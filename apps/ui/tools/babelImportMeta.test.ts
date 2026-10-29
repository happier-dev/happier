import { transformFileSync } from '@babel/core';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { expect, it } from 'vitest';

const uiRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const zipModule = join(dirname(require.resolve('@zip.js/zip.js/package.json')), 'lib/zip-fs.js');

it.each(['ios', 'android', 'web'])('compiles the actual ZIP dependency into a production %s script', platform => {
    // This is the same dependency source and app Babel configuration Metro uses.
    // Node/Vitest's own ESM loader accepts import.meta and cannot catch this bug.
    // Expo's Metro caller adds fields beyond Babel's standard caller type.
    const caller = { name: 'metro', bundler: 'metro', platform, engine: 'hermes', isDev: false, isServer: false, supportsStaticESM: false };
    const result = transformFileSync(zipModule, {
        cwd: uiRoot,
        configFile: join(uiRoot, 'babel.config.js'),
        babelrc: false,
        envName: 'production',
        caller,
    });
    expect(result?.code).toBeTruthy();
    // Metro emits a script on every platform, not a browser/native ES module.
    expect(() => new Script(result!.code!)).not.toThrow();
});
