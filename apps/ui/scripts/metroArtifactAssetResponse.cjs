const { createRequire } = require('node:module');
const { extname } = require('node:path');

// Use the compressor already owned by the installed Expo development server.
const expoRequire = createRequire(require.resolve('expo/package.json'));
const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
const compress = cliRequire('compression')();

exports.createArtifactAssetResponse = (middleware, artifactExtensions) => (req, res, next) => {
    let url;
    try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { return middleware(req, res, next); }
    const assetPath = url.searchParams.get('unstable_path')?.split('?')[0] ?? url.pathname;
    if (!/^\/assets(?:\/|$)/.test(url.pathname) || !artifactExtensions.includes(extname(assetPath).slice(1))) {
        return middleware(req, res, next);
    }
    const setHeader = res.setHeader;
    res.setHeader = function (name, value) {
        // Metro's MIME lookup returns false for packaged .bundle files. Keep
        // errors and other response types under their existing serving owner.
        if (name.toLowerCase() === 'content-type' && (value === false || value === 'false')) {
            value = assetPath.endsWith('.map') || assetPath.endsWith('.json.bundle')
                ? 'application/json' : 'application/javascript';
        }
        return setHeader.call(this, name, value);
    };
    return compress(req, res, () => middleware(req, res, next));
};
