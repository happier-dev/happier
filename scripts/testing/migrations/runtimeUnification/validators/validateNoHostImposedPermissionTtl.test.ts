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

test('validateNoHostImposedPermissionTtl rejects copied plugin lifecycle timers outside permission folders', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);
  writeRepoFile(
    rootDir,
    'packages/plugins/claude/src/backend/utils/permissionRuntime.ts',
    [
      'const pendingRequests = new Map<string, unknown>();',
      'export function expireCopiedLifecycle(id: string) {',
      '  setTimeout(() => pendingRequests.delete(id), 30000);',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('packages/plugins/claude/src/backend/utils/permissionRuntime.ts')));
  assert.ok(result.errors.some((error) => error.includes('pendingRequests')));
});

test('validateNoHostImposedPermissionTtl treats permission-owned timers as suspicious by path', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);
  writeRepoFile(
    rootDir,
    'apps/cli/src/agent/permissions/permissionRequestCoordinator.ts',
    [
      'export function schedule(id: string) {',
      '  setTimeout(() => cancel(id), 30000);',
      '}',
      'function cancel(_id: string) {}',
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

test('validateNoHostImposedPermissionTtl rejects accepted bridge marker without a nearby timer', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'apps/cli/src/backends/claude/runtime/terminal/permissions/localPermissionBridge.ts',
    [
      '// L-25 ALLOWLIST: localPermissionBridge non-interactive opt-in arrival latency',
      'export function createLocalWaiter(requestId: string) {',
      '  return requestId;',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('allowlist marker')));
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

test('validateNoHostImposedPermissionTtl rejects split-clock permission TTL checks', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);
  writeRepoFile(
    rootDir,
    'packages/plugins/claude/src/backend/utils/permissionRuntime.ts',
    [
      'const TTL_MS = 30000;',
      'const pendingRequests = new Map<string, { createdAt: number }>();',
      'export function pruneCopiedLifecycle(id: string, entry: { createdAt: number }) {',
      '  const now = Date.now();',
      '  const requestAgeMs = now - entry.createdAt;',
      '  if (requestAgeMs > TTL_MS) {',
      '    pendingRequests.delete(id);',
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('Date.now')));
  assert.ok(result.errors.some((error) => error.includes('createdAt')));
});

test('validateNoHostImposedPermissionTtl rejects directly assigned split-clock permission TTL checks with separated comparison', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);
  writeRepoFile(
    rootDir,
    'packages/plugins/claude/src/backend/utils/permissionRuntime.ts',
    [
      'const TTL_MS = 30000;',
      'const pendingRequests = new Map<string, { createdAt: number }>();',
      'export function pruneCopiedLifecycle(id: string, entry: { createdAt: number }) {',
      '  const requestAgeMs = Date.now() - entry.createdAt;',
      '  const stillPending = pendingRequests.has(id);',
      '  const shouldCheck = stillPending;',
      '  const shouldDelete = shouldCheck;',
      '  if (shouldDelete && requestAgeMs > TTL_MS) {',
      '    pendingRequests.delete(id);',
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('Date.now')));
  assert.ok(result.errors.some((error) => error.includes('createdAt')));
});

test('validateNoHostImposedPermissionTtl rejects split-clock max-age permission TTL checks', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);
  writeRepoFile(
    rootDir,
    'packages/plugins/claude/src/backend/utils/permissionRuntime.ts',
    [
      'const pendingRequests = new Map<string, { createdAt: number }>();',
      'export function pruneCopiedLifecycle(id: string, entry: { createdAt: number }, maxAgeMs: number) {',
      '  const now = Date.now();',
      '  const requestAgeMs = now - entry.createdAt;',
      '  const stillPending = pendingRequests.has(id);',
      '  const shouldCheck = stillPending && maxAgeMs > 0;',
      '  if (shouldCheck && requestAgeMs > maxAgeMs) {',
      '    pendingRequests.delete(id);',
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('Date.now')));
  assert.ok(result.errors.some((error) => error.includes('createdAt')));
});
