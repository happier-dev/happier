import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';

import { ProviderOperationAbandonedError } from '../operationLifetime';
import {
  PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS,
  createProviderProbeScheduler,
} from '../probe/scheduler';
import {
  collectProviderConnectionDnsEvidence,
  collectProviderConnectionsDnsEvidence,
} from './dnsEvidence';
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

  it('resolves each hostname once, bounds active lookups, and projects evidence to every connection URL', async () => {
    const base = customConnectionSettings();
    const baseConnection = base.connections[0]!;
    if (baseConnection.source.kind !== 'custom') throw new Error('Expected custom fixture');
    const providerSettings = ProviderSettingsV1Schema.parse({
      ...base,
      connections: Array.from({ length: 12 }, (_, index) => ({
        ...baseConnection,
        id: `pc_custom_${index}`,
        source: {
          kind: 'custom',
          template: {
            ...baseConnection.source.template,
            v: 1,
            name: `Custom ${index}`,
            endpointTemplates: [{
              id: 'responses',
              protocol: 'openai-responses',
              baseUrl: index < 6
                ? `https://shared.example/v${index}`
                : `https://unique-${index}.example/v1`,
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
      })),
    });
    let active = 0;
    let peak = 0;
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    const resolveAddresses = vi.fn(async (hostname: string) => {
      calls.push(hostname);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return ['1.1.1.1'];
    });

    const collected = collectProviderConnectionsDnsEvidence({
      connectionIds: providerSettings.connections.map((connection) => connection.id),
      machineId: 'machine-a',
      providerSettings,
      registry,
      resolveAddresses,
      lifetime: { wallDeadlineAtMs: Date.now() + 60_000 },
    });

    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    while (releases.length > 0 || active > 0) {
      for (const release of releases.splice(0)) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const evidenceByConnectionId = await collected;

    expect(calls.filter((hostname) => hostname === 'shared.example')).toHaveLength(1);
    expect(new Set(calls).size).toBe(calls.length);
    expect(peak).toBeLessThanOrEqual(
      PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS,
    );
    for (const connection of providerSettings.connections) {
      expect(evidenceByConnectionId.get(connection.id)?.size).toBe(1);
    }
  });

  it('does not admit another hostname after the operation is abandoned', async () => {
    const base = customConnectionSettings();
    const baseConnection = base.connections[0]!;
    const providerSettings = ProviderSettingsV1Schema.parse({
      ...base,
      connections: Array.from({ length: 10 }, (_, index) => ({
        ...baseConnection,
        id: `pc_cancel_${index}`,
        source: {
          kind: 'custom',
          template: {
            v: 1,
            name: `Cancel ${index}`,
            endpointTemplates: [{
              id: 'responses',
              protocol: 'openai-responses',
              baseUrl: `https://cancel-${index}.example/v1`,
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
      })),
    });
    const controller = new AbortController();
    const scheduler = createProviderProbeScheduler();
    const calls: string[] = [];
    const collected = collectProviderConnectionsDnsEvidence({
      connectionIds: providerSettings.connections.map((connection) => connection.id),
      machineId: 'machine-a',
      providerSettings,
      registry,
      resolveAddresses: async (hostname) => {
        calls.push(hostname);
        controller.abort();
        return ['1.1.1.1'];
      },
      admitResolution: scheduler.runDns,
      lifetime: { signal: controller.signal, wallDeadlineAtMs: Date.now() + 60_000 },
    });

    await expect(collected).rejects.toMatchObject({ reason: 'cancelled' });
    expect(calls.length).toBeLessThanOrEqual(
      PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS,
    );
    const callsAtSettlement = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(callsAtSettlement);
  });
});
