import { describe, expect, it, vi, afterEach } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

const { callMachineRpc } = vi.hoisted(() => ({ callMachineRpc: vi.fn() }));
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc }));

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { requestInactiveSessionResume } from './requestInactiveSessionResume';

const machineKey = new Uint8Array(32).fill(1);
const credentials = {
  token: 'account-token',
  encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
};

const rawSession = {
  id: 'session-1', active: false, machineId: 'machine-1', path: '/repo', seq: 17,
} as unknown as RawSessionRecord;

const metadata = {
  machineId: 'machine-1',
  path: '/repo',
  runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
  claudeSessionId: 'provider-session-1',
};

function resume() {
  return requestInactiveSessionResume({
    credentials: credentials as never,
    sessionId: 'session-1',
    localId: 'local-1',
    rawSession,
    metadata,
  });
}

/**
 * `unsupported` shapes the recovery the caller offers, so it has to keep meaning
 * "this cannot be done", not "this attempt did not work". The observed defect
 * reported a machine-side `ENOTEMPTY` as an incapability.
 */
describe('requestInactiveSessionResume failure classification', () => {
  afterEach(() => {
    callMachineRpc.mockReset();
  });

  it('reports a machine that failed the resume as a failure, not as an unsupported capability', async () => {
    callMachineRpc.mockResolvedValue({
      type: 'error',
      errorMessage: "Connected services resolution failed: ENOTEMPTY: directory not empty, rmdir '/tmp/cs'",
    });

    await expect(resume()).resolves.toMatchObject({ ok: false, code: 'resume_failed' });
  });

  it('reports a machine that threw during the resume as a failure, not as an unsupported capability', async () => {
    callMachineRpc.mockRejectedValue(new Error('socket closed'));

    await expect(resume()).resolves.toMatchObject({ ok: false, code: 'resume_failed' });
  });

  it('keeps a daemon that does not carry the method at all as unsupported', async () => {
    callMachineRpc.mockRejectedValue(new RpcError('method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE));

    await expect(resume()).resolves.toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('keeps a timed-out resume as a timeout', async () => {
    callMachineRpc.mockRejectedValue(Object.assign(new Error('timed out'), { code: 'MACHINE_RPC_TIMEOUT' }));

    await expect(resume()).resolves.toMatchObject({ ok: false, code: 'timeout' });
  });
});
