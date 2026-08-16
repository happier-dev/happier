import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sanitizePackagedNodeModulesTree } from './binary-release.mjs';

// @modelcontextprotocol/sdk vendors express, express-rate-limit, cors, jose, and hono inside
// its own node_modules, but happier never reaches the SDK source files that require them
// (server/express.js, server/auth/router.js, server/auth/handlers/*.js,
// client/auth-extensions.js), and `hono` is only referenced from type-only .d.ts files never
// executed by the sibling @hono/node-server package (which IS used and must be preserved).
// This pruning is unconditional -- it does not depend on packaging target os/arch -- so verify
// removal across all five CLI binary targets.
const CLI_TARGETS = [
  { os: 'linux', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'darwin', arch: 'arm64' },
  { os: 'windows', arch: 'x64' },
];

const UNUSED_MCP_SDK_DEPENDENCY_NAMES = ['express', 'express-rate-limit', 'cors', 'jose', 'hono'];

async function pathExists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function writeFakePackageDir(dirPath, name) {
  await mkdir(dirPath, { recursive: true });
  await writeFile(join(dirPath, 'package.json'), JSON.stringify({ name }), 'utf-8');
  await writeFile(join(dirPath, 'index.js'), 'module.exports = {};', 'utf-8');
}

async function buildFakeMcpSdkTree(stageDir) {
  const sdkDir = join(stageDir, 'node_modules', '@modelcontextprotocol', 'sdk');
  await writeFakePackageDir(sdkDir, '@modelcontextprotocol/sdk');

  const unusedDepDirs = {};
  for (const depName of UNUSED_MCP_SDK_DEPENDENCY_NAMES) {
    const depDir = join(sdkDir, 'node_modules', depName);
    await writeFakePackageDir(depDir, depName);
    unusedDepDirs[depName] = depDir;
  }

  // Retained sibling that must NOT be pruned: @hono/node-server (used) and other genuinely
  // required SDK dependencies.
  const honoNodeServerDir = join(sdkDir, 'node_modules', '@hono', 'node-server');
  await writeFakePackageDir(honoNodeServerDir, '@hono/node-server');

  const ajvDir = join(sdkDir, 'node_modules', 'ajv');
  await writeFakePackageDir(ajvDir, 'ajv');

  return { sdkDir, unusedDepDirs, honoNodeServerDir, ajvDir };
}

for (const target of CLI_TARGETS) {
  test(`sanitizePackagedNodeModulesTree removes unused @modelcontextprotocol/sdk vendored deps for ${target.os}-${target.arch}`, async () => {
    const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-mcp-sdk-unused-deps-prune-'));
    try {
      const { unusedDepDirs, honoNodeServerDir, ajvDir } = await buildFakeMcpSdkTree(stageDir);

      await sanitizePackagedNodeModulesTree({ stageDir, target });

      for (const [depName, depDir] of Object.entries(unusedDepDirs)) {
        assert.equal(await pathExists(depDir), false, `${depName} should be removed`);
      }
      assert.equal(await pathExists(honoNodeServerDir), true, '@hono/node-server should be preserved');
      assert.equal(await pathExists(ajvDir), true, 'ajv should be preserved');
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  });
}

test('sanitizePackagedNodeModulesTree does not prune first-party @modelcontextprotocol/sdk server/auth source', async () => {
  const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-mcp-sdk-auth-source-preserved-'));
  try {
    const sdkDir = join(stageDir, 'node_modules', '@modelcontextprotocol', 'sdk');
    await writeFakePackageDir(sdkDir, '@modelcontextprotocol/sdk');
    const authErrorsPath = join(sdkDir, 'dist', 'cjs', 'server', 'auth', 'errors.js');
    await mkdir(join(sdkDir, 'dist', 'cjs', 'server', 'auth'), { recursive: true });
    await writeFile(authErrorsPath, 'module.exports = {};', 'utf-8');

    await sanitizePackagedNodeModulesTree({ stageDir, target: { os: 'darwin', arch: 'arm64' } });

    assert.equal(await pathExists(authErrorsPath), true, 'server/auth/errors.js must not be pruned');
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
});
