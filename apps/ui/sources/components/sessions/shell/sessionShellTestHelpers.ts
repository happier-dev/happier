import type {
    SessionListAttentionState,
    SessionListSecondaryLineMode,
} from '@/sync/domains/session/listing/deriveSessionListActivity';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';
import { vi } from 'vitest';
import {
    resolveSessionRowAttentionState,
    resolveSessionRowPresentation,
} from './row/resolveSessionRowPresentation';
import type { SessionListRowModel } from './row/sessionListRowModelTypes';

type SessionItemTestSession = (Session | SessionListRenderableSession) & Readonly<{
    archivedAt?: number | null;
    pendingCount?: number | null;
}>;

export type SessionItemTestRowModelInput = Readonly<{
    session: Session | SessionListRenderableSession;
    rowModel?: SessionListRowModel;
    serverId?: string | null;
    serverName?: string;
    currentUserId?: string | null;
    showServerBadge?: boolean;
    pinned?: boolean;
    attentionStanding?: boolean;
    attentionStandingEnabled?: boolean;
    selected?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
    variant?: 'default' | 'no-path';
    secondaryLineMode?: SessionListSecondaryLineMode;
    subtitleOverride?: string | null;
    subtitleEllipsizeMode?: 'head' | 'tail';
    compact?: boolean;
    compactMinimal?: boolean;
    folderDepth?: number;
    tags?: readonly string[];
    allKnownTags?: readonly string[];
    tagsEnabled?: boolean;
    hideInactiveSessions?: boolean;
    activityTimeMode?: 'meaningful' | 'updatedAt';
}>;

export type SessionItemTestRowModelOverrides = Partial<SessionListRowModel> & Readonly<{
    status?: SessionStatus;
    listAttentionState?: SessionListAttentionState;
}>;

const defaultSessionItemTestStatus: SessionStatus = {
    state: 'waiting',
    isConnected: true,
    statusText: '',
    shouldShowStatus: false,
    statusColor: 'status-color',
    statusDotColor: 'status-dot-color',
    isPulsing: false,
};

function resolveSessionItemTestListAttentionState(status: SessionStatus): SessionListAttentionState {
    switch (status.state) {
        case 'thinking':
        case 'waiting':
        case 'background_active':
        case 'permission_required':
        case 'action_required':
            return status.state === 'waiting' || status.state === 'background_active'
                ? 'quiet'
                : status.state;
        case 'disconnected':
        case 'recoverable_unservable':
        case 'resuming':
            return 'quiet';
    }
}

export function createSessionItemTestRowModel(
    input: SessionItemTestRowModelInput,
    overrides: SessionItemTestRowModelOverrides = {},
): SessionListRowModel {
    if (input.rowModel) return input.rowModel;

    const session = input.session as SessionItemTestSession;
    const sessionId = String(session.id);
    const serverId = input.serverId ?? null;
    const status = overrides.status ?? defaultSessionItemTestStatus;
    const listState = overrides.listAttentionState ?? resolveSessionItemTestListAttentionState(status);
    const rowState = overrides.attention?.rowState ?? resolveSessionRowAttentionState(listState);
    const isMinimal = input.compact === true && input.compactMinimal === true;
    const density = isMinimal ? 'minimal' : input.compact === true ? 'compact' : 'default';
    const secondaryLineMode = input.secondaryLineMode ?? (input.variant === 'no-path' ? 'status' : 'path');
    const subtitle = input.subtitleOverride ?? '';

    const model: SessionListRowModel = {
        rowKey: `${serverId ?? 'local'}:${sessionId}`,
        sessionId,
        serverId,
        serverName: input.serverName,
        treeRowId: `session:${serverId ?? 'local'}:${sessionId}`,
        testID: `session-list-item-${sessionId}`,
        dataIndex: 0,
        session,
        status,
        statusSignature: `${status.state}|${status.isConnected ? 1 : 0}|${status.statusText}`,
        nextRuntimeFreshnessAtMs: null,
        secondaryLineMode,
        attention: {
            listState,
            rowState,
        },
        presentation: resolveSessionRowPresentation({
            attentionState: rowState,
            density,
            requestedSecondaryLineMode: secondaryLineMode,
            hasPathSubtitle: Boolean(subtitle),
        }),
        activity: {
            mode: input.activityTimeMode === 'updatedAt' ? 'updatedAt' : 'meaningful',
            timestamp: typeof session.updatedAt === 'number' ? session.updatedAt : null,
            label: '',
            bucket: '',
        },
        isIdentityLoading: session.metadata == null && !('metadataUnavailable' in session),
        title: session.metadata == null ? 'status.unknown' : 'Session',
        subtitle,
        subtitleEllipsizeMode: input.subtitleEllipsizeMode ?? 'head',
        groupKey: 'group-a',
        groupKind: null,
        section: 'active',
        variant: input.variant ?? 'default',
        folder: {
            id: null,
            depth: input.folderDepth ?? 0,
        },
        adjacency: {
            isFirst: input.isFirst ?? false,
            isLast: input.isLast ?? false,
            isSingle: input.isSingle ?? false,
        },
        isSelected: input.selected ?? false,
        isPinned: input.pinned ?? false,
        isAttentionStanding: input.attentionStanding ?? false,
        attentionStandingEnabled: input.attentionStandingEnabled ?? false,
        isArchived: session.archivedAt != null,
        isActive: session.active === true,
        hasUnreadMessages: false,
        pendingCount: session.pendingCount ?? 0,
        draft: null,
        agentActivityLabel: null,
        pendingBlockedCount: session.pendingBlockedCount ?? 0,
        tags: [...(input.tags ?? [])],
        allKnownTags: [...(input.allKnownTags ?? [])],
        tagsEnabled: input.tagsEnabled ?? false,
        currentUserId: input.currentUserId ?? 'u1',
        showServerBadge: input.showServerBadge ?? false,
        compact: input.compact ?? false,
        compactMinimal: input.compactMinimal ?? false,
        identityDisplay: 'avatar',
        activeColorMode: 'activityAndAttention',
        workingIndicatorMode: 'spinner',
        workingIndicatorPaused: false,
        hideInactiveSessions: input.hideInactiveSessions ?? false,
    };

    return {
        ...model,
        ...overrides,
    };
}

type SessionShellModuleFactory = () => unknown | Promise<unknown>;
type SessionShellImportOriginal = <T = unknown>() => Promise<T>;
type SessionShellStorageModuleFactory = (importOriginal: SessionShellImportOriginal) => unknown | Promise<unknown>;

type InstallSessionShellCommonModuleMocksOptions = Readonly<{
    reactNative?: SessionShellModuleFactory;
    unistyles?: SessionShellModuleFactory;
    text?: SessionShellModuleFactory;
    modal?: SessionShellModuleFactory;
    router?: SessionShellModuleFactory;
    storage?: SessionShellStorageModuleFactory;
}>;

const sessionShellModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as SessionShellModuleFactory | undefined,
        unistyles: undefined as SessionShellModuleFactory | undefined,
        text: undefined as SessionShellModuleFactory | undefined,
        modal: undefined as SessionShellModuleFactory | undefined,
        router: undefined as SessionShellModuleFactory | undefined,
        storage: undefined as SessionShellStorageModuleFactory | undefined,
    },
}));

export function installSessionShellCommonModuleMocks(
    options: InstallSessionShellCommonModuleMocksOptions = {},
) {
    sessionShellModuleState.options = {
        reactNative: options.reactNative,
        unistyles: options.unistyles,
        text: options.text,
        modal: options.modal,
        router: options.router,
        storage: options.storage,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
