import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';

import { ProviderOperationAbandonedError, createProviderOperationLifetime } from '../operationLifetime';
import {
  PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS,
  createProviderProbeScheduler,
} from '../probe/scheduler';
import {
  collectProviderConnectionDnsEvidence,
  collectProviderConnectionsDnsEvidence,
} from './dnsEvidence';
import type { ProviderContributionRegistryView } from './types';
import { resolveProviderConnectionForMachine } from './resolve';
import { setProviderConnectionGrant } from '../connections/service/grants';
import { assessProviderEndpoint } from '@happier-dev/protocol/providers/safety/url';
import { createProviderConnectionSecurityFingerprintV1, createProviderEndpointSetFingerprintV1 } from '@happier-dev/protocol/providers/securityFingerprintsV1';

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

  it('does not resolve Account-enabled public HTTPS endpoints before Agent launch or semantic resolution', async () => {
    const resolveAddresses = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    const settings = customConnectionSettings();
    const resolution = resolveProviderConnectionForMachine({ connectionId: 'pc_custom', machineId: 'machine-a',
      providerSettings: settings, registry, dnsEvidenceByEndpointUrl: new Map() });
    if (resolution.status !== 'resolved') throw new Error('Expected configured connection');
    const enabled = setProviderConnectionGrant({ settings, connectionId: 'pc_custom', machineId: 'machine-a', scope: 'account',
      enabled: true, connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
      endpointSetFingerprint: resolution.record.endpointSetFingerprint, now: 1 });
    expect(enabled.accountGrants[0]?.connectionSecurityFingerprint).toMatch(/^connection-security:v2:/);
    const evidence = await collectProviderConnectionDnsEvidence({ connectionId: 'pc_custom', machineId: 'machine-a',
      providerSettings: enabled, registry, resolveAddresses,
      lifetime: createProviderOperationLifetime({}),
    });
    expect(evidence).toEqual(new Map());
    expect(resolveAddresses).not.toHaveBeenCalled();
  });

  it.each(['http://localhost:11434/v1', 'https://gateway.example/v1'])('uses modern Machine consent for %s without DNS when Account consent also exists', async url => {
    const base = customConnectionSettings();
    const configured = url.startsWith('http:') ? { ...base, connections: base.connections.map(connection => ({ ...connection,
      endpointOverridesByMachineId: { 'machine-a': [{ endpointTemplateId: 'responses', baseUrl: url }] },
    })) } : base;
    const addresses = url.startsWith('http:') ? ['127.0.0.1'] : ['10.0.0.1'];
    const dns = new Map([[url, addresses]]);
    const resolve = (providerSettings: ProviderSettingsV1) => resolveProviderConnectionForMachine({ connectionId: 'pc_custom',
      machineId: 'machine-a', providerSettings, registry, dnsEvidenceByEndpointUrl: dns });
    const local = resolve(configured);
    if (local.status !== 'resolved') throw new Error('Expected local endpoint');
    const account = setProviderConnectionGrant({ settings: configured, connectionId: 'pc_custom', machineId: 'machine-a',
      scope: 'account', enabled: true, connectionSecurityFingerprint: local.record.connectionSecurityFingerprint,
      endpointSetFingerprint: local.record.endpointSetFingerprint, now: 1 });
    const enabled = setProviderConnectionGrant({ settings: account, connectionId: 'pc_custom', machineId: 'machine-a',
      scope: 'machine', enabled: true, connectionSecurityFingerprint: local.record.connectionSecurityFingerprint,
      endpointSetFingerprint: local.record.endpointSetFingerprint, now: 2 });
    const resolveAddresses = vi.fn(async () => addresses);
    const evidence = await collectProviderConnectionDnsEvidence({ connectionId: 'pc_custom', machineId: 'machine-a',
      providerSettings: enabled, registry, resolveAddresses, lifetime: createProviderOperationLifetime({}),
    });
    expect(evidence).toEqual(new Map());
    expect(resolveAddresses).not.toHaveBeenCalled();
    expect(resolveProviderConnectionForMachine({ connectionId: 'pc_custom', machineId: 'machine-a',
      providerSettings: enabled, registry, dnsEvidenceByEndpointUrl: evidence,
    })).toMatchObject({ status: 'resolved', record: { scope: 'machine', authorization: { authorized: true, grantKind: 'machine' } } });
  });

  it('launches a named-private endpoint with modern Machine-only consent without daemon DNS', async () => {
    const settings = customConnectionSettings();
    const initial = resolveProviderConnectionForMachine({ connectionId: 'pc_custom', machineId: 'machine-a',
      providerSettings: settings, registry, dnsEvidenceByEndpointUrl: new Map([['https://gateway.example/v1', ['10.0.0.1']]]) });
    if (initial.status !== 'resolved') throw new Error('Expected private endpoint');
    const enabled = setProviderConnectionGrant({ settings, connectionId: 'pc_custom', machineId: 'machine-a', scope: 'machine',
      enabled: true, connectionSecurityFingerprint: initial.record.connectionSecurityFingerprint,
      endpointSetFingerprint: initial.record.endpointSetFingerprint, now: 1 });
    expect(enabled.machineGrants[0]?.connectionSecurityFingerprint).toMatch(/^connection-security:v2:/);
    const resolveAddresses = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    const evidence = await collectProviderConnectionDnsEvidence({ connectionId: 'pc_custom', machineId: 'machine-a',
      providerSettings: enabled, registry, resolveAddresses, lifetime: createProviderOperationLifetime({}),
    });
    expect(evidence).toEqual(new Map());
    expect(resolveAddresses).not.toHaveBeenCalled();
    expect(resolveProviderConnectionForMachine({ connectionId: 'pc_custom', machineId: 'machine-a',
      providerSettings: enabled, registry, dnsEvidenceByEndpointUrl: evidence,
    })).toMatchObject({ status: 'resolved', record: { scope: 'machine', authorization: { authorized: true, grantKind: 'machine' } } });
  });

  it('retains the original DNS comparison for an opaque legacy Machine grant', async () => {
    const url = 'https://gateway.example/v1';
    const dns = new Map([[url, ['10.0.0.1']]]);
    const enabled = setProviderConnectionGrant({ settings: customConnectionSettings(), connectionId: 'pc_custom', machineId: 'machine-a',
      scope: 'machine', enabled: true, now: 1,
      connectionSecurityFingerprint: createProviderConnectionSecurityFingerprintV1({ securityContractVersion: 1,
        endpoints: [{ endpointTemplateId: 'responses', protocol: 'openai-responses', url }], catalogProbes: [], credentialTransports: [] }),
      endpointSetFingerprint: createProviderEndpointSetFingerprintV1({ endpoints: [{ endpointTemplateId: 'responses',
        endpoint: assessProviderEndpoint(url, { resolvedAddresses: ['10.0.0.1'] }) }] }),
    });
    const resolveAddresses = vi.fn(async () => ['10.0.0.1']);
    const evidence = await collectProviderConnectionDnsEvidence({ connectionId: 'pc_custom', machineId: 'machine-a',
      providerSettings: enabled, registry, resolveAddresses, lifetime: createProviderOperationLifetime({}),
    });
    expect(evidence).toEqual(dns);
    expect(resolveAddresses).toHaveBeenCalledTimes(1);
    expect(resolveProviderConnectionForMachine({ connectionId: 'pc_custom', machineId: 'machine-a',
      providerSettings: enabled, registry, dnsEvidenceByEndpointUrl: evidence,
    })).toMatchObject({ status: 'resolved', record: { scope: 'machine', authorization: { authorized: true, grantKind: 'machine' } } });
  });

  it('admits only the effective declared family before DNS and ignores overridden lower-layer hosts', async () => {
    const base = customConnectionSettings();
    const original = base.connections[0]!;
    if (original.source.kind !== 'custom') throw new Error('Expected custom source');
    const template = { ...original.source.template, endpointTemplates: original.source.template.endpointTemplates.map(endpoint => ({
      ...endpoint, addressConstraint: { origin: 'https://gateway.example', pathSegments: ['v1', null, 'responses'] },
      baseUrl: 'https://gateway.example/v1/default/responses',
    })) };
    const collect = async (url: string) => {
      const calls: string[] = [];
      const providerSettings = ProviderSettingsV1Schema.parse({ ...base, connections: [{ ...original,
        source: { ...original.source, template },
        endpointOverrides: [{ endpointTemplateId: 'responses', baseUrl: url }],
      }] });
      const evidence = await collectProviderConnectionDnsEvidence({ connectionId: 'pc_custom', machineId: 'machine-a',
        providerSettings, registry, lifetime: createProviderOperationLifetime({}), resolveAddresses: async hostname => { calls.push(hostname); return ['1.1.1.1']; } });
      return { calls, evidence };
    };
    for (const url of ['https://other.example/v1/customer/responses', 'https://gateway.example/v1/customer/messages',
      'https://gateway.example/v1/customer/responses/extra']) {
      expect(await collect(url)).toEqual({ calls: [], evidence: new Map() });
    }
    expect(await collect('https://gateway.example/v1/customer/responses')).toEqual({ calls: ['gateway.example'],
      evidence: new Map([['https://gateway.example/v1/customer/responses', ['1.1.1.1']]]) });
  });

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

  it('retains other connections DNS evidence when a projection collects a source-scoped deadline failure', async () => {
    const base = customConnectionSettings();
    const original = base.connections[0]!;
    if (original.source.kind !== 'custom') throw new Error('Expected custom source');
    const settings = ProviderSettingsV1Schema.parse({ ...base, connections: [original, {
      ...original, id: 'pc_healthy', source: { ...original.source, template: {
        ...original.source.template, endpointTemplates: original.source.template.endpointTemplates.map(endpoint => ({
          ...endpoint, baseUrl: 'https://healthy.example/v1',
        })),
      } },
    }] });
    const failures = new Map<string, unknown>();
    const evidence = await collectProviderConnectionsDnsEvidence({
      connectionIds: settings.connections.map(connection => connection.id), machineId: 'machine-a', providerSettings: settings, registry,
      resolveAddresses: hostname => hostname === 'healthy.example'
        ? Promise.resolve(['1.1.1.1']) : new Promise<readonly string[]>(() => {}),
      lifetime: { wallDeadlineAtMs: Date.now() + 20 },
      onConnectionResolved: (connectionId, { error }) => { if (error) failures.set(connectionId, error); },
    });
    expect(evidence.get('pc_healthy')).toEqual(new Map([['https://healthy.example/v1', ['1.1.1.1']]]));
    expect(failures.size).toBe(1);
    expect(failures.get('pc_custom')).toMatchObject({ reason: 'deadline' });
    expect(evidence.get('pc_custom')).toEqual(new Map());
  });

  it.each([false, true])('abandons resolution when the caller cancels before the resolver answers (partial: %s)', async partial => {
    const controller = new AbortController();
    const collected = collectProviderConnectionDnsEvidence({
      connectionId: 'pc_custom',
      machineId: 'machine-a',
      providerSettings: customConnectionSettings(),
      registry,
      resolveAddresses: () => new Promise<readonly string[]>(() => {}),
      lifetime: { signal: controller.signal, wallDeadlineAtMs: Date.now() + 60_000 },
      ...(partial ? { onConnectionResolved: () => {} } : {}),
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
    const baseSourceTemplate = baseConnection.source.template;
    const providerSettings = ProviderSettingsV1Schema.parse({
      ...base,
      connections: Array.from({ length: 12 }, (_, index) => ({
        ...baseConnection,
        id: `pc_custom_${index}`,
        source: {
          kind: 'custom',
          template: {
            ...baseSourceTemplate,
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
