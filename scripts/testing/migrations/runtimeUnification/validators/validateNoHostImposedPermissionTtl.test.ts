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

test('validateNoHostImposedPermissionTtl ignores dependency, generated, temporary, and restore artifacts without ignoring other dot-directories', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);
  const artifactFiles = [
    'packages/plugins/cliproxyapi/node_modules/vendor/permissionRuntime.ts',
    'packages/plugins/google/generated/permissionRuntime.ts',
    'packages/plugins/inspector/.tmp-build/permissionRuntime.ts',
    'packages/plugins/claude/.restore.1234/agent/permissions/runtime.ts',
  ];
  for (const filePath of artifactFiles) {
    writeRepoFile(
      rootDir,
      filePath,
      'const pendingRequests = new Map();\nsetTimeout(() => pendingRequests.clear(), 1000);\n',
    );
  }

  const artifactOnlyResult = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(artifactOnlyResult.ok, true);
  assert.deepEqual(artifactOnlyResult.errors, []);
  assert.ok(artifactFiles.every((filePath) => !artifactOnlyResult.scannedFiles.includes(filePath)));

  const dotProductionPath = 'packages/plugins/claude/.owned-source/permissionRuntime.ts';
  writeRepoFile(
    rootDir,
    dotProductionPath,
    'const pendingRequests = new Map();\nsetTimeout(() => pendingRequests.clear(), 1000);\n',
  );

  const dotProductionResult = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(dotProductionResult.ok, false);
  assert.ok(dotProductionResult.scannedFiles.includes(dotProductionPath));
  assert.ok(dotProductionResult.errors.some((error) => error.includes(dotProductionPath)));
});

test('validateNoHostImposedPermissionTtl accepts external-session invocation readiness deadlines', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);
  const externalSessionFiles = [
    'packages/plugins/claude/src/agent/surfaces/sessions/external/hooks.ts',
    'packages/plugins/codex/src/agent/surfaces/sessions/external/externalSessionHooks.ts',
  ];
  for (const filePath of externalSessionFiles) {
    writeRepoFile(
      rootDir,
      filePath,
      [
        'function invocationFailure(request: { deadlineAtMs: number }) {',
        '  if (Date.now() >= request.deadlineAtMs) {',
        "    return { ok: false, code: 'timeout', message: 'Callback exceeded its deadline.' };",
        '  }',
        '  return null;',
        '}',
        '',
      ].join('\n'),
    );
  }

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(externalSessionFiles.every((filePath) => result.scannedFiles.includes(filePath)));
});

test('validateNoHostImposedPermissionTtl accepts assistant terminalization grace beside an independent permission-denied outcome', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);
  const filePath = 'packages/plugins/opencode/src/agent/runtime/server/runtimeController.ts';
  writeRepoFile(
    rootDir,
    filePath,
    [
      'const acceptedAtMs = state.currentTurnPromptAcceptedAtMs;',
      'const assistantGraceExpired = acceptedAtMs !== null',
      '  && Date.now() - acceptedAtMs >= 60_000;',
      'const permissionDenied = currentTurnPermissionRejectionMessage !== null;',
      'if (terminalWithoutText || permissionDenied || assistantGraceExpired) {',
      '  completeTurn();',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.scannedFiles.includes(filePath));
});

test('validateNoHostImposedPermissionTtl rejects a permission-denied deadline in the same branch condition', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);
  const filePath = 'packages/plugins/sample/src/agent/runtime/requestDeadline.ts';
  writeRepoFile(
    rootDir,
    filePath,
    [
      'const permissionDenied = currentPermissionDecision === "denied";',
      'const deadline = request.deadlineAtMs;',
      'if (',
      '  permissionDenied',
      '  && Date.now() >= deadline',
      ') {',
      '  cancelPermissionRequest(request.id);',
      '}',
      '',
    ].join('\n'),
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes(filePath)));
  assert.ok(result.errors.some((error) => error.includes('Date.now')));
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

test('validateNoHostImposedPermissionTtl accepts a wire-protocol keepalive timer whose neighbourhood merely mentions reconnect requests', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);
  const filePath = 'packages/plugins/channel-discord/src/discordGatewayWorker.ts';
  writeRepoFile(
    rootDir,
    filePath,
    [
      "case 'scheduleHeartbeat':",
      '  clearHeartbeat();',
      '  heartbeatHandle = clock.setTimeout(() => {',
      '    if (signal.aborted || controlResult || reconnectRequested) return;',
      '    void processEffects(session.onHeartbeatTimer()).catch(() => requestReconnect());',
      '  }, effect.afterMs);',
      '  break;',
      '',
    ].join('\n'),
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.scannedFiles.includes(filePath));
});

test('validateNoHostImposedPermissionTtl still rejects a request-store expiry timer that never says permission', async () => {
  const { validateNoHostImposedPermissionTtl } = await loadValidator();
  const rootDir = createRepo();
  writeCurrentAllowlistedBridge(rootDir);
  const filePath = 'packages/plugins/sample/src/agent/state/agentStateRequestStore.ts';
  writeRepoFile(
    rootDir,
    filePath,
    [
      'const requests = new Map<string, { createdAt: number }>();',
      'setInterval(() => {',
      '  for (const [id, entry] of requests) {',
      '    if (isStale(entry)) requests.delete(id);',
      '  }',
      '}, 1_000);',
      'function isStale(_entry: { createdAt: number }) { return false; }',
      '',
    ].join('\n'),
  );

  const result = validateNoHostImposedPermissionTtl({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes(filePath)));
  assert.ok(result.errors.some((error) => error.includes('setInterval')));
});
