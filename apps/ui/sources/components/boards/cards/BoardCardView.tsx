import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_DRAG_GRIP_METRICS, HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { formatRelativeTimeShort, readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { workStatusSurfaceStyle, workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import { getStorage } from '@/sync/domains/state/storage';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import { getSessionWorkContext } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { formatNextScheduledRun, readNextScheduledRunRefreshAtMs } from '@/components/workflows/triggers/formatTriggerSummary';
import { describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';

import type { BoardCard, BoardCardBody } from '../model/boardCards';
import type { BoardCardAction } from '../model/boardCardOpenTarget';

/**
 * One board card (lab `boards-B1`): identity mark, name and the state word; "Kind · context"; then the
 * kind's body. Healthy work stays neutral; needs-you and trouble take the shared state treatment
 * (`workStatusTreatment`) — a soft ring, a faint tint and the word in tone. A card never answers a
 * permission: pressing it opens the item where that happens.
 */

const KIND_ICON: Readonly<Record<BoardCard['ref']['kind'], IconName>> = {
    task: 'check-square',
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

function readBodyRefreshAtMs(body: BoardCardBody, nowMs: number): number | null {
    const ageRefresh = (iso: string | null) => iso === null ? null : readRelativeTimeShortRefreshAtMs(Date.parse(iso), nowMs);
    if (body.kind === 'workflow_run') return runAttentionLine(body) ? null : ageRefresh(body.startedAt);
    if (body.kind !== 'workflow') return null;
    const deadlines = [body.lastRunWord ? ageRefresh(body.lastRunAt) : null,
        body.nextRun.kind === 'scheduled' ? readNextScheduledRunRefreshAtMs(body.nextRun.at, nowMs) : null]
        .filter((at): at is number => at !== null);
    return deadlines.length === 0 ? null : Math.min(...deadlines);
}

const NO_SESSION_ADDRESSES: readonly SessionAddress[] = [];

/** The session's context line, read from its own row by this card only. */
const SessionContext = React.memo(function SessionContext(props: Readonly<{ serverId: string; sessionId: string }>) {
    const subtitle = getStorage()((state) => {
        const row = readSessionListRowForServerId(state.sessionListRowsByServerId, props.serverId, props.sessionId);
        return row ? getSessionWorkContext(row, props.serverId) : null;
    });
    return <Text numberOfLines={1} style={styles.kind}>{t('boards.kinds.session')}
        {subtitle ? <Text style={styles.context}>{' · '}{subtitle}</Text> : null}
    </Text>;
});

/**
 * The Run's attention in the body, unless the card's state word already names it: a held Run's word is
 * its hold ("Waiting for your review"), so the body keeps its progress and age instead of saying it
 * again; a stopped Run that still needs the person says so here beside its outcome word.
 */
function runAttentionLine(body: Extract<BoardCardBody, { kind: 'workflow_run' }>): string | null {
    return body.state === 'waiting_for_review' ? null : body.attentionLabel;
}

/** `shownWord`: the state word on screen, which the body never says again. */
function describeBody(body: BoardCardBody, nowMs: number, shownWord: string | null): string | null {
    switch (body.kind) {
        case 'task':
            return null;
        case 'workflow_run': {
            const age = ageOf(body.startedAt, nowMs);
            const state = runAttentionLine(body) ?? (age ? t('boards.card.run.started', { age }) : null);
            return [describeWorkflowRunProgress(body.progress), state].filter(Boolean).join(' · ') || null;
        }
        case 'workflow': {
            const age = ageOf(body.lastRunAt, nowMs);
            const lastRun = !body.lastRunWord || !age ? null : body.lastRunWord === shownWord
                ? t('boards.card.workflow.lastRunAt', { age }) : t('boards.card.workflow.lastRun', { word: body.lastRunWord, age });
            const needs = body.needsYouCount !== null && body.needsYouCount > 0
                ? t('boards.card.workflow.needYou', { count: body.needsYouCount }) : null;
            const next = body.nextRun.kind === 'scheduled' ? formatNextScheduledRun(body.nextRun.at, true, nowMs)
                : body.nextRun.kind === 'unavailable' ? `${t('automations.detail.overview.nextRunTitle')}: ${t('boards.card.notLoaded')}` : null;
            return [body.triggerSummary, next, lastRun, needs]
                .filter(Boolean).join(' · ') || null;
        }
        case 'machine': {
            if (body.online === null) return shownWord === t('common.unknown') ? null : t('common.unknown');
            if (!body.online) return t('boards.card.machine.offlineBody');
            // Who needs the person is the card's state word; the body says what the Machine is doing.
            return body.counts.running > 0 ? t('boards.card.machine.running', { count: body.counts.running }) : t('boards.card.machine.idle');
        }
        case 'session':
            return body.statusDetail ?? null;
        case 'none':
            return null;
    }
}

/** The card's one secondary action: Run now for a readable workflow, Review for a held Run. */
export function resolveBoardCardAction(card: BoardCard): BoardCardAction | null {
    if (card.availability !== 'ready') return null;
    // A parent hold is enough to open its native detail, not to claim a review/permission type.
    // Aggregate attention (including stopped/uncertain custody) does not establish a hold.
    if (card.ref.kind === 'workflow') return 'run';
    return card.body.kind === 'workflow_run' && card.body.state === 'waiting_for_review' ? 'review' : null;
}

/**
 * The card's frame: its edge, the shared state ring and tint, and the lift. It holds the open target and the
 * action side by side, so the action is never a control inside the card's own button.
 */
export function BoardCardFrame(props: Readonly<{ card: BoardCard; lifted?: boolean; children: React.ReactNode }>) {
    return <View testID={`board-card:${props.card.key}`}
        style={[styles.card, workStatusSurfaceStyle(props.card.status.tone), props.lifted ? styles.lifted : null]}>
        {props.children}
    </View>;
}

/** The card's own content, drawn inside its open target. */
export const BoardCardContent = React.memo(function BoardCardContent(props: Readonly<{
    card: BoardCard;
    /** The enclosing status group already states this fact; accessibility keeps the exact word. */
    showStatusWord?: boolean;
    /** The card carries its grip in its top corner: the title row ends before it. */
    gripped?: boolean;
}>) {
    const { theme } = useUnistyles();
    const { card } = props;
    // A Session card names itself from encrypted content: it demands that content like a visible list row.
    const sessionAddress = card.body.kind === 'session' ? normalizeSessionAddress(card.body.serverId, card.body.sessionId) : null;
    useSessionContentDemand(sessionAddress ? [sessionAddress] : NO_SESSION_ADDRESSES, { tag: 'board.hydrateSessionCard', hydrate: 'unsettled' });
    const unavailable = card.availability !== 'ready';
    // The item is still arriving: the card holds its title's line with a skeleton rather than naming it unavailable.
    const loading = card.availability === 'not_loaded';
    const reducedMotion = useReducedMotionPreference();
    // In a status group the column names the bucket, so the title row drops the word. A card that needs
    // the person or is in trouble still says what it is waiting for ("Permission required") on its own
    // line; a healthy word ("Idle") would only repeat the column.
    const grouped = props.showStatusWord === false;
    const groupedWord = grouped && card.status.tone !== 'neutral' ? card.status.word : null;
    const shownWord = grouped ? groupedWord : card.status.word;
    const readNextRefresh = React.useCallback((nowMs: number) => readBodyRefreshAtMs(card.body, nowMs), [card.body]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, !unavailable
        && (card.body.kind === 'workflow' || card.body.kind === 'workflow_run'));
    const body = unavailable
        ? (card.unavailableReason ?? (card.availability === 'home_unavailable' ? t('boards.card.unavailableBody') : null))
        : describeBody(card.body, nowMs, shownWord);
    const kindLabel = t(`boards.kinds.${card.ref.kind}`);
    return (
        <View style={[styles.content, resolveBoardCardAction(card) ? styles.contentAboveAction : null]}>
            <View style={[styles.titleRow, props.gripped ? styles.titleRowGripped : null]}>
                <View style={styles.mark}><Icon name={KIND_ICON[card.ref.kind]} size={16} color={theme.colors.text.secondary} /></View>
                {/* A grouped card sits in a narrow column: its name may take a second line rather than truncate. */}
                {loading
                    ? <View testID={`board-card:${card.key}:loading`} accessible accessibilityLabel={card.title} style={styles.titleSkeleton}>
                        <HappierSkeletonBlock width="55%" height={10} radius={5} color={theme.colors.surface.skeleton} reducedMotion={reducedMotion} />
                    </View>
                    : <Text numberOfLines={grouped ? 2 : 1} style={[styles.title, unavailable ? styles.quiet : null]}>{card.title}</Text>}
                {grouped || loading ? null : <Text
                    testID={`board-card:${card.key}:word`}
                    numberOfLines={1}
                    style={[styles.word, workStatusWordStyle(card.status.tone)]}
                >
                    {card.status.word}
                </Text>}
            </View>
            {/* A settled unavailable card, and an unreadable Session (its detail is the reason it cannot be named),
                is already titled by its kind; the line would only repeat it. */}
            {/* An untitled item whose title already reads as its kind (a Run with no name) skips the line too. */}
            {(unavailable && !loading) || (card.body.kind === 'session' && card.body.statusDetail !== undefined)
                || (card.body.kind !== 'session' && card.title === kindLabel) ? null : <View style={styles.metaRow}>
                {card.body.kind === 'session'
                    ? <SessionContext serverId={card.body.serverId} sessionId={card.body.sessionId} />
                    : <Text numberOfLines={1} style={styles.kind}>{kindLabel}</Text>}
            </View>}
            {body ? <Text style={[styles.body, unavailable ? styles.quiet : null]}>{body}</Text> : null}
            {groupedWord ? <Text testID={`board-card:${card.key}:needs`} style={[styles.body, workStatusWordStyle(card.status.tone)]}>{groupedWord}</Text> : null}
        </View>
    );
});

/** Domain identity; the Collection and widget frame own its placement. */
export function BoardCardMark(props: Readonly<{ card: BoardCard }>) {
    const { theme } = useUnistyles();
    return <Icon name={KIND_ICON[props.card.ref.kind]} size={16} color={theme.colors.text.secondary} />;
}

export function shownBoardCardWord(card: BoardCard, showStatusWord?: boolean): string | null {
    if (card.availability === 'not_loaded'
        || ((showStatusWord === false || (card.ref.kind === 'workflow' && card.availability === 'ready'))
            && card.status.tone === 'neutral')) return null;
    return card.status.word;
}

export function BoardCardStatus(props: Readonly<{ card: BoardCard; showStatusWord?: boolean }>) {
    const { card } = props;
    const grouped = props.showStatusWord === false;
    const word = shownBoardCardWord(card, props.showStatusWord);
    if (word === null) return null;
    return <Text testID={`board-card:${card.key}:${grouped ? 'needs' : 'word'}`}
        style={[styles.word, workStatusWordStyle(card.status.tone)]}>{word}</Text>;
}

/** Domain context stays live only while its rendered card demands it. */
export function BoardCardFacts(props: Readonly<{ card: BoardCard }>) {
    const { card } = props;
    const kindLabel = t(`boards.kinds.${card.ref.kind}`);
    if ((card.availability !== 'ready' && card.availability !== 'not_loaded')
        || (card.body.kind === 'session' && card.body.statusDetail !== undefined)
        || (card.body.kind !== 'session' && card.title === kindLabel)) return null;
    return card.body.kind === 'session'
        ? <SessionContext serverId={card.body.serverId} sessionId={card.body.sessionId} />
        : <Text style={styles.kind}>{kindLabel}</Text>;
}

/** Live domain body only; identity, facts, actions and activation belong to the shared card. */
export const BoardCardBodyContent = React.memo(function BoardCardBodyContent(props: Readonly<{
    card: BoardCard;
    /** The enclosing status group already states this fact; accessibility keeps the exact word. */
    showStatusWord?: boolean;
}>) {
    const { theme } = useUnistyles();
    const { card } = props;
    // A Session card names itself from encrypted content: it demands that content like a visible list row.
    const sessionAddress = card.ref.kind === 'session' && card.availability !== 'home_unavailable'
        ? normalizeSessionAddress(card.ref.qualifiedId.serverId, card.ref.qualifiedId.id) : null;
    useSessionContentDemand(sessionAddress ? [sessionAddress] : NO_SESSION_ADDRESSES, { tag: 'board.hydrateSessionCard', hydrate: 'unsettled' });
    const unavailable = card.availability !== 'ready';
    // The semantic title stays available while its content is still arriving.
    const loading = card.availability === 'not_loaded';
    const reducedMotion = useReducedMotionPreference();
    // Group headers name healthy states; a speaking word still explains what needs the person.
    const shownWord = shownBoardCardWord(card, props.showStatusWord);
    const readNextRefresh = React.useCallback((nowMs: number) => readBodyRefreshAtMs(card.body, nowMs), [card.body]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, !unavailable
        && (card.body.kind === 'workflow' || card.body.kind === 'workflow_run'));
    const body = unavailable
        ? (card.unavailableReason ?? (card.availability === 'home_unavailable' ? t('boards.card.unavailableBody') : null))
        : describeBody(card.body, nowMs, shownWord);
    return (
        <>
            {loading ? <View testID={`board-card:${card.key}:loading`} accessible accessibilityLabel={card.title} style={styles.titleSkeleton}>
                <HappierSkeletonBlock width="55%" height={10} radius={5} color={theme.colors.surface.skeleton} reducedMotion={reducedMotion} />
            </View> : null}
            {body ? <Text style={[styles.body, unavailable ? styles.quiet : null]}>{body}</Text> : null}
        </>
    );
});

/** The card's secondary action, on its own line under the content; `null` when the card has none. */
export function BoardCardActionButton(props: Readonly<{
    card: BoardCard;
    onAction?: (card: BoardCard, action: BoardCardAction) => void;
    /** A carry owns interaction without changing the card's measured footprint. */
    disabled?: boolean;
}>) {
    const { card, onAction } = props;
    const action = resolveBoardCardAction(card);
    if (!action || !onAction) return null;
    return <View style={styles.action}>
        <RoundButton testID={`board-card:${card.key}:${action}`} size="small" display="secondary"
            disabled={props.disabled}
            title={action === 'run' ? t('workflows.destination.rowMenu.runNow') : t('workflows.run.review')}
            onPress={() => onAction(card, action)} />
    </View>;
}

/**
 * The whole card. `renderTarget` wraps the content in the caller's open target (a Pressable); the action
 * sits beside that target inside the frame.
 */
export const BoardCardView = React.memo(function BoardCardView(props: Readonly<{
    card: BoardCard;
    /** Lifted while dragged. */
    lifted?: boolean;
    /** The enclosing status group already states this fact; accessibility keeps the exact word. */
    showStatusWord?: boolean;
    onAction?: (card: BoardCard, action: BoardCardAction) => void;
    /** A carry owns interaction without changing the card's measured footprint. */
    actionsDisabled?: boolean;
    renderTarget?: (content: React.ReactNode) => React.ReactNode;
    /**
     * The Canvas grip. It sits inside the card's top corner, level with the title, as a widget card keeps
     * its grip in its header: a sibling of the open target, never a control inside the card's button.
     */
    grip?: React.ReactNode;
}>) {
    const gripped = props.grip !== undefined && props.grip !== null;
    const content = <BoardCardContent card={props.card} showStatusWord={props.showStatusWord} gripped={gripped} />;
    return <BoardCardFrame card={props.card} lifted={props.lifted}>
        {props.renderTarget ? props.renderTarget(content) : content}
        <BoardCardActionButton card={props.card} onAction={props.onAction} disabled={props.actionsDisabled} />
        {gripped ? <View style={styles.grip}>{props.grip}</View> : null}
    </BoardCardFrame>;
});

const styles = StyleSheet.create((theme) => ({
    // The theme's card radius and spacing scales (the same the Work map's node cards read), so a
    // board follows the person's radius and density choices.
    card: {
        width: '100%',
        borderRadius: theme.borderRadius.xl,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    lifted: shadowLevelStyle(theme.colors.shadowLevels[4]),
    content: {
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
    },
    // The action's own line carries the card's bottom inset.
    contentAboveAction: { paddingBottom: theme.space.s8 },
    // The mark sits on the title's first line, so a two-line name in a status column keeps it level.
    titleRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
    },
    // Clears the grip (its box, a small gap, at the grip's inset rather than the content's).
    titleRowGripped: { paddingRight: HAPPIER_DRAG_GRIP_METRICS.pointer.box + theme.space.s4 + theme.space.s8 - theme.space.s16 },
    // Level with the title's first line, a little inside the card's corner.
    grip: {
        position: 'absolute',
        top: theme.space.s12 + (Typography.variant('label', 'semiBold').lineHeight - HAPPIER_DRAG_GRIP_METRICS.pointer.box) / 2,
        right: theme.space.s8,
    },
    mark: {
        height: Typography.variant('label', 'semiBold').lineHeight,
        justifyContent: 'center',
    },
    title: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
        flex: 1,
        minWidth: 0,
    },
    // The skeleton bar is centred in the title's own line, so the loaded title lands without a jump.
    titleSkeleton: {
        flex: 1,
        minWidth: 0,
        height: Typography.variant('label', 'semiBold').lineHeight,
        justifyContent: 'center',
    },
    word: {
        ...Typography.variant('meta'),
        alignSelf: 'center',
        color: theme.colors.text.secondary,
        flexShrink: 1,
        maxWidth: '40%',
        minWidth: 0,
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: theme.space.s24,
        minWidth: 0,
    },
    kind: {
        ...Typography.variant('meta'),
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
        minWidth: 0,
    },
    context: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    body: {
        ...Typography.variant('meta'),
        color: theme.colors.text.primary,
        paddingLeft: theme.space.s24,
        paddingTop: theme.space.s4,
    },
    quiet: {
        color: theme.colors.text.tertiary,
    },
    // Trailing, like the lab's card actions: the body reads first, the action closes the card.
    action: { alignItems: 'flex-end', paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s12 },
}));
