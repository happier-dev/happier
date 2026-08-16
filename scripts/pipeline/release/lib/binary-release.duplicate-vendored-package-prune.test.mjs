import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sanitizePackagedNodeModulesTree } from './binary-release.mjs';

// Independent per-package vendoring entry points don't share a "visited" set with each other,
// so a transitive dependency already present at the payload's top-level node_modules can also
// get copied again into a nested package's own node_modules. These are confirmed exact
// duplicates that should be pruned outright, relying on ordinary upward-walking Node/Bun module
// resolution to find the top-level copy once the nested duplicate is removed.
const TARGET = { os: 'darwin', arch: 'arm64' };

async function pathExists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function buildFakeDuplicateTree(stageDir, { topLevelPackagePath, nestedDuplicatePath }) {
  const topLevelDir = join(stageDir, 'node_modules', ...topLevelPackagePath.split('/'));
  await mkdir(topLevelDir, { recursive: true });
  await writeFile(join(topLevelDir, 'package.json'), JSON.stringify({ name: 'top-level-copy' }), 'utf-8');
  await writeFile(join(topLevelDir, 'index.js'), 'module.exports = {};', 'utf-8');

  const nestedDir = join(stageDir, 'node_modules', ...nestedDuplicatePath.split('/'));
  await mkdir(nestedDir, { recursive: true });
  await writeFile(join(nestedDir, 'package.json'), JSON.stringify({ name: 'nested-duplicate-copy' }), 'utf-8');
  await writeFile(join(nestedDir, 'index.js'), 'module.exports = {};', 'utf-8');

  return { topLevelDir, nestedDir };
}

test('sanitizePackagedNodeModulesTree removes duplicated tar nested inside onnxruntime-node', async () => {
  const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-dup-tar-prune-'));
  try {
    const { topLevelDir, nestedDir } = await buildFakeDuplicateTree(stageDir, {
      topLevelPackagePath: 'tar',
      nestedDuplicatePath: '@huggingface/transformers/node_modules/onnxruntime-node/node_modules/tar',
    });

    await sanitizePackagedNodeModulesTree({ stageDir, target: TARGET });

    assert.equal(await pathExists(nestedDir), false, 'nested duplicate tar dir should be removed');
    assert.equal(await pathExists(topLevelDir), true, 'top-level tar dir should be preserved');
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
});

test('sanitizePackagedNodeModulesTree removes duplicated @modelcontextprotocol/sdk nested inside claude-agent-sdk', async () => {
  const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-dup-mcp-sdk-prune-'));
  try {
    const { topLevelDir, nestedDir } = await buildFakeDuplicateTree(stageDir, {
      topLevelPackagePath: '@modelcontextprotocol/sdk',
      nestedDuplicatePath: '@anthropic-ai/claude-agent-sdk/node_modules/@modelcontextprotocol/sdk',
    });

    await sanitizePackagedNodeModulesTree({ stageDir, target: TARGET });

    assert.equal(await pathExists(nestedDir), false, 'nested duplicate @modelcontextprotocol/sdk dir should be removed');
    assert.equal(await pathExists(topLevelDir), true, 'top-level @modelcontextprotocol/sdk dir should be preserved');
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
});
