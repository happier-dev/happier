import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';

import { ProviderOperationAbandonedError } from '../operationLifetime';
import { collectProviderConnectionDnsEvidence } from './dnsEvidence';
import type { ProviderContributionRegistryView } from './types';

function customConnectionSettings(): ProviderSettingsV1 {
  return ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1,
      id: 'pc_custom',
      source: {
        kind: 'custom',
        template: {
          v: 1,
          name: 'Custom',
          endpointTemplates: [{
            id: 'responses',
            protocol: 'openai-responses',
            baseUrl: 'https://gateway.example/v1',
            capabilities: {
              streaming: 'unknown',
              toolRoundTrips: 'unknown',
              statefulResponses: 'unknown',
              reasoningControls: 'unknown',
            },
          }],
          catalog: { source: 'manual', manualModelPolicy: 'allowed' },
        },
      },
      role: 'named',
      displayName: 'Custom',
      displayNameMode: 'custom',
      deployment: { kind: 'external' },
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
    }],
  });
}

describe('provider connection DNS evidence', () => {
  const registry = { providersByContributionKey: new Map() };

  it('abandons a resolver that never settles once the operation budget is spent', async () => {
    const collected = collectProviderConnectionDnsEvidence({
      connectionId: 'pc_custom',
      machineId: 'machine-a',
      providerSettings: customConnectionSettings(),
      registry,
      // A resolver the host cannot abort: `node:dns` has no signal, so without
      // the operation budget this await never settles and the caller — an RPC
      // promise or an admitted scheduler slot — is held open forever.
      resolveAddresses: () => new Promise<readonly string[]>(() => {}),
      lifetime: { wallDeadlineAtMs: Date.now() + 20 },
    });

    await expect(collected).rejects.toBeInstanceOf(ProviderOperationAbandonedError);
  });

  it('abandons resolution when the caller cancels before the resolver answers', async () => {
    const controller = new AbortController();
    const collected = collectProviderConnectionDnsEvidence({
      connectionId: 'pc_custom',
      machineId: 'machine-a',
      providerSettings: customConnectionSettings(),
      registry,
      resolveAddresses: () => new Promise<readonly string[]>(() => {}),
      lifetime: { signal: controller.signal, wallDeadlineAtMs: Date.now() + 60_000 },
    });
    controller.abort();

    await expect(collected).rejects.toMatchObject({ reason: 'cancelled' });
  });

  it('keeps an ordinary resolver failure as absent evidence rather than abandoning', async () => {
    await expect(collectProviderConnectionDnsEvidence({
      connectionId: 'pc_custom',
      machineId: 'machine-a',
      providerSettings: customConnectionSettings(),
      registry,
      resolveAddresses: async () => { throw new Error('ENOTFOUND'); },
      lifetime: { wallDeadlineAtMs: Date.now() + 60_000 },
    })).resolves.toEqual(new Map());
  });

  it('returns resolved addresses within the budget', async () => {
    await expect(collectProviderConnectionDnsEvidence({
      connectionId: 'pc_custom',
      machineId: 'machine-a',
      providerSettings: customConnectionSettings(),
      registry,
      resolveAddresses: async () => ['1.1.1.1'],
      lifetime: { wallDeadlineAtMs: Date.now() + 60_000 },
    })).resolves.toEqual(new Map([['https://gateway.example/v1', ['1.1.1.1']]]));
  });

  it('does not resolve declaration URLs for a managed-local connection', async () => {
    const resolveAddresses = vi.fn(async () => ['203.0.113.1']);
    const providerSettings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: 'pc_managed',
        source: { kind: 'contribution', contributionKey: 'acme.gateway/gateway' },
        role: 'named',
        displayName: 'Managed Gateway',
        displayNameMode: 'custom',
        deployment: { kind: 'managedLocal' },
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    const contribution: ResolvedProviderContribution = {
      provenance: 'external',
      source: { kind: 'path' },
      pluginId: 'acme.gateway',
      identity: { pluginId: 'acme.gateway', localId: 'gateway' },
      definition: ProviderContributionV1Schema.parse({
        v: 1,
        id: 'gateway',
        name: 'Gateway',
        kind: 'cloud',
        endpointTemplates: [{
          id: 'responses',
          protocol: 'openai-responses',
          baseUrl: 'https://declared.example/v1',
          capabilities: {
            streaming: 'unknown',
            toolRoundTrips: 'unknown',
            statefulResponses: 'unknown',
            reasoningControls: 'unknown',
          },
        }],
        catalog: { source: 'manual', manualModelPolicy: 'allowed' },
        managedRuntime: {
          kind: 'managed',
          endpointTemplateIds: ['responses'],
        },
      }),
    };
    const managedRegistry: ProviderContributionRegistryView = {
      providersByContributionKey: new Map([['acme.gateway/gateway', contribution]]),
    };

    await expect(collectProviderConnectionDnsEvidence({
      connectionId: 'pc_managed',
      machineId: 'machine-a',
      providerSettings,
      registry: managedRegistry,
      resolveAddresses,
      lifetime: { wallDeadlineAtMs: Date.now() + 60_000 },
    })).resolves.toEqual(new Map());
    expect(resolveAddresses).not.toHaveBeenCalled();
  });
});
