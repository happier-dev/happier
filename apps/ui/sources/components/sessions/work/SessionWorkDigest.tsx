import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useSessionRecapState } from '@/components/sessions/companion/summary/useSessionRecap';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { createAppSessionTranscriptActions } from '@/components/sessions/transcript/source/appSessionTranscriptActions';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { formatRelativeTimeShort, readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';

import { WorkItemRow } from './WorkItemRow';
import type { WorkItem } from './workProjection';
import { WorkSection, WorkSectionBlock, WorkSectionEmptyLine } from './WorkSection';

/**
 * A coordinator's digest on its Work page (C1 R12, lab P1 `digest`): a Work section like Working and
 * Recent. Its heading says when and from where; its lead is the Recap in its own words (the memory
 * synopsis, else what a managed Session delivered). The Session that sent it follows as the same Work
 * row the list draws, with its status, when the list above does not already show it quietly: as in the
 * lab, a row that needs you is repeated here, a Working or Recent one is not. It stores nothing and has no
 * summarizer or timer. The refresh at the heading's end (lab P1-C "Ask for a fresh digest") is an ordinary
 * message to this coordinator, sent through the Session send owner (`session.message.send`), so admission,
 * confirmation, the pending queue and failures are the ones every message already has.
 */
export const SessionWorkDigest = React.memo(function SessionWorkDigest(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    /** The Work list's own Session rows, by Session id: the update's sender is drawn as its row. */
    sessionItemById: ReadonlyMap<string, WorkItem>;
    /** Sessions the list above already shows as Working or Recent rows: named, not drawn again. */
    listedQuietSessionIds: ReadonlySet<string>;
    onOpenItem: (item: WorkItem) => void;
}>) {
    const address = React.useMemo(() => normalizeSessionAddress(props.serverId, props.sessionId), [props.serverId, props.sessionId]);
    const presented = useLayoutPresentationActive();
    const { status, recap } = useSessionRecapState(address, presented);
    const atMs = recap?.atMs ?? null;
    const readNextRefresh = React.useCallback((nowMs: number) => (
        atMs === null ? null : readRelativeTimeShortRefreshAtMs(atMs, nowMs)
    ), [atMs]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, presented && atMs !== null);
    const refresh = useDigestRefresh(props.sessionId, props.serverId);
    const workerSessionId = recap?.source === 'worker_update' ? recap.workerSessionId ?? null : null;
    const sourceItem = workerSessionId ? props.sessionItemById.get(workerSessionId) ?? null : null;

    // When and where it comes from, quiet beside the title (lab "Today 09:12 · from your rule").
    const meta = recap && atMs !== null
        ? `${formatRelativeTimeShort(atMs, nowMs)} · ${recap.source === 'synopsis' ? t('sessionWork.digest.fromMemory') : t('sessionWork.digest.latestUpdate')}`
        : '';
    // The Recap's own words; a status-only update is said plainly, naming the Session it is about.
    const lead = !recap ? null
        : recap.source === 'synopsis' ? recap.text
            : recap.body ?? (sourceItem ? t('sessionWork.digest.statusSentence', { title: sourceItem.title, status: recap.text }) : recap.text);

    return (
        <WorkSection
            testID="session-work-digest"
            title={t('sessionWork.digest.title')}
            count={meta}
            loading={status === 'loading'}
            action={(
                <IconButton
                    testID="session-work-digest-refresh"
                    iconName="arrow-clockwise"
                    variant="plain"
                    accessibilityLabel={t('sessionWork.digest.refresh')}
                    tooltip={t('sessionWork.digest.refresh')}
                    busy={refresh.sending}
                    onPress={refresh.send}
                />
            )}
        >
            {recap ? (<>
                <WorkSectionBlock style={styles.leadBlock}>
                    <Text testID="session-work-digest-lead" numberOfLines={6} style={styles.lead}>{lead}</Text>
                </WorkSectionBlock>
                {sourceItem && workerSessionId && !props.listedQuietSessionIds.has(workerSessionId) ? (
                    <View testID="session-work-digest-source">
                        <WorkItemRow item={sourceItem} onOpen={props.onOpenItem} />
                    </View>
                ) : null}
            </>) : status === 'unavailable' ? (
                <WorkSectionEmptyLine testID="session-work-digest-unavailable" text={t('sessionWork.digest.unavailable')} />
            ) : status === 'empty' ? (
                <WorkSectionEmptyLine testID="session-work-digest-empty" text={t('sessionWork.digest.empty')} />
            ) : null}
        </WorkSection>
    );
});

/**
 * Ask this coordinator to post a fresh digest: the canned request goes out as the person's message to
 * this exact Session. One request at a time; a failure is the same alert every Action failure shows.
 */
function useDigestRefresh(sessionId: string, serverId: string | null) {
    const actions = React.useMemo(() => createAppSessionTranscriptActions(sessionId, serverId), [sessionId, serverId]);
    const pendingRef = React.useRef(false);
    const [sending, setSending] = React.useState(false);
    const send = React.useCallback(() => {
        if (pendingRef.current) return;
        pendingRef.current = true;
        setSending(true);
        fireAndForget((async () => {
            try {
                await actions.submitMessage(t('sessionWork.digest.refreshRequest'));
            } catch (error) {
                Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.requestFailed'));
            } finally {
                pendingRef.current = false;
                setSending(false);
            }
        })(), { tag: 'SessionWorkDigest.refresh' });
    }, [actions]);
    return { sending, send };
}

const styles = StyleSheet.create((theme) => ({
    // The lead is the section's first line of reading; the row follows a breath below it.
    leadBlock: {
        paddingBottom: theme.space.s6,
    },
    lead: {
        ...Typography.variant('body'),
        color: theme.colors.text.primary,
    },
}));
