import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function writeFile(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

describe('apps/cli bin/happier.mjs preflight', () => {
  it('allows @happier-dev/protocol to be hoisted to the repo root node_modules', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'happier-bin-preflight-'));
    try {
      const projectRoot = join(tmp, 'apps', 'cli');
      const binDir = join(projectRoot, 'bin');
      const distDir = join(projectRoot, 'dist');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(distDir, { recursive: true });

      const realBin = join(process.cwd(), 'bin', 'happier.mjs');
      const binSource = readFileSync(realBin, 'utf8');
      writeFileSync(join(binDir, 'happier.mjs'), binSource, 'utf8');

      writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(join(distDir, 'index.mjs'), 'process.exit(0);\n', 'utf8');

      // Simulate the `hstack` clone setup behavior: only root node_modules exist.
      writeFile(
        join(tmp, 'node_modules', '@happier-dev', 'protocol', 'package.json'),
        JSON.stringify({
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          exports: { '.': './dist/index.js' },
        })
      );
      writeFile(
        join(tmp, 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'),
        'export {};\n'
      );
      writeFile(join(tmp, 'node_modules', 'tweetnacl', 'index.js'), 'module.exports = {};\n');
      writeFile(join(tmp, 'node_modules', 'base64-js', 'index.js'), 'module.exports = {};\n');
      writeFile(join(tmp, 'node_modules', '@noble', 'hashes', 'package.json'), JSON.stringify({ name: '@noble/hashes' }));
      writeFile(join(tmp, 'node_modules', '@noble', 'hashes', 'hmac.js'), 'module.exports = {};\n');
      writeFile(join(tmp, 'node_modules', '@noble', 'hashes', 'sha512.js'), 'module.exports = {};\n');

      const res = spawnSync(process.execPath, [join(binDir, 'happier.mjs'), '--help'], {
        cwd: projectRoot,
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prints a helpful error if @happier-dev/protocol cannot be resolved', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'happier-bin-preflight-'));
    try {
      const projectRoot = join(tmp, 'apps', 'cli');
      const binDir = join(projectRoot, 'bin');
      const distDir = join(projectRoot, 'dist');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(distDir, { recursive: true });

      const realBin = join(process.cwd(), 'bin', 'happier.mjs');
      const binSource = readFileSync(realBin, 'utf8');
      writeFileSync(join(binDir, 'happier.mjs'), binSource, 'utf8');

      writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(join(distDir, 'index.mjs'), 'process.exit(0);\n', 'utf8');

      const res = spawnSync(process.execPath, [join(binDir, 'happier.mjs'), '--help'], {
        cwd: projectRoot,
        encoding: 'utf8',
      });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Missing bundled package: @happier-dev/protocol');
      expect(res.stderr).toContain('Reinstall @happier-dev/cli to repair your installation.');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
