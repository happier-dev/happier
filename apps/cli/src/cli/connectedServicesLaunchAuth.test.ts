import { describe, expect, it, vi } from 'vitest';

import {
  parseConnectedServicesLaunchAuth,
  resolveCliConnectedServicesLaunchBindings,
  resolveConnectedServicesLaunchAuth,
  resolveConnectedServicesLaunchAuthWithInventory,
} from './connectedServicesLaunchAuth';

const CODEX_SERVICE_KEY = 'happier.agent.codex/openai-codex';

const codexInventory = {
  supportedServiceIds: [CODEX_SERVICE_KEY],
  profileOptionsByServiceId: {
    [CODEX_SERVICE_KEY]: [{ profileId: 'work', status: 'connected' }],
  },
  groupOptionsByServiceId: {
    [CODEX_SERVICE_KEY]: [{ groupId: 'team' }],
  },
};

describe('connectedServicesLaunchAuth', () => {
  it('parses the canonical shorthand without provider-specific core logic', () => {
    expect(parseConnectedServicesLaunchAuth('default')).toEqual({ kind: 'default' });
    expect(parseConnectedServicesLaunchAuth('native')).toEqual({ kind: 'native' });
    expect(parseConnectedServicesLaunchAuth('cs:team')).toEqual({
      kind: 'connected',
      id: 'team',
      selection: null,
      serviceId: null,
    });
    expect(parseConnectedServicesLaunchAuth(`cs:${CODEX_SERVICE_KEY}:group:team`)).toEqual({
      kind: 'connected',
      id: 'team',
      selection: 'group',
      serviceId: CODEX_SERVICE_KEY,
    });
  });

  it('resolves the exact id through the evolved inventory shape', () => {
    expect(resolveConnectedServicesLaunchAuth({
      intent: parseConnectedServicesLaunchAuth('cs:work'),
      supportedServiceIds: [CODEX_SERVICE_KEY],
      inventory: codexInventory,
    })).toEqual({
      v: 2,
      bindingsByServiceId: {
        [CODEX_SERVICE_KEY]: {
          source: 'connected',
          selection: 'profile',
          profileId: 'work',
        },
      },
    });
  });

  it('fails closed when the exact id is unavailable', () => {
    expect(() => resolveConnectedServicesLaunchAuth({
      intent: parseConnectedServicesLaunchAuth('cs:missing'),
      supportedServiceIds: [CODEX_SERVICE_KEY],
      inventory: codexInventory,
    })).toThrow('connected_service_auth_not_found:cs:missing');
  });

  it.each(['needs_reauth', 'refreshing', 'refresh_failed_retryable'])(
    'resolves an existing %s profile so the daemon owns credential admission',
    (status) => {
      expect(resolveConnectedServicesLaunchAuth({
        intent: parseConnectedServicesLaunchAuth(`cs:${CODEX_SERVICE_KEY}:profile:work`),
        supportedServiceIds: [CODEX_SERVICE_KEY],
        inventory: {
          ...codexInventory,
          profileOptionsByServiceId: {
            [CODEX_SERVICE_KEY]: [{ profileId: 'work', status }],
          },
        },
      })).toEqual({
        v: 2,
        bindingsByServiceId: {
          [CODEX_SERVICE_KEY]: {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
          },
        },
      });
    },
  );

  it('reports qualified alternatives when an exact id is ambiguous', () => {
    expect(() => resolveConnectedServicesLaunchAuth({
      intent: parseConnectedServicesLaunchAuth('cs:same'),
      supportedServiceIds: [CODEX_SERVICE_KEY],
      inventory: {
        supportedServiceIds: [CODEX_SERVICE_KEY],
        profileOptionsByServiceId: {
          [CODEX_SERVICE_KEY]: [{ profileId: 'same', status: 'connected' }],
        },
        groupOptionsByServiceId: {
          [CODEX_SERVICE_KEY]: [{ groupId: 'same' }],
        },
      },
    })).toThrow(
      `connected_service_auth_ambiguous:cs:${CODEX_SERVICE_KEY}:profile:same,cs:${CODEX_SERVICE_KEY}:group:same`,
    );
  });

  it('consults the canonical inventory only for an explicit connected selector', async () => {
    const listInventory = vi.fn(async () => codexInventory);

    await expect(resolveConnectedServicesLaunchAuthWithInventory({
      intent: parseConnectedServicesLaunchAuth('cs:work'),
      supportedServiceIds: [CODEX_SERVICE_KEY],
      listInventory,
    })).resolves.toEqual({
      v: 2,
      bindingsByServiceId: {
        [CODEX_SERVICE_KEY]: {
          source: 'connected',
          selection: 'profile',
          profileId: 'work',
        },
      },
    });
    expect(listInventory).toHaveBeenCalledTimes(1);

    listInventory.mockClear();
    await resolveConnectedServicesLaunchAuthWithInventory({
      intent: parseConnectedServicesLaunchAuth('native'),
      supportedServiceIds: [CODEX_SERVICE_KEY],
      listInventory,
    });
    expect(listInventory).not.toHaveBeenCalled();
  });

  it('uses the configured Connected Services default when direct CLI auth is omitted', async () => {
    const bindings = {
      v: 2 as const,
      bindingsByServiceId: {
        [CODEX_SERVICE_KEY]: { source: 'connected' as const, selection: 'group' as const, groupId: 'team' },
      },
    };
    await expect(resolveCliConnectedServicesLaunchBindings({
      authRaw: undefined,
      authJsonRaw: undefined,
      supportedServiceIds: [CODEX_SERVICE_KEY],
      defaultDisposition: { kind: 'connected', bindings },
      listInventory: async () => {
        throw new Error('inventory should not be read for defaults');
      },
    })).resolves.toEqual(bindings);
  });

  it('lets explicit native auth override a configured connected default', async () => {
    await expect(resolveCliConnectedServicesLaunchBindings({
      authRaw: 'native',
      authJsonRaw: undefined,
      supportedServiceIds: [CODEX_SERVICE_KEY],
      defaultDisposition: {
        kind: 'connected',
        bindings: {
          v: 2,
          bindingsByServiceId: {
            [CODEX_SERVICE_KEY]: {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
      },
      listInventory: vi.fn(),
    })).resolves.toEqual({
      v: 2,
      bindingsByServiceId: {
        [CODEX_SERVICE_KEY]: { source: 'native' },
      },
    });
  });

  it('fails visibly instead of falling back to native when the configured default is invalid', async () => {
    await expect(resolveCliConnectedServicesLaunchBindings({
      authRaw: undefined,
      authJsonRaw: undefined,
      supportedServiceIds: [CODEX_SERVICE_KEY],
      defaultDisposition: {
        kind: 'unavailable',
        reason: 'connected_services_default_settings_invalid',
      },
      listInventory: async () => null,
    })).rejects.toThrow('connected_services_default_unavailable');
  });

  it('rejects structured connected-service auth for an unsupported backend', async () => {
    await expect(resolveCliConnectedServicesLaunchBindings({
      authRaw: undefined,
      authJsonRaw: '{"v":1,"bindingsByServiceId":{"openai-codex":{"source":"native"}}}',
      supportedServiceIds: [],
      defaultDisposition: { kind: 'native' },
      listInventory: vi.fn(),
    })).rejects.toThrow('connected_service_auth_unsupported');
  });
});
