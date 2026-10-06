import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1,
    PluginProjectionV2Schema, SessionCurrentProjectionRecordV1Schema, SessionListQueryResponseV1Schema, projectLegacySessionAccessCapabilitiesV1,
    tryWriteServerEnabledBitInPlace, type PluginProjectionV2 } from '@happier-dev/protocol';
import { normalizePluginUiInlineSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionSurfaceItemV1Schema, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import { widgetCandidateDefinitionV1 } from '@happier-dev/protocol/widgets';

import { manifest as publicAuthoringManifest } from '../../../../../../packages/plugin-sdk/examples/public-authoring/index.ts';
import { readCanonicalPluginManifest } from '../../../../../cli/src/plugins/manifest/normalize.ts';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { answerMachineProjectionDescribeAtRpcBoundary } from '@/dev/testkit/mocks/machineProjectionRpc';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { storage } from '@/sync/domains/state/storage';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjection';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import type { SessionBoardItemProjection, SessionBoardMountHost } from '@/sync/domains/session/board';
import { selectWidgetCandidates } from '@/components/widgets/widgetCatalog';

import { SessionWidgetHost } from './SessionWidgetHost';
import { createSessionBoardSourceAvailabilityResolver } from './sessionBoardItemPresentation';

/**
 * The shared widget shell's installed arm across placements.
 *
 * The failure pinned here is invisible until it costs something: a Board card, a
 * compact sidebar card and a Companion card all showing the same item, each
 * starting its own executable plugin frame, Host API binding and Resource
 * subscription just to look busy. The one-primary rule says only the placement
 * the Session shell selected may run; the others are inert references.
 *
 * Only the foreign executable renderer is replaced. Shell admission, the
 * incumbent host, exact-target snapshots and physical lifetimes run for real.
 */

const state = vi.hoisted(() => ({
    mounts: [] as Record<string, unknown>[],
    activeMountKeys: new Set<string>(),
    session: null as ReturnType<typeof createSessionFixture> | null,
    serverId: '',
    daemonProjection: null as PluginProjectionV2 | null,
    detailResponse: null as Promise<Response> | null,
    detailRequested: false,
    mountedProps: new Map<string, Record<string, unknown>>(),
}));

installDisconnectedServerSocketBoundary();
// The generic Node stub creates a router per render. A mounted host needs the
// navigation SDK's stable router identity, supplied by the canonical boundary.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
// The daemon's describe RPC is the external producer boundary. Catalog,
// currentness, exact Session selection and input admission remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (params: { method: string; machineId: string; payload?: { pluginId?: string } }) => {
        if (params.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
            const pluginId = params.payload?.pluginId;
            const entry = Object.values(state.daemonProjection?.familiesById.pluginUi?.entriesById ?? {})
                .find(entry => entry.pluginId === pluginId);
            return { status: 'current', targetedContributions: {
                target: { pluginId, occurrenceId: entry?.occurrenceId,
                    sourceCustody: { kind: 'development', registeredRootId: `${pluginId}-fixture` } }, points: [],
            }, targetedSurfaceMounts: [] };
        }
        return answerMachineProjectionDescribeAtRpcBoundary(() => ({
            supported: true, projection: state.daemonProjection,
        }))(params);
    },
}));

vi.mock('@/components/plugins/surfaces', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/components/plugins/surfaces')>();
    return { ...original, PluginInlineSurfaceHost: (props: React.ComponentProps<typeof original.PluginInlineSurfaceHost>) => {
        state.mountedProps.set(String(props.mountInstanceKey), props);
        return React.createElement(original.PluginInlineSurfaceHost, props);
    } };
});

// This boundary stands for foreign plugin code; the host prepares its real
// RenderContext and controller lifetime before reaching it.
vi.mock('@/components/plugins/reactNative/PluginReactNativeSurface', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/components/plugins/reactNative/PluginReactNativeSurface')>();
    return { ...original, PluginReactNativeSurface: (props: React.ComponentProps<typeof original.PluginReactNativeSurface>) => {
        const mountInstanceKey = String(props.mountInstanceKey);
        React.useEffect(() => {
            const mounted = state.mountedProps.get(mountInstanceKey);
            if (!mounted) throw new Error('The foreign renderer must have a real inline host');
            state.mounts.push(mounted);
            state.activeMountKeys.add(mountInstanceKey);
            return () => { state.activeMountKeys.delete(mountInstanceKey); };
        }, [mountInstanceKey]);
        return React.createElement('ForeignWidgetRenderer');
    } };
});

// The generated app-package byte inventory is intentionally absent from the
// source-only remote test mirror. Installed-surface correlation/currentness is
// below that Artifact-read boundary. The foreign renderer never loads bytes.
vi.mock('@/sync/domains/plugins/availability/bundledAppExactArtifactSource', () => ({
    createBundledPluginUiAppExactArtifactSource: () => null,
}));

const SURFACE = { pluginId: 'acme.review', localId: 'review-status-widget' } as const;
const wireProjections = new WeakMap<NonNullable<SessionPluginRuntimeState['pluginUiProjection']>, PluginProjectionV2>();

function sessionHttpRecord(session: ReturnType<typeof createSessionFixture>) {
    const owner = createSessionOwnerMetadataV1({ metadata: session.metadata });
    if (!owner.ok) throw new Error('Expected canonical owner metadata');
    // The loaded sharing feature opts exact detail into accessProjectionVersion=1.
    // Detail and native options must serve the same current server projection.
    return SessionCurrentProjectionRecordV1Schema.parse({
        id: session.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
        active: session.active, activeAt: session.activeAt, archivedAt: null,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: session.metadata })), metadataVersion: 1,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), ownerMetadataVersion: 1,
        agentState: null, agentStateVersion: 1, share: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) },
        viewer: { readState: { state: 'not_started' }, relevance: { relevant: false, reasons: [] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            follow: { follows: false, notificationLevel: 'none' }, notification: { level: 'none', source: 'preference' } },
        responsibleAccountId: null, responsibleAccount: null,
    });
}

function projectFixture(wire: PluginProjectionV2) {
    const family = wire.familiesById.pluginUi;
    const entries = Object.values(family?.entriesById ?? {});
    const renderers = entries.filter(entry => entry.contributionKind === 'surfacePlacement').map(entry => {
        const renderer = entry.renderer as { contributionId: string };
        const artifactId = `${entry.pluginId}-widget`;
        const digest = `sha256:${'a'.repeat(64)}`;
        const relativePath = `react-native/${artifactId}/entry.cjs.bundle`;
        return { id: `reactNativeBundle:${entry.pluginId}:${renderer.contributionId}`, pluginId: entry.pluginId,
            occurrenceId: entry.occurrenceId, contributionKind: 'reactNativeBundle', contributionId: renderer.contributionId,
            generatedV2: true, pluginVersion: '1.0.0', artifactGraph: { artifactId, tier: 'reactNative', entry: relativePath,
                files: [{ relativePath, digest: `sha256:${'b'.repeat(64)}`, byteSize: 16 }], digest,
                builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0' },
            runtime: { decision: { state: 'load', reason: 'compatible', diagnostics: [] }, loadPolicy: { source: 'installedArtifact' },
                cacheKey: artifactId, cacheIdentity: { artifactDigest: digest } } };
    });
    const current = PluginProjectionV2Schema.parse({ ...wire, installedPackagesById: Object.fromEntries(Object.entries(wire.installedPackagesById)
        .map(([id, pkg]) => [id, { ...pkg, occurrenceId: entries.find(entry => entry.pluginId === id)?.occurrenceId, version: '1.0.0' }])),
        familiesById: { ...wire.familiesById, ...(family ? { pluginUi: { ...family,
            entriesById: { ...family.entriesById, ...Object.fromEntries(renderers.map(renderer => [renderer.id, renderer])) } } } : {}) } });
    const projection = normalizePluginUiProjection(current);
    wireProjections.set(projection, current);
    return projection;
}

function publicAuthoringProjection() {
    const manifest = readCanonicalPluginManifest(publicAuthoringManifest);
    if (!manifest) throw new Error('the maintained public-authoring manifest must remain canonical');
    const view = manifest.contributes.ui.views.find((candidate) => candidate.id === 'review-status-widget');
    if (!view) throw new Error('the maintained public-authoring example must emit review-status-widget');
    const rendererIds = manifest.contributes.ui.renderers.map((candidate) => candidate.id);
    const binding = normalizePluginUiInlineSurfaceBindingV1({
        pluginId: manifest.id,
        surfaceId: view.id,
        rendererId: view.renderer,
        fallbackRendererIds: view.fallbackRenderers,
        availableRendererIds: rendererIds,
        role: view.container,
        target: view.target,
    });
    if (!binding) throw new Error('the emitted public-authoring widget must remain Registry-admitted');
    const primaryRenderer = manifest.contributes.ui.renderers.find((candidate) => candidate.id === view.renderer);
    if (!primaryRenderer) throw new Error('the emitted public-authoring widget renderer must be present');
    const entry = {
        id: `surfacePlacement:${manifest.id}:${view.id}`,
        pluginId: manifest.id,
        contributionKind: 'surfacePlacement',
        descriptorId: view.id,
        // The daemon producer stamps every projected UI entry with its plugin-slot occurrence.
        occurrenceId: `${manifest.id}#1`,
        binding,
        target: binding.target,
        renderer: { kind: primaryRenderer.kind, contributionId: primaryRenderer.id },
        display: { title: view.title },
        inputs: view.inputs,
        inputSchema: view.inputSchema,
        sessionInputPath: view.sessionInputPath,
        availability: { state: 'available', reason: 'available', diagnostics: [] },
    };
    return projectFixture(PluginProjectionV2Schema.parse({
        v: 2,
        generation: 17,
        installedPackagesById: {
            [manifest.id]: {
                id: manifest.id,
                displayName: manifest.displayName,
                version: manifest.version,
                enabled: true,
                immutableGenerationId: 'public-authoring-generation-17',
                source: { kind: 'path', locator: '/fixtures/public-authoring' },
            },
        },
        actionsById: {},
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [entry.id]: entry } } },
    }));
}

function projection(options: Readonly<{
    generation?: number;
    installed?: boolean;
    includePlacement?: boolean;
    availability?: 'available' | 'disabled';
}> = {}) {
    const binding = normalizePluginUiInlineSurfaceBindingV1({
        pluginId: SURFACE.pluginId,
        surfaceId: SURFACE.localId,
        rendererId: 'review-native',
        role: 'widget',
        target: { kind: 'session' },
    });
    if (!binding) throw new Error('fixture must use an admitted inline binding');
    const entry = {
        id: `surfacePlacement:${SURFACE.pluginId}:${SURFACE.localId}`,
        pluginId: SURFACE.pluginId,
        contributionKind: 'surfacePlacement',
        descriptorId: SURFACE.localId,
        occurrenceId: `${SURFACE.pluginId}#${options.generation ?? 3}`,
        binding,
        target: binding.target,
        renderer: { kind: 'reactNative', contributionId: 'review-native' },
        display: { title: 'Review status' },
        inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true },
            { path: 'view', title: 'View', widget: 'text' }] },
        inputSchema: { type: 'object', properties: { session: { type: 'object',
            properties: { serverId: { type: 'string' }, sessionId: { type: 'string' } }, required: ['serverId', 'sessionId'], additionalProperties: false },
            view: { type: 'string' } }, required: ['session'], additionalProperties: false },
        sessionInputPath: 'session',
        availability: options.availability === 'disabled'
            ? { state: 'disabled', reason: 'plugin_disabled', diagnostics: [] }
            : { state: 'available', reason: 'available', diagnostics: [] },
    };
    return projectFixture(PluginProjectionV2Schema.parse({
        v: 2,
        generation: options.generation ?? 3,
        installedPackagesById: options.installed === false ? {} : {
            [SURFACE.pluginId]: {
                id: SURFACE.pluginId,
                displayName: 'Review Assistant',
                enabled: true,
                source: { kind: 'local', locator: '/plugins/acme.review' },
            },
        },
        actionsById: {},
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: options.includePlacement === false ? {} : { [entry.id]: entry },
            },
        },
    }));
}

function runtime(overrides: Partial<SessionPluginRuntimeState> = {}): SessionPluginRuntimeState {
    return {
        pluginUiProjection: projection(),
        pluginBrowserProjection: null,
        phase: 'current',
        interactionEnabled: true,
        machineId: 'machine-a',
        serverId: state.serverId,
        platform: 'web',
        ...overrides,
    };
}

const item: SessionBoardItemProjection = {
    itemId: 'widget-1',
    revision: 'rev-1',
    state: {
        kind: 'ready',
        item: SessionSurfaceItemV1Schema.parse({
            v: 1,
            title: 'Review status',
            frame: 'card',
            height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: { v: 1, id: 'widget-1', definition: { kind: 'installed', surface: SURFACE },
                bindings: { session: { kind: 'context', slot: 'session' }, view: { kind: 'value', value: 'summary' } } } },
        }),
    },
};

function FixtureHost(props: React.ComponentProps<typeof SessionWidgetHost>): React.ReactElement {
    const current = props.pluginRuntime;
    if (!current) throw new Error('The mounted fixture requires a current runtime');
    React.useLayoutEffect(() => {
        state.daemonProjection = current.pluginUiProjection ? wireProjections.get(current.pluginUiProjection) ?? null : null;
        publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-a', serverId: state.serverId });
    }, [current.pluginUiProjection]);
    return <AppShellPluginUiProjectionValueProvider value={{ ...current, clientExecutableActivation: { status: 'ready' },
        reloadClientExecutables() {}, reloadConnectedAccountProjection() {} }}>
        <SessionWidgetHost {...props} serverId={state.serverId} />
    </AppShellPluginUiProjectionValueProvider>;
}

async function renderPlacement(input: Readonly<{
    host: SessionBoardMountHost;
    primaryHost: SessionBoardMountHost | null;
    density: 'full' | 'compact' | 'preview';
    expanded?: boolean;
    runtimeOverrides?: Partial<SessionPluginRuntimeState>;
    onManagePlugin?: () => void;
    onOpenHere?: () => void;
    onSetInputs?: React.ComponentProps<typeof SessionWidgetHost>['onSetInputs'];
    executableCurrentness?: 'current' | 'stale' | 'offline' | 'unverified';
}>) {
    const current = { ...runtime(), ...input.runtimeOverrides };
    return await renderScreen(React.createElement(FixtureHost, {
        sessionId: 'session-1',
        session: state.session ?? undefined,
        item,
        host: input.host,
        primaryHost: input.primaryHost,
        density: input.density,
        expanded: input.expanded,
        canEdit: true,
        executableCurrentness: input.executableCurrentness ?? 'current',
        heightBounds: { min: 96, max: 520 },
        pluginRuntime: current,
        resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver(current),
        ...(input.onManagePlugin ? { onManagePlugin: input.onManagePlugin } : {}),
        ...(input.onOpenHere ? { onOpenHere: input.onOpenHere } : {}),
        ...(input.onSetInputs ? { onSetInputs: input.onSetInputs } : {}),
        testID: 'widget',
    }));
}

function actionsOf(screen: Awaited<ReturnType<typeof renderScreen>>): ReadonlyArray<Record<string, unknown>> {
    const owners = screen.tree.root.findAll(
        (node) => Array.isArray((node.props as { actions?: unknown }).actions)
            && (node.props as { overflowTriggerTestID?: string }).overflowTriggerTestID === 'widget-actions',
        { deep: true },
    );
    return (owners.at(-1)?.props as { actions?: ReadonlyArray<Record<string, unknown>> } | undefined)
        ?.actions ?? [];
}

async function pressPluginRecovery(screen: Awaited<ReturnType<typeof renderScreen>>, onManagePlugin: () => void) {
    const findCard = () => screen.tree.root.findAll(node => typeof node.props.testID === 'string'
        && node.props.action?.onPress === onManagePlugin, { deep: true })[0];
    await vi.waitFor(() => {
        const cards = screen.tree.root.findAll(node => typeof node.props.diagnosticCode === 'string', { deep: true })
            .map(node => ({ testID: node.props.testID, code: node.props.diagnosticCode,
                action: Boolean(node.props.action), suppliedAction: node.props.action?.onPress === onManagePlugin }));
        expect(findCard(), JSON.stringify(cards)).toBeDefined();
    });
    const card = findCard();
    if (!card) throw new Error('Expected the visible plugin-management recovery');
    const actionTestId = card.props.action.testID ?? `${card.props.testID}-action`;
    expect(screen.findByTestId(actionTestId)).not.toBeNull();
    await screen.pressByTestIdAsync(actionTestId);
}

describe('SessionWidgetHost installed surface placements', () => {
    beforeEach(async () => {
        standardCleanup();
        await import('@/sync/syncEngine');
        state.mounts = [];
        state.activeMountKeys.clear();
        state.mountedProps.clear();
        const previous = storage.getState();
        state.detailResponse = null;
        state.detailRequested = false;
        const http = createHomeHubArtifactHttpBoundary('viewer');
        const features = createRootLayoutFeaturesResponse();
        if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Expected the canonical Board feature');
        const connection = await restoreServerAccountForTest({ serverUrl: 'http://session-widget-host.test', accountId: 'viewer',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
                // A missing persisted Board layout is a valid empty layout,
                // unlike a malformed HTTP envelope. Catalog admission reads it.
                if (path === '/v2/sessions/session-1/system-records/record') return Response.json({ record: null });
                if (path === '/v2/sessions/session-1/system-records') return Response.json({ records: [], nextCursor: null, hasNext: false });
                if (path === '/v2/sessions/query') {
                    const session = state.session;
                    if (!session) throw new Error('Expected the current exact Session for native options');
                    return Response.json(SessionListQueryResponseV1Schema.parse({ sessions: [sessionHttpRecord(session)],
                        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }));
                }
                if (new URL(String(url)).pathname === '/v2/sessions/session-1' && state.detailResponse) {
                    state.detailRequested = true;
                    // Each HTTP read owns a fresh body, even when multiple
                    // legitimate hydration consumers share the held response.
                    return (await state.detailResponse).clone();
                }
                return http.request(url, init);
            } });
        state.serverId = connection.home.id;
        state.daemonProjection = null;
        clearDaemonMergedProjectionCacheForTests();
        state.session = createSessionFixture({ id: 'session-1', serverId: state.serverId,
            metadata: { path: '/fixture', host: 'fixture', machineId: 'machine-a' } });
        const machine = createMachineFixture({ id: 'machine-a', activeAt: Date.now() });
        storage.setState({ endpointStatus: 'online', sessions: { [state.session.id]: state.session },
            sessionListRowsByServerId: { [state.serverId]: { [state.session.id]: createSessionListRenderableSessionFixture(state.session) } },
            machines: { [machine.id]: machine }, machineListByServerId: { [state.serverId]: [machine] } });
        onTestFinished(async () => {
            standardCleanup();
            clearDaemonMergedProjectionCacheForTests();
            await connection.dispose();
            storage.setState(previous, true);
        });
    });

    it('mounts the maintained emitted public-authoring widget through the real candidate and host path', async () => {
        const restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
        onTestFinished(restoreExecutorModuleLoader);
        const pluginUiProjection = publicAuthoringProjection();
        const candidate = selectWidgetCandidates(pluginUiProjection, { platform: 'web' }).find(
            (value) => value.target === 'session' && value.surface?.pluginId === publicAuthoringManifest.id
                && value.surface?.localId === 'review-status-widget',
        );
        expect(candidate).toMatchObject({
            surface: {
                pluginId: publicAuthoringManifest.id,
                localId: 'review-status-widget',
            },
        });
        if (!candidate) throw new Error('the maintained public-authoring widget must be selectable');

        const publicItem: SessionBoardItemProjection = {
            itemId: 'public-authoring-widget',
            revision: 'public-authoring-revision-1',
            state: {
                kind: 'ready',
                item: SessionSurfaceItemV1Schema.parse({
                    v: 1,
                    title: candidate.title,
                    frame: 'card',
                    height: { mode: 'auto', fallback: 'regular' },
                    source: { kind: 'widget', instance: { v: 1, id: 'public-widget-1', definition: widgetCandidateDefinitionV1(candidate),
                        bindings: { session: { kind: 'context', slot: 'session' }, view: { kind: 'value', value: 'summary' } } } },
                }),
            },
        };
        const current = runtime({ pluginUiProjection });
        const renderPublicWidget = (executableCurrentness: 'current' | 'stale') => React.createElement(FixtureHost, {
            sessionId: 'session-1',
            session: state.session ?? undefined,
            item: publicItem,
            host: 'details' as const,
            primaryHost: 'details' as const,
            density: 'full' as const,
            canEdit: true,
            executableCurrentness,
            heightBounds: { min: 96, max: 520 },
            pluginRuntime: current,
            resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver(current),
            testID: 'public-authoring-widget',
        });

        const screen = await renderScreen(renderPublicWidget('current'));
        await vi.waitFor(async () => {
            await flushHookEffects();
            const diagnosticCodes = screen.tree.root.findAll(node => typeof node.props.diagnosticCode === 'string', { deep: true })
                .map(node => node.props.diagnosticCode);
            expect(state.mounts, diagnosticCodes.join(',')).toHaveLength(1);
        });
        expect(state.mounts[0]).toMatchObject({
            placement: {
                pluginId: publicAuthoringManifest.id,
                descriptorId: 'review-status-widget',
            },
            inlineMount: { role: 'widget', presentation: 'content' },
            launchInput: { session: { serverId: state.serverId, sessionId: 'session-1' }, view: 'summary' },
        });

        await screen.update(renderPublicWidget('stale'));
        expect(state.activeMountKeys).toEqual(new Set());
    });

    it('mounts the plugin exactly once in the shell-selected primary placement', async () => {
        // The compact sidebar is a real promised host and is the cheapest one to
        // render, so this pins the mount contract without dragging the spacious
        // grid's chrome into every assertion.
        await renderPlacement({ host: 'sidebar', primaryHost: 'sidebar', density: 'compact' });
        expect(state.mounts).toHaveLength(1);
        expect(state.mounts[0]!.launchInput).toEqual({ session: { serverId: state.serverId, sessionId: 'session-1' }, view: 'summary' });
        expect(state.detailRequested).toBe(false);
    });

    it('uses current installed-frame height for Auto, ignores it while fixed, and restores it with Fit content', async () => {
        const onSetHeight = vi.fn();
        const renderWidget = (height: SessionSurfaceItemV1['height']) => React.createElement(FixtureHost, {
            sessionId: 'session-1',
            session: state.session ?? undefined,
            item: {
                ...item,
                state: item.state.kind === 'ready'
                    ? { kind: 'ready' as const, item: { ...item.state.item, height } }
                    : item.state,
            },
            host: 'details' as const,
            primaryHost: 'details' as const,
            density: 'full' as const,
            canEdit: true,
            executableCurrentness: 'current' as const,
            heightBounds: { min: 96, max: 520 },
            pluginRuntime: runtime(),
            resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver(runtime()),
            onSetHeight,
            testID: 'widget',
        });
        const screen = await renderScreen(renderWidget({ mode: 'auto', fallback: 'regular' }));
        const reportHeight = state.mounts.at(-1)?.onIntrinsicHeightChange as ((height: number) => void) | undefined;
        expect(reportHeight).toEqual(expect.any(Function));

        await act(async () => { reportHeight?.(432); });
        expect(screen.findByTestId('widget-body')?.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ height: 432 }),
        ]));

        await screen.update(renderWidget({ mode: 'fixed', size: 'compact' }));
        await act(async () => { reportHeight?.(500); });
        expect(screen.findByTestId('widget-body')?.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ height: 160 }),
        ]));

        const fitContent = actionsOf(screen).find((action) => action.id === 'height-auto');
        (fitContent?.onPress as (() => void) | undefined)?.();
        expect(onSetHeight).toHaveBeenLastCalledWith({ mode: 'auto', fallback: 'tall' });

        await screen.update(renderWidget({ mode: 'auto', fallback: 'tall' }));
        expect(screen.findByTestId('widget-body')?.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ height: 500 }),
        ]));
    });

    it('supplies the existing plugin-management recovery to the incumbent host for late lifecycle refusal', async () => {
        const managePlugin = vi.fn();
        await renderPlacement({
            host: 'details',
            primaryHost: 'details',
            density: 'full',
            onManagePlugin: managePlugin,
        });

        const action = state.mounts[0]?.unavailableAction as Readonly<{
            label: string;
            onPress: () => void;
        }> | undefined;
        expect(action?.label).toEqual(expect.any(String));
        action?.onPress();
        expect(managePlugin).toHaveBeenCalledOnce();
    });

    it('retains one item through disabled and uninstalled states and remounts a fresh H lifetime on reinstall', async () => {
        const managePlugin = vi.fn();
        const removeFromBoard = vi.fn();
        const renderWidget = (current: SessionPluginRuntimeState) => React.createElement(FixtureHost, {
            sessionId: 'session-1',
            session: state.session ?? undefined,
            item,
            host: 'companion' as const,
            primaryHost: 'companion' as const,
            density: 'compact' as const,
            canEdit: true,
            executableCurrentness: 'current' as const,
            heightBounds: { min: 96, max: 520 },
            pluginRuntime: current,
            resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver(current),
            onManagePlugin: managePlugin,
            onRemove: removeFromBoard,
            testID: 'widget',
        });
        const generationG = runtime({ pluginUiProjection: projection({ generation: 7 }) });
        const screen = await renderScreen(renderWidget(generationG));
        const generationGMountKey = state.mounts.at(-1)?.mountInstanceKey;

        const disabled = runtime({
            pluginUiProjection: projection({ generation: 8, availability: 'disabled' }),
        });
        await screen.update(renderWidget(disabled));
        // The canonical availability owner retires the executable mount before
        // publishing the two valid lifecycle recoveries on the inert card.
        expect(state.activeMountKeys).toEqual(new Set());
        await pressPluginRecovery(screen, managePlugin);
        await act(async () => { (actionsOf(screen).find(action => action.id === 'remove')?.onPress as (() => void) | undefined)?.(); });
        expect(managePlugin).toHaveBeenCalledOnce();
        expect(removeFromBoard).toHaveBeenCalledOnce();

        managePlugin.mockClear();
        removeFromBoard.mockClear();

        const uninstalled = runtime({
            pluginUiProjection: projection({ generation: 9, installed: false, includePlacement: false }),
        });
        await screen.update(renderWidget(uninstalled));
        expect(state.activeMountKeys).toEqual(new Set());
        await pressPluginRecovery(screen, managePlugin);
        await act(async () => { (actionsOf(screen).find(action => action.id === 'remove')?.onPress as (() => void) | undefined)?.(); });
        expect(managePlugin).toHaveBeenCalledOnce();
        expect(removeFromBoard).toHaveBeenCalledOnce();

        const generationH = runtime({ pluginUiProjection: projection({ generation: 10 }) });
        await screen.update(renderWidget(generationH));
        expect(state.mounts.at(-1)?.mountInstanceKey).not.toBe(generationGMountKey);
        expect(state.activeMountKeys).toEqual(new Set([String(state.mounts.at(-1)?.mountInstanceKey)]));
        // The shared record identity/revision never changed; lifecycle recovery
        // creates only a fresh executable mount, never a replacement Board item.
        expect(item.itemId).toBe('widget-1');
        expect(item.revision).toBe('rev-1');
    });

    it('keeps a non-primary placement an inert reference, not a duplicate frame', async () => {
        const screen = await renderPlacement({ host: 'sidebar', primaryHost: 'details', density: 'compact' });
        expect(state.mounts).toHaveLength(0);
        // ...and not a failure either: a healthy widget that simply runs in
        // another placement must never be reported as unavailable.
        expect(screen.findAllByTestId('widget-state')).toHaveLength(0);
        expect(screen.findByTestId('widget-provenance')).toBeTruthy();
    });

    it('keeps a retained record preview inert while Open navigates to its primary placement', async () => {
        const open = vi.fn();
        const screen = await renderPlacement({
            host: 'sidebar',
            primaryHost: 'details',
            density: 'compact',
            runtimeOverrides: {
                pluginUiProjection: projection({ availability: 'disabled' }),
            },
            onManagePlugin: vi.fn(),
            onOpenHere: open,
        });

        expect(state.mounts).toHaveLength(0);
        expect(screen.findByTestId('widget-state')).toBeNull();
        expect(screen.findByTestId('widget-open-here')).not.toBeNull();
        await screen.pressByTestIdAsync('widget-open-here');
        expect(open).toHaveBeenCalledOnce();
        expect(state.mounts).toHaveLength(0);
    });

    it('unmounts a stale retained item and gives the same record a fresh physical lifetime after reconnect', async () => {
        const current = runtime();
        const renderWidget = (executableCurrentness: 'current' | 'stale' | 'offline' | 'unverified') => React.createElement(FixtureHost, {
            sessionId: 'session-1',
            session: state.session ?? undefined,
            item,
            host: 'companion' as const,
            primaryHost: 'companion' as const,
            density: 'compact' as const,
            canEdit: true,
            executableCurrentness,
            heightBounds: { min: 96, max: 520 },
            pluginRuntime: current,
            resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver(current),
            testID: 'widget',
        });
        const screen = await renderScreen(renderWidget('current'));
        const generationG = state.mounts.at(-1)?.mountInstanceKey;
        expect(state.activeMountKeys).toEqual(new Set([String(generationG)]));

        await screen.update(renderWidget('offline'));
        expect(state.activeMountKeys.size).toBe(0);
        expect(screen.findByTestId('widget-executable-offline')).not.toBeNull();

        await screen.update(renderWidget('current'));
        const generationH = state.mounts.at(-1)?.mountInstanceKey;
        expect(generationH).not.toBe(generationG);
        expect(state.activeMountKeys).toEqual(new Set([String(generationH)]));
    });

    it('never mounts retained plugin code when the Board record itself is still current', async () => {
        const screen = await renderPlacement({
            host: 'details',
            primaryHost: 'details',
            density: 'full',
            executableCurrentness: 'current',
        });
        const initialMountKey = state.mounts.at(-1)?.mountInstanceKey;
        expect(initialMountKey).toEqual(expect.any(String));
        await act(async () => { storage.setState({ endpointStatus: 'offline' }); });
        expect(state.activeMountKeys.size).toBe(0);
        expect(state.mounts).toHaveLength(1);
        expect(screen.findByTestId('widget-runtime-retainedOffline-state')).not.toBeNull();
    });

    it('binds a fresh physical mount nonce when the current installed generation changes', async () => {
        const renderWidget = (current: SessionPluginRuntimeState) => React.createElement(FixtureHost, {
            sessionId: 'session-1',
            session: state.session ?? undefined,
            item,
            host: 'details' as const,
            primaryHost: 'details' as const,
            density: 'full' as const,
            canEdit: true,
            executableCurrentness: 'current' as const,
            heightBounds: { min: 96, max: 520 },
            pluginRuntime: current,
            resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver(current),
            testID: 'widget',
        });
        const screen = await renderScreen(renderWidget(runtime({ pluginUiProjection: projection({ generation: 7 }) })));
        const generationGKey = state.mounts.at(-1)?.mountInstanceKey;

        await screen.update(renderWidget(runtime({ pluginUiProjection: projection({ generation: 8 }) })));

        expect(state.mounts.at(-1)?.mountInstanceKey).not.toBe(generationGKey);
        expect(state.activeMountKeys).toEqual(new Set([String(state.mounts.at(-1)?.mountInstanceKey)]));
    });

    it('never runs an inline transcript row, because the shell never elects that placement', async () => {
        // The transcript row passes the shell's answer straight through
        // (`SessionBoardActionResultReference.tsx:44-48`), and the visibility owner never puts
        // `inlineTranscript` in `visibleHosts` — so `primaryHost` is whatever pane is really
        // showing the item, or nothing at all. Both are previews here.
        await renderPlacement({ host: 'inlineTranscript', primaryHost: null, density: 'preview' });
        expect(state.mounts).toHaveLength(0);
        await renderPlacement({ host: 'inlineTranscript', primaryHost: 'details', density: 'preview' });
        expect(state.mounts).toHaveLength(0);
    });

    it('derives plugin presentation from the actual compact or expanded host, not persisted frame chrome', async () => {
        const compact = await renderPlacement({ host: 'companion', primaryHost: 'companion', density: 'compact' });
        expect(state.mounts.at(-1)?.inlineMount).toMatchObject({ presentation: 'content' });
        await compact.unmount();
        expect(state.activeMountKeys.size).toBe(0);
        await renderPlacement({ host: 'focusedDetails', primaryHost: 'focusedDetails', density: 'full', expanded: true });
        await vi.waitFor(() => expect(state.mounts.at(-1)?.inlineMount).toMatchObject({ presentation: 'fill' }));
    });

    // The mobile Cockpit renders the Board before its Session projection has
    // hydrated. Reporting "this device cannot show this content" for a widget
    // whose plugin is installed, enabled and projected is a lie the person
    // cannot act on — and it is not a renderer fact at all.
    it.each(['missing', 'available'] as const)('reports a Session that has not hydrated as loading, then settles %s', async (settlement) => {
        const session = state.session;
        if (!session) throw new Error('Expected the known Session fixture');
        state.session = null;
        // The list already names this exact Session; its detail request is
        // genuinely pending, rather than a settled not-found lookup.
        storage.setState({ sessions: {} });
        const response = createDeferred<Response>();
        state.detailResponse = response.promise;
        const { sync } = await import('@/sync/sync');
        const hydration = sync.ensureSessionVisibleForMessageRoute('session-1', {
            serverId: state.serverId, forceRefresh: true, hydrateMessages: false,
        });
        try {
            await vi.waitFor(() => expect(state.detailRequested).toBe(true));
            expect(storage.getState().sessionListRowsByServerId[state.serverId]?.['session-1']).toMatchObject({ id: 'session-1' });
            const onSetInputs = vi.fn<NonNullable<React.ComponentProps<typeof SessionWidgetHost>['onSetInputs']>>()
                .mockResolvedValue({ ok: true });
            const screen = await renderPlacement({ host: 'details', primaryHost: 'details', density: 'full', onSetInputs });
            expect(state.mounts).toHaveLength(0);
            const cards = screen.tree.root.findAll(
                (node) => typeof (node.props as { diagnosticCode?: unknown }).diagnosticCode === 'string',
                { deep: true },
            );
            const codes = cards.map((node) => (node.props as { diagnosticCode: string }).diagnosticCode);
            expect(codes).toContain('widget_session_hydrating');
            expect(codes).not.toContain('session_board_renderer_missing');
            expect(screen.findByTestId('widget-inputs-repair')).toBeNull();
            let hydrationOutcome: Awaited<typeof hydration> | undefined;
            await act(async () => {
                response.resolve(settlement === 'missing'
                    ? Response.json({ error: 'Session not found' }, { status: 404 })
                    : Response.json({ session: sessionHttpRecord(session) }));
                hydrationOutcome = await hydration;
            });
            if (settlement === 'missing') {
                await vi.waitFor(() => expect(screen.tree.root.findAll(
                    node => node.props.diagnosticCode === 'widget_session_unavailable', { deep: true },
                )).not.toHaveLength(0));
                expect(state.activeMountKeys.size).toBe(0);
                expect(screen.findByTestId('widget-inputs-repair')).not.toBeNull();
                await screen.pressByTestIdAsync('widget-inputs-repair');
                expect(onSetInputs).not.toHaveBeenCalled();
            } else {
                await vi.waitFor(async () => {
                    await flushHookEffects();
                    const currentSession = storage.getState().sessions[session.id];
                    const codes = screen.tree.root.findAll(node => typeof node.props.diagnosticCode === 'string', { deep: true })
                        .map(node => node.props.diagnosticCode);
                    expect(state.activeMountKeys.size, JSON.stringify({ codes, access: currentSession?.access,
                        metadata: currentSession?.metadata, hydrationOutcome })).toBe(1);
                });
                expect(state.mounts.at(-1)?.launchInput).toEqual({ session: { serverId: state.serverId, sessionId: session.id }, view: 'summary' });
            }
        } finally {
            response.resolve(Response.json({ error: 'Session not found' }, { status: 404 }));
            await hydration;
        }
    });

    it('reports an establishing plugin projection as loading, never as an uninstalled plugin', async () => {
        const onManagePlugin = vi.fn();
        const screen = await renderPlacement({
            host: 'details',
            primaryHost: 'details',
            density: 'full',
            runtimeOverrides: { pluginUiProjection: null, phase: 'establishing' },
            onManagePlugin,
        });

        expect(state.mounts).toHaveLength(0);
        const cards = screen.tree.root.findAll(
            (node) => typeof (node.props as { diagnosticCode?: unknown }).diagnosticCode === 'string',
            { deep: true },
        );
        const codes = cards.map((node) => (node.props as { diagnosticCode: string }).diagnosticCode);
        expect(codes).toContain('widget_projection_establishing');
        expect(codes).not.toContain('plugin_unavailable');
        expect(screen.findByTestId('widget-state-action')).toBeNull();
        expect(onManagePlugin).not.toHaveBeenCalled();
    });

    it('refuses an installed definition absent from a settled projection', async () => {
        const screen = await renderPlacement({ host: 'details', primaryHost: 'details', density: 'full',
            runtimeOverrides: { pluginUiProjection: null, phase: 'current' } });

        expect(state.mounts).toHaveLength(0);
        expect(screen.tree.root.findAll(node => node.props.diagnosticCode === 'widget_type_unavailable', { deep: true }))
            .not.toHaveLength(0);
        expect(screen.tree.root.findAll(node => node.props.diagnosticCode === 'widget_projection_establishing', { deep: true }))
            .toHaveLength(0);
    });
});
