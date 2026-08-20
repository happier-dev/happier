import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchSessionByIdCompat: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: mocks.fetchSessionByIdCompat,
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

function rawSession(metadata: Record<string, unknown>) {
  return { id: 'session-1', metadata: JSON.stringify(metadata), metadataVersion: 1 };
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

  it('reports a missing Session as unsupported rather than guessing', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValue(null);

    const result = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'codex' } },
    });

    expect(result).toEqual({ type: 'unavailable', reason: 'unsupported_session' });
  });
});
