import { describe, expect, it, vi } from 'vitest';

import {
  parseConnectedServicesLaunchAuth,
  resolveCliConnectedServicesLaunchBindings,
  resolveConnectedServicesLaunchAuth,
  resolveConnectedServicesLaunchAuthWithInventory,
} from './connectedServicesLaunchAuth';

const codexInventory = {
  supportedServiceIds: ['openai-codex'],
  profileOptionsByServiceId: {
    'openai-codex': [{ profileId: 'work', status: 'connected' }],
  },
  groupOptionsByServiceId: {
    'openai-codex': [{ groupId: 'team' }],
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
    expect(parseConnectedServicesLaunchAuth('cs:openai-codex:group:team')).toEqual({
      kind: 'connected',
      id: 'team',
      selection: 'group',
      serviceId: 'openai-codex',
    });
  });

  it('resolves the exact id through the evolved inventory shape', () => {
    expect(resolveConnectedServicesLaunchAuth({
      intent: parseConnectedServicesLaunchAuth('cs:work'),
      supportedServiceIds: ['openai-codex'],
      inventory: codexInventory,
    })).toEqual({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
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
      supportedServiceIds: ['openai-codex'],
      inventory: codexInventory,
    })).toThrow('connected_service_auth_not_found:cs:missing');
  });

  it('reports qualified alternatives when an exact id is ambiguous', () => {
    expect(() => resolveConnectedServicesLaunchAuth({
      intent: parseConnectedServicesLaunchAuth('cs:same'),
      supportedServiceIds: ['openai-codex'],
      inventory: {
        supportedServiceIds: ['openai-codex'],
        profileOptionsByServiceId: {
          'openai-codex': [{ profileId: 'same', status: 'connected' }],
        },
        groupOptionsByServiceId: {
          'openai-codex': [{ groupId: 'same' }],
        },
      },
    })).toThrow(
      'connected_service_auth_ambiguous:cs:openai-codex:profile:same,cs:openai-codex:group:same',
    );
  });

  it('consults the canonical inventory only for an explicit connected selector', async () => {
    const listInventory = vi.fn(async () => codexInventory);

    await expect(resolveConnectedServicesLaunchAuthWithInventory({
      intent: parseConnectedServicesLaunchAuth('cs:work'),
      supportedServiceIds: ['openai-codex'],
      listInventory,
    })).resolves.toEqual({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
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
      supportedServiceIds: ['openai-codex'],
      listInventory,
    });
    expect(listInventory).not.toHaveBeenCalled();
  });

  it('uses the configured Connected Services default when direct CLI auth is omitted', async () => {
    const bindings = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected' as const, selection: 'group' as const, groupId: 'team' },
      },
    };
    await expect(resolveCliConnectedServicesLaunchBindings({
      authRaw: undefined,
      authJsonRaw: undefined,
      supportedServiceIds: ['openai-codex'],
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
      supportedServiceIds: ['openai-codex'],
      defaultDisposition: {
        kind: 'connected',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
      },
      listInventory: vi.fn(),
    })).resolves.toEqual({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'native' },
      },
    });
  });

  it('fails visibly instead of falling back to native when the configured default is invalid', async () => {
    await expect(resolveCliConnectedServicesLaunchBindings({
      authRaw: undefined,
      authJsonRaw: undefined,
      supportedServiceIds: ['openai-codex'],
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
