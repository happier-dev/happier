import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sanitizePackagedNodeModulesTree } from './binary-release.mjs';

// @huggingface/transformers ships a dist/ with build outputs for every consumer (browser, CJS,
// minified, plus the browser-only onnxruntime-web WASM backend), but this payload only ever
// resolves dist/transformers.node.mjs via the package's own package.json exports.node.import
// condition (Node/Bun, dynamic `await import('@huggingface/transformers')` in
// createLocalTransformersEmbeddingsProvider.ts). This is not platform/arch-sensitive -- the same
// files are unreachable on every CLI target, since "which consumer resolves which dist file" is
// determined by the exports map, not by OS/arch.
const CLI_TARGETS = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'linux', arch: 'x64' },
  { os: 'windows', arch: 'x64' },
];

async function buildFakeTransformersDistTree(stageDir) {
  const distDir = join(stageDir, 'node_modules', '@huggingface', 'transformers', 'dist');
  await mkdir(distDir, { recursive: true });

  const unreachableFiles = [
    'transformers.js',
    'transformers.js.map',
    'transformers.min.js',
    'transformers.min.js.map',
    'transformers.web.js',
    'transformers.web.js.map',
    'transformers.web.min.js',
    'transformers.web.min.js.map',
    'transformers.node.cjs',
    'transformers.node.cjs.map',
    'transformers.node.min.cjs',
    'transformers.node.min.cjs.map',
    'transformers.node.min.mjs',
    'transformers.node.min.mjs.map',
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
  ];
  for (const name of unreachableFiles) {
    await writeFile(join(distDir, name), 'placeholder', 'utf-8');
  }

  await writeFile(join(distDir, 'transformers.node.mjs'), 'export default {};', 'utf-8');
  await writeFile(join(distDir, 'transformers.node.mjs.map'), '{}', 'utf-8');

  return distDir;
}

for (const target of CLI_TARGETS) {
  test(`sanitizePackagedNodeModulesTree prunes @huggingface/transformers dist/ to the node build only [${target.os}/${target.arch}]`, async () => {
    const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-transformers-dist-prune-'));
    try {
      const distDir = await buildFakeTransformersDistTree(stageDir);

      await sanitizePackagedNodeModulesTree({ stageDir, target });

      const remaining = (await readdir(distDir)).sort();
      assert.deepEqual(remaining, ['transformers.node.mjs', 'transformers.node.mjs.map']);
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  });
}
