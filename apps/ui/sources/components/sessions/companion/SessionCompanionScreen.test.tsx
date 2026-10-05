import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import type { SessionWidgetHostProps } from '@/components/sessions/board/SessionWidgetHost';
import { createSessionSurfaceNoteDocumentV1, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import {
    readPresentationNotice,
    retirePresentationNotice,
} from '@/components/sessions/presentation/presentationNotices';

vi.mock('@/text', () => createTextModuleMock());

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

vi.mock('@/components/sessions/shell/sessionViewStableSession', () => ({
    useSessionViewShellSession: () => ({ id: 'session-1', serverId: 'server-a' }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

const boardSnapshot = vi.fn();
const boardControllerRun = vi.fn();
vi.mock('@/components/sessions/board/SessionBoardControllerProvider', () => ({
    useMountedSessionBoardController: () => ({
        address: { serverId: 'server-a', sessionId: 'session-1' },
        binding: boardSnapshot(),
        controller: {
            supports: (kind: string) => kind === 'item.managePlugin' || kind === 'item.remove',
            run: boardControllerRun,
        },
        pluginRuntime: shellRuntime,
        callerHostedHtmlRuntime: null,
    }),
}));

// The mobile Cockpit shell: no multi-pane, phone class. The REAL host-visibility
// derivation runs on top of these incumbent-owner facts.
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({ scopeId: 'session:s1', scopeState: null }),
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScopeLayout', () => ({
    useOptionalAppPaneScopeLayout: () => ({
        containerWidthPx: 390,
        containerHeightPx: 844,
        mainRegionHeightPx: 844,
        mainRegionWidthPx: 390,
        multiPaneEnabled: false,
        deviceType: 'phone',
        layout: { kind: 'single', right: 'hidden', details: 'hidden' },
        bottomPresentation: 'docked',
    }),
}));
vi.mock('@/sync/domains/session/sessionSurfaceVisibility', () => ({
    isSessionSurfaceVisible: () => true,
}));
vi.mock('@/hooks/ui/useKeyboardHeight', () => ({ useKeyboardHeight: () => 0 }));
vi.mock('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry', () => ({
    useSessionCockpitBottomChromeHeight: () => 64,
    useSessionCockpitComposerChromeHeight: () => 0,
}));

const storedPreference = { value: undefined as unknown };
const mutate = vi.fn();
vi.mock('@/sync/domains/state/storage', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useSessionCompanionPreferenceSlot: () => ({
        stored: storedPreference.value,
        storageKey: JSON.stringify(['server-a', 'account-a', 'session-1']),
    }),
    useMutateSessionCompanionPreference: () => mutate,
}));

const widgetHostProps = vi.fn();
vi.mock('@/components/sessions/board/SessionWidgetHost', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/sessions/board/SessionWidgetHost')>();
    return { ...actual, SessionWidgetHost: (props: SessionWidgetHostProps) => {
        widgetHostProps(props);
        return <actual.SessionWidgetHost {...props} />;
    } };
});

import {
    projectSessionBoard,
    type SessionBoardOpenedRecord,
} from '@/sync/domains/session/board';

import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import {
    PaneHeaderSlotProvider,
    PaneHeaderSlotScope,
    usePublishedPaneHeaderContent,
} from '@/components/appShell/panes/paneHeaderSlot';

import { SessionCompanionScreen } from './SessionCompanionScreen';

/** The phone cockpit's surface header: the large title plus what the Companion publishes. */
function HeaderProbe(): React.ReactElement {
    const published = usePublishedPaneHeaderContent('companion');
    return (
        <PaneHeader
            testID="probe-header"
            size="large"
            title="Companion"
            line={published?.line ?? null}
            actions={published?.action}
        />
    );
}

function inCockpitHeader(children: React.ReactNode): React.ReactElement {
    return (
        <PaneHeaderSlotProvider>
            <HeaderProbe />
            <PaneHeaderSlotScope slotKey="companion">{children}</PaneHeaderSlotScope>
        </PaneHeaderSlotProvider>
    );
}

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const readySnapshot = () => ({
    status: 'ready' as const,
    snapshot: projectSessionBoard({
        layout: undefined,
        items: new Map(),
        capabilities: null,
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
    }),
    refresh: () => {},
});
const resolvePrimaryHost = () => 'companion' as const;
const shellRuntime = {
    serverId: 'server-a',
    machineId: 'machine-from-cockpit-shell',
    pluginUiProjection: null,
    pluginBrowserProjection: null,
    phase: 'current' as const,
    interactionEnabled: true,
    platform: 'web' as const,
};
const shellProps = {
    sessionId: 'session-1',
    address: { serverId: 'server-a', sessionId: 'session-1' },
    onRequestClose: () => {},
    onRevealBoardItem: () => {},
    resolvePrimaryHost,
};

describe('SessionCompanionScreen (mounted, mobile Cockpit)', () => {
    beforeEach(() => {
        widgetHostProps.mockClear();
        boardControllerRun.mockClear();
        mutate.mockClear();
        mutate.mockImplementation((_sessionId: string, project: (stored: unknown) => unknown) => {
            const next = project(storedPreference.value);
            if (next !== null) storedPreference.value = next;
            return next !== null;
        });
        retirePresentationNotice();
        boardSnapshot.mockReturnValue(readySnapshot());
        storedPreference.value = {
            v: 1,
            visible: true,
            collapsed: false,
            edge: 'trailing',
            density: 'compact',
            items: [{ kind: 'builtin', id: 'session_summary' }],
        };
    });

    it('renders one full-height Companion destination with the shared content owner', async () => {
        const renderer = await renderScreen(inCockpitHeader(
            <SessionCompanionScreen
                {...shellProps}
            />,
        ));

        expect(renderer.findByTestId('session-companion-screen')).not.toBeNull();
        expect(renderer.findByTestId('session-companion-content')).not.toBeNull();
        expect(renderer.findByTestId('session-companion-content-summary')).not.toBeNull();
        // The cockpit's large title is the one heading (session-tabs lab Cp): no uppercase eyebrow of
        // its own, and the live line says where it lives and how much it holds.
        expect(renderer.findAllByTestId('session-companion-screen-heading')).toHaveLength(0);
        expect(renderer.findByTestId('probe-header.subtitle')).toBeTruthy();
        const headerText = renderer.getTextContent();
        expect(headerText).toContain('sessionBoard.companion.pane.besideChat');
        expect(headerText).toContain('sessionBoard.companion.pane.itemCount');
        expect(renderer.findByTestId('session-companion-content-item-builtin:session_summary')).not.toBeNull();
    });

    it('invites an empty Companion with the summary and says it is personal (lab STp)', async () => {
        storedPreference.value = {
            v: 1,
            visible: true,
            collapsed: false,
            edge: 'trailing',
            density: 'compact',
            items: [],
        };
        const renderer = await renderScreen(inCockpitHeader(
            <SessionCompanionScreen
                {...shellProps}
            />,
        ));

        expect(renderer.findByTestId('session-companion-content-empty-action')).toBeTruthy();
        expect(renderer.findByTestId('session-companion-content-empty-note')).toBeTruthy();
        const headerText = renderer.getTextContent();
        expect(headerText).toContain('sessionBoard.companion.pane.justForYou');
    });

    it('manages a shared widget through Board while removing only its personal Companion reference', async () => {
        boardSnapshot.mockReturnValue({
            ...readySnapshot(),
            snapshot: projectSessionBoard({
                layout: undefined,
                items: new Map([['w1', {
                    revision: 'r1',
                    outcome: {
                        status: 'ready',
                        value: {
                            v: 1,
                            title: 'Review status',
                            frame: 'card',
                            height: { mode: 'auto', fallback: 'regular' },
                            source: {
                                kind: 'widget',
                                instance: { v: 1, id: 'w1', definition: { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'review-status' } }, bindings: {} },
                            },
                        },
                    },
                }]]),
                capabilities: { readTranscript: true, editSessionRecords: true },
                freshness: 'fresh',
                reachability: 'reachable',
                loading: 'idle',
                incomplete: false,
            }),
        });
        storedPreference.value = {
            v: 1,
            visible: true,
            collapsed: false,
            edge: 'trailing',
            density: 'compact',
            items: [{ kind: 'widget', widgetId: 'w1' }],
        };

        const renderer = await renderScreen(<SessionCompanionScreen {...shellProps} />);
        const mounted = widgetHostProps.mock.calls.at(-1)?.[0] as Record<string, unknown>;
        expect(mounted).not.toHaveProperty('onRemove');
        const [menu] = renderer.findAll((node) => Array.isArray(node.props?.actions)
            && node.props?.overflowTriggerTestID === 'session-companion-content-item-widget:w1-actions');
        const actions = menu?.props.actions as ReadonlyArray<{ id: string; onPress?: () => void }>;
        await act(async () => { actions.find((action) => action.id === 'manage-plugin')?.onPress?.(); });
        expect(boardControllerRun).toHaveBeenCalledWith({ kind: 'item.managePlugin', itemId: 'w1' });
        await act(async () => { actions.find((action) => action.id === 'remove')?.onPress?.(); });
        expect(storedPreference.value).toMatchObject({ items: [], visible: false });
        expect(boardControllerRun.mock.calls.some(([command]) => command.kind === 'item.remove')).toBe(false);
        expect(boardSnapshot().snapshot.itemsById.has('w1')).toBe(true);
    });

    it('preserves the Session Summary when the exact Home cannot provide Board', async () => {
        boardSnapshot.mockReturnValue({
            status: 'unavailable',
            reason: 'board_feature_disabled',
            refresh: vi.fn(),
        });
        const renderer = await renderScreen(inCockpitHeader(
            <SessionCompanionScreen
                {...shellProps}
            />,
        ));

        expect(renderer.findByTestId('session-companion-screen-unavailable')).toBeNull();
        expect(renderer.findByTestId('session-companion-content')).not.toBeNull();
        expect(renderer.findByTestId('session-companion-content-summary')).not.toBeNull();
    });

    it('exposes the Companion menu without collapse controls that would do nothing here', async () => {
        const renderer = await renderScreen(inCockpitHeader(
            <SessionCompanionScreen
                {...shellProps}
            />,
        ));

        const [menu] = renderer.findAll((node) => Array.isArray(node.props?.actions)
            && node.props?.overflowTriggerTestID === 'session-companion-screen-menu');
        const ids = (menu?.props.actions as ReadonlyArray<{ id: string }>).map((action) => action.id);

        expect(ids).toContain('edge-leading');
        expect(ids).toContain('density-comfortable');
        expect(ids).toContain('hide');
        expect(ids).not.toContain('collapse');
        expect(ids).not.toContain('expand');
        // Navigation to "the full surface" from the full surface would be a
        // control with no observable effect.
        expect(ids).not.toContain('open-full');
    });

    it('returns to Chat when the person hides the full-screen Companion', async () => {
        const onRequestClose = vi.fn();
        const renderer = await renderScreen(inCockpitHeader(
            <SessionCompanionScreen
                {...shellProps}
                onRequestClose={onRequestClose}
            />,
        ));
        const [menu] = renderer.findAll((node) => Array.isArray(node.props?.actions)
            && node.props?.overflowTriggerTestID === 'session-companion-screen-menu');
        const actions = menu?.props.actions as ReadonlyArray<{ id: string; onPress?: () => void }>;

        actions.find((action) => action.id === 'hide')?.onPress?.();

        expect(mutate).toHaveBeenCalledTimes(1);
        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(readPresentationNotice()).toMatchObject({
            message: 'sessionBoard.companion.notices.hidden',
            undo: { label: 'sessionBoard.companion.actions.undo' },
        });
    });

    it('publishes feedback only after applied edge and density changes', async () => {
        const renderer = await renderScreen(inCockpitHeader(
            <SessionCompanionScreen {...shellProps} />,
        ));
        const [menu] = renderer.findAll((node) => Array.isArray(node.props?.actions)
            && node.props?.overflowTriggerTestID === 'session-companion-screen-menu');
        const actions = menu?.props.actions as ReadonlyArray<{ id: string; onPress?: () => void }>;

        actions.find((action) => action.id === 'density-compact')?.onPress?.();
        expect(readPresentationNotice()).toBeNull();

        actions.find((action) => action.id === 'edge-leading')?.onPress?.();
        expect(readPresentationNotice()).toMatchObject({
            message: 'sessionBoard.companion.notices.moved',
            undo: { label: 'sessionBoard.companion.actions.undo' },
        });

        retirePresentationNotice();
        actions.find((action) => action.id === 'density-comfortable')?.onPress?.();
        expect(readPresentationNotice()).toMatchObject({
            message: 'sessionBoard.companion.actions.comfortable',
            undo: { label: 'sessionBoard.companion.actions.undo' },
        });
    });

    it('offers safe Undo when a readable Board item is added from the Add to Companion picker', async () => {
        const boardItems = new Map<string, SessionBoardOpenedRecord<SessionSurfaceItemV1>>([['widget-1', {
            revision: 'r1',
            outcome: {
                status: 'ready',
                value: {
                    v: 1,
                    title: 'Deploy status',
                    frame: 'card',
                    height: { mode: 'auto', fallback: 'regular' },
                    source: {
                        kind: 'declarative',
                        document: createSessionSurfaceNoteDocumentV1(''),
                    },
                },
            },
        }]]);
        boardSnapshot.mockReturnValue({
            status: 'ready',
            snapshot: projectSessionBoard({
                layout: undefined,
                items: boardItems,
                capabilities: { readTranscript: true, editSessionRecords: true },
                freshness: 'fresh',
                reachability: 'reachable',
                loading: 'idle',
                incomplete: false,
            }),
            refresh: () => {},
        });
        const renderer = await renderScreen(inCockpitHeader(
            <SessionCompanionScreen
                {...shellProps}
                onRequestClose={() => {}}
            />,
        ));
        // The phone's + in the navigation bar opens the one Add popover.
        await renderer.pressByTestIdAsync('session-companion-screen-add');
        const [popover] = renderer.findAll((node) => Array.isArray(node.props?.sections)
            && typeof node.props?.searchPlaceholder === 'string');
        const sections = popover?.props.sections as ReadonlyArray<{
            id: string;
            entries: ReadonlyArray<{ id: string; onPick: () => void }>;
        }>;
        const onBoard = sections.find((section) => section.id === 'board')?.entries ?? [];
        expect(onBoard.map((entry) => entry.id)).toEqual(['board-widget-1']);
        await act(async () => { onBoard[0]?.onPick(); });

        expect(readPresentationNotice()).toMatchObject({
            message: 'sessionBoard.companion.notices.added',
            severity: 'info',
            undo: { label: 'sessionBoard.companion.actions.undo' },
        });
    });

    it('never mounts a persistent rail on a phone: the wide host resolves to a mobile control', async () => {
        const renderer = await renderScreen(inCockpitHeader(
            <SessionCompanionScreen
                {...shellProps}
            />,
        ));

        expect(renderer.findByTestId('session-companion-reserved-rail')).toBeNull();
        expect(renderer.findByTestId('session-companion-collapsed-control')).toBeNull();
    });

    it('reads its preference through the realm-qualified slot and writes nothing on mount', async () => {
        await renderScreen(
            <SessionCompanionScreen
                {...shellProps}
            />,
        );

        expect(mutate).not.toHaveBeenCalled();
    });

    it('shows a truthful loading state while the exact Session is not readable yet', async () => {
        const renderer = await renderScreen(inCockpitHeader(
            <SessionCompanionScreen
                {...shellProps}
            />,
        ));

        // An unavailable Board never becomes a deleted-item tombstone here.
        expect(renderer.findByTestId('session-companion-content')).not.toBeNull();
    });
});
