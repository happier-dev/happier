import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

it('includes password crypto in a standalone ESM bundle without adjacent dependencies', async () => {
  await withTempDir('happier-password-crypto-bundle-', async (dir) => {
    const entry = join(dir, 'entry.ts');
    const cryptoPath = fileURLToPath(new URL('./nativeEmailPasswordCrypto.ts', import.meta.url));
    await writeFile(entry, `
import { deriveNativeEmailPasswordKeys } from ${JSON.stringify(cryptoPath)};
const keys = await deriveNativeEmailPasswordKeys({
  password: 'a password with spaces 🗝',
  kdf: { algorithm: 'argon2id13', salt: 'AAAAAAAAAAAAAAAAAAAAAA', opsLimit: 3,
    memLimitBytes: 64 * 1024 * 1024, outputBytes: 32 },
});
try { console.log(Buffer.from(keys.authKey).toString('base64url')); }
finally { keys.authKey.fill(0); keys.wrapKey.fill(0); }
`, 'utf8');
    const bundledEntry = join(dir, 'entry.mjs');
    const tsconfig = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
    await build({
      entryPoints: [entry], outfile: bundledEntry, bundle: true, platform: 'node', format: 'esm', tsconfig,
      // Supply Node's CommonJS globals for bundled dependencies' built-in
      // imports. They must still resolve from this isolated bundle root.
      banner: { js: [
        "import { createRequire as __bundleCreateRequire } from 'node:module';",
        "import { fileURLToPath as __bundleFilePath } from 'node:url';",
        "import { dirname as __bundleDirname } from 'node:path';",
        'const require = __bundleCreateRequire(import.meta.url);',
        'const __filename = __bundleFilePath(import.meta.url);',
        'const __dirname = __bundleDirname(__filename);',
      ].join('\n') },
    });
    // No repository cwd, NODE_PATH, or adjacent dependency tree may hide a
    // module-URL require omitted from the self-contained bundle.
    const result = spawnSync(process.execPath, [bundledEntry], { cwd: dir, env: { ...process.env, NODE_PATH: '' }, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('7VQv5bMjwJVCy2xKgDSf4iZBHCsrd3O2eJY12_UWhZE');
  });
});
