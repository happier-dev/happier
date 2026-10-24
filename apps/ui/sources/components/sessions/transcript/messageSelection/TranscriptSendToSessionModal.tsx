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
import { t } from '@/text';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { getSessionName, getSessionStatus, getSessionSubtitle } from '@/utils/sessions/sessionUtils';

import { resolveTranscriptSendToSessionTargets } from './resolveTranscriptSendToSessionTargets';
import {
    resolveTranscriptSendToSessionModalLayout,
    TRANSCRIPT_SEND_TO_SESSION_MODAL_SIZE,
    TRANSCRIPT_SEND_TO_SESSION_MODAL_WIDTH,
} from './resolveTranscriptSendToSessionModalLayout';
import type { SendTranscriptSelectionDestination } from './sendTranscriptSelectionToSession';
import { Icon } from '@/components/ui/icons/Icon';

export type TranscriptSendToSessionModalProps = CustomModalInjectedProps & Readonly<{
    sourceSessionId: string;
    sourceServerId: string;
    previewText: string;
    onResolve: (destination: SendTranscriptSelectionDestination | null) => void;
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
    newSessionIcon: {
        width: 20,
        alignItems: 'center',
        justifyContent: 'center',
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

type TranscriptSendToSessionTargetSource = Session | SessionListRenderableSession;
type TranscriptSendToSessionTarget = TranscriptSendToSessionTargetSource & Readonly<{ serverId: string }>;

const NEW_SESSION_DESTINATION_ID = 'new-session';

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function appendTranscriptSendToTarget(
    targets: TranscriptSendToSessionTarget[],
    seenTargetKeys: Set<string>,
    session: TranscriptSendToSessionTargetSource,
    rawServerId: unknown,
): void {
    const sessionId = normalizeNonEmptyString(session.id);
    const serverId = normalizeNonEmptyString(rawServerId);
    if (!sessionId || !serverId) return;

    const targetKey = `${serverId}\u0000${sessionId}`;
    if (seenTargetKeys.has(targetKey)) return;
    seenTargetKeys.add(targetKey);
    targets.push({ ...session, serverId });
}

function appendSessionListTargets(
    targets: TranscriptSendToSessionTarget[],
    seenTargetKeys: Set<string>,
    sessionListViewDataByServerId: Readonly<Record<string, ReadonlyArray<SessionListViewItem> | null>>,
): void {
    for (const [recordServerId, items] of Object.entries(sessionListViewDataByServerId)) {
        const serverId = normalizeNonEmptyString(recordServerId);
        if (!serverId || !Array.isArray(items)) continue;

        for (const item of items) {
            if (item.type !== 'session') continue;
            appendTranscriptSendToTarget(targets, seenTargetKeys, item.session, item.serverId ?? serverId);
        }
    }
}

const TranscriptSendToSessionRowMeta = React.memo(function TranscriptSendToSessionRowMeta(
    props: Readonly<{ session: TranscriptSendToSessionTarget }>,
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
        <View testID={`transcript-send-to-session-meta-${props.session.id}`} style={styles.sessionMeta}>
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

export const TranscriptSendToSessionModal = React.memo(function TranscriptSendToSessionModal(
    props: TranscriptSendToSessionModalProps,
) {
    const { theme } = useUnistyles();
    const sessions = useSessions() ?? [];
    const windowDimensions = useWindowDimensions();
    const keyboardHeight = useKeyboardHeight();
    const modalLayout = React.useMemo(() => resolveTranscriptSendToSessionModalLayout({
        windowWidth: windowDimensions.width,
        windowHeight: windowDimensions.height,
        keyboardHeight,
    }), [keyboardHeight, windowDimensions.height, windowDimensions.width]);
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        layout: 'fill' as const,
        dimensions: {
            width: TRANSCRIPT_SEND_TO_SESSION_MODAL_WIDTH,
            maxHeightRatio: modalLayout.maxHeightRatio,
            size: TRANSCRIPT_SEND_TO_SESSION_MODAL_SIZE,
        },
    }), [modalLayout.maxHeightRatio]);
    useModalCardChrome(props.setChrome, chrome);

    const sourceServerId = props.sourceServerId.trim();
    const sourceServerIds = React.useMemo(() => sourceServerId ? [sourceServerId] : [], [sourceServerId]);
    const sessionListViewDataByServerId = useSessionListViewDataByServerId(sourceServerIds);
    const targets = React.useMemo<ReadonlyArray<TranscriptSendToSessionTarget>>(() => {
        const candidates: TranscriptSendToSessionTarget[] = [];
        const seenTargetKeys = new Set<string>();
        appendSessionListTargets(candidates, seenTargetKeys, sessionListViewDataByServerId);
        for (const session of sessions) {
            appendTranscriptSendToTarget(
                candidates,
                seenTargetKeys,
                session,
                session.serverId ?? resolveServerIdForSessionIdFromLocalCache(session.id),
            );
        }
        return resolveTranscriptSendToSessionTargets({
            sourceSessionId: props.sourceSessionId,
            sourceServerId,
            sessions: candidates,
        }) as ReadonlyArray<TranscriptSendToSessionTarget>;
    }, [props.sourceSessionId, sessions, sessionListViewDataByServerId, sourceServerId]);

    const onResolve = props.onResolve;
    const onClose = props.onClose;
    const options = React.useMemo<ReadonlyArray<SelectionListOption>>(() => [
        {
            id: NEW_SESSION_DESTINATION_ID,
            testID: 'transcript-send-to-session-option-new-session',
            label: t('transcript.selection.sendTo.newSession'),
            subtitle: t('transcript.selection.sendTo.newSessionSubtitle'),
            icon: (
                <View style={styles.newSessionIcon}>
                    <Icon name="plus-circle" size={20} color={theme.colors.text.secondary} />
                </View>
            ),
        },
        ...targets.map((session) => ({
            id: session.id,
            testID: `transcript-send-to-session-option-${session.id}`,
            label: getSessionName(session),
            subtitle: getSessionSubtitle(session),
            icon: (
                <SessionListIdentity
                    session={session}
                    display="agentLogo"
                    avatarSize={20}
                    agentLogoSize={20}
                    testID={`transcript-send-to-session-agent-logo-${session.id}`}
                />
            ),
            rightAccessory: <TranscriptSendToSessionRowMeta session={session} />,
        })),
    ], [targets, theme.colors.text.secondary]);

    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: 'transcript-send-to-session-root',
        title: t('transcript.selection.sendTo.modalTitle'),
        inputPlaceholder: t('transcript.selection.sendTo.searchPlaceholder'),
        emptyStateLabel: t('transcript.selection.sendTo.noResults'),
        sections: [
            {
                kind: 'static',
                id: 'sessions',
                options,
                virtualization: 'auto',
            },
        ],
    }), [options]);

    return (
        <View testID="transcript-send-to-session-modal-body" style={styles.body}>
            <Text style={styles.subtitle}>{t('transcript.selection.sendTo.modalSubtitle')}</Text>
            {options.length > 0 ? (
                <SelectionList
                    testID="transcript-send-to-session-list"
                    rootStep={rootStep}
                    onSelect={(id) => {
                        if (id === NEW_SESSION_DESTINATION_ID) {
                            onResolve({ kind: 'newSession' });
                            onClose();
                            return;
                        }
                        const selected = targets.find((target) => target.id === id);
                        onResolve(selected ? { kind: 'existingSession', sessionId: selected.id, serverId: selected.serverId } : null);
                        onClose();
                    }}
                    onRequestClose={() => {
                        onResolve(null);
                        onClose();
                    }}
                    autoFocusInputOnWeb
                    keyboardHintsEnabled
                    maxHeight={modalLayout.listMaxHeight}
                    heightBehavior="fixedToMaxHeight"
                    showsVerticalScrollIndicator
                />
            ) : (
                <Text testID="transcript-send-to-session-empty" style={styles.empty}>
                    {t('transcript.selection.sendTo.noResults')}
                </Text>
            )}
        </View>
    );
});
