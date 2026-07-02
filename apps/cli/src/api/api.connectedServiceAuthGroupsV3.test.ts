import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('updates auth group runtime state through the runtime-state contract', async () => {
    mockPatch.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 2) });
    const api = await createApiClient();

    expect(typeof (api as { updateConnectedServiceAuthGroupRuntimeState?: unknown }).updateConnectedServiceAuthGroupRuntimeState).toBe('function');

    const group = await (api as {
      updateConnectedServiceAuthGroupRuntimeState(params: {
        serviceId: 'openai-codex';
        groupId: string;
        expectedGeneration: number;
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
});
