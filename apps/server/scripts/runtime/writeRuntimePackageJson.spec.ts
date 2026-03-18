import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { writeRuntimePackageJson } from './writeRuntimePackageJson';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('writeRuntimePackageJson', () => {
  it('writes a runtime-focused package.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-server-runtime-pkg-'));
    tempDirs.push(root);

    const projectDir = join(root, 'workspace', 'apps', 'server');
    const destRoot = join(root, 'dest');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(root, 'workspace', 'node_modules', 'privacy-kit'), { recursive: true });
    await writeFile(
      join(projectDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/server',
        version: '0.1.2',
        type: 'module',
        scripts: { build: 'tsc --noEmit' },
        dependencies: { fastify: '^5.0.0', '@happier-dev/agents': '0.0.0', 'privacy-kit': '^0.0.25' },
      }) + '\n',
      'utf-8',
    );
    await writeFile(
      join(root, 'workspace', 'node_modules', 'privacy-kit', 'package.json'),
      JSON.stringify({
        name: 'privacy-kit',
        version: '0.0.25',
        type: 'module',
        exports: {
          import: './dist/index.mjs',
          require: './dist/index.cjs',
        },
        dependencies: {
          '@cloudflare/voprf-ts': '^1.0.0',
          '@noble/curves': '^1.9.0',
          '@noble/hashes': '^1.8.0',
        },
      }) + '\n',
      'utf-8',
    );
    await mkdir(join(root, 'workspace', 'node_modules', 'privacy-kit', 'dist'), { recursive: true });
    await writeFile(join(root, 'workspace', 'node_modules', 'privacy-kit', 'dist', 'index.mjs'), 'export {};\n', 'utf-8');
    await writeFile(join(root, 'workspace', 'node_modules', 'privacy-kit', 'dist', 'index.cjs'), 'module.exports = {};\n', 'utf-8');

    await writeRuntimePackageJson({ projectDir, destRoot });

    const written = JSON.parse(await readFile(join(destRoot, 'package.json'), 'utf-8'));
    expect(written).toEqual({
      name: '@happier-dev/server',
      version: '0.1.2',
      private: true,
      type: 'module',
      dependencies: {
        fastify: '^5.0.0',
        '@happier-dev/agents': '0.0.0',
        'privacy-kit': '^0.0.25',
        '@cloudflare/voprf-ts': '^1.0.0',
        '@noble/curves': '^1.9.0',
        '@noble/hashes': '^1.8.0',
      },
    });
  });
});
