import React from 'react';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';

import type { SessionItemProps } from './SessionItem';
import type { SessionListRowViewModel } from './sessionListRowViewModels';

const DEFAULT_SESSION_ITEM_ROW_STATUS: SessionStatus = {
    state: 'waiting',
    isConnected: true,
    statusText: '',
    shouldShowStatus: false,
    statusColor: 'status-color',
    statusDotColor: 'dot-color',
    isPulsing: false,
};

type CreateSessionItemRowViewModelInput = Readonly<{
    session: Session | SessionListRenderableSession;
    serverId?: string;
    overrides?: Partial<Omit<SessionListRowViewModel, 'session'>>;
}>;

export type ModelBackedSessionItemTestProps = Omit<SessionItemProps, 'rowViewModel'> & Readonly<{
    rowViewModel?: SessionListRowViewModel;
    rowViewModelOverrides?: Partial<Omit<SessionListRowViewModel, 'session'>>;
}>;

type SessionItemRowViewModelOverrides = Partial<Omit<SessionListRowViewModel, 'session'>>;

type CreateModelBackedSessionItemTestComponentOptions = Readonly<{
    defaultRowViewModelOverrides?: SessionItemRowViewModelOverrides;
    resolveRowViewModelOverrides?: (props: ModelBackedSessionItemTestProps) => SessionItemRowViewModelOverrides;
}>;

export function createSessionItemRowViewModel(
    input: CreateSessionItemRowViewModelInput,
): SessionListRowViewModel {
    const serverId = input.serverId ?? 'server_a';
    const sessionKey = `${serverId}:${input.session.id}`;
    // Test fixtures use full Session objects with the row-renderable fields SessionItem consumes.
    const session = input.session as SessionListRenderableSession;

    return {
        groupKey: 'group:test',
        sessionKey,
        session,
        sessionStatus: DEFAULT_SESSION_ITEM_ROW_STATUS,
        externalSessionRuntime: null,
        externalSessionIdentity: null,
        isIdentityLoading: false,
        nextRuntimeFreshnessAtMs: null,
        hasUnreadMessages: false,
        activityTimeLabel: '',
        workingIndicatorMode: 'spinner',
        identityDisplay: 'avatar',
        activeColorMode: 'activityAndAttention',
        hideInactiveSessions: false,
        isFirst: true,
        isLast: true,
        isSingle: true,
        subtitleOverride: null,
        subtitleEllipsizeMode: 'head',
        pinned: false,
        showServerBadge: false,
        selected: false,
        tags: [],
        secondaryLineMode: 'path',
        workingPlacementRetained: false,
        attentionStanding: false,
        isAttentionStanding: false,
        attentionStandingEnabled: false,
        draft: null,
        ...input.overrides,
    };
}

export function createModelBackedSessionItemTestComponent(
    SessionItem: React.ComponentType<SessionItemProps>,
    options: CreateModelBackedSessionItemTestComponentOptions = {},
): React.ComponentType<ModelBackedSessionItemTestProps> {
    return function ModelBackedSessionItemTest(props) {
        const {
            rowViewModel,
            rowViewModelOverrides,
            ...itemProps
        } = props;
        const isFirst = itemProps.isFirst === true;
        const isLast = itemProps.isLast === true;
        const defaultOverrides = options.resolveRowViewModelOverrides?.(props)
            ?? options.defaultRowViewModelOverrides
            ?? {};

        return React.createElement(SessionItem, {
            ...itemProps,
            rowViewModel: rowViewModel ?? createSessionItemRowViewModel({
                session: itemProps.session,
                serverId: itemProps.serverId,
                overrides: {
                    isFirst,
                    isLast,
                    isSingle: itemProps.isSingle ?? (isFirst && isLast),
                    subtitleOverride: itemProps.subtitleOverride ?? null,
                    subtitleEllipsizeMode: itemProps.subtitleEllipsizeMode ?? 'head',
                    pinned: itemProps.pinned === true,
                    showServerBadge: itemProps.showServerBadge === true,
                    selected: itemProps.selected === true,
                    tags: itemProps.tags ?? [],
                    secondaryLineMode: itemProps.secondaryLineMode ?? 'path',
                    ...defaultOverrides,
                    ...rowViewModelOverrides,
                },
            }),
        });
    };
}
