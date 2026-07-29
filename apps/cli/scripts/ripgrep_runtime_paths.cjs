const path = require('path');

function resolvePackagedRipgrepBinaryPath(toolsDir, platform = process.platform) {
    return path.join(toolsDir, platform === 'win32' ? 'rg.exe' : 'rg');
}

module.exports = {
    resolvePackagedRipgrepBinaryPath,
};
