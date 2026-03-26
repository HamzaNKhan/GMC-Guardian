const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Change the cache directory to a folder inside your project
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
