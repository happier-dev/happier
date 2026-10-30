import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SessionListIdentity } from '@/components/sessions/shell/SessionListIdentity';
import { SelectionList, type SelectionListOption, type SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { useSessionListViewDataByServerId, useSessions } from '@/sync/domains/state/storage';
import { readSessionListMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListOrderingRules';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { Session } from '@/sync/domains/state/storageTypes';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { getSessionName, getSessionStatus, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';

import {
    resolveSessionSelectionModalLayout,
    SESSION_SELECTION_MODAL_SIZE,
    SESSION_SELECTION_MODAL_WIDTH,
} from './resolveSessionSelectionModalLayout';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { sortSessionSelectionCandidates } from './sortSessionSelectionCandidates';

export type SessionSelectionIdentity = Readonly<{ sessionId: string; serverId: string }>;
export type SessionSelectionCandidate = (Session | SessionListRenderableSession) & Readonly<{ serverId: string }>;

export type SessionSelectionModalProps = CustomModalInjectedProps & Readonly<{
    serverIds?: ReadonlyArray<string>;
    selectSessions?: (sessions: ReadonlyArray<SessionSelectionCandidate>) => ReadonlyArray<SessionSelectionCandidate>;
    title: string;
    subtitle?: string;
    searchPlaceholder: string;
    emptyStateLabel: string;
    testID: string;
    leadingOptions?: ReadonlyArray<SelectionListOption>;
    onSelectSession: (selection: SessionSelectionIdentity) => void | Promise<void>;
    onSelectOption?: (optionId: string) => void;
    onDismiss: () => void;
}>;

const styles = StyleSheet.create((theme) => ({
    body: {
        flex: 1,
        minHeight: 0,
    },
    subtitle: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 8,
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
    empty: {
        padding: 16,
        color: theme.colors.text.secondary,
    },
    sessionMeta: {
        alignItems: 'flex-end',
        gap: 2,
        marginLeft: 12,
        minWidth: 48,
        maxWidth: 128,
    },
    sessionStatus: {
        fontSize: 12,
        fontWeight: '600',
    },
    sessionActivity: {
        color: theme.colors.text.secondary,
        fontSize: 11,
    },
}));

type SessionSelectionTargetSource = Session | SessionListRenderableSession;
type SessionSelectionTarget = SessionSelectionCandidate;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function sessionOptionId(session: SessionSelectionIdentity): string {
    return `session:${encodeURIComponent(session.serverId)}:${encodeURIComponent(session.sessionId)}`;
}

function appendSessionSelectionTarget(
    targets: SessionSelectionTarget[],
    seenTargetKeys: Set<string>,
    session: SessionSelectionTargetSource,
    rawServerId: unknown,
): void {
    const sessionId = normalizeNonEmptyString(session.id);
    const serverId = normalizeNonEmptyString(rawServerId);
    if (!sessionId || !serverId) return;

    const targetKey = `${serverId}\u0000${sessionId}`;
    if (seenTargetKeys.has(targetKey)) return;
    seenTargetKeys.add(targetKey);
    targets.push({ ...session, id: sessionId, serverId });
}

function appendSessionListTargets(
    targets: SessionSelectionTarget[],
    seenTargetKeys: Set<string>,
    sessionListViewDataByServerId: Readonly<Record<string, ReadonlyArray<SessionListViewItem> | null>>,
): void {
    for (const [recordServerId, items] of Object.entries(sessionListViewDataByServerId)) {
        const serverId = normalizeNonEmptyString(recordServerId);
        if (!serverId || !Array.isArray(items)) continue;

        for (const item of items) {
            if (item.type !== 'session') continue;
            appendSessionSelectionTarget(targets, seenTargetKeys, item.session, item.serverId ?? serverId);
        }
    }
}

const SessionSelectionRowMeta = React.memo(function SessionSelectionRowMeta(
    props: Readonly<{ session: SessionSelectionTarget; testID: string }>,
) {
    const { theme } = useUnistyles();
    const nowMs = Date.now();
    const status = getSessionStatus(props.session, nowMs, {
        workingTextMode: 'static',
        statusColors: theme.colors.status,
    });
    const activityAt = readSessionListMeaningfulActivityAt(props.session);
    const activityLabel = activityAt > 0 ? formatShortRelativeTimeAt(activityAt, nowMs) : '';

    return (
        <View testID={`${props.testID}-meta-${props.session.id}`} style={styles.sessionMeta}>
            <Text style={[styles.sessionStatus, { color: status.statusColor }]} numberOfLines={1}>
                {status.statusText}
            </Text>
            {activityLabel ? (
                <Text style={styles.sessionActivity} numberOfLines={1}>
                    {activityLabel}
                </Text>
            ) : null}
        </View>
    );
});

export const SessionSelectionModal = React.memo(function SessionSelectionModal(
    props: SessionSelectionModalProps,
) {
    const sessions = useSessions();
    const windowDimensions = useWindowDimensions();
    const keyboardHeight = useKeyboardHeight();
    const modalLayout = React.useMemo(() => resolveSessionSelectionModalLayout({
        windowWidth: windowDimensions.width,
        windowHeight: windowDimensions.height,
        keyboardHeight,
    }), [keyboardHeight, windowDimensions.height, windowDimensions.width]);
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: props.title,
        testID: `${props.testID}-modal`,
        layout: 'fill' as const,
        dimensions: {
            width: SESSION_SELECTION_MODAL_WIDTH,
            maxHeightRatio: modalLayout.maxHeightRatio,
            size: SESSION_SELECTION_MODAL_SIZE,
        },
    }), [modalLayout.maxHeightRatio, props.testID, props.title]);
    useModalCardChrome(props.setChrome, chrome);

    const sessionListViewDataByServerId = useSessionListViewDataByServerId(props.serverIds);
    const targets = React.useMemo<ReadonlyArray<SessionSelectionCandidate>>(() => {
        const candidates: SessionSelectionCandidate[] = [];
        const seenTargetKeys = new Set<string>();
        appendSessionListTargets(candidates, seenTargetKeys, sessionListViewDataByServerId);
        for (const session of sessions ?? []) {
            appendSessionSelectionTarget(
                candidates,
                seenTargetKeys,
                session,
                session.serverId ?? resolveServerIdForSessionIdFromLocalCache(session.id),
            );
        }
        const visible = candidates.filter(isUserFacingSession);
        return props.selectSessions ? props.selectSessions(visible) : sortSessionSelectionCandidates(visible);
    }, [props.selectSessions, sessions, sessionListViewDataByServerId]);

    const options = React.useMemo<ReadonlyArray<SelectionListOption>>(() => {
        const includeServerName = new Set(targets.map((session) => session.serverId)).size > 1;
        return [
            ...(props.leadingOptions ?? []),
            ...targets.map((session) => ({
                id: sessionOptionId({ sessionId: session.id, serverId: session.serverId }),
                testID: `${props.testID}-option-${session.id}`,
                label: getSessionName(session),
                subtitle: includeServerName
                    ? [getServerProfileById(session.serverId)?.name ?? session.serverId, getSessionSubtitle(session)].filter(Boolean).join(' · ')
                    : getSessionSubtitle(session),
                icon: (
                    <SessionListIdentity
                        session={session}
                        display="agentLogo"
                        avatarSize={20}
                        agentLogoSize={20}
                        testID={`${props.testID}-agent-logo-${session.id}`}
                    />
                ),
                rightAccessory: <SessionSelectionRowMeta session={session} testID={props.testID} />,
            })),
        ];
    }, [props.leadingOptions, props.testID, targets]);

    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: `${props.testID}-root`,
        title: props.title,
        inputPlaceholder: props.searchPlaceholder,
        emptyStateLabel: props.emptyStateLabel,
        sections: [
            {
                kind: 'static',
                id: 'sessions',
                options,
                virtualization: 'auto',
            },
        ],
    }), [options, props.title, props.testID, props.searchPlaceholder, props.emptyStateLabel]);

    return (
        <View testID={`${props.testID}-modal-body`} style={styles.body}>
            <Text style={styles.subtitle}>{props.subtitle}</Text>
            {options.length > 0 ? (
                <SelectionList
                    testID={`${props.testID}-list`}
                    rootStep={rootStep}
                    onSelect={(id) => {
                        const selected = targets.find((target) => sessionOptionId({ sessionId: target.id, serverId: target.serverId }) === id);
                        if (selected) {
                            fireAndForget((async () => {
                                await props.onSelectSession({ sessionId: selected.id, serverId: selected.serverId });
                                props.onClose();
                            })(), { tag: 'SessionSelectionModal.selectSession' });
                        } else {
                            props.onSelectOption?.(id);
                            props.onClose();
                        }
                    }}
                    onRequestClose={() => {
                        props.onDismiss();
                        props.onClose();
                    }}
                    autoFocusInputOnWeb
                    keyboardHintsEnabled
                    maxHeight={modalLayout.listMaxHeight}
                    heightBehavior="fixedToMaxHeight"
                    showsVerticalScrollIndicator
                />
            ) : (
                <Text testID={`${props.testID}-empty`} style={styles.empty}>
                    {props.emptyStateLabel}
                </Text>
            )}
        </View>
    );
});
