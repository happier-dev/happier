import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const { callMachineRpc } = vi.hoisted(() => ({ callMachineRpc: vi.fn() }));
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc }));

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { requestInactiveSessionResume } from './requestInactiveSessionResume';

const machineKey = new Uint8Array(32).fill(1);
const credentials = {
  token: 'account-token',
  encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
};

function rawSession(overrides: Record<string, unknown> = {}): RawSessionRecord {
  return {
    id: 'session-1', active: false, machineId: 'machine-1', path: '/repo', seq: 17, ...overrides,
  } as unknown as RawSessionRecord;
}

const metadata = {
  machineId: 'machine-1',
  path: '/repo',
  runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
  claudeSessionId: 'provider-session-1',
};

const providerMetadata = {
  ...metadata,
  providerBindingV1: {
    v: 1,
    connectionId: 'pc_work',
    contributionKey: 'plugin.gateway/gateway',
    connectionRevision: 2,
    protocol: 'openai-responses',
    materialization: 'engineConfig',
    adapterBindingKey: 'gateway',
    compatibilityFingerprint: 'compatibility-v1',
    bindingSecurityFingerprint: 'security-v1',
    displaySnapshot: {
      providerName: 'Gateway',
      connectionName: 'Work',
      connectionRole: 'named',
      connectionDisplayNameMode: 'custom',
    },
  },
  modelSelectionIntentV1: {
    v: 1,
    updatedAt: 100,
    selection: {
      agentTargetKey: 'backend:claude',
      providerConnectionId: 'pc_work',
      modelId: 'provider-model',
    },
  },
} as const;

describe('requestInactiveSessionResume', () => {
  afterEach(() => callMachineRpc.mockReset());

  it('accepts the canonical resume success response while sending identity-only execution authorization', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success' });

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      request: expect.objectContaining({
        type: 'resume-session',
        sessionId: 'session-1',
        executionAuthorization: { provenance: 'user_request', requestId: 'local-1' },
      }),
    }));
  });

  it('fails closed on conflicting machine identity without issuing a resume', async () => {
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession({ machineId: 'machine-other' }),
      metadata,
    })).resolves.toMatchObject({ ok: false, code: 'unsupported' });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('rejects a success response that explicitly names a different session', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-other' });

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
    })).resolves.toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('uses one current-only Provider-safe RPC so an older daemon refuses inactive wake before side effects', async () => {
    callMachineRpc.mockRejectedValueOnce(Object.assign(new Error('method not available'), {
      code: 'MACHINE_RPC_METHOD_NOT_FOUND',
    }));

    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: providerMetadata,
    })).resolves.toMatchObject({ ok: false, code: 'unsupported' });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    }));
    expect(callMachineRpc).not.toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
    }));
  });

  it('wakes a Provider-bound inactive session through the atomic Provider-safe RPC', async () => {
    callMachineRpc.mockResolvedValueOnce({ type: 'success' });

    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: providerMetadata,
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    }));
  });

  it('retains custody when resume times out', async () => {
    callMachineRpc.mockRejectedValue(Object.assign(new Error('timed out'), { code: 'MACHINE_RPC_TIMEOUT' }));

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
    })).resolves.toMatchObject({ ok: false, code: 'timeout' });
  });
});
