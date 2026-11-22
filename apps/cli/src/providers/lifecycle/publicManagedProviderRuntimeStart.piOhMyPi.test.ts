import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { resolveProviderBindingCompatibilityWithFingerprintV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ManagedServiceHandle, ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';
import { activate as activateGateway, PLUGIN_MANIFEST as gatewayManifest, CLIPROXYAPI_PROVIDER_CONTRIBUTION as gateway } from '@happier-dev/plugins-cliproxyapi';
import { activate as activatePi, PLUGIN_MANIFEST as piManifest } from '@happier-dev/plugins-pi';
import { activate as activateOhMyPi, PLUGIN_MANIFEST as ohMyPiManifest } from '@happier-dev/plugins-ohmypi';
import { activate as activateOpenCode, PLUGIN_MANIFEST as openCodeManifest } from '@happier-dev/plugins-opencode';
import { createCLIProxyAPIManagedHealthResponse } from '../../../../../packages/plugins/cliproxyapi/src/provider/managedHealth.testkit';
import { createUnavailableManagedServices } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { resolveProviderConnectionForMachine } from '../registry/index';
import { resolveProviderSourceFacts } from '../registry/sourceFacts';
import { createProviderLaunchResourceScope } from './resourceScope';
import { startPublicManagedProviderRuntime } from './publicManagedProviderRuntimeStart';

// Public registrations and the real managed-start owner compose both plugins.
// Only Connected Accounts, process supervision and endpoint access are boundaries.
describe('Muse managed source to native configurations', () => {
  it.each([
    { id: 'pi', manifest: piManifest, activate: activatePi },
    { id: 'ohmypi', manifest: ohMyPiManifest, activate: activateOhMyPi },
    { id: 'opencode', manifest: openCodeManifest, activate: activateOpenCode },
  ])('materializes the public Muse source for $id without upstream auth', async agent => {
    const source = await createPluginTestkit({ manifest: gatewayManifest, module: { activate: activateGateway } });
    const target = await createPluginTestkit({ manifest: agent.manifest, module: { activate: agent.activate } });
    const runtime = source.registration('providers', 'cliproxyapi')?.managedRuntime;
    const adapter = target.registration('agents', agent.id)?.providerBinding;
    expect(adapter, 'selected Provider binding must be registered').toBeDefined();
    if (!adapter || !runtime) throw new Error('Public registration missing');
    const purpose = gateway.connectedAccounts.find(row => row.service.pluginId === 'happier.agent.muse');
    if (!purpose) throw new Error('Public Muse source missing');
    const endpoint = gateway.endpointTemplates.find(row => row.protocol === 'openai-responses' && purpose.endpointTemplateIds.includes(row.id));
    const model = purpose.staticModels[0];
    if (!endpoint || !model) throw new Error('Public Muse model or Responses endpoint missing');
    const contributionKey = `${gatewayManifest.id}/${gateway.id}`;
    const connectionId = ProviderConnectionIdSchema.parse('pc_managed_muse');
    const contribution = { identity: { pluginId: gatewayManifest.id, localId: gateway.id },
      pluginId: gatewayManifest.id, provenance: 'external', source: { kind: 'path' }, definition: gateway,
    } as const satisfies ResolvedProviderContribution;
    const resolved = resolveProviderConnectionForMachine({ connectionId, machineId: 'fixture-machine',
      providerSettings: { ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{ v: 1, id: connectionId,
        source: { kind: 'contribution', contributionKey }, deployment: { kind: 'managedLocal' },
        purposeBindingDefaults: { [purpose.purpose]: { kind: 'account',
          account: { service: purpose.service, accountId: 'fake-muse-account' } } },
        role: 'default', displayName: 'Muse gateway', displayNameMode: 'automatic',
        revision: 0, createdAt: 1, updatedAt: 1 }] },
      registry: { providersByContributionKey: new Map([[contributionKey, contribution]]) },
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (resolved.status !== 'resolved') throw new Error(`Managed source resolution failed: ${resolved.status}${'reason' in resolved ? `/${resolved.reason}` : ''}`);
    const facts = resolveProviderSourceFacts(resolved.record);
    const requirements = agent.manifest.contributes.agents?.[0]?.providerRequirements;
    if (!requirements) throw new Error('Public Agent requirements missing');
    const admission = resolveProviderBindingCompatibilityWithFingerprintV1({
      agentTargetKey: `${agent.manifest.id}/${agent.id}`, adapterVersion: adapter.adapterVersion,
      agent: requirements, endpoints: facts.endpointTemplates, credential: facts.credential, model,
    });
    expect(admission.result.status).not.toBe('incompatible');
    const accounts = { getBinding: async (id: string) => id === purpose.purpose ? {
      purpose: id, service: purpose.service, account: { service: purpose.service, accountId: 'fake-muse-account' },
      target: { kind: 'account' as const, displayName: 'Muse' },
    } : null,
      async requestSelection() { throw new Error('Selection is unavailable during admitted managed start'); },
      async materialize() { throw new Error('Credential materialization is unavailable during managed start'); },
      async listAccounts() { throw new Error('Account inventory is unavailable during managed start'); },
      async materializeListedAccount() { throw new Error('Listed credentials are unavailable during managed start'); },
      watch() { return { dispose() {} }; },
    } satisfies ConnectedAccountsService;
    let launch: ManagedServiceSpec | undefined;
    const snapshot = { id: 'cliproxyapi-managed', state: 'healthy' as const, mode: 'spawn' as const, baseUrl: 'http://127.0.0.1:45123', startedAtMs: 1, lastHealthyAtMs: 2, diagnostics: [], diagnosticsTruncated: false };
    const service = { snapshot: () => snapshot, observe: () => ({ dispose() {} }), waitUntilHealthy: async () => snapshot,
      request: async () => createCLIProxyAPIManagedHealthResponse(launch), stop: async () => ({ status: 'stopped' as const }), dispose: async () => undefined } satisfies ManagedServiceHandle;
    const scope = createProviderLaunchResourceScope();
    try {
      const started = await startPublicManagedProviderRuntime({
        identity: { pluginId: gatewayManifest.id, localId: gateway.id },
        request: { reason: 'explicitStartLocal', endpointTemplateIds: [endpoint.id] },
        acquireRuntime: async () => ({ runtime, activationOccurrenceId: 'fixture-gateway', sourceCustody: createManagedPluginSourceCustody('fixture-gateway'), isCurrent: () => true }),
        connectedAccounts: accounts,
        custody: { managedServices: { ...createUnavailableManagedServices(),
          supervise: async spec => { launch = spec; return service; } },
          projectEndpointAccess: async ({ endpoints }) => ({ access: endpoints, isCurrent: () => true }), },
        isAuthorizationCurrent: () => true, revalidateAuthorization: async () => true,
        signal: new AbortController().signal, launchResourceScope: scope,
      });
      expect(started).toMatchObject({ ok: true, access: [{ endpointTemplateId: endpoint.id, servicePath: '/v1' }] });
      if (!started.ok) throw new Error('Managed source failed');
      const normalizedUrl = snapshot.baseUrl + started.access[0]!.servicePath;
      const transport = gateway.credential.transports[0]!;
      const materialized = await adapter.materialize({ v: 1,
        prepared: adapter.prepare({ v: 1, agentTargetKey: 'agent-target', connectionId: 'managed-muse', model }),
        binding: { v: 1, agentTargetKey: 'agent-target', contributionKey,
          selection: { connectionId: 'managed-muse', model }, endpoint: { endpointTemplateId: endpoint.id, protocol: endpoint.protocol, normalizedUrl, publicHeaders: {} },
          runtimeCredentialTransport: transport, compatibilityFingerprint: admission.compatibilityFingerprint },
        credential: { kind: 'apiKey', transport, value: 'fake-downstream-bearer' },
      });
      expect(materialized).toMatchObject({ kind: 'configFile' });
      if (agent.id !== 'opencode') expect(materialized).toMatchObject({ nativeHome: true });
      if (materialized.kind !== 'configFile') throw new Error('Native config missing');
      expect(materialized.files[0]!.utf8).not.toContain('fake-downstream-bearer');
      expect(materialized.env.some(entry => entry.value === 'fake-downstream-bearer')).toBe(true);
      if (agent.id === 'pi') {
        expect(JSON.parse(materialized.files[0]!.utf8).providers['happier-provider']).toMatchObject({ api: endpoint.protocol, baseUrl: normalizedUrl, models: [{ id: model.id }] });
      } else if (agent.id === 'ohmypi') {
        const registerProvider = vi.fn();
        const extension = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(materialized.files[0]!.utf8).toString('base64')}`);
        extension.default({ registerProvider });
        expect(registerProvider).toHaveBeenCalledWith('happier-provider', expect.objectContaining({ api: endpoint.protocol, baseUrl: normalizedUrl, models: [expect.objectContaining({ id: model.id })] }));
      } else {
        const native = JSON.parse(materialized.files[0]!.utf8);
        const [providerId, ...modelId] = native.model.split('/');
        expect(modelId.join('/')).toBe(model.id);
        expect(native.provider[providerId]).toMatchObject({
          npm: '@ai-sdk/openai',
          options: { baseURL: normalizedUrl, apiKey: '{env:HAPPIER_OPENCODE_PROVIDER_API_KEY}' },
          models: { [model.id]: { name: model.name } },
        });
      }
    } finally { await scope.release(); await source.dispose(); await target.dispose(); }
  });
});
