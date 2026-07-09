import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('commitConnectedServiceAccountSwitchSessionEvent', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('commits manual profile switches without requiring a group id', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-1',
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
        message: { id: 'msg-1', seq: 2, localId: 'local-1', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'anthropic',
        groupId: null,
        fromProfileId: 'old-profile',
        toProfileId: 'new-profile',
        reason: 'manual',
      },
    });

    expect(getSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-1$/),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
      }),
    );
    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-1\/messages$/),
      expect.objectContaining({
        localId: expect.stringMatching(/^connected-service-account-switch:anthropic:direct:/),
        messageRole: 'event',
        attentionImpact: {
          affectsUnread: false,
          affectsMeaningfulActivity: false,
        },
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                groupId: null,
                fromProfileId: 'old-profile',
                toProfileId: 'new-profile',
                reason: 'manual',
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

  it('uses deterministic local ids for switch maintenance event families', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: {
        session: {
          id: 'sess-deterministic',
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
      data: { didWrite: true, message: { id: 'm', seq: 2, localId: 'l', createdAt: 2 } },
    });
    const credentials = {
      token: 'token-1',
      encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
    };
    const events = [
      {
        type: 'connected_service_account_switch_deferred',
        policy: 'defer_until_turn_boundary',
        awaitingBoundary: true,
        timeoutMs: 30_000,
      },
      {
        type: 'connected_service_account_switch_deferral_completed',
        policy: 'defer_until_turn_boundary',
        reason: 'completed_at_boundary',
      },
      {
        type: 'connected_service_account_switch_deferral_superseded',
        policy: 'defer_until_idle',
      },
      {
        type: 'connected_service_account_switch_attempt',
        ok: false,
        action: 'hot_applied',
        attemptedContinuityMode: 'hot_apply',
        outcome: 'failed',
        outcomeAction: 'none',
        reason: 'manual',
        errorCode: 'auth_invalid',
        partialState: 'runtime_auth_partially_applied',
      },
      {
        type: 'provider_state_sharing_degraded',
        serviceId: 'pi',
        requestedStateMode: 'enabled',
        effectiveStateMode: 'disabled',
        code: 'state_sharing_unavailable',
      },
      {
        type: 'connected_service_account_switch',
        serviceId: 'anthropic',
        groupId: null,
        fromProfileId: 'old-profile',
        toProfileId: 'new-profile',
        reason: 'manual',
      },
    ] as const;

    for (const event of events) {
      await commitConnectedServiceAccountSwitchSessionEvent({
        credentials,
        sessionId: 'sess-deterministic',
        event,
      });
    }

    const localIds = postSpy.mock.calls.map((call) => (
      call[1] as Readonly<{ localId: string }>
    ).localId);
    expect(localIds).toEqual([
      'connected-service-account-switch-deferral:defer_until_turn_boundary:awaiting-boundary:30000',
      'connected-service-account-switch-deferral-completed:defer_until_turn_boundary:completed_at_boundary',
      'connected-service-account-switch-deferral-superseded:defer_until_idle',
      'connected-service-account-switch-attempt:failed:hot_applied:manual:hot_apply:failed:none:auth_invalid',
      'provider-state-sharing-degraded:pi:enabled:disabled:state_sharing_unavailable',
      'connected-service-account-switch:anthropic:direct:old-profile:new-profile:manual:restart_resume',
    ]);
  });

  it('attaches resolved profile labels to committed switch events for non-hydrated clients', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-1',
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
        message: { id: 'msg-1', seq: 2, localId: 'local-1', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'claude-subscription',
        groupId: null,
        fromProfileId: 'old-profile',
        toProfileId: 'new-profile',
        reason: 'manual',
      },
      listConnectedServiceProfiles: async () => ({
        serviceId: 'claude-subscription',
        profiles: [
          { profileId: 'old-profile', displayName: 'Work Account' },
          { profileId: 'new-profile', providerEmail: 'personal@example.test' },
        ],
      }),
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-1\/messages$/),
      expect.objectContaining({
        content: expect.objectContaining({
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                fromProfileId: 'old-profile',
                toProfileId: 'new-profile',
                fromProfileLabel: 'Work Account',
                toProfileLabel: 'personal@example.test',
              }),
            }),
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('skips same-profile connected-service account switch transcript events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-same-profile',
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
        message: { id: 'msg-same-profile', seq: 2, localId: 'local-same-profile', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-same-profile',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'claude-subscription',
        groupId: 'claude',
        fromProfileId: 'batiplus',
        toProfileId: 'batiplus',
        reason: 'manual',
      },
      listConnectedServiceProfiles: async () => ({
        serviceId: 'claude-subscription',
        profiles: [
          { profileId: 'batiplus', displayName: 'leeroy' },
        ],
      }),
    });

    expect(getSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('commits pre-turn auth-group soft-threshold switch coordinator events (preemptive swaps surface)', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-3',
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
        message: { id: 'msg-3', seq: 2, localId: 'local-3', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-3',
      event: {
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'soft_threshold',
        fromGeneration: 3,
        toGeneration: 4,
        resultStatus: 'switched',
        success: true,
        latencyMs: 12,
      },
    });

    // soft_threshold is a user-relevant preemptive swap: it commits like a hard-limit switch.
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('suppresses same-provider fanout switch coordinator events as background maintenance', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-fanout',
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
      data: { didWrite: true, message: { id: 'm', seq: 2, localId: 'l', createdAt: 2 } },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) } },
      sessionId: 'sess-fanout',
      event: {
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'same_provider_account_exhausted',
        fromGeneration: 3,
        toGeneration: 4,
        resultStatus: 'switched',
        success: true,
        latencyMs: 12,
      },
    });

    expect(getSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('carries the event-source group label on committed switch events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-group-label',
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
        message: { id: 'msg-group-label', seq: 2, localId: 'local-group-label', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-group-label',
      event: {
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        groupLabel: 'Codex Team',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'usage_limit',
        fromGeneration: 3,
        toGeneration: 4,
        resultStatus: 'switched',
        success: true,
        latencyMs: 12,
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-group-label\/messages$/),
      expect.objectContaining({
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'codex-main',
                groupLabel: 'Codex Team',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('commits the actual switch mode from runtime auth events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-4',
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
        message: { id: 'msg-4', seq: 2, localId: 'local-4', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-4',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'anthropic',
        groupId: null,
        fromProfileId: 'old-profile',
        toProfileId: 'new-profile',
        reason: 'manual',
        mode: 'hot_apply',
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-4\/messages$/),
      expect.objectContaining({
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                mode: 'hot_apply',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('commits a deferral lifecycle event when a switch is deferred until the turn boundary', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-deferred',
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
      data: { didWrite: true, message: { id: 'm', seq: 2, localId: 'l', createdAt: 2 } },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) } },
      sessionId: 'sess-deferred',
      event: {
        type: 'connected_service_account_switch_deferred',
        policy: 'defer_until_turn_boundary',
        awaitingBoundary: true,
        timeoutMs: 30_000,
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-deferred\/messages$/),
      expect.objectContaining({
        localId: expect.stringMatching(/^connected-service-account-switch-deferral:defer_until_turn_boundary:awaiting-boundary:/),
        attentionImpact: {
          affectsUnread: false,
          affectsMeaningfulActivity: false,
        },
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'connected-service-account-switch-deferral',
                policy: 'defer_until_turn_boundary',
                awaitingBoundary: true,
                timeoutMs: 30_000,
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('commits a switch attempt lifecycle event including the failure error code', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-attempt',
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
      data: { didWrite: true, message: { id: 'm', seq: 2, localId: 'l', createdAt: 2 } },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) } },
      sessionId: 'sess-attempt',
      event: {
        type: 'connected_service_account_switch_attempt',
        ok: false,
        action: 'restart_requested',
        errorCode: 'provider_session_state_unavailable_for_resume',
        partialState: null,
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-attempt\/messages$/),
      expect.objectContaining({
        localId: expect.stringMatching(/^connected-service-account-switch-attempt:failed:/),
        attentionImpact: {
          affectsUnread: false,
          affectsMeaningfulActivity: false,
        },
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'connected-service-account-switch-attempt',
                ok: false,
                action: 'restart_requested',
                errorCode: 'provider_session_state_unavailable_for_resume',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('preserves failed hot-apply outcome fields without claiming a successful outcome action', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-attempt-hot-apply',
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
      data: { didWrite: true, message: { id: 'm', seq: 2, localId: 'l', createdAt: 2 } },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) } },
      sessionId: 'sess-attempt-hot-apply',
      event: {
        type: 'connected_service_account_switch_attempt',
        ok: false,
        action: 'hot_applied',
        attemptedContinuityMode: 'hot_apply',
        outcome: 'failed',
        outcomeAction: 'none',
        reason: 'manual',
        errorCode: 'hot_apply_failed',
        partialState: 'runtime_auth_partially_applied',
        groupGeneration: 7,
        sessionAdoption: 'failed',
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-attempt-hot-apply\/messages$/),
      expect.objectContaining({
        attentionImpact: {
          affectsUnread: false,
          affectsMeaningfulActivity: false,
        },
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'connected-service-account-switch-attempt',
                ok: false,
                action: 'hot_applied',
                reason: 'manual',
                attemptedContinuityMode: 'hot_apply',
                outcome: 'failed',
                outcomeAction: 'none',
                errorCode: 'hot_apply_failed',
                groupGeneration: 7,
                sessionAdoption: 'failed',
                partialState: 'runtime_auth_partially_applied',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('commits sanitized successful switch attempt verification evidence', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-attempt-ok',
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
      data: { didWrite: true, message: { id: 'm', seq: 2, localId: 'l', createdAt: 2 } },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) } },
      sessionId: 'sess-attempt-ok',
      event: {
        type: 'connected_service_account_switch_attempt',
        ok: true,
        action: 'restart_requested',
        verificationByServiceId: {
          'openai-codex': {
            status: 'weakly_verified',
            reason: 'provider_account_email_verified_without_account_id',
            providerAccountId: 'acct-secret',
          },
        },
      },
    });

    const postedBody = postSpy.mock.calls[0]?.[1];
    expect(postedBody).toEqual(expect.objectContaining({
      attentionImpact: {
        affectsUnread: false,
        affectsMeaningfulActivity: false,
      },
      content: expect.objectContaining({
        t: 'plain',
        v: expect.objectContaining({
          content: expect.objectContaining({
            data: expect.objectContaining({
              type: 'connected-service-account-switch-attempt',
              ok: true,
              action: 'restart_requested',
              verificationByServiceId: {
                'openai-codex': {
                  status: 'weakly_verified',
                  reason: 'provider_account_email_verified_without_account_id',
                },
              },
            }),
          }),
        }),
      }),
    }));
    expect(JSON.stringify(postedBody)).not.toContain('acct-secret');
  });

  it('commits soft-threshold switch attempt transcript events (preemptive swaps surface)', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-attempt-background',
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
      data: { didWrite: true, message: { id: 'm', seq: 2, localId: 'l', createdAt: 2 } },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) } },
      sessionId: 'sess-attempt-background',
      event: {
        type: 'connected_service_account_switch_attempt',
        ok: true,
        action: 'hot_applied',
        attemptedContinuityMode: 'hot_apply',
        outcome: 'succeeded',
        outcomeAction: 'hot_applied',
        errorCode: null,
        partialState: null,
        reason: 'soft_threshold',
      },
    });

    // Preemptive soft-threshold attempts surface in the transcript like hard-limit attempts.
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('suppresses same-provider fanout switch attempt transcript events as background maintenance', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-attempt-fanout',
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
      data: { didWrite: true, message: { id: 'm', seq: 2, localId: 'l', createdAt: 2 } },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) } },
      sessionId: 'sess-attempt-fanout',
      event: {
        type: 'connected_service_account_switch_attempt',
        ok: true,
        action: 'hot_applied',
        attemptedContinuityMode: 'hot_apply',
        outcome: 'succeeded',
        outcomeAction: 'hot_applied',
        errorCode: null,
        partialState: null,
        reason: 'same_provider_account_exhausted',
      },
    });

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('does not persist local state-sharing entry names in provider degraded diagnostics', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-degraded',
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
      data: { didWrite: true, message: { id: 'm', seq: 2, localId: 'l', createdAt: 2 } },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) } },
      sessionId: 'sess-degraded',
      event: {
        type: 'provider_state_sharing_degraded',
        serviceId: 'pi',
        requestedStateMode: 'enabled',
        effectiveStateMode: 'disabled',
        code: 'state_sharing_unavailable',
        reason: 'Provider state sharing unavailable',
        entryName: 'sessions/--Users-alice-work-project--',
      },
    });

    const postedBody = postSpy.mock.calls[0]?.[1];
    expect(postedBody).toEqual(expect.objectContaining({
      attentionImpact: {
        affectsUnread: false,
        affectsMeaningfulActivity: false,
      },
    }));
    expect(JSON.stringify(postedBody)).not.toContain('Users-alice-work-project');
    expect(JSON.stringify(postedBody)).not.toContain('entryName');
  });
});
