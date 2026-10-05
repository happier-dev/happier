import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { formatRelativeTimeShort } from '@/components/ui/selectionList/formatRelativeTimeShort';
import { workStatusSurfaceStyle, workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import { getStorage } from '@/sync/domains/state/storage';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';

import type { BoardCard, BoardCardBody } from '../model/boardCards';

/**
 * One board card (lab `boards-B1`): identity mark, name and the state word; "Kind · context"; then the
 * kind's body. Healthy work stays neutral; needs-you and trouble take the shared state treatment
 * (`workStatusTreatment`) — a soft ring, a faint tint and the word in tone. A card never answers a
 * permission: pressing it opens the item where that happens.
 */

const KIND_ICON: Readonly<Record<BoardCard['ref']['kind'], IconName>> = {
    session: 'chat-circle',
    workflow_run: 'tree-structure',
    workflow: 'clock',
    machine: 'hard-drives',
};

function ageOf(iso: string | null, nowMs: number): string | null {
    if (!iso) return null;
    const at = Date.parse(iso);
    return Number.isFinite(at) ? formatRelativeTimeShort(at, nowMs) : null;
}

/** The session's context line, read from its own row by this card only. */
const SessionContext = React.memo(function SessionContext(props: Readonly<{ serverId: string; sessionId: string }>) {
    const subtitle = getStorage()((state) => {
        const row = readSessionListRowForServerId(state.sessionListRowsByServerId, props.serverId, props.sessionId);
        return row ? getSessionSubtitle(row, props.serverId) : null;
    });
    return subtitle ? <Text numberOfLines={1} style={styles.context}> · {subtitle}</Text> : null;
});

function describeBody(body: BoardCardBody, nowMs: number): string | null {
    switch (body.kind) {
        case 'workflow_run': {
            const age = ageOf(body.startedAt, nowMs);
            const state = body.waitingForYou ? t('boards.card.run.waitingForYou') : age ? t('boards.card.run.started', { age }) : null;
            return [describeWorkflowRunProgress(body.progress), state].filter(Boolean).join(' · ') || null;
        }
        case 'workflow': {
            const age = ageOf(body.lastRunAt, nowMs);
            const lastRun = body.lastRunWord && age ? t('boards.card.workflow.lastRun', { word: body.lastRunWord, age }) : null;
            const needs = body.needsYouCount !== null && body.needsYouCount > 0
                ? t('boards.card.workflow.needYou', { count: body.needsYouCount }) : null;
            const next = body.nextRun.kind === 'scheduled' ? t('workflows.triggers.row.nextRun', {
                time: formatWithCachedDateTimeFormatter(body.nextRun.at, getPreferredLanguage(), { dateStyle: 'medium', timeStyle: 'short' }),
            }) : body.nextRun.kind === 'unavailable' ? `${t('automations.detail.overview.nextRunTitle')}: ${t('boards.card.notLoaded')}` : null;
            return [body.triggerSummary, next, lastRun ?? (body.runSummaryAvailable ? t('boards.card.workflow.noRuns') : null), needs]
                .filter(Boolean).join(' · ') || null;
        }
        case 'machine': {
            if (!body.online) return t('boards.card.machine.offlineBody');
            const parts: string[] = [];
            if (body.counts.running > 0) parts.push(t('boards.card.machine.running', { count: body.counts.running }));
            if (body.counts.needsYou > 0) parts.push(t('boards.card.machine.needYou', { count: body.counts.needsYou }));
            return parts.length > 0 ? parts.join(' · ') : t('boards.card.machine.idle');
        }
        case 'session':
        case 'none':
            return null;
    }
}

export const BoardCardView = React.memo(function BoardCardView(props: Readonly<{
    card: BoardCard;
    /** Lifted while dragged. */
    lifted?: boolean;
}>) {
    const { theme } = useUnistyles();
    const { card } = props;
    const unavailable = card.availability !== 'ready';
    const body = unavailable
        ? (card.availability === 'home_unavailable' ? t('boards.card.unavailableBody') : null)
        : describeBody(card.body, Date.now());
    return (
        <View
            testID={`board-card:${card.key}`}
            style={[styles.card, workStatusSurfaceStyle(card.status.tone), props.lifted ? styles.lifted : null]}
        >
            <View style={styles.titleRow}>
                <Icon name={KIND_ICON[card.ref.kind]} size={16} color={theme.colors.text.secondary} />
                <Text numberOfLines={1} style={[styles.title, unavailable ? styles.quiet : null]}>{card.title}</Text>
                <Text
                    testID={`board-card:${card.key}:word`}
                    numberOfLines={1}
                    style={[styles.word, workStatusWordStyle(card.status.tone)]}
                >
                    {card.status.word}
                </Text>
            </View>
            <View style={styles.metaRow}>
                <Text numberOfLines={1} style={styles.kind}>{t(`boards.kinds.${card.ref.kind}`)}</Text>
                {card.body.kind === 'session'
                    ? <SessionContext serverId={card.body.serverId} sessionId={card.body.sessionId} />
                    : null}
            </View>
            {body ? <Text style={[styles.body, unavailable ? styles.quiet : null]}>{body}</Text> : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    // The theme's card radius and spacing scales (the same the Work map's node cards read), so a
    // board follows the person's radius and density choices.
    card: {
        width: '100%',
        gap: theme.margins.xs,
        paddingHorizontal: theme.margins.lg,
        paddingVertical: theme.margins.md,
        borderRadius: theme.borderRadius.xl,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    lifted: shadowLevelStyle(theme.colors.shadowLevels[4]),
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    title: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
        flex: 1,
        minWidth: 0,
    },
    word: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
        flexShrink: 0,
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 24,
        minWidth: 0,
    },
    kind: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        flexShrink: 0,
    },
    context: {
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    body: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
        paddingLeft: 24,
        paddingTop: 4,
    },
    quiet: {
        color: theme.colors.text.tertiary,
    },
}));
