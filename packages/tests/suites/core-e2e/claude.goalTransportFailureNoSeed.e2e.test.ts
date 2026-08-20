import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

/**
 * G2 — goal set during a live-RPC TRANSPORT failure must surface a typed error and seed NO phantom
 * metadata goal (G-4 / plan #3, Lane C1).
 *
 * LEVEL CHOSEN (documented gap): a true full-subprocess transport-kill that yields `session_rpc_failed`
 * is NOT deterministically reproducible in the e2e harness. When an ACTIVE session has no runtime
 * socket, the server RPC handler returns `METHOD_NOT_AVAILABLE`
 * (`apps/server/sources/app/api/socket/rpcHandler.ts`) — a DEFINITIVE capability signal that the goal
 * router CORRECTLY falls back on (and seeds via the inactive adapter); that is not the G-4 bug.
 * `session_rpc_failed` is only produced by `callSessionRpcForTransport` when the socket RPC THROWS
 * unclassified (socket-connect failure or the 20s ack timeout), neither of which the fake Claude CLI can
 * drive deterministically. So this suite exercises the guarantee at the highest genuine integration
 * level: the REAL `routeSessionGoalControl` + the REAL `getSessionGoalControlAdapter` catalog wiring
 * (no stub adapter), faking ONLY the live-RPC transport boundary to the exact `session_rpc_failed` shape
 * `callSessionRpcForTransport` emits. This is strictly stronger than the router unit test
 * (`apps/cli/.../sessionGoalControlRouter.test.ts`, which stubs `resolveAdapter`): it proves the REAL
 * Claude provider adapter is never reached and the real metadata-persist boundary is never invoked, so
 * no phantom goal is seeded through real provider wiring.
 */

const mocks = vi.hoisted(() => ({
  // The metadata WRITE is a system boundary (network). Fake it so a regression that seeds a phantom goal
  // is observable as a call — never as a silent real write.
  updateSessionMetadataWithRetry: vi.fn(async (params: {
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
  }) => ({ version: 2, metadata: params.updater({}) })),
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: mocks.updateSessionMetadataWithRetry,
}));

// Imported AFTER the mock registration so the router binds the faked persist boundary. The catalog is
// the REAL one (no mock) — the router resolves the genuine Claude inactive adapter if it falls back.
import { routeSessionGoalControl } from '@/session/goalControls/sessionGoalControlRouter';

function createCredentials(): Credentials {
  return {
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
}

// `flavor: 'claude'` makes `inferAgentIdFromSessionMetadata` resolve `claude`, so the REAL catalog would
// resolve the REAL Claude inactive goal adapter (which CAN seed) if the router incorrectly fell back.
function createClaudeMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { machineId: 'machine-local', flavor: 'claude', ...overrides };
}

function createActiveClaudeRawSession(): RawSessionRecord {
  // Test fixture: only the fields the router reads (active/machineId/path/metadata) matter; bridge
  // through `unknown` because `RawSessionRecord` is the full V2 session response shape (30+ fields).
  return {
    id: 'sess_transport_fail',
    active: true,
    path: '/repo',
    machineId: 'machine-local',
    metadata: '{}',
    metadataVersion: 1,
    encryptionMode: 'plain',
  } as unknown as RawSessionRecord;
}

const ctx = {
  encryptionKey: new Uint8Array(32).fill(1),
  encryptionVariant: 'legacy' as const,
};

// The EXACT shape `callSessionRpcForTransport` returns when the live session RPC throws unclassified
// (`readRpcErrorCode(error) ?? 'session_rpc_failed'`) — the transport-failure boundary, faked.
function transportFailureLiveRpcResult(): Record<string, unknown> {
  return {
    ok: false,
    errorCode: 'session_rpc_failed',
    error: 'session_rpc_failed',
    errorMessage: 'RPC call timeout',
    sessionId: 'sess_transport_fail',
  };
}

describe('core e2e (router+catalog integration): goal set during a live-RPC transport failure seeds no phantom goal', () => {
  beforeEach(() => {
    mocks.updateSessionMetadataWithRetry.mockClear();
  });

  it('surfaces the typed session_rpc_failed error and never reaches the real Claude adapter or persists metadata', async () => {
    const callLiveSessionRpc = vi.fn(async () => transportFailureLiveRpcResult());

    const result = await routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_transport_fail',
      rawSession: createActiveClaudeRawSession(),
      metadata: createClaudeMetadata(),
      currentMachineId: 'machine-local',
      currentMachineHost: 'e2e-host',
      currentMachineHomeDir: '/home/e2e',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { objective: 'pursue the claude goal' },
      // NO resolveAdapter override → the REAL `getSessionGoalControlAdapter` catalog is used.
      callLiveSessionRpc,
    });

    // The typed transport error surfaces verbatim to the caller/UI.
    expect(result).toMatchObject({ ok: false, errorCode: 'session_rpc_failed', error: 'session_rpc_failed' });

    // The live RPC was attempted exactly once (active session prefers the live path)...
    expect(callLiveSessionRpc).toHaveBeenCalledTimes(1);
    // ...and because a transport failure is NON-fallback, the router never seeds metadata: the real
    // Claude adapter's seed would have gone through this persist boundary. It must be untouched.
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  // Control: a DEFINITIVE capability signal on the SAME active Claude session DOES fall back to the real
  // catalog adapter and seeds via the persist boundary. This pins the discriminator — the no-seed above
  // is specific to transport failures, not a blanket "active sessions never seed".
  it('DOES fall back through the real catalog + persists on the unsupported_session_runtime_method capability signal', async () => {
    const callLiveSessionRpc = vi.fn(async () => ({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method',
    }));

    const result = await routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_transport_fail',
      rawSession: createActiveClaudeRawSession(),
      metadata: createClaudeMetadata(),
      currentMachineId: 'machine-local',
      currentMachineHost: 'e2e-host',
      currentMachineHomeDir: '/home/e2e',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { objective: 'pursue the claude goal' },
      callLiveSessionRpc,
    });

    expect(callLiveSessionRpc).toHaveBeenCalledTimes(1);
    // The real Claude inactive adapter seeded a goal work-state item and persisted it (fallback path).
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ metadata: expect.any(Object) });
    const seeded = (result as { metadata?: { sessionWorkStateV1?: unknown } }).metadata?.sessionWorkStateV1;
    expect(seeded).toBeTruthy();
  });
});
