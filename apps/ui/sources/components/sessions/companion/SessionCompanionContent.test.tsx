import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import {
    readPresentationNotice,
    retirePresentationNotice,
} from '@/components/sessions/presentation/presentationNotices';
import { createSessionBoardSourceAvailabilityResolver } from '@/components/sessions/board/sessionBoardItemPresentation';
import { createSessionFixture } from '@/dev/testkit';
import { createSessionSurfaceNoteDocumentV1, SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board';
import { resolveWidgetSizeChoicesV1, WidgetDefinitionV1Schema, WidgetSizeDeclarationV1Schema, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import type { SessionWidgetHostProps } from '@/components/sessions/board/SessionWidgetHost';
import { sessionCompanionGlanceLabel } from './glances/SessionCompanionGlance';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { HostedHtmlSurfaceAdapter } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { loadPluginUiHostSupport } from '@/components/plugins/hostApi/loadPluginUiHostSupport';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Only the physical iframe is replaced; Companion, the shared widget host,
// authored definition admission and hosted runtime stay real.
vi.mock('@/components/browser/frame/BrowserViewFrame.web', () => ({
    BrowserViewFrame: () => React.createElement('BrowserViewFrame', { testID: 'companion-visual-frame' }),
}));

installDisconnectedServerSocketBoundary();

vi.mock('@/text', () => createTextModuleMock());

it('names an inline Companion copy from its published definition, preserving its local rename', () => {
    const instance: WidgetInstanceV1 = { v: 1, id: 'shared-copy', bindings: {}, definition: { kind: 'inline', definition: {
        v: 1, id: 'shared-definition', name: 'Shared checks', body: { kind: 'installed', surface: { pluginId: 'acme.ci', localId: 'checks' } },
        sizeDeclaration: WidgetSizeDeclarationV1Schema.parse(resolveWidgetSizeChoicesV1('sessionBoard')),
        inputs: { fields: [] }, inputSchema: { type: 'object' }, provenance: { source: { kind: 'authored' } },
    } } };
    expect(sessionCompanionGlanceLabel({ kind: 'instance', ref: { kind: 'instance', instance } })).toBe('Shared checks');
    expect(sessionCompanionGlanceLabel({ kind: 'instance', ref: { kind: 'instance', instance: { ...instance, displayName: 'My checks' } } })).toBe('My checks');
});

const summaryModel = {
    scope: 'exact' as const,
    title: 'Teams lane 08',
    agentLabel: 'Claude',
    agentId: null,
    status: { state: 'thinking' as const, statusText: 'Working', quiet: false },
    stale: false,
    availability: 'complete' as const,
    encryption: 'plain' as const,
    identityDestination: 'sessionInfo' as const,
    rows: [] as const,
    needsYou: null,
    sinceMs: null,
    progress: null,
    plan: null,
    facts: [] as const,
};
vi.mock('./summary/useSessionSummaryModel', () => ({
    useSessionSummaryModel: () => summaryModel,
}));

const widgetHostProps = vi.fn();
vi.mock('@/components/sessions/board/SessionWidgetHost', async () => {
    const actual = await vi.importActual<typeof import('@/components/sessions/board/SessionWidgetHost')>(
        '@/components/sessions/board/SessionWidgetHost',
    );
    return {
        ...actual,
        SessionWidgetHost: (props: SessionWidgetHostProps) => {
            widgetHostProps(props);
            return <actual.SessionWidgetHost {...props} />;
        },
    };
});

import {
    projectSessionBoard,
    type SessionBoardItemProjection,
    type SessionBoardSnapshot,
} from '@/sync/domains/session/board';

import { SessionCompanionContent } from './SessionCompanionContent';
import {
    HIDDEN_SESSION_COMPANION_PREFERENCE_V1,
    SESSION_SUMMARY_COMPANION_ITEM,
    moveSessionCompanionItem,
    type SessionCompanionItemRefV1,
    type SessionCompanionPreferenceV1,
} from './state/sessionCompanionPreference';
import type { SessionCompanionController } from './state/useSessionCompanionController';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = createSessionFixture({ id: 'session-1' });

const installedItem = (itemId: string): SessionBoardItemProjection => ({
    itemId,
    revision: 'r1',
    state: {
        kind: 'ready',
        item: {
            v: 1,
            title: 'External conversations',
            frame: 'card',
            height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: { v: 1, id: itemId, definition: { kind: 'installed', surface: { pluginId: 'channels', localId: 'conversations' } }, bindings: {} } },
        },
    },
});

const readyItem = (itemId: string): SessionBoardItemProjection => ({
    itemId,
    revision: 'r1',
    state: {
        kind: 'ready',
        item: {
            v: 1,
            title: 'Deploy status',
            frame: 'card',
            height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('') },
        },
    },
});

function snapshot(overrides: Partial<SessionBoardSnapshot> = {}): SessionBoardSnapshot {
    return {
        ...projectSessionBoard({
            layout: undefined,
            items: new Map(),
            capabilities: null,
            freshness: 'fresh',
            reachability: 'reachable',
            loading: 'idle',
            incomplete: false,
        }),
        ...overrides,
    };
}

const binding = (overrides: Partial<SessionBoardSnapshot> = {}) => ({
    status: 'ready' as const,
    snapshot: snapshot(overrides),
    refresh: vi.fn(),
});

const removeItem = vi.fn();
const moveItem = vi.fn();
const show = vi.fn();
const applyLocalInverse = vi.fn();

function controller(items: readonly SessionCompanionItemRefV1[]): SessionCompanionController {
    const preference: SessionCompanionPreferenceV1 = {
        ...HIDDEN_SESSION_COMPANION_PREFERENCE_V1,
        visible: true,
        items,
    };
    return {
        preference,
        availability: 'ready',
        preferenceExists: true,
        show,
        hide: () => null,
        setCollapsed: () => null,
        setEdge: () => null,
        setDensity: () => null,
        addItem: () => null,
        removeItem,
        moveItem,
        setItemFrameStyle: () => null,
        setInstanceInputs: () => null,
        setInstanceNetwork: () => null,
        renameInstance: () => null,
        openFullSurface: () => {},
        applyLocalInverse,
        realmKey: 'account-a:home-1:session-1',
    };
}

describe('SessionCompanionContent (mounted)', () => {
    beforeEach(() => {
        widgetHostProps.mockClear();
        removeItem.mockClear();
        moveItem.mockClear();
        show.mockClear();
        applyLocalInverse.mockClear();
        retirePresentationNotice();
    });

    it('renders an agent-published inline HTML visual in the exact Companion Home through the real shared host', async () => {
        const http = createHomeHubArtifactHttpBoundary('viewer');
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://companion-visual.test',
            serverIdentityId: 'srv_companion_visual', accountId: 'viewer', request: (url, init) => {
                // Restoring the viewer also bootstraps Account Project rows; this
                // widget fixture has none and uses that reader's strict response.
                if (new URL(String(url)).pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
                    return Promise.resolve(Response.json(ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', rows: [], coverage: 'complete' })));
                }
                return http.request(url, init);
            } });
        const viewer = getActiveServerAccountScope();
        if (!viewer) throw new Error('Expected current viewer');
        const exactSession = createSessionFixture({ id: 'visual-session', serverId: viewer.serverId });
        storage.getState().applySessions([exactSession]);
        const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'daily-visual', name: 'Daily usage',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
            inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
            body: { kind: 'html', source: artifactHtmlBundleFromBodyV1('<main>Daily usage</main>'),
                requestedCapabilities: { network: 'none' } } });
        const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: definition.name, frame: 'card',
            height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'widget', instance: {
                v: 1, id: 'daily-placement', definition: { kind: 'inline', definition }, bindings: {},
            } } });
        const board = projectSessionBoard({ layout: undefined,
            items: new Map([['daily-placement', { revision: 'visual:1', outcome: { status: 'ready', value: item } }]]),
            capabilities: { readTranscript: true, editSessionRecords: true }, freshness: 'fresh',
            reachability: 'reachable', loading: 'idle', incomplete: false });
        vi.stubGlobal('location', { origin: 'https://app.happier.dev' });
        const content = (serverId: string) => <InjectedAuthProvider credentials={connection.credentials}>
            <SessionCompanionContent session={exactSession} serverId={serverId}
                controller={controller([{ kind: 'widget', widgetId: 'daily-placement' }])}
                boardBinding={{ status: 'ready', snapshot: board }} resolvePrimaryHost={() => 'companion'}
                resolveSourceAvailability={createSessionBoardSourceAvailabilityResolver({ hostedHtmlRendererAvailable: true })} />
        </InjectedAuthProvider>;
        const screen = await renderScreen(content(viewer.serverId));
        try {
            // The reference is presented once the column has laid it out inside its viewport.
            await act(async () => {
                screen.findHostByTestId('session-companion-content')!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 600 } } });
                screen.findHostByTestId('session-companion-content-item-widget:daily-placement')!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 260 } } });
            });
            expect(screen.tree.root.findAllByProps({ diagnosticCode: 'widget_viewer_scope_mismatch' })).toHaveLength(0);
            await act(async () => { await loadPluginUiHostSupport(); });
            await vi.waitFor(() => expect(screen.tree.root.findAllByType(HostedHtmlSurfaceAdapter)).toHaveLength(1));
            await vi.waitFor(() => expect(screen.findByTestId('companion-visual-frame')).not.toBeNull());
            expect(screen.tree.root.findByType(HostedHtmlSurfaceAdapter).props.source).toEqual(
                definition.body.kind === 'html' ? definition.body.source : null,
            );
            expect(screen.findByTestId('session-companion-widget-daily-placement-state')).toBeNull();
            await screen.update(content('other-home'));
            expect(screen.tree.root.findAllByType(HostedHtmlSurfaceAdapter)).toHaveLength(0);
            expect(screen.findByTestId('companion-visual-frame')).toBeNull();
            await screen.update(content(viewer.serverId));
            await vi.waitFor(() => expect(screen.findByTestId('companion-visual-frame')).not.toBeNull());
            expect(http.writes).toEqual([]);
        } finally { await screen.unmount(); await connection.dispose(); vi.unstubAllGlobals(); }
    });

    it('mounts a direct personal copy\'s body on its first presentation, holds its room until then, and keeps it once presented', async () => {
        const http = createHomeHubArtifactHttpBoundary('viewer');
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://companion-demand.test', serverIdentityId: 'srv_companion_demand', accountId: 'viewer', request: (url, init) => {
            if (new URL(String(url)).pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
                return Promise.resolve(Response.json(ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', rows: [], coverage: 'complete' })));
            }
            return http.request(url, init);
        } });
        const viewer = getActiveServerAccountScope();
        if (!viewer) throw new Error('Expected current viewer');
        const exactSession = createSessionFixture({ id: 'demand-session', serverId: viewer.serverId });
        storage.getState().applySessions([exactSession]);
        const refs = ['first', 'second'].map(id => ({ kind: 'instance' as const, instance: {
            v: 1 as const, id, bindings: {}, definition: { kind: 'inline' as const, definition: WidgetDefinitionV1Schema.parse({
                v: 1, id, name: id, sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
                inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
                body: { kind: 'html', source: artifactHtmlBundleFromBodyV1(`<main>${id}</main>`), requestedCapabilities: { network: 'none' } },
            }) },
        } }));
        vi.stubGlobal('location', { origin: 'https://app.happier.dev' });
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}>
            <SessionCompanionContent session={exactSession} serverId={viewer.serverId} controller={controller(refs)}
                boardBinding={null} resolvePrimaryHost={() => null} />
        </InjectedAuthProvider>);
        const bodies = () => screen.tree.root.findAllByType(WidgetSurface).map(body => body.props.instance.id);
        const item = (id: string) => screen.findHostByTestId(`session-companion-content-item-instance:${id}`)!;
        const place = (id: string, y: number) => item(id).props.onLayout({ nativeEvent: { layout: { x: 0, y, width: 320, height: 260 } } });
        const scroll = screen.findHostByTestId('session-companion-content')!;
        try {
            // Before any layout nothing has been presented, and the frame still holds the room a body would take.
            expect(bodies()).toEqual([]);
            expect(screen.findByTestId('session-companion-content-glance-instance:first.deferred')).not.toBeNull();
            await act(async () => {
                scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 600 } } });
                place('first', 0);
                place('second', 4000);
            });
            expect(bodies()).toEqual(['first']);
            await act(async () => { scroll.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 4000 } } }); });
            expect(bodies().sort()).toEqual(['first', 'second']);
        } finally { await screen.unmount(); await connection.dispose(); vi.unstubAllGlobals(); }
    });

    it('mounts a widget through the shared host with the exact Session and shell-derived primary mount', async () => {
        const pluginRuntime = { serverId: 'server-a' } as never;
        const callerHostedHtmlRuntime = { serverIdentityId: 'server-identity-a' } as never;
        const renderer = await renderScreen(
            <SessionCompanionContent
                session={session}
                serverId="server-a"
                controller={controller([{ kind: 'widget', widgetId: 'w1' }])}
                boardBinding={binding({
                    itemsById: new Map([['w1', readyItem('w1')]]),
                    capabilities: { readTranscript: true, editSessionRecords: true },
                    canEdit: true,
                })}
                resolvePrimaryHost={() => 'details'}
                pluginRuntime={pluginRuntime}
                callerHostedHtmlRuntime={callerHostedHtmlRuntime}
                resolveSourceAvailability={createSessionBoardSourceAvailabilityResolver({
                    hostedHtmlRendererAvailable: true,
                })}
            />,
        );

        expect(renderer.findByTestId('session-companion-content-item-widget:w1')).not.toBeNull();
        expect(widgetHostProps.mock.calls[0]?.[0]).toMatchObject({
            sessionId: 'session-1',
            host: 'companion',
            // Not 'companion': the Companion consumes the shell's answer instead
            // of appointing itself, so Details keeps the single executable mount.
            primaryHost: 'details',
            pluginRuntime,
            callerHostedHtmlRuntime,
        });
        const resolveSourceAvailability = widgetHostProps.mock.calls[0]?.[0]
            ?.resolveSourceAvailability as ((source: unknown) => unknown) | undefined;
        expect(resolveSourceAvailability?.({
            kind: 'hostedHtml',
            source: artifactHtmlBundleFromBodyV1('<main>Companion</main>'),
            requestedCapabilities: {},
        })).toEqual({ kind: 'available' });
    });

    it('uses the incumbent inert preview path and withholds every executable control during cold measurement', async () => {
        const pluginRuntime = { serverId: 'server-a' } as never;
        const callerHostedHtmlRuntime = { serverIdentityId: 'server-identity-a' } as never;
        const openBoard = vi.fn();
        const managePlugin = vi.fn();

        const renderer = await renderScreen(
            <SessionCompanionContent
                session={session}
                serverId="server-a"
                controller={controller([{ kind: 'widget', widgetId: 'w1' }])}
                boardBinding={binding({
                    itemsById: new Map([['w1', readyItem('w1')]]),
                    capabilities: { readTranscript: true, editSessionRecords: true },
                    canEdit: true,
                })}
                resolvePrimaryHost={() => 'companion'}
                pluginRuntime={pluginRuntime}
                callerHostedHtmlRuntime={callerHostedHtmlRuntime}
                onRevealBoardItem={openBoard}
                onManageBoardItemPlugin={managePlugin}
                measurementOnly
                testID="measurement-content"
            />,
        );

        expect(renderer.findByTestId('measurement-content-item-widget:w1')).not.toBeNull();
        expect(widgetHostProps.mock.calls[0]?.[0]).toMatchObject({
            sessionId: 'session-1',
            host: 'companion',
            primaryHost: null,
            canEdit: false,
            pluginRuntime,
        });
        expect(widgetHostProps.mock.calls[0]?.[0]).not.toHaveProperty('callerHostedHtmlRuntime');
        expect(widgetHostProps.mock.calls[0]?.[0]).not.toHaveProperty('onOpenHere');
        expect(widgetHostProps.mock.calls[0]?.[0]).not.toHaveProperty('onManagePlugin');
        expect(widgetHostProps.mock.calls[0]?.[0]).not.toHaveProperty('onRemove');
        expect(renderer.findByTestId('measurement-content-item-widget:w1-actions')).toBeNull();
        expect(openBoard).not.toHaveBeenCalled();
        expect(managePlugin).not.toHaveBeenCalled();
    });

    it('measures the same Summary the live rail shows, with inert destinations', async () => {
        const mutableModel = summaryModel as unknown as { rows: readonly unknown[]; facts: readonly unknown[] };
        mutableModel.rows = [
            { kind: 'approvals', count: 2, destination: 'approvals' },
            { kind: 'workflow', runCount: 1, destination: 'workTab' },
        ];
        mutableModel.facts = [
            { kind: 'subagents', live: 1, total: 1, destination: 'workTab' },
            { kind: 'changes', count: 3, destination: 'git' },
        ];
        const openApprovals = vi.fn();
        const openGit = vi.fn();
        const renderMeasured = (measurementOnly: boolean) => renderScreen(
            <SessionCompanionContent
                session={session}
                serverId="server-a"
                controller={controller([SESSION_SUMMARY_COMPANION_ITEM])}
                boardBinding={binding()}
                resolvePrimaryHost={() => null}
                summaryDestinations={{ approvals: openApprovals, git: openGit }}
                presentation="rail"
                measurementOnly={measurementOnly}
                testID={measurementOnly ? 'measured' : 'live'}
            />,
        );
        try {
            const live = await renderMeasured(false);
            const measured = await renderMeasured(true);
            for (const [renderer, prefix] of [[live, 'live'], [measured, 'measured']] as const) {
                expect(renderer.findByTestId(`${prefix}-summary-row-approvals`)).not.toBeNull();
                expect(renderer.findByTestId(`${prefix}-summary-fact-changes`)).not.toBeNull();
            }
            // The measured card keeps its shape but nothing in it can navigate.
            (measured.findByTestId('measured-summary-row-approvals')?.props as { onPress?: () => void }).onPress?.();
            (measured.findByTestId('measured-summary-fact-changes')?.props as { onPress?: () => void }).onPress?.();
            expect(openApprovals).not.toHaveBeenCalled();
            expect(openGit).not.toHaveBeenCalled();
        } finally {
            mutableModel.rows = [];
            mutableModel.facts = [];
        }
    });

    it('draws a widget as a flat section of the column, with one menu and no Board-only controls', async () => {
        const managePlugin = vi.fn();
        const openBoard = vi.fn();
        const renderer = await renderScreen(
            <SessionCompanionContent
                session={session}
                serverId="server-a"
                controller={controller([{ kind: 'widget', widgetId: 'w1' }])}
                boardBinding={binding({
                    itemsById: new Map([['w1', installedItem('w1')]]),
                    capabilities: { readTranscript: true, editSessionRecords: true },
                    canEdit: true,
                })}
                resolvePrimaryHost={() => 'details'}
                onRevealBoardItem={openBoard}
                onManageBoardItemPlugin={managePlugin}
            />,
        );

        const mounted = widgetHostProps.mock.calls.at(-1)?.[0] as Record<string, unknown>;
        expect(mounted).toMatchObject({ frame: 'section', canEdit: false });
        // The Companion keeps a reference: deleting or editing the shared record, and a
        // second "open" control beside the menu's, belong to the Board.
        expect(mounted).not.toHaveProperty('onRemove');
        expect(mounted).not.toHaveProperty('onOpenHere');
        const [actionOwner] = renderer.findAll((node) => Array.isArray(node.props?.actions)
            && node.props?.overflowTriggerTestID === 'session-companion-content-item-widget:w1-actions');
        const actions = actionOwner?.props.actions as ReadonlyArray<{ id: string; onPress?: () => void }>;
        expect(actions.map((action) => action.id)).toEqual(['open-board', 'manage-plugin', 'frameStyle', 'remove']);
        actions.find((action) => action.id === 'manage-plugin')?.onPress?.();
        expect(managePlugin).toHaveBeenCalledWith('w1');
        expect(removeItem).not.toHaveBeenCalled();
    });

    it('uses compact widget composition in the rail and fill composition in the full surface', async () => {
        const board = snapshot({ itemsById: new Map([['w1', readyItem('w1')]]) });
        const shared = {
            session,
            serverId: 'server-a',
            controller: controller([{ kind: 'widget' as const, widgetId: 'w1' }]),
            boardBinding: binding({ itemsById: board.itemsById }),
            resolvePrimaryHost: () => 'companion' as const,
        };

        await renderScreen(<SessionCompanionContent {...shared} presentation="rail" />);
        expect(widgetHostProps.mock.calls.at(-1)?.[0]).toMatchObject({ density: 'compact', expanded: false });

        await renderScreen(<SessionCompanionContent {...shared} presentation="full" />);
        expect(widgetHostProps.mock.calls.at(-1)?.[0]).toMatchObject({ density: 'full', expanded: true });
    });

    it('renders a recoverable pending state, never a deletion, while the inventory is incomplete', async () => {
        const renderer = await renderScreen(
            <SessionCompanionContent
                session={session}
                serverId="server-a"
                controller={controller([{ kind: 'widget', widgetId: 'w1' }])}
                boardBinding={binding({ incomplete: true })}
                resolvePrimaryHost={() => null}
            />,
        );

        expect(renderer.findByTestId('session-companion-content-pending-w1')).not.toBeNull();
        expect(renderer.findByTestId('session-companion-content-removed-w1')).toBeNull();
    });

    it('calls an absent widget removed only once the Board inventory is authoritative', async () => {
        const renderer = await renderScreen(
            <SessionCompanionContent
                session={session}
                serverId="server-a"
                controller={controller([{ kind: 'widget', widgetId: 'w1' }])}
                boardBinding={binding()}
                resolvePrimaryHost={() => null}
            />,
        );

        expect(renderer.findByTestId('session-companion-content-removed-w1')).not.toBeNull();
        expect(renderer.findByTestId('session-companion-content-removed-w1-action')).not.toBeNull();
    });

    it('keeps an unreachable Board recoverable rather than tombstoning every reference', async () => {
        const renderer = await renderScreen(
            <SessionCompanionContent
                session={session}
                serverId="server-a"
                controller={controller([{ kind: 'widget', widgetId: 'w1' }])}
                boardBinding={binding({ reachability: 'offline' })}
                resolvePrimaryHost={() => null}
            />,
        );

        expect(renderer.findByTestId('session-companion-content-pending-w1')).not.toBeNull();
    });

    it('keeps revoked Board references visible without hiding the independent Session Summary', async () => {
        const renderer = await renderScreen(
            <SessionCompanionContent
                session={session}
                serverId="server-a"
                controller={controller([
                    SESSION_SUMMARY_COMPANION_ITEM,
                    { kind: 'widget', widgetId: 'w1' },
                ])}
                boardBinding={{ status: 'unavailable', reason: 'forbidden', refresh: vi.fn() }}
                resolvePrimaryHost={() => null}
            />,
        );

        expect(renderer.findByTestId('session-companion-content-summary')).not.toBeNull();
        expect(renderer.findByTestId(
            'session-companion-content-pending-w1-diagnostic-session_companion_widget_access_revoked',
        )).not.toBeNull();
        expect(renderer.getTextContent()).toContain('session.follow.accessLost');
    });

    it('offers retry for an offline Board reference through the incumbent binding refresh', async () => {
        const refresh = vi.fn();
        const renderer = await renderScreen(
            <SessionCompanionContent
                session={session}
                serverId="server-a"
                controller={controller([{ kind: 'widget', widgetId: 'w1' }])}
                boardBinding={{ status: 'unavailable', reason: 'offline', refresh }}
                resolvePrimaryHost={() => null}
            />,
        );
        await renderer.pressByTestIdAsync('session-companion-content-pending-w1-action');

        expect(renderer.findByTestId(
            'session-companion-content-pending-w1-diagnostic-session_companion_widget_offline',
        )).not.toBeNull();
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('keeps Open on Board available for stale but reachable content', async () => {
        const openBoard = vi.fn();
        const renderer = await renderScreen(
            <SessionCompanionContent
                session={session}
                serverId="server-a"
                controller={controller([{ kind: 'widget', widgetId: 'w1' }])}
                boardBinding={binding({
                    freshness: 'stale',
                    itemsById: new Map([['w1', readyItem('w1')]]),
                })}
                resolvePrimaryHost={() => null}
                onRevealBoardItem={openBoard}
            />,
        );
        const [actionOwner] = renderer.findAll((node) => Array.isArray(node.props?.actions)
            && node.props?.overflowTriggerTestID === 'session-companion-content-item-widget:w1-actions');
        const actions = actionOwner?.props.actions as ReadonlyArray<{ id: string; onPress?: () => void }>;

        actions.find((action) => action.id === 'open-board')?.onPress?.();

        expect(openBoard).toHaveBeenCalledWith('w1');
    });

    it('refuses a configured-instance menu move when the qualified widget Action owner is unavailable', async () => {
        const instance = { kind: 'instance' as const, instance: { v: 1 as const, id: 'personal-summary', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} } };
        const pane = { kind: 'widget' as const, widgetId: 'w1' };
        let preference: SessionCompanionPreferenceV1 = { ...HIDDEN_SESSION_COMPANION_PREFERENCE_V1, visible: true, items: [SESSION_SUMMARY_COMPANION_ITEM, instance, pane] };
        const companion: SessionCompanionController = {
            ...controller(preference.items),
            moveItem: (item, index) => {
                const previous = preference;
                preference = moveSessionCompanionItem(previous, item, index);
                return preference === previous ? null : { previous, applied: preference };
            },
        };
        const renderer = await renderScreen(<SessionCompanionContent session={session} serverId="server-a" controller={companion}
            boardBinding={binding({ itemsById: new Map([['w1', readyItem('w1')]]) })} resolvePrimaryHost={() => null} />);
        const [owner] = renderer.findAll(node => Array.isArray(node.props?.actions)
            && node.props?.overflowTriggerTestID === 'session-companion-content-item-instance:personal-summary-actions');
        const actions = owner?.props.actions as ReadonlyArray<{ id: string; onPress?: () => void }>;
        actions.find(action => action.id === 'move-up')?.onPress?.();
        expect(preference.items).toEqual([SESSION_SUMMARY_COMPANION_ITEM, instance, pane]);
        expect(readPresentationNotice()).toMatchObject({ key: 'widgets.item.move', severity: 'error' });
    });

    it('keeps a refused personal rename draft and treats the unchanged empty name as a no-op', async () => {
        const instance = { kind: 'instance' as const, instance: { v: 1 as const, id: 'personal-summary', definition: { kind: 'builtin' as const, id: 'session_summary' },
            bindings: { session: { kind: 'context' as const, slot: 'session' } } } };
        const renameInstance = vi.fn((_instanceId: string, _displayName: string | null) => null);
        const companion: SessionCompanionController = { ...controller([instance]), renameInstance };
        const renderer = await renderScreen(<SessionCompanionContent session={session} serverId="server-a" controller={companion}
            boardBinding={binding()} resolvePrimaryHost={() => null} />);
        const menu = () => renderer.findAll(node => Array.isArray(node.props?.actions)
            && node.props?.overflowTriggerTestID === 'session-companion-content-item-instance:personal-summary-actions')[0]!;
        const rename = async (text: string) => {
            await act(async () => { (menu().props.actions as ReadonlyArray<{ id: string; onPress?: () => void }>).find(action => action.id === 'rename')?.onPress?.(); });
            const field = renderer.findByTestId('session-companion-content-item-instance:personal-summary-title-input')!;
            await act(async () => { field.props.onChangeText(text); });
            await act(async () => { renderer.findByTestId('session-companion-content-item-instance:personal-summary-title-input')!.props.onSubmitEditing(); });
        };
        await rename('Release soak');
        expect(renameInstance).not.toHaveBeenCalled();
        const refused = renderer.findByTestId('session-companion-content-item-instance:personal-summary-title-input')!;
        expect(refused.props.value).toBe('Release soak');
        await act(async () => { refused.props.onKeyPress({ nativeEvent: { key: 'Escape' } }); });
        await rename('  ');
        // Nothing to clear yet: the copy still has the widget's own name.
        expect(renameInstance).not.toHaveBeenCalled();
    });

    it('gives every mounted item a reachable local action menu', async () => {
        const renderer = await renderScreen(
            <SessionCompanionContent
                session={session}
                serverId="server-a"
                controller={controller([
                    SESSION_SUMMARY_COMPANION_ITEM,
                    { kind: 'widget', widgetId: 'w1' },
                ])}
                boardBinding={binding({
                    itemsById: new Map([['w1', readyItem('w1')]]),
                    capabilities: { readTranscript: true, editSessionRecords: true },
                    canEdit: true,
                })}
                resolvePrimaryHost={() => 'companion'}
            />,
        );

        expect(renderer.findByTestId('session-companion-content-item-builtin:session_summary-actions')).not.toBeNull();
        expect(renderer.findByTestId('session-companion-content-item-widget:w1-actions')).not.toBeNull();
    });

    it('uses the translation owner for every visible string', async () => {
        const renderer = await renderScreen(
            <SessionCompanionContent
                session={session}
                serverId="server-a"
                controller={controller([])}
                boardBinding={binding()}
                resolvePrimaryHost={() => null}
            />,
        );

        // The text mock echoes keys, so hardcoded English would surface here as
        // prose instead of the translation key its owner resolves.
        const [empty] = renderer.findAll((node) => (
            node.props?.testID === 'session-companion-content-empty'
            && typeof node.props?.title === 'string'
        ));
        expect(empty?.props.title).toBe('sessionBoard.companion.empty.title');
        expect(empty?.props.reason).toBe('sessionBoard.companion.empty.reason');
        expect(empty?.props.action?.label).toBe('sessionBoard.companion.actions.addSummary');
    });
});
