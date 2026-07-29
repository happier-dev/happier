import { describe, expect, it } from 'vitest';

import {
  ConnectedAccountPurposeDeclarationsV1Schema,
  ConnectedAccountRequestAuthUsesV1Schema,
  ManagedProviderEndpointSecurityFactsV1Schema,
} from '@happier-dev/protocol';

import {
  MANAGED_PROVIDER_IMPLEMENTATION,
  MANAGED_PROVIDER_RUNTIME_ADAPTER,
} from './managed.js';

describe('CLIProxyAPI host-private managed implementation', () => {
  it('declares one packaged mixed-family endpoint whose upstream purposes can be bound independently', () => {
    expect(MANAGED_PROVIDER_IMPLEMENTATION).toMatchObject({
      v: 1,
      providerLocalId: 'cliproxyapi',
      facet: {
        managedEndpoint: {
          localService: {
            launch: {
              kind: 'packaged-runtime-binary',
              directorySegments: ['tools', 'unpacked'],
              executableBaseName: 'happier-cliproxyapi-managed',
              privateConfigPathFlag: '--config',
            },
          },
          protocols: ['openai-chat', 'openai-responses', 'anthropic'],
        },
        connectedAccounts: [{
          purpose: 'openai-upstream',
          service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
          },
          required: false,
          materializationKinds: ['httpHeaders'],
        }, {
          purpose: 'anthropic-upstream',
          service: {
            pluginId: 'happier.agent.claude',
            localId: 'claude-subscription',
          },
          required: false,
          materializationKinds: ['httpHeaders'],
        }],
        requestAuthUses: [{
          purpose: 'openai-upstream',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://chatgpt.com',
            headerNames: ['authorization', 'chatgpt-account-id'],
          },
        }, {
          purpose: 'anthropic-upstream',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.anthropic.com',
            headerNames: ['authorization'],
          },
        }],
      },
    });
    expect(ManagedProviderEndpointSecurityFactsV1Schema.safeParse(
      MANAGED_PROVIDER_IMPLEMENTATION.facet.managedEndpoint,
    ).success).toBe(true);
    expect(ConnectedAccountPurposeDeclarationsV1Schema.safeParse(
      MANAGED_PROVIDER_IMPLEMENTATION.facet.connectedAccounts,
    ).success).toBe(true);
    expect(ConnectedAccountRequestAuthUsesV1Schema.safeParse(
      MANAGED_PROVIDER_IMPLEMENTATION.facet.requestAuthUses,
    ).success).toBe(true);
    expect(MANAGED_PROVIDER_RUNTIME_ADAPTER).toMatchObject({
      v: 1,
      prepare: expect.any(Function),
    });
  });
});
