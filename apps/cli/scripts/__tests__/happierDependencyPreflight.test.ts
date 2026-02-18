import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('happier bin preflight', () => {
  it('works when protocol deps are vendored under protocol/node_modules (not hoisted to the CLI root)', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..', '..');
    const tempRoot = mkdtempSync(join(tmpdir(), 'happier-bin-preflight-'));

    mkdirSync(resolve(tempRoot, 'bin'), { recursive: true });
    mkdirSync(resolve(tempRoot, 'dist'), { recursive: true });

    // Global-install / packed layout:
    // - protocol is present as a bundled workspace package
    // - protocol runtime deps are vendored under protocol/node_modules
    mkdirSync(resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'base64-js'), {
      recursive: true,
    });
    mkdirSync(resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes'), {
      recursive: true,
    });

    // CLI direct dep is expected at the CLI root.
    mkdirSync(resolve(tempRoot, 'node_modules', 'tweetnacl'), { recursive: true });

    cpSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'happier.mjs'), resolve(tempRoot, 'bin', 'happier.mjs'));

    writeFileSync(
      resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol', 'package.json'),
      JSON.stringify({ name: '@happier-dev/protocol', version: '0.0.0' }),
      'utf8',
    );
    writeFileSync(
      resolve(tempRoot, 'node_modules', 'tweetnacl', 'package.json'),
      JSON.stringify({ name: 'tweetnacl', version: '0.0.0', main: 'index.js' }),
      'utf8',
    );
    writeFileSync(resolve(tempRoot, 'node_modules', 'tweetnacl', 'index.js'), 'module.exports = {};\n', 'utf8');

    writeFileSync(
      resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'base64-js', 'package.json'),
      JSON.stringify({ name: 'base64-js', version: '0.0.0', main: 'index.js' }),
      'utf8',
    );
    writeFileSync(
      resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'base64-js', 'index.js'),
      'module.exports = {};\n',
      'utf8',
    );

    writeFileSync(
      resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'package.json'),
      JSON.stringify({ name: '@noble/hashes', version: '0.0.0', main: 'index.js' }),
      'utf8',
    );
    writeFileSync(
      resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'hmac.js'),
      'export {};\n',
      'utf8',
    );
    writeFileSync(
      resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'sha512.js'),
      'export {};\n',
      'utf8',
    );

    writeFileSync(resolve(tempRoot, 'dist', 'index.mjs'), "console.log('ok');\n", 'utf8');

    const result = spawnSync(process.execPath, [resolve(tempRoot, 'bin', 'happier.mjs')], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok');
  });

  it('prints a helpful error when tweetnacl is missing', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..', '..');
    const tempRoot = mkdtempSync(join(tmpdir(), 'happier-bin-preflight-'));

    mkdirSync(resolve(tempRoot, 'bin'), { recursive: true });
    mkdirSync(resolve(tempRoot, 'dist'), { recursive: true });
    mkdirSync(resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol'), { recursive: true });

    cpSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'happier.mjs'), resolve(tempRoot, 'bin', 'happier.mjs'));

    writeFileSync(
      resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol', 'package.json'),
      JSON.stringify({ name: '@happier-dev/protocol', version: '0.0.0' }),
      'utf8',
    );
    writeFileSync(
      resolve(tempRoot, 'dist', 'index.mjs'),
      "console.log('ok');\n",
      'utf8',
    );

    const result = spawnSync(process.execPath, [resolve(tempRoot, 'bin', 'happier.mjs')], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing required dependency: tweetnacl');
  });

  it('prints a helpful error when base64-js is missing', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..', '..');
    const tempRoot = mkdtempSync(join(tmpdir(), 'happier-bin-preflight-'));

    mkdirSync(resolve(tempRoot, 'bin'), { recursive: true });
    mkdirSync(resolve(tempRoot, 'dist'), { recursive: true });
    mkdirSync(resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol'), { recursive: true });
    mkdirSync(resolve(tempRoot, 'node_modules', 'tweetnacl'), { recursive: true });

    cpSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'happier.mjs'), resolve(tempRoot, 'bin', 'happier.mjs'));

    writeFileSync(
      resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol', 'package.json'),
      JSON.stringify({ name: '@happier-dev/protocol', version: '0.0.0' }),
      'utf8',
    );
    writeFileSync(
      resolve(tempRoot, 'node_modules', 'tweetnacl', 'package.json'),
      JSON.stringify({ name: 'tweetnacl', version: '0.0.0', main: 'index.js' }),
      'utf8',
    );
    writeFileSync(resolve(tempRoot, 'node_modules', 'tweetnacl', 'index.js'), 'module.exports = {};\n', 'utf8');

    writeFileSync(resolve(tempRoot, 'dist', 'index.mjs'), "console.log('ok');\n", 'utf8');

    const result = spawnSync(process.execPath, [resolve(tempRoot, 'bin', 'happier.mjs')], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing required dependency: base64-js');
  });

  it('prints a helpful error when @noble/hashes/hmac is missing', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..', '..');
    const tempRoot = mkdtempSync(join(tmpdir(), 'happier-bin-preflight-'));

    mkdirSync(resolve(tempRoot, 'bin'), { recursive: true });
    mkdirSync(resolve(tempRoot, 'dist'), { recursive: true });
    mkdirSync(resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol'), { recursive: true });
    mkdirSync(resolve(tempRoot, 'node_modules', 'tweetnacl'), { recursive: true });
    mkdirSync(resolve(tempRoot, 'node_modules', 'base64-js'), { recursive: true });

    cpSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'happier.mjs'), resolve(tempRoot, 'bin', 'happier.mjs'));

    writeFileSync(
      resolve(tempRoot, 'node_modules', '@happier-dev', 'protocol', 'package.json'),
      JSON.stringify({ name: '@happier-dev/protocol', version: '0.0.0' }),
      'utf8',
    );
    writeFileSync(
      resolve(tempRoot, 'node_modules', 'tweetnacl', 'package.json'),
      JSON.stringify({ name: 'tweetnacl', version: '0.0.0', main: 'index.js' }),
      'utf8',
    );
    writeFileSync(resolve(tempRoot, 'node_modules', 'tweetnacl', 'index.js'), 'module.exports = {};\n', 'utf8');

    writeFileSync(
      resolve(tempRoot, 'node_modules', 'base64-js', 'package.json'),
      JSON.stringify({ name: 'base64-js', version: '0.0.0', main: 'index.js' }),
      'utf8',
    );
    writeFileSync(resolve(tempRoot, 'node_modules', 'base64-js', 'index.js'), 'module.exports = {};\n', 'utf8');

    writeFileSync(resolve(tempRoot, 'dist', 'index.mjs'), "console.log('ok');\n", 'utf8');

    const result = spawnSync(process.execPath, [resolve(tempRoot, 'bin', 'happier.mjs')], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing required dependency: @noble/hashes/hmac');
  });
});
