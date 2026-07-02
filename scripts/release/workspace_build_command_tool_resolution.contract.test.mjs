import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function readJson(relativePath) {
  const raw = await readFile(resolve(repoRoot, relativePath), 'utf8');
  return JSON.parse(raw);
}

test('cli-common keeps the atomic build entrypoint and resolves typecheck through a shared TypeScript wrapper', async () => {
  const pkg = await readJson('packages/cli-common/package.json');

  assert.equal(String(pkg?.scripts?.build ?? ''), 'node scripts/build.mjs');
  assert.match(
    String(pkg?.scripts?.typecheck ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs --noEmit -p tsconfig\.json\b/,
    'cli-common typecheck should use the shared TypeScript wrapper'
  );
  assert.doesNotMatch(
    String(pkg?.scripts?.build ?? ''),
    /node_modules\/typescript\/bin\/tsc/,
    'cli-common build should not hardcode a repo-root TypeScript binary path'
  );
  assert.doesNotMatch(
    String(pkg?.scripts?.typecheck ?? ''),
    /\btsc\b|node_modules\/typescript\/bin\/tsc/,
    'cli-common typecheck should not invoke a shell-wrapper TypeScript binary path'
  );
});

test('workspace build and typecheck scripts use the shared Node-safe TypeScript wrapper instead of bare tsc shell shims', async () => {
  const agentsPkg = await readJson('packages/agents/package.json');
  const protocolPkg = await readJson('packages/protocol/package.json');
  const cliCommonPkg = await readJson('packages/cli-common/package.json');
  const connectionSupervisorPkg = await readJson('packages/connection-supervisor/package.json');
  const releaseRuntimePkg = await readJson('packages/release-runtime/package.json');

  assert.match(
    String(agentsPkg?.scripts?.build ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs -p tsconfig\.json\b/,
    'agents build should use the shared TypeScript wrapper'
  );
  assert.match(
    String(agentsPkg?.scripts?.build ?? ''),
    /fs\.rmSync\('dist', \{ recursive: true, force: true \}\)/,
    'agents build should clean stale dist output before compiling'
  );
  assert.match(
    String(agentsPkg?.scripts?.typecheck ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs --noEmit -p tsconfig\.json\b/,
    'agents typecheck should use the shared TypeScript wrapper'
  );
  assert.match(
    String(protocolPkg?.scripts?.build ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs -p tsconfig\.json\b/,
    'protocol build should use the shared TypeScript wrapper'
  );
  assert.match(
    String(protocolPkg?.scripts?.build ?? ''),
    /fs\.rmSync\('dist', \{ recursive: true, force: true \}\)/,
    'protocol build should clean stale dist output before compiling'
  );
  assert.match(
    String(protocolPkg?.scripts?.typecheck ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs --noEmit -p tsconfig\.json\b/,
    'protocol typecheck should use the shared TypeScript wrapper'
  );
  assert.match(
    String(cliCommonPkg?.scripts?.typecheck ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs --noEmit -p tsconfig\.json\b/,
    'cli-common typecheck should use the shared TypeScript wrapper'
  );
  assert.match(
    String(connectionSupervisorPkg?.scripts?.build ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs -p tsconfig\.json\b/,
    'connection-supervisor build should use the shared TypeScript wrapper'
  );
  assert.match(
    String(connectionSupervisorPkg?.scripts?.typecheck ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs --noEmit -p tsconfig\.json\b/,
    'connection-supervisor typecheck should use the shared TypeScript wrapper'
  );
  assert.match(
    String(releaseRuntimePkg?.scripts?.['build:esm'] ?? ''),
    /scripts\/workspaces\/runTypeScriptCli\.mjs -p tsconfig\.json\b/,
    'release-runtime build:esm should use the shared TypeScript wrapper'
  );

  for (const [label, script] of [
    ['agents build', agentsPkg?.scripts?.build],
    ['agents typecheck', agentsPkg?.scripts?.typecheck],
    ['protocol build', protocolPkg?.scripts?.build],
    ['protocol typecheck', protocolPkg?.scripts?.typecheck],
    ['cli-common typecheck', cliCommonPkg?.scripts?.typecheck],
    ['connection-supervisor build', connectionSupervisorPkg?.scripts?.build],
    ['connection-supervisor typecheck', connectionSupervisorPkg?.scripts?.typecheck],
    ['release-runtime build:esm', releaseRuntimePkg?.scripts?.['build:esm']],
  ]) {
    assert.doesNotMatch(
      String(script ?? ''),
      /\btsc\b/,
      `${label} should not invoke the bare tsc shell shim`
    );
  }
});
