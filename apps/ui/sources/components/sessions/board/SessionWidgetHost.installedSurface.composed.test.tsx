import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionCurrentProjectionRecordV1Schema} from '@happier-dev/protocol/sessions/listing/response';
import { projectLegacySessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { tryWriteServerEnabledBitInPlace} from '@happier-dev/protocol/features/serverEnabledBit';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { DaemonPluginUiArtifactBytesReadResponseSchema, DaemonPluginUiTargetedContributionsReadResponseSchema, PluginProjectionV2Schema, type PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { decodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { StoredApprovalRequestSchema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1, normalizePluginUiInlineSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { SessionSurfaceItemV1Schema, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import { widgetCandidateDefinitionV1 } from '@happier-dev/protocol/widgets';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

import { manifest as publicAuthoringManifest } from '../../../../../../packages/plugin-sdk/examples/public-authoring/index.ts';
import { readCanonicalPluginManifest } from '../../../../../cli/src/plugins/manifest/normalize.ts';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineRowFixture, createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createSessionListSourceFixture, createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjection';
import { storage } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import type { SessionBoardItemProjection, SessionBoardMountHost } from '@/sync/domains/session/board';
import { selectWidgetCandidates } from '@/components/widgets/widgetCatalog';
import { PluginInlineSurfaceHost } from '@/components/plugins/surfaces';
import { PluginReactNativeSurface } from '@/components/plugins/reactNative/PluginReactNativeSurface';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { encodeBase64 } from '@/encryption/base64';
import { pluginArtifactTransferDaemonState } from '@/dev/testkit/harness/pluginArtifactTransferBoundary';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { PluginGlance } from '@/components/sessions/companion/glances/PluginGlance';
import { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePaneHeaderSlotContent, usePublishedPaneHeaderContent } from '@/components/appShell/panes/paneHeaderSlot';

import { SessionWidgetHost } from './SessionWidgetHost';
import { createSessionBoardSourceAvailabilityResolver } from './sessionBoardItemPresentation';

// Static mounted-host imports reach Sync; install its external Socket boundary during collection.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

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
    presentations: [] as RenderContext[],
    localStates: [] as unknown[],
    activeExecutions: new Set<Record<string, unknown>>(),
    screen: null as Awaited<ReturnType<typeof renderScreen>> | null,
    get activeMountKeys(): Set<string> {
        return new Set([...this.activeExecutions]
            .flatMap((mount) => typeof mount.mountInstanceKey === 'string' ? [mount.mountInstanceKey] : []));
    },
    session: null as ReturnType<typeof createSessionFixture> | null,
    httpSessions: {} as Record<string, ReturnType<typeof createSessionFixture>>,
    serverId: 'home-a',
    serverIdentityId: 'srv_installed_session_widget',
    projection: null as PluginProjectionV2 | null,
    projectionsByMachine: {} as Record<string, PluginProjectionV2>,
    deferredProjection: null as Promise<unknown> | null,
    sessionResponses: {} as Record<string, Promise<Response>>,
    sessionRequests: [] as Array<{ method: string; path: string; parts?: unknown }>,
    approvalWriteMode: 'none' as 'none' | 'refused' | 'created',
    approvalWriteBody: null as unknown,
    requiredApprovalPolicy: null as ReturnType<typeof normalizeActionsSettingsV1> | null,
    artifactReads: 0,
    updateHeader: null as ((header: { caption: string; fact: string } | null) => void) | null,
}));

// The daemon RPC is the external boundary; the scoped runtime and target binder remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createPluginArtifactTransferBoundary } = await import('@/dev/testkit/harness/pluginArtifactTransferBoundary');
    const artifacts = createPluginArtifactTransferBoundary(() => {
        state.artifactReads += 1;
        return DaemonPluginUiArtifactBytesReadResponseSchema.parse({
            ok: true, artifactFamily: 'reactNative', cacheIdentity: { artifactDigest: nativeArtifactGraph.digest },
            artifact: { artifactKind: 'reactNativeBundle', digest: nativeArtifactGraph.digest, format: 'plainJs', byteSize: nativeBytes.byteLength },
            files: nativeArtifactGraph.files.map((file) => ({ ...file, bytesBase64: encodeBase64(nativeBytes) })),
        });
    });
    return {
    machineRpcWithServerScope: async (request: { method: string; machineId: string; payload?: { pluginId?: string } }) => {
        if (artifacts.handles(request.method)) return artifacts.request({ ...request, payload: request.payload });
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
    };
});
const rawProjections = new WeakMap<ReturnType<typeof normalizePluginUiProjection>, PluginProjectionV2>();
function sessionHttpRecord(session: ReturnType<typeof createSessionFixture>) {
    const metadata = readSessionOwnerMetadataView(session);
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Expected canonical owner metadata');
    // The loaded sharing feature opts exact detail into accessProjectionVersion=1.
    // Detail and native options must serve the same current server projection.
    return SessionCurrentProjectionRecordV1Schema.parse({
        id: session.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
        active: session.active, activeAt: session.activeAt, archivedAt: null,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })), metadataVersion: 1,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), ownerMetadataVersion: 1,
        agentState: null, agentStateVersion: 1, share: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) },
        viewer: { latestFailureSeq: null, readState: { state: 'not_started' }, relevance: { relevant: false, reasons: [] },
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
        NativeModules: { InstalledWidgetAuthorObserver: { mounted: (context: RenderContext) => observeAuthorExecution(context),
            presented: (context: RenderContext, localState: unknown, updateHeader: typeof state.updateHeader) => {
                state.presentations.push(context); state.localStates.push(localState); state.updateHeader = updateHeader;
            } } },
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
const { PaneHeaderContent, defineUiSurface } = require('@happier-dev/plugin-ui');
function WidgetAuthor(context) {
    const [localState] = React.useState(() => ({ count: 1 }));
    const [header, updateHeader] = React.useState(null);
    Native.NativeModules.InstalledWidgetAuthorObserver.presented(context, localState, updateHeader);
    React.useEffect(() => Native.NativeModules.InstalledWidgetAuthorObserver.mounted(context), [context.signal]);
    return React.createElement(Native.View, { testID: 'installed-widget-author' }, header &&
        React.createElement(PaneHeaderContent, { caption: header.caption, line: [header.fact],
            actions: React.createElement(Native.Pressable, { testID: 'authored-header-action' },
                React.createElement(Native.Text, null, 'Link')) }));
}
const renderHeaderSurface = defineUiSurface(WidgetAuthor);
exports.renderSurface = (context) => context.launchInput?.view === 'header-test'
    ? renderHeaderSurface(context) : React.createElement(WidgetAuthor, context);
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
    return { executionOrigin: { serverIdentityId: state.serverIdentityId, materializationRef: { machineId, materializationId: `${pluginId}-${generation}`, pluginId } } };
}

function inlineProps(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.tree.root.findAllByType(PluginInlineSurfaceHost).at(-1)?.props;
}
async function awaitAuthorMount(screen: Awaited<ReturnType<typeof renderScreen>>) {
    state.screen = screen;
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(state.activeMountKeys.size, screen.getTextContent()).toBe(1);
    });
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
const sessionContextRequest = (sessionId: string) => ({
    method: 'POST', path: '/v2/sessions/read-batch',
    parts: expect.objectContaining({ sessionIds: [sessionId], includeSnapshot: true, includeTurns: false, includeMessages: false }),
});

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
        ...(view.sizeDeclaration ? { sizeDeclaration: view.sizeDeclaration } : {}),
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
        sizeDeclaration: { sizes: ['medium', 'large'], defaultSize: 'medium' },
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
        accountLifetime: captureActiveServerAccountScopeLifetime(),
        ...overrides,
    } as SessionPluginRuntimeState;
}

function createInstalledItem(sessionId = 'session-1'): SessionBoardItemProjection { return {
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
                    session: { kind: 'value', value: { serverId: state.serverId, sessionId } },
                    view: { kind: 'value', value: 'summary' },
                },
            } },
        },
    },
}; }

let item = createInstalledItem();

function InstalledWidgetHostFixture(props: React.ComponentProps<typeof SessionWidgetHost> & React.PropsWithChildren & { companion?: boolean }): React.ReactElement {
    const current = props.pluginRuntime ?? runtime();
    const raw = current.pluginUiProjection ? rawProjections.get(current.pluginUiProjection) ?? null : null;
    state.projection = raw;
    React.useLayoutEffect(() => {
        publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: state.serverId });
    }, [raw]);
    return <AppShellPluginUiProjectionValueProvider value={{
        ...current, clientExecutableActivation: { status: 'ready' },
        reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {},
    }}>{props.companion && props.item.state.kind === 'ready' && props.item.state.item.source.kind === 'widget' && state.session
        ? <PluginGlance instance={props.item.state.item.source.instance} session={state.session} sessionId={props.sessionId}
            serverId={state.serverId} frameStyle="card" bodyPresented measurementOnly={false} testID="widget" />
        : <SessionWidgetHost {...props} serverId={state.serverId} />}{props.children}</AppShellPluginUiProjectionValueProvider>;
}

function SurroundingPane(props: React.PropsWithChildren) {
    usePaneHeaderSlotContent({ line: { segments: ['Surrounding pane'] } });
    const header = usePublishedPaneHeaderContent('surrounding');
    return <>{header?.line?.segments.map((part, index) => <React.Fragment key={index}>{typeof part === 'string' ? part : part.text}</React.Fragment>)}{props.children}</>;
}

async function renderPlacement(input: Readonly<{
    host: SessionBoardMountHost;
    primaryHost: SessionBoardMountHost | null;
    density: 'full' | 'compact' | 'preview';
    expanded?: boolean;
    width?: React.ComponentProps<typeof SessionWidgetHost>['width'];
    runtimeOverrides?: Partial<SessionPluginRuntimeState>;
    onManagePlugin?: () => void;
    onOpenHere?: () => void;
    onResize?: React.ComponentProps<typeof SessionWidgetHost>['onResize'];
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
        width: input.width,
        canEdit: true,
        executableCurrentness: input.executableCurrentness ?? 'current',
        heightBounds: { min: 96, max: 520 },
        pluginRuntime: current,
        resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver(),
        ...(input.onManagePlugin ? { onManagePlugin: input.onManagePlugin } : {}),
        ...(input.onOpenHere ? { onOpenHere: input.onOpenHere } : {}),
        ...(input.onResize ? { onResize: input.onResize } : {}),
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
        retirePresentationNotice();
        state.mounts = [];
        state.rawAuthorExecutions = [];
        state.presentations = [];
        state.localStates = [];
        state.activeExecutions.clear();
        state.screen = null;
        clearDaemonMergedProjectionCacheForTests();
        state.projectionsByMachine = {};
        state.deferredProjection = null;
        state.sessionResponses = {};
        state.sessionRequests = [];
        state.approvalWriteMode = 'none';
        state.approvalWriteBody = null;
        state.requiredApprovalPolicy = null;
        state.artifactReads = 0;
        state.updateHeader = null;
        state.session = createSessionFixture({ id: 'session-1' });
        state.httpSessions = { [state.session.id]: state.session };
        await import('@/sync/syncEngine');
        restoreExecutorLoader = await installRealActionExecutorModuleLoader();
        const http = createHomeHubArtifactHttpBoundary('viewer');
        const features = createRootLayoutFeaturesResponse({
            features: { sessions: { board: { enabled: true } } },
            capabilities: { serverIdentity: { serverIdentityId: state.serverIdentityId } },
        });
        // This composed fixture hosts a trusted native plugin bundle. Advertise
        // its actual Home capability and catalog dependencies through HTTP;
        // the real surface host must still enforce the fail-closed decision.
        for (const feature of ['sessions.board', 'plugins', 'plugins.ui', 'plugins.ui.reactNativeBundles', 'machines.transfer'] as const) {
            if (!tryWriteServerEnabledBitInPlace(features, feature, true)) throw new Error(`Expected the canonical ${feature} feature`);
        }
        const request = createSessionReadBatchFetchBoundary(async (input, init) => {
            const path = new URL(String(input)).pathname;
            // The real Account bootstrap and target reader consume the same
            // Machine served by this daemon RPC boundary.
            const machine = createMachineFixture({ activeAt: Date.now(), daemonState: pluginArtifactTransferDaemonState });
            if (path === '/v1/machines') return Response.json(['machine-1', ...Object.keys(state.projectionsByMachine)]
                .filter((id, index, ids) => ids.indexOf(id) === index)
                .map(id => createPlainMachineRowFixture({ id, accountId: 'viewer', machine: { ...machine, id } })));
            const machineRead = createPlainMachineReadHttpResponseFixture(path, init, 'viewer', machine);
            if (machineRead) return machineRead;
            if (path === '/v2/account/settings' && state.requiredApprovalPolicy) return Response.json({
                content: { t: 'plain', v: { actionsSettingsV1: state.requiredApprovalPolicy } }, version: 2,
            });
            if (path === '/v1/artifacts' && init?.method === 'POST' && state.approvalWriteMode !== 'none') {
                const payload: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : null;
                state.approvalWriteBody = payload;
                if (state.approvalWriteMode === 'refused') return Response.json({ error: 'forbidden' }, { status: 403 });
                if (!payload || typeof payload !== 'object') throw new Error('Expected Artifact creation payload');
                return Response.json({ ...payload, ownerAccountId: 'viewer', access: 'owner', encryptionMode: 'plain',
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            }
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            // Dynamic Widget options discover their consuming descriptor
            // through the real Board port; this Home has an empty Board.
            if (path === '/v2/sessions/session-1/system-records/record') return Response.json({ record: null });
            if (path === '/v2/sessions/session-1/system-records') return Response.json({ records: [], nextCursor: null, hasNext: false });
            if (path === '/v2/sessions/query' || path === '/v2/sessions' || path === '/v2/sessions/active') {
                return Response.json(createSessionListSourceFixture({
                    sessions: Object.values(state.httpSessions).map(sessionHttpRecord), nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                }));
            }
            // Optional display backfill is outside this read-only Session
            // fixture. Refuse it honestly while keeping the admitted row.
            if (/^\/v2\/sessions\/[^/]+$/.test(path) && init?.method === 'PATCH') return Response.json({ error: 'forbidden' }, { status: 403 });
            const sessionId = /^\/v2\/sessions\/([^/]+)$/.exec(path)?.[1];
            const response = sessionId ? state.sessionResponses[sessionId] : undefined;
            if (response) return (await response).clone();
            const session = sessionId ? state.httpSessions[sessionId] : undefined;
            if (session) return Response.json({ session: sessionHttpRecord(session) });
            // Account Availability must settle before the real Artifact
            // owner admits even daemon-selected development widget bytes.
            return createEmptyAccountBootstrapHttpResponse(path, init) ?? http.request(input, init);
        });
        accountConnection = await restoreServerAccountForTest({ serverUrl: 'http://installed-session-widget.test', accountId: 'viewer',
            serverIdentityId: state.serverIdentityId,
            request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                const exactSessionId = /^\/v2\/sessions\/([^/]+)$/.exec(path)?.[1];
                const isExactSessionRead = exactSessionId !== undefined
                    && (Object.hasOwn(state.httpSessions, exactSessionId) || Object.hasOwn(state.sessionResponses, exactSessionId));
                if (path === '/v2/sessions/read-batch' || (init?.method ?? 'GET') === 'GET'
                    && (isExactSessionRead || path.startsWith('/v1/sessions/'))) {
                    state.sessionRequests.push({ method: init?.method ?? 'GET', path,
                        ...(path === '/v2/sessions/read-batch' ? { parts: JSON.parse(String(init?.body)) as unknown } : {}) });
                }
                return request(input, init);
            } });
        state.serverId = resolveServerProfileScopeId(accountConnection.home);
        storage.setState({ profile: AccountProfileSchema.parse({ id: 'viewer' }),
            profileScope: { serverId: state.serverId, accountId: 'viewer' } });
        state.session = createSessionFixture({ id: 'session-1', serverId: state.serverId });
        state.httpSessions = { [state.session.id]: state.session };
        item = createInstalledItem();
        storage.getState().applySessions([state.session]);
        const machine = createMachineFixture({ activeAt: Date.now(), daemonState: pluginArtifactTransferDaemonState });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [state.serverId]: [machine] }, endpointStatus: 'online' });
        // Restore starts the real Account acquisition asynchronously. Finish
        // the exact Session's public route acquisition before observing a host
        // so legacy fixture metadata cannot be upgraded beneath its first body.
        const { sync } = await import('@/sync/sync');
        await act(async () => {
            await sync.awaitBootstrapForegroundAcquisition();
            await sync.ensureSessionVisibleForMessageRoute('session-1', { serverId: state.serverId, hydrateMessages: false, forceRefresh: true });
        });
        const session = storage.getState().sessions['session-1'];
        if (!session || session.metadataLayoutVersion !== 1) throw new Error('Expected the real current Session projection before host measurement');
        state.session = session;
        state.httpSessions[session.id] = session;
        state.sessionRequests = [];
    });

    afterEach(async () => {
        standardCleanup();
        retirePresentationNotice();
        restoreExecutorLoader?.();
        restoreExecutorLoader = undefined;
        await accountConnection?.dispose();
        accountConnection = undefined;
    });

    it('retains configured local state and executable lifetime after an acknowledged native height record revision changes', async () => {
        // The unchanged daemon projection is one external lifetime boundary; recreating it would
        // publish a registry invalidation independently of the acknowledged item-height edit.
        const runtimeOverrides = { pluginUiProjection: projection() };
        const screen = await renderPlacement({ host: 'details', primaryHost: 'details', density: 'full', width: 'medium', runtimeOverrides });
        const physicalMount = state.mounts[0]?.mountInstanceKey;
        const localState = state.localStates.at(-1);
        // The persisted record boundary publishes a new revision after the native item-height upsert;
        // the configured instance itself is unchanged. Native mutation/revision correctness is owner-tested.
        if (item.state.kind !== 'ready') throw new Error('Expected readable native item');
        const instance = item.state.item.source.kind === 'widget' ? item.state.item.source.instance : null;
        item = { ...item, revision: 'rev-2', state: { kind: 'ready', item: { ...item.state.item,
            height: { mode: 'fixed', size: 'tall' } } } };
        await renderPlacement({ host: 'details', primaryHost: 'details', density: 'full', width: 'medium', screen, runtimeOverrides });
        expect(state.activeMountKeys).toEqual(new Set([physicalMount]));

        expect(state.localStates.at(-1)).toBe(localState);
        expect(state.mounts).toHaveLength(1);
        expect(item.state.kind === 'ready' && item.state.item.source.kind === 'widget' ? item.state.item.source.instance : null).toBe(instance);
        expect(state.presentations.at(-1)?.widgetPresentation?.footprint).toMatchObject({ columnSpan: 6, rowSpan: 4 });
        await act(async () => { screen.findByTestId('widget.viewport')!.props.onLayout({ nativeEvent: { layout: { width: 350, height: 520 } } }); });
        expect(state.presentations.at(-1)?.widgetPresentation?.geometry).toEqual({ width: 350, height: 520 });

        if (item.state.kind !== 'ready' || item.state.item.source.kind !== 'widget') throw new Error('Expected readable widget');
        item = { ...item, revision: 'rev-3', state: { kind: 'ready', item: { ...item.state.item,
            title: 'Renamed counter', source: { ...item.state.item.source,
                instance: { ...item.state.item.source.instance, displayName: 'Renamed counter' } } } } };
        await renderPlacement({ host: 'details', primaryHost: 'details', density: 'full', width: 'medium', screen, runtimeOverrides });
        expect(screen.getTextContent()).toContain('Renamed counter');
        expect(state.localStates.at(-1)).toBe(localState);
        expect(state.activeMountKeys).toEqual(new Set([physicalMount]));

        if (item.state.kind !== 'ready' || item.state.item.source.kind !== 'widget') throw new Error('Expected readable widget');
        item = { ...item, revision: 'rev-4', state: { kind: 'ready', item: { ...item.state.item,
            source: { ...item.state.item.source, instance: { ...item.state.item.source.instance,
                bindings: { ...item.state.item.source.instance.bindings, view: { kind: 'value', value: 'details' } } } } } } };
        await renderPlacement({ host: 'details', primaryHost: 'details', density: 'full', width: 'medium', screen, runtimeOverrides });
        expect(state.mounts.at(-1)?.launchInput).toMatchObject({ view: 'details' });
        expect(state.localStates.at(-1)).not.toBe(localState);
        expect(state.activeMountKeys.has(String(physicalMount))).toBe(false);
    });

    it.each([false, true])('lends the public plugin header to its own frame and retains the body (Companion: %s)', async (companion) => {
        if (item.state.kind !== 'ready' || item.state.item.source.kind !== 'widget') throw new Error('Expected installed instance');
        item.state.item.source.instance.displayName = 'My review';
        item.state.item.source.instance.bindings.view = { kind: 'value', value: 'header-test' };
        const current = runtime();
        const detailsPlacement = { primaryHost: 'details' as const, executableCurrentness: 'current' as const };
        const screen = await renderScreen(<PaneHeaderSlotProvider><PaneHeaderSlotScope slotKey="surrounding">
            <SurroundingPane><InstalledWidgetHostFixture {...detailsPlacement} companion={companion}
                sessionId="session-1" session={state.session ?? undefined} item={item} host="details" density="full"
                canEdit pluginRuntime={current} testID="widget" /></SurroundingPane>
        </PaneHeaderSlotScope></PaneHeaderSlotProvider>);
        await awaitAuthorMount(screen);
        const bodyState = state.localStates.at(-1);
        const initialMounts = state.rawAuthorExecutions.length;
        const initialText = screen.getTextContent();
        expect(state.updateHeader).toBeTypeOf('function');
        await act(async () => { state.updateHeader?.({ caption: 'Reviews', fact: '1 needs you' }); });
        await flushHookEffects();
        expect(screen.findByTestId('widget-frame.plugin-header.subtitle'), screen.getTextContent()).not.toBeNull();
        expect(screen.findByTestId('authored-header-action')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Surrounding pane');
        expect(screen.getTextContent()).toContain('1 needs you');
        expect(screen.getTextContent()).toContain('Reviews');
        expect(screen.getTextContent()).toContain('My review');
        if (!companion) expect(screen.findByTestId('widget-provenance')?.props.accessibilityLabel).toContain('Review Assistant');
        await act(async () => { state.updateHeader?.({ caption: 'Open reviews', fact: '2 needs you' }); });
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('2 needs you');
        expect(screen.getTextContent()).not.toContain('1 needs you');
        await act(async () => { state.updateHeader?.(null); });
        await flushHookEffects();
        expect(screen.findByTestId('authored-header-action')).toBeNull();
        expect(screen.findByTestId('widget-frame.plugin-header.subtitle')).toBeNull();
        expect(screen.getTextContent()).toContain('Surrounding pane');
        expect(screen.getTextContent()).toBe(initialText);
        expect(state.localStates.at(-1)).toBe(bodyState);
        expect(state.rawAuthorExecutions).toHaveLength(initialMounts);
    });

    it('titles an unnamed installed widget by its contribution title, never by the local id an Action seeded as the item title', async () => {
        if (item.state.kind !== 'ready') throw new Error('Expected readable native item');
        item = { ...item, state: { kind: 'ready', item: { ...item.state.item, title: SURFACE.localId } } };
        const screen = await renderPlacement({ host: 'details', primaryHost: 'details', density: 'full', width: 'medium' });
        expect(screen.findByTestId('widget-title')?.props.children).toBe('Review status');
        expect(screen.getTextContent()).not.toContain(SURFACE.localId);
    });

    it.each([
        { mode: 'refused' as const, severity: 'error' as const },
        { mode: 'created' as const, severity: 'info' as const },
    ])('reports a $mode size approval without changing the retained Board rectangle', async ({ mode, severity }) => {
        const previous = JSON.stringify(item);
        // This scenario requires durable Inbox approval, rather than the default
        // present-user confirmation. Seed that exact Account policy at both
        // its persisted HTTP boundary and its current Settings projection.
        state.approvalWriteMode = mode;
        state.requiredApprovalPolicy = normalizeActionsSettingsV1({ v: 1,
            actions: { 'widgets.item.size.set': { approvalRequiredSurfaces: ['ui'] } },
        });
        storage.getState().applySettingsForScope({ serverId: state.serverId, accountId: 'viewer' }, {
            ...storage.getState().settings, actionsSettingsV1: state.requiredApprovalPolicy,
        }, 2);
        const screen = await renderPlacement({ host: 'details', primaryHost: 'details', density: 'full',
            width: 'medium', onResize: () => {} });
        await screen.pressByTestIdAsync('widget-actions');
        await screen.pressByTestIdAsync('widget.size.large');
        // The native Board's shared approval owner runs for real. Only its HTTP
        // Artifact write is refused or accepted; neither outcome mutates the Board.
        await vi.waitFor(async () => {
            // Let each asynchronous settlement commit before inspecting the
            // menu, rather than holding React's batch open during the wait.
            await flushHookEffects();
            expect(screen.findByTestId('widget.size.large')?.props.disabled).toBe(false);
        });
        const payload = state.approvalWriteBody;
        if (!payload || typeof payload !== 'object' || !('body' in payload) || typeof payload.body !== 'string')
            throw new Error('Expected encoded approval Artifact');
        const content: unknown = decodePlainArtifactStoredContent(payload.body);
        if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string')
            throw new Error('Expected approval request body');
        const request = StoredApprovalRequestSchema.parse(JSON.parse(content.body));
        expect(request).toMatchObject({ actionId: 'widgets.item.size.set', actionArgs: {
            ref: { surface: { serverId: state.serverId, accountId: 'viewer', owner: { kind: 'sessionBoard', sessionId: 'session-1' } },
                instanceId: 'widget-1' }, size: 'large',
        } });
        expect(readPresentationNotice()).toMatchObject({ key: 'session-1:widget-1:size', severity });
        expect(JSON.stringify(item)).toBe(previous);
        expect(screen.findByTestId('widget.size.medium')?.props.accessibilityState?.checked).toBe(true);
    });

    it('shows no named size selected for an existing custom native rectangle', async () => {
        if (item.state.kind !== 'ready') throw new Error('Expected installed item');
        item = { ...item, state: { kind: 'ready', item: { ...item.state.item, height: { mode: 'fixed', size: 'tall' } } } };
        const screen = await renderPlacement({ host: 'details', primaryHost: 'details', density: 'full',
            width: 'compact', onResize: () => {} });
        await screen.pressByTestIdAsync('widget-actions');
        expect(screen.findByTestId('widget.size.medium')?.props.accessibilityState?.checked).toBe(false);
        expect(screen.findByTestId('widget.size.large')?.props.accessibilityState?.checked).toBe(false);
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

    it('delivers the actual unnamed native Board rectangle and measured viewport without resizing or replacing the executable', async () => {
        if (item.state.kind !== 'ready') throw new Error('Expected installed item');
        item = { ...item, state: { kind: 'ready', item: { ...item.state.item, height: { mode: 'fixed', size: 'tall' } } } };
        const before = JSON.stringify(item);
        const screen = await renderPlacement({ host: 'details', primaryHost: 'details', density: 'full', width: 'compact' });
        expect(state.presentations.at(-1)?.widgetPresentation?.size).toBeUndefined();
        expect(state.presentations.at(-1)?.widgetPresentation?.footprint).toMatchObject({ columns: 12, columnSpan: 4, rowSpan: 4 });
        const viewport = screen.findByTestId('widget.viewport');
        expect(viewport).not.toBeNull();
        await act(async () => { viewport!.props.onLayout({ nativeEvent: { layout: { width: 350, height: 520 } } }); });
        expect(state.presentations.at(-1)?.widgetPresentation).toMatchObject({
            footprint: { columnSpan: 4, rowSpan: 4 }, geometry: { width: 350, height: 520 } });
        expect(JSON.stringify(item)).toBe(before);
        expect(state.activeMountKeys.size).toBe(1);
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
        expect(screen.findByType(WidgetFrame)?.props.viewportHeight).toBe(432);

        await screen.update(renderWidget({ mode: 'fixed', size: 'compact' }));
        await act(async () => { reportHeight?.(500); });
        expect(screen.findByType(WidgetFrame)?.props.viewportHeight).toBe(160);

        const fitContent = actionsOf(screen).find((action) => action.id === 'height-auto');
        (fitContent?.onPress as (() => void) | undefined)?.();
        expect(onSetHeight).toHaveBeenLastCalledWith({ mode: 'auto', fallback: 'tall' });

        await screen.update(renderWidget({ mode: 'auto', fallback: 'tall' }));
        expect(screen.findByType(WidgetFrame)?.props.viewportHeight).toBe(500);
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
        const screen = await renderPlacement({ host: 'inlineTranscript', primaryHost: 'details', density: 'preview' });
        expect(state.mounts).toHaveLength(0);
        // A configured widget that cannot be opened here still says where it runs; an empty body
        // read as a widget that failed to render (live, phone transcript).
        expect(screen.findHostByTestId('widget-elsewhere')).toBeTruthy();
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
        // Use a genuinely unseen target; deleting only a previously acquired
        // row leaves Sync's admitted list/currentness state warm.
        const session = { ...state.session!, id: 'session-cold' };
        item = createInstalledItem(session.id);
        // This case demands an exact, uncached Session. Advertising it in the
        // independent list source also admits background display hydration.
        let settleSession: ((response: Response) => void) | undefined;
        state.sessionResponses[session.id] = new Promise(resolve => { settleSession = resolve; });
        const screen = await renderPlacement({ host: 'details', density: 'full' });

        expect(state.mounts).toHaveLength(0);
        const cards = screen.tree.root.findAll(
            (node) => typeof (node.props as { diagnosticCode?: unknown }).diagnosticCode === 'string',
            { deep: true },
        );
        const codes = cards.map((node) => (node.props as { diagnosticCode: string }).diagnosticCode);
        expect(codes).toContain('widget_session_hydrating');
        expect(codes).not.toContain('session_board_renderer_missing');
        expect(codes).not.toContain('widget_session_unavailable');
        await vi.waitFor(() => expect(state.sessionRequests).toEqual([sessionContextRequest(session.id)]));
        await act(async () => {
            settleSession?.(Response.json({ session: sessionHttpRecord(session) }));
        });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect({ activeBodies: state.activeMountKeys.size, artifactReads: state.artifactReads,
                installedHosts: screen.tree.root.findAllByType(PluginInlineSurfaceHost).length,
                nativeHosts: screen.tree.root.findAllByType(PluginReactNativeSurface).length,
                sessionPresent: storage.getState().sessions[session.id] !== undefined }, screen.getTextContent())
                .toMatchObject({ activeBodies: 1, sessionPresent: true });
        });
        expect(storage.getState().sessions[session.id]?.serverId).toBe(state.serverId);
        expect(state.sessionRequests).toEqual([sessionContextRequest(session.id)]);
    });

    it.each([
        { status: 404, reasonCode: 'widget_session_unavailable' },
        { status: 403, reasonCode: 'widget_session_access_denied' },
    ])('settles a confirmed HTTP $status Session refusal without running plugin code', async ({ status, reasonCode }) => {
        const sessionId = 'session-cold';
        item = createInstalledItem(sessionId);
        state.sessionResponses[sessionId] = Promise.resolve(Response.json({ error: status === 404 ? 'Session not found' : 'Forbidden' }, { status }));
        const screen = await renderPlacement({ host: 'details', density: 'full' });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(state.sessionRequests).toEqual([sessionContextRequest(sessionId)]);
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
            // Loading reserves the body as a busy region (lab dashboards ST), not an explanatory card.
            expect(screen.tree.root.findAll(node => node.props.accessibilityRole === 'progressbar' && node.props['aria-busy'] === true).length).toBeGreaterThan(0);
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
