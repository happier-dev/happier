import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import type { PluginSurfaceContributedActionTransport } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';

import {
    buildPluginSearchProviderSections,
    PLUGIN_SEARCH_SECTION_ID_PREFIX,
    type BuildPluginSearchProviderSectionsInput,
} from './pluginSearchProviderSections';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

// The bundled package/declaration bytes are the system boundary. Account
// selection, projection, SDK registration and Action dispatch remain real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', async () => {
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { PluginUiArtifactsManifestEntryV2Schema } = await import('@happier-dev/protocol/plugins/ui');
    const { PluginSearchQueryV1Schema, PluginSearchResultV1Schema } = await import('@happier-dev/protocol/plugins/contributions/search-providers');
    const { projectPluginPortableUiDeclarationsV1 } = await import('@happier-dev/protocol/plugins/contributions/ui');
    const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: 'acme.account-search', version: '1.0.0',
        displayName: 'Account search', runtime: { apiVersion: 1 }, contributes: {
            actions: [{ id: 'query', title: 'Account search', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                dangerLevel: 'safe', readOnly: true, inputSchema: PluginSearchQueryV1Schema.jsonSchema,
                resultSchema: PluginSearchResultV1Schema.jsonSchema,
                execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } },
                { id: 'read-setting', title: 'Read setting', scopes: ['global'], surfaces: ['ui', 'plugin'], placementBindings: [],
                    dangerLevel: 'safe', readOnly: true,
                    execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } }],
            searchProviders: [{ id: 'entries', action: 'query' }],
        } });
    const digest = `sha256:${'a'.repeat(64)}`;
    const graph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'account-runtime', tier: 'reactNative',
        entry: 'react-native/account-runtime/entry.cjs.bundle', digest,
        files: [{ relativePath: 'react-native/account-runtime/entry.cjs.bundle', digest, byteSize: 1 }],
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0' });
    const declaration = { pluginId: manifest.id, pluginVersion: manifest.version, displayName: manifest.displayName,
        packageName: '@acme/account-search', normalizedManifest: manifest, artifactGraphs: [graph],
        entriesById: projectPluginPortableUiDeclarationsV1(manifest) };
    return { BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [], BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_PACKAGED_RESOURCES: [],
        BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [{ ...declaration, presentationManifest: manifest,
            loadDeclaration: async () => declaration }] };
});

// Real semantic routing, launch admission and Action dispatch run above this
// injected machine transport. No plugin process or network is opened here.
const executeAction = vi.fn<PluginSurfaceContributedActionTransport>();
const openSurface = vi.fn<PluginSurfaceOpenHandler>();

function actionResult(result: Extract<Awaited<ReturnType<PluginSurfaceContributedActionTransport>>, { supported: true }>['result']) {
    return { supported: true as const, result };
}

const SCOPED = Object.freeze({
    serverId: 'server-1',
    machineId: 'machine-1',
    interactionEnabled: true,
});

function hostOrigin(pluginId: string, machineId: string, generation: number) {
    return Object.freeze({
        machineId,
        serverId: `server-${machineId}`,
        interactionEnabled: true,
        phase: 'current' as const,
        executionOrigin: {
            serverIdentityId: 'srv_test',
            materializationRef: {
                pluginId,
                machineId,
                materializationId: `${machineId}:${pluginId}`,
            },
        },
    });
}

function projection(overrides: Partial<PluginUiProjectionModel> = {}): PluginUiProjectionModel {
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 7,
        searchProvidersById: Object.freeze({
            'searchProvider:happier.triage:entries': Object.freeze({
                id: 'searchProvider:happier.triage:entries',
                pluginId: 'happier.triage',
                occurrenceId: 'happier-triage-occurrence-7',
                contributionKind: 'searchProvider' as const,
                descriptorId: 'entries',
                identity: Object.freeze({ pluginId: 'happier.triage', localId: 'entries' }),
                action: Object.freeze({ pluginId: 'happier.triage', localId: 'search' }),
            }),
        }),
        actionsById: Object.freeze({
            'happier.triage/search': Object.freeze({
                id: 'search',
                pluginId: 'happier.triage',
                occurrenceId: 'happier-triage-occurrence-7',
                title: 'PRs & Issues',
                icon: 'action',
                scopes: ['global' as const],
                surfaces: ['ui' as const],
                execution: { target: 'daemon' as const },
                dangerLevel: 'safe',
                available: true,
            }),
        }),
        ...overrides,
    });
}

function sections(overrides: Partial<BuildPluginSearchProviderSectionsInput> = {}) {
    return buildPluginSearchProviderSections({
        projection: projection(),
        scopedLaunchFacts: SCOPED,
        rowLimit: 8,
        onCommitActivation: vi.fn(),
        execute: executeAction,
        openSurface,
        ...overrides,
    });
}

beforeEach(() => {
    executeAction.mockReset();
    openSurface.mockReset();
});

it.each(['account', 'machine', 'home', 'home partial'] as const)('queries Account data from a %s provider and fences its withdrawal', async providerPlacement => {
    const homeScope = providerPlacement === 'home' || providerPlacement === 'home partial';
    const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    const { createHomeHubArtifactHttpBoundary } = await import('@/dev/testkit/harness/homeHubArtifactHttpBoundary');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, retirePluginAccountAvailabilityProjection,
        clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
    const { unionPluginUiProjections, mergeInstalledPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
    const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
    const { PluginProjectionV2Schema, PluginProjectedActionV2Schema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
    const { widgetExecutionOrigin, widgetInstalledPackage } = await import('@/dev/testkit/fixtures/pluginWidgetProjectionFixtures');
    const { resolveProjectedPluginUiClientExecutables } = await import('@/components/plugins/reactNative/clientExecutableProjection');
    const { createPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
    const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
    const http = createHomeHubArtifactHttpBoundary('search-account');
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://account-search.test', accountId: 'search-account', request: http.request });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected real Account lifetime');
    const pluginId = 'acme.account-search';
    const actionKey = `${pluginId}/query`;
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const availability = readPluginAccountAvailability(lifetime.scope);
    const readCurrent = () => availability.readAccountUiProjection();
    const unpublish = publishCommittedAppShellPluginUiProjection(readCurrent);
    const account = readCurrent();
    const accountAction = account?.actionsById[actionKey];
    if (!account || !accountAction) throw new Error('Expected admitted Account query declaration');
    const executionOrigin = widgetExecutionOrigin(pluginId, 'machine-search');
    const occurrenceId = 'daemon-search:55';
    const rawAction = PluginProjectedActionV2Schema.parse({ id: 'query', pluginId, occurrenceId, executionOrigin,
        title: 'Account search', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
        readOnly: true, available: true, execution: accountAction.execution });
    const daemon = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { [pluginId]: { ...widgetInstalledPackage(pluginId, 'Account search'), version: '1.0.0', occurrenceId, executionOrigin } },
        actionsById: { [actionKey]: rawAction }, familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
            [`searchProvider:${pluginId}:entries`]: { id: `searchProvider:${pluginId}:entries`, pluginId, occurrenceId,
                contributionKind: 'searchProvider', descriptorId: 'entries', identity: { pluginId, localId: 'entries' }, action: { pluginId, localId: 'query' } },
        } } } }));
    const machineScoped = unionPluginUiProjections([{ machineId: 'machine-search', serverId: lifetime.scope.serverId,
        serverIdentityId: executionOrigin.serverIdentityId, projection: daemon, phase: 'current', interactionEnabled: true }],
    new Map([[pluginId, executionOrigin]])).pluginUiProjection;
    const scoped = providerPlacement !== 'machine' ? mergeInstalledPluginUiProjections([account], null) : machineScoped;
    if (!scoped) throw new Error('Expected real selected daemon provider projection');
    const targets = resolveProjectedPluginUiClientExecutables({ actionProjection: { projection: account }, platform: 'web' });
    expect(targets).toHaveLength(1);
    const cache = createPluginReactNativeBundleCache();
    for (const target of targets) cache.putInstalledArtifact({ identity: target.cacheIdentity, bytes: new Uint8Array([47, 47]), format: 'plainJs' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let queries = 0;
    let nestedRead: unknown;
    const activate = (api: import('@happier-dev/plugin-sdk').PluginAccountApi) => {
        api.actions.register('read-setting', async (_value, context) =>
            context.services.actions.execute('settings.get', { anchor: 'appearance.themeMode' }));
        api.actions.register('query', async (value, context) => {
            const queryNumber = ++queries;
            if (providerPlacement === 'home partial' && queryNumber === 2) throw new Error('source unavailable');
            nestedRead = await context.services.actions.execute({ pluginId, localId: 'read-setting' }, {});
            const query = value && typeof value === 'object' && !Array.isArray(value) ? value.query : null;
            if (typeof query !== 'string') throw new Error('Expected admitted Search query');
            if (query === 'hold') await gate;
            return { items: [{ id: 'match', title: query, command: { kind: 'executeAction', action: 'query', input: { query: 'activate', limit: 1 } } }], truncated: false };
        });
    };
    const composition = getInstalledPluginUiClientExecutableComposition();
    try {
        if (providerPlacement !== 'machine') {
            expect(buildPluginSearchProviderSections({ projection: scoped,
                scopedLaunchFacts: { serverId: lifetime.scope.serverId, machineId: null, interactionEnabled: true },
                accountLifetime: lifetime, onCommitActivation: vi.fn() })).toHaveLength(0);
        }
        const attempts = await composition.reconcile(targets.map(target => ({ pluginId, pluginVersion: target.pluginVersion,
            hostUiApiRange: target.hostUiApiRange, contributes: target.contributes, target: target.target,
            executionOrigin: target.executionOrigin, authority: target.authority, occurrenceId: target.occurrenceId,
            accountLifetime: lifetime, isCurrent: lifetime.isCurrent, cache, identity: target.cacheIdentity,
            moduleReference: target.moduleReference,
            // The package loader is the physical artifact boundary; its SDK registration transaction is real.
            backend: { backendId: 'commonJs', available: true, loadInstalledBundle: async () => activate as import('@/components/plugins/reactNative/loader').PluginReactNativeExecutableExport },
        })));
        expect(attempts).toMatchObject([{ result: { ok: true } }]);
        const { dispatchPluginResolvedSemanticCommand } = await import('@/components/plugins/surfaces/dispatchPluginResolvedSemanticCommand');
        expect(await dispatchPluginResolvedSemanticCommand({ projection: scoped, callerPluginId: pluginId,
            expectedAction: accountAction, command: { kind: 'executeAction', action: { pluginId, localId: 'read-setting' }, input: {} },
            scopedLaunchFacts: { serverId: lifetime.scope.serverId, machineId: null, interactionEnabled: true },
            accountLifetime: lifetime })).toMatchObject({ ok: false, reason: 'plugin_ui_action_unavailable' });
        expect(nestedRead).toBeUndefined();
        const onCommitActivation = vi.fn();
        const built = buildPluginSearchProviderSections({ projection: scoped,
            scopedLaunchFacts: { serverId: lifetime.scope.serverId, machineId: providerPlacement !== 'machine' ? null : 'machine-search', interactionEnabled: true },
            ...(homeScope ? { homeMachines: [
                { machineId: 'machine-one', name: 'First', reachable: true }, { machineId: 'machine-two', name: 'Second', reachable: true },
                { machineId: 'machine-offline', name: 'Offline', reachable: false },
            ] } : {}),
            accountLifetime: lifetime, isOccurrenceCurrent: (_id, occurrence) => occurrence === (providerPlacement !== 'machine' ? accountAction.occurrenceId : occurrenceId),
            onCommitActivation });
        expect(built).toHaveLength(1);
        const section = built[0]!;
        const result = await section.resolve('needle', new AbortController().signal);
        expect(result.options).toMatchObject([{ label: 'needle' }]);
        expect(nestedRead).toMatchObject({ anchor: 'appearance.themeMode' });
        expect(queries).toBe(homeScope ? 2 : 1);
        if (homeScope) expect(result.resultHint).toContain('Offline');
        if (providerPlacement === 'home partial') expect(result.resultHint).toContain('Second');
        result.options[0]!.onSelect?.();
        const pending = section.resolve('hold', new AbortController().signal);
        await vi.waitFor(() => expect(queries).toBe(homeScope ? 4 : 2));
        retirePluginAccountAvailabilityProjection([pluginId]);
        expect(readCurrent()?.actionsById[actionKey]).toBeUndefined();
        release();
        expect(await pending).toEqual({ options: [] });
        await expect(section.resolve('again', new AbortController().signal)).resolves.toEqual({ options: [] });
        expect(await onCommitActivation.mock.calls[0]![0]()).toMatchObject({ ok: false, reason: 'plugin_ui_generation_retired' });
        expect(queries).toBe(homeScope ? 4 : 2);
    } finally {
        release(); unpublish(); await composition.invalidatePlugin(pluginId);
        clearPluginAccountAvailabilityProjection(); await connection.dispose();
    }
});

describe('buildPluginSearchProviderSections', () => {
    it('queries a source-backed Machine provider through the real projection union', async () => {
        const { PluginProjectionV2Schema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { widgetInstalledPackage } = await import('@/dev/testkit/fixtures/pluginWidgetProjectionFixtures');
        const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const { unionPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
        const pluginId = 'qa.journey-machine-search';
        const machineId = 'machine-search';
        const serverId = 'srv_search';
        const occurrenceId = `${pluginId}:115`;
        const executionOrigin = { serverIdentityId: serverId, sourceRef: {
            machineId, pluginId, sourceCustody: { kind: 'development' as const, registeredRootId: '/tmp/journey-machine-search' },
        } };
        const daemon = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 115,
            installedPackagesById: { [pluginId]: { ...widgetInstalledPackage(pluginId, 'QA Machine Search'),
                version: '1.0.0', occurrenceId, executionOrigin } },
            actionsById: { [`${pluginId}/query`]: { id: 'query', pluginId, occurrenceId, executionOrigin,
                title: 'QA Machine Search', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                execution: { target: 'daemon' }, dangerLevel: 'safe', available: true } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                [`searchProvider:${pluginId}:fixture-search`]: { id: `searchProvider:${pluginId}:fixture-search`,
                    pluginId, occurrenceId, contributionKind: 'searchProvider', descriptorId: 'fixture-search',
                    identity: { pluginId, localId: 'fixture-search' }, action: { pluginId, localId: 'query' } },
            } } },
        }));
        const union = unionPluginUiProjections([{ machineId, serverId, serverIdentityId: serverId,
            projection: daemon, phase: 'current', interactionEnabled: true }], new Map([[pluginId, executionOrigin]]));
        executeAction.mockResolvedValue(actionResult({ ok: true, result: { items: [{ id: 'match',
            title: 'QA Machine Search: journey', command: { kind: 'executeAction', action: 'query' } }], truncated: false } }));
        const built = sections({ projection: union.pluginUiProjection,
            scopedLaunchFacts: { serverId, machineId, interactionEnabled: true } });
        expect(built).toHaveLength(1);
        expect(await built[0]!.resolve('journey', new AbortController().signal)).toMatchObject({
            options: [{ label: 'QA Machine Search: journey' }],
        });
    });

    it.each([true, false])('announces an empty plugin reply truthfully when truncated=%s', async (truncated) => {
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit');
        const { SelectionList } = await import('@/components/ui/selectionList');
        executeAction.mockResolvedValue(actionResult({ ok: true, result: { items: [], truncated } }));
        const screen = await renderScreen(React.createElement(SelectionList, {
            testID: 'empty-search', inputValue: 'needle', keyboardHintsEnabled: false, disableTransitions: true,
            rootStep: { id: 'root', inputPlaceholder: 'Search', sections: sections().map(section => ({ kind: 'dynamic' as const, ...section, debounceMs: 0 })) },
            onSelect: vi.fn(), onRequestClose: vi.fn(),
        }));
        try {
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
            const status = screen.findByTestId('empty-search:status');
            expect(status?.props.role).toBe('status');
            expect(screen.getTextContent()).toContain(truncated ? 'PRs & Issues · No matches in what was searched' : 'PRs & Issues · No matches');
            expect(screen.getTextContent()).not.toContain('More results are available');
            expect(screen.findByTestId('empty-search:section:plugin-search:happier.triage:entries:error')).toBeNull();
        } finally { await act(async () => screen.tree.unmount()); }
    });

    it('folds an external plugin root failure into the folder line while an untyped failure keeps Retry', async () => {
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit');
        const { SelectionList } = await import('@/components/ui/selectionList');
        const { buildUniversalSearchSections } = await import('./buildUniversalSearchSections');
        const { workspaceFolderMissingFailure } = await import('./universalSearchMachineFailures');
        const { t } = await import('@/text');
        const base = projection();
        const external = projection({
            searchProvidersById: Object.fromEntries(['root', 'untyped'].map(id => [`searchProvider:acme.${id}:entries`, {
                ...base.searchProvidersById['searchProvider:happier.triage:entries']!,
                id: `searchProvider:acme.${id}:entries`, pluginId: `acme.${id}`, occurrenceId: `occurrence-${id}`,
                identity: { pluginId: `acme.${id}`, localId: 'entries' },
                action: { pluginId: `acme.${id}`, localId: 'search' },
            }])),
            actionsById: Object.fromEntries(['root', 'untyped'].map(id => [`acme.${id}/search`, {
                ...base.actionsById['happier.triage/search']!,
                pluginId: `acme.${id}`, occurrenceId: `occurrence-${id}`, title: id,
            }])),
        });
        executeAction.mockImplementation(async (_machineId, call) => actionResult(call.qualifiedActionId === 'acme.root/search'
            ? { ok: true, result: { items: [], truncated: false, failure: { code: 'root_not_found' } } }
            : { ok: false, code: 'plugin_action_failed', message: 'private diagnostic' }));
        const paletteSections = buildUniversalSearchSections({
            query: 'needle', commands: [], sessions: [], projects: [], searchSettingsPages: () => [],
            transcript: { status: 'absent' }, files: { status: 'absent' }, commits: { status: 'absent' },
            pluginSections: sections({ projection: external }).map(section => ({ ...section, debounceMs: 0 })),
            onCommitResult: vi.fn(),
        });
        const screen = await renderScreen(React.createElement(SelectionList, {
            testID: 'r115', inputValue: 'needle', keyboardHintsEnabled: false, disableTransitions: true,
            rootStep: { id: 'root', inputPlaceholder: 'Search', sections: [
                { kind: 'dynamic', id: 'files', title: 'Files', debounceMs: 0,
                    resolve: async () => { throw workspaceFolderMissingFailure(); } },
                ...paletteSections,
            ] },
            onSelect: vi.fn(), onRequestClose: vi.fn(),
        }));
        try {
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
            expect(executeAction.mock.calls.map(([, call]) => call.qualifiedActionId).sort()).toEqual(['acme.root/search', 'acme.untyped/search']);
            expect(screen.getTextContent().split(t('errors.workspaceFolderMissing'))).toHaveLength(2);
            expect(screen.findByTestId('r115:section:plugin-search:acme.root:entries:error')).toBeNull();
            expect(screen.findByTestId('r115:section:plugin-search:acme.untyped:entries:error')).not.toBeNull();
            expect(screen.findByTestId('r115:section:plugin-search:acme.untyped:entries:error:retry')).not.toBeNull();
            expect(screen.getTextContent()).not.toContain('private diagnostic');
        } finally { await act(async () => screen.tree.unmount()); }
    });

    it('builds one qualified dynamic section per admitted provider', () => {
        const built = sections();
        expect(built).toHaveLength(1);
        expect(built[0]!.id).toBe(`${PLUGIN_SEARCH_SECTION_ID_PREFIX}happier.triage:entries`);
        expect(built[0]!.title).toBe('PRs & Issues');
        expect(built[0]!.resultFiltering).toBe('provider');
    });

    it('makes no provider request on an empty query', () => {
        const built = sections();
        expect(built[0]!.visibleWhen?.('')).toBe(false);
        expect(built[0]!.visibleWhen?.('   ')).toBe(false);
        expect(built[0]!.visibleWhen?.('pr')).toBe(true);
    });

    it('keeps the resolver across peer projection changes and rebinds for occurrence, machine, or server changes', () => {
        const first = sections()[0]!.resolverKey;
        const peerProjectionChange = sections({
            projection: projection({ generation: 8 }),
        })[0]!.resolverKey;
        const current = projection();
        const nextOccurrence = sections({
            projection: projection({
                searchProvidersById: Object.freeze({
                    'searchProvider:happier.triage:entries': Object.freeze({
                        ...current.searchProvidersById['searchProvider:happier.triage:entries'],
                        occurrenceId: 'happier-triage-occurrence-8',
                    }),
                }),
                actionsById: Object.freeze({
                    'happier.triage/search': Object.freeze({
                        ...current.actionsById['happier.triage/search']!,
                        occurrenceId: 'happier-triage-occurrence-8',
                    }),
                }),
            }),
        })[0]!.resolverKey;
        const otherMachine = sections({ scopedLaunchFacts: { ...SCOPED, machineId: 'machine-2' } })[0]!.resolverKey;
        const otherServer = sections({ scopedLaunchFacts: { ...SCOPED, serverId: 'server-2' } })[0]!.resolverKey;
        expect(peerProjectionChange).toBe(first);
        expect(new Set([first, nextOccurrence, otherMachine, otherServer]).size).toBe(4);
    });

    it('queries exact source-backed providers and rebinds when their source custody changes', async () => {
        const current = projection();
        const sourceOrigin = (registeredRootId: string) => ({
            ...hostOrigin('happier.triage', 'machine-1', 7),
            executionOrigin: {
                serverIdentityId: 'srv_test',
                sourceRef: {
                    pluginId: 'happier.triage',
                    machineId: 'machine-1',
                    sourceCustody: { kind: 'development' as const, registeredRootId },
                },
            },
        });
        const withSource = (providerRoot: string, actionRoot = providerRoot, generation = 7) => projection({
            generation,
            searchProvidersById: {
                'searchProvider:happier.triage:entries': {
                    ...current.searchProvidersById['searchProvider:happier.triage:entries']!,
                    hostOrigin: sourceOrigin(providerRoot),
                },
            },
            actionsById: {
                'happier.triage/search': {
                    ...current.actionsById['happier.triage/search']!,
                    hostOrigin: sourceOrigin(actionRoot),
                },
            },
        });
        const scopedLaunchFacts = { ...SCOPED, serverId: 'server-machine-1' };
        const first = sections({ projection: withSource('root-a'), scopedLaunchFacts });
        expect(first).toHaveLength(1);
        executeAction.mockResolvedValue(actionResult({
            ok: true,
            result: {
                items: [{ id: 'source-entry', title: 'Development result', command: { kind: 'executeAction', action: 'search' } }],
                truncated: false,
            },
        }));
        await expect(first[0]!.resolve('development', new AbortController().signal)).resolves.toMatchObject({
            options: [expect.objectContaining({ label: 'Development result' })],
        });
        expect(executeAction.mock.calls[0]).toEqual([
            'machine-1',
            expect.objectContaining({
                serverId: 'server-machine-1',
                qualifiedActionId: 'happier.triage/search',
                expectedContributorOccurrenceId: 'happier-triage-occurrence-7',
                input: { query: 'development', limit: 8 },
                executionSurface: 'ui',
            }),
        ]);
        const peerUpdate = sections({ projection: withSource('root-a', 'root-a', 8), scopedLaunchFacts });
        expect(peerUpdate[0]!.resolverKey).toBe(first[0]!.resolverKey);
        const replacement = sections({ projection: withSource('root-b'), scopedLaunchFacts });
        expect(replacement[0]!.resolverKey).not.toBe(first[0]!.resolverKey);
        expect(sections({ projection: withSource('root-a', 'root-b'), scopedLaunchFacts })).toHaveLength(0);
    });

    it('omits a provider whose query Action is unavailable or retired', () => {
        const unavailable = projection({
            actionsById: Object.freeze({
                'happier.triage/search': Object.freeze({
                    id: 'search',
                    pluginId: 'happier.triage',
                    occurrenceId: 'happier-triage-occurrence-7',
                    title: 'PRs & Issues',
                    scopes: ['global' as const],
                    surfaces: ['ui' as const],
                    execution: { target: 'daemon' as const },
                    dangerLevel: 'safe',
                    available: false,
                }),
            }),
        });
        expect(sections({ projection: unavailable })).toHaveLength(0);
        // Uninstalled: the descriptor is gone with the projection it came from.
        expect(sections({
            projection: projection({ searchProvidersById: Object.freeze({}) }),
        })).toHaveLength(0);
        expect(sections({ scopedLaunchFacts: { ...SCOPED, interactionEnabled: false } })).toHaveLength(0);
    });

    it('omits an ambient provider projected for another Home when Search scope changes', () => {
        const scopedProvider = {
            ...SCOPED,
            serverId: 'server-2',
            machineId: 'machine-2',
        };
        const providerWithOrigin = projection({
            searchProvidersById: Object.freeze({
                'searchProvider:happier.triage:entries': Object.freeze({
                    ...projection().searchProvidersById['searchProvider:happier.triage:entries'],
                    hostOrigin: hostOrigin('happier.triage', 'machine-1', 7),
                }),
            }),
        });
        expect(sections({ projection: providerWithOrigin, scopedLaunchFacts: scopedProvider })).toHaveLength(0);
    });

    it('treats null scope coordinates as unconstrained while preserving exact constraints', () => {
        const providerWithOrigin = projection({
            searchProvidersById: Object.freeze({
                'searchProvider:happier.triage:entries': Object.freeze({
                    ...projection().searchProvidersById['searchProvider:happier.triage:entries'],
                    hostOrigin: hostOrigin('happier.triage', 'machine-1', 7),
                }),
            }),
            actionsById: Object.freeze({
                'happier.triage/search': Object.freeze({
                    ...projection().actionsById['happier.triage/search'],
                    hostOrigin: hostOrigin('happier.triage', 'machine-1', 7),
                }),
            }),
        });

        // An exact Home with a coarse machine union still admits the provider.
        expect(sections({
            projection: providerWithOrigin,
            scopedLaunchFacts: { ...SCOPED, serverId: 'server-machine-1', machineId: null },
        })).toHaveLength(1);

        // A coarse Home union with an exact machine constrains only that machine.
        expect(sections({
            projection: providerWithOrigin,
            scopedLaunchFacts: { ...SCOPED, serverId: null, machineId: 'machine-1' },
        })).toHaveLength(1);
        expect(sections({
            projection: providerWithOrigin,
            scopedLaunchFacts: { ...SCOPED, serverId: null, machineId: 'machine-2' },
        })).toHaveLength(0);
    });

    it('queries the declared Action through the one dispatcher and renders its rows', async () => {
        executeAction.mockResolvedValue(actionResult({
            ok: true,
            result: {
                items: [{
                    id: 'entry-1',
                    title: 'Fix the crash',
                    subtitle: 'happier/happier',
                    command: { kind: 'openSurface', destination: 'triage', subPath: '' },
                }],
                truncated: true,
            },
        }));
        const controller = new AbortController();
        const resolved = await sections()[0]!.resolve('  pr  ', controller.signal);
        const [machineId, call] = executeAction.mock.calls[0]!;
        expect(machineId).toBe('machine-1');
        expect(call).toMatchObject({
            qualifiedActionId: 'happier.triage/search',
            expectedContributorOccurrenceId: 'happier-triage-occurrence-7',
            executionSurface: 'ui',
            serverId: 'server-1',
            input: { query: 'pr', limit: 8 },
        });
        expect(call.signal).toBe(controller.signal);
        expect(resolved.options).toHaveLength(1);
        expect(resolved.options[0]!.id).toBe(
            `${PLUGIN_SEARCH_SECTION_ID_PREFIX}happier.triage:entries::entry-1`,
        );
        expect(resolved.options[0]!.label).toBe('Fix the crash');
        expect(resolved.options[0]!.subtitle).toBe('happier/happier');
        expect(resolved.emptyHint).toBeUndefined();
        expect(resolved.resultHint).toBe('More results are available. Refine your search.');
    });

    it('uses each provider exact origin in a two-machine union even when coarse union coordinates are null', async () => {
        const firstOrigin = hostOrigin('acme.first', 'machine-a', 11);
        const secondOrigin = hostOrigin('acme.second', 'machine-b', 22);
        const union = projection({
            generation: 999,
            searchProvidersById: Object.freeze({
                'searchProvider:acme.first:entries': Object.freeze({
                    id: 'searchProvider:acme.first:entries',
                    pluginId: 'acme.first',
                    occurrenceId: 'acme-first-occurrence-11',
                    contributionKind: 'searchProvider' as const,
                    descriptorId: 'entries',
                    identity: Object.freeze({ pluginId: 'acme.first', localId: 'entries' }),
                    action: Object.freeze({ pluginId: 'acme.first', localId: 'search' }),
                    hostOrigin: firstOrigin,
                }),
                'searchProvider:acme.second:entries': Object.freeze({
                    id: 'searchProvider:acme.second:entries',
                    pluginId: 'acme.second',
                    occurrenceId: 'acme-second-occurrence-22',
                    contributionKind: 'searchProvider' as const,
                    descriptorId: 'entries',
                    identity: Object.freeze({ pluginId: 'acme.second', localId: 'entries' }),
                    action: Object.freeze({ pluginId: 'acme.second', localId: 'search' }),
                    hostOrigin: secondOrigin,
                }),
            }),
            actionsById: Object.freeze({
                'acme.first/search': Object.freeze({
                    id: 'search', pluginId: 'acme.first', occurrenceId: 'acme-first-occurrence-11', title: 'First', scopes: ['global' as const], surfaces: ['ui' as const],
                    execution: { target: 'daemon' as const }, dangerLevel: 'safe', available: true, hostOrigin: firstOrigin,
                }),
                'acme.second/search': Object.freeze({
                    id: 'search', pluginId: 'acme.second', occurrenceId: 'acme-second-occurrence-22', title: 'Second', scopes: ['global' as const], surfaces: ['ui' as const],
                    execution: { target: 'daemon' as const }, dangerLevel: 'safe', available: true, hostOrigin: secondOrigin,
                }),
            }),
        });
        executeAction.mockImplementation(async (_machineId, { qualifiedActionId, input }) => actionResult({
            ok: true,
            result: input
                ? {
                    items: [{
                        id: `${qualifiedActionId}-entry`,
                        title: `${qualifiedActionId} entry`,
                        command: { kind: 'executeAction', action: 'search' },
                    }],
                    truncated: false,
                }
                : null,
        }));

        const onCommitActivation = vi.fn();
        const built = buildPluginSearchProviderSections({
            projection: union,
            scopedLaunchFacts: {
                serverId: null,
                machineId: null,
                interactionEnabled: true,
            },
            onCommitActivation,
            execute: executeAction,
        });
        expect(built).toHaveLength(2);
        const resolved = await Promise.all(
            built.map((section) => section.resolve('entry', new AbortController().signal)),
        );

        expect(executeAction.mock.calls.map(([machineId, call]) => ({ machineId, serverId: call.serverId }))).toEqual([
            { serverId: 'server-machine-a', machineId: 'machine-a' },
            { serverId: 'server-machine-b', machineId: 'machine-b' },
        ]);
        expect(resolved.map(result => result.options[0]?.label)).toEqual([
            'acme.first/search entry', 'acme.second/search entry',
        ]);

        resolved[1]!.options[0]!.onSelect?.();
        await expect(onCommitActivation.mock.calls[0]![0]()).resolves.toEqual({ ok: true, result: null });
        const [machineId, activation] = executeAction.mock.calls[2]!;
        expect(machineId).toBe('machine-b');
        expect(activation).toMatchObject({
            serverId: 'server-machine-b',
            qualifiedActionId: 'acme.second/search',
            expectedContributorOccurrenceId: 'acme-second-occurrence-22',
            executionSurface: 'ui',
        });
        expect(activation.input).toBeUndefined();
    });

    it('fails the section locally on malformed provider output', async () => {
        executeAction.mockResolvedValue(actionResult({
            ok: true,
            result: { items: [{ id: 'entry-1', title: 'Fix', command: { kind: 'openLink', url: 'https://x' } }], truncated: false },
        }));
        await expect(sections()[0]!.resolve('pr', new AbortController().signal)).rejects.toThrow(
            /plugin_search_result_invalid/,
        );
    });

    it('fails only the duplicate-id provider while a healthy sibling provider still resolves', async () => {
        const siblingProjection = projection({
            searchProvidersById: Object.freeze({
                ...projection().searchProvidersById,
                'searchProvider:acme.healthy:entries': Object.freeze({
                    id: 'searchProvider:acme.healthy:entries',
                    pluginId: 'acme.healthy',
                    occurrenceId: 'acme-healthy-occurrence-7',
                    contributionKind: 'searchProvider' as const,
                    descriptorId: 'entries',
                    identity: Object.freeze({ pluginId: 'acme.healthy', localId: 'entries' }),
                    action: Object.freeze({ pluginId: 'acme.healthy', localId: 'search' }),
                }),
            }),
            actionsById: Object.freeze({
                ...projection().actionsById,
                'acme.healthy/search': Object.freeze({
                    id: 'search', pluginId: 'acme.healthy', occurrenceId: 'acme-healthy-occurrence-7', title: 'Healthy', scopes: ['global' as const], surfaces: ['ui' as const],
                    execution: { target: 'daemon' as const }, dangerLevel: 'safe', available: true,
                }),
            }),
        });
        executeAction.mockImplementation(async (_machineId, { qualifiedActionId }) => actionResult(qualifiedActionId === 'happier.triage/search'
            ? {
                ok: true,
                result: {
                    items: [
                        { id: 'same', title: 'One', command: { kind: 'executeAction', action: 'open' } },
                        { id: 'same', title: 'Two', command: { kind: 'executeAction', action: 'open' } },
                    ],
                    truncated: false,
                },
            }
            : {
                ok: true,
                result: {
                    items: [{ id: 'healthy', title: 'Healthy', command: { kind: 'executeAction', action: 'open' } }],
                    truncated: false,
                },
            }));
        const built = sections({ projection: siblingProjection });
        const duplicate = built.find((section) => section.id.includes('happier.triage'))!;
        const healthy = built.find((section) => section.id.includes('acme.healthy'))!;

        await expect(duplicate.resolve('entry', new AbortController().signal)).rejects.toThrow(
            /plugin_search_result_duplicate_id/,
        );
        await expect(healthy.resolve('entry', new AbortController().signal)).resolves.toMatchObject({
            options: [expect.objectContaining({ label: 'Healthy' })],
        });
    });

    it('preserves long queries, display labels and the host caller row limit', async () => {
        const query = '😀'.repeat(300);
        executeAction.mockResolvedValue(actionResult({ ok: true, result: {
            items: Array.from({ length: 100 }, (_, index) => ({
                id: `entry-${index}`, title: query, subtitle: query,
                command: { kind: 'executeAction', action: 'open' },
            })),
            truncated: false,
        } }));
        const result = await sections({ rowLimit: 80 })[0]!.resolve(query, new AbortController().signal);
        expect(executeAction.mock.calls[0]?.[1].input).toEqual({ query, limit: 80 });
        expect(result.options).toHaveLength(80);
        expect(result.options[0]).toMatchObject({ label: query, subtitle: query });
        expect(result.options[79]?.id).toBe('plugin-search:happier.triage:entries::entry-79');
        expect(result.resultHint).toBe('More results are available. Refine your search.');
    });

    it('reports host-side row truncation even when the provider forgot to mark it', async () => {
        executeAction.mockResolvedValue(actionResult({
            ok: true,
            result: {
                items: [
                    { id: 'entry-1', title: 'One', command: { kind: 'openSurface', destination: 'triage' } },
                    { id: 'entry-2', title: 'Two', command: { kind: 'openSurface', destination: 'triage' } },
                ],
                truncated: false,
            },
        }));
        const resolved = await sections({ rowLimit: 1 })[0]!.resolve(
            'pr',
            new AbortController().signal,
        );
        expect(resolved.options).toHaveLength(1);
        expect(resolved.resultHint).toBe('More results are available. Refine your search.');
    });

    it('fails the section locally on a typed dispatch failure', async () => {
        executeAction.mockResolvedValue(actionResult({ ok: false, code: 'plugin_ui_action_unavailable' }));
        await expect(sections()[0]!.resolve('pr', new AbortController().signal)).rejects.toThrow(
            /plugin_ui_action_unavailable/,
        );
    });

    it('stops before dispatching when the query is already cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(sections()[0]!.resolve('pr', controller.signal)).rejects.toThrow();
        expect(executeAction).not.toHaveBeenCalled();
    });

    it('does not publish query rows after the captured Account lifetime retires', async () => {
        let resolveQuery!: (value: Awaited<ReturnType<PluginSurfaceContributedActionTransport>>) => void;
        executeAction.mockImplementationOnce(() => new Promise((resolve) => {
            resolveQuery = resolve;
        }));
        let current = true;
        const accountLifetime = {
            scope: { serverId: 'server-a', accountId: 'account-a' },
            isCurrent: () => current,
            onRetire: () => ({ dispose: () => undefined }),
        };
        const section = sections({ accountLifetime, accountLifetimeRevision: 1 })[0]!;
        const pending = section.resolve('private', new AbortController().signal);
        await vi.waitFor(() => expect(executeAction).toHaveBeenCalledTimes(1));

        current = false;
        resolveQuery(actionResult({
            ok: true,
            result: {
                items: [{
                    id: 'private-entry',
                    title: 'Private entry',
                    command: { kind: 'executeAction', action: 'open-entry' },
                }],
                truncated: false,
            },
        }));

        await expect(pending).resolves.toEqual({ options: [] });
    });

    it('commits without dispatching, then activates through the incumbent semantic-command owner', async () => {
        executeAction.mockResolvedValueOnce(actionResult({
            ok: true,
            result: {
                items: [{
                    id: 'entry-1',
                    title: 'Fix the crash',
                    command: { kind: 'openSurface', destination: 'triage', input: { v: 1 }, subPath: '' },
                }],
                truncated: false,
            },
        }));
        openSurface.mockResolvedValue({ ok: true });
        const onCommitActivation = vi.fn();
        const built = buildPluginSearchProviderSections({
            projection: projection(),
            scopedLaunchFacts: SCOPED,
            rowLimit: 8,
            onCommitActivation,
            execute: executeAction,
            openSurface,
        });
        const resolved = await built[0]!.resolve('pr', new AbortController().signal);
        resolved.options[0]!.onSelect?.();
        expect(executeAction).toHaveBeenCalledTimes(1);
        expect(openSurface).not.toHaveBeenCalled();
        expect(onCommitActivation).toHaveBeenCalledTimes(1);
        const outcome = await onCommitActivation.mock.calls[0]![0]();
        expect(executeAction).toHaveBeenCalledTimes(1);
        expect(openSurface.mock.calls[0]![0]).toEqual({
            destination: { pluginId: 'happier.triage', localId: 'triage' },
            input: { v: 1 },
            subPath: '',
        });
        expect(outcome).toEqual({ ok: true });
    });

    it('refuses activation once the admitting generation is gone', async () => {
        executeAction.mockResolvedValue(actionResult({
            ok: true,
            result: {
                items: [{ id: 'entry-1', title: 'Fix', command: { kind: 'executeAction', action: 'open-entry' } }],
                truncated: false,
            },
        }));
        const onCommitActivation = vi.fn();
        let current = true;
        const accountLifetime = {
            scope: { serverId: 'server-a', accountId: 'account-a' },
            isCurrent: () => current,
            onRetire: () => ({ dispose: () => undefined }),
        };
        const built = buildPluginSearchProviderSections({
            projection: projection(),
            scopedLaunchFacts: SCOPED,
            rowLimit: 8,
            accountLifetime,
            accountLifetimeRevision: 1,
            onCommitActivation,
            execute: executeAction,
        });
        const resolved = await built[0]!.resolve('pr', new AbortController().signal);
        current = false;
        resolved.options[0]!.onSelect?.();
        expect(executeAction).toHaveBeenCalledTimes(1);
        const outcome = await onCommitActivation.mock.calls[0]![0]();
        expect(outcome).toEqual({
            ok: false,
            code: 'stale_surface',
            reason: 'plugin_ui_generation_retired',
        });
        expect(executeAction).toHaveBeenCalledTimes(1);
    });

    it('does not accept a replacement Account lifetime merely because its scope strings are identical', async () => {
        executeAction.mockResolvedValueOnce(actionResult({
            ok: true,
            result: {
                items: [{ id: 'entry-1', title: 'Private result', command: { kind: 'executeAction', action: 'open-entry' } }],
                truncated: false,
            },
        }));
        const onCommitActivation = vi.fn();
        let admittingLifetimeCurrent = true;
        const admittingLifetime = {
            scope: { serverId: 'server-a', accountId: 'account-a' },
            isCurrent: () => admittingLifetimeCurrent,
            onRetire: () => ({ dispose: () => undefined }),
        };
        const built = buildPluginSearchProviderSections({
            projection: projection(),
            scopedLaunchFacts: SCOPED,
            accountLifetime: admittingLifetime,
            accountLifetimeRevision: 4,
            onCommitActivation,
            execute: executeAction,
        });
        const resolved = await built[0]!.resolve('private', new AbortController().signal);

        admittingLifetimeCurrent = false;
        const replacementLifetime = {
            scope: { ...admittingLifetime.scope },
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        };
        expect(replacementLifetime.scope).toEqual(admittingLifetime.scope);
        resolved.options[0]!.onSelect?.();

        await expect(onCommitActivation.mock.calls[0]![0]()).resolves.toEqual({
            ok: false,
            code: 'stale_surface',
            reason: 'plugin_ui_generation_retired',
        });
        expect(executeAction).toHaveBeenCalledTimes(1);
    });

    it('replaces and removes provider sections across update, disable, and uninstall lifecycle changes', () => {
        const original = sections()[0]!;
        const current = projection();
        const updated = sections({ projection: projection({
            generation: 8,
            searchProvidersById: Object.freeze({
                'searchProvider:happier.triage:entries': Object.freeze({
                    ...current.searchProvidersById['searchProvider:happier.triage:entries'],
                    occurrenceId: 'happier-triage-occurrence-8',
                }),
            }),
            actionsById: Object.freeze({
                'happier.triage/search': Object.freeze({
                    ...current.actionsById['happier.triage/search']!,
                    occurrenceId: 'happier-triage-occurrence-8',
                }),
            }),
        }) })[0]!;
        expect(updated.id).toBe(original.id);
        expect(updated.resolverKey).not.toBe(original.resolverKey);
        expect(sections({ scopedLaunchFacts: { ...SCOPED, interactionEnabled: false } })).toEqual([]);
        expect(sections({ projection: projection({ searchProvidersById: Object.freeze({}) }) })).toEqual([]);
    });
});
