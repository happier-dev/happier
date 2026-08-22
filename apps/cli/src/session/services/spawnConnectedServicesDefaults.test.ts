import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoredCredentials } from '@/persistence';

const mocks = vi.hoisted(() => ({
  bootstrapAccountSettingsContext: vi.fn(),
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext: mocks.bootstrapAccountSettingsContext,
}));

import {
  resolveSessionSpawnConnectedServicesDefaultsPayload,
  resolveSpawnConnectedServicesDefaultDisposition,
  resolveSpawnConnectedServicesDefaults,
} from './spawnConnectedServicesDefaults';

describe('resolveSpawnConnectedServicesDefaults', () => {
  beforeEach(() => {
    mocks.bootstrapAccountSettingsContext.mockReset();
  });

  it('resolves connected-service defaults from plain account Settings with token-only credentials', async () => {
    const credentials = {
      token: 'token-only',
      encryption: null,
    } satisfies StoredCredentials;
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({
      settings: {
        connectedServicesDefaultAuthByAgentIdV1: {
          v: 1,
          bindingsByAgentId: {
            codex: {
              v: 1,
              bindingsByServiceId: {
                'openai-codex': {
                  source: 'connected',
                  selection: 'profile',
                  profileId: 'primary',
                },
              },
            },
          },
        },
      },
    });

    await expect(resolveSessionSpawnConnectedServicesDefaultsPayload({
      agentId: 'codex',
      credentials,
    })).resolves.toMatchObject({
      connectedServices: {
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'primary',
          },
        },
      },
      connectedServicesUpdatedAt: expect.any(Number),
    });
    expect(mocks.bootstrapAccountSettingsContext).toHaveBeenCalledWith({
      credentials,
      mode: 'blocking',
      deps: { applySideEffects: expect.any(Function) },
    });
  });

  it('preserves an exact connected group selection while availability is deferred to the daemon', () => {
    expect(resolveSpawnConnectedServicesDefaults({
      agentId: 'claude',
      accountSettings: {
        connectedServicesDefaultAuthByAgentIdV1: {
          v: 1,
          bindingsByAgentId: {
            claude: {
              v: 1,
              bindingsByServiceId: {
                'claude-subscription': {
                  source: 'connected',
                  selection: 'group',
                  groupId: 'team',
                },
              },
            },
          },
        },
      },
    })).toEqual({
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'team',
        },
        anthropic: { source: 'native' },
      },
    });
  });

  it('preserves protocol-tolerant native fallback for a malformed persisted default blob', () => {
    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex',
      accountSettings: {},
    })).toEqual({ kind: 'native' });
    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex',
      accountSettings: {
        connectedServicesDefaultAuthByAgentIdV1: { v: 999 },
      },
    })).toEqual({ kind: 'native' });
  });
});
