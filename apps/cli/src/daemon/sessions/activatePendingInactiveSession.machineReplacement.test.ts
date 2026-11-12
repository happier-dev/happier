import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { readPendingQueueV2ActivationEligibilityFromServer } from '@/api/session/pendingQueueV2Transport';
import { reportPendingSessionActivationFailure } from '@/api/session/pendingActivationTransport';
import { activatePendingSessionRuntime } from './activatePendingInactiveSession';

const transport = vi.hoisted(() => ({ get: vi.fn() }));
// Only server reads and writes are replaced; metadata, snapshot and locality owners stay real.
vi.mock('axios', () => ({ default: { get: transport.get } }));
vi.mock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionByIdCompat: vi.fn() }));
vi.mock('@/api/session/pendingQueueV2Transport', () => ({ readPendingQueueV2ActivationEligibilityFromServer: vi.fn() }));
vi.mock('@/api/session/pendingActivationTransport', () => ({ reportPendingSessionActivationFailure: vi.fn() }));


const predecessor = '43d617ed-acf3-45fe-96e5-26fe258d0f51';
const successor = '88c680c2-bfe0-4453-83cc-188493418c79';
const sessionId = 'cmuftr5w53gmytmw7x9m5ritt';
const credentials = { token: 'fixture-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };

function createSession(machineId: string) {
  return {
    id: sessionId, seq: 12, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
    encryptionMode: 'plain' as const,
    metadata: JSON.stringify({ machineId, path: '/repo', flavor: 'claude', claudeSessionId: 'vendor-session',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' } }),
    metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
    machineId, path: '/repo', pendingCount: 1, pendingVersion: 9,
    pendingActivationAuthorization: { requestId: 'pending-request', requestedAt: 10, status: 'waiting' as const },
  };
}

async function activate(machineId: string) {
  const spawn = vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId }));
  const result = await activatePendingSessionRuntime({ credentials, machineId, sessionId,
    requestId: 'pending-request', pendingVersion: 9, spawnSession: spawn });
  return { result, spawn };
}

describe('Pending activation inherited Machine locality', () => {
  beforeEach(() => {
    vi.mocked(fetchSessionByIdCompat).mockReset().mockResolvedValue(createSession(predecessor));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockReset().mockResolvedValue('eligible');
    vi.mocked(reportPendingSessionActivationFailure).mockReset();
    transport.get.mockReset();
  });

  it('resumes the recorded Claude Session on its canonical successor with one Account read and unchanged metadata', async () => {
    const session = createSession(predecessor);
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(session);
    transport.get.mockResolvedValue({ data: [
      { id: predecessor, replacedByMachineId: 'intermediate', revokedAt: 1 },
      { id: 'intermediate', replacedByMachineId: successor }, { id: successor },
    ] });
    const { result, spawn } = await activate(successor);
    expect(result).toMatchObject({ status: 'activated' });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ machineId: successor, existingSessionId: sessionId,
      directory: '/repo', initialTranscriptAfterSeq: 12,
      executionAuthorization: { provenance: 'user_request', requestId: 'pending-request', requestedAt: 10 } }));
    expect(JSON.parse(session.metadata).machineId).toBe(predecessor);
    expect(transport.get).toHaveBeenCalledTimes(1);
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
  });

  it('does not read replacement inventory for the same-Machine fast path', async () => {
    const { result } = await activate(predecessor);
    expect(result).toMatchObject({ status: 'activated' });
    expect(transport.get).not.toHaveBeenCalled();
  });

  it.each([
    ['unrelated', [{ id: predecessor }, { id: successor }]],
    ['missing successor row', [{ id: predecessor, replacedByMachineId: successor }]],
    ['cycle', [{ id: predecessor, replacedByMachineId: successor }, { id: successor, replacedByMachineId: predecessor }]],
  ])('leaves Pending waiting for %s identities without spawning or terminalizing', async (_case, machines) => {
    transport.get.mockResolvedValue({ data: machines });
    const { result, spawn } = await activate(successor);
    expect(result).toEqual({ status: 'not-needed', reason: 'target-mismatch' });
    expect(spawn).not.toHaveBeenCalled();
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
    expect(transport.get).toHaveBeenCalledTimes(1);
  });

  it('leaves Pending waiting when the Account replacement read fails', async () => {
    transport.get.mockRejectedValue(new Error('transport unavailable'));
    const { result, spawn } = await activate(successor);
    expect(result).toEqual({ status: 'not-needed', reason: 'target-mismatch' });
    expect(spawn).not.toHaveBeenCalled();
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
  });
});
