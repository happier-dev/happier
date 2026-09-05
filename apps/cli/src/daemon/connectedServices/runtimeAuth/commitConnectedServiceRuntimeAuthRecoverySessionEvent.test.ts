import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import * as sessionSockets from '@/api/session/sockets';

describe('commitConnectedServiceRuntimeAuthRecoverySessionEvent', () => {
  it('persists the scheduler wait before acknowledging its visible event', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    let metadata: Record<string, unknown> = { path: '/project', unrelated: true };
    const socket = createApiSessionSocketStub({
      onConnect: (connected) => connected.trigger('connect'),
      emit: (event, args) => {
        if (event !== 'update-metadata') return;
        const request = args[0] as { metadata: string };
        metadata = JSON.parse(request.metadata) as Record<string, unknown>;
        const ack = args[1] as (value: unknown) => void;
        ack({ result: 'success', version: 2, metadata: request.metadata });
      },
    });
    // Session-scoped socket construction is the network boundary; metadata CAS remains real.
    vi.spyOn(sessionSockets, 'createSessionScopedSocket').mockReturnValue(socket as unknown as ReturnType<typeof sessionSockets.createSessionScopedSocket>);
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: { session: {
      id: 'sess-wait', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      metadata: JSON.stringify(metadata), metadataVersion: 1, encryptionMode: 'plain',
      agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
    } } });
    vi.spyOn(axios, 'post').mockImplementationOnce(async () => {
      expect(metadata).toMatchObject({ unrelated: true, sessionUsageLimitRecoveryV1: {
        status: 'waiting', nextCheckAtMs: 31000, runtimeAuthRecoveryAttemptId: 'attempt-wait',
      } });
      return { status: 200, data: { didWrite: true, message: { id: 'msg', seq: 2, localId: 'event', createdAt: 2 } } };
    });
    const { commitConnectedServiceRuntimeAuthRecoverySessionEvent } = await import('./commitConnectedServiceRuntimeAuthRecoverySessionEvent');
    await commitConnectedServiceRuntimeAuthRecoverySessionEvent({
      credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      sessionId: 'sess-wait', attemptId: 'attempt-wait', transition: 'scheduled',
      event: {
        type: 'connected-service-runtime-auth-recovery', status: 'retry_scheduled', serviceId: 'openai-codex', terminal: false,
        nextRetryAtMs: 31000,
        diagnostic: { code: 'recovery_retry_scheduled', source: 'runtime_auth_recovery', failurePhase: 'runtime_auth_recovery',
          serviceId: 'openai-codex', retryable: true, suggestedActions: ['retry'] },
      },
      recoveryIntent: {
        v: 2, sessionId: 'sess-wait', attemptId: 'attempt-wait', serviceId: 'openai-codex',
        profileId: 'primary', groupId: 'pool', status: 'waiting', armedAtMs: 1000,
        nextRetryAtMs: 31000, attemptCount: 1, maxAttempts: 3, switchesThisTurn: 0,
        classification: { kind: 'usage_limit', serviceId: 'openai-codex', profileId: 'primary', groupId: 'pool',
          resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' },
        failurePhase: 'handler', failureReason: 'usage_limit', lastError: 'no_eligible_member', lastErrorClassification: null,
      },
    });
    expect(metadata).toHaveProperty('sessionUsageLimitRecoveryV1');
  });
  it('uses durable attempt and transition identity for deterministic replay-safe local ids', async () => {
    const module = await import('./commitConnectedServiceRuntimeAuthRecoverySessionEvent') as typeof import('./commitConnectedServiceRuntimeAuthRecoverySessionEvent') & {
      buildRuntimeAuthRecoveryAttemptTransitionLocalId: (input: { attemptId: string; transition: string }) => string;
    };
    const first = module.buildRuntimeAuthRecoveryAttemptTransitionLocalId({
      attemptId: `runtime-auth-attempt:${'opaque-segment-'.repeat(80)}A`,
      transition: 'scheduled',
    });
    const replay = module.buildRuntimeAuthRecoveryAttemptTransitionLocalId({
      attemptId: `runtime-auth-attempt:${'opaque-segment-'.repeat(80)}A`,
      transition: 'scheduled',
    });
    const distinct = module.buildRuntimeAuthRecoveryAttemptTransitionLocalId({
      attemptId: `runtime-auth-attempt:${'opaque-segment-'.repeat(80)}B`,
      transition: 'scheduled',
    });

    expect(replay).toBe(first);
    expect(distinct).not.toBe(first);
    expect(first).toMatch(/^connected-service-runtime-auth-recovery:/);
    expect(first.length).toBeLessThan(200);
  });
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
  });

  it('rejects a missing session snapshot so durable delivery remains pending without an HTTP commit ACK', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    const {
      commitConnectedServiceRuntimeAuthRecoverySessionEvent,
    } = await import('./commitConnectedServiceRuntimeAuthRecoverySessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 404,
      data: { error: 'Session not found' },
    });
    const postSpy = vi.spyOn(axios, 'post');

    await expect(commitConnectedServiceRuntimeAuthRecoverySessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-missing',
      attemptId: 'runtime-auth-attempt:missing-session',
      transition: 'scheduled',
      event: {
        type: 'connected-service-runtime-auth-recovery',
        status: 'retry_scheduled',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team-pool',
        attempt: 1,
        nextRetryAtMs: 2_000_000,
        terminal: false,
        reason: 'provider_capacity',
        diagnostic: {
          code: 'recovery_retry_scheduled',
          failurePhase: 'runtime_auth_recovery',
          source: 'runtime_auth_recovery',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'team-pool',
          retryable: true,
          suggestedActions: ['retry'],
        },
      },
    })).rejects.toMatchObject({ code: 'runtime_auth_recovery_session_not_found' });

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('commits typed runtime-auth recovery dead-letter events through the session event outbox owner', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    const {
      commitConnectedServiceRuntimeAuthRecoverySessionEvent,
    } = await import('./commitConnectedServiceRuntimeAuthRecoverySessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-recovery',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-recovery', seq: 2, localId: 'local-recovery', createdAt: 2 },
      },
    });
    const diagnostic = {
      code: 'recovery_dead_lettered',
      failurePhase: 'runtime_auth_recovery',
      source: 'runtime_auth_recovery',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team-pool',
      retryable: false,
      suggestedActions: ['open_connected_accounts'],
      diagnostics: { reason: 'max_attempts_exhausted' },
    };

    await commitConnectedServiceRuntimeAuthRecoverySessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-recovery',
      attemptId: 'runtime-auth-attempt:dead-letter-1',
      transition: 'terminal',
      event: {
        type: 'connected-service-runtime-auth-recovery',
        status: 'dead_lettered',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team-pool',
        attempt: 5,
        nextRetryAtMs: null,
        terminal: true,
        reason: 'max_attempts_exhausted',
        diagnostic,
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-recovery\/messages$/),
      expect.objectContaining({
        localId: (await import('./commitConnectedServiceRuntimeAuthRecoverySessionEvent'))
          .buildRuntimeAuthRecoveryAttemptTransitionLocalId({
            attemptId: 'runtime-auth-attempt:dead-letter-1',
            transition: 'terminal',
          }),
        messageRole: 'event',
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            role: 'agent',
            content: expect.objectContaining({
              type: 'event',
              data: expect.objectContaining({
                type: 'connected-service-runtime-auth-recovery',
                status: 'dead_lettered',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'team-pool',
                attempt: 5,
                nextRetryAtMs: null,
                terminal: true,
                reason: 'max_attempts_exhausted',
                diagnostic: expect.objectContaining({
                  source: 'runtime_auth_recovery',
                  failurePhase: 'runtime_auth_recovery',
                }),
              }),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
        }),
      }),
    );
  });

  it('uses a deterministic local id for repeated runtime-auth recovery events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    const {
      commitConnectedServiceRuntimeAuthRecoverySessionEvent,
    } = await import('./commitConnectedServiceRuntimeAuthRecoverySessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: {
        session: {
          id: 'sess-recovery',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-recovery', seq: 2, localId: 'local-recovery', createdAt: 2 },
      },
    });
    const event = {
      type: 'connected-service-runtime-auth-recovery',
      status: 'dead_lettered',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team-pool',
      attempt: 5,
      nextRetryAtMs: null,
      terminal: true,
      reason: 'max_attempts_exhausted',
      diagnostic: {
        code: 'recovery_dead_lettered',
        failurePhase: 'runtime_auth_recovery',
        source: 'runtime_auth_recovery',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team-pool',
        retryable: false,
        suggestedActions: ['open_connected_accounts'],
        diagnostics: { reason: 'max_attempts_exhausted' },
      },
    };
    const credentials = {
      token: 'token-1',
      encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
    };

    await commitConnectedServiceRuntimeAuthRecoverySessionEvent({
      credentials,
      sessionId: 'sess-recovery',
      event,
    });
    await commitConnectedServiceRuntimeAuthRecoverySessionEvent({
      credentials,
      sessionId: 'sess-recovery',
      event: {
        ...event,
        attempt: 6,
        nextRetryAtMs: 2_000_000,
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(2);
    const firstPayload = postSpy.mock.calls[0]?.[1] as Readonly<{ localId: string; content: { v: { content: { id: string } } } }>;
    const secondPayload = postSpy.mock.calls[1]?.[1] as Readonly<{ localId: string; content: { v: { content: { id: string } } } }>;
    expect(firstPayload.localId).not.toBe(secondPayload.localId);
    expect(firstPayload.content.v.content.id).toBe(firstPayload.localId);
    expect(secondPayload.content.v.content.id).toBe(secondPayload.localId);
  });

  it('does not treat retry schedule drift as a new runtime-auth recovery event row', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    const {
      commitConnectedServiceRuntimeAuthRecoverySessionEvent,
    } = await import('./commitConnectedServiceRuntimeAuthRecoverySessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: {
        session: {
          id: 'sess-recovery',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-recovery', seq: 2, localId: 'local-recovery', createdAt: 2 },
      },
    });
    const credentials = {
      token: 'token-1',
      encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
    };
    const event = {
      type: 'connected-service-runtime-auth-recovery',
      status: 'retry_scheduled',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team-pool',
      attempt: 3,
      nextRetryAtMs: 2_000_000,
      terminal: false,
      reason: 'provider_capacity',
      diagnostic: {
        code: 'recovery_retry_scheduled',
        failurePhase: 'runtime_auth_recovery',
        source: 'runtime_auth_recovery',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team-pool',
        retryable: true,
        suggestedActions: ['retry'],
      },
    } as const;

    await commitConnectedServiceRuntimeAuthRecoverySessionEvent({
      credentials,
      sessionId: 'sess-recovery',
      event,
    });
    await commitConnectedServiceRuntimeAuthRecoverySessionEvent({
      credentials,
      sessionId: 'sess-recovery',
      event: {
        ...event,
        nextRetryAtMs: 2_060_000,
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(2);
    const firstPayload = postSpy.mock.calls[0]?.[1] as Readonly<{
      attentionImpact?: { affectsUnread: boolean; affectsMeaningfulActivity: boolean };
      localId: string;
      content: { v: { content: { id: string } } };
    }>;
    const secondPayload = postSpy.mock.calls[1]?.[1] as Readonly<{
      attentionImpact?: { affectsUnread: boolean; affectsMeaningfulActivity: boolean };
      localId: string;
      content: { v: { content: { id: string } } };
    }>;
    expect(firstPayload.localId).toBe(secondPayload.localId);
    expect(firstPayload.localId).toBe('connected-service-runtime-auth-recovery:openai-codex:team-pool:primary:retry_scheduled:3:false:provider_capacity');
    expect(firstPayload.content.v.content.id).toBe(firstPayload.localId);
    expect(secondPayload.content.v.content.id).toBe(secondPayload.localId);
    expect(firstPayload.attentionImpact).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
    expect(secondPayload.attentionImpact).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
  });

  it('reuses the same local id when the same runtime-auth recovery incident is retried', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    const {
      commitConnectedServiceRuntimeAuthRecoverySessionEvent,
    } = await import('./commitConnectedServiceRuntimeAuthRecoverySessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: {
        session: {
          id: 'sess-recovery',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-recovery', seq: 2, localId: 'local-recovery', createdAt: 2 },
      },
    });
    const credentials = {
      token: 'token-1',
      encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
    };
    const event = {
      type: 'connected-service-runtime-auth-recovery',
      status: 'dead_lettered',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team-pool',
      attempt: 2,
      nextRetryAtMs: null,
      terminal: true,
      reason: 'max_attempts_exhausted',
      diagnostic: {
        code: 'recovery_dead_lettered',
        failurePhase: 'runtime_auth_recovery',
        source: 'runtime_auth_recovery',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team-pool',
        retryable: false,
        suggestedActions: ['open_connected_accounts'],
        diagnostics: { reason: 'max_attempts_exhausted' },
      },
    } as const;

    await commitConnectedServiceRuntimeAuthRecoverySessionEvent({
      credentials,
      sessionId: 'sess-recovery',
      event,
    });
    await commitConnectedServiceRuntimeAuthRecoverySessionEvent({
      credentials,
      sessionId: 'sess-recovery',
      event,
    });

    expect(postSpy).toHaveBeenCalledTimes(2);
    const firstPayload = postSpy.mock.calls[0]?.[1] as Readonly<{ localId: string }>;
    const secondPayload = postSpy.mock.calls[1]?.[1] as Readonly<{ localId: string }>;
    expect(firstPayload.localId).toBe(secondPayload.localId);
  });
});
