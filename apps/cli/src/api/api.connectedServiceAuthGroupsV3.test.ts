import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { readHttpStatus } from './client/httpStatusError';
import { classifyDaemonServerWorkError } from '@/daemon/serverWork/classifyDaemonServerWorkError';
import { ApiClient } from './api';

const { mockDelete, mockGet, mockPatch, mockPost } = vi.hoisted(() => ({
  mockDelete: vi.fn(),
  mockGet: vi.fn(),
  mockPatch: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { delete: mockDelete, get: mockGet, isAxiosError: vi.fn(() => true), patch: mockPatch, post: mockPost },
  isAxiosError: vi.fn(() => true),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

function authGroupResponse(activeProfileId: string, generation: number) {
  return {
    group: {
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'main',
      displayName: null,
      policy: { v: 1, autoSwitch: true, autoUseQuotaResetsWhenExhausted: true },
      activeProfileId,
      generation,
      runtimeStateRevision: 0,
      state: { v: 1 },
      members: [
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: activeProfileId,
          enabled: true,
          priority: 1,
          state: { v: 1 },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

describe('ApiClient connected service auth groups v3', () => {
  beforeEach(() => {
    mockDelete.mockReset();
    mockGet.mockReset();
    mockPatch.mockReset();
    mockPost.mockReset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('gets an auth group from the v3 connected services groups endpoint', async () => {
    mockGet.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 1) });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const group = await api.getConnectedServiceAuthGroup({ serviceId: 'openai-codex', groupId: 'main' });

    expect(group?.activeProfileId).toBe('primary');
    expect(group?.generation).toBe(1);
    expect(group?.policy.autoUseQuotaResetsWhenExhausted).toBe(true);
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main?happierAutoDisablePlanInvalidAccounts=1&happierPoolQuotaLimitSelection=1&happierPoolExpiryFirst=1'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
          accept: 'application/json; happier-connected-service-auto-quota-reset=1',
        }),
      }),
    );
    const headers = (axios.get as any).mock.calls[0]?.[1]?.headers;
    expect(headers).not.toHaveProperty('x-happier-connected-service-auto-disable-plan-invalid');
    expect(headers).not.toHaveProperty('x-happier-connected-service-pool-quota-limit-selection');
  });

  it('rejects an auth-group response without the required server-owned runtime-state revision', async () => {
    const response = authGroupResponse('primary', 1);
    delete (response.group as Partial<typeof response.group>).runtimeStateRevision;
    mockGet.mockResolvedValue({ status: 200, data: response });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect(api.getConnectedServiceAuthGroup({
      serviceId: 'openai-codex',
      groupId: 'main',
    })).rejects.toThrow('Invalid connected service auth group response');
  });

  it('lists authoritative auth groups for one service through the v3 endpoint', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { groups: [authGroupResponse('primary', 1).group] } });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect(api.listConnectedServiceAuthGroups({ serviceId: 'openai-codex' }))
      .resolves.toEqual([expect.objectContaining({ groupId: 'main', generation: 1 })]);
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups?happierAutoDisablePlanInvalidAccounts=1&happierPoolQuotaLimitSelection=1&happierPoolExpiryFirst=1'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
          accept: 'application/json; happier-connected-service-auto-quota-reset=1',
        }),
      }),
    );
    expect(String((axios.get as any).mock.calls[0]?.[0])).not.toContain('/groups/undefined');
  });

  it('uses the connected-services server API timeout for auth group reads', async () => {
    mockGet.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 1) });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await api.getConnectedServiceAuthGroup({ serviceId: 'openai-codex', groupId: 'main' });

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main'),
      expect.objectContaining({
        timeout: 30_000,
      }),
    );
  });

  it('honors a bounded connected-services server API timeout override', async () => {
    vi.stubEnv('HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS', '45000');
    mockGet.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 1) });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await api.getConnectedServiceAuthGroup({ serviceId: 'openai-codex', groupId: 'main' });

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main'),
      expect.objectContaining({
        timeout: 45_000,
      }),
    );
  });

  it('returns null only for the server-confirmed deleted auth-group response', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 404,
        data: { error: 'connect_group_not_found' },
      },
    });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect(api.getConnectedServiceAuthGroup({
      serviceId: 'openai-codex',
      groupId: 'main',
    })).resolves.toBeNull();
  });

  it('throws an indeterminate auth-group error for feature-gated 404 responses', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 404,
        data: { error: 'not_found' },
      },
    });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    let caught: unknown;
    try {
      await api.getConnectedServiceAuthGroup({ serviceId: 'openai-codex', groupId: 'main' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(readHttpStatus(caught)).toBe(404);
    expect((caught as { code?: string }).code).toBe('connected_service_auth_group_unavailable');
  });

  it('commits an auth group active profile through the CAS active-profile contract', async () => {
    mockPost.mockResolvedValue({ status: 200, data: authGroupResponse('backup', 2) });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const group = await api.updateConnectedServiceAuthGroupActiveProfile({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      expectedGeneration: 1,
    });

    expect(group.activeProfileId).toBe('backup');
    expect(group.generation).toBe(2);
    expect(axios.patch).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main/active-profile?happierAutoDisablePlanInvalidAccounts=1&happierPoolQuotaLimitSelection=1&happierPoolExpiryFirst=1'),
      { profileId: 'backup', expectedGeneration: 1 },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
          accept: 'application/json; happier-connected-service-auto-quota-reset=1',
        }),
      }),
    );
  });

  it('can request an automated active-profile commit that overrides stale runtime cooldown state', async () => {
    mockPost.mockResolvedValue({ status: 200, data: authGroupResponse('backup', 2) });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const group = await api.updateConnectedServiceAuthGroupActiveProfile({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      expectedGeneration: 1,
      overrideRuntimeCooldown: true,
      switchReason: 'usage_limit',
    });

    expect(group.activeProfileId).toBe('backup');
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main/active-profile?happierAutoDisablePlanInvalidAccounts=1&happierPoolQuotaLimitSelection=1&happierPoolExpiryFirst=1'),
      { profileId: 'backup', expectedGeneration: 1, overrideRuntimeCooldown: true },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
          accept: 'application/json; happier-connected-service-auto-quota-reset=1',
          'x-happier-connected-service-switch-reason': 'usage_limit',
        }),
      }),
    );
  });

  it('updates auth group runtime state through the runtime-state contract', async () => {
    mockPatch.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 1) });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const group = await api.updateConnectedServiceAuthGroupRuntimeState({
      serviceId: 'openai-codex',
      groupId: 'main',
      expectedGeneration: 1,
      expectedRuntimeStateRevision: 0,
      memberStates: [
        {
          profileId: 'primary',
          state: {
            quotaExhaustedUntilMs: 5_000,
            lastFailureKind: 'usage_limit',
          },
        },
      ],
    });

    expect(group.activeProfileId).toBe('primary');
    expect(axios.patch).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main/runtime-state?happierAutoDisablePlanInvalidAccounts=1&happierPoolQuotaLimitSelection=1&happierPoolExpiryFirst=1'),
      {
        expectedGeneration: 1,
        expectedRuntimeStateRevision: 0,
        memberStates: [
          {
            profileId: 'primary',
            state: {
              quotaExhaustedUntilMs: 5_000,
              lastFailureKind: 'usage_limit',
            },
          },
        ],
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
          accept: 'application/json; happier-connected-service-auto-quota-reset=1',
        }),
      }),
    );
  });

  it('rejects active-profile updates that omit expectedGeneration before sending a request', async () => {
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect(api.updateConnectedServiceAuthGroupActiveProfile({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
    } as never)).rejects.toThrow('expectedGeneration');

    expect(axios.post).not.toHaveBeenCalled();
  });

  it('allows neutral runtime-state patches without expectedGeneration', async () => {
    mockPatch.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 1) });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const group = await api.updateConnectedServiceAuthGroupRuntimeState({
      serviceId: 'openai-codex',
      groupId: 'main',
      memberStates: [],
    } as never);

    expect(group.activeProfileId).toBe('primary');
    expect(axios.patch).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main/runtime-state?happierAutoDisablePlanInvalidAccounts=1&happierPoolQuotaLimitSelection=1&happierPoolExpiryFirst=1'),
      { memberStates: [] },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
          accept: 'application/json; happier-connected-service-auto-quota-reset=1',
        }),
      }),
    );
  });

  it('rejects mutating runtime-state updates that omit expectedGeneration before sending a request', async () => {
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect(api.updateConnectedServiceAuthGroupRuntimeState({
      serviceId: 'openai-codex',
      groupId: 'main',
      state: { status: 'error' },
      memberStates: [],
    } as never)).rejects.toThrow('expectedGeneration');
    await expect(api.updateConnectedServiceAuthGroupRuntimeState({
      serviceId: 'openai-codex',
      groupId: 'main',
      memberStates: [{ profileId: 'primary', state: { lastFailureKind: 'usage_limit' } }],
    } as never)).rejects.toThrow('expectedGeneration');

    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('sends auth group member mutations through CAS contracts', async () => {
    mockPost.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 2) });
    mockPatch.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 3) });
    mockDelete.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 4) });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await api.createConnectedServiceAuthGroupMember({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      priority: 50,
      expectedGeneration: 1,
    });
    await api.updateConnectedServiceAuthGroupMember({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      enabled: false,
      expectedGeneration: 2,
    });
    await api.deleteConnectedServiceAuthGroupMember({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      expectedGeneration: 3,
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main/members?happierAutoDisablePlanInvalidAccounts=1&happierPoolQuotaLimitSelection=1&happierPoolExpiryFirst=1'),
      { profileId: 'backup', priority: 50, expectedGeneration: 1 },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
          accept: 'application/json; happier-connected-service-auto-quota-reset=1',
        }),
      }),
    );
    expect(axios.patch).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main/members/backup?happierAutoDisablePlanInvalidAccounts=1&happierPoolQuotaLimitSelection=1&happierPoolExpiryFirst=1'),
      { enabled: false, expectedGeneration: 2 },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
          accept: 'application/json; happier-connected-service-auto-quota-reset=1',
        }),
      }),
    );
    expect(axios.delete).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main/members/backup?happierAutoDisablePlanInvalidAccounts=1&happierPoolQuotaLimitSelection=1&happierPoolExpiryFirst=1'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
          accept: 'application/json; happier-connected-service-auto-quota-reset=1',
        }),
        params: { expectedGeneration: 3 },
      }),
    );
    // Bodiless DELETE: a JSON content type makes Fastify reject it (FST_ERR_CTP_EMPTY_JSON_BODY).
    expect(vi.mocked(axios.delete).mock.calls[0]?.[1]?.headers).not.toHaveProperty('Content-Type');
  });

  it('rejects auth group member mutations that omit expectedGeneration before sending a request', async () => {
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect(api.createConnectedServiceAuthGroupMember({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
    } as never)).rejects.toThrow('expectedGeneration');
    await expect(api.updateConnectedServiceAuthGroupMember({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      enabled: false,
    } as never)).rejects.toThrow('expectedGeneration');
    await expect(api.deleteConnectedServiceAuthGroupMember({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
    } as never)).rejects.toThrow('expectedGeneration');

    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.patch).not.toHaveBeenCalled();
    expect(axios.delete).not.toHaveBeenCalled();
  });

  it('preserves transient auth-group HTTP failures so runtime-auth recovery can retry them', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 503',
      response: {
        status: 503,
        data: { error: 'temporarily_unavailable' },
      },
    });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    let caught: unknown;
    try {
      await api.getConnectedServiceAuthGroup({ serviceId: 'openai-codex', groupId: 'main' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(readHttpStatus(caught)).toBe(503);
    expect(classifyDaemonServerWorkError(caught)).toMatchObject({
      kind: 'server_error',
      retryable: true,
      statusCode: 503,
    });
  });

  it('preserves ECONNREFUSED code/cause so a local-endpoint outage stays network/retryable', async () => {
    // No HTTP response (the daemon control endpoint is down). The re-wrapped error must keep
    // the transport code/cause so it does NOT terminalize runtime-auth recovery.
    const transportError: Error & { code?: string } = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:52753'),
      { isAxiosError: true, code: 'ECONNREFUSED' },
    );
    mockGet.mockRejectedValue(transportError);
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    let caught: unknown;
    try {
      await api.getConnectedServiceAuthGroup({ serviceId: 'openai-codex', groupId: 'main' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('ECONNREFUSED');
    expect((caught as { cause?: unknown }).cause).toBe(transportError);
    expect(classifyDaemonServerWorkError(caught)).toMatchObject({
      kind: 'network',
      retryable: true,
    });
  });
});

  it('throws ConnectedServiceAuthGroupGenerationConflictError on 409 conflict', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: 'connect_group_generation_conflict', generation: 5 },
      },
    });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect(api.updateConnectedServiceAuthGroupActiveProfile({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      expectedGeneration: 1,
    })).rejects.toThrow('connected_service_auth_group_generation_conflict');
  });
