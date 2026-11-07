import { createWorkspaceActionAdapter } from '@/components/appShell/workspace/workspaceActions';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { createWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-triage/manifest';
import { projectPluginUiDeclarationEntriesV1, projectPluginReactNativeArtifactEntryV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { createPluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { createPluginUiResourceProjection } from '@/dev/testkit/fixtures/pluginUiResourceProjection';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { selectPluginDestinationSurfacePlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { storage } from '@/sync/domains/state/storageStore';
import { hasInAppResourceHandler, requestOpenResource, requestOpenResourceUrl } from './openResource';

const initialSettings = storage.getState().settings;
afterEach(() => storage.setState({ settings: initialSettings }));

function triageResourceProjection() {
  const pluginId = PLUGIN_MANIFEST.id;
  const declarations = <T extends { id: string }>(definitions: readonly T[]) => definitions.map(definition => ({
    pluginId, identity: { pluginId, localId: definition.id }, definition,
  }));
  const entries = projectPluginUiDeclarationEntriesV1({ registry: {
    uiViewsV2: declarations(PLUGIN_MANIFEST.contributes.ui.views),
    uiRenderersV2: declarations(PLUGIN_MANIFEST.contributes.ui.renderers),
  }, artifactEntries: PLUGIN_MANIFEST.contributes.ui.renderers.flatMap(renderer => renderer.kind === 'reactNative'
    // Executable bytes are outside this routing contract; the daemon's admitted loadable facts are the boundary fixture.
    ? [projectPluginReactNativeArtifactEntryV1({ pluginId, pluginVersion: PLUGIN_MANIFEST.version,
      contributionId: renderer.id, artifactId: renderer.artifact, generatedOwnerKind: 'renderer',
      requiredHostMethods: renderer.requiredHostMethods ?? [], runtime: { state: 'loadable', diagnostics: [],
        decision: { state: 'load', reason: 'compatible', diagnostics: [] } } })] : []) });
  return normalizePluginUiProjection({ v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {},
    resourcesById: {}, settingsById: {}, diagnostics: [], familiesById: { pluginUi: { family: 'pluginUi',
      entriesById: Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, { ...entry, occurrenceId: 'triage-install',
        executionOrigin: { serverIdentityId: 'srv_home', materializationRef: {
          pluginId, machineId: 'machine', materializationId: 'triage-install',
        } },
      }])) } } });
}

describe('open resource intent', () => {
  it.each(['happier', 'github', 'unavailable'] as const)('phone person and agent report the %s destination outcome', async scenario => {
    const preference = scenario === 'github' ? 'github' : 'happier';
    storage.setState({ settings: { ...initialSettings, scmResourceOpenLocation: preference } });
    const projection = triageResourceProjection();
    const opened: unknown[] = [];
    const external: string[] = [];
    const navigation = createPluginSurfaceDestinationNavigationBinding({
      placements: selectPluginDestinationSurfacePlacements(projection), projection, targetKind: 'session',
      runtimeAdmission: { platform: 'web', formFactor: 'phone' },
      scopedLaunchFacts: { serverId: 'home', machineId: 'machine', interactionEnabled: true },
      accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) },
    });
    if (scenario !== 'unavailable') navigation.registerOwner({ container: 'detailsTab', handler: resolution => {
      opened.push(resolution.request); return { ok: true };
    } });
    const resource = { kind: 'pullRequest' as const, url: 'https://github.com/happier-dev/triage-qa-sandbox/pull/54' };
    const context = { navigation, openExternal: async (url: string) => { external.push(url); return true; } };
    expect(await requestOpenResource(resource, context)).toBe(true);
    const personOpened = [...opened]; const personExternal = [...external];
    opened.length = 0; external.length = 0;
    const state = createWorkspaceState({ id: 'session', target: { kind: 'session', params: { id: 's' } }, pinned: false, preview: false });
    const workspace = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => [],
      dispatch: () => { throw new Error('Resource intent must use the incumbent plugin destination'); },
      transport: { commit: () => {} }, createId: () => 'new', onChange: () => {} });
    const execute = createWorkspaceActionAdapter({ getState: () => state, navigation: workspace,
      readCanvas: () => null, createId: () => 'new', readResourceContext: () => context });
    expect(await execute('workspace.tabs.open', { resource })).toEqual(scenario === 'happier'
      ? { ok: true }
      : { ok: false, errorCode: 'workspace_resource_opened_external', error: 'workspace_resource_opened_external' });
    expect(opened).toEqual(personOpened);
    expect(external).toEqual(personExternal);
    expect(scenario === 'happier' ? opened : external).toHaveLength(1);
  });

  it('does not turn a refused resource handoff into an external open', async () => {
    storage.setState({ settings: { ...initialSettings, scmResourceOpenLocation: 'happier' } });
    const projection = triageResourceProjection();
    const navigation = createPluginSurfaceDestinationNavigationBinding({
      placements: selectPluginDestinationSurfacePlacements(projection), projection, targetKind: 'session',
      accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) },
      scopedLaunchFacts: { serverId: 'home', machineId: 'machine', interactionEnabled: true },
    });
    navigation.registerOwner({ container: 'detailsTab', handler: () => ({ ok: false, code: 'denied', reason: 'navigation_cancelled' }) });
    const external: string[] = [];
    expect(await requestOpenResource({ kind: 'pullRequest', url: 'https://github.com/happier-dev/triage-qa-sandbox/pull/54' }, {
      navigation, openExternal: async url => { external.push(url); return true; },
    })).toBe(false);
    expect(external).toEqual([]);
  });

  it('prefers the real Triage Session handler over the app-only catalog with the happier preference', async () => {
    storage.setState({ settings: { ...initialSettings, scmResourceOpenLocation: 'happier' } });
    const pluginId = PLUGIN_MANIFEST.id;
    const projection = triageResourceProjection();
    const appProjection = { ...projection, surfacePlacementsById: Object.fromEntries(Object.entries(projection.surfacePlacementsById)
      .filter(([, entry]) => entry.binding.targetKind === 'app')) };
    let appCatalogReads = 0;
    const detach = publishCommittedAppShellPluginUiProjection(() => { appCatalogReads++; return appProjection; });
    const opened: unknown[] = [];
    const external: string[] = [];
    const navigation = createPluginSurfaceDestinationNavigationBinding({
      placements: selectPluginDestinationSurfacePlacements(projection), projection,
      targetKind: 'session', scopedLaunchFacts: { serverId: 'home', machineId: 'machine', interactionEnabled: true },
      accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) },
    });
    navigation.registerOwner({ container: 'detailsTab', handler: resolution => {
      opened.push({ destination: resolution.placement.binding.destination, request: resolution.request });
      return { ok: true };
    } });
    const resource = { kind: 'pullRequest' as const, url: 'https://github.com/happier-dev/triage-qa-sandbox/pull/54' };
    try {
      const details = PLUGIN_MANIFEST.contributes.ui.views.find(view => view.container === 'detailsTab' && view.target.kind === 'session')!;
      expect(await navigation.openSurface({ destination: { pluginId, localId: details.id }, instanceKey: resource.url, input: { resource } })).toEqual({ ok: true });
      opened.length = 0;
      expect(await requestOpenResource(resource, { navigation, openExternal: async url => { external.push(url); return true; } })).toBe(true);
      expect(opened).toEqual([{ destination: { pluginId, localId: details.id }, request: {
        destination: { pluginId, localId: details.id }, instanceKey: resource.url, input: { resource },
      } }]);
      expect(external).toEqual([]);
      expect(appCatalogReads).toBe(0);
    } finally { detach(); }
  });

  it.each(['happier', 'github'] as const)('routes a Session-origin Triage resource using the %s preference', async preference => {
    const projection = triageResourceProjection();
    const appProjection = { ...projection, surfacePlacementsById: Object.fromEntries(Object.entries(projection.surfacePlacementsById)
      .filter(([, entry]) => entry.binding.targetKind === 'app')) };
    const resource = { kind: 'pullRequest' as const, url: 'https://github.com/happier-dev/triage-qa-sandbox/pull/63' };
    const opened: unknown[] = [];
    const external: string[] = [];
    storage.setState({ settings: { ...initialSettings, scmResourceOpenLocation: preference } });
    const appNavigation = createPluginSurfaceDestinationNavigationBinding({
      placements: selectPluginDestinationSurfacePlacements(appProjection), projection: appProjection, targetKind: 'app',
      scopedLaunchFacts: { serverId: 'home', machineId: 'machine', interactionEnabled: true },
      accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) },
    });
    appNavigation.registerOwner({ container: 'appPage', handler: resolution => {
      opened.push(resolution.request);
      return { ok: true };
    } });
    const navigation = createPluginSurfaceDestinationNavigationBinding({
      placements: [], projection: appProjection, targetKind: 'session',
      enclosingOpenSurface: appNavigation.openSurface,
      scopedLaunchFacts: { serverId: 'home', machineId: 'machine', interactionEnabled: true },
      accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) },
    });
    expect(await requestOpenResource(resource, { navigation,
      openExternal: async url => { external.push(url); return true; } })).toBe(true);
    expect(opened).toEqual(preference === 'github' ? [] : [{
      destination: { pluginId: PLUGIN_MANIFEST.id, localId: 'triage' }, input: { resource },
    }]);
    expect(external).toEqual(preference === 'github' ? [resource.url] : []);
  });

  it('keeps an unavailable scoped catalog unavailable instead of borrowing the app catalog', async () => {
    const projection = createPluginUiResourceProjection(true, 'app');
    const detach = publishCommittedAppShellPluginUiProjection(() => projection);
    const external: string[] = [];
    const launches: unknown[] = [];
    const resource = { kind: 'pullRequest' as const, url: 'https://forge.example/acme/repo/pull/42' };
    try {
      await requestOpenResource(resource, { navigation: { targetKind: 'app', projection: null,
        openSurface: request => { launches.push(request); return { ok: true }; } },
        openExternal: async url => { external.push(url); return true; } });
      expect(external).toEqual([resource.url]);
      expect(launches).toEqual([]);
    } finally { detach(); }
  });

  it.each(['session', 'app'] as const)('opens resources declared on a real %s destination without occupying the SCM slot', async targetKind => {
    const projection = createPluginUiResourceProjection(true, targetKind, 'destination');
    const launches: unknown[] = [];
    const external: string[] = [];
    const resource = { kind: 'pullRequest' as const, url: 'https://forge.example/acme/repo/pull/42' };
    expect(hasInAppResourceHandler(projection)).toBe(true);
    await requestOpenResource(resource, { projection,
      navigation: { targetKind, openSurface: request => { launches.push(request); return { ok: true }; } },
      openExternal: async url => { external.push(url); return true; } });
    expect(launches).toEqual([{ destination: { pluginId: 'acme.forge', localId: 'details' },
      ...(targetKind === 'session' ? { instanceKey: resource.url } : {}), input: { resource } }]);
    expect(external).toEqual([]);
    expect(hasInAppResourceHandler(createPluginUiResourceProjection(false, targetKind, 'destination'))).toBe(false);
  });

  it('recognizes integration-owned URLs and preserves the exact resource in the destination launch', async () => {
    const launches: unknown[] = [];
    const external: string[] = [];
    const resource = { kind: 'pullRequest' as const, url: 'https://forge.example/acme/repo/pull/42' };
    expect(await requestOpenResourceUrl(resource.url, { projection: createPluginUiResourceProjection(),
      navigation: { targetKind: 'session', openSurface: request => { launches.push(request); return { ok: true }; } },
      openExternal: async url => { external.push(url); return true; } })).toBe(true);
    expect(launches).toEqual([{ destination: { pluginId: 'acme.forge', localId: 'details' },
      instanceKey: resource.url, input: { resource } }]);
    expect(external).toEqual([]);
  });

  it('opens externally for the preference, missing handler, or unavailable destination', async () => {
    const external: string[] = [];
    let launches = 0;
    const resource = { kind: 'pullRequest' as const, url: 'https://forge.example/acme/repo/pull/42' };
    const context = { projection: createPluginUiResourceProjection(), navigation: { targetKind: 'session' as const,
      openSurface: () => { launches++; return { ok: false as const, code: 'unavailable' as const, reason: 'unavailable' }; } },
      openExternal: async (url: string) => { external.push(url); return true; } };
    storage.setState({ settings: { ...initialSettings, scmResourceOpenLocation: 'github' } });
    await requestOpenResource(resource, context);
    expect(launches).toBe(0);
    storage.setState({ settings: { ...initialSettings, scmResourceOpenLocation: 'happier' } });
    await requestOpenResource(resource, context);
    await requestOpenResource({ ...resource, kind: 'issue' }, context);
    await requestOpenResource(resource, { ...context, projection: null });
    expect(launches).toBe(1);
    expect(external).toEqual([resource.url, resource.url, resource.url, resource.url]);
  });

  it.each(['app', 'project'] as const)('opens the app resource destination from %s without a singleton instance key', async targetKind => {
    const launches: unknown[] = [];
    const external: string[] = [];
    const resource = { kind: 'pullRequest' as const, url: 'https://forge.example/acme/repo/pull/42' };
    await requestOpenResource(resource, { projection: createPluginUiResourceProjection(true, 'app'),
      navigation: { targetKind, openSurface: request => { launches.push(request); return { ok: true }; } },
      openExternal: async url => { external.push(url); return true; } });
    expect(launches).toEqual([{ destination: { pluginId: 'acme.forge', localId: 'details' }, input: { resource } }]);
    expect(external).toEqual([]);
  });
});
