import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    TREE_DROP_OVERLAY_KIND_NONE,
    type TreeDropOverlaySharedValues,
} from '@/components/ui/treeDragDrop/ui/treeDropOverlayTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import {
    createModelBackedSessionItemTestComponent,
    createSessionItemRowViewModel,
} from './sessionItemRowViewModelTestFixture';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let hasUnreadMessagesValue = false;
let platformOs: 'ios' | 'android' | 'web' = 'web';
let windowDimensions = { width: 1024, height: 768, scale: 1, fontScale: 1 };
let sessionListIdentityDisplay: 'avatar' | 'agentLogo' | 'none' = 'avatar';
let sessionListActiveColorMode: 'activityAndAttention' | 'attentionOnly' | 'allActive' = 'activityAndAttention';

vi.mock('react-native-reanimated', async () => (
    await import('@/dev/testkit/mocks/reanimated')
).createReanimatedModuleMock());

vi.mock('react-native-gesture-handler', () => ({
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
    Swipeable: 'Swipeable',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));


installSessionShellCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                prompt: vi.fn(),
            },
        }).module;
    },
    storage: async (importOriginal) => importOriginal(),
});

vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');

// Install SDK boundaries before loading provider/store consumers. The broad
// testkit barrel can otherwise resolve the shell's default web mock first.
// Configure the shared SDK object itself: imports elsewhere may already hold
// its default web boundary before this suite installs shell options.
const nativeBoundary = await import('react-native');
Object.defineProperty(nativeBoundary.Platform, 'OS', { configurable: true, get: () => platformOs });
vi.spyOn(nativeBoundary, 'useWindowDimensions').mockImplementation(() => windowDimensions);
vi.spyOn(nativeBoundary.Dimensions, 'get').mockImplementation(() => windowDimensions);
const { lightTheme } = await import('@/theme');
const { renderScreen: renderCanonicalScreen } = await import('@/dev/testkit/render/renderScreen');
const storageModule = await import('@/sync/domains/state/storage');
const { Avatar } = await import('@/components/ui/avatar/Avatar');
const { AgentIcon } = await import('@/agents/registry/AgentIcon');
const { SessionAgentCatalogIdentityIcon } = await import('@/components/sessions/presentation/SessionAgentCatalogIdentityIcon');
const { StatusDot } = await import('@/components/ui/status/StatusDot');
const { SessionItem: ArchiveProgressSessionItem } = await import('./SessionItem');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
function renderScreen(...args: Parameters<typeof renderCanonicalScreen>) {
    return renderCanonicalScreen(<InjectedAuthProvider credentials={null}>{args[0]}</InjectedAuthProvider>, args[1]);
}
const useProfileSpy = vi.spyOn(storageModule, 'useProfile');
const useSessionSpy = vi.spyOn(storageModule, 'useSession');
const useSessionListRenderableWithServerScopeSpy = vi.spyOn(storageModule, 'useSessionListRenderableWithServerScope');
let previousStorageState: ReturnType<typeof storageModule.storage.getState>;









type MockSessionStatus = SessionStatus;
let projectStatus: typeof import('@/utils/sessions/sessionUtils').getSessionStatus;

/** Display fields a test chooses; awareness and its work-status bucket/tone come from the real owner. */
type StatusFixtureDisplay = Omit<SessionStatus, 'awareness' | 'bucket' | 'tone'>;

function createStatusFixture(display: StatusFixtureDisplay): SessionStatus {
    const nowMs = Date.now();
    const session = createSessionFixture({
        id: 'status-fixture',
        encryptionMode: 'plain',
        active: display.isConnected,
        activeAt: nowMs,
        presence: display.isConnected ? 'online' : 0,
        thinking: display.state === 'thinking',
        thinkingAt: nowMs,
        agentState: display.state === 'permission_required' ? {
            controlledByUser: null,
            requests: { permission: { tool: 'Bash', kind: 'permission', arguments: {}, createdAt: nowMs } },
        } : null,
    });
    const projected = projectStatus(session, nowMs);
    return { ...display, bucket: projected.bucket, tone: projected.tone, awareness: projected.awareness };
}


const defaultSessionStatus: StatusFixtureDisplay = {
    state: 'thinking',
    isConnected: true,
    statusText: 'Working on it',
    shouldShowStatus: true,
    statusColor: '#07f',
    statusDotColor: '#0f0',
    isPulsing: false,
};

let mockSessionStatus: MockSessionStatus;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    if (!style || typeof style !== 'object') {
        return {};
    }
    return style as Record<string, unknown>;
}

function createSession(
    id: string,
    metadata: ReturnType<typeof createSessionFixture>['metadata'] = { name: 'Session', path: '/workspace/repo', host: 'host' },
) {
    return createSessionFixture({
        id,
        active: true,
        activeAt: Date.now(),
        encryptionMode: 'plain',
        createdAt: 1,
        updatedAt: 1,
        metadata: metadata ? { ...metadata, name: metadata.name ?? 'Session' } : null,
        presence: 'online',
    });
}


function findSessionTitleText(screen: Awaited<ReturnType<typeof renderScreen>>, title: string) {
    return screen.findAllByType('Text').find((node) => node.props.children === title);
}

function createTreeDropOverlaySharedValues(): TreeDropOverlaySharedValues {
    return {
        overlayVisible: { value: 0 },
        overlayKind: { value: TREE_DROP_OVERLAY_KIND_NONE },
        overlayTop: { value: 0 },
        overlayHeight: { value: 0 },
        overlayLeft: { value: 0 },
        overlayRight: { value: 0 },
        overlayDepth: { value: 0 },
    };
}

async function importSessionItem() {
    const { SessionItem } = await import('./SessionItem');
    return createModelBackedSessionItemTestComponent(SessionItem, {
        resolveRowViewModelOverrides: (props) => ({
            sessionStatus: props.session.latestTurnStatus != null || ('hasPendingPermissionRequests' in props.session && props.session.hasPendingPermissionRequests === true)
                ? projectStatus(props.session, Date.now())
                : mockSessionStatus,
            hasUnreadMessages: hasUnreadMessagesValue,
            activityTimeLabel: '1m',
            identityDisplay: sessionListIdentityDisplay,
            activeColorMode: sessionListActiveColorMode,
        }),
    });
}

function findRowGeometryStyle(screen: Awaited<ReturnType<typeof renderScreen>>, sessionId: string) {
    let node = screen.findByTestId(`session-list-item-${sessionId}`)?.parent;
    while (node) {
        const style = flattenStyle(node.props.style);
        if (typeof style.height === 'number') return style;
        node = node.parent;
    }
    throw new Error(`expected row geometry for ${sessionId}`);
}

describe('SessionItem activity time', () => {
    beforeEach(async () => {
        previousStorageState = storageModule.storage.getState();
        projectStatus = (await import('@/utils/sessions/sessionUtils')).getSessionStatus;
        hasUnreadMessagesValue = false;
        sessionListIdentityDisplay = 'avatar';
        sessionListActiveColorMode = 'activityAndAttention';
        platformOs = 'web';
        windowDimensions = { width: 1024, height: 768, scale: 1, fontScale: 1 };
        mockSessionStatus = createStatusFixture({
            ...defaultSessionStatus,
        });
        useProfileSpy.mockClear();
        useSessionSpy.mockClear();
        useSessionListRenderableWithServerScopeSpy.mockClear();
    });

    afterEach(async () => {
        await standardCleanup();
        storageModule.storage.setState(previousStorageState, true);
    });

    it('shows shared archive progress on an already mounted row and clears it when the operation settles', async () => {
        const { act } = await import('react-test-renderer');
        const session = createSession('archiving-row');
        const rowViewModel = createSessionItemRowViewModel({ session, serverId: 'server_a',
            overrides: { sessionStatus: projectStatus(session, Date.now()) } });
        const screen = await renderScreen(<ArchiveProgressSessionItem session={session} rowViewModel={rowViewModel}
            serverId="server_a" pinned={false} selected={false}
            variant="default" compact={false} />);
        const textBefore = screen.getTextContent();
        let operation: ReturnType<typeof storageModule.storage.getState>['sessionArchiveOperations'][string][string] | null = null;
        await act(async () => { operation = storageModule.storage.getState().beginSessionArchive({ sessionId: 'archiving-row', serverId: 'server_a' }); });
        expect(screen.getTextContent()).toContain('status.archiving');
        expect(screen.findByTestId('session-list-item-archiving-row')?.props.accessibilityLabel).toContain('status.archiving');
        await act(async () => { storageModule.storage.getState().finishSessionArchive(operation!); });
        expect(screen.getTextContent()).toBe(textBefore);
    });

    it('renders the meaningful activity timestamp instead of the raw session updatedAt', async () => {
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_1')}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findByTestId('session-list-item-sess_1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('1m');
    });

    it('sets the activity time in the shared right-aligned tabular meta column', async () => {
        const SessionItem = await importSessionItem();
        const { HAPPIER_META_COLUMN_V1 } = await import('@happier-dev/plugin-ui/presentation');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_1')}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        const time = screen.root.findAll((node) => String(node.type) === 'Text' && node.props.children === '1m')[0];
        expect(time).toBeTruthy();
        const style = flattenStyle(time!.props.style);
        expect(style.fontVariant).toEqual(expect.arrayContaining(['tabular-nums']));
        expect(style.textAlign).toBe('right');
        expect(style.minWidth).toBe(HAPPIER_META_COLUMN_V1.minWidthPx);
    });

    it('renders the row view model activity timestamp for date-grouped lists', async () => {
        const updatedAt = 1_700_000_000_000 - 3 * 60 * 60 * 1000;
        const meaningfulActivityAt = 1_700_000_000_000 - 5 * 60 * 60 * 1000;
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={{
                    ...createSession('sess_updated_at'),
                    createdAt: 1_700_000_000_000 - 5 * 60 * 60 * 1000,
                    updatedAt,
                    meaningfulActivityAt,
                } as SessionListRenderableSession}
                rowViewModelOverrides={{
                    activityTimeLabel: '5h',
                }}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        expect(screen.getTextContent()).toContain('5h');
        expect(screen.getTextContent()).not.toContain('1m');
    });

    it('keeps unread state out of the avatar because row attention owns the indicator', async () => {
        hasUnreadMessagesValue = true;

        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_unread')}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findByType(Avatar)?.props).toMatchObject({
            hasUnreadMessages: false,
        });
        expect(screen.findByType(Avatar)?.props.unreadBadgeTestID).toBeUndefined();
    });

    it('renders a stable minimal unread attention indicator instead of an avatar badge', async () => {
        hasUnreadMessagesValue = true;
        mockSessionStatus = createStatusFixture({
            ...defaultSessionStatus,
            state: 'waiting',
            statusText: 'online',
            shouldShowStatus: false,
            isPulsing: false,
        });
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={{ ...createSession('sess_unread_minimal'), seq: 2, viewer: createSessionViewerFixture({
                    readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
                    attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' },
                }) }}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findByTestId('session-list-attention-indicator-sess_unread_minimal-trailing-unread')).toBeTruthy();
        expect(screen.findByType(Avatar)?.props.hasUnreadMessages).toBe(false);
    });

    it('shows ready-for-review status text for non-minimal completed unread turns', async () => {
        hasUnreadMessagesValue = true;
        mockSessionStatus = createStatusFixture({
            ...defaultSessionStatus,
            state: 'waiting',
            statusText: 'online',
            shouldShowStatus: false,
            isPulsing: false,
        });
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={{
                    ...createSession('sess_ready_for_review'),
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_000,
                    meaningfulActivityAt: 1_000,
                    latestReadyEventSeq: 10,
                    lastViewedSessionSeq: 9,
                    seq: 10,
                    viewer: createSessionViewerFixture({
                        readState: { state: 'tracking', lastViewedSessionSeq: 9, unreadSince: null },
                        attention: { needsAttention: true, reasons: ['ready_after_read'], primary: 'ready_after_read', presentation: 'full' },
                    }),
                } as SessionListRenderableSession}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                secondaryLineMode="path"
                compact={false}
            />,
        );

        expect(screen.getTextContent()).toContain('workStatus.buckets.finished');
        expect(screen.findByTestId('session-list-status-subtitle-sess_ready_for_review-finished_unseen')).toBeTruthy();
    });

    it('shows failed status text before stale working text when the primary turn failed', async () => {
        hasUnreadMessagesValue = true;
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={{
                    ...createSession('sess_failed_primary_turn'),
                    thinking: true,
                    thinkingAt: 1_000,
                    latestTurnStatus: 'failed',
                    latestTurnStatusObservedAt: 1_100,
                    seq: 11,
                    viewer: createSessionViewerFixture({
                        latestFailureSeq: 11,
                        readState: { state: 'tracking', lastViewedSessionSeq: 10, unreadSince: null },
                        attention: { needsAttention: true, reasons: ['failed'], primary: 'failed', presentation: 'full' },
                    }),
                } as SessionListRenderableSession}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                secondaryLineMode="status"
                compact={false}
            />,
        );

        expect(screen.getTextContent()).toContain('status.error');
        expect(screen.getTextContent()).not.toContain('Working on it');
        expect(screen.findByTestId('session-list-status-subtitle-sess_failed_primary_turn-failed')).toBeTruthy();
    });

    it.each([
        ['web', 'working', 'status.workingExternally', 'working'],
        ['ios', 'working', 'status.workingExternally', 'working'],
        ['web', 'waiting', 'status.needsInputExternally', 'action_required'],
        ['web', 'idle', 'status.ready', 'ready'],
        ['web', 'unknown', 'status.externalStatusUnknown', 'none'],
    ] as const)('keeps canonical status for external %s %s facts', async (platform, state, labelKey, indicator) => {
        platformOs = platform;
        mockSessionStatus = createStatusFixture({
            ...defaultSessionStatus,
            state: 'disconnected',
            isConnected: false,
            statusText: 'status.offline',
            shouldShowStatus: true,
            isPulsing: false,
        });
        const SessionItem = await importSessionItem();
        const session = createSession('sess_external_status', {
            host: 'MacBook Pro',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-a',
                remoteSessionId: 'native-session-1',
                source: {
                    kind: 'codexHome',
                    home: '/Users/test/.codex',
                },
            },
        } as any);

        const screen = await renderScreen(
            <SessionItem
                session={session}
                rowViewModelOverrides={{
                    externalSessionRuntime: {
                        controlConnectivity: 'offline',
                        detachedActivity: 'unknown',
                        externalAgent: {
                            state,
                            labelKey,
                            tone: state === 'working'
                                ? 'live'
                                : state === 'waiting'
                                    ? 'attention'
                                    : state === 'idle'
                                        ? 'ready'
                                        : 'muted',
                            indicator: indicator === 'action_required' ? 'action' : indicator,
                            nextExpiryAtMs: null,
                        },
                    } as any,
                    externalSessionIdentity: {
                        agentId: 'codex',
                        agentLabel: 'agentInput.agent.codex',
                        machineLabel: 'MacBook Pro',
                        storageLabel: 'sessionsList.storageExternalFilter',
                        identityLabel: 'agentInput.agent.codex · MacBook Pro',
                        rowMetadataLabel: 'sessionsList.storageExternalFilter · agentInput.agent.codex · MacBook Pro',
                    },
                }}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                secondaryLineMode="path"
                compact={false}
            />,
        );

        expect(screen.getTextContent()).toContain('status.offline');
        expect(screen.getTextContent()).toContain(
            'status.offline · sessionsList.storageExternalFilter · agentInput.agent.codex · MacBook Pro',
        );
        expect(screen.getTextContent()).not.toContain(labelKey);
        expect(screen.findByTestId(
            `session-list-attention-indicator-sess_external_status-secondary-${indicator}`,
        )).toBeNull();
        expect(screen.findByType(Avatar)?.props.monochrome).toBe(true);
    });

    it('keeps retained working placement from replacing a quiet canonical status', async () => {
        const session = createSession('sess_retained_quiet');
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(
            <SessionItem
                session={session}
                rowViewModel={createSessionItemRowViewModel({
                    session,
                    overrides: {
                        sessionStatus: projectStatus(session, Date.now()),
                        secondaryLineMode: 'status',
                        workingPlacementRetained: true,
                    },
                })}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                secondaryLineMode="status"
                compact={false}
            />,
        );

        expect(screen.findByTestId(
            'session-list-attention-indicator-sess_retained_quiet-secondary-working',
        )).toBeNull();
        expect(screen.getTextContent()).not.toContain('status.workingRetained');
    });

    it('keeps canonical failed status authoritative over external-session presentation', async () => {
        const now = Date.now();
        const session = {
            ...createSession('sess_external_failed'),
            latestTurnStatus: 'failed' as const,
            latestTurnStatusObservedAt: now,
            viewer: createSessionViewerFixture({
                latestFailureSeq: 1,
                readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: null },
                attention: { needsAttention: true, reasons: ['failed'], primary: 'failed', presentation: 'full' },
            }),
        };
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(
            <SessionItem
                session={session}
                rowViewModelOverrides={{
                    externalSessionRuntime: {
                        controlConnectivity: 'online',
                        detachedActivity: 'active',
                        externalAgent: {
                            state: 'working',
                            labelKey: 'status.workingExternally',
                            tone: 'live',
                            indicator: 'working',
                            nextExpiryAtMs: null,
                        },
                    } as any,
                }}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                secondaryLineMode="status"
                compact={false}
            />,
        );

        expect(screen.findByTestId(
            'session-list-attention-indicator-sess_external_failed-secondary-failed',
        )).toBeTruthy();
        expect(screen.findByTestId(
            'session-list-attention-indicator-sess_external_failed-secondary-working',
        )).toBeNull();
    });

    it('renders inactive sessions with a monochrome avatar even when the daemon still reports connected', async () => {
        mockSessionStatus = createStatusFixture({
            ...defaultSessionStatus,
            isConnected: true,
        });

        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSessionFixture({
                    id: 'sess_inactive_connected',
                    active: false,
                    activeAt: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    metadata: null,
                    presence: 'online',
                })}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findByType(Avatar)?.props.monochrome).toBe(true);
    });

    it('uses a tighter fixed row height and readable title metrics in very compact web rows', async () => {
        platformOs = 'web';
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_title')}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const rowStyle = findRowGeometryStyle(screen, 'sess_compact_title');
        // The shared compact work row (lab `clflat`): 32 tall, its title on the navigation rows' body step.
        expect(rowStyle.height).toBe(32);

        const title = screen.findAllByType('Text').find((node) => node.props.children === 'Session');
        const titleStyle = flattenStyle(title?.props.style);
        expect(titleStyle.fontSize).toBe(13);
        expect(titleStyle.lineHeight).toBe(18);
    });

    it('renders a 16px micro avatar in very compact web rows', async () => {
        platformOs = 'web';
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_avatar_web')}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findByType(Avatar)?.props).toMatchObject({
            id: 'sess_compact_avatar_web',
            size: 16,
        });
    });

    it('preserves session identity and an accessible touch area in compact native phone rows', async () => {
        platformOs = 'ios';
        windowDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_avatar_phone')}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findByType(Avatar)?.props.id).toBe('sess_compact_avatar_phone');
        const rowStyle = findRowGeometryStyle(screen, 'sess_compact_avatar_phone');
        // The full-width row is its own hit area: it keeps the readable phone height (DESIGN.md → touch
        // targets are hit areas, not drawn sizes), never the 44 pt finger target.
        expect(rowStyle.height).toBe(36);
    });

    it('renders the selected agent logo in the same narrow identity slot', async () => {
        sessionListIdentityDisplay = 'agentLogo';
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_narrow', { flavor: 'claude' } as any)}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findAllByType(Avatar)).toHaveLength(0);
        expect(screen.findByType(SessionAgentCatalogIdentityIcon)?.props).toMatchObject({
            agentId: 'claude',
            size: 15,
            serverId: 'server_a',
            testID: 'session-list-agent-logo-sess_agent_logo_narrow',
        });
    });

    it('keeps an external Agent identity and its exact Session scope in agent-logo mode', async () => {
        sessionListIdentityDisplay = 'agentLogo';
        const SessionItem = await importSessionItem();
        const session = {
            ...createSession('sess_external_agent_logo'),
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                agentPresentation: { agentId: 'acme.plugin/ultracode' },
            },
            ownerMetadataView: { machineId: 'machine_external' },
        } as any;

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_external"
                pinned={false}
                selected={false}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findAllByType(AgentIcon)).toHaveLength(0);
        expect(screen.findByType(SessionAgentCatalogIdentityIcon)?.props).toMatchObject({
            agentId: 'acme.plugin/ultracode',
            machineId: 'machine_external',
            serverId: 'server_external',
            size: 15,
            testID: 'session-list-agent-logo-sess_external_agent_logo',
        });
    });

    it('passes the resolved title color to agent logos for active rows without attention', async () => {
        sessionListIdentityDisplay = 'agentLogo';
        mockSessionStatus = createStatusFixture({
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        });
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_idle', { flavor: 'claude' } as any)}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const titleStyle = flattenStyle(findSessionTitleText(screen, 'Session')?.props.style);
        expect(titleStyle.color).toBe(lightTheme.colors.text.secondary);
        expect(screen.findByType(SessionAgentCatalogIdentityIcon)?.props.color).toBe(titleStyle.color);
    });

    it('can use the active title color for all active connected session rows', async () => {
        sessionListIdentityDisplay = 'agentLogo';
        sessionListActiveColorMode = 'allActive';
        mockSessionStatus = createStatusFixture({
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        });
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_all_active', { flavor: 'claude' } as any)}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const titleStyle = flattenStyle(findSessionTitleText(screen, 'Session')?.props.style);
        expect(titleStyle.color).toBe(lightTheme.colors.text.primary);
        expect(screen.findByType(SessionAgentCatalogIdentityIcon)?.props.color).toBe(titleStyle.color);
    });

    it('can keep working rows secondary when only attention rows use active color', async () => {
        sessionListIdentityDisplay = 'agentLogo';
        sessionListActiveColorMode = 'attentionOnly';
        mockSessionStatus = createStatusFixture({
            state: 'thinking',
            isConnected: true,
            statusText: 'Working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        });
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_attention_only', { flavor: 'claude' } as any)}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const titleStyle = flattenStyle(findSessionTitleText(screen, 'Session')?.props.style);
        expect(titleStyle.color).toBe(lightTheme.colors.text.secondary);
        expect(screen.findByType(SessionAgentCatalogIdentityIcon)?.props.color).toBe(titleStyle.color);
    });

    it('hides the session list identity slot across row densities when identity display is none', async () => {
        sessionListIdentityDisplay = 'none';
        const SessionItem = await importSessionItem();

        const detailed = await renderScreen(
            <SessionItem
                session={createSession('sess_identity_none_detailed')}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
            />,
        );
        expect(detailed.findAllByType(Avatar)).toHaveLength(0);
        expect(detailed.findAllByType(AgentIcon)).toHaveLength(0);
        expect(detailed.findAllByType(SessionAgentCatalogIdentityIcon)).toHaveLength(0);

        standardCleanup();

        const narrow = await renderScreen(
            <SessionItem
                session={createSession('sess_identity_none_narrow')}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );
        expect(narrow.findAllByType(Avatar)).toHaveLength(0);
        expect(narrow.findAllByType(AgentIcon)).toHaveLength(0);
        expect(narrow.findAllByType(SessionAgentCatalogIdentityIcon)).toHaveLength(0);
    });

    it('replaces trailing time with a spinner in very compact mode when the session is working', async () => {
        mockSessionStatus = createStatusFixture({
            state: 'thinking',
            isConnected: true,
            statusText: 'Working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        });

        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={{ ...createSession('sess_compact_active'), thinking: true, thinkingAt: Date.now() }}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={true}
                compactMinimal={true}
                rowAttentionAnimationEnabled={false}
            />,
        );

        const spinner = screen.findByTestId('session-row-attention-indicator-spinner-sess_compact_active-trailing');
        expect(spinner).toBeTruthy();
        const spinnerStyle = flattenStyle(spinner?.props.style);
        expect(spinnerStyle.animationName).toBeUndefined();
        expect(screen.findAllByType(StatusDot)).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('Working on it');
        expect(screen.getTextContent()).not.toContain('1m');
    });

    it('renders session status with the configured spinner and text', async () => {
        mockSessionStatus = createStatusFixture({
            state: 'thinking',
            isConnected: true,
            statusText: 'Working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        });

        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={{ ...createSession('sess_status_plain'), thinking: true, thinkingAt: Date.now() }}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
                secondaryLineMode="status"
            />,
        );
        expect(screen.findByTestId('session-list-status-pill-sess_status_plain')).toBeNull();
        const spinner = screen.findByTestId('session-row-attention-indicator-spinner-sess_status_plain-secondary');
        expect(spinner).toBeTruthy();
        expect(screen.findAllByType(StatusDot)).toHaveLength(0);
        const statusText = screen.findAllByType('Text').find((node) => node.props.children === 'Working on it');
        const flat = flattenStyle(statusText?.props.style);
        expect(flat.fontSize).toBe(12);
        expect(flat.lineHeight).toBe(16);
    });

    it('keeps the shared working arc still when row attention animation is disabled', async () => {
        mockSessionStatus = createStatusFixture({
            state: 'thinking',
            isConnected: true,
            statusText: 'Working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        });

        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={{ ...createSession('sess_status_plain_dot'), thinking: true, thinkingAt: Date.now() }}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
                secondaryLineMode="status"
                rowAttentionAnimationEnabled={false}
            />,
        );

        expect(screen.findAllByType(StatusDot)).toHaveLength(0);
        // Imported here, not at the top: an eager import would load the row's platform-dependent
        // modules before each test picks its platform.
        const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
        const spinners = screen.findAllByType(ActivitySpinner);
        expect(spinners).toHaveLength(1);
        expect(spinners[0]?.props).toMatchObject({
            testID: 'session-row-attention-indicator-spinner-sess_status_plain_dot-secondary',
            animationEnabled: false,
        });
    });

    it.each([
        ['thinking', { thinking: true }, true],
        ['permission_required', { pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0 }, false],
        ['action_required', { pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1 }, false],
        ['error', { latestTurnStatus: 'failed' as const, viewer: createSessionViewerFixture({
            latestFailureSeq: 1,
            readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: null },
            attention: { needsAttention: true, reasons: ['failed'], primary: 'failed', presentation: 'full' },
        }) }, false],
    ] as const)('exposes the %s state on the single actionable row in minimal path mode', async (state, sourceFacts, busy) => {
        const now = Date.now();
        const sessionId = `sess_accessible_${state}`;
        const session = createSessionFixture({
            ...createSession(sessionId, {
                name: `Accessible ${state}`,
                path: '/workspace/example',
                host: 'tester.local',
            }),
            ...sourceFacts,
            thinkingAt: state === 'thinking' ? now : 0,
            pendingRequestObservedAt: state === 'permission_required' || state === 'action_required' ? now : null,
            latestTurnStatusObservedAt: state === 'error' ? now : undefined,
        });
        mockSessionStatus = projectStatus(session, now);
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact
                compactMinimal
                secondaryLineMode="path"
                rowAttentionAnimationEnabled={false}
            />,
        );

        const row = screen.findByTestId(`session-list-item-${sessionId}`);
        expect(row?.props.accessibilityRole).toBe('button');
        expect(row?.props.accessibilityLabel).toContain(`Accessible ${state}`);
        const expectedStatusWord = state === 'permission_required' ? 'workStatus.words.permission'
            : state === 'action_required' ? 'workStatus.words.question' : mockSessionStatus.statusText;
        expect(row?.props.accessibilityLabel).toContain(expectedStatusWord);
        expect(row?.props.accessibilityState).toMatchObject({ selected: false, busy });
        expect(screen.tree.root.findAll((node) => (
            // A host element's node type is its tag string; components never stringify to it.
            String(node.type) === 'Pressable'
            && node.props?.testID === `session-list-item-${sessionId}`
        ))).toHaveLength(1);
        const indicator = screen.findByTestId(`session-row-attention-indicator-${sessionId}-trailing`)
            ?? screen.findByTestId(`session-row-attention-indicator-${sessionId}-secondary`);
        expect(indicator?.props).toMatchObject({
            accessible: false,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
        });
        await screen.unmount();
    });

    it('does not render a subtitle in very compact mode for quiet online sessions', async () => {
        mockSessionStatus = createStatusFixture({
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        });

        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_quiet')}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.getTextContent()).not.toContain('online');
        expect(screen.findAllByType(StatusDot)).toHaveLength(0);
        expect(screen.getTextContent()).toContain('1m');
    });

    it('keeps the selected row background when a session is selected', async () => {
        mockSessionStatus = createStatusFixture({
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        });

        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_selected')}
                serverId="server_a"
                pinned={false}
                selected={true}
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findByTestId('session-list-item-sess_selected')?.props.accessibilityState).toMatchObject({
            selected: true,
        });
    });

    it('uses the row view model and currentUserId prop without subscribing to profile or full session state', async () => {
        const SessionItem = await importSessionItem();

        await renderScreen(
            <SessionItem
                session={createSession('sess_row_state')}
                currentUserId="u1"
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        expect(useSessionListRenderableWithServerScopeSpy).not.toHaveBeenCalled();
        expect(useSessionSpy).not.toHaveBeenCalled();
        expect(useProfileSpy).not.toHaveBeenCalled();
    });

    it('renders from a row view model without subscribing to row renderables', async () => {
        const SessionItem = await importSessionItem();
        const rowSession = createSession('sess_model_backed');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('stale_prop_session')}
                rowViewModel={{
                    groupKey: 'group:model',
                    rowContext: null,
                    guardState: null,
                    sessionKey: 'server_a:sess_model_backed',
                    session: rowSession,
                    sessionStatus: {
                        awareness: projectStatus(rowSession, Date.now()).awareness,
                        state: 'waiting',
                        bucket: 'idle',
                        tone: 'neutral',
                        isConnected: true,
                        statusText: 'online',
                        shouldShowStatus: false,
                        statusColor: '#34C759',
                        statusDotColor: '#34C759',
                        isPulsing: false,
                    },
                    externalSessionRuntime: null,
                    externalSessionIdentity: null,
                    reminder: null,
                    isIdentityLoading: false,
                    nextRuntimeFreshnessAtMs: null,
                    hasUnreadMessages: true,
                    activityTimeLabel: '7m',
                    identityDisplay: 'avatar',
                    activeColorMode: 'attentionOnly',
                    hideInactiveSessions: true,
                    subtitleOverride: 'Model subtitle',
                    subtitleEllipsizeMode: 'head',
                    pinned: false,
                    showServerBadge: true,
                    selected: true,
                    tags: [],
                    secondaryLineMode: 'path',
                    workingPlacementRetained: false,
                    attentionStanding: false,
                    isAttentionStanding: false,
                    attentionStandingEnabled: false,
                    draft: null,
                }}
                serverId="server_a"
                serverName="Server A"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        expect(useSessionListRenderableWithServerScopeSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-list-item-sess_model_backed')?.props.accessibilityState).toMatchObject({
            selected: true,
        });
        expect(screen.findByType(Avatar)?.props.hasUnreadMessages).toBe(false);
        expect(screen.findByType(Avatar)?.props.unreadBadgeTestID).toBeUndefined();
        expect(screen.getTextContent()).toContain('7m');
    });

    it('uses list-row pending approval flags when the scoped store renderable is stale', async () => {
        storageModule.storage.getState().applyServerScopedSessionListRows('server_a', [{
            ...createSession('sess_overlay_permission'),
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        }], { source: 'rowOnly', mode: 'append' });
        mockSessionStatus = createStatusFixture({
            state: 'permission_required',
            isConnected: true,
            statusText: 'status.permissionRequired',
            shouldShowStatus: true,
            statusColor: '#f90',
            statusDotColor: '#f90',
            isPulsing: true,
        });
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={{
                    ...createSession('sess_overlay_permission'),
                    hasPendingPermissionRequests: true,
                    hasPendingUserActionRequests: false,
                    pendingRequestObservedAt: Date.now(),
                }}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                secondaryLineMode="status"
                compact={false}
            />,
        );

        expect(screen.getTextContent()).toContain('workStatus.words.permission');
    });

    it('uses overlaid permission state when the row view model session is stale', async () => {
        const staleSession = {
            ...createSession('sess_row_model_overlay_permission'),
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        };
        const overlaidSession = {
            ...staleSession,
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: Date.now(),
        };
        mockSessionStatus = createStatusFixture({
            state: 'waiting',
            isConnected: true,
            statusText: 'Online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        });
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={overlaidSession}
                rowViewModel={createSessionItemRowViewModel({
                    session: staleSession,
                    overrides: {
                        sessionStatus: mockSessionStatus,
                        secondaryLineMode: 'status',
                        workingPlacementRetained: false,
                        attentionStanding: false,
                    },
                })}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                secondaryLineMode="status"
                compact={false}
            />,
        );

        expect(screen.getTextContent()).toContain('workStatus.words.permission');
        // The overlaid state names the status line; a request nobody routed to this viewer stays calm (no mark).
        expect(screen.findByTestId(
            'session-list-status-subtitle-sess_row_model_overlay_permission-permission_required',
        )).toBeTruthy();
    });

    it.each(['failed', 'stale', 'offline', 'locked'] as const)('projects richer %s facts before rendering attention and motion', async (scenario) => {
        const now = Date.now();
        const rowSession = {
            ...createSession('sess_projection'),
            encryptionMode: 'plain' as const,
            activeAt: now,
            thinking: true,
            thinkingAt: now,
            latestTurnStatus: 'in_progress' as const,
            latestTurnStatusObservedAt: now - 1,
        };
        const providedSession = {
            ...rowSession,
            updatedAt: now,
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: now,
            ...(scenario === 'failed' ? {
                latestTurnStatus: 'failed' as const,
                latestTurnStatusObservedAt: now,
                viewer: createSessionViewerFixture({
                    latestFailureSeq: 1,
                    readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: null },
                    attention: { needsAttention: true, reasons: ['failed'], primary: 'failed', presentation: 'full' },
                }),
            } : scenario === 'stale' ? { activeAt: 1 }
                : scenario === 'locked' ? {
                    encryptionMode: 'e2ee' as const,
                    encryptedContentAvailability: 'encrypted_access_pending' as const,
                    metadata: null,
                }
                    : { presence: now - 200_000 }),
        };
        const { getSessionStatus } = await import('@/utils/sessions/sessionUtils');
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(<SessionItem
            session={providedSession}
            rowViewModel={createSessionItemRowViewModel({
                session: rowSession,
                overrides: { sessionStatus: getSessionStatus(rowSession, now), secondaryLineMode: 'status' },
            })}
            serverId="server_a" pinned={false} selected={false}
            variant="default" secondaryLineMode="path" subtitleOverride="~/private-path" compact={false}
        />);
        if (scenario !== 'failed') {
            const expectedStatusWord = scenario === 'stale' ? 'workStatus.words.permission'
                : getSessionStatus(providedSession, now).statusText;
            expect(screen.getTextContent()).toContain(expectedStatusWord);
        }
        if (scenario === 'failed') {
            expect(screen.findByTestId('session-list-attention-indicator-sess_projection-secondary-failed')).toBeTruthy();
            expect(screen.findByTestId('session-list-attention-indicator-sess_projection-secondary-permission_required')).toBeNull();
        }
        expect(screen.findAllByType(StatusDot).every((dot) => dot.props.animationEnabled === false)).toBe(true);
        const spinner = screen.findByTestId('session-row-attention-indicator-spinner-sess_projection-secondary');
        if (spinner) expect(flattenStyle(spinner.props.style).animationName).toBeUndefined();
    });

    it.each([undefined, 'encrypted_access_pending'] as const)('keeps the safe cached title but hides the private path with content availability %s', async (encryptedContentAvailability) => {
        const session = { ...createSession('sess_private'), encryptionMode: 'e2ee' as const,
            encryptedContentAvailability,
            metadata: { name: 'Private retained title', path: '/private/retained/path' } };
        const { getSessionStatus } = await import('@/utils/sessions/sessionUtils');
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(<SessionItem session={session}
            rowViewModel={createSessionItemRowViewModel({ session, overrides: {
                sessionStatus: getSessionStatus(session, Date.now()), subtitleOverride: '/private/retained/path', secondaryLineMode: 'path',
            } })}
            serverId="server_a" pinned={false} selected={false} variant="default" compact={false}
        />);
        // A legitimately retained title names the same Session as its detail header;
        // unreadable content still cannot disclose the private path.
        expect(screen.getTextContent()).toContain('Private retained title');
        expect(screen.getTextContent()).not.toContain('/private/retained/path');
    });

    it.each([
        ['encrypted_access_pending', 'session.access.pending'],
        ['recipient_encryption_setup_required', 'session.access.setup'],
        ['encrypted_content_unavailable', 'session.access.unavailable'],
    ] as const)('explains %s instead of reporting an outcome the viewer cannot read', async (
        encryptedContentAvailability,
        expectedStatusKey,
    ) => {
        const now = Date.now();
        const session = {
            ...createSession('sess_access_state'),
            encryptionMode: 'e2ee' as const,
            encryptedContentAvailability,
            metadata: null,
            latestTurnStatus: 'completed' as const,
            latestTurnStatusObservedAt: now,
            latestReadyEventSeq: 4,
            activeAt: now,
        };
        const { getSessionStatus } = await import('@/utils/sessions/sessionUtils');
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(<SessionItem session={session}
            rowViewModel={createSessionItemRowViewModel({ session, overrides: {
                sessionStatus: getSessionStatus(session, now), secondaryLineMode: 'path',
            } })}
            serverId="server_a" pinned={false} selected={false}
            variant="default" secondaryLineMode="path" compact={false}
        />);
        expect(screen.getTextContent()).toContain(expectedStatusKey);
        expect(screen.getTextContent()).not.toContain('status.readyForReview');
    });

    it('composes the canonical paused work headline into the status line', async () => {
        const now = Date.now();
        const session: Session = {
            ...createSession('sess_paused_headline'),
            encryptionMode: 'plain' as const,
            activeAt: now,
            metadata: { path: "/project", host: "test-host", sessionWorkStateV1: {
                v: 1, backendId: 'codex', updatedAt: now,
                items: [{ id: 'paused', kind: 'task', origin: 'vendor', status: 'paused', title: 'Review migration', updatedAt: now }],
            } },
        };
        const { getSessionStatus } = await import('@/utils/sessions/sessionUtils');
        expect(getSessionStatus(session, now).awareness.currentWork?.title).toBe('Review migration');
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(<SessionItem
            session={session}
            rowViewModel={createSessionItemRowViewModel({
                session,
                overrides: { sessionStatus: getSessionStatus(session, now), secondaryLineMode: 'status' },
            })}
            serverId="server_a" pinned={false} selected={false}
            variant="default" secondaryLineMode="status" compact={false}
        />);
        expect(screen.getTextContent()).toContain('Review migration');
    });

    it('uses row-model blocked pending count when the provided session omits it', async () => {
        const rowSession = {
            ...createSession('sess_row_model_overlay_blocked_pending'),
            pendingCount: 1,
            pendingBlockedCount: 1,
        };
        const providedSession = {
            ...createSession('sess_row_model_overlay_blocked_pending'),
            pendingCount: 1,
        };
        mockSessionStatus = createStatusFixture({
            state: 'waiting',
            isConnected: true,
            statusText: 'Online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        });
        const { getSessionStatus } = await import('@/utils/sessions/sessionUtils');
        mockSessionStatus = getSessionStatus(rowSession, Date.now());
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={providedSession}
                rowViewModel={createSessionItemRowViewModel({
                    session: rowSession,
                    overrides: {
                        sessionStatus: mockSessionStatus,
                        secondaryLineMode: 'status',
                        workingPlacementRetained: false,
                        attentionStanding: false,
                    },
                })}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                secondaryLineMode="status"
                compact={false}
            />,
        );

        expect(screen.getTextContent()).toContain('status.actionRequired');
        expect(screen.findByTestId(
            'session-list-attention-indicator-sess_row_model_overlay_blocked_pending-secondary-action_required',
        )).toBeTruthy();
    });

    it('uses explicit provided-session zero blocked pending count over stale row-model state', async () => {
        const rowSession = {
            ...createSession('sess_row_model_overlay_blocked_pending_zero'),
            pendingCount: 1,
            pendingBlockedCount: 1,
        };
        const providedSession = {
            ...createSession('sess_row_model_overlay_blocked_pending_zero'),
            pendingCount: 0,
            pendingBlockedCount: 0,
        };
        mockSessionStatus = createStatusFixture({
            state: 'waiting',
            isConnected: true,
            statusText: 'Online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        });
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={providedSession}
                rowViewModel={createSessionItemRowViewModel({
                    session: rowSession,
                    overrides: {
                        sessionStatus: mockSessionStatus,
                        secondaryLineMode: 'status',
                        workingPlacementRetained: false,
                        attentionStanding: false,
                    },
                })}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                secondaryLineMode="status"
                compact={false}
            />,
        );

        expect(screen.findAllByTestId(
            'session-list-attention-indicator-sess_row_model_overlay_blocked_pending_zero-secondary-action_required',
        )).toHaveLength(0);
    });

    it('does not reconstruct pending requests from a stale list placement reason', async () => {
        const { SessionListSessionItem } = await import('./sessionListSessionItem');
        const { agentState: _agentState, ...listSession } = createSession('sess_action_overlay');
        const staleSession = {
            ...listSession,
            pendingRequestObservedAt: Date.now(),
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        };
        mockSessionStatus = createStatusFixture({
            state: 'waiting',
            isConnected: true,
            statusText: 'Online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        });

        const screen = await renderScreen(
            <SessionListSessionItem
                item={{
                    type: 'session',
                    sessionId: 'sess_action_overlay',
                    serverId: 'server_a',
                    groupKey: 'attention-promotion-v1',
                    groupKind: 'attention',
                    attentionPlacementReason: 'action_required',
                    variant: 'default',
                }}
                rowViewModel={createSessionItemRowViewModel({
                    session: staleSession,
                    overrides: {
                        sessionStatus: mockSessionStatus,
                        secondaryLineMode: 'status',
                        workingPlacementRetained: false,
                        attentionStanding: false,
                    },
                })}
                rowHeight={42}
                dragEnabled={false}
                treeRowId="session:sess_action_overlay"
                onDragStart={vi.fn()}
                resolveDropResult={() => ({
                    result: { instruction: { kind: 'idle' }, visual: { kind: 'none' } },
                    geometry: { kind: 'none' },
                })}
                onDropResult={vi.fn()}
                onTogglePinnedSessionKey={null}
                onSetTagsSessionKey={null}
                onNativeContextMenuOpenChangeSessionKey={null}
                draggingSessionKey={null}
                nativeContextMenuSessionKey={null}
                overlayShared={createTreeDropOverlaySharedValues()}
                onRegisterTreeRowBounds={vi.fn()}
                onUnregisterTreeRowBounds={vi.fn()}
                currentUserId="u1"
                allKnownTags={[]}
                tagsEnabled={false}
                compact={false}
                compactMinimal={false}
                rowAttentionAnimationEnabled={true}
            />,
        );

        expect(screen.getTextContent()).not.toContain('status.actionRequired');
        expect(screen.findByTestId(
            'session-list-attention-indicator-sess_action_overlay-secondary-action_required',
        )).toBeNull();
    });

    it('uses start-side overflow ellipsis for path subtitles on web without reordering the path', async () => {
        mockSessionStatus = createStatusFixture({
            ...defaultSessionStatus,
            state: 'waiting',
            statusText: 'Online',
            shouldShowStatus: false,
            isPulsing: false,
        });
        platformOs = 'web';
        const SessionItem = await importSessionItem();
        const sessionPath = '~/Documents/Development/happier/dev';

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_path_web')}
                subtitleOverride={sessionPath}
                secondaryLineMode="path"
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        const outerSubtitle = screen.root.findAll((node) => {
            const style = flattenStyle(node.props?.style);
            return String(node.type) === 'Text'
                && node.props.numberOfLines === 1
                && style.writingDirection === 'rtl';
        })[0];
        const innerSubtitle = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.children === sessionPath,
        )[0];

        expect(screen.getTextContent()).toContain(sessionPath);
        expect(outerSubtitle).toBeTruthy();
        expect(innerSubtitle).toBeTruthy();
        expect(flattenStyle(outerSubtitle?.props.style)).toMatchObject({
            writingDirection: 'rtl',
            textAlign: 'left',
        });
        expect(flattenStyle(innerSubtitle?.props.style)).toMatchObject({
            writingDirection: 'ltr',
            unicodeBidi: 'isolate',
        });
    });

    it('uses native head ellipsis for path subtitles outside web', async () => {
        mockSessionStatus = createStatusFixture({
            ...defaultSessionStatus,
            state: 'waiting',
            statusText: 'Online',
            shouldShowStatus: false,
            isPulsing: false,
        });
        platformOs = 'ios';
        const SessionItem = await importSessionItem();
        const sessionPath = '~/Documents/Development/happier/dev';

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_path_native')}
                subtitleOverride={sessionPath}
                secondaryLineMode="path"
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        const subtitle = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.children === sessionPath
            && node.props.numberOfLines === 1,
        )[0];

        expect(subtitle?.props.ellipsizeMode).toBe('head');
    });

    it('shows the working indicator instead of only path and time in date-grouped rows', async () => {
        mockSessionStatus = createStatusFixture({
            ...defaultSessionStatus,
        });
        const SessionItem = await importSessionItem();
        const sessionPath = '~/Documents/Development/happier/dev';

        const screen = await renderScreen(
            <SessionItem
                session={{
                    ...createSession('sess_date_working'),
                    thinking: true,
                    thinkingAt: Date.now(),
                }}
                subtitleOverride={sessionPath}
                secondaryLineMode="path"
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findByTestId('session-row-attention-indicator-spinner-sess_date_working-secondary')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Working on it');
        expect(screen.getTextContent()).not.toContain(sessionPath);
    });
});
