import { readProviderSettingsForCli } from '../settings/read';
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
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
import { ProviderContributionV1Schema } from '@happier-dev/protocol';
import { resolveProviderConnectedAccountDeclarationsV1 } from '@happier-dev/protocol/providers/contributions';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { serializeProviderBindingLaunchHandoffForEnv, consumeProviderBindingLaunchHandoffFromEnvironments,
  HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY } from '@/plugins/runtime/providerBindings/handoff';
const service = { pluginId: 'acme.shared-registry', localId: 'accounts' };
const provider = { pluginId: 'acme.shared-registry', localId: 'gateway' };
const purpose = { consumer: provider, purpose: 'upstream' };
const connectedAccountTarget = { kind: 'account' as const, account: { service, accountId: 'upstream-account' } };
const retainedServices = { v: 2 as const, bindingsByServiceId: {
  'acme.shared-registry/accounts': { source: 'connected' as const, profileId: 'upstream-account' },
} };
const selectSource = (agentTargetKey: string, modelId: string) => ({ v: 2 as const, updatedAt: 1, ref: {
  source: 'connected_account' as const, purpose, endpointTemplateId: 'api', agentTargetKey, modelId,
} });
describe('Provider-managed Connected Account purpose launch', () => {
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
  it.each([{ guest: false, placed: false }, { guest: true, placed: false }, { guest: false, placed: true }])(
    'uses the source catalog through daemon launch and child materialization (guest=$guest, placed=$placed)', async ({ guest, placed }, context) => {
    const holderPath = resolveSessionHolderExecutablePath();
    if (placed && (process.platform === 'win32' || !holderPath)) return context.skip();
    await withConfiguredDaemonTestHome({ prefix: 'purpose-daemon-' }, async ({ homeDir }) => {
      const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
        physicalGateway: true, sourceEnvelopeTransport: 'cpx-v1', connectedAccountModels: [
          { id: 'example', name: 'Example' }, { id: 'key-only', name: 'Key only' }] });
      const resources = createProviderLaunchResourceScope();
      const redaction = createProviderRedactionLease({ values: [] });
      const targetLifetime = new AbortController();
      let targetBytes = Buffer.alloc(0);
      // The native process/channel stands in for an admitted Machine provider;
      // all Provider admission, materialization and forwarding remain real.
      const managedTarget = placed ? { home: homeDir, holderPath: holderPath!, lifetime: targetLifetime.signal,
        openChannel: (argv: readonly string[], signal: AbortSignal) => {
          const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
          const channel = Duplex.from({ readable: child.stdout, writable: child.stdin });
          child.stdout.on('data', (bytes: Buffer) => { targetBytes = Buffer.concat([targetBytes, bytes]); });
          child.once('error', error => channel.destroy(error));
          const stop = () => { child.kill(); };
          signal.addEventListener('abort', stop, { once: true });
          child.once('close', () => { signal.removeEventListener('abort', stop); channel.destroy(); });
          return channel;
        } } : undefined;
      const backendTarget = { kind: 'backend' as const, backendId: fixture.agentId };
      const selection = selectSource(fixture.agentTargetKey, 'example');
      const registry = { ...fixture.lease.registry, contributes: { ...fixture.lease.registry.contributes,
        providersByContributionKey: new Map([...fixture.lease.registry.contributes.providersByContributionKey].map(([key, row]) => {
          const definition = ProviderContributionV1Schema.parse({ ...row.definition,
            connectedAccounts: row.definition.connectedAccounts?.map(family => ({
              ...family, catalogObservation: { agent: fixture.lease.registry.contributes.agentDefinitionsById.get(fixture.agentId)!.identity },
            })),
          });
          const connectedAccountDeclarations = resolveProviderConnectedAccountDeclarationsV1({ identity: row.identity, definition });
          return [key, { ...row, definition, connectedAccountDeclarations }];
        })),
      } };
      const lease = { ...fixture.lease, registry };
      let offeredModels = [{ id: 'example', name: 'Example' }, { id: 'key-only', name: 'Key only' }];
      const runtimeOptions = { acquireRuntimeLease: async () => lease, featureGate: { isEnabled: () => true },
        getAccountSettingsSnapshot: () => fixture.snapshot,
        resolveManagedPurposeBindingIntentSelection: fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection,
        modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected catalog mutation'); },
      };
      const controllerMachineId = guest ? 'controller' : fixture.machineId;
      const controller = createRuntimeProviderModelManagementServices({ ...runtimeOptions, machineId: controllerMachineId,
        // Installed native model invocation is the external boundary. Admission, source
        // observation and both catalog readers below use their real production owners.
        invokeConnectedAccountNativeModels: async () => ({ ok: true, result: { agentId: fixture.agentId,
          source: 'dynamic', supportsFreeform: false, availableModels: offeredModels } }),
      });
      let guestObservations = 0;
      const catalogs = guest ? createRuntimeProviderModelManagementServices({
        ...runtimeOptions, machineId: fixture.machineId,
        readConnectedAccountCatalogCustodianMachineId: () => controllerMachineId,
        readModelProjection: (request, signal) => controller.projectModels(request, signal),
        invokeConnectedAccountNativeModels: async () => { guestObservations++; return { ok: false }; },
      }) : controller;
      try {
        const before = await catalogs.projectModels({ machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey,
          connectedServices: retainedServices });
        if (before.status !== 'success') throw new Error(JSON.stringify(before));
        expect(before.groups).toMatchObject([expect.objectContaining({ catalogObserved: true })]);
        const group = before.groups[0]!;
        const oldRow = group.rows.find(row => row.descriptor.id === 'key-only')!;
        offeredModels = [{ id: 'example', name: 'Example' }];
        const confirmation = await catalogs.mutateModelSettings({ action: 'confirmExperimental',
          machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, connectedAccountTarget,
          connectionId: group.connectionId, catalogSourceKey: oldRow.confirmationSource!.catalogSourceKey,
          expectedConnectionRevision: group.connectionRevision, modelId: oldRow.descriptor.id,
          compatibilityFingerprint: oldRow.compatibility.compatibilityFingerprint });
        expect.soft(confirmation).toMatchObject({ status: 'error', error: { code: 'provider_model_not_found' } });
        const prepared = await prepareDaemonProviderLaunch({
          options: { directory: homeDir, backendTarget, machineId: fixture.machineId, connectedServices: retainedServices },
          effectiveBackendTarget: backendTarget, catalogAgentId: fixture.agentId, modelSelection: selection,
          profileEnvironmentVariables: {}, daemonSpawnHooks: null, persistedProviderBinding: null,
          normalizedExistingSessionId: '', processEnv: {}, accountSettingsSnapshot: fixture.snapshot,
          providerRuntimeHomeDir: homeDir, resolveProvidersFeatureEnabled: () => true,
          resolveManagedPurposeBindingIntentSelection: fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection,
          readModelProjection: (request, signal) => catalogs.projectModels(request, signal),
          pluginRuntimeLease: { currentRegistry: registry, acquire: async () => lease, release: async () => {} },
          launchResourceScope: resources });
        expect(prepared).toMatchObject({ ok: true, managedPurpose: { kind: 'managedPurpose' }, attempt: null });
        if (!prepared.ok || !prepared.managedPurpose) throw new Error('Expected declared source admission');
        const refused = await prepareDaemonProviderLaunch({ options: { ...prepared.options },
          modelSelection: { ...selection, ref: { ...selection.ref, modelId: 'key-only' } },
          effectiveBackendTarget: backendTarget, catalogAgentId: fixture.agentId,
          profileEnvironmentVariables: {}, daemonSpawnHooks: null, persistedProviderBinding: null,
          normalizedExistingSessionId: '', processEnv: {}, accountSettingsSnapshot: fixture.snapshot,
          providerRuntimeHomeDir: homeDir, resolveProvidersFeatureEnabled: () => true,
          resolveManagedPurposeBindingIntentSelection: fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection,
          readModelProjection: (request, signal) => catalogs.projectModels(request, signal),
          pluginRuntimeLease: { currentRegistry: registry, acquire: async () => lease, release: async () => {} },
          launchResourceScope: resources });
        expect(refused).toMatchObject({ ok: false, result: { errorDetail: { providerError: { code: 'provider_model_not_found' } } } });
        await expect(readFile(join(homeDir, 'fixture', 'gateway-starts'))).rejects.toMatchObject({ code: 'ENOENT' });
        const child = await prepareDaemonSpawnChildEnvironment({
          options: { ...prepared.options, existingSessionId: 'committed-source-session' },
          effectiveModelSelection: selection, terminal: undefined, resolvedAgentId: fixture.agentId,
          profileEnvironmentVariables: {}, daemonSpawnHooks: null, pluginRuntimeRegistry: fixture.lease.registry,
          processEnv: {}, connectedServiceAuth: null, connectedServiceMaterializationIdentity: null,
          providerBindingAttempt: null, managedPurpose: prepared.managedPurpose, managedTarget,
          providerAgentTargetKey: prepared.agentTargetKey, providerDiagnosticRedactionLease: redaction,
          launchResourceScope: resources });
        expect(child).toMatchObject({ ok: true });
        if (!child.ok) throw new Error(JSON.stringify(child.result));
        await expect(child.revalidateManagedProviderBeforeCommit?.()).resolves.toEqual({ ok: true });
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
        if (placed) {
          expect(targetBytes.includes(Buffer.from('committed Session source'))).toBe(true);
          const unauthorized = await fetch(endpoint + '/responses', { method: 'POST', headers: {
            authorization: 'Bearer synthetic-not-admitted', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'example', input: 'must-not-reach-source' }) });
          expect(unauthorized.status).toBe(403);
          await unauthorized.text();
        }
        expect((await readFile(join(homeDir, 'fixture', 'gateway-inputs'), 'utf8')).trim()).toBe('committed Session source');
        expect(guestObservations).toBe(0);
        if (placed) {
          targetLifetime.abort();
          await expect(child.revalidateManagedProviderBeforeCommit?.()).resolves.toMatchObject({
            ok: false, error: { code: 'provider_authorization_changed' },
          });
        }
        await resources.retire();
        await expect(child.revalidateManagedProviderBeforeCommit?.()).resolves.toMatchObject({
          ok: false, error: { code: 'provider_authorization_changed' },
        });
        await expect(fetch(endpoint)).rejects.toThrow();
      } finally { await resources.retire(); targetLifetime.abort(); redaction.close(); await fixture.cleanup(); }
    });
  });
  it('refuses a managed source selected for a mismatched Agent target', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'purpose-target-' }, async ({ homeDir }) => {
      const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
        physicalGateway: true, connectedAccountModels: [{ id: 'example', name: 'Example' }] });
      try {
        const result = await prepareProviderLaunch({
          selection: selectSource('agent:acme.other/agent', 'example'),
          backendTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
          machineId: fixture.machineId, agentId: fixture.agentId, previousBinding: null, confirmation: null,
          connectedServices: retainedServices,
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
        physicalGateway: true, experimental: true, connectedAccountModels: [{ id: 'example', name: 'Example' }] });
      let cleanup: (() => Promise<void>) | undefined;
      try {
        const registry = resolveProviderContributionRegistryView(fixture.lease.registry.contributes, undefined);
        const implementation = getProviderContribution(registry, 'acme.shared-registry/gateway');
        const adapter = readLeasedAgentProviderBindingAdapter({ lease: fixture.lease, agentId: fixture.agentId });
        if (!implementation || !adapter) throw new Error('Missing real catalog fixture declarations');
        const projected = await projectConnectedAccountCatalog({ registry, provider: implementation, purpose: 'upstream', sessionPurpose: purpose,
          request: { machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, includeDirectMaterialization: true,
            connectedAccountTarget },
          support: adapter.support, adapterVersion: adapter.adapter.adapterVersion,
          providerSettings: fixture.providerSettings,
          resolveSelection: fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection });
        const row = projected.groups.flatMap(group => group.rows).find(row => row.descriptor.id === 'example');
        if (!row?.confirmationSource || row.compatibility.result.status !== 'experimental') {
          throw new Error('Expected a projected experimental source with its confirmation identity');
        }
        let settings = fixture.providerSettings;
        let catalogUnavailable = true;
        const launch = () => prepareProviderLaunch({
          selection: selectSource(fixture.agentTargetKey, 'example'),
          backendTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
          machineId: fixture.machineId, agentId: fixture.agentId, previousBinding: null, confirmation: null,
          connectedServices: retainedServices,
          featureEnabled: true, resolvePrerequisites: async () => ({ ok: true }),
          createAuthorizationAttempt: async () => { throw new Error('Saved connection path'); },
          managedPurposeContext: { lease: fixture.lease, happyHomeDir: homeDir, readProviderSettings: async () => catalogUnavailable
            ? readProviderSettingsForCli({ ...fixture.snapshot, providerConnectionsCatalog: { status: 'unavailable', reason: 'unreachable' } }).settings
            : settings,
            resolveManagedPurposeBindingIntentSelection: fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection },
        });
        expect(await launch()).toMatchObject({ ok: false, error: { code: 'provider_catalog_unavailable',
          failureCause: { phase: 'providers.catalog', errorCode: 'unreachable' } } });
        catalogUnavailable = false;
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
      });
      const unexpected = async (): Promise<never> => { throw new Error('Persisted Provider connection path must not run'); };
      try {
        let selections = 0;
        const connectedServices = { v: 2 as const, bindingsByServiceId: {
          'acme.shared-registry/accounts': kind === 'session'
            ? { source: 'connected' as const, profileId: 'upstream-account' }
            : { source: 'connected' as const, selection: 'group' as const, groupId: 'source-pool' } } };
        const launch = (modelId: string, featureEnabled = true, retainedSource = true) => prepareProviderLaunch({
          selection: selectSource(fixture.agentTargetKey, modelId),
          backendTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
          machineId: fixture.machineId, agentId: fixture.agentId, previousBinding: null, confirmation: null,
          connectedServices: retainedSource ? connectedServices : null,
          featureEnabled, resolvePrerequisites: unexpected, createAuthorizationAttempt: unexpected,
          managedPurposeContext: { lease: fixture.lease, happyHomeDir: homeDir,
            resolveManagedPurposeBindingIntentSelection: async request => { selections++; return await fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection(request); } },
        });
        expect(await launch('example', false)).toMatchObject({ ok: false, error: { code: 'provider_feature_disabled' } });
        expect(selections).toBe(0);
        expect(await launch('example', true, false)).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
        expect(selections).toBe(0);
        expect(await launch('missing')).toMatchObject({ ok: false, error: { code: 'provider_model_not_found' } });
        const admitted = await launch('example');
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

it('retains a real materialization transport cause through declared managed-purpose launch', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'purpose-cause-' }, async ({ homeDir }) => {
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      physicalGateway: true, materializationUrl: 'http://127.0.0.1:0',
      connectedAccountModels: [{ id: 'example', name: 'Example' }] });
    try {
      const unexpected = async (): Promise<never> => { throw new Error('Persisted Provider connection path must not run'); };
      const admitted = await prepareProviderLaunch({
        selection: selectSource(fixture.agentTargetKey, 'example'),
        backendTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
        machineId: fixture.machineId, agentId: fixture.agentId, previousBinding: null, confirmation: null,
        connectedServices: retainedServices,
        featureEnabled: true, resolvePrerequisites: unexpected, createAuthorizationAttempt: unexpected,
        managedPurposeContext: { lease: fixture.lease, happyHomeDir: homeDir,
          resolveManagedPurposeBindingIntentSelection: fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection },
      });
      expect(admitted).toMatchObject({ ok: true, kind: 'managedPurpose' });
      if (!admitted.ok || admitted.kind !== 'managedPurpose') throw new Error('Expected managed-purpose admission');
      expect(await admitted.materialize({ kind: 'session', sessionId: 'cause-session' })).toMatchObject({ ok: false,
        error: { code: 'provider_materialization_failed', failureCause: { errorClass: 'TypeError', errorCode: 'ECONNREFUSED' } } });
    } finally { await fixture.cleanup(); }
  });
});
