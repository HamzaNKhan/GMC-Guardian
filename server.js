const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Helper to log with timestamp
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) console.log(data);
}

// ---------------------------------------------------------------------
// Helper: Simulate adding a product to cart and navigate to checkout
// ---------------------------------------------------------------------
async function simulateAddToCartAndCheckout(browser, baseUrl, productUrls) {
  if (!productUrls || productUrls.length === 0) {
    log('No product URLs to simulate add to cart.');
    return null;
  }

  const productUrl = productUrls[0]; // use the first product page
  log(`Simulating add to cart using product: ${productUrl}`);

  const page = await browser.newPage();
  try {
    await page.goto(productUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    log(`Product page loaded.`);

    // Try to find and click "Add to Cart" button (common selectors for Shopify & WooCommerce)
    const addToCartSelectors = [
      'button[type="submit"][name="add"]',           // Shopify
      'button.single_add_to_cart_button',            // WooCommerce
      'form.cart button[type="submit"]',
      'button[data-product-add-to-cart]',
      '#add-to-cart-button',
      '.product-form__submit',
      'button[name="add"]',
      'form[action*="add_to_cart"] button[type="submit"]'
    ];

    let buttonFound = false;
    for (const selector of addToCartSelectors) {
      const button = await page.$(selector);
      if (button) {
        log(`Found "Add to Cart" button with selector: ${selector}`);
        await button.click();
        buttonFound = true;
        break;
      }
    }

    if (!buttonFound) {
      log('No "Add to Cart" button found on product page.');
      return null;
    }

    // Wait for cart to update (e.g., AJAX)
    await page.waitForTimeout(3000);

    // Check if we were redirected to cart/checkout automatically
    const currentUrl = page.url();
    if (currentUrl.includes('/checkout') || currentUrl.includes('/cart')) {
      log(`Redirected to cart/checkout: ${currentUrl}`);
      return currentUrl;
    }

    // Otherwise, look for a "View Cart" or "Checkout" link
    const checkoutLinkSelectors = [
      'a[href*="checkout"]',
      'a[href*="cart"]',
      '.cart__checkout',
      '.checkout-button',
      'a[href*="/checkout"]',
      'a[href*="/cart"]'
    ];

    let checkoutUrl = null;
    for (const selector of checkoutLinkSelectors) {
      const link = await page.$(selector);
      if (link) {
        const href = await link.evaluate(el => el.href);
        if (href && (href.includes('checkout') || href.includes('cart'))) {
          checkoutUrl = href;
          log(`Found checkout/cart link: ${href}`);
          break;
        }
      }
    }

    if (checkoutUrl) {
      // If it's a cart page, we may need to click a "Checkout" button there
      if (checkoutUrl.includes('/cart')) {
        log(`Navigating to cart page: ${checkoutUrl}`);
        await page.goto(checkoutUrl, { waitUntil: 'networkidle0', timeout: 30000 });
        // Look for a "Checkout" button on the cart page
        const cartCheckoutSelectors = [
          'a[href*="checkout"]',
          '.checkout-button',
          'button[name="checkout"]',
          'input[value="Proceed to checkout"]'
        ];
        let checkoutBtnFound = false;
        for (const selector of cartCheckoutSelectors) {
          const btn = await page.$(selector);
          if (btn) {
            log(`Found checkout button on cart page: ${selector}`);
            await btn.click();
            checkoutBtnFound = true;
            break;
          }
        }
        if (checkoutBtnFound) {
          await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 });
          checkoutUrl = page.url();
          log(`Final checkout URL: ${checkoutUrl}`);
        } else {
          log('No checkout button found on cart page.');
          return null;
        }
      } else {
        // Directly go to checkout URL
        await page.goto(checkoutUrl, { waitUntil: 'networkidle0', timeout: 30000 });
        checkoutUrl = page.url();
      }
      return checkoutUrl;
    }

    // Fallback: try common checkout paths
    const possiblePaths = ['/checkout', '/cart', '/cart/checkout'];
    for (const path of possiblePaths) {
      const testUrl = new URL(path, baseUrl).href;
      try {
        const response = await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 5000 });
        if (response && response.status() === 200) {
          log(`Found checkout page via path: ${testUrl}`);
          return testUrl;
        }
      } catch {}
    }

    log('Could not locate checkout page after adding to cart.');
    return null;
  } catch (err) {
    log(`Error during cart simulation: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------
// Helper: Run the audit on a single page (returns the result object)
// ---------------------------------------------------------------------
async function auditPage(page, url, pageType = 'unknown') {
  const pageTitle = await page.title();
  log(`Starting audit of ${pageType} page: ${url} (Title: "${pageTitle}")`);

  // Capture JavaScript errors
  await page.evaluateOnNewDocument(() => {
    window.__gmc_js_errors = [];
    window.addEventListener('error', (event) => {
      window.__gmc_js_errors.push({ message: event.message, filename: event.filename, lineno: event.lineno });
    });
    window.addEventListener('unhandledrejection', (event) => {
      window.__gmc_js_errors.push({ message: event.reason });
    });
  });

  const result = await page.evaluate(async (pageTypeParam) => {
    // ========== BEGIN FULL AUDIT CODE ==========
    'use strict';

    // --- Helper functions (same as your original) ---
    const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
    const bodyHTML = document.documentElement ? document.documentElement.innerHTML : '';
    const bodyHTMLL = bodyHTML.toLowerCase();
    const allLinks  = Array.from(document.querySelectorAll('a[href]'));
    const allScripts= Array.from(document.querySelectorAll('script'));
    const allImages = Array.from(document.querySelectorAll('img'));

    function hasLinkTo(kw) {
      return allLinks.some(a => {
        const h = (a.href || '').toLowerCase();
        const t = (a.textContent || '').toLowerCase().trim();
        return new RegExp(kw, 'i').test(h) || new RegExp(kw, 'i').test(t);
      });
    }

    function hasScriptFrom(kw) {
      return allScripts.some(s => new RegExp(kw,'i').test(s.src || '') || new RegExp(kw,'i').test(s.textContent || ''));
    }

    function getMeta(name) {
      const el = document.querySelector(`meta[name="${name}"]`) || document.querySelector(`meta[property="${name}"]`);
      return el ? el.getAttribute('content') : null;
    }

    function getSchemas() {
      const arr = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        try {
          const parsed = JSON.parse(s.textContent);
          (Array.isArray(parsed) ? parsed : [parsed]).forEach(o => arr.push(o));
        } catch {}
      });
      return arr;
    }

    function hasSchemaType(type) {
      return getSchemas().some(s => {
        const t = s['@type'] || '';
        return Array.isArray(t)
          ? t.some(x => x.toLowerCase() === type.toLowerCase())
          : t.toLowerCase() === type.toLowerCase();
      });
    }

    async function tryFetch(url) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(timer);
        const text = await r.text();
        return { ok: r.ok, status: r.status, text };
      } catch {
        return { ok: false, status: 0, text: '' };
      }
    }

    function chk(id, name, condition, detail, fix, importance = 'important') {
      const status = condition === true ? 'pass' : condition === 'warn' ? 'warning' : 'fail';
      return { id, name, status, detail, fix: status === 'pass' ? '' : fix, importance };
    }

    function catScore(checks) {
      if (!checks.length) return 0;
      const pts = checks.reduce((s, c) => s + (c.status === 'pass' ? 1 : c.status === 'warning' ? 0.5 : 0), 0);
      return Math.round((pts / checks.length) * 100);
    }

    // --- Page meta ---
    const loc = window.location;
    const isHTTPS = loc.protocol === 'https:';
    const domain = loc.hostname;
    const base = `${loc.protocol}//${domain}`;
    const pageTitle = document.title || '';
    const isShopify = bodyHTMLL.includes('shopify') || bodyHTMLL.includes('cdn.shopify.com');
    const isWoo     = bodyHTMLL.includes('woocommerce') || bodyHTMLL.includes('wp-content/plugins');
    const platform  = isShopify ? 'Shopify' : isWoo ? 'WooCommerce' : 'Unknown Platform';

    // ========== 1. Technical Setup ==========
    function technicalChecks() {
      const viewport = document.querySelector('meta[name="viewport"]');
      const vpContent = viewport ? viewport.getAttribute('content') : '';
      const canonical = document.querySelector('link[rel="canonical"]');
      const favicon = document.querySelector('link[rel="icon"]') || document.querySelector('link[rel="shortcut icon"]');
      const robots = getMeta('robots') || '';
      const noindex = robots.includes('noindex');
      const metaDesc = getMeta('description');
      const titleLen = pageTitle.length;

      return [
        chk('https', 'HTTPS Protocol Active', isHTTPS,
            isHTTPS ? 'Site served over HTTPS ✓' : 'Site is using insecure HTTP',
            'Install an SSL certificate and force HTTPS redirects.', 'critical'),
        chk('title-exists','Page Title Present', titleLen > 0,
            titleLen > 0 ? `"${pageTitle.substring(0,70)}"` : 'No <title> tag found',
            'Add a descriptive <title> tag to your <head>.', 'critical'),
        chk('title-length','Title Length Optimal',
            titleLen >= 30 && titleLen <= 70 ? true : titleLen > 0 ? 'warn' : false,
            `Title is ${titleLen} characters (optimal: 30–70)`,
            'Shorten or lengthen your page title.'),
        chk('meta-desc', 'Meta Description Present', !!metaDesc,
            metaDesc ? `"${metaDesc.substring(0,100)}..."` : 'No meta description found',
            'Add <meta name="description" content="..."> with 150–160 characters.', 'important'),
        chk('viewport', 'Mobile Viewport Tag', !!viewport,
            viewport ? `content="${vpContent}"` : 'No viewport meta tag found',
            'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head>.', 'critical'),
        chk('viewport-correct','Viewport Configured Correctly',
            vpContent.includes('width=device-width') ? true : viewport ? 'warn' : false,
            vpContent || 'Missing viewport',
            'Set viewport content to: width=device-width, initial-scale=1', 'important'),
        chk('canonical', 'Canonical Tag Present', !!canonical,
            canonical ? canonical.href : 'No canonical link tag found',
            'Add <link rel="canonical" href="page-url"> to prevent duplicate content issues.', 'important'),
        chk('favicon', 'Favicon Present', !!favicon,
            favicon ? 'Favicon found' : 'No favicon detected',
            'Add a favicon — it builds brand recognition and trust.', 'recommended'),
        chk('noindex', 'Page is Indexable by Google', !noindex,
            noindex ? '⚠️ Page has noindex directive' : 'Page is indexable (no noindex found)',
            'Remove noindex from your robots meta tag so Google can crawl and index this page.', 'critical'),
      ];
    }

    // ========== 2. Crawlability ==========
    async function crawlabilityChecks() {
      const robots  = await tryFetch(`${base}/robots.txt`);
      const sitemap = await tryFetch(`${base}/sitemap.xml`);
      const sitemapIdx = await tryFetch(`${base}/sitemap_index.xml`);

      const robotsOk        = robots.ok && robots.status === 200;
      const robotsBlocksAll = robots.text.includes('Disallow: /') &&
                              !robots.text.includes('Disallow: /admin');
      const sitemapOk       = sitemap.ok || sitemapIdx.ok;
      const sitemapHasURLs  = sitemap.text.includes('<url>') || sitemapIdx.text.includes('<sitemap>');
      const domCount        = document.querySelectorAll('*').length;

      return [
        chk('robots-exists',  'robots.txt Accessible',          robotsOk,
            robotsOk ? 'robots.txt found and accessible' : 'robots.txt not found (404)',
            'Create a robots.txt at yourstore.com/robots.txt — most platforms do this automatically.', 'important'),
        chk('robots-allow',   'robots.txt Not Blocking Google',
            !robotsBlocksAll ? true : false,
            robotsBlocksAll ? '⚠️ "Disallow: /" found — Google may be blocked' : 'Google can crawl your site',
            'Remove the broad "Disallow: /" rule from robots.txt. Only block /admin or private paths.', 'critical'),
        chk('sitemap-exists', 'Sitemap.xml Present',            sitemapOk,
            sitemapOk ? 'sitemap.xml found' : 'No sitemap found at /sitemap.xml',
            'Generate and submit a sitemap to Google Search Console.', 'important'),
        chk('sitemap-urls',   'Sitemap Contains URLs',          sitemapHasURLs ? true : sitemapOk ? 'warn' : false,
            sitemapHasURLs ? 'Sitemap has URL entries' : 'Sitemap may be empty',
            'Ensure your sitemap includes all product, collection, and policy page URLs.', 'important'),
        chk('dom-size',       'DOM Size Acceptable',
            domCount < 2000 ? true : domCount < 4000 ? 'warn' : false,
            `${domCount} DOM elements (recommended: <2000)`,
            'Reduce DOM complexity. Large DOMs slow crawling and page rendering.', 'recommended'),
        chk('page-title-unique','Title is Descriptive',
            pageTitle.length > 5 && !/^(home|untitled|welcome)$/i.test(pageTitle.trim()),
            pageTitle || 'No title',
            'Use a unique, keyword-rich page title — avoid generic titles like "Home" or "Welcome".', 'important'),
      ];
    }

    // ========== 3. Policy Pages ==========
    async function policyChecks() {
      const find = (patterns) => allLinks.find(a =>
        patterns.some(p => new RegExp(p,'i').test(a.href) || new RegExp(p,'i').test(a.textContent.trim()))
      );

      const privacyA  = find(['privacy']);
      const returnA   = find(['return','refund','cancellation']);
      const shippingA = find(['shipping','delivery']);
      const termsA    = find(['terms','tos','conditions']);
      const contactA  = find(['contact','contact-us','get-in-touch']);
      const aboutA    = find(['about','about-us','our-story']);
      const faqA      = find(['faq','frequently-asked']);

      const fetch2 = async (link) => {
        if (!link) return '';
        const r = await tryFetch(link.href);
        return r.text.toLowerCase();
      };

      const [returnTxt, shippingTxt, contactTxt] = await Promise.all([
        fetch2(returnA), fetch2(shippingA), fetch2(contactA)
      ]);

      return [
        chk('privacy',        'Privacy Policy Linked',        !!privacyA,
            privacyA ? privacyA.href : 'No privacy policy link found',
            'Add a Privacy Policy link in your footer. Required by GMC and GDPR/CCPA law.', 'critical'),
        chk('returns',        'Return & Refund Policy Linked', !!returnA,
            returnA ? returnA.href : 'No return/refund policy link found',
            'Add a Return Policy link in footer. GMC will reject stores without a clear refund policy.', 'critical'),
        chk('shipping',       'Shipping Policy Linked',       !!shippingA,
            shippingA ? shippingA.href : 'No shipping policy link found',
            'Add a Shipping Policy page with delivery times and costs. Required for GMC approval.', 'critical'),
        chk('terms',          'Terms of Service Linked',      !!termsA,
            termsA ? termsA.href : 'No terms of service link found',
            'Add a Terms & Conditions page linked from your footer.', 'important'),
        chk('contact',        'Contact Page Present',         !!contactA,
            contactA ? contactA.href : 'No contact page link found',
            'Add a Contact Us page. GMC requires a way for customers to reach you.', 'critical'),
        chk('about',          'About Us Page Present',        !!aboutA ? true : 'warn',
            aboutA ? aboutA.href : 'No about page found',
            'Add an About Us page explaining who you are. Builds trust with Google and customers.', 'recommended'),
        chk('faq',            'FAQ Page Present',             !!faqA ? true : 'warn',
            faqA ? faqA.href : 'No FAQ page detected',
            'Add an FAQ page. Reduces customer service load and signals legitimacy.', 'recommended'),
        chk('return-days',    'Return Policy Mentions Timeframe',
            returnTxt ? (returnTxt.includes('day') || returnTxt.includes('week') ? true : 'warn') : 'warn',
            returnTxt ? 'Return policy text checked for timeframe' : 'Could not read return policy content',
            'State your return window explicitly (e.g., "30-day returns"). Vague policies trigger GMC disapprovals.', 'important'),
        chk('shipping-time',  'Shipping Policy Mentions Delivery Time',
            shippingTxt ? (shippingTxt.includes('day') || shippingTxt.includes('business') ? true : 'warn') : 'warn',
            shippingTxt ? 'Shipping policy checked for delivery times' : 'Could not read shipping policy content',
            'Include estimated delivery times ("3–5 business days") in your shipping policy.', 'important'),
        chk('contact-method', 'Contact Page Has Contact Method',
            contactTxt ? (contactTxt.includes('@') || contactTxt.includes('phone') || contactTxt.includes('form') ? true : 'warn') : 'warn',
            contactTxt ? 'Contact method found on contact page' : 'Could not verify contact page',
            'Ensure your contact page has at least one method: email, phone, or contact form.', 'important'),
      ];
    }

    // ========== 4. Schema Markup ==========
    function schemaChecks() {
      const schemas    = getSchemas();
      const hasAny     = schemas.length > 0;
      const hasProduct = hasSchemaType('Product');
      const hasOrg     = hasSchemaType('Organization') || hasSchemaType('Store') || hasSchemaType('LocalBusiness');
      const hasSite    = hasSchemaType('WebSite');
      const hasBread   = hasSchemaType('BreadcrumbList');
      const hasOffer   = schemas.some(s => s.offers || s['@type'] === 'Offer');
      const hasRating  = schemas.some(s => s.aggregateRating);

      let jsonValid = true;
      document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        try { JSON.parse(s.textContent); } catch { jsonValid = false; }
      });

      return [
        chk('schema-any',     'Structured Data Present',     hasAny,
            hasAny ? `${schemas.length} schema object(s) found` : 'No JSON-LD schema found',
            'Add JSON-LD structured data to your pages.', 'critical'),
        chk('schema-json',    'Schema JSON Valid',           !hasAny ? 'warn' : jsonValid,
            jsonValid ? 'All schema JSON parses correctly' : '⚠️ Invalid JSON found in schema',
            'Fix JSON syntax errors in your structured data.', 'critical'),
        chk('schema-product', 'Product Schema Present',      hasProduct ? true : hasAny ? 'warn' : false,
            hasProduct ? 'Product schema found ✓' : 'No Product schema detected',
            'Add Product schema on all product pages for Google Shopping eligibility.', 'critical'),
        chk('schema-org',     'Organization Schema Present', hasOrg,
            hasOrg ? 'Organization schema found ✓' : 'No Organization schema found',
            'Add Organization schema on your homepage.', 'important'),
        chk('schema-site',    'WebSite Schema Present',      hasSite ? true : 'warn',
            hasSite ? 'WebSite schema found ✓' : 'No WebSite schema',
            'Add WebSite schema to enable sitelinks searchbox in Google results.', 'recommended'),
        chk('schema-offer',   'Offer/Price Schema Present',  hasOffer ? true : hasProduct ? 'warn' : false,
            hasOffer ? 'Offer schema with pricing found ✓' : 'No Offer schema with price',
            'Add Offer schema with price and availability inside Product schema.', 'critical'),
        chk('schema-rating',  'AggregateRating Schema',      hasRating ? true : 'warn',
            hasRating ? 'AggregateRating schema found ✓' : 'No rating schema',
            'Add AggregateRating schema to show star ratings in Google Search.', 'recommended'),
        chk('schema-breadcrumb','BreadcrumbList Schema',     hasBread ? true : 'warn',
            hasBread ? 'BreadcrumbList schema found ✓' : 'No BreadcrumbList schema',
            'Add BreadcrumbList schema to show navigation in Google results.', 'recommended'),
      ];
    }

    // ========== 5. Digital Footprint ==========
    function digitalFootprintChecks() {
      const hasFB    = hasLinkTo('facebook\\.com');
      const hasIG    = hasLinkTo('instagram\\.com');
      const hasTW    = hasLinkTo('twitter\\.com|x\\.com');
      const hasYT    = hasLinkTo('youtube\\.com');
      const hasTT    = hasLinkTo('tiktok\\.com');
      const socialCount = [hasFB, hasIG, hasTW, hasYT, hasTT].filter(Boolean).length;

      const hasEmail = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i.test(bodyText);
      const hasPhone = !!document.querySelector('a[href^="tel:"]') || /\+?\d[\d\s\-\(\)]{7,}/i.test(bodyText);

      const hasTP    = bodyHTMLL.includes('trustpilot') || hasLinkTo('trustpilot\\.com');
      const hasReview= bodyHTMLL.includes('judge.me') || bodyHTMLL.includes('loox') ||
                       bodyHTMLL.includes('yotpo') || bodyHTMLL.includes('reviews.io') ||
                       bodyHTMLL.includes('stamped') || hasTP;

      return [
        chk('fb',           'Facebook Page Linked',         hasFB,
            hasFB ? 'Facebook link found ✓' : 'No Facebook page link',
            'Add your Facebook Business page link to the footer.', 'important'),
        chk('instagram',    'Instagram Linked',             hasIG,
            hasIG ? 'Instagram link found ✓' : 'No Instagram link',
            'Add your Instagram profile to the footer.', 'important'),
        chk('twitter',      'Twitter / X Linked',          hasTW ? true : 'warn',
            hasTW ? 'Twitter/X link found ✓' : 'No Twitter/X link',
            'Link your Twitter/X profile from your footer.', 'recommended'),
        chk('youtube',      'YouTube Channel Linked',       hasYT ? true : 'warn',
            hasYT ? 'YouTube link found ✓' : 'No YouTube link',
            'Create a YouTube channel and link it.', 'recommended'),
        chk('tiktok',       'TikTok Linked',                hasTT ? true : 'warn',
            hasTT ? 'TikTok link found ✓' : 'No TikTok link',
            'Add your TikTok profile link.', 'recommended'),
        chk('social-count', 'Minimum Social Presence (3+)',
            socialCount >= 3 ? true : socialCount >= 1 ? 'warn' : false,
            `${socialCount} / 5 major social platforms linked`,
            'Link at least 3 social platforms from your footer.', 'important'),
        chk('email-visible','Business Email Visible',       hasEmail,
            hasEmail ? 'Email address found on page ✓' : 'No email address detected',
            'Display a business email on your Contact page. Use a branded domain email, not Gmail.', 'critical'),
        chk('phone',        'Phone Number Present',         hasPhone ? true : 'warn',
            hasPhone ? 'Phone number detected ✓' : 'No phone number found',
            'Add a business phone number.', 'important'),
        chk('review-platform','Third-Party Review Platform',hasReview,
            hasReview ? 'Review platform detected ✓' : 'No review platform detected',
            'Integrate Trustpilot, Judge.me, or Yotpo. External reviews are critical for GMC trust.', 'important'),
      ];
    }

    // ========== 6. Mobile & Speed ==========
    function mobileSpeedChecks() {
      const viewport   = document.querySelector('meta[name="viewport"]');
      const vpContent  = viewport ? viewport.getAttribute('content') : '';
      const perf       = window.performance;
      const timing     = perf && perf.timing;
      let loadTime = 0;
      if (timing && timing.loadEventEnd > 0 && timing.navigationStart > 0) {
        loadTime = timing.loadEventEnd - timing.navigationStart;
      }

      const lazyImgs  = allImages.filter(i => i.loading === 'lazy' || i.dataset.src).length;
      const syncScripts = Array.from(document.querySelectorAll('script[src]:not([async]):not([defer])')).length;
      const imgCount   = allImages.length;

      return [
        chk('vp-present',   'Viewport Meta Present',       !!viewport,
            viewport ? 'Viewport tag found ✓' : 'Missing viewport meta tag',
            'Add <meta name="viewport" content="width=device-width, initial-scale=1"> immediately.', 'critical'),
        chk('vp-correct',   'Viewport Correctly Configured',
            vpContent.includes('width=device-width') ? true : viewport ? 'warn' : false,
            vpContent || 'Not configured',
            'Set viewport to: content="width=device-width, initial-scale=1"', 'important'),
        chk('load-time',    'Page Load Time',
            loadTime === 0 ? 'warn' : loadTime < 3000 ? true : loadTime < 6000 ? 'warn' : false,
            loadTime > 0 ? `Loaded in ${(loadTime/1000).toFixed(1)}s (target: <3s)` : 'Could not measure load time',
            'Optimize for under 3 seconds: compress images, minimize CSS/JS, use a CDN.', 'important'),
        chk('img-count',    'Image Count Manageable',
            imgCount <= 60 ? true : imgCount <= 120 ? 'warn' : false,
            `${imgCount} images on this page`,
            'Reduce images per page. Lazy-load images below the fold with loading="lazy".', 'recommended'),
        chk('lazy-load',    'Images Use Lazy Loading',
            lazyImgs > 0 || imgCount === 0 ? true : 'warn',
            lazyImgs > 0 ? `${lazyImgs} images use lazy loading ✓` : 'No lazy loading detected',
            'Add loading="lazy" to all images below the fold to improve initial load speed.', 'recommended'),
        chk('render-block', 'Low Render-Blocking Scripts',
            syncScripts <= 3 ? true : syncScripts <= 8 ? 'warn' : false,
            `${syncScripts} render-blocking script(s) found`,
            'Add async or defer to non-critical script tags to prevent render blocking.', 'important'),
        chk('mobile-ready', 'Mobile-Friendly Configuration',
            vpContent.includes('width=device-width') ? true : 'warn',
            vpContent.includes('width=device-width') ? 'Mobile configuration correct ✓' : 'Mobile setup may be incomplete',
            'Test your store with Google\'s Mobile-Friendly Test.', 'critical'),
      ];
    }

    // ========== 7. Trust Signals ==========
    function trustSignalChecks() {
      const hasSecureText  = /secure.{0,20}checkout|ssl.secured|secure.payment|256.bit/i.test(bodyText);
      const hasMoneyBack   = /money.back|satisfaction.guaran|30.day.guarantee/i.test(bodyText);
      const hasCookieBanner= bodyHTMLL.includes('cookie') && (bodyHTMLL.includes('accept') || bodyHTMLL.includes('consent'));
      const hasLiveChat    = hasScriptFrom('intercom') || hasScriptFrom('tidio') ||
                            hasScriptFrom('zendesk') || hasScriptFrom('tawk') ||
                            hasScriptFrom('freshchat') || hasScriptFrom('gorgias') ||
                            hasScriptFrom('livechat');
      const hasPaymentBadges = /visa|mastercard|paypal|apple.pay|google.pay|american express|amex/i.test(bodyText + bodyHTML);
      const hasFreeShip    = /free shipping|free delivery/i.test(bodyText);
      const hasNewsletter  = hasScriptFrom('klaviyo') || hasScriptFrom('mailchimp') ||
                            bodyHTMLL.includes('newsletter') || bodyHTMLL.includes('subscribe');

      return [
        chk('ssl-active',   'SSL/HTTPS Active',             isHTTPS,
            isHTTPS ? 'HTTPS active — connection is secure ✓' : '⚠️ HTTP only — not secure',
            'Install SSL immediately. GMC will not approve any HTTP-only store.', 'critical'),
        chk('payment-badges','Payment Method Logos Visible', hasPaymentBadges,
            hasPaymentBadges ? 'Payment method indicators found ✓' : 'No payment logos/text found',
            'Display Visa, Mastercard, PayPal logos on homepage and checkout.', 'important'),
        chk('secure-checkout','Secure Checkout Messaging',  hasSecureText ? true : 'warn',
            hasSecureText ? 'Secure checkout messaging found ✓' : 'No secure checkout messaging',
            'Add "Secure Checkout" or "SSL Secured" text near the cart/buy buttons.', 'recommended'),
        chk('money-back',   'Money-Back Guarantee',         hasMoneyBack ? true : 'warn',
            hasMoneyBack ? 'Money-back guarantee language found ✓' : 'No money-back guarantee found',
            'Add a money-back guarantee.', 'recommended'),
        chk('live-chat',    'Live Chat Support Widget',     hasLiveChat ? true : 'warn',
            hasLiveChat ? 'Live chat widget detected ✓' : 'No live chat widget found',
            'Install Tidio, Gorgias, or Zendesk.', 'recommended'),
        chk('cookie-consent','Cookie Consent Banner',       hasCookieBanner ? true : 'warn',
            hasCookieBanner ? 'Cookie consent mechanism found ✓' : 'No cookie consent detected',
            'Add a GDPR cookie consent banner — legally required for EU customers.', 'important'),
        chk('free-shipping', 'Free Shipping Offer Visible', hasFreeShip ? true : 'warn',
            hasFreeShip ? 'Free shipping offer found ✓' : 'No free shipping offer found',
            'Offer or clearly show shipping costs.', 'recommended'),
        chk('newsletter',   'Email Marketing Integration',  hasNewsletter ? true : 'warn',
            hasNewsletter ? 'Newsletter/email integration detected ✓' : 'No email marketing signup found',
            'Add a newsletter signup with Klaviyo or Mailchimp.', 'recommended'),
      ];
    }

    // ========== 8. Google Ecosystem ==========
    function googleEcosystemChecks() {
      const hasGA  = hasScriptFrom('googletagmanager.com/gtag') || hasScriptFrom('google-analytics.com') ||
                     bodyHTML.includes('gtag(') || bodyHTML.includes("ga('") || /G-[A-Z0-9]+|UA-\d/.test(bodyHTML);
      const hasGTM = hasScriptFrom('googletagmanager.com') || /GTM-[A-Z0-9]+/.test(bodyHTML);
      const hasGSC = !!document.querySelector('meta[name="google-site-verification"]');
      const hasMC  = bodyHTML.includes('google_conversion') || bodyHTML.includes('merchant_center') ||
                     bodyHTML.includes('google_tag_params');
      const hasGMaps    = bodyHTMLL.includes('maps.google') || bodyHTMLL.includes('maps.googleapis');
      const hasGBusiness= allLinks.some(a => /g\.page|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(a.href));
      const hasSchema   = document.querySelectorAll('script[type="application/ld+json"]').length > 0;

      return [
        chk('ga4',          'Google Analytics (GA4) Installed', hasGA,
            hasGA ? 'Google Analytics detected ✓' : 'Google Analytics not found',
            'Install GA4 immediately. Required for GMC campaign data and conversion tracking.', 'critical'),
        chk('gtm',          'Google Tag Manager',          hasGTM ? true : 'warn',
            hasGTM ? 'Google Tag Manager detected ✓' : 'GTM not found',
            'Install GTM to manage GA4, GMC, and other tags in one place.', 'important'),
        chk('gsc',          'Google Search Console Verified', hasGSC,
            hasGSC ? 'Search Console verification meta found ✓' : 'No GSC verification meta tag',
            'Verify your store in Google Search Console before applying to GMC.', 'critical'),
        chk('mc-tag',       'Merchant Center Conversion Tag', hasMC ? true : 'warn',
            hasMC ? 'Merchant Center tag detected ✓' : 'No Merchant Center tag found',
            'Install the GMC website tag after approval for conversion tracking.', 'important'),
        chk('structured-d', 'Structured Data for Shopping', hasSchema,
            hasSchema ? 'Structured data present ✓' : 'No structured data',
            'Add Product, Offer, and Organization schema to all relevant pages.', 'critical'),
        chk('google-maps',  'Google Maps Presence',         hasGMaps ? true : 'warn',
            hasGMaps ? 'Google Maps embed/link detected ✓' : 'No Google Maps found',
            'Add a Google Maps link or embed on your Contact page to verify your business location.', 'recommended'),
        chk('gbusiness',    'Google Business Profile Linked', hasGBusiness ? true : 'warn',
            hasGBusiness ? 'Google Business Profile link found ✓' : 'No Google Business Profile link',
            'Create a Google Business Profile and link it from your Contact page.', 'important'),
        chk('analytics-complete','Analytics Setup Complete',
            hasGA && hasGTM ? true : hasGA ? 'warn' : false,
            hasGA && hasGTM ? 'GA4 + GTM both detected ✓' : 'Partial analytics setup',
            'Install both GA4 (for measurement) and GTM (for tag management) for complete tracking.', 'important'),
      ];
    }

    // ========== 9. Prohibited Content ==========
    function prohibitedChecks() {
      const txt = bodyText;
      const hasCounterfeit  = /\b(replica|replicas|counterfeit|aaa quality designer|inspired by (gucci|louis|prada|chanel))\b/i.test(txt);
      const hasMedicalClaim = /\b(cures?|treats?|diagnoses?|prevents? (cancer|diabetes|covid)|fda approved product|clinically proven to)\b/i.test(txt);
      const hasPrescription = /\b(opioid|controlled substance|prescription (required|only)|pharmaceutical grade drug)\b/i.test(txt);
      const hasAdultSig     = /\b(explicit content|adult only|18\+ content|pornograph)\b/i.test(txt);
      const hasExcessCaps   = (txt.match(/[A-Z]{6,}/g) || []).length > 8;
      const hasExcessPunct  = /[!?]{3,}/.test(txt);
      const hasFakeUrgency  = /only \d+ left in stock!|selling out fast!|almost gone!/i.test(txt);
      const hasMiracle      = /\b(miracle (cure|solution|pill)|magic(al)? weight loss|lose \d+ (pounds|kg) (in|per) (day|week))\b/i.test(txt);

      return [
        chk('no-counterfeit', 'No Counterfeit Product Signals', !hasCounterfeit,
            hasCounterfeit ? '⚠️ Counterfeit/replica keywords detected' : 'No counterfeit signals ✓',
            'Remove all references to replicas or counterfeits. Permanent GMC suspension risk.', 'critical'),
        chk('no-medical',   'No False Medical Claims',      !hasMedicalClaim,
            hasMedicalClaim ? '⚠️ Unsubstantiated medical claims found' : 'No prohibited medical claims ✓',
            'Remove any claims that products cure or treat diseases without FDA approval.', 'critical'),
        chk('no-prescription','No Prescription Drug Content', !hasPrescription,
            hasPrescription ? '⚠️ Prescription drug references detected' : 'No prescription drug signals ✓',
            'Remove prescription/controlled substance references unless you are a licensed pharmacy.', 'critical'),
        chk('no-adult',     'No Adult Content Signals',     !hasAdultSig,
            hasAdultSig ? '⚠️ Adult content keywords detected' : 'No adult content signals ✓',
            'Remove adult content. If intentional, enroll in GMC\'s adult content program.', 'critical'),
        chk('no-caps',      'No Excessive ALL CAPS',        !hasExcessCaps,
            hasExcessCaps ? '⚠️ Heavy ALL CAPS usage detected' : 'Capitalization is appropriate ✓',
            'Use standard title case in product titles and descriptions. ALL CAPS violates GMC policy.', 'important'),
        chk('no-punct',     'No Excessive Punctuation',     !hasExcessPunct,
            hasExcessPunct ? '⚠️ Excessive !!! or ??? detected' : 'Punctuation appears normal ✓',
            'Remove excessive punctuation. "Best product ever!!!" violates GMC editorial standards.', 'important'),
        chk('no-fake-urgency','No Misleading Urgency',      !hasFakeUrgency ? true : 'warn',
            hasFakeUrgency ? '⚠️ Possible hardcoded urgency language detected' : 'No misleading urgency ✓',
            'Stock warnings like "Only 2 left!" must be real and dynamic, not hardcoded text.', 'important'),
        chk('no-miracle',   'No Miracle Claim Language',    !hasMiracle,
            hasMiracle ? '⚠️ Miracle/magic claim language detected' : 'No exaggerated claims ✓',
            'Remove "miracle", "magic", or instant results claims. These trigger GMC policy violations.', 'important'),
      ];
    }

    // ========== 10. Product Data ==========
    function productDataChecks() {
      const schemas = getSchemas();
      const productSchema = schemas.find(s => s['@type'] === 'Product');
      const isProductPage = !!productSchema ||
        /\/product[s]?\//i.test(loc.pathname) ||
        bodyHTMLL.includes('add-to-cart') ||
        bodyHTMLL.includes('add_to_cart') ||
        !!document.querySelector('button[name*="cart"], button[id*="cart"]');

      if (!isProductPage) {
        return [{
          id: 'not-product', name: 'Product Page Detected', status: 'warning',
          detail: 'This page does not appear to be a product page. Navigate to a product page for full product data checks.',
          fix: 'Open a product page (e.g., yourstore.com/products/item-name) and run the audit again for product checks.',
          importance: 'important'
        }];
      }

      const h1 = document.querySelector('h1');
      const titleEl = h1 || document.querySelector('[itemprop="name"]');
      const titleTxt = (titleEl ? titleEl.textContent.trim() : productSchema?.name || '');
      const titleLen = titleTxt.length;
      const titleAllCaps = titleLen > 10 && titleTxt === titleTxt.toUpperCase();
      const titleHasPromo = /\b(free shipping|sale|% off|discount|buy one|bogo|promo)\b/i.test(titleTxt);

      // Expanded description selectors
      const descSelectors = [
        '[itemprop="description"]',
        '.product-description',
        '.product__description',
        '[data-product-description]',
        '.description',
        '.product-details__description',
        '.product-info__description',
        '#description',
        '.product-description__text',
        '.product-detail-description',
        '.woocommerce-product-details__short-description',
        '.product .description',
        '.product .product-description',
        'div[data-description]',
        '.product-specs',
        '.product-content',
        '.product__details',
        '#tab-description .wc-tab-inner',
        '[class*="description"]'
      ];

      let descEl = null;
      for (const selector of descSelectors) {
        descEl = document.querySelector(selector);
        if (descEl && descEl.textContent.trim().length > 0) break;
      }

      let descTxt = descEl ? descEl.textContent.trim() : '';
      if (!descTxt && productSchema?.description) {
        descTxt = productSchema.description;
      }
      const descLen = descTxt.length;

      const hasPrice = !!document.querySelector('[itemprop="price"],.price,[class*="price"],[data-price]') ||
                      /\$[\d,]+|\£[\d,]+|€[\d,]+/i.test(bodyText);
      const hasImages = allImages.filter(i => i.naturalWidth > 100 || i.width > 100 || /product|cdn/i.test(i.src)).length > 0;
      const hasAvail  = /in.stock|out.of.stock|available|add to (cart|bag)|buy now/i.test(bodyText);
      const hasBrand  = !!productSchema?.brand || bodyHTMLL.includes('itemprop="brand"');

      return [
        chk('prod-title',   'Product Title Present',       titleLen > 0,
            titleLen > 0 ? `"${titleTxt.substring(0,70)}"` : 'No product title found',
            'Add a clear H1 product title. Include brand + product type + key attributes.', 'critical'),
        chk('prod-title-len','Product Title Length Optimal',
            titleLen >= 25 && titleLen <= 150 ? true : titleLen > 0 ? 'warn' : false,
            `${titleLen} characters (recommended: 70–130)`,
            'Ideal product title: Brand + Product Name + Key Attribute. 70–130 characters.', 'important'),
        chk('prod-no-caps', 'Title Not in ALL CAPS',       !titleAllCaps,
            titleAllCaps ? '⚠️ Title appears to be in ALL CAPS' : 'Title capitalization correct ✓',
            'Use standard title case in product names. ALL CAPS is a GMC editorial violation.', 'important'),
        chk('prod-no-promo','No Promotional Text in Title', !titleHasPromo,
            titleHasPromo ? `⚠️ Promotional language in title: "${titleTxt.substring(0,50)}"` : 'No promotional text in title ✓',
            'Remove "Free Shipping", "Sale", or discount text from product titles. GMC prohibits this.', 'critical'),
        chk('prod-desc',    'Product Description Present', descLen > 0,
            descLen > 0 ? `${descLen} characters` : 'No product description found',
            'Add a detailed product description. Include features, materials, dimensions, and use cases.', 'critical'),
        chk('prod-desc-len','Description Has Sufficient Length',
            descLen >= 500 ? true : descLen >= 100 ? 'warn' : false,
            `${descLen} characters (recommended: 500+)`,
            'Write at least 500 characters. More detail helps GMC categorize products correctly.', 'important'),
        chk('prod-images',  'Product Images Present',      hasImages,
            hasImages ? 'Product images detected ✓' : 'No product images found',
            'Add high-quality images. GMC min: 100×100px. Recommended: 800×800px+. No watermarks.', 'critical'),
        chk('prod-price',   'Price Clearly Displayed',     hasPrice,
            hasPrice ? 'Price found on page ✓' : 'No price detected',
            'Display product price clearly. Must match price in your GMC product feed exactly.', 'critical'),
        chk('prod-avail',   'Availability Status Shown',   hasAvail,
            hasAvail ? 'Availability status found ✓' : 'No availability status found',
            'Show in-stock/out-of-stock status. Required for GMC product feeds.', 'critical'),
        chk('prod-brand',   'Brand Information Present',   hasBrand ? true : 'warn',
            hasBrand ? 'Brand data found ✓' : 'No brand information detected',
            'Add brand name to product schema and product description. Required by GMC for all products.', 'important'),
      ];
    }

    // ========== NEW CHECKS ==========

    // 11. Homepage scroll length
    function homepageLengthChecks() {
      if (pageTypeParam !== 'home') return null;
      const viewportHeight = window.innerHeight;
      const pageHeight = document.documentElement.scrollHeight;
      const scrolls = pageHeight / viewportHeight;
      const condition = scrolls >= 10;
      return chk('homepage-length', 'Homepage Scroll Length',
        condition,
        `Page height is ${scrolls.toFixed(1)} screen heights (recommended: 2.5–3)`,
        'Add more content (images, text, categories) to increase scroll depth. Longer pages improve engagement.',
        'important');
    }

    // 12. Empty Product Categories
    async function emptyCategoryChecks() {
      if (pageTypeParam !== 'home') return [];
      const categoryLinks = allLinks.filter(link => {
        const text = link.textContent.toLowerCase();
        const href = link.href.toLowerCase();
        return (text.includes('category') || text.includes('collection') ||
                href.includes('/category/') || href.includes('/collection/')) &&
               !href.includes('#') && !href.includes('javascript:');
      });
      const emptyCategories = [];
      for (const link of categoryLinks.slice(0, 5)) {
        try {
          const res = await fetch(link.href);
          const text = await res.text();
          if (text.includes('0 products') || text.includes('no products') || text.includes('No products')) {
            emptyCategories.push(link.href);
          }
        } catch {}
      }
      const isEmpty = emptyCategories.length > 0;
      return chk('empty-categories', 'No Empty Product Categories',
        !isEmpty,
        isEmpty ? `Found empty category: ${emptyCategories[0]}` : 'All checked categories contain products',
        'Ensure every category page has at least one product. Empty categories can hurt trust and SEO.',
        'important');
    }

    // 13. Broken internal links
    async function brokenLinksChecks() {
      if (pageTypeParam !== 'home') return null;
      const internalLinks = allLinks.filter(link => {
        try {
          const u = new URL(link.href, loc.href);
          return u.hostname === loc.hostname;
        } catch { return false; }
      }).slice(0, 20);
      const broken = [];
      for (const link of internalLinks) {
        try {
          const res = await fetch(link.href, { method: 'HEAD', cache: 'no-store' });
          if (res.status >= 400) broken.push(link.href);
        } catch {
          broken.push(link.href);
        }
      }
      const isOk = broken.length === 0;
      return chk('broken-links', 'No Broken Internal Links',
        isOk,
        isOk ? 'No broken internal links found' : `${broken.length} broken internal link(s) found: ${broken.slice(0,3).join(', ')}`,
        'Fix broken links by updating or removing them. Use a tool like deadlinkchecker.com to scan your entire site.',
        'important');
    }

    // 14. Business Address Format
    function businessAddressChecks() {
      if (pageTypeParam !== 'policy') return null;
      const body = document.body.innerText;
      const addressPattern = /(\d{1,5}\s\w+\s\w+|\w+\s\d{1,5}),\s*[\w\s]+,\s*[\w\s]+,\s*[\w\s]+,\s*[\w\s]+/i;
      const hasAddress = addressPattern.test(body);
      return chk('address-format', 'Business Address Format',
        hasAddress,
        hasAddress ? 'Address found in correct format' : 'Address missing or not in correct format (Street, City, State, Zip, Country)',
        'Add a complete business address on your contact page: Street + Number, City, State/Province, Zipcode, Country.',
        'critical');
    }

    // 15. Customer Service Hours
    function customerServiceHoursChecks() {
      if (pageTypeParam !== 'policy') return null;
      const body = document.body.innerText;
      const hasHours = /customer service.*(mon|tue|wed|thu|fri|monday|tuesday|wednesday|thursday|friday|9\s*am|10\s*am)/i.test(body);
      return chk('service-hours', 'Customer Service Hours',
        hasHours,
        hasHours ? 'Customer service hours mentioned' : 'No customer service hours found',
        'Add your support hours (e.g., "Mon-Fri 9am-5pm") on your contact page or footer.',
        'important');
    }

    // 16. Payment Methods Listed
    function paymentMethodsChecks() {
      const paymentMethods = ['visa', 'mastercard', 'paypal', 'amex', 'american express', 'maestro', 'ideal', 'klarna'];
      const found = paymentMethods.filter(m => bodyText.includes(m));
      const hasAtLeastTwo = found.length >= 2;
      return chk('payment-methods', 'Payment Methods Listed',
        hasAtLeastTwo,
        hasAtLeastTwo ? `${found.length} payment methods found (${found.slice(0,3).join(', ')})` : 'Few or no payment methods mentioned',
        'Display accepted payment methods (e.g., Visa, Mastercard, PayPal) in footer and on checkout page.',
        'important');
    }

    // 17. Cookie Consent in Privacy Policy
    function cookieConsentChecks() {
      if (pageTypeParam !== 'policy') return null;
      const text = document.body.innerText;
      const hasCookies = /cookies?|gdpr|consent/i.test(text);
      return chk('cookie-consent', 'Cookie Policy Mentioned',
        hasCookies,
        hasCookies ? 'Privacy policy mentions cookies' : 'No mention of cookies in privacy policy',
        'Add a section about cookies and how users can manage them. Required for GDPR compliance.',
        'important');
    }

    // 18. Terms of Service Links to Other Policies
    function tosLinksChecks() {
      if (pageTypeParam !== 'policy') return null;
      const text = document.body.innerText;
      const hasLinks = /privacy|shipping|return|payment/i.test(text);
      return chk('tos-links', 'Terms of Service Links to Policies',
        hasLinks,
        hasLinks ? 'Terms includes links to other policies' : 'Terms does not link to other important policies',
        'In your Terms of Service, link to Privacy Policy, Shipping, Returns, etc. for clarity.',
        'important');
    }

    // 19. Track Order Page with Contact Info
    function trackOrderChecks() {
      const trackPage = allLinks.find(link => /track\s*order|order\s*status/i.test(link.textContent) || /track\s*order|order\s*status/i.test(link.href));
      if (!trackPage) return chk('track-order', 'Track Order Page', false, 'No track order page link found', 'Add a "Track Your Order" page in the header/footer.', 'important');
      if (pageTypeParam !== 'policy' && trackPage.href !== loc.href) return null;
      const text = document.body.innerText;
      const hasContact = /contact|email|phone/i.test(text);
      return chk('track-order', 'Track Order Page with Contact Info',
        hasContact,
        hasContact ? 'Track order page includes contact info' : 'Track order page missing contact details',
        'Ensure your track order page includes a way to contact support in case of issues.',
        'important');
    }

    // 20. Footer Completeness
    function footerChecks() {
      const footer = document.querySelector('footer') || document.querySelector('[class*="footer"]');
      if (!footer) return chk('footer', 'Footer Content', false, 'No footer found', 'Add a footer with links to important pages.', 'important');
      const footerText = footer.innerText.toLowerCase();
      const required = ['privacy', 'shipping', 'return', 'payment', 'terms', 'contact', 'about', 'faq', 'track', 'social'];
      const present = required.filter(r => footerText.includes(r));
      const isOk = present.length >= 6;
      return chk('footer', 'Footer Completeness',
        isOk,
        `${present.length}/${required.length} key links found in footer`,
        'Include links to Privacy, Shipping, Returns, Payment, Terms, Contact, About, FAQ, Track Order, Social profiles, and payment icons in your footer.',
        'important');
    }

    // 21. Tax Calculation Mention
    function taxChecks() {
      const text = bodyText;
      const hasTax = /tax|vat|sales tax|gst/i.test(text);
      const noTaxMention = /no tax|tax free|tax excluded/i.test(text);
      const condition = hasTax && !noTaxMention;
      return chk('tax', 'Tax Calculation Mentioned',
        condition,
        condition ? 'Tax information found' : (noTaxMention ? 'Mentions "no tax" – may be misleading' : 'No tax information found'),
        'Clearly state if and how tax is calculated. Do not say "no tax" unless it is actually true (e.g., for certain jurisdictions).',
        'important');
    }

    // 22. Overpromising Statements
    function overpromisingChecks() {
      const txt = bodyText;
      const overpromise = /\b(best\s*in\s*the\s*world|guaranteed\s*results|100%\s*satisfaction\s*guaranteed|miracle|magic\s*cure)\b/i.test(txt);
      return chk('no-overpromise', 'No Overpromising Statements',
        !overpromise,
        overpromise ? '⚠️ Overpromising language detected' : 'No overpromising statements found',
        'Avoid exaggerated claims like "best in the world" or "miracle cure". Be factual.',
        'important');
    }

    // 23. Payment Processor Detection (scans scripts on all pages)
    function paymentProcessorChecks() {
      const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src.toLowerCase());
      const hasStripe = scripts.some(s => s.includes('stripe.com'));
      const hasPayPal = scripts.some(s => s.includes('paypal.com') || s.includes('paypalobjects.com'));
      const hasBraintree = scripts.some(s => s.includes('braintree'));
      const hasSquare = scripts.some(s => s.includes('squareup.com'));
      const hasProcessor = hasStripe || hasPayPal || hasBraintree || hasSquare;
      const processors = [];
      if (hasStripe) processors.push('Stripe');
      if (hasPayPal) processors.push('PayPal');
      if (hasBraintree) processors.push('Braintree');
      if (hasSquare) processors.push('Square');
      return chk('payment-processor', 'Payment Processor Detected',
        hasProcessor,
        hasProcessor ? `${processors.join(', ')} detected` : 'No known payment processor script found',
        'Ensure your checkout page includes scripts from a supported payment processor (Stripe, PayPal, Braintree, Square).',
        'critical');
    }

    // 24. Checkout Page Functionality (only on checkout pages)
    async function checkoutPageChecks() {
      if (pageTypeParam !== 'checkout') return null;
      // Check for essential fields
      const hasAddressField = document.querySelector('input[name*="address"], input[name*="street"], input[name*="city"], input[name*="zip"], input[name*="postal"]') !== null;
      const hasPaymentMethod = document.querySelector('select[name*="payment"], input[name*="payment"], div[class*="payment"]') !== null ||
                               document.querySelector('input[type="radio"][value*="card"], input[type="radio"][value*="paypal"]') !== null;
      // Check for JavaScript errors
      const hasJSErrors = window.__gmc_js_errors && window.__gmc_js_errors.length > 0;
      const checks = [];
      checks.push(chk('checkout-exists', 'Checkout Page Exists', true, 'Checkout page is accessible', 'Ensure the checkout page is reachable.', 'critical'));
      checks.push(chk('checkout-fields', 'Checkout Has Essential Fields', hasAddressField && hasPaymentMethod,
        hasAddressField && hasPaymentMethod ? 'Address and payment fields found' : (hasAddressField ? 'Missing payment method selection' : (hasPaymentMethod ? 'Missing address fields' : 'Missing both address and payment fields')),
        'Your checkout page must include address fields (street, city, zip) and payment method selection.', 'critical'));
      checks.push(chk('checkout-js-errors', 'No JavaScript Errors on Checkout', !hasJSErrors,
        hasJSErrors ? 'JavaScript errors detected on checkout page' : 'No JavaScript errors detected',
        'Fix any JavaScript errors on the checkout page; they can break the checkout process.', 'important'));
      return checks;
    }

    // ========== ASSEMBLE RESULTS ==========
    const [crawl, policies, emptyCatCheck, brokenCheck] = await Promise.all([
      crawlabilityChecks(),
      policyChecks(),
      emptyCategoryChecks(),
      brokenLinksChecks()
    ]);

    // Build categories
    const categories = [
      { id:'technical',         name:'Technical Setup',       icon:'⚙️',  checks: technicalChecks(),       weight: 1.2 },
      { id:'crawlability',      name:'Crawlability',           icon:'🤖',  checks: crawl,                   weight: 1.2 },
      { id:'policyPages',       name:'Policy Pages',           icon:'📋',  checks: policies,                weight: 1.5 },
      { id:'productData',       name:'Product Data',           icon:'🛍️',  checks: productDataChecks(),     weight: 1.5 },
      { id:'schemaMarkup',      name:'Schema Markup',          icon:'🔖',  checks: schemaChecks(),          weight: 1.2 },
      { id:'digitalFootprint',  name:'Digital Footprint',      icon:'🌐',  checks: digitalFootprintChecks(),weight: 1.0 },
      { id:'mobileSpeed',       name:'Mobile & Speed',         icon:'📱',  checks: mobileSpeedChecks(),     weight: 1.1 },
      { id:'trustSignals',      name:'Trust Signals',          icon:'🔒',  checks: trustSignalChecks(),     weight: 1.1 },
      { id:'googleEcosystem',   name:'Google Ecosystem',       icon:'🅶',   checks: googleEcosystemChecks(), weight: 1.3 },
      { id:'prohibitedContent', name:'Prohibited Content',     icon:'🚫',  checks: prohibitedChecks(),      weight: 1.5 },
    ];

    // Business details checks
    const businessChecks = [
      homepageLengthChecks(),
      emptyCatCheck,
      brokenCheck,
      businessAddressChecks(),
      customerServiceHoursChecks(),
      paymentMethodsChecks(),
      cookieConsentChecks(),
      tosLinksChecks(),
      trackOrderChecks(),
      footerChecks(),
      taxChecks(),
      overpromisingChecks(),
      paymentProcessorChecks()
    ].filter(c => c !== null);
    if (businessChecks.length) {
      categories.push({ id:'businessDetails', name:'Business Details', icon:'🏢', checks: businessChecks, weight: 1.2 });
    }

    // Checkout page checks (only if this is a checkout page)
    const checkoutChecksList = await checkoutPageChecks();
    if (checkoutChecksList && checkoutChecksList.length) {
      categories.push({ id:'checkout', name:'Checkout & Payments', icon:'💳', checks: checkoutChecksList, weight: 1.5 });
    }

    categories.forEach(c => { c.score = catScore(c.checks); });

    const allChecksList = categories.flatMap(c => c.checks);
    const passing = allChecksList.filter(c => c.status === 'pass').length;
    const warnings = allChecksList.filter(c => c.status === 'warning').length;
    const failing = allChecksList.filter(c => c.status === 'fail').length;

    const wSum = categories.reduce((s,c) => s + c.score * c.weight, 0);
    const wTotal = categories.reduce((s,c) => s + c.weight, 0);
    const overallScore = Math.round(wSum / wTotal);

    const readiness = overallScore >= 90 ? 'Ready to Submit' : overallScore >= 60 ? 'Needs Improvement' : 'Critical Issues Found';

    const results = {
      meta: {
        url: loc.href,
        domain,
        title: pageTitle,
        platform,
        isShopify,
        timestamp: new Date().toISOString(),
        auditor: 'GMC Guardian v1.0'
      },
      overallScore,
      readiness,
      summary: { passing, warnings, failing, total: allChecksList.length },
      categories,
      pageType: pageTypeParam,
      jsErrors: window.__gmc_js_errors || []
    };
    return results;
  }, pageType);

  log(`Finished audit of ${pageType} page: ${url}`);
  return result;
}

// ---------------------------------------------------------------------
// Helper: Collect internal links from the homepage
// ---------------------------------------------------------------------
async function collectLinksFromHomepage(page, baseUrl) {
  log(`Collecting internal links from homepage: ${baseUrl}`);
  const links = await page.evaluate((baseUrl) => {
    const links = Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
    const internal = links.filter(href => {
      try {
        const u = new URL(href, baseUrl);
        return u.hostname === window.location.hostname && u.pathname !== '/';
      } catch {
        return false;
      }
    });
    const policyKeywords = ['privacy', 'return', 'refund', 'shipping', 'terms', 'contact', 'about', 'faq'];
    const policyPages = internal.filter(url =>
      policyKeywords.some(kw => url.toLowerCase().includes(kw))
    );
    const productPatterns = [/\/product\//i, /\/products\//i, /\/p\//i, /\/item\//i];
    const productPages = internal.filter(url =>
      productPatterns.some(p => p.test(url))
    );
    const categoryPatterns = [/\/category\//i, /\/collections\//i, /\/shop\//i];
    const categoryPages = internal.filter(url =>
      categoryPatterns.some(p => p.test(url))
    );
    // Checkout page detection: look for a link that contains /checkout or /cart, or has text "checkout"
    const checkoutLink = internal.find(url =>
      url.toLowerCase().includes('/checkout') ||
      url.toLowerCase().includes('/cart') ||
      (document.querySelector(`a[href="${url}"]`) && /checkout/i.test(document.querySelector(`a[href="${url}"]`).textContent))
    );
    const checkoutPage = checkoutLink ? checkoutLink : null;
    return { policyPages, productPages, categoryPages, checkoutPage };
  }, baseUrl);
  log(`Found ${links.policyPages.length} policy pages, ${links.productPages.length} product pages, ${links.categoryPages.length} category pages, checkout page: ${links.checkoutPage || 'none'}`);
  return links;
}

// ---------------------------------------------------------------------
// Helper: Aggregate results from multiple pages
// ---------------------------------------------------------------------
function aggregateResults(resultsArray) {
  log(`Aggregating results from ${resultsArray.length} pages...`);
  if (!resultsArray.length) return null;
  const base = resultsArray[0];

  const productChecks = [];
  resultsArray.forEach(page => {
    const prodCat = page.categories.find(c => c.id === 'productData');
    if (prodCat && prodCat.checks && page.pageType === 'product') {
      productChecks.push(...prodCat.checks);
    }
  });

  const productCategory = base.categories.find(c => c.id === 'productData');
  if (productCategory && productChecks.length) {
    productCategory.checks = productChecks;
    productCategory.score = catScore(productChecks);
    log(`Merged product data from ${productChecks.length} checks across ${resultsArray.filter(r => r.pageType === 'product').length} product pages.`);
  }

  // Also merge payment processor detection across all pages
  const processorChecks = [];
  resultsArray.forEach(page => {
    const procCat = page.categories.find(c => c.id === 'businessDetails');
    if (procCat && procCat.checks) {
      const procCheck = procCat.checks.find(ch => ch.id === 'payment-processor');
      if (procCheck && procCheck.status === 'pass') {
        processorChecks.push(procCheck);
      }
    }
  });
  if (processorChecks.length) {
    const businessCat = base.categories.find(c => c.id === 'businessDetails');
    if (businessCat) {
      const existingIdx = businessCat.checks.findIndex(ch => ch.id === 'payment-processor');
      if (existingIdx !== -1) {
        // Replace with a merged version: if any page had a processor, it's a pass
        const anyPass = processorChecks.some(ch => ch.status === 'pass');
        businessCat.checks[existingIdx] = {
          ...businessCat.checks[existingIdx],
          status: anyPass ? 'pass' : 'fail',
          detail: anyPass ? `Payment processor detected on at least one page` : 'No payment processor found on any page',
        };
        businessCat.score = catScore(businessCat.checks);
      }
    }
  }

  const allChecks = base.categories.flatMap(c => c.checks);
  const passing = allChecks.filter(c => c.status === 'pass').length;
  const warnings = allChecks.filter(c => c.status === 'warning').length;
  const failing = allChecks.filter(c => c.status === 'fail').length;
  base.summary = { passing, warnings, failing, total: allChecks.length };

  let wSum = 0, wTotal = 0;
  base.categories.forEach(c => {
    wSum += c.score * c.weight;
    wTotal += c.weight;
  });
  base.overallScore = Math.round(wSum / wTotal);
  base.readiness = base.overallScore >= 90 ? 'Ready to Submit' : base.overallScore >= 60 ? 'Needs Improvement' : 'Critical Issues Found';
  base.meta.fullSite = true;

  log(`Aggregation complete. Overall score: ${base.overallScore} (${base.readiness})`);
  return base;
}

// ---------------------------------------------------------------------
// Helper function to compute category score (needed in aggregation)
// ---------------------------------------------------------------------
function catScore(checks) {
  if (!checks.length) return 0;
  const pts = checks.reduce((s, c) => s + (c.status === 'pass' ? 1 : c.status === 'warning' ? 0.5 : 0), 0);
  return Math.round((pts / checks.length) * 100);
}

// ---------------------------------------------------------------------
// Single‑page audit endpoint
// ---------------------------------------------------------------------
app.post('/api/audit', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  log(`Single-page audit requested for ${url}`);
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    log(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    const pageTitle = await page.title();
    log(`Page loaded. Title: "${pageTitle}"`);
    const result = await auditPage(page, url, 'home');
    await browser.close();
    log(`Audit complete for ${url}`);
    res.json(result);
  } catch (err) {
    log(`Error auditing ${url}: ${err.message}`);
    if (browser) await browser.close();
    res.status(500).json({ error: 'Audit failed: ' + err.message });
  }
});

// ---------------------------------------------------------------------
// Full‑site audit endpoint (with cart simulation)
// ---------------------------------------------------------------------
app.post('/api/full-audit', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  log(`========================================`);
  log(`FULL SITE AUDIT STARTED for ${url}`);
  log(`========================================`);

  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();

    // 1. Go to homepage and collect links
    log(`Navigating to homepage: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    const homepageTitle = await page.title();
    log(`Homepage loaded. Title: "${homepageTitle}"`);
    const { policyPages, productPages, categoryPages, checkoutPage } = await collectLinksFromHomepage(page, url);
    log(`Discovered ${policyPages.length} policy pages, ${productPages.length} product pages, ${categoryPages.length} category pages, checkout page (from link): ${checkoutPage || 'none'}`);

    // 2. Audit the homepage
    log(`Auditing homepage...`);
    const homeResult = await auditPage(page, url, 'home');
    const allResults = [homeResult];
    log(`Homepage audit complete.`);

    // 3. Crawl policy pages (up to 10)
    const policyUrls = [...new Set(policyPages)].slice(0, 10);
    if (policyUrls.length) {
      log(`Starting audit of ${policyUrls.length} policy page(s)...`);
      for (const [idx, policyUrl] of policyUrls.entries()) {
        log(`[${idx+1}/${policyUrls.length}] Auditing policy page: ${policyUrl}`);
        const newPage = await browser.newPage();
        try {
          await newPage.goto(policyUrl, { waitUntil: 'networkidle0', timeout: 60000 });
          const policyTitle = await newPage.title();
          log(`Policy page loaded. Title: "${policyTitle}"`);
          const result = await auditPage(newPage, policyUrl, 'policy');
          allResults.push(result);
          log(`Policy page ${policyUrl} audit complete.`);
        } catch (err) {
          log(`Failed to audit policy page ${policyUrl}: ${err.message}`);
        } finally {
          await newPage.close();
        }
      }
    } else {
      log(`No policy pages found to audit.`);
    }

    // 4. Crawl product pages (up to 10) – but we also use the first one for cart simulation
    const productUrls = [...new Set(productPages)].slice(0, 10);
    if (productUrls.length) {
      log(`Starting audit of ${productUrls.length} product page(s)...`);
      for (const [idx, prodUrl] of productUrls.entries()) {
        log(`[${idx+1}/${productUrls.length}] Auditing product page: ${prodUrl}`);
        const newPage = await browser.newPage();
        try {
          await newPage.goto(prodUrl, { waitUntil: 'networkidle0', timeout: 60000 });
          const prodTitle = await newPage.title();
          log(`Product page loaded. Title: "${prodTitle}"`);
          const result = await auditPage(newPage, prodUrl, 'product');
          allResults.push(result);
          log(`Product page ${prodUrl} audit complete.`);
        } catch (err) {
          log(`Failed to audit product page ${prodUrl}: ${err.message}`);
        } finally {
          await newPage.close();
        }
      }
    } else {
      log(`No product pages found to audit.`);
    }

    // 5. Crawl category pages (up to 5)
    const categoryUrls = [...new Set(categoryPages)].slice(0, 5);
    if (categoryUrls.length) {
      log(`Starting audit of ${categoryUrls.length} category page(s)...`);
      for (const [idx, catUrl] of categoryUrls.entries()) {
        log(`[${idx+1}/${categoryUrls.length}] Auditing category page: ${catUrl}`);
        const newPage = await browser.newPage();
        try {
          await newPage.goto(catUrl, { waitUntil: 'networkidle0', timeout: 60000 });
          const catTitle = await newPage.title();
          log(`Category page loaded. Title: "${catTitle}"`);
          const result = await auditPage(newPage, catUrl, 'category');
          allResults.push(result);
          log(`Category page ${catUrl} audit complete.`);
        } catch (err) {
          log(`Failed to audit category page ${catUrl}: ${err.message}`);
        } finally {
          await newPage.close();
        }
      }
    } else {
      log(`No category pages found to audit.`);
    }

    // 6. Simulate adding a product to cart and go to checkout
    let checkoutUrl = null;
    if (productUrls.length) {
      checkoutUrl = await simulateAddToCartAndCheckout(browser, url, productUrls);
    }

    if (checkoutUrl) {
      log(`Auditing checkout page (with cart): ${checkoutUrl}`);
      const newPage = await browser.newPage();
      try {
        await newPage.goto(checkoutUrl, { waitUntil: 'networkidle0', timeout: 60000 });
        const result = await auditPage(newPage, checkoutUrl, 'checkout');
        allResults.push(result);
        log(`Checkout page audit complete.`);
      } catch (err) {
        log(`Failed to audit checkout page ${checkoutUrl}: ${err.message}`);
      } finally {
        await newPage.close();
      }
    } else {
      log(`Could not simulate cart and checkout.`);
      // Add a placeholder check in the report
      const dummyCheck = {
        meta: { domain: new URL(url).hostname },
        categories: [{ id: 'checkout', name: 'Checkout & Payments', checks: [{
          id: 'checkout-simulation-failed', name: 'Checkout Page Not Simulated', status: 'fail',
          detail: 'Could not add a product to cart or find the checkout page. The checkout page may require manual interaction.',
          fix: 'Ensure your store has a product with a working "Add to Cart" button and a checkout link.',
          importance: 'critical'
        }], weight: 1.5 }]
      };
      allResults.push(dummyCheck);
    }

    // 7. Aggregate results
    log(`All pages audited. Aggregating results...`);
    const finalReport = aggregateResults(allResults);
    await browser.close();

    log(`========================================`);
    log(`FULL SITE AUDIT COMPLETE for ${url}`);
    log(`========================================`);
    res.json(finalReport);
  } catch (err) {
    log(`FULL SITE AUDIT FAILED: ${err.message}`);
    if (browser) await browser.close();
    res.status(500).json({ error: 'Full audit failed: ' + err.message });
  }
});

// ---------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Server running on http://localhost:${PORT}`);
  log(`Waiting for audit requests...`);
});