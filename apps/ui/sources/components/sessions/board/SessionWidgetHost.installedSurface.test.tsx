import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, SessionCurrentProjectionRecordV1Schema, projectLegacySessionAccessCapabilitiesV1, tryWriteServerEnabledBitInPlace, AccountProfileSchema, DaemonPluginUiArtifactBytesReadResponseSchema, DaemonPluginUiTargetedContributionsReadResponseSchema, PluginProjectionV2Schema, type PluginProjectionV2 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1, normalizePluginUiInlineSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { SessionSurfaceItemV1Schema, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import { widgetCandidateDefinitionV1 } from '@happier-dev/protocol/widgets';

import { manifest as publicAuthoringManifest } from '../../../../../../packages/plugin-sdk/examples/public-authoring/index.ts';
import { readCanonicalPluginManifest } from '../../../../../cli/src/plugins/manifest/normalize.ts';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjection';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import type { SessionBoardItemProjection, SessionBoardMountHost } from '@/sync/domains/session/board';
import { selectWidgetCandidates } from '@/components/widgets/widgetCatalog';
import { PluginInlineSurfaceHost } from '@/components/plugins/surfaces';
import { PluginReactNativeSurface } from '@/components/plugins/reactNative/PluginReactNativeSurface';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { encodeBase64 } from '@/encryption/base64';

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
 * Admission, Artifact integrity/adoption and the native host all run for real.
 * Only daemon RPC, generated package assets and browser persistence are external
 * fixtures. Executable lifetime is observed inside the authored bundle itself.
 */

const state = vi.hoisted(() => ({
    mounts: [] as Record<string, unknown>[],
    rawAuthorExecutions: [] as Record<string, unknown>[],
    activeExecutions: new Set<Record<string, unknown>>(),
    screen: null as Awaited<ReturnType<typeof renderScreen>> | null,
    get activeMountKeys(): Set<string> {
        return new Set([...this.activeExecutions]
            .flatMap((mount) => typeof mount.mountInstanceKey === 'string' ? [mount.mountInstanceKey] : []));
    },
    session: null as ReturnType<typeof createSessionFixture> | null,
    serverId: 'home-a',
    serverIdentityId: 'srv_installed_session_widget',
    projection: null as PluginProjectionV2 | null,
    projectionsByMachine: {} as Record<string, PluginProjectionV2>,
    deferredProjection: null as Promise<unknown> | null,
    sessionResponse: null as Promise<Response> | null,
    sessionRequests: [] as string[],
}));

// The daemon RPC is the external boundary; the scoped runtime and target binder remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: { method: string; machineId: string; payload?: { kind?: string; pluginId?: string } }) => {
        if (request.payload?.kind === 'targeted_action_rpc') return {
            actionId: null, fieldPath: 'session', optionsSourceId: 'sessions',
            options: [{ value: { serverId: state.serverId, sessionId: 'session-1' }, label: 'Session' }],
        };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ) return DaemonPluginUiArtifactBytesReadResponseSchema.parse({
            ok: true, artifactFamily: 'reactNative', cacheIdentity: { artifactDigest: nativeArtifactGraph.digest },
            artifact: { artifactKind: 'reactNativeBundle', digest: nativeArtifactGraph.digest, format: 'plainJs', byteSize: nativeBytes.byteLength },
            bytesBase64: encodeBase64(nativeBytes),
            files: nativeArtifactGraph.files.map((file) => ({ ...file, bytesBase64: encodeBase64(nativeBytes) })),
        });
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
            const pluginId = request.payload?.pluginId ?? '';
            const installed = state.projection?.installedPackagesById[pluginId];
            return DaemonPluginUiTargetedContributionsReadResponseSchema.parse({ status: 'current', targetedContributions: {
                target: { pluginId, occurrenceId: installed?.occurrenceId, sourceCustody: { kind: 'development', registeredRootId: `${pluginId}-test-root` } },
                points: [],
            }, targetedSurfaceMounts: [] });
        }
        if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            throw new Error(`Unexpected widget fixture RPC: ${request.method}`);
        if (state.deferredProjection) return state.deferredProjection;
        return { protocolVersion: 1, projection: state.projectionsByMachine[request.machineId] ?? state.projection };
    },
}));
const rawProjections = new WeakMap<ReturnType<typeof normalizePluginUiProjection>, PluginProjectionV2>();
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

function normalizeFixtureProjection(raw: unknown): ReturnType<typeof normalizePluginUiProjection> {
    const parsed = PluginProjectionV2Schema.parse(raw);
    const normalized = normalizePluginUiProjection(parsed);
    rawProjections.set(normalized, parsed);
    return normalized;
}

installDisconnectedServerSocketBoundary();
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreExecutorLoader: (() => void) | undefined;

// vitest.config aliases the generated app-byte inventory to the canonical empty
// bundledPluginUiAssets fixture; no internal Artifact source is replaced here.

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.hoisted(() => {
    // Browser CacheStorage is the genuine persistent Artifact byte boundary.
    const stores = new Map<string, Map<string, Response>>();
    const requestUrl = (request: RequestInfo | URL) => typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
    vi.stubGlobal('caches', {
        open: async (name: string) => {
            const records = stores.get(name) ?? new Map<string, Response>();
            stores.set(name, records);
            return {
                match: async (request: RequestInfo | URL) => records.get(requestUrl(request))?.clone(),
                put: async (request: RequestInfo | URL, response: Response) => { records.set(requestUrl(request), response.clone()); },
                delete: async (request: RequestInfo | URL) => records.delete(requestUrl(request)),
                keys: async () => [...records.keys()].map((url) => new Request(url)),
            };
        },
        delete: async (name: string) => stores.delete(name),
        has: async (name: string) => stores.has(name),
        keys: async () => [...stores.keys()],
        match: async () => undefined,
    });
});

// NativeModules is the external native SDK boundary. The real evaluator exposes
// the react-native namespace unchanged; the authored effect calls this adapter,
// not a test global or an internal admission/loader replacement.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        // Adding the native observer preserves the existing Node test adapter;
        // the real plugin runtime still admits this surface for explicit web.
        Platform: { OS: 'node' },
        NativeModules: { InstalledWidgetAuthorObserver: { mounted: (context: RenderContext) => observeAuthorExecution(context) } },
    });
});

function observeAuthorExecution(context: RenderContext) {
    let capturedMountKey: string | undefined;
    const execution = {
        launchInput: context.launchInput,
        signal: context.signal,
        get mountInstanceKey() {
            // Capture while live; a disappearing wrapper must not erase evidence
            // that its author effect failed to clean up.
            capturedMountKey ??= state.screen?.tree.root.findAllByType(PluginReactNativeSurface)
                .find((node) => node.props.renderContext?.signal === context.signal)?.props.mountInstanceKey;
            return capturedMountKey;
        },
    };
    state.mounts.push(execution);
    state.rawAuthorExecutions.push(execution);
    state.activeExecutions.add(execution);
    return () => { state.activeExecutions.delete(execution); };
}
const nativeBytes = new TextEncoder().encode(`
const React = require('react');
const Native = require('react-native');
function WidgetAuthor({ context }) {
    React.useEffect(() => Native.NativeModules.InstalledWidgetAuthorObserver.mounted(context), [context.signal]);
    return React.createElement(Native.View, { testID: 'installed-widget-author' });
}
exports.renderSurface = (context) => React.createElement(WidgetAuthor, { context });
`);
const nativeEntry = 'react-native/widget-native/entry.cjs.bundle';
const nativeArtifactGraph = {
    artifactId: 'widget-native', tier: 'reactNative', entry: nativeEntry,
    files: [{ relativePath: nativeEntry, digest: computePluginUiArtifactSha256DigestV1(nativeBytes), byteSize: nativeBytes.byteLength }],
    digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: nativeEntry, bytes: nativeBytes }]),
    builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0',
} as const;

function nativeRenderer(pluginId: string, rendererId: string, occurrenceId: string, pluginVersion: string) {
    return {
        id: `reactNativeBundle:${pluginId}:${rendererId}`, pluginId, contributionKind: 'reactNativeBundle', contributionId: rendererId,
        occurrenceId, pluginVersion, generatedV2: true, artifactSelectionOwner: 'daemonProjection', artifactGraph: nativeArtifactGraph,
        hostApi: { minVersion: '1.0.0', methods: [] },
        runtime: { decision: { state: 'load', reason: 'compatible', diagnostics: [] }, loadPolicy: { source: 'installedArtifact' },
            cacheKey: nativeArtifactGraph.digest, cacheIdentity: { artifactDigest: nativeArtifactGraph.digest } },
    };
}
function executionOrigin(pluginId: string, generation: number, machineId = 'machine-1') {
    return { serverIdentityId: state.serverIdentityId, materializationRef: { machineId, materializationId: `${pluginId}-${generation}`, pluginId } };
}

function inlineProps(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.tree.root.findAllByType(PluginInlineSurfaceHost).at(-1)?.props;
}
async function awaitAuthorMount(screen: Awaited<ReturnType<typeof renderScreen>>) {
    state.screen = screen;
    await vi.waitFor(async () => { await flushHookEffects(); expect(state.activeMountKeys.size).toBe(1); });
    // Cold Artifact adoption probes then commits the author in the same native
    // frame. Count physical executable placements by their positively observed
    // host nonce, while retaining every author effect and its real cleanup.
    const physicalMounts = new Map<string | Record<string, unknown>, Record<string, unknown>>();
    for (const execution of state.rawAuthorExecutions) {
        const nonce = execution.mountInstanceKey;
        physicalMounts.set(typeof nonce === 'string' ? nonce : execution, execution);
    }
    state.mounts = [...physicalMounts.values()];
}
const SURFACE = { pluginId: 'acme.review', localId: 'review-status-widget' } as const;

function publicAuthoringProjection() {
    const manifest = readCanonicalPluginManifest(publicAuthoringManifest);
    if (!manifest) throw new Error('the maintained public-authoring manifest must remain canonical');
    const view = manifest.contributes.ui.views.find((candidate) => candidate.id === 'review-status-widget');
    if (!view) throw new Error('the maintained public-authoring example must emit review-status-widget');
    if (view.container !== 'widget') throw new Error('the maintained public-authoring view must be a widget');
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
        ...executionOrigin(manifest.id, 17),
        binding,
        target: binding.target,
        renderer: { kind: primaryRenderer.kind, contributionId: primaryRenderer.id },
        display: { title: view.title },
        ...(view.inputs ? { inputs: view.inputs } : {}),
        ...(view.inputSchema ? { inputSchema: view.inputSchema } : {}),
        ...(view.sessionInputPath ? { sessionInputPath: view.sessionInputPath } : {}),
        availability: { state: 'available', reason: 'available', diagnostics: [] },
    };
    const bundle = nativeRenderer(manifest.id, primaryRenderer.id, `${manifest.id}#1`, manifest.version);
    return normalizeFixtureProjection({
        v: 2,
        generation: 17,
        installedPackagesById: {
            [manifest.id]: {
                id: manifest.id,
                displayName: manifest.displayName,
                version: manifest.version,
                enabled: true,
                immutableGenerationId: 'public-authoring-generation-17',
                occurrenceId: `${manifest.id}#1`,
                source: { kind: 'path', locator: '/fixtures/public-authoring' },
            },
        },
        actionsById: {},
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [entry.id]: entry, [bundle.id]: bundle } } },
    });
}

function projection(options: Readonly<{
    generation?: number;
    machineId?: string;
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
        ...executionOrigin(SURFACE.pluginId, options.generation ?? 3, options.machineId),
        binding,
        target: binding.target,
        renderer: { kind: 'reactNative', contributionId: 'review-native' },
        display: { title: 'Review status' },
        inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true }, { path: 'view', title: 'View', widget: 'text' }] },
        inputSchema: { type: 'object', properties: {
            session: { type: 'object', properties: { serverId: { type: 'string' }, sessionId: { type: 'string' } }, required: ['serverId', 'sessionId'], additionalProperties: false },
            view: { type: 'string' },
        }, required: ['session'], additionalProperties: false },
        sessionInputPath: 'session',
        availability: options.availability === 'disabled'
            ? { state: 'disabled', reason: 'plugin_disabled', diagnostics: [] }
            : { state: 'available', reason: 'available', diagnostics: [] },
    };
    const bundle = nativeRenderer(SURFACE.pluginId, 'review-native', `${SURFACE.pluginId}#${options.generation ?? 3}`, '0.1.0');
    return normalizeFixtureProjection({
        v: 2,
        generation: options.generation ?? 3,
        installedPackagesById: options.installed === false ? {} : {
            [SURFACE.pluginId]: {
                id: SURFACE.pluginId,
                displayName: 'Review Assistant',
                version: '0.1.0',
                immutableGenerationId: `review-generation-${options.generation ?? 3}`,
                enabled: true,
                occurrenceId: `${SURFACE.pluginId}#${options.generation ?? 3}`,
                source: { kind: 'local', locator: '/plugins/acme.review' },
            },
        },
        actionsById: {},
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: options.includePlacement === false ? {} : { [entry.id]: entry, [bundle.id]: bundle },
            },
        },
    });
}

function runtime(overrides: Partial<SessionPluginRuntimeState> = {}): SessionPluginRuntimeState {
    return {
        pluginUiProjection: projection(),
        pluginBrowserProjection: null,
        phase: 'current',
        interactionEnabled: true,
        machineId: 'machine-1',
        serverId: state.serverId,
        platform: 'web',
        ...overrides,
    } as SessionPluginRuntimeState;
}

function createInstalledItem(): SessionBoardItemProjection { return {
    itemId: 'widget-1',
    revision: 'rev-1',
    state: {
        kind: 'ready',
        item: {
            v: 1,
            title: 'Review status',
            frame: 'card',
            height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: {
                v: 1, id: 'widget-1', definition: { kind: 'installed', surface: SURFACE },
                bindings: {
                    session: { kind: 'value', value: { serverId: state.serverId, sessionId: 'session-1' } },
                    view: { kind: 'value', value: 'summary' },
                },
            } },
        },
    },
}; }

let item = createInstalledItem();

function InstalledWidgetHostFixture(props: React.ComponentProps<typeof SessionWidgetHost>): React.ReactElement {
    const current = props.pluginRuntime ?? runtime();
    const raw = current.pluginUiProjection ? rawProjections.get(current.pluginUiProjection) ?? null : null;
    state.projection = raw;
    React.useLayoutEffect(() => {
        publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: state.serverId });
    }, [raw]);
    return <AppShellPluginUiProjectionValueProvider value={{
        ...current, clientExecutableActivation: { status: 'ready' },
        reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {},
    }}><SessionWidgetHost {...props} serverId={state.serverId} /></AppShellPluginUiProjectionValueProvider>;
}

async function renderPlacement(input: Readonly<{
    host: SessionBoardMountHost;
    primaryHost: SessionBoardMountHost | null;
    density: 'full' | 'compact' | 'preview';
    expanded?: boolean;
    runtimeOverrides?: Partial<SessionPluginRuntimeState>;
    onManagePlugin?: () => void;
    onOpenHere?: () => void;
    executableCurrentness?: 'current' | 'stale' | 'offline' | 'unverified';
    screen?: Awaited<ReturnType<typeof renderScreen>>;
}>) {
    const current = { ...runtime(), ...input.runtimeOverrides } as SessionPluginRuntimeState;
    const node = React.createElement(InstalledWidgetHostFixture, {
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
        resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver(),
        ...(input.onManagePlugin ? { onManagePlugin: input.onManagePlugin } : {}),
        ...(input.onOpenHere ? { onOpenHere: input.onOpenHere } : {}),
        testID: 'widget',
    });
    const screen = input.screen ?? await renderScreen(node);
    if (input.screen) await screen.update(node);
    state.screen = screen;
    await flushHookEffects();
    const placement = inlineProps(screen);
    if (state.session && !state.deferredProjection && placement && input.executableCurrentness !== 'stale'
        && input.executableCurrentness !== 'offline' && input.executableCurrentness !== 'unverified') await awaitAuthorMount(screen);
    return screen;
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

describe('SessionWidgetHost installed surface placements', () => {
    beforeEach(async () => {
        standardCleanup();
        state.mounts = [];
        state.rawAuthorExecutions = [];
        state.activeExecutions.clear();
        state.screen = null;
        clearDaemonMergedProjectionCacheForTests();
        state.projectionsByMachine = {};
        state.deferredProjection = null;
        state.sessionResponse = null;
        state.sessionRequests = [];
        state.session = createSessionFixture({ id: 'session-1' });
        await import('@/sync/syncEngine');
        restoreExecutorLoader = await installRealActionExecutorModuleLoader();
        const http = createHomeHubArtifactHttpBoundary('viewer');
        const features = createRootLayoutFeaturesResponse({
            features: { sessions: { board: { enabled: true } } },
            capabilities: { serverIdentity: { serverIdentityId: state.serverIdentityId } },
        });
        if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Expected the canonical Board feature');
        const { SessionListQueryResponseV1Schema } = await import('@happier-dev/protocol');
        accountConnection = await restoreServerAccountForTest({ serverUrl: 'http://installed-session-widget.test', accountId: 'viewer',
            serverIdentityId: state.serverIdentityId,
            request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
                // Dynamic Widget options discover their consuming descriptor
                // through the real Board port; this Home has an empty Board.
                if (path === '/v2/sessions/session-1/system-records/record') return Response.json({ record: null });
                if (path === '/v2/sessions/session-1/system-records') return Response.json({ records: [], nextCursor: null, hasNext: false });
                if (path === '/v2/sessions/query') {
                    const session = state.session;
                    if (!session) throw new Error('Widget option discovery requires the readable Session fixture');
                    return Response.json(SessionListQueryResponseV1Schema.parse({
                        sessions: [sessionHttpRecord(session)], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                    }));
                }
                const isBoundSessionProjection = path === '/v2/sessions/session-1';
                if (isBoundSessionProjection || path.startsWith('/v1/sessions/session-1/')) {
                    state.sessionRequests.push(path);
                }
                if (isBoundSessionProjection && state.sessionResponse) return (await state.sessionResponse).clone();
                return http.request(input, init);
            } });
        state.serverId = resolveServerProfileScopeId(accountConnection.home);
        storage.setState({ profile: AccountProfileSchema.parse({ id: 'viewer' }),
            profileScope: { serverId: state.serverId, accountId: 'viewer' } });
        state.session = createSessionFixture({ id: 'session-1', serverId: state.serverId });
        item = createInstalledItem();
        storage.getState().applySessions([state.session]);
        const machine = createMachineFixture({ activeAt: Date.now() });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [state.serverId]: [machine] }, endpointStatus: 'online' });
    });

    afterEach(async () => {
        standardCleanup();
        restoreExecutorLoader?.();
        restoreExecutorLoader = undefined;
        await accountConnection?.dispose();
        accountConnection = undefined;
    });

    it('mounts the maintained emitted public-authoring widget through the real candidate and host path', async () => {
        const pluginUiProjection = publicAuthoringProjection();
        const candidate = selectWidgetCandidates(pluginUiProjection, { platform: 'web' }).find(
            (value) => value.target === 'session' && value.surface?.pluginId === publicAuthoringManifest.id
                && value.surface.localId === 'review-status-widget',
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
                    source: { kind: 'widget', instance: {
                        v: 1, id: 'public-authoring-widget', definition: widgetCandidateDefinitionV1(candidate),
                        bindings: {
                            session: { kind: 'value', value: { serverId: state.serverId, sessionId: 'session-1' } },
                            view: { kind: 'value', value: 'summary' },
                        },
                    } },
                }),
            },
        };
        const current = runtime({ pluginUiProjection });
        const renderPublicWidget = (executableCurrentness: 'current' | 'stale') => React.createElement(InstalledWidgetHostFixture, {
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
            resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver(),
            testID: 'public-authoring-widget',
        });

        const screen = await renderScreen(renderPublicWidget('current'));
        await awaitAuthorMount(screen);
        expect(state.mounts).toHaveLength(1);
        expect(inlineProps(screen)).toMatchObject({
            placement: {
                pluginId: publicAuthoringManifest.id,
                descriptorId: 'review-status-widget',
            },
            inlineMount: { role: 'widget', presentation: 'content' },
            launchInput: { view: 'summary' },
        });

        await screen.update(renderPublicWidget('stale'));
        expect(state.activeMountKeys).toEqual(new Set());
    });

    it.each(['compact', 'preview'] as const)('mounts the plugin exactly once in the shell-selected primary placement with %s chrome', async (density) => {
        // The compact sidebar is a real promised host and is the cheapest one to
        // render, so this pins the mount contract without dragging the spacious
        // grid's chrome into every assertion.
        await renderPlacement({ host: 'sidebar', primaryHost: 'sidebar', density });
        expect(state.mounts).toHaveLength(1);
        expect(state.mounts[0]!.launchInput).toEqual({
            session: { serverId: state.serverId, sessionId: 'session-1' }, view: 'summary',
        });
        expect(state.sessionRequests).toEqual([]);
    });

    it('uses current installed-frame height for Auto, ignores it while fixed, and restores it with Fit content', async () => {
        const onSetHeight = vi.fn();
        const renderWidget = (height: SessionSurfaceItemV1['height']) => React.createElement(InstalledWidgetHostFixture, {
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
            resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver(),
            onSetHeight,
            testID: 'widget',
        });
        const screen = await renderScreen(renderWidget({ mode: 'auto', fallback: 'regular' }));
        await awaitAuthorMount(screen);
        const reportHeight = inlineProps(screen)?.onIntrinsicHeightChange as ((height: number) => void) | undefined;
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
        const screen = await renderPlacement({
            host: 'details',
            primaryHost: 'details',
            density: 'full',
            onManagePlugin: managePlugin,
        });

        const action = inlineProps(screen)?.unavailableAction as Readonly<{
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
        const renderWidget = (current: SessionPluginRuntimeState) => React.createElement(InstalledWidgetHostFixture, {
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
            resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver(),
            onManagePlugin: managePlugin,
            onRemove: removeFromBoard,
            testID: 'widget',
        });
        const generationG = runtime({ pluginUiProjection: projection({ generation: 7 }) });
        const screen = await renderScreen(renderWidget(generationG));
        await awaitAuthorMount(screen);
        const removeFromFrame = async () => {
            const remove = actionsOf(screen).find((action) => action.id === 'remove');
            expect(remove?.onPress).toEqual(expect.any(Function));
            await act(async () => { (remove!.onPress as () => void)(); });
        };
        const generationGMountKey = state.mounts.at(-1)?.mountInstanceKey;
        expect(generationGMountKey).toEqual(expect.any(String));
        expect(state.activeMountKeys).toEqual(new Set([generationGMountKey]));

        const disabled = runtime({
            pluginUiProjection: projection({ generation: 8, availability: 'disabled' }),
        });
        await screen.update(renderWidget(disabled));
        await flushHookEffects();
        // The canonical availability owner retires the executable mount before
        // publishing management on the real native refusal card; destructive
        // shared-item removal remains in the same frame's canonical menu.
        expect(state.activeMountKeys).toEqual(new Set());
        await screen.pressByTestIdAsync('plugin-surface-unavailable-action');
        await removeFromFrame();
        expect(managePlugin).toHaveBeenCalledOnce();
        expect(removeFromBoard).toHaveBeenCalledOnce();

        managePlugin.mockClear();
        removeFromBoard.mockClear();

        const uninstalled = runtime({
            pluginUiProjection: projection({ generation: 9, installed: false, includePlacement: false }),
        });
        await screen.update(renderWidget(uninstalled));
        await flushHookEffects();
        expect(state.activeMountKeys).toEqual(new Set());
        await screen.pressByTestIdAsync('widget-manage-plugin');
        await removeFromFrame();
        expect(managePlugin).toHaveBeenCalledOnce();
        expect(removeFromBoard).toHaveBeenCalledOnce();

        const generationH = runtime({ pluginUiProjection: projection({ generation: 10 }) });
        await screen.update(renderWidget(generationH));
        await awaitAuthorMount(screen);
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

    it('never offers Open for an unavailable retained widget', async () => {
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
        expect(screen.findByTestId('widget-state')).not.toBeNull();
        expect(actionsOf(screen).some((action) => action.id === 'openHere')).toBe(false);
        expect(open).not.toHaveBeenCalled();
    });

    it('offers Open for an admitted non-primary reference without mounting the widget body', async () => {
        const open = vi.fn();
        const screen = await renderPlacement({ host: 'sidebar', primaryHost: 'details', density: 'compact', onOpenHere: open });

        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findByTestId('widget-open-here')).not.toBeNull();
        });
        expect(screen.findAllByTestId('widget-state')).toHaveLength(0);
        await screen.pressByTestIdAsync('widget-open-here');
        expect(open).toHaveBeenCalledOnce();
        expect(state.activeMountKeys.size).toBe(0);
        expect(state.rawAuthorExecutions).toHaveLength(0);
        expect(screen.tree.root.findAllByType(PluginInlineSurfaceHost)).toHaveLength(0);
    });

    it('refuses a different bound Session whose plugin is disabled even when the host plugin is available', async () => {
        const disabled = projection({ availability: 'disabled', machineId: 'machine-2' });
        const raw = rawProjections.get(disabled);
        if (!raw) throw new Error('The bound machine requires its producer-shaped projection');
        state.projectionsByMachine['machine-2'] = raw;
        const boundSession = createSessionFixture({ id: 'session-2', serverId: state.serverId,
            metadata: { ...createSessionFixture().metadata!, machineId: 'machine-2' } });
        storage.getState().applySessions([boundSession]);
        const boundMachine = createMachineFixture({ id: 'machine-2', activeAt: Date.now() });
        storage.setState(current => ({ machines: { ...current.machines, [boundMachine.id]: boundMachine },
            machineListByServerId: { ...current.machineListByServerId,
                [state.serverId]: [...(current.machineListByServerId[state.serverId] ?? []), boundMachine] } }));
        if (item.state.kind !== 'ready' || item.state.item.source.kind !== 'widget') throw new Error('The item must be configured');
        item = { ...item, state: { kind: 'ready', item: { ...item.state.item, source: { kind: 'widget', instance: {
            ...item.state.item.source.instance, bindings: { ...item.state.item.source.instance.bindings,
                session: { kind: 'value', value: { serverId: state.serverId, sessionId: boundSession.id } } },
        } } } } };
        const manage = vi.fn();
        const screen = await renderPlacement({ host: 'sidebar', primaryHost: 'details', density: 'compact',
            onOpenHere: vi.fn(), onManagePlugin: manage });

        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByType(SurfaceStateCard)
                .find(node => node.props.testID === 'widget-state')?.props.diagnosticCode).toBe('plugin_disabled');
        });
        expect(screen.findByTestId('widget-open-here')).toBeNull();
        await screen.pressByTestIdAsync('widget-manage-plugin');
        expect(manage).toHaveBeenCalledOnce();
        expect(state.rawAuthorExecutions).toHaveLength(0);
        expect(screen.tree.root.findAllByType(PluginInlineSurfaceHost)).toHaveLength(0);

        // Reverse the two machines' availability: B is admitted even when A is disabled.
        const available = rawProjections.get(projection({ generation: 4, machineId: 'machine-2' }));
        if (!available) throw new Error('The admitted bound machine requires its producer-shaped projection');
        state.projectionsByMachine['machine-2'] = available;
        const open = vi.fn();
        await renderPlacement({ host: 'sidebar', primaryHost: 'details', density: 'compact', screen,
            runtimeOverrides: { pluginUiProjection: projection({ availability: 'disabled' }) }, onOpenHere: open });
        await act(async () => {
            publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-2', serverId: state.serverId });
        });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findByTestId('widget-open-here')).not.toBeNull();
        });
        expect(screen.findByTestId('widget-state')).toBeNull();
        await screen.pressByTestIdAsync('widget-open-here');
        expect(open).toHaveBeenCalledOnce();
        expect(state.rawAuthorExecutions).toHaveLength(0);
    });

    it('unmounts a stale retained item and gives the same record a fresh physical lifetime after reconnect', async () => {
        const current = runtime();
        const renderWidget = (executableCurrentness: 'current' | 'stale' | 'offline' | 'unverified') => React.createElement(InstalledWidgetHostFixture, {
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
            resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver(),
            testID: 'widget',
        });
        const screen = await renderScreen(renderWidget('current'));
        await awaitAuthorMount(screen);
        const generationG = state.mounts.at(-1)?.mountInstanceKey;
        expect(state.activeMountKeys).toEqual(new Set([String(generationG)]));

        await screen.update(renderWidget('offline'));
        expect(state.activeMountKeys.size).toBe(0);
        expect(screen.findByTestId('widget-executable-offline')).not.toBeNull();

        await screen.update(renderWidget('current'));
        await awaitAuthorMount(screen);
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
        expect(state.activeMountKeys.size).toBe(1);
        // Disconnect the real selected runtime; the item's persisted revision remains current.
        await act(async () => { storage.setState({ endpointStatus: 'offline' }); });
        await flushHookEffects();
        expect(state.activeMountKeys.size).toBe(0);
        expect(screen.findByTestId('widget-runtime-retainedOffline-state')).not.toBeNull();
    });

    it('binds a fresh physical mount nonce when the current installed generation changes', async () => {
        const renderWidget = (current: SessionPluginRuntimeState) => React.createElement(InstalledWidgetHostFixture, {
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
            resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver(),
            testID: 'widget',
        });
        const screen = await renderScreen(renderWidget(runtime({ pluginUiProjection: projection({ generation: 7 }) })));
        await awaitAuthorMount(screen);
        const generationGKey = state.mounts.at(-1)?.mountInstanceKey;

        await screen.update(renderWidget(runtime({ pluginUiProjection: projection({ generation: 8 }) })));
        await awaitAuthorMount(screen);

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
        const screen = await renderPlacement({ host: 'companion', primaryHost: 'companion', density: 'compact' });
        expect(inlineProps(screen)?.inlineMount).toMatchObject({ presentation: 'content' });

        await renderPlacement({ screen, host: 'focusedDetails', primaryHost: 'focusedDetails', density: 'full', expanded: true });
        await vi.waitFor(async () => { await flushHookEffects(); expect(inlineProps(screen)?.inlineMount).toMatchObject({ presentation: 'fill' }); });
    });

    // The mobile Cockpit renders the Board before its Session projection has
    // hydrated. Reporting "this device cannot show this content" for a widget
    // whose plugin is installed, enabled and projected is a lie the person
    // cannot act on — and it is not a renderer fact at all.
    it('hydrates the exact uncached Session without reporting it missing or reading its transcript', async () => {
        const session = state.session!;
        let settleSession: ((response: Response) => void) | undefined;
        state.sessionResponse = new Promise(resolve => { settleSession = resolve; });
        state.session = null;
        storage.setState({ sessions: {} });
        const screen = await renderPlacement({ host: 'details', primaryHost: 'details', density: 'full' });

        expect(state.mounts).toHaveLength(0);
        const cards = screen.tree.root.findAll(
            (node) => typeof (node.props as { diagnosticCode?: unknown }).diagnosticCode === 'string',
            { deep: true },
        );
        const codes = cards.map((node) => (node.props as { diagnosticCode: string }).diagnosticCode);
        expect(codes).toContain('widget_session_hydrating');
        expect(codes).not.toContain('session_board_renderer_missing');
        expect(codes).not.toContain('widget_session_unavailable');
        await vi.waitFor(() => expect(state.sessionRequests).toEqual(['/v2/sessions/session-1']));
                await act(async () => {
            settleSession?.(Response.json({ session: sessionHttpRecord(session) }));
        });
        await vi.waitFor(async () => { await flushHookEffects(); expect(state.activeMountKeys.size).toBe(1); });
        expect(storage.getState().sessions['session-1']?.serverId).toBe(state.serverId);
        expect(state.sessionRequests).toEqual(['/v2/sessions/session-1']);
    });

    it.each([
        { status: 404, reasonCode: 'widget_session_unavailable' },
        { status: 403, reasonCode: 'widget_session_access_denied' },
    ])('settles a confirmed HTTP $status Session refusal without running plugin code', async ({ status, reasonCode }) => {
        state.sessionResponse = Promise.resolve(Response.json({ error: status === 404 ? 'Session not found' : 'Forbidden' }, { status }));
        state.session = null;
        storage.setState({ sessions: {} });
        const screen = await renderPlacement({ host: 'details', primaryHost: 'details', density: 'full' });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(state.sessionRequests).toEqual(['/v2/sessions/session-1']);
            expect(screen.findByTestId(`widget-state-diagnostic-${reasonCode}`)).not.toBeNull();
        });
        expect(state.activeMountKeys.size).toBe(0);
        expect(screen.findByTestId('widget-state-diagnostic-widget_session_hydrating')).toBeNull();
    });

    it.each(['inactive', 'other-home', 'malformed'] as const)('does not hydrate an $0 target that cannot be admitted', async (refusal) => {
        const { renderHook } = await import('@/dev/testkit');
        const { WidgetInstanceV1Schema } = await import('@happier-dev/protocol/widgets');
        const { useConfiguredWidgetTarget } = await import('@/sync/domains/widgets/useConfiguredWidgetTarget');
        const current = runtime();
        const descriptor = selectWidgetCandidates(current.pluginUiProjection, { platform: 'web' }).find(candidate =>
            candidate.surface?.pluginId === SURFACE.pluginId && candidate.surface.localId === SURFACE.localId);
        if (!descriptor) throw new Error('The installed fixture must provide its admitted descriptor');
        const projectedItem = createInstalledItem();
        if (projectedItem.state.kind !== 'ready' || projectedItem.state.item.source.kind !== 'widget')
            throw new Error('The installed fixture must retain its widget instance');
        const instance = WidgetInstanceV1Schema.parse({ ...projectedItem.state.item.source.instance, bindings: {
            ...projectedItem.state.item.source.instance.bindings,
            session: { kind: 'value', value: refusal === 'malformed' ? { sessionId: 'session-1' }
                : { serverId: refusal === 'other-home' ? 'other-home' : state.serverId, sessionId: 'session-1' } },
        } });
        state.session = null;
        storage.setState({ sessions: {} });
        const hook = await renderHook(() => useConfiguredWidgetTarget({
            scope: { serverId: state.serverId, accountId: 'viewer', owner: { kind: 'sessionBoard', sessionId: 'session-1' } },
            instance, descriptor, providedContext: {}, appRuntime: current, enabled: refusal !== 'inactive',
        }));
        await flushHookEffects();
        expect(hook.getCurrent().status).not.toBe('ready');
        expect(state.sessionRequests).toEqual([]);
    });

    it('reports an establishing plugin projection as loading, never as an uninstalled plugin', async () => {
        let settleProjection: ((value: unknown) => void) | undefined;
        state.deferredProjection = new Promise(resolve => { settleProjection = resolve; });
        try {
            const screen = await renderPlacement({ host: 'details', primaryHost: 'details', density: 'full' });
            expect(state.mounts).toHaveLength(0);
            const cards = screen.tree.root.findAll(
                (node) => typeof (node.props as { diagnosticCode?: unknown }).diagnosticCode === 'string',
                { deep: true },
            );
            const codes = cards.map((node) => (node.props as { diagnosticCode: string }).diagnosticCode);
            expect(codes).toContain('widget_projection_establishing');
            expect(codes).not.toContain('plugin_unavailable');
            expect(cards.some(node => node.props.kind === 'loading')).toBe(true);
            state.deferredProjection = null;
            settleProjection?.({ protocolVersion: 1, projection: state.projection });
            await vi.waitFor(async () => { await flushHookEffects(); expect(state.activeMountKeys.size).toBe(1); });
            expect(screen.findByTestId('widget-state-diagnostic-widget_projection_establishing')).toBeNull();
            // A settled, genuinely empty scoped projection is unavailable, not
            // perpetual loading or permission to borrow the AppShell descriptor.
            state.projection = PluginProjectionV2Schema.parse({ ...state.projection,
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: {} } } });
            await act(async () => {
                publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: state.serverId });
            });
            await vi.waitFor(async () => { await flushHookEffects(); expect(state.activeMountKeys.size).toBe(0); });
            expect(screen.findByTestId('widget-state-diagnostic-widget_type_unavailable')).not.toBeNull();
        } finally {
            state.deferredProjection = null;
            settleProjection?.({ protocolVersion: 1, projection: state.projection });
            await flushHookEffects();
        }
    });
});
