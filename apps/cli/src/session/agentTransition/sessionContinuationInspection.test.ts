import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchSessionByIdCompat: vi.fn(),
  fetchAccountMachineReplacements: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: mocks.fetchSessionByIdCompat,
}));
vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: mocks.fetchAccountMachineReplacements,
}));
vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  tryDecryptSessionMetadata: (params: { rawSession: { metadata: string } }) =>
    JSON.parse(params.rawSession.metadata) as Record<string, unknown>,
}));

const {
  evaluateSessionContinuationTargetSupport,
  inspectSessionContinuation,
} = await import('./sessionContinuationInspection');

const credentials = { token: 'token-1' } as never;

function rawSession(metadata: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    metadata: JSON.stringify(metadata),
    metadataVersion: 1,
    machineId: 'machine-1',
    ...overrides,
  };
}

describe('evaluateSessionContinuationTargetSupport', () => {
  it('accepts another catalog Agent', () => {
    expect(evaluateSessionContinuationTargetSupport({
      selection: { v: 1, agentId: 'codex' },
      sourceAgentId: 'claude',
    })).toEqual({ type: 'supported', targetAgentId: 'codex' });
  });

  it('rejects a provider-connection binding rather than silently dropping it', () => {
    expect(evaluateSessionContinuationTargetSupport({
      selection: { v: 1, agentId: 'codex', modelId: 'gpt-5.6', providerConnectionId: 'conn-1' },
      sourceAgentId: 'claude',
    })).toEqual({ type: 'unsupported', code: 'target_unavailable' });
  });

  it('rejects an unknown Agent id', () => {
    expect(evaluateSessionContinuationTargetSupport({
      selection: { v: 1, agentId: 'not-an-agent' },
      sourceAgentId: 'claude',
    })).toEqual({ type: 'unsupported', code: 'target_unavailable' });
  });

  it('rejects a configured ACP target as unproven in V1', () => {
    expect(evaluateSessionContinuationTargetSupport({
      selection: { v: 1, agentId: 'customAcp' },
      sourceAgentId: 'claude',
    })).toEqual({ type: 'unsupported', code: 'target_unavailable' });
  });

  it('reports the current Agent as same_target', () => {
    expect(evaluateSessionContinuationTargetSupport({
      selection: { v: 1, agentId: 'claude' },
      sourceAgentId: 'claude',
    })).toEqual({ type: 'unsupported', code: 'same_target' });
  });
});

describe('inspectSessionContinuation', () => {
  beforeEach(() => {
    mocks.fetchSessionByIdCompat.mockReset();
    mocks.fetchAccountMachineReplacements.mockReset();
    mocks.fetchAccountMachineReplacements.mockResolvedValue([{ id: 'machine-1' }, { id: 'machine-2' }]);
  });

  it('reports same-Session transition available and native return false', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValue(rawSession({ path: '/work/repo', flavor: 'claude' }));

    const result = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'codex' } },
    });

    expect(result).toEqual({
      type: 'available',
      protocolVersion: 1,
      sameSessionTransition: true,
    });
  });

  it('reports a direct-transcript Session as an unsupported session', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValue(
      rawSession({ path: '/work/repo', flavor: 'claude', directSessionV1: { v: 1 } }),
    );

    const result = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'codex' } },
    });

    expect(result).toEqual({ type: 'unavailable', reason: 'unsupported_session' });
  });

  it('reports an unrepresentable selection as target_unavailable', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValue(rawSession({ path: '/work/repo', flavor: 'claude' }));

    const result = await inspectSessionContinuation({
      credentials,
      request: {
        v: 1,
        sourceSessionId: 'session-1',
        selection: { v: 1, agentId: 'codex', modelId: 'gpt-5.6', providerConnectionId: 'conn-1' },
      },
    });

    expect(result).toEqual({ type: 'unavailable', reason: 'target_unavailable' });
  });

  it('still reports availability for the current Agent, with sameSessionTransition false', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValue(rawSession({ path: '/work/repo', flavor: 'claude' }));

    const result = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'claude' } },
    });

    expect(result).toMatchObject({ type: 'available', sameSessionTransition: false });
  });

  // The inspection answers for THIS exact machine. A Session hosted elsewhere
  // has no runtime, no workspace and no machine-local native-return record
  // here, so reporting it as `available` would arm a switch this daemon cannot
  // honour and would then have to fail after stopping a Session it does not own.
  it('reports a Session hosted on another machine as unavailable', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValue(
      rawSession({ path: '/work/repo', flavor: 'claude', machineId: 'machine-2' }, { machineId: 'machine-2' }),
    );

    const result = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'codex' } },
      currentMachineId: 'machine-1',
    });

    expect(result).toEqual({ type: 'unavailable', reason: 'unsupported_session' });
  });

  it('still answers for its own Session when the host machine matches', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValue(rawSession({ path: '/work/repo', flavor: 'claude' }));

    const result = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'codex' } },
      currentMachineId: 'machine-1',
    });

    expect(result).toMatchObject({ type: 'available', sameSessionTransition: true });
  });

  // A user who replaces a machine keeps the Sessions the previous one hosted
  // (product ruling). Nothing re-homes a Session row, so its recorded host stays
  // the PREDECESSOR forever; the client already reaches this daemon by walking
  // the replacement chain, so the daemon answers with the same walk rather than
  // a raw id comparison that reads its own inheritance as foreign.
  it('answers for a Session whose recorded host machine this one replaced', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValue(
      rawSession({ path: '/work/repo', flavor: 'claude', machineId: 'machine-old' }, { machineId: 'machine-old' }),
    );
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-old', replacedByMachineId: 'machine-1' },
      { id: 'machine-1' },
    ]);

    const result = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'codex' } },
      currentMachineId: 'machine-1',
    });

    expect(result).toMatchObject({ type: 'available', sameSessionTransition: true });
  });

  // The guard must widen to successors WITHOUT becoming a no-op: an unrelated
  // machine is still not this Session's host.
  it('still reports a Session hosted by an unrelated machine as unavailable', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValue(
      rawSession({ path: '/work/repo', flavor: 'claude', machineId: 'machine-2' }, { machineId: 'machine-2' }),
    );
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-1' },
      { id: 'machine-2' },
    ]);

    const result = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'codex' } },
      currentMachineId: 'machine-1',
    });

    expect(result).toEqual({ type: 'unavailable', reason: 'unsupported_session' });
  });

  // An unreadable chain proves no inheritance, so it keeps the refusal rather
  // than guessing the daemon is the successor.
  it('reports unavailable when the replacement chain cannot be read', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValue(
      rawSession({ path: '/work/repo', flavor: 'claude', machineId: 'machine-old' }, { machineId: 'machine-old' }),
    );
    mocks.fetchAccountMachineReplacements.mockResolvedValue(null);

    const result = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'codex' } },
      currentMachineId: 'machine-1',
    });

    expect(result).toEqual({ type: 'unavailable', reason: 'unsupported_session' });
  });

  // The overwhelmingly common case must not pay for the rare one.
  it('does not read the machine chain when the recorded host is this machine', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValue(rawSession({ path: '/work/repo', flavor: 'claude' }));

    await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'codex' } },
      currentMachineId: 'machine-1',
    });

    expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
  });

  it('reports a missing Session as unsupported rather than guessing', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValue(null);

    const result = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'codex' } },
    });

    expect(result).toEqual({ type: 'unavailable', reason: 'unsupported_session' });
  });
});
