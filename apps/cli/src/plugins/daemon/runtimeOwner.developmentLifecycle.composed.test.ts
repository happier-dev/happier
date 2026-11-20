import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';

import { createActiveAccountSettingsConnectedAccountPurposeBindingStore, createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { deriveRegistryConnectedAccountPurposeReconciliationScopes } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { DaemonState } from '@/api/types';
import { createDaemonPluginRegistryProjectionInvalidation } from '@/daemon/pluginRegistryProjectionInvalidation';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { createDaemonPluginDevelopmentRootsOwner } from './developmentRoots';

import { createPackedTestConnectedAccountsRuntime } from './packedTestConnectedAccounts';
import { createDaemonPluginRuntimeOwner } from './runtimeOwner';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

function createRuntime(happyHomeDir: string, pluginId: string,
  reconcileConnectedAccountPurposePublication?: Parameters<typeof createDaemonPluginRuntimeOwner>[0]['reconcileConnectedAccountPurposePublication'],
  invalidateProjection?: () => void) {
  const reloadController = createPluginReloadController({
    happyHomeDir,
    resolveRuntimeRegistry: async () => resolveExecutablePluginRuntimeRegistry({
      contributes: createResolvedContributionRegistry({}),
    }),
  });
  const owner = createDaemonPluginRuntimeOwner({
    happyHomeDir,
    staleCandidateCleanup: 'disabled',
    reloadController,
    resolveCurrentMachineId: () => 'machine-development-lifecycle',
    connectedAccounts: createPackedTestConnectedAccountsRuntime({ happyHomeDir, pluginId }).owner,
    ...(reconcileConnectedAccountPurposePublication ? { reconcileConnectedAccountPurposePublication } : {}),
    ...(invalidateProjection ? {
      onDurableRegistryApplied: invalidateProjection,
      onRuntimeProjectionInvalidated: invalidateProjection,
    } : {}),
  });
  return { owner, reloadController, async dispose() {
    await owner.changeService.shutdown();
    await reloadController.shutdown();
  } };
}

it('publishes a daemon projection revision for a process-local development replacement, not retained observations', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-projection-')));
  const entryPath = join(root, 'plugin.ts');
  const pluginId = 'acme.development-projection';
  let daemonState: DaemonState = { status: 'running', pid: 17, contributionRegistryProjectionRevision: 40 };
  const publications: DaemonState[] = [];
  // Only the machine-state network publication is substituted. The runtime,
  // source observation, registry adoption and projection revision owner are real.
  const projection = createDaemonPluginRegistryProjectionInvalidation({
    getApiMachine: () => ({
      getContributionRegistryProjectionRevision: () => daemonState.contributionRegistryProjectionRevision ?? 0,
      updateDaemonState: async update => {
        daemonState = update(daemonState);
        publications.push(daemonState);
      },
    }),
    isDaemonQuiescing: () => false,
    onPublicationFailure: error => { throw error; },
  });
  const runtime = createRuntime(root, pluginId, undefined, projection.invalidateProjection);
  const manifest = createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined,
    contributes: { actions: [{ id: 'identity', title: 'Identity', scopes: ['global'], surfaces: ['cli'],
      execution: { target: 'daemon' }, dangerLevel: 'safe' }] },
  });
  const writeVersion = async (revision: number, crash = false) => writeFile(entryPath, [
    `export const manifest = ${JSON.stringify(manifest)};`,
    `export function activate(api) { api.actions.register('identity', () => ({ revision: ${revision} }));`,
    ...(crash ? ["throw new Error('candidate activation failed');"] : []),
    '}',
  ].join('\n'));
  const invoke = () => runtime.reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
    pluginId, localId: 'identity', input: {}, surface: 'cli',
  });
  try {
    await writeVersion(1);
    const initial = await runtime.reloadController.acquireRuntimeRegistry();
    await initial.release();
    await runtime.owner.initialize();
    const publicationsBeforeInstall = publications.length;
    const revisionBeforeInstall = projection.readRevision();
    await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    const pending = (await runtime.owner.changeService.listPendingPluginChanges()).changes[0]!;
    await expect(runtime.owner.changeService.decidePluginChange({
      pendingChangeId: pending.pendingChangeId, decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
    expect(projection.readRevision()).toBe(revisionBeforeInstall + 1);
    expect(publications).toHaveLength(publicationsBeforeInstall + 1);
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { revision: 1 } });
    const installed = await createPluginRegistryStateStore({ happyHomeDir: root }).readSnapshot();
    const materializationId = installed.materializationIdsByPluginId[pluginId];
    expect(materializationId).toEqual(expect.any(String));
    expect(runtime.reloadController.getState().activeRegistry!
      .resolveCurrentPluginMaterializationRef?.(pluginId)).toEqual({
      pluginId, machineId: 'machine-development-lifecycle', materializationId,
    });
    const revisionBeforeDurableUpdate = projection.readRevision();
    const publicationsBeforeDurableUpdate = publications.length;
    await expect(runtime.owner.changeService.requestPluginChange({
      kind: 'setUpdatePolicy', pluginId, policy: 'pinned',
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
    expect(projection.readRevision()).toBe(revisionBeforeDurableUpdate + 1);
    expect(publications).toHaveLength(publicationsBeforeDurableUpdate + 1);
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { revision: 1 } });
    const incumbentOccurrence = runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId);
    const revisionBeforeReload = projection.readRevision();
    const publicationsBeforeReload = publications.length;

    await writeVersion(2);
    await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'reload', rootPath: entryPath });
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { revision: 2 } });
    const replacementOccurrence = runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId);
    expect(replacementOccurrence).toBeTruthy();
    expect(replacementOccurrence).not.toBe(incumbentOccurrence);
    expect(projection.readRevision()).toBe(revisionBeforeReload + 1);
    expect(publications.slice(publicationsBeforeReload)).toEqual([
      { status: 'running', pid: 17, contributionRegistryProjectionRevision: revisionBeforeReload + 1 },
    ]);

    await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'status' });
    const current = await runtime.reloadController.acquireRuntimeRegistry();
    await current.release();
    runtime.owner.reportCurrentAvailability();
    await writeVersion(3, true);
    const rejected = await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'reload', rootPath: entryPath });
    expect(rejected.status.plugins).toEqual(expect.arrayContaining([expect.objectContaining({
      pluginId, phase: 'retained_incumbent',
    })]));
    expect(runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBe(replacementOccurrence);
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { revision: 2 } });
    expect(projection.readRevision()).toBe(revisionBeforeReload + 1);
    expect(publications).toHaveLength(publicationsBeforeReload + 1);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

it('reports an uncertain development adoption when the daemon stops after preparation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-adoption-')));
  const pluginId = 'acme.development-adoption';
  const entryPath = join(root, 'plugin.ts');
  let releaseActivation!: () => void;
  const activationMayFinish = new Promise<void>(resolve => { releaseActivation = resolve; });
  let markActivationEntered!: () => void;
  const activationEntered = new Promise<void>(resolve => { markActivationEntered = resolve; });
  // A real network request holds plugin activation while the real daemon
  // controller shuts down; no lifecycle or registry decision is substituted.
  const server = createServer(async (_request, response) => {
    markActivationEntered();
    await activationMayFinish;
    response.end();
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an HTTP listener');
  const runtime = createRuntime(root, pluginId);
  const manifest = createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined,
    contributes: { actions: [{ id: 'identity', title: 'Identity', scopes: ['global'], surfaces: ['cli'],
      execution: { target: 'daemon' }, dangerLevel: 'safe' }] },
  });
  try {
    await writeFile(entryPath, [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export async function activate(api) {',
      "api.actions.register('identity', () => ({ revision: 1 }));",
      `await fetch(${JSON.stringify(`http://127.0.0.1:${address.port}`)});`,
      '}',
    ].join('\n'));
    const initial = await runtime.reloadController.acquireRuntimeRegistry();
    await initial.release();
    await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    const pending = (await runtime.owner.changeService.listPendingPluginChanges()).changes[0]!;
    const decision = runtime.owner.changeService.decidePluginChange({
      pendingChangeId: pending.pendingChangeId, decision: 'installAndTrust',
    });
    await activationEntered;
    await runtime.reloadController.shutdown();
    releaseActivation();
    await expect(decision).resolves.toMatchObject({ kind: 'outcomeUnknown', pluginId });
    expect((await createPluginRegistryStateStore({ happyHomeDir: root }).read()).plugins[pluginId]).toBeDefined();
    expect(runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeNull();
  } finally {
    releaseActivation();
    await runtime.dispose();
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

it('re-enables a reviewed source in place, changes policy, and re-enables after process custody is restored', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-lifecycle-')));
  const entryPath = join(root, 'plugin.ts');
  const pluginId = 'acme.development-lifecycle';
  let runtime = createRuntime(root, pluginId);
  const store = createPluginRegistryStateStore({ happyHomeDir: root });
  const manifest = createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined,
    contributes: { actions: [{ id: 'identity', title: 'Identity', scopes: ['global'], surfaces: ['cli'],
      execution: { target: 'daemon' }, dangerLevel: 'safe' }] },
  });
  const source = (value: string) => [
    `export const manifest = ${JSON.stringify(manifest)};`,
    `export function activate(api) { api.actions.register('identity', () => ({ value: ${JSON.stringify(value)} })); }`,
  ].join('\n');
  const invoke = () => runtime.reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
    pluginId, localId: 'identity', input: {}, surface: 'cli',
  });
  try {
    await writeFile(entryPath, source('first'));
    const lease = await runtime.reloadController.acquireRuntimeRegistry();
    await lease.release();
    await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    const pending = (await runtime.owner.changeService.listPendingPluginChanges()).changes[0]!;
    await expect(runtime.owner.changeService.decidePluginChange({
      pendingChangeId: pending.pendingChangeId, decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'committed', pluginId });

    // Use the real durable/runtime lifecycle; the public disable Action also
    // requires a server-owned managed-resource census, outside this regression.
    const roots = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir: root,
      submitObservation: async () => ({ kind: 'retained' }),
    });
    await roots.initialize();
    const mutationStore = createPluginRegistryStateStore({ happyHomeDir: root,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({
        happyHomeDir: root, reloadController: runtime.reloadController,
        resolveDevelopmentSourceAuthority: roots.resolveDevelopmentSourceAuthority,
      }),
    });
    try {
      await mutationStore.setEnabledWithResult(pluginId, false);
      await expect(runtime.owner.changeService.requestPluginChange({ kind: 'enable', pluginId }))
        .resolves.toMatchObject({ kind: 'committed', pluginId });
      expect(runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeTruthy();
      await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { value: 'first' } });
      await expect(runtime.owner.changeService.requestPluginChange({ kind: 'setUpdatePolicy', pluginId, policy: 'pinned' }))
        .resolves.toMatchObject({ kind: 'committed', pluginId });
      expect((await store.read()).plugins[pluginId]!.install.updatePolicy).toBe('pinned');
      expect((await runtime.owner.readCatalog()).find(plugin => plugin.pluginId === pluginId)?.install.updatePolicy)
        .toBe('pinned');
      await expect(runtime.owner.changeService.requestPluginChange({ kind: 'update', pluginId }))
        .resolves.toMatchObject({ kind: 'failed', code: 'plugin_update_pinned' });
      await mutationStore.setEnabledWithResult(pluginId, false);
      await expect(runtime.owner.changeService.requestPluginChange({ kind: 'setUpdatePolicy', pluginId, policy: 'allowed' }))
        .resolves.toMatchObject({ kind: 'committed', pluginId });
      expect((await store.read()).plugins[pluginId]!.install.updatePolicy).toBe('allowed');
      expect((await runtime.owner.readCatalog()).find(plugin => plugin.pluginId === pluginId)?.install.updatePolicy)
        .toBe('allowed');
    } finally {
      await roots.stop();
    }

    await runtime.dispose();
    runtime = createRuntime(root, pluginId);
    const restoredLease = await runtime.reloadController.acquireRuntimeRegistry();
    await restoredLease.release();
    await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    await expect(runtime.owner.changeService.requestPluginChange({ kind: 'enable', pluginId }))
      .resolves.toMatchObject({ kind: 'committed', pluginId });
    expect((await store.read()).plugins[pluginId]!.state.enabled).toBe(true);
    expect(runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeTruthy();
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { value: 'first' } });
    await expect(runtime.owner.changeService.requestPluginChange({ kind: 'update', pluginId }))
      .resolves.toMatchObject({ kind: 'failed', code: 'plugin_development_update_requires_reload' });
    await writeFile(entryPath, source('updated'));
    await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'reload', rootPath: entryPath });
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { value: 'updated' } });
    const restoredRoots = createDaemonPluginDevelopmentRootsOwner({ happyHomeDir: root,
      submitObservation: async () => ({ kind: 'retained' }),
    });
    await restoredRoots.initialize();
    try {
      await createPluginRegistryStateStore({ happyHomeDir: root,
        runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir: root,
          reloadController: runtime.reloadController,
          resolveDevelopmentSourceAuthority: restoredRoots.resolveDevelopmentSourceAuthority,
        }),
      }).setEnabledWithResult(pluginId, false);
      await expect(runtime.owner.changeService.requestPluginChange({ kind: 'enable', pluginId }))
        .resolves.toMatchObject({ kind: 'committed', pluginId });
      await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { value: 'updated' } });
    } finally {
      await restoredRoots.stop();
    }
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('reactivates an enabled external development plugin after daemon restart without an author command', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-restart-')));
  const entryPath = join(root, 'plugin.ts');
  const pluginId = 'acme.development-restart';
  let runtime = createRuntime(root, pluginId);
  const manifest = createPluginManifestV2Fixture({
    id: pluginId,
    entrypoints: { daemon: './plugin.mjs', development: './plugin.ts' },
    contributes: {
      actions: [{ id: 'identity', title: 'Identity', scopes: ['global'], surfaces: ['cli'],
        execution: { target: 'daemon' }, dangerLevel: 'safe' }],
      resources: [{ id: 'status', source: 'dynamic', kind: 'config', contentType: 'application/json' }],
    },
  });
  const source = (revision: number) => [
    `export const manifest = ${JSON.stringify(manifest)};`,
    'export function activate(api) {',
    `api.actions.register('identity', async () => ({ revision: ${revision} }));`,
    `api.resources.registerDynamicResource('status', { read: async () => JSON.stringify({ revision: ${revision} }), observe: () => ({ dispose() {} }) });`,
    '}',
  ].join('\n');
  try {
    await writeFile(entryPath, source(1));
    const initial = await runtime.reloadController.acquireRuntimeRegistry();
    await initial.release();
    await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    const pending = (await runtime.owner.changeService.listPendingPluginChanges()).changes[0]!;
    await expect(runtime.owner.changeService.decidePluginChange({
      pendingChangeId: pending.pendingChangeId, decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
    await runtime.dispose();
    // A new daemon gets only durable state and current source, with no CLI watcher
    // or in-process occurrence from the previous daemon.
    await writeFile(entryPath, source(2));
    const credentials = { token: 'restart-fixture', encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], connectedPurposeCatalog: { status: 'ready', revision: 1,
        record: { key: 'purposes', value: { v: 1, bindings: [] } } } });
    // HTTP is the only substituted boundary: the startup registry, persisted
    // development roots, purpose store and publication admission remain real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      throw new Error(`Unexpected restart HTTP read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 503, data: { error: 'unavailable' } });
    const unavailable = async (): Promise<never> => { throw new Error('Startup must not select or materialize credentials'); };
    const bindings = createConnectedAccountPurposeBindingOwner({
      store: createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials }),
      selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
      projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
    });
    runtime = createRuntime(root, pluginId, async input => bindings.reconcileAuthorizedPurposes({
      consumerScopes: deriveRegistryConnectedAccountPurposeReconciliationScopes(input.previous, input.candidate,
        input.resolveOptionalAccess, { candidateActivePluginIds: input.candidateActivePluginIds }),
      signal: new AbortController().signal, publish: input.publish,
    }));
    await runtime.owner.initialize();
    expect((await runtime.owner.changeService.listPendingPluginChanges()).changes).toEqual([]);
    expect(runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeTruthy();
    await expect(runtime.reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
      pluginId, localId: 'identity', input: {}, surface: 'cli',
    })).resolves.toMatchObject({ status: 'executed', value: { revision: 2 } });
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

it.each([false, true])('publishes new dynamic Resources with their Actions, retaining v1 if v2 throws (%s)', async (crash) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-resource-update-')));
  const pluginId = 'acme.development-resource-update';
  const entryPath = join(root, 'plugin.ts');
  const runtime = createRuntime(root, pluginId);
  const writeVersion = async (revision: number, throws = false) => {
    const actions = ['identity', ...(revision > 1 ? ['added'] : [])].map(id => ({
      id, title: id, scopes: ['global'], surfaces: ['cli'],
      execution: { target: 'daemon' }, dangerLevel: 'safe',
    }));
    const manifest = createPluginManifestV2Fixture({
      id: pluginId, version: `${revision}.0.0`,
      entrypoints: { daemon: './plugin.mjs', development: './plugin.ts' },
      contributes: {
        actions,
        resources: [{ id: 'baseline', source: 'dynamic', kind: 'config', contentType: 'application/json' }, ...(revision > 1 ? [{
          id: 'status', source: 'dynamic', kind: 'config', contentType: 'application/json',
        }] : [])],
      },
    });
    await writeFile(entryPath, [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate(api) {',
      `api.actions.register('identity', async () => ({ revision: ${revision} }));`,
      `api.resources.registerDynamicResource('baseline', { read: async () => JSON.stringify({ revision: ${revision} }), observe: () => ({ dispose() {} }) });`,
      ...(revision > 1 ? [
        `api.actions.register('added', async () => ({ revision: ${revision} }));`,
        `api.resources.registerDynamicResource('status', { read: async () => JSON.stringify({ revision: ${revision} }), observe: () => ({ dispose() {} }) });`,
      ] : []),
      ...(throws ? ["throw new Error('candidate activation failed');"] : []),
      '}',
    ].join('\n'));
  };
  const active = () => runtime.reloadController.getState().activeRegistry!;
  const invoke = (localId = 'identity') => active().targetActionInvocations.invoke({
    pluginId, localId, input: {}, surface: 'cli',
  });
  const store = createPluginRegistryStateStore({ happyHomeDir: root });
  try {
    await writeVersion(1);
    const initial = await runtime.reloadController.acquireRuntimeRegistry();
    await initial.release();
    await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    const pending = (await runtime.owner.changeService.listPendingPluginChanges()).changes[0]!;
    await expect(runtime.owner.changeService.decidePluginChange({
      pendingChangeId: pending.pendingChangeId, decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
    const incumbentOccurrence = runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId);
    expect(incumbentOccurrence).toBeTruthy();
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { revision: 1 } });

    await writeVersion(2, crash);
    const update = await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'reload', rootPath: entryPath });
    if (crash) {
      expect(update.status.plugins).toEqual(expect.arrayContaining([expect.objectContaining({
        pluginId, phase: 'retained_incumbent', diagnostic: expect.objectContaining({
          code: 'plugin_activation_failed', message: expect.stringContaining('candidate activation failed'),
        }),
      })]));
      expect(runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBe(incumbentOccurrence);
      await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { revision: 1 } });
      expect(active().contributes.resources.map(resource => resource.definition.id)).toEqual(['baseline']);
      expect(active().contributes.actions.some(action => action.definition.id === 'added')).toBe(false);
      expect((await store.read()).plugins[pluginId]?.install.manifestVersion).toBe('1.0.0');
      const incumbentResource = await active().readUiResource!({
        expectedCallerOccurrenceId: incumbentOccurrence!, callerPluginId: pluginId, resourceId: 'baseline',
      });
      expect(JSON.parse(new TextDecoder().decode(incumbentResource.bytes))).toEqual({ revision: 1 });
    } else {
      expect(update.status.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ pluginId, phase: 'active' })]));
      await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { revision: 2 } });
      await expect(invoke('added')).resolves.toMatchObject({ status: 'executed', value: { revision: 2 } });
      const occurrenceId = runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId);
      expect(occurrenceId).toBeTruthy();
      expect(occurrenceId).not.toBe(incumbentOccurrence);
      const resource = await active().readUiResource!({
        expectedCallerOccurrenceId: occurrenceId!, callerPluginId: pluginId, resourceId: 'status',
      });
      expect(JSON.parse(new TextDecoder().decode(resource.bytes))).toEqual({ revision: 2 });
      expect((await store.read()).plugins[pluginId]?.install.manifestVersion).toBe('2.0.0');
      await expect(active().readUiResource!({
        expectedCallerOccurrenceId: incumbentOccurrence!, callerPluginId: pluginId, resourceId: 'status',
      })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
    }
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['file', 'package'] as const)('registers a direct development install (%s) and rejoins its exact review before publishing the approved source', async (shape) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-direct-install-')));
  const pluginId = 'acme.direct-development';
  const entryPath = shape === 'file' ? join(root, 'plugin.ts') : join(root, 'source', 'src', 'index.mjs');
  const locator = shape === 'file' ? entryPath : join(root, 'source');
  if (shape === 'package') {
    await mkdir(join(locator, 'src'), { recursive: true });
    await writeFile(join(locator, 'package.json'), JSON.stringify({ type: 'module', main: './src/index.mjs' }));
  }
  const runtime = createRuntime(root, pluginId);
  const store = createPluginRegistryStateStore({ happyHomeDir: root });
  try {
    await writeFile(entryPath, [
      `export const manifest = ${JSON.stringify(createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined,
        contributes: { actions: [{ id: 'identity', title: 'Identity', scopes: ['global'], surfaces: ['cli'],
          execution: { target: 'daemon' }, dangerLevel: 'safe' }] },
      }))};`,
      "export function activate(api) { api.actions.register('identity', () => ({ installed: true })); }",
    ].join('\n'));
    const lease = await runtime.reloadController.acquireRuntimeRegistry();
    await lease.release();
    const request = { kind: 'development' as const, sourceRootPath: locator };
    const pending = await runtime.owner.changeService.requestPluginChange(request);
    expect(pending.kind).toBe('reviewRequired');
    if (pending.kind !== 'reviewRequired') throw new Error('Expected installation review');
    await expect(runtime.owner.changeService.requestPluginChange(request)).resolves.toEqual(pending);
    expect((await store.read()).plugins[pluginId]).toBeUndefined();
    expect(runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeNull();
    const approved = await runtime.owner.changeService.decidePluginChange({
      pendingChangeId: pending.pendingChangeId, decision: 'installAndTrust',
    });
    expect(approved, JSON.stringify(approved)).toMatchObject({ kind: 'committed', pluginId });
    if (shape === 'package') {
      await expect(readFile(join(locator, 'pnpm-lock.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect((await store.read()).plugins[pluginId]?.source).toMatchObject({ kind: 'path', locator, devWatch: true });
    expect((await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'status' })).status.plugins)
      .toEqual(expect.arrayContaining([expect.objectContaining({ pluginId, sourceRootPath: locator, phase: 'active' })]));
    await expect(runtime.reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
      pluginId, localId: 'identity', input: {}, surface: 'cli',
    })).resolves.toMatchObject({ status: 'executed', value: { installed: true } });
    // Re-adopting a corrected retained source uses the same public install path.
    await writeFile(entryPath, (await readFile(entryPath, 'utf8')).replace('installed: true', 'installed: "corrected"'));
    const corrected = await runtime.owner.changeService.requestPluginChange(request);
    expect(corrected, JSON.stringify(corrected)).toMatchObject({ kind: 'committed', pluginId });
    await expect(runtime.reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
      pluginId, localId: 'identity', input: {}, surface: 'cli',
    })).resolves.toMatchObject({ status: 'executed', value: { installed: 'corrected' } });
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses a direct development install without registering its source during handoff', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-handoff-')));
  const entryPath = join(root, 'plugin.ts');
  const runtime = createRuntime(root, 'acme.handoff-development');
  try {
    await writeFile(entryPath, [
      `export const manifest = ${JSON.stringify(createPluginManifestV2Fixture({ id: 'acme.handoff-development', entrypoints: undefined }))};`,
      'export function activate() {}',
    ].join('\n'));
    const handoff = await runtime.owner.changeService.quiesceForHandoff();
    try {
      const refused = await runtime.owner.changeService.requestPluginChange({ kind: 'development', sourceRootPath: entryPath });
      expect(refused, JSON.stringify(refused)).toMatchObject({ kind: 'unavailable', code: 'daemon_draining' });
      const status = await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'status' });
      expect(status.status.roots).toEqual([]);
      expect(status.status.plugins).toEqual([]);
      expect((await runtime.owner.changeService.listPendingPluginChanges()).changes).toEqual([]);
    } finally {
      handoff.resume();
    }
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not register a direct development source cancelled while its path is resolving', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-cancelled-')));
  const entryPath = join(root, 'plugin.ts');
  const runtime = createRuntime(root, 'acme.cancelled-development');
  try {
    await writeFile(entryPath, [
      `export const manifest = ${JSON.stringify(createPluginManifestV2Fixture({ id: 'acme.cancelled-development', entrypoints: undefined }))};`,
      'export function activate() {}',
    ].join('\n'));
    const controller = new AbortController();
    const request = runtime.owner.changeService.requestPluginChange({ kind: 'development', sourceRootPath: entryPath }, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(request).resolves.toMatchObject({ kind: 'cancelled' });
    const status = await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'status' });
    expect(status.status.roots).toEqual([]);
    expect(status.status.plugins).toEqual([]);
    expect((await runtime.owner.changeService.listPendingPluginChanges()).changes).toEqual([]);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['unregistered', 'staleRevision', 'unregisteredAfterReview'] as const)(
  'does not persist installation authority for a development candidate with %s custody', async (custody) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-unregistered-')));
  const pluginId = 'acme.unregistered-development';
  const entryPath = join(root, 'plugin.ts');
  const runtime = createRuntime(root, pluginId);
  try {
    await writeFile(entryPath, [
      `export const manifest = ${JSON.stringify(createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined }))};`,
      'export function activate() {}',
    ].join('\n'));
    const lease = await runtime.reloadController.acquireRuntimeRegistry();
    await lease.release();
    if (custody !== 'unregistered') {
      await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
      if (custody === 'staleRevision') {
        const pending = (await runtime.owner.changeService.listPendingPluginChanges()).changes[0]!;
        await runtime.owner.changeService.decidePluginChange({ pendingChangeId: pending.pendingChangeId, decision: 'cancel' });
      }
    }
    const request = await runtime.owner.changeService.requestPluginChange({
      kind: 'development', sourceRootPath: entryPath,
      // Revision-bearing submissions are observations, never a grant to register a source.
      ...(custody !== 'unregisteredAfterReview' ? { observedRevision: 0 } : {}),
    });
    expect(request.kind).toBe('reviewRequired');
    if (request.kind !== 'reviewRequired') throw new Error('Expected installation review');
    if (custody === 'unregisteredAfterReview') {
      await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'unregisterExplicit', rootPath: entryPath });
    }
    await expect(runtime.owner.changeService.decidePluginChange({
      pendingChangeId: request.pendingChangeId, decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'failed', code: 'plugin_change_failed',
      message: expect.stringContaining('superseded before preparation'),
      details: { failureCause: { errorCode: 'plugin_change_superseded', phase: 'plugins.change.apply' } } });
    expect((await createPluginRegistryStateStore({ happyHomeDir: root }).read()).plugins[pluginId]).toBeUndefined();
    expect(runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeNull();
    if (custody === 'unregistered') {
      // A settled failed observation cannot trap a later ordinary install in
      // its revision-zero custody; the new install gets the registered review.
      const retry = await runtime.owner.changeService.requestPluginChange({ kind: 'development', sourceRootPath: entryPath });
      expect(retry.kind).toBe('reviewRequired');
      if (retry.kind !== 'reviewRequired') throw new Error('Expected a fresh installation review');
      expect(retry.pendingChangeId).not.toBe(request.pendingChangeId);
      await expect(runtime.owner.changeService.decidePluginChange({
        pendingChangeId: retry.pendingChangeId, decision: 'installAndTrust',
      })).resolves.toMatchObject({ kind: 'committed', pluginId });
    }
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
