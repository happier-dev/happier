import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

type PermissionTtlValidatorModule = typeof import('./validateNoHostImposedPermissionTtl.ts');

async function loadValidator(): Promise<PermissionTtlValidatorModule> {
  try {
    return await import('./validateNoHostImposedPermissionTtl.ts');
  } catch (error) {
    assert.fail(`validator module should load: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createRepo(): string {
  return mkdtempSync(join(tmpdir(), 'happier-permission-ttl-validator-'));
}

function writeRepoFile(rootDir: string, filePath: string, content: string): void {
  const absolutePath = join(rootDir, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

function writeCurrentAllowlistedBridge(rootDir: string): void {
  writeRepoFile(
    rootDir,
    'apps/cli/src/backends/claude/runtime/terminal/permissions/localPermissionBridge.ts',
    [
      'function createLocalWaiter(requestId: string) {',
      '  const timeoutMs = 1000;',
      '  // L-25 ALLOWLIST: localPermissionBridge non-interactive opt-in arrival latency',
      '  const timeout = setTimeout(() => {',
      '    void requestId;',
      '  }, timeoutMs);',
      '  return timeout;',
      '}',
      '',
    ].join('\n'),
  );
}

test('validateNoHostImposedPermissionTtl accepts the current Claude local bridge marker', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateNoHostImposedPermissionTtl accepts the future Claude plugin bridge marker', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/plugins/claude/src/agent/permissions/bridge/localPermissionBridge.ts',
    [
      'function createLocalWaiter(requestId: string) {',
      '  const timeoutMs = 1000;',
      '  // L-25 ALLOWLIST: localPermissionBridge non-interactive opt-in arrival latency',
      '  const timeout = setTimeout(() => {',
      '    void requestId;',
      '  }, timeoutMs);',
      '  return timeout;',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateNoHostImposedPermissionTtl rejects host permission timers outside the allowlist', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);
  writeRepoFile(
    rootDir,
    'apps/cli/src/agent/permissions/permissionRequestCoordinator.ts',
    [
      'export function expirePermissionRequest(requestId: string) {',
      '  setTimeout(() => {',
      '    cancelPermissionRequest(requestId);',
      '  }, 30000);',
      '}',
      'function cancelPermissionRequest(_requestId: string) {}',
      '',
    ].join('\n'),
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('permissionRequestCoordinator.ts')));
  assert.ok(result.errors.some((error) => error.includes('setTimeout')));
});

test('validateNoHostImposedPermissionTtl rejects missing allowlist marker proof', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'apps/cli/src/agent/permissions/permissionRequestCoordinator.ts',
    'export const coordinatorHasNoTimers = true;\n',
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('allowlist marker')));
});

test('validateNoHostImposedPermissionTtl rejects marker copies outside accepted bridge paths', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'packages/plugins/other/src/agent/permissions/bridge/localPermissionBridge.ts',
    [
      'function createLocalWaiter(requestId: string) {',
      '  // L-25 ALLOWLIST: localPermissionBridge non-interactive opt-in arrival latency',
      '  return setTimeout(() => {',
      '    void requestId;',
      '  }, 1000);',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('allowlist marker')));
  assert.ok(result.errors.some((error) => error.includes('packages/plugins/other')));
});

test('validateNoHostImposedPermissionTtl rejects wall-clock late-decision cleanup', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);
  writeRepoFile(
    rootDir,
    'packages/plugins/claude/src/agent/permissions/runtime.ts',
    [
      'const lateDecisions = new Map<string, { timestamp: number }>();',
      'setInterval(() => {',
      '  for (const [requestId, decision] of lateDecisions) {',
      '    if (Date.now() - decision.timestamp > 30000) lateDecisions.delete(requestId);',
      '  }',
      '}, 1000);',
      '',
    ].join('\n'),
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('lateDecisions')));
  assert.ok(result.errors.some((error) => error.includes('Date.now')));
});
