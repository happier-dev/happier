import React from 'react';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

import type { SessionItemProps } from './SessionItem';
import type { SessionListRowViewModel } from './sessionListRowViewModels';

const DEFAULT_SESSION_ITEM_ROW_PRESENTATION: Omit<SessionStatus, 'awareness'> = {
    state: 'waiting',
    bucket: 'idle',
    tone: 'neutral',
    isConnected: true,
    statusText: '',
    shouldShowStatus: false,
    statusColor: 'status-color',
    statusDotColor: 'dot-color',
    isPulsing: false,
};

/**
 * `SessionStatus.awareness` is the canonical projection every row derives its state from, so the
 * fixture asks the real owner for it instead of hand-writing a projection that could describe a
 * different Session than the one under test.
 */
function createDefaultSessionItemRowStatus(session: SessionListRenderableSession): SessionStatus {
    return {
        ...DEFAULT_SESSION_ITEM_ROW_PRESENTATION,
        awareness: projectUiSessionAwareness(session, Date.now()),
    };
}

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
    const sessionKey = sessionAddressKey({ serverId, sessionId: input.session.id });
    // Test fixtures use full Session objects with the row-renderable fields SessionItem consumes.
    const session = input.session as SessionListRenderableSession;

    return {
        groupKey: 'group:test',
        sessionKey,
        session,
        sessionStatus: createDefaultSessionItemRowStatus(session),
        externalSessionRuntime: null,
        externalSessionIdentity: null,
        isIdentityLoading: false,
        nextRuntimeFreshnessAtMs: null,
        hasUnreadMessages: false,
        activityTimeLabel: '',
        identityDisplay: 'avatar',
        activeColorMode: 'activityAndAttention',
        hideInactiveSessions: false,
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
        reminder: null,
        attentionStandingEnabled: false,
        draft: null,
        guardState: null,
        rowContext: null,
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
        const defaultOverrides = options.resolveRowViewModelOverrides?.(props)
            ?? options.defaultRowViewModelOverrides
            ?? {};

        return React.createElement(SessionItem, {
            ...itemProps,
            rowViewModel: rowViewModel ?? createSessionItemRowViewModel({
                session: itemProps.session,
                serverId: itemProps.serverId,
                overrides: {
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
