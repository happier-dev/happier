import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('commitConnectedServiceRuntimeAuthRecoverySessionEvent', () => {
  it('builds a bounded deterministic local id from durable attempt and transition identity', async () => {
    const { buildRuntimeAuthRecoveryAttemptTransitionLocalId } = await import('./commitConnectedServiceRuntimeAuthRecoverySessionEvent');
    const attemptId = `runtime-auth-attempt:${'opaque-'.repeat(100)}A`;
    const first = buildRuntimeAuthRecoveryAttemptTransitionLocalId({ attemptId, transition: 'scheduled' });
    expect(buildRuntimeAuthRecoveryAttemptTransitionLocalId({ attemptId, transition: 'scheduled' })).toBe(first);
    expect(buildRuntimeAuthRecoveryAttemptTransitionLocalId({ attemptId: `${attemptId}B`, transition: 'scheduled' })).not.toBe(first);
    expect(first.length).toBeLessThan(200);
  });

  it('commits a durable visible-event delivery with its exact attempt and transition tuple', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const {
      buildRuntimeAuthRecoveryAttemptTransitionLocalId,
      commitRuntimeAuthRecoveryVisibleEventDelivery,
    } = await import('./commitConnectedServiceRuntimeAuthRecoverySessionEvent');
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { session: {
        id: 'sess-visible', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain', metadata: '{}', metadataVersion: 1,
        agentState: null, agentStateVersion: 1, dataEncryptionKey: null,
      } },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: { didWrite: true, message: { id: 'msg-visible', seq: 2, localId: 'local-visible', createdAt: 2 } },
    });
    const attemptId = 'runtime-auth-attempt:visible-delivery';
    const transition = 'scheduled';

    await commitRuntimeAuthRecoveryVisibleEventDelivery({
      credentials: {
        token: 'token-visible',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      delivery: {
        sessionId: 'sess-visible',
        attemptId,
        transition,
        transcriptEvent: {
          type: 'connected-service-runtime-auth-recovery',
          status: 'dead_lettered',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'team-pool',
          attempt: 1,
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
        },
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        localId: buildRuntimeAuthRecoveryAttemptTransitionLocalId({ attemptId, transition }),
      }),
      expect.any(Object),
    );
  });

  it('does not acknowledge a durable visible event when the session snapshot is missing', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitRuntimeAuthRecoveryVisibleEventDelivery } =
      await import('./commitConnectedServiceRuntimeAuthRecoverySessionEvent');
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 404, data: {} });

    await expect(commitRuntimeAuthRecoveryVisibleEventDelivery({
      credentials: {
        token: 'token-missing',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      delivery: {
        sessionId: 'sess-missing',
        attemptId: 'runtime-auth-attempt:missing',
        transition: 'terminal',
        transcriptEvent: {
          type: 'connected-service-runtime-auth-recovery',
          status: 'dead_lettered',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'team-pool',
          attempt: 1,
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
        },
      },
    })).rejects.toThrow('runtime_auth_recovery_session_unavailable');
  });
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('commits typed runtime-auth recovery dead-letter events through the session event outbox owner', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
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
        localId: expect.stringMatching(/^connected-service-runtime-auth-recovery:openai-codex:team-pool:primary:dead_lettered:/),
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

  it('uses a distinct local id for separate runtime-auth recovery incidents', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
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

  it('does not include retry schedule drift in runtime-auth recovery local ids', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
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
      attempt: 2,
      nextRetryAtMs: 1_900_000,
      terminal: false,
      reason: 'temporary_throttle',
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
        nextRetryAtMs: 1_950_000,
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(2);
    const firstPayload = postSpy.mock.calls[0]?.[1] as Readonly<{ localId: string; attentionImpact?: unknown }>;
    const secondPayload = postSpy.mock.calls[1]?.[1] as Readonly<{ localId: string; attentionImpact?: unknown }>;
    expect(firstPayload.localId).toBe(secondPayload.localId);
    expect(firstPayload.localId).toBe(
      'connected-service-runtime-auth-recovery:openai-codex:team-pool:primary:retry_scheduled:2:false:temporary_throttle',
    );
    expect(firstPayload.attentionImpact).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
  });

  it('reuses the same local id when the same runtime-auth recovery incident is retried', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
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
