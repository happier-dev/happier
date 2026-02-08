function withWindowsHide(options, platform = process.platform) {
  if (platform === 'win32') {
    return { ...options, windowsHide: true };
  }
  return options;
}

module.exports = {
  withWindowsHide,
};

