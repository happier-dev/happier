import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { classifyDaemonServerWorkError } from '@/daemon/serverWork/classifyDaemonServerWorkError';
import { ApiClient } from './api';
import { readHttpStatus } from './client/httpStatusError';

const { mockGet, mockPatch, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPatch: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { get: mockGet, isAxiosError: vi.fn(() => true), patch: mockPatch, post: mockPost },
  isAxiosError: vi.fn(() => true),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('./configuration', () => ({
  configuration: {
    apiServerUrl: 'https://api.example.com',
  },
}));

function authGroupResponse(activeProfileId: string, generation: number) {
  return {
    group: {
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'main',
      displayName: null,
      policy: { v: 1 },
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

function createApiClient() {
  return ApiClient.create({
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  });
}

describe('ApiClient connected service auth groups v3', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPatch.mockReset();
    mockPost.mockReset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the connected-services server API timeout for auth group reads', async () => {
    mockGet.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 1) });
    const api = await createApiClient();

    await api.getConnectedServiceAuthGroup({ serviceId: 'openai-codex', groupId: 'main' });

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main'),
      expect.objectContaining({
        timeout: 30_000,
      }),
    );
  });

  it('lists the authoritative current auth groups for one connected service', async () => {
    const response = authGroupResponse('primary', 4);
    mockGet.mockResolvedValue({ status: 200, data: { groups: [response.group] } });
    const api = await createApiClient();

    await expect(api.listConnectedServiceAuthGroups({ serviceId: 'openai-codex' }))
      .resolves.toMatchObject([{
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        generation: 4,
      }]);
    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer happy-token' }),
        timeout: 30_000,
      }),
    );
  });

  it('rejects malformed auth-group inventory at the HTTP boundary', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: { groups: [{ serviceId: 'openai-codex', groupId: 'main' }] },
    });
    const api = await createApiClient();

    await expect(api.listConnectedServiceAuthGroups({ serviceId: 'openai-codex' }))
      .rejects.toThrow('Invalid connected service auth group list response');
  });

  it('rejects an auth-group response without the authoritative runtime-state revision', async () => {
    const response = authGroupResponse('primary', 4);
    const { runtimeStateRevision: _removed, ...group } = response.group;
    mockGet.mockResolvedValue({ status: 200, data: { group } });
    const api = await createApiClient();

    await expect(api.getConnectedServiceAuthGroup({
      serviceId: 'openai-codex',
      groupId: 'main',
    })).rejects.toThrow('Invalid connected service auth group response');
  });

  it('honors a bounded connected-services server API timeout override', async () => {
    vi.stubEnv('HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS', '45000');
    mockGet.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 1) });
    const api = await createApiClient();

    await api.getConnectedServiceAuthGroup({ serviceId: 'openai-codex', groupId: 'main' });

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main'),
      expect.objectContaining({
        timeout: 45_000,
      }),
    );
  });

  it('updates auth group runtime state through the runtime-state contract', async () => {
    mockPatch.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 2) });
    const api = await createApiClient();

    expect(typeof (api as { updateConnectedServiceAuthGroupRuntimeState?: unknown }).updateConnectedServiceAuthGroupRuntimeState).toBe('function');

    const group = await (api as {
      updateConnectedServiceAuthGroupRuntimeState(params: {
        serviceId: 'openai-codex';
        groupId: string;
        expectedGeneration: number;
        expectedRuntimeStateRevision: number;
        memberStates: Array<{
          profileId: string;
          state: {
            quotaExhaustedUntilMs: number;
            lastFailureKind: string;
          };
        }>;
      }): Promise<{ activeProfileId: string | null; generation: number }>;
    }).updateConnectedServiceAuthGroupRuntimeState({
      serviceId: 'openai-codex',
      groupId: 'main',
      expectedGeneration: 1,
      expectedRuntimeStateRevision: 4,
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
    expect(group.generation).toBe(2);
    expect(axios.patch).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main/runtime-state'),
      {
        expectedGeneration: 1,
        expectedRuntimeStateRevision: 4,
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
        headers: expect.objectContaining({ Authorization: 'Bearer happy-token' }),
      }),
    );
  });

  it('preserves generation conflicts from active-profile updates', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: 'connect_group_generation_conflict', generation: 5 },
      },
    });
    const api = await createApiClient();

    await expect(api.updateConnectedServiceAuthGroupActiveProfile({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      expectedGeneration: 1,
    })).rejects.toMatchObject({
      generation: 5,
      message: 'connected_service_auth_group_generation_conflict',
    });
  });

  it('can explicitly override runtime cooldown when updating an auth group active profile', async () => {
    mockPost.mockResolvedValue({ status: 200, data: authGroupResponse('backup', 2) });
    const api = await createApiClient();

    await expect(api.updateConnectedServiceAuthGroupActiveProfile({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      expectedGeneration: 1,
      overrideRuntimeCooldown: true,
    })).resolves.toMatchObject({
      activeProfileId: 'backup',
      generation: 2,
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main/active-profile'),
      {
        profileId: 'backup',
        expectedGeneration: 1,
        overrideRuntimeCooldown: true,
      },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer happy-token' }),
      }),
    );
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
    const api = await createApiClient();

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

  it('distinguishes deleted auth-group 404s from feature-gated 404s', async () => {
    const api = await createApiClient();

    mockGet.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 404,
        data: { error: 'connect_group_not_found' },
      },
    });
    await expect(api.getConnectedServiceAuthGroup({
      serviceId: 'openai-codex',
      groupId: 'deleted',
    })).resolves.toBeNull();

    mockGet.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 404,
        data: { error: 'not_found' },
      },
    });
    await expect(api.getConnectedServiceAuthGroup({
      serviceId: 'openai-codex',
      groupId: 'feature-gated',
    })).rejects.toMatchObject({
      response: { status: 404 },
      code: 'not_found',
    });
  });
});
