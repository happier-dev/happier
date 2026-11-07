const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join } = require('node:path');

// The public inventory and upstream root share one installed registry. Resolve
// its identity through that public entry rather than copying its generated hash.
exports.resolveShikiGrammarRegistry = (uiPackageDir) => {
    const requireFromUi = createRequire(join(uiPackageDir, 'package.json'));
    const entry = requireFromUi.resolve('shiki/langs');
    const imports = [...readFileSync(entry, 'utf8').matchAll(/\bfrom\s*["'](\.[^"']+)["']/gu)];
    if (imports.length !== 1) throw new Error('Installed Shiki language registry layout is unsupported');
    return createRequire(entry).resolve(imports[0][1]);
};
