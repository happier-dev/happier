import { describe, expect, it } from 'vitest';
import {
  readBuiltInLegacyConnectedAccountServiceKeyIngress,
  type AccountProfile,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import { createConnectedServiceBindingAuthorityFingerprint } from './connectedServiceBindingAuthority';

const CODEX_SERVICE_KEY = readBuiltInLegacyConnectedAccountServiceKeyIngress('openai-codex')!;

function bindings(
  binding: ConnectedServiceBindingsV1['bindingsByServiceId'][string],
): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      [CODEX_SERVICE_KEY]: binding,
    },
  };
}

function services(params?: Readonly<{
  activeProfileId?: string | null;
  generation?: number;
  primaryStatus?: 'connected' | 'refreshing' | 'needs_reauth' | 'refresh_failed_retryable';
}>): AccountProfile['connectedServicesV2'] {
  return [{
    serviceId: 'openai-codex',
    profiles: [
      {
        profileId: 'primary',
        status: params?.primaryStatus ?? 'connected',
        kind: 'oauth',
        providerEmail: null,
        providerAccountId: null,
        expiresAt: null,
        lastUsedAt: null,
        health: null,
      },
      {
        profileId: 'backup',
        status: 'connected',
        kind: 'oauth',
        providerEmail: null,
        providerAccountId: null,
        expiresAt: null,
        lastUsedAt: null,
        health: null,
      },
    ],
    groups: [{
      groupId: 'voice-pool',
      displayName: 'Voice pool',
      activeProfileId: params?.activeProfileId ?? 'primary',
      generation: params?.generation ?? 1,
      memberProfileIds: ['primary', 'backup'],
    }],
  }];
}

describe('createConnectedServiceBindingAuthorityFingerprint', () => {
  it('tracks only the selected profile authority and ignores unrelated projection churn', () => {
    const selected = bindings({
      source: 'connected',
      selection: 'profile',
      profileId: 'primary',
    });
    const initial = createConnectedServiceBindingAuthorityFingerprint({
      bindings: selected,
      connectedServices: services(),
    });
    const clonedWithUnrelatedService = createConnectedServiceBindingAuthorityFingerprint({
      bindings: structuredClone(selected),
      connectedServices: [
        {
          serviceId: 'openai',
          profiles: [{
            profileId: 'unrelated',
            status: 'needs_reauth',
            kind: 'token',
            providerEmail: null,
            providerAccountId: null,
            expiresAt: null,
            lastUsedAt: null,
            health: null,
          }],
          groups: [],
        },
        ...structuredClone(services()),
      ],
    });

    expect(clonedWithUnrelatedService).toBe(initial);
    expect(createConnectedServiceBindingAuthorityFingerprint({
      bindings: bindings({
        source: 'connected',
        selection: 'profile',
        profileId: 'backup',
      }),
      connectedServices: services(),
    })).not.toBe(initial);
    expect(createConnectedServiceBindingAuthorityFingerprint({
      bindings: selected,
      connectedServices: services({ primaryStatus: 'needs_reauth' }),
    })).not.toBe(initial);
  });

  it('tracks group generation, active profile, and active-profile health', () => {
    const selected = bindings({
      source: 'connected',
      selection: 'group',
      groupId: 'voice-pool',
    });
    const initial = createConnectedServiceBindingAuthorityFingerprint({
      bindings: selected,
      connectedServices: services(),
    });

    expect(createConnectedServiceBindingAuthorityFingerprint({
      bindings: selected,
      connectedServices: services({ generation: 2 }),
    })).not.toBe(initial);
    expect(createConnectedServiceBindingAuthorityFingerprint({
      bindings: selected,
      connectedServices: services({ activeProfileId: 'backup' }),
    })).not.toBe(initial);
    expect(createConnectedServiceBindingAuthorityFingerprint({
      bindings: selected,
      connectedServices: services({ primaryStatus: 'needs_reauth' }),
    })).not.toBe(initial);
  });

  it('distinguishes connected and native binding authority without borrowing account rows', () => {
    const connected = createConnectedServiceBindingAuthorityFingerprint({
      bindings: bindings({
        source: 'connected',
        selection: 'profile',
        profileId: 'primary',
      }),
      connectedServices: services(),
    });
    const native = createConnectedServiceBindingAuthorityFingerprint({
      bindings: bindings({ source: 'native' }),
      connectedServices: services(),
    });
    const nativeWithoutProjection = createConnectedServiceBindingAuthorityFingerprint({
      bindings: bindings({ source: 'native' }),
      connectedServices: [],
    });

    expect(native).not.toBe(connected);
    expect(nativeWithoutProjection).toBe(native);
    expect(createConnectedServiceBindingAuthorityFingerprint({
      bindings: null,
      connectedServices: services(),
    })).toBe('unbound');
  });
});
