import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createManagedRunLaunchFixture } from './managedRunLaunch.testkit';
import { prepareProviderLaunch } from './prepareLaunch';
import { projectConnectedAccountCatalog } from '@/providers/modelManagement/connectedAccountCatalog';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { getProviderContribution } from '@/providers/registry/lookup';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import { prepareDaemonProviderLaunch } from '@/daemon/spawn/prepareDaemonProviderLaunch';
import { prepareDaemonSpawnChildEnvironment } from '@/daemon/spawn/prepareDaemonSpawnChildEnvironment';
import { createProviderLaunchResourceScope } from './resourceScope';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { serializeProviderBindingLaunchHandoffForEnv, consumeProviderBindingLaunchHandoffFromEnvironments,
  HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY } from '@/plugins/runtime/providerBindings/handoff';
const service = { pluginId: 'acme.shared-registry', localId: 'accounts' };
const provider = { pluginId: 'acme.shared-registry', localId: 'gateway' };
describe('Agent managed Connected Account purpose launch', () => {
  it('keeps unbound native Session admission independent of Provider feature acquisition', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'purpose-native-' }, async ({ homeDir }) => {
      const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir });
      const resources = createProviderLaunchResourceScope();
      try {
        const backendTarget = { kind: 'backend' as const, backendId: fixture.agentId };
        const result = await prepareDaemonProviderLaunch({ options: { directory: homeDir, backendTarget },
          effectiveBackendTarget: backendTarget, catalogAgentId: fixture.agentId,
          profileEnvironmentVariables: {}, daemonSpawnHooks: null, persistedProviderBinding: null,
          normalizedExistingSessionId: '', processEnv: {}, pluginRuntimeLease: {
            currentRegistry: fixture.lease.registry, acquire: async () => fixture.lease, release: async () => {} },
          launchResourceScope: resources,
          resolveProvidersFeatureEnabled: () => { throw new Error('Native launch must not acquire Provider features'); } });
        expect(result).toMatchObject({ ok: true, attempt: null });
      } finally { await resources.retire(); await fixture.cleanup(); }
    });
  });
  it('carries a committed Session source through real daemon admission and late child materialization', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'purpose-daemon-' }, async ({ homeDir }) => {
      const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
        controller: pluginReloadController, physicalGateway: true, connectedAccountModels: [{ id: 'example', name: 'Example' }],
        connectedAccounts: [{ purpose: 'inference', service, materializationKinds: ['httpHeaders'],
          managedProviderEndpoint: { provider, purpose: 'upstream', modelIdPrefix: 'native/' } }] });
      const resources = createProviderLaunchResourceScope();
      const redaction = createProviderRedactionLease({ values: [] });
      const backendTarget = { kind: 'backend' as const, backendId: fixture.agentId };
      const selection = { v: 1 as const, updatedAt: 1, ref: {
        agentTargetKey: fixture.agentTargetKey, providerConnectionId: null, modelId: 'native/example' } };
      try {
        const prepared = await prepareDaemonProviderLaunch({
          options: { directory: homeDir, backendTarget, machineId: fixture.machineId,
            connectedServices: { v: 2, bindingsByServiceId: { 'acme.shared-registry/accounts': { source: 'connected', profileId: 'upstream-account' } } } },
          effectiveBackendTarget: backendTarget, catalogAgentId: fixture.agentId, modelSelection: selection,
          profileEnvironmentVariables: {}, daemonSpawnHooks: null, persistedProviderBinding: null,
          normalizedExistingSessionId: '', processEnv: {}, accountSettingsSnapshot: fixture.snapshot,
          providerRuntimeHomeDir: homeDir, resolveProvidersFeatureEnabled: () => true,
          resolveManagedPurposeBindingIntentSelection: fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection,
          pluginRuntimeLease: { currentRegistry: fixture.lease.registry, acquire: async () => fixture.lease, release: async () => {} },
          launchResourceScope: resources });
        expect(prepared).toMatchObject({ ok: true, managedPurpose: { kind: 'managedPurpose' }, attempt: null });
        if (!prepared.ok || !prepared.managedPurpose) throw new Error('Expected declared source admission');
        await expect(readFile(join(homeDir, 'fixture', 'gateway-starts'))).rejects.toMatchObject({ code: 'ENOENT' });
        const child = await prepareDaemonSpawnChildEnvironment({
          options: { ...prepared.options, existingSessionId: 'committed-source-session' },
          effectiveModelSelection: selection, terminal: undefined, resolvedAgentId: fixture.agentId,
          profileEnvironmentVariables: {}, daemonSpawnHooks: null, pluginRuntimeRegistry: fixture.lease.registry,
          processEnv: {}, connectedServiceAuth: null, connectedServiceMaterializationIdentity: null,
          providerBindingAttempt: null, managedPurpose: prepared.managedPurpose,
          providerAgentTargetKey: prepared.agentTargetKey, providerDiagnosticRedactionLease: redaction,
          launchResourceScope: resources });
        expect(child).toMatchObject({ ok: true });
        if (!child.ok) throw new Error(JSON.stringify(child.result));
        const handoff = child.spawnEnvironment.providerBindingLaunchHandoff;
        if (!handoff) throw new Error('Expected source handoff from late materialization');
        const environment = { [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]: serializeProviderBindingLaunchHandoffForEnv(handoff) };
        const consumed = consumeProviderBindingLaunchHandoffFromEnvironments([environment]);
        expect(consumed).toMatchObject({ selection: selection.ref,
          providerBinding: { source: { kind: 'connected_account', account: { service, accountId: 'upstream-account' } }, model: { id: 'example' } } });
        expect(environment).toEqual({});
        const endpoint = child.extraEnvForChild.RUN_PROVIDER_URL;
        const response = await fetch(endpoint + '/responses', { method: 'POST', headers: {
          authorization: 'Bearer ' + child.extraEnvForChild.RUN_PROVIDER_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ model: consumed!.providerBinding!.model.id, input: 'committed Session source' }) });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('ok');
        expect((await readFile(join(homeDir, 'fixture', 'gateway-inputs'), 'utf8')).trim()).toBe('committed Session source');
        await resources.retire();
        await expect(fetch(endpoint)).rejects.toThrow();
      } finally { await resources.retire(); redaction.close(); await fixture.cleanup(); }
    });
  });
  it('refuses a managed source selected for a mismatched Agent target', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'purpose-target-' }, async ({ homeDir }) => {
      const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
        physicalGateway: true, connectedAccountModels: [{ id: 'example', name: 'Example' }],
        connectedAccounts: [{ purpose: 'inference', service, materializationKinds: ['httpHeaders'],
          managedProviderEndpoint: { provider, purpose: 'upstream', modelIdPrefix: 'native/' } }] });
      try {
        const result = await prepareProviderLaunch({
          selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:acme.other/agent', providerConnectionId: null, modelId: 'native/example' } },
          backendTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
          machineId: fixture.machineId, agentId: fixture.agentId, previousBinding: null, confirmation: null,
          connectedServices: { v: 2, bindingsByServiceId: { 'acme.shared-registry/accounts': { source: 'connected', profileId: 'upstream-account' } } },
          featureEnabled: true, resolvePrerequisites: async () => ({ ok: true }),
          createAuthorizationAttempt: async () => { throw new Error('Saved connection path'); },
          managedPurposeContext: { lease: fixture.lease, happyHomeDir: homeDir,
            resolveManagedPurposeBindingIntentSelection: fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection },
        });
        expect(result).toMatchObject({ ok: false, error: { code: 'provider_incompatible_with_agent' } });
      } finally { await fixture.cleanup(); }
    });
  });
  it('refuses an explicit experimental source until its exact catalog source is confirmed', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'purpose-consent-' }, async ({ homeDir }) => {
      const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
        physicalGateway: true, experimental: true, connectedAccountModels: [{ id: 'example', name: 'Example' }],
        connectedAccounts: [{ purpose: 'inference', service, materializationKinds: ['httpHeaders'],
          managedProviderEndpoint: { provider, purpose: 'upstream', modelIdPrefix: 'native/' } }] });
      let cleanup: (() => Promise<void>) | undefined;
      try {
        const registry = resolveProviderContributionRegistryView(fixture.lease.registry.contributes, undefined);
        const implementation = getProviderContribution(registry, 'acme.shared-registry/gateway');
        const adapter = readLeasedAgentProviderBindingAdapter({ lease: fixture.lease, agentId: fixture.agentId });
        if (!implementation || !adapter) throw new Error('Missing real catalog fixture declarations');
        const projected = await projectConnectedAccountCatalog({ registry, provider: implementation, purpose: 'upstream',
          request: { machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, includeDirectMaterialization: true,
            connectedAccountTarget: { kind: 'account', account: { service, accountId: 'upstream-account' } } },
          support: adapter.support, adapterVersion: adapter.adapter.adapterVersion,
          providerSettings: fixture.providerSettings,
          resolveSelection: fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection });
        const row = projected.groups.flatMap(group => group.rows).find(row => row.descriptor.id === 'example');
        if (!row?.confirmationSource || row.compatibility.result.status !== 'experimental') {
          throw new Error('Expected a projected experimental source with its confirmation identity');
        }
        let settings = fixture.providerSettings;
        const launch = () => prepareProviderLaunch({
          selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: null, modelId: 'native/example' } },
          backendTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
          machineId: fixture.machineId, agentId: fixture.agentId, previousBinding: null, confirmation: null,
          connectedServices: { v: 2, bindingsByServiceId: { 'acme.shared-registry/accounts': { source: 'connected', profileId: 'upstream-account' } } },
          featureEnabled: true, resolvePrerequisites: async () => ({ ok: true }),
          createAuthorizationAttempt: async () => { throw new Error('Saved connection path'); },
          managedPurposeContext: { lease: fixture.lease, happyHomeDir: homeDir, readProviderSettings: () => settings,
            resolveManagedPurposeBindingIntentSelection: fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection },
        });
        expect(await launch()).toMatchObject({ ok: false, error: { code: 'provider_compatibility_unverified' } });
        settings = { ...settings, experimentalBindingConfirmations: [{ v: 1, ...row.confirmationSource,
          agentTargetKey: fixture.agentTargetKey,
          modelId: row.compatibility.result.confirmationScope.kind === 'model' ? row.descriptor.id : null,
          compatibilityFingerprint: row.compatibility.compatibilityFingerprint, confirmedAt: 2 }] };
        const confirmed = await launch();
        expect(confirmed).toMatchObject({ ok: true, kind: 'managedPurpose' });
        if (!confirmed.ok || confirmed.kind !== 'managedPurpose') throw new Error('Expected confirmed source admission');
        const materialized = await confirmed.materialize({ kind: 'session', sessionId: 'confirmed-source-session' });
        expect(materialized).toMatchObject({ ok: true, providerBinding: {
          source: { kind: 'connected_account', account: { service, accountId: 'upstream-account' } }, model: { id: 'example' } } });
        if (!materialized.ok) throw new Error(JSON.stringify(materialized.error));
        cleanup = materialized.cleanup;
      } finally { await cleanup?.(); await fixture.cleanup(); }
    });
  });
  it.each(['session', 'execution_run'] as const)('admits %s through managed custody, refuses a missing model, and recovers on a fresh launch', async kind => {
    await withConfiguredDaemonTestHome({ prefix: 'purpose-launch-' }, async ({ homeDir }) => {
      const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
        physicalGateway: true, connectedAccountModels: [{ id: 'example', name: 'Example' }],
        resolveAccountTarget: async (target, signal) => { signal.throwIfAborted();
          return { account: { service, accountId: 'upstream-account' }, displayName: 'Selected source',
            ...(target.kind === 'group' ? { group: { groupId: target.groupId, generation: 1 } } : {}) }; },
        connectedAccounts: [{ purpose: 'inference', service, materializationKinds: ['httpHeaders'],
          managedProviderEndpoint: { provider, purpose: 'upstream', modelIdPrefix: 'native/' } }],
      });
      const unexpected = async (): Promise<never> => { throw new Error('Persisted Provider connection path must not run'); };
      try {
        let selections = 0;
        const connectedServices = { v: 2 as const, bindingsByServiceId: {
          'acme.shared-registry/accounts': kind === 'session'
            ? { source: 'connected' as const, profileId: 'upstream-account' }
            : { source: 'connected' as const, selection: 'group' as const, groupId: 'source-pool' } } };
        const launch = (modelId: string, featureEnabled = true) => prepareProviderLaunch({
          selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: null, modelId } },
          backendTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
          machineId: fixture.machineId, agentId: fixture.agentId, previousBinding: null, confirmation: null,
          connectedServices,
          featureEnabled, resolvePrerequisites: unexpected, createAuthorizationAttempt: unexpected,
          managedPurposeContext: { lease: fixture.lease, happyHomeDir: homeDir,
            resolveManagedPurposeBindingIntentSelection: async request => { selections++; return await fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection(request); } },
        });
        expect(await launch('native/example', false)).toMatchObject({ ok: false, error: { code: 'provider_feature_disabled' } });
        expect(selections).toBe(0);
        expect(await launch('native/missing')).toMatchObject({ ok: false, error: { code: 'provider_model_not_found' } });
        const admitted = await launch('native/example');
        expect(admitted).toMatchObject({ ok: true, kind: 'managedPurpose',
          model: { id: 'example' },
          connectedServices });
        if (!admitted.ok || admitted.kind !== 'managedPurpose') throw new Error('Expected managed purpose');
        const materialized = await admitted.materialize(kind === 'session' ? { kind, sessionId: 'session-purpose' } : { kind, executionRunId: 'run-purpose' });
        expect(materialized).toMatchObject({ ok: true, providerBinding: { source: { kind: 'connected_account', account: { service, accountId: 'upstream-account' } }, model: { id: 'example' } } });
        if (!materialized.ok) throw new Error(JSON.stringify(materialized.error));
        expect(selections).toBe(2);
        const endpoint = materialized.environmentOverlay.find(entry => entry.name === 'RUN_PROVIDER_URL')!.value!;
        const credential = materialized.environmentOverlay.find(entry => entry.name === 'RUN_PROVIDER_TOKEN')!.value!;
        expect(new URL(endpoint).hostname).toBe('127.0.0.1');
        const request = () => fetch(endpoint + '/responses', { method: 'POST', headers: {
          authorization: 'Bearer ' + credential, 'content-type': 'application/json' },
          body: JSON.stringify({ model: materialized.providerBinding.model.id, input: 'managed source request' }) });
        const response = await request();
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('ok');
        expect((await readFile(join(homeDir, 'fixture', 'gateway-inputs'), 'utf8')).trim()).toBe('managed source request');
        expect((await readFile(join(homeDir, 'fixture', 'gateway-starts'), 'utf8')).trim().split('\n')).toHaveLength(1);
        expect(await materialized.revalidateBeforeCommit()).toEqual({ ok: true });
        await materialized.cleanup();
        await expect(request()).rejects.toThrow();
      } finally { await fixture.cleanup(); }
    });
  });
});
