import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sanitizePackagedNodeModulesTree } from './binary-release.mjs';

// Second-round duplicate-directory dedup findings ("exhaustive-duplicate-resweep"): the
// independent per-package vendoring entry points in workspaces/index.ts don't share a
// "visited"/"dedupeByNameVersion" map with each other, so the same transitive dependency can
// get vendored multiple times at different nesting depths. Each of these is confirmed
// byte-identical to a surviving copy reachable via ordinary upward Node/Bun module resolution
// once the nested duplicate is removed.
//
// NOTE: an "ajv duplicated across fastify/@modelcontextprotocol-sdk" case was in the original
// candidate list but is deliberately NOT covered here -- re-verification against the real tree
// showed none of those ajv copies has a surviving ancestor (there is no top-level ajv in the
// payload), so each is the sole reachable copy for its dependent and must not be pruned.

const CLI_TARGETS = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'linux', arch: 'x64' },
  { os: 'windows', arch: 'x64' },
];

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

const CASES = [
  {
    name: 'zod nested inside @modelcontextprotocol/sdk',
    topLevelPackagePath: 'zod',
    nestedDuplicatePath: '@modelcontextprotocol/sdk/node_modules/zod',
  },
  {
    name: 'zod nested inside @happier-dev/agents',
    topLevelPackagePath: 'zod',
    nestedDuplicatePath: '@happier-dev/agents/node_modules/zod',
  },
  {
    name: 'zod nested inside @happier-dev/protocol',
    topLevelPackagePath: 'zod',
    nestedDuplicatePath: '@happier-dev/protocol/node_modules/zod',
  },
  {
    name: 'zod nested inside @happier-dev/protocol/zod-to-json-schema',
    topLevelPackagePath: 'zod',
    nestedDuplicatePath: '@happier-dev/protocol/node_modules/zod-to-json-schema/node_modules/zod',
  },
  {
    name: 'archiver-utils nested inside archiver/zip-stream',
    topLevelPackagePath: 'archiver/node_modules/archiver-utils',
    nestedDuplicatePath: 'archiver/node_modules/zip-stream/node_modules/archiver-utils',
  },
  {
    name: 'get-intrinsic nested inside a sibling call-bound package',
    topLevelPackagePath: 'side-channel-weakmap/node_modules/get-intrinsic',
    nestedDuplicatePath: 'side-channel-weakmap/node_modules/call-bound/node_modules/get-intrinsic',
  },
  {
    name: 'readable-stream nested inside archiver/zip-stream',
    topLevelPackagePath: 'archiver/node_modules/readable-stream',
    nestedDuplicatePath: 'archiver/node_modules/zip-stream/node_modules/readable-stream',
  },
  {
    name: 'readable-stream nested inside archiver/archiver-utils',
    topLevelPackagePath: 'archiver/node_modules/readable-stream',
    nestedDuplicatePath: 'archiver/node_modules/archiver-utils/node_modules/readable-stream',
  },
  {
    name: 'readable-stream nested inside archiver/zip-stream/compress-commons',
    topLevelPackagePath: 'archiver/node_modules/readable-stream',
    nestedDuplicatePath:
      'archiver/node_modules/zip-stream/node_modules/compress-commons/node_modules/readable-stream',
  },
  {
    name: 'readable-stream nested inside archiver/zip-stream/compress-commons/crc32-stream',
    topLevelPackagePath: 'archiver/node_modules/readable-stream',
    nestedDuplicatePath:
      'archiver/node_modules/zip-stream/node_modules/compress-commons/node_modules/crc32-stream/node_modules/readable-stream',
  },
];

for (const target of CLI_TARGETS) {
  for (const testCase of CASES) {
    test(`sanitizePackagedNodeModulesTree removes duplicate ${testCase.name} (${target.os}-${target.arch})`, async () => {
      const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-resweep-dup-prune-'));
      try {
        const { topLevelDir, nestedDir } = await buildFakeDuplicateTree(stageDir, {
          topLevelPackagePath: testCase.topLevelPackagePath,
          nestedDuplicatePath: testCase.nestedDuplicatePath,
        });

        await sanitizePackagedNodeModulesTree({ stageDir, target });

        assert.equal(await pathExists(nestedDir), false, `nested duplicate ${testCase.name} dir should be removed`);
        assert.equal(await pathExists(topLevelDir), true, `top-level ${testCase.name} dir should be preserved`);
      } finally {
        await rm(stageDir, { recursive: true, force: true });
      }
    });
  }
}

// qs nested inside @modelcontextprotocol/sdk's express's own body-parser dependency is covered
// by its own dedicated pattern (see DUPLICATE_VENDORED_PACKAGE_DIR_PATTERNS in binary-release.mjs)
// rather than the shared parameterized loop above: the real-tree ancestor for this duplicate is
// `.../@modelcontextprotocol/sdk/node_modules/express`, a path prefix that another, independently
// landing pruning rule in this same file (unused-vendored-SDK-dependency pruning) may also
// legitimately delete wholesale as an unrelated finding. When both rules are present, the whole
// `express` subtree -- including both the "top-level" and "nested duplicate" qs copies used in a
// plain before/after existence check -- can be removed together, which is correct behavior, not a
// test bug. Assert the invariant that actually matters instead of an exact survivor: the nested
// duplicate must never survive.
for (const target of CLI_TARGETS) {
  test(`sanitizePackagedNodeModulesTree removes duplicate qs nested inside @modelcontextprotocol/sdk/express/body-parser (${target.os}-${target.arch})`, async () => {
    const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-resweep-dup-prune-qs-'));
    try {
      const { nestedDir } = await buildFakeDuplicateTree(stageDir, {
        topLevelPackagePath: '@modelcontextprotocol/sdk/node_modules/express/node_modules/qs',
        nestedDuplicatePath:
          '@modelcontextprotocol/sdk/node_modules/express/node_modules/body-parser/node_modules/qs',
      });

      await sanitizePackagedNodeModulesTree({ stageDir, target });

      assert.equal(await pathExists(nestedDir), false, 'nested duplicate qs dir should never survive');
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  });
}
