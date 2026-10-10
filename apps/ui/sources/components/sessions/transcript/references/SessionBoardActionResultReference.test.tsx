import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import * as React from 'react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createSessionSurfaceNoteDocumentV1, SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board';
import { PluginProjectionV2Schema, tryWriteServerEnabledBitInPlace, type PluginProjectionV2 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createSessionFixture, makeToolCall, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionBoardSnapshot } from '@/sync/domains/session/board';
import { storage } from '@/sync/domains/state/storage';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { widgetProjectionEntry } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { answerMachineProjectionDescribeAtRpcBoundary } from '@/dev/testkit/mocks/machineProjectionRpc';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';

/**
 * The last mile of the Agent visualization journey, at the real transcript row.
 *
 * The producers for this existed and had no caller: `SessionBoardMountHost`
 * already listed `inlineTranscript`, `SessionWidgetHost` already had its inert
 * arm and `resolveSessionBoardReferenceState` already knew how to answer a
 * viewer-local reference — but no transcript row ever mounted a Board item, so
 * an Agent that created a widget produced a JSON blob in the transcript.
 *
 * These tests mount the REAL tool row, the REAL Board controller provider and the
 * REAL widget shell. The Board's record transport is replaced at its own owner
 * (`useSessionBoardSnapshot`) exactly as the Board's own mounted tests do; the
 * projection, presentation, mount-mode and navigation below all run for real.
 */

const REVISION = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';

const INSTALLED_SURFACE = vi.hoisted(() => ({ pluginId: 'acme.board', localId: 'status' }));

const harness = vi.hoisted(() => ({
    itemPresent: true,
    serverId: 'home-a',
    daemonProjection: null as PluginProjectionV2 | null,
    incomplete: false,
    installedSource: false,
    unavailable: null as string | null,
    reachability: 'reachable' as 'reachable' | 'offline',
    primaryHost: 'details' as 'details' | 'inlineTranscript' | null,
    pluginMounts: [] as Record<string, unknown>[],
    companionAvailable: true,
    companionInputs: [] as Array<Readonly<{
        sessionId: string;
        serverId: string | null;
        openFullSurface: () => void;
    }>>,
    companionShow: vi.fn(),
    companionApplyLocalInverse: vi.fn(() => true),
    revealCompanionAfterMutation: vi.fn(),
    revealBoardItem: vi.fn(),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
installDisconnectedServerSocketBoundary();
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (params: { method: string; machineId: string; payload?: { pluginId?: string } }) => {
        if (params.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
            const pluginId = params.payload?.pluginId;
            const entry = Object.values(harness.daemonProjection?.familiesById.pluginUi?.entriesById ?? {})
                .find(entry => entry.pluginId === pluginId);
            return { status: 'current', targetedContributions: { target: {
                pluginId, occurrenceId: entry?.occurrenceId,
                sourceCustody: { kind: 'development', registeredRootId: `${pluginId}-fixture` },
            }, points: [] }, targetedSurfaceMounts: [] };
        }
        return answerMachineProjectionDescribeAtRpcBoundary(() => ({
            supported: true, projection: harness.daemonProjection,
        }))(params);
    },
}));
vi.mock('@/sync/domains/plugins/availability/bundledAppExactArtifactSource', () => ({
    createBundledPluginUiAppExactArtifactSource: () => ({
        kind: 'appExact',
        readFile: vi.fn(async () => null),
    }),
}));
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [],
}));
vi.mock('@/sync/domains/plugins/availability/reader', () => ({
    createPluginAccountAvailabilityReader: vi.fn(() => null),
    createPluginAccountAvailabilityReaderStore: vi.fn(() => ({
        get: vi.fn(() => null),
        subscribe: vi.fn(() => () => {}),
    })),
    projectPluginAccountAvailabilityMaterializationIdentity: vi.fn(() => null),
}));
vi.mock('@/text', () => ({
    t: (key: string) => key,
    getPreferredLanguage: () => 'en',
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/components/ui/surfaces/hostedHtml/useSessionCallerHostedHtmlRuntime', () => ({
    useSessionCallerHostedHtmlRuntime: () => null,
}));
vi.mock('@/components/sessions/companion/state/useSessionCompanionController', () => ({
    useSessionCompanionController: (input: Readonly<{
        sessionId: string;
        serverId: string | null;
        openFullSurface: () => void;
    }>) => {
        harness.companionInputs.push(input);
        return ({
        preference: {
            v: 1,
            visible: false,
            collapsed: false,
            edge: 'trailing',
            density: 'comfortable',
            items: [],
        },
        availability: harness.companionAvailable ? 'ready' : 'realm_unavailable',
        preferenceExists: true,
        show: harness.companionShow,
        removeItem: vi.fn(),
        applyLocalInverse: harness.companionApplyLocalInverse,
    });
    },
}));
// The installed-surface arm's real frame is a plugin process boundary; a preview
// must never reach it, which is exactly what one of these tests asserts.
vi.mock('@/components/plugins/reactNative/PluginReactNativeSurface', async (importOriginal) => {
    const ReactModule = await import('react');
    const original = await importOriginal<typeof import('@/components/plugins/reactNative/PluginReactNativeSurface')>();
    return {
        ...original,
        PluginReactNativeSurface: (props: React.ComponentProps<typeof original.PluginReactNativeSurface>) => {
            // Count a physical mount, not React render passes caused by the
            // surrounding controller settling. Re-renders are not duplicate
            // executable placements.
            ReactModule.useEffect(() => {
                harness.pluginMounts.push({ ...props });
            }, []);
            return ReactModule.createElement('ForeignBoardWidget');
        },
    };
});
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));

function snapshot(): SessionBoardSnapshot {
    const source = harness.installedSource
        ? { kind: 'widget', instance: { v: 1, id: 'item-1', definition: { kind: 'installed', surface: INSTALLED_SURFACE },
            bindings: { session: { kind: 'context', slot: 'session' } } } }
        : { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('Ship the release') };
    return {
        layoutState: { kind: 'ready' },
        layoutRevision: REVISION,
        views: [{ id: 'overview', title: null, synthetic: true, placements: [] }],
        itemsById: new Map(harness.itemPresent
            ? [['item-1', {
                itemId: 'item-1',
                revision: REVISION,
                state: { kind: 'ready', item: SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Release checklist', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source }) },
            }]]
            : []),
        unplacedItemIds: harness.itemPresent ? ['item-1'] : [],
        capabilities: { readTranscript: true, editSessionRecords: true },
        canEdit: true,
        freshness: 'fresh',
        reachability: harness.reachability,
        loading: 'idle',
        incomplete: harness.incomplete,
    } as unknown as SessionBoardSnapshot;
}

vi.mock('@/components/sessions/board/useSessionBoardSnapshot', () => ({
    useSessionBoardSnapshot: () => (harness.unavailable
        ? { status: 'unavailable', reason: harness.unavailable, refresh: vi.fn() }
        : { status: 'ready', refresh: vi.fn(), snapshot: snapshot() }),
}));

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionBoardControllerProvider } from '@/components/sessions/board/SessionBoardControllerProvider';
import { SessionCompanionRevealPortProvider } from '@/components/sessions/companion/presentation/SessionCompanionRevealPort';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import {
    readPresentationNotice,
    retirePresentationNotice,
} from '@/components/sessions/presentation/presentationNotices';
import { ToolView } from '@/components/tools/shell/views/ToolView';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';

await loadSyncSingletonForTests();

function installedProjection() {
    const entry = { ...widgetProjectionEntry({ ...INSTALLED_SURFACE, title: 'Board status',
        occurrenceId: 'acme.board#1' }), renderer: { kind: 'reactNative', contributionId: 'widget-native' } };
    const artifactId = 'acme-board-widget';
    const digest = `sha256:${'a'.repeat(64)}`;
    const relativePath = `react-native/${artifactId}/entry.cjs.bundle`;
    const renderer = {
        id: 'reactNativeBundle:acme.board:widget-native', pluginId: INSTALLED_SURFACE.pluginId,
        occurrenceId: entry.occurrenceId, contributionKind: 'reactNativeBundle', contributionId: 'widget-native',
        generatedV2: true, pluginVersion: '1.0.0', artifactGraph: {
            artifactId, tier: 'reactNative', entry: relativePath,
            files: [{ relativePath, digest: `sha256:${'b'.repeat(64)}`, byteSize: 16 }], digest,
            builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0',
        },
        runtime: { decision: { state: 'load', reason: 'compatible', diagnostics: [] }, loadPolicy: { source: 'installedArtifact' },
            cacheKey: artifactId, cacheIdentity: { artifactDigest: digest } },
    };
    return PluginProjectionV2Schema.parse({
        v: 2, generation: 3, actionsById: {}, installedPackagesById: {
            [INSTALLED_SURFACE.pluginId]: { id: INSTALLED_SURFACE.pluginId, displayName: 'Board Status',
                version: '1.0.0', occurrenceId: entry.occurrenceId, enabled: true,
                source: { kind: 'path', locator: '/plugins/acme.board' } },
        }, familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [entry.id]: entry, [renderer.id]: renderer } } },
    });
}

async function prepareInstalledWidget() {
    const previous = storage.getState();
    const locks = installWebLockManagerMock();
    const http = createHomeHubArtifactHttpBoundary('viewer');
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Expected Board feature');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://transcript-board-widget.test', accountId: 'viewer',
        request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v2/sessions/session-1/system-records/record') return Response.json({ record: null });
            if (path === '/v2/sessions/session-1/system-records') return Response.json({ records: [], nextCursor: null, hasNext: false });
            return http.request(url, init);
        } });
    harness.serverId = connection.home.id;
    harness.daemonProjection = installedProjection();
    clearDaemonMergedProjectionCacheForTests();
    const session = createSessionFixture({ id: 'session-1', serverId: harness.serverId,
        metadata: { path: '/fixture', host: 'fixture', machineId: 'machine-a' } });
    const machine = createMachineFixture({ id: 'machine-a', activeAt: Date.now() });
    storage.setState({ endpointStatus: 'online', sessions: { [session.id]: session }, machines: { [machine.id]: machine },
        machineListByServerId: { [harness.serverId]: [machine] } });
    onTestFinished(async () => {
        standardCleanup();
        clearDaemonMergedProjectionCacheForTests();
        await connection.dispose();
        storage.setState(previous, true);
        locks.restore();
    });
}

const SCOPE_ID = createSessionPaneScopeId('session-1', 'home-a');

function appliedResult(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
        v: 1,
        serverId: harness.serverId,
        sessionId: 'session-1',
        result: {
            operation: 'upsert_item',
            itemId: 'item-1',
            outcome: 'created',
            itemRevision: REVISION,
            layoutRevision: REVISION,
        },
        destination: { tabId: 'overview', width: 'wide' },
        ...overrides,
    });
}

function boardUpsertToolCall(overrides: Record<string, unknown> = {}) {
    return makeToolCall({
        name: 'mcp__happier__session_board_item_upsert',
        state: 'completed',
        input: {
            itemId: 'item-1',
            expectedItemRevision: null,
            item: {
                v: 1,
                title: 'Release checklist',
                frame: 'card',
                height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('Ship the release') },
            },
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' },
        },
        result: appliedResult(),
        ...overrides,
    });
}

async function renderRow(
    tool = boardUpsertToolCall(),
    serverId: string | null = harness.serverId,
    revealServerId: string | null = harness.serverId,
) {
    let scopeState: any = null;
    const Probe = () => {
        scopeState = useAppPaneScope(SCOPE_ID).scopeState;
        return null;
    };
    const row = (
        <AppSessionTranscriptSourceProvider sessionId="session-1" serverId={serverId}>
        <AppPaneProvider>
            <SessionBoardControllerProvider
                sessionId="session-1"
                serverId={serverId}
                resolvePrimaryHost={() => harness.primaryHost}
            >
                <SessionCompanionRevealPortProvider
                    address={revealServerId === null ? null : { serverId: revealServerId, sessionId: 'session-1' }}
                    openFullSurface={() => {}}
                    revealAfterMutation={harness.revealCompanionAfterMutation}
                    revealBoardItem={harness.revealBoardItem}
                >
                    <ToolView
                        tool={tool}
                        metadata={null}
                        messages={[]}
                        sessionId="session-1"
                        {...(serverId === null ? {} : { serverId })}
                        messageId="message-1"
                    />
                </SessionCompanionRevealPortProvider>
                <Probe />
            </SessionBoardControllerProvider>
        </AppPaneProvider>
        </AppSessionTranscriptSourceProvider>
    );
    const screen = await renderScreen(harness.daemonProjection
        ? <AppShellPluginUiProjectionValueProvider value={{
            pluginUiProjection: normalizePluginUiProjection(harness.daemonProjection), pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, serverId: harness.serverId, machineId: 'machine-a', platform: 'web',
            accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {}, reloadConnectedAccountProjection() {},
        }}>{row}</AppShellPluginUiProjectionValueProvider> : row);
    return { screen, readScopeState: () => scopeState };
}

beforeEach(() => {
    standardCleanup();
    // The mounted Board controller now derives executable plugin policy from
    // the exact Session record. Keep this integration fixture on that real
    // owner path instead of accidentally testing the no-Session fallback.
    storage.setState((state) => ({
        ...state,
        sessions: {
            ...state.sessions,
            'session-1': createSessionFixture({
                id: 'session-1',
                serverId: 'home-a',
                active: true,
            }),
        },
    }));
    retirePresentationNotice();
    harness.itemPresent = true;
    harness.serverId = 'home-a';
    harness.daemonProjection = null;
    harness.incomplete = false;
    harness.installedSource = false;
    harness.unavailable = null;
    harness.reachability = 'reachable';
    harness.primaryHost = 'details';
    harness.pluginMounts.length = 0;
    harness.companionAvailable = true;
    harness.companionInputs.length = 0;
    harness.companionShow.mockReset();
    harness.companionApplyLocalInverse.mockClear();
    harness.revealCompanionAfterMutation.mockReset();
    harness.revealBoardItem.mockReset();
    harness.companionShow.mockImplementation(() => ({
        previous: {
            v: 1,
            visible: false,
            collapsed: false,
            edge: 'trailing',
            density: 'comfortable',
            items: [],
        },
        applied: {
            v: 1,
            visible: true,
            collapsed: false,
            edge: 'trailing',
            density: 'comfortable',
            items: [{ kind: 'widget', widgetId: 'item-1' }],
        },
    }));
});

function widgetActionsOf(screen: Awaited<ReturnType<typeof renderRow>>['screen']): ReadonlyArray<Record<string, unknown>> {
    const owners = screen.tree.root.findAll(
        (node) => Array.isArray((node.props as { actions?: unknown }).actions)
            && (node.props as { overflowTriggerTestID?: string }).overflowTriggerTestID
                === 'transcript-board-widget-item-1-actions',
        { deep: true },
    );
    return (owners.at(-1)?.props as { actions?: Record<string, unknown>[] } | undefined)?.actions ?? [];
}

describe('inline transcript Board result', () => {
    it('mounts the exact Board item a completed upsert acknowledged', async () => {
        const { screen } = await renderRow();
        expect(screen.findByTestId('transcript-board-item-item-1')).toBeTruthy();
        expect(screen.findByTestId('transcript-board-widget-item-1')).toBeTruthy();
        expect(screen.findByTestId('transcript-board-widget-item-1-title')).toBeTruthy();
    });

    it('mounts nothing for an unrelated tool call', async () => {
        const { screen } = await renderRow(makeToolCall({ name: 'Read', input: { file_path: '/a' }, result: 'ok' }));
        expect(screen.findAllHostsByTestId('transcript-board-item-item-1')).toHaveLength(0);
    });

    it('mounts nothing when the row cannot name its exact Home', async () => {
        const { screen } = await renderRow(boardUpsertToolCall(), null);
        expect(screen.findAllHostsByTestId('transcript-board-item-item-1')).toHaveLength(0);
    });

    it('opens the canonical mounted Board destination with the exact item selected', async () => {
        const { screen } = await renderRow();
        const open = screen.findByTestId('transcript-board-item-item-1-open');
        expect(open).toBeTruthy();
        await pressTestInstanceAsync(open!, 'transcript-board-item-item-1-open');
        expect(harness.revealBoardItem).toHaveBeenCalledWith('item-1');
    });

    it('offers Show in Companion through the exact-Home controller with one safe local Undo notice', async () => {
        const { screen } = await renderRow();
        const action = widgetActionsOf(screen).find((candidate) => candidate.id === 'add-to-companion');

        expect(action).toBeDefined();
        (action?.onPress as (() => void) | undefined)?.();

        expect(harness.companionInputs).toContainEqual({
            sessionId: 'session-1',
            serverId: 'home-a',
            openFullSurface: expect.any(Function),
        });
        expect(harness.companionShow).toHaveBeenCalledWith({ kind: 'widget', widgetId: 'item-1' });
        expect(harness.revealCompanionAfterMutation).toHaveBeenCalledWith(expect.objectContaining({
            applied: expect.objectContaining({
                visible: true,
                items: [{ kind: 'widget', widgetId: 'item-1' }],
            }),
        }));
        const notice = readPresentationNotice();
        expect(notice?.key).toContain('companion.item.add');
        expect(notice?.undo).toBeDefined();
        notice?.undo?.run();
        expect(harness.companionApplyLocalInverse).toHaveBeenCalledTimes(1);
    });

    it('does not expose local reveal actions through another Home\'s same-id presentation port', async () => {
        const { screen } = await renderRow(boardUpsertToolCall(), 'home-a', 'home-b');
        const action = widgetActionsOf(screen).find((candidate) => candidate.id === 'add-to-companion');
        expect(action).toBeUndefined();
        expect(screen.findByTestId('transcript-board-item-item-1-open')).toBeNull();
        expect(harness.companionShow).not.toHaveBeenCalled();
        expect(harness.revealCompanionAfterMutation).not.toHaveBeenCalled();
        expect(harness.revealBoardItem).not.toHaveBeenCalled();
    });

    it('does not expose reveal actions without a mounted exact-Session presentation port', async () => {
        const { screen } = await renderRow(boardUpsertToolCall(), 'home-a', null);

        expect(widgetActionsOf(screen).map((candidate) => candidate.id)).not.toContain('add-to-companion');
        expect(screen.findByTestId('transcript-board-item-item-1-open')).toBeNull();
    });

    it('does not reveal when the Companion preference mutation is unchanged or unavailable', async () => {
        harness.companionShow.mockReturnValue(null);
        const { screen } = await renderRow();
        const action = widgetActionsOf(screen).find((candidate) => candidate.id === 'add-to-companion');

        (action?.onPress as (() => void) | undefined)?.();

        expect(harness.revealCompanionAfterMutation).not.toHaveBeenCalled();
        expect(readPresentationNotice()).toBeNull();
    });

    it('does not advertise Show in Companion when the exact preference realm is unavailable', async () => {
        harness.companionAvailable = false;
        const { screen } = await renderRow();

        expect(widgetActionsOf(screen).map((candidate) => candidate.id)).not.toContain('add-to-companion');
    });

    it('does not advertise Show in Companion while the exact Board Home is unreachable', async () => {
        harness.reachability = 'offline';
        const { screen } = await renderRow();

        expect(widgetActionsOf(screen).map((candidate) => candidate.id)).not.toContain('add-to-companion');
        expect(harness.companionShow).not.toHaveBeenCalled();
        expect(harness.revealCompanionAfterMutation).not.toHaveBeenCalled();
    });

    it('stays an inert preview and starts no plugin frame while another placement is primary', async () => {
        await prepareInstalledWidget();
        harness.installedSource = true;
        const { screen } = await renderRow();
        expect(screen.findByTestId('transcript-board-widget-item-1')).toBeTruthy();
        expect(harness.pluginMounts).toHaveLength(0);
    });

    it('runs the executable mount only when the shell selects this placement', async () => {
        await prepareInstalledWidget();
        harness.installedSource = true;
        harness.primaryHost = 'inlineTranscript';
        const { screen } = await renderRow();
        expect(screen.findByTestId('transcript-board-widget-item-1')).toBeTruthy();
        await vi.waitFor(() => expect(harness.pluginMounts).toHaveLength(1));
    });

    it('presents removal and loading through the Board item state owner, never as an empty row', async () => {
        harness.itemPresent = false;
        const removed = await renderRow();
        expect(removed.screen.findByTestId('transcript-board-widget-item-1-state')).toBeTruthy();

        standardCleanup();
        harness.incomplete = true;
        const pending = await renderRow();
        expect(pending.screen.findByTestId('transcript-board-widget-item-1-state')).toBeTruthy();
    });

    it('shows the truthful Board-unavailable state when access is revoked', async () => {
        harness.unavailable = 'forbidden';
        const { screen } = await renderRow();
        expect(screen.findByTestId('transcript-board-item-item-1-unavailable')).toBeTruthy();
    });

    it('mounts nothing at all when this Home has no Board feature', async () => {
        harness.unavailable = 'board_feature_disabled';
        const { screen } = await renderRow();
        expect(screen.findAllHostsByTestId('transcript-board-item-item-1')).toHaveLength(0);
    });
});
