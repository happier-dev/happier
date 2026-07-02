import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('commitConnectedServiceRuntimeAuthRecoverySessionEvent', () => {
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
});
