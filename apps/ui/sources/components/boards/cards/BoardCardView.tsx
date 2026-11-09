import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { formatRelativeTimeShort, readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import { getStorage } from '@/sync/domains/state/storage';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import { getSessionName, getSessionWorkContext } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { formatNextScheduledRun, readNextScheduledRunRefreshAtMs } from '@/components/workflows/triggers/formatTriggerSummary';
import { describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';
import { useAppShellPluginUiProjection, useAppShellPluginUiProjectionReader } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { Modal } from '@/modal';
import { PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE } from '@happier-dev/protocol/plugins/actions/invocation';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { dispatchBoardTaskTransition, readBoardTaskTransitionAction } from '../model/boardTaskActions';
import { BoardTaskRefreshContext } from '../model/useBoardTaskItems';

import type { BoardCard, BoardCardBody } from '../model/boardCards';
import type { BoardCardAction, BoardCardSecondaryAction } from '../model/boardCardOpenTarget';

/** Board domain facts and controls, bound to the existing shared card and widget-frame anatomy. */

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
        case 'task': {
            const category = resolveWorkStatusTone({ kind: 'task', facts: { category: body.item.category,
                word: body.item.categoryLabel, linkedStatuses: [] } }).word;
            return [category === shownWord ? null : category, body.item.parentTitle].filter(Boolean).join(' · ') || null;
        }
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
export function resolveBoardCardAction(card: BoardCard): BoardCardSecondaryAction | null {
    if (card.availability !== 'ready') return null;
    // A parent hold is enough to open its native detail, not to claim a review/permission type.
    // Aggregate attention (including stopped/uncertain custody) does not establish a hold.
    if (card.ref.kind === 'workflow') return 'run';
    return card.body.kind === 'workflow_run' && card.body.state === 'waiting_for_review' ? 'review' : null;
}

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

/** Native task controls or the card's secondary Run/Review action; `null` when it has none. */
export function BoardCardActionButton(props: Readonly<{
    card: BoardCard;
    onAction?: (card: BoardCard, action: BoardCardAction) => void;
    /** A carry owns interaction without changing the card's measured footprint. */
    disabled?: boolean;
}>) {
    const { card, onAction } = props;
    if (card.ref.kind === 'task' && card.body.kind === 'task' && card.availability === 'ready') {
        return <BoardTaskCardActions card={card} onAction={onAction} disabled={props.disabled} />;
    }
    const action = resolveBoardCardAction(card);
    if (!action || !onAction) return null;
    // Run starts independent work; it is not the fix for a speaking Workflow status.
    // Keep its row/menu eligibility at resolveBoardCardAction and the Workflow home.
    if (action === 'run' && shownBoardCardWord(card) !== null) return null;
    return <View style={styles.action}>
        <RoundButton testID={`board-card:${card.key}:${action}`} size="small" display="secondary"
            disabled={props.disabled}
            title={action === 'run' ? t('workflows.destination.rowMenu.runNow') : t('workflows.run.review')}
            onPress={() => onAction(card, action)} />
    </View>;
}

function BoardTaskSessionButton(props: Readonly<{ cardKey: string; serverId: string; sessionId: string; onOpen: () => void; disabled?: boolean }>) {
    const isSessionVisible = useSessionRecordingVisibility();
    const name = getStorage()(state => {
        if (!isSessionVisible(props)) return t('boards.kinds.session');
        const row = readSessionListRowForServerId(state.sessionListRowsByServerId, props.serverId, props.sessionId);
        return row ? getSessionName(row) : props.sessionId;
    });
    return <RoundButton testID={`board-card:${props.cardKey}:session:${props.serverId}:${props.sessionId}`} size="small" display="secondary"
        disabled={props.disabled} title={t('inbox.openSession', { session: name })}
        onPress={props.onOpen} />;
}

/** Transient invocation state only; live task facts stay with the public reader. */
function BoardTaskCardActions(props: Readonly<{ card: BoardCard; onAction?: (card: BoardCard, action: BoardCardAction) => void; disabled?: boolean }>) {
    const refreshTaskItems = React.useContext(BoardTaskRefreshContext);
    const readCurrentView = useAppShellPluginUiProjectionReader();
    const selected = useAppShellPluginUiProjection(view => ({
        action: readBoardTaskTransitionAction(props.card, view)?.action ?? null,
        accountLifetime: view.accountLifetime,
    }));
    const controller = React.useRef<AbortController | null>(null);
    const inFlight = React.useRef(false);
    const [pending, setPending] = React.useState<string | null>(null);
    React.useEffect(() => {
        const lifetime = new AbortController();
        controller.current = lifetime;
        inFlight.current = false;
        setPending(null);
        const retirement = selected.accountLifetime?.onRetire(() => lifetime.abort());
        return () => { lifetime.abort(); retirement?.dispose(); if (controller.current === lifetime) controller.current = null; };
    }, [props.card.key, selected.accountLifetime]);
    if (props.card.body.kind !== 'task') return null;
    const item = props.card.body.item;
    const transitions = selected.action ? item.transitions ?? [] : [];
    if (item.linkedSessions.length === 0 && transitions.length === 0) return null;
    const transition = async (transitionId: string) => {
        const lifetime = controller.current;
        if (props.disabled || inFlight.current || !lifetime || lifetime.signal.aborted) return;
        inFlight.current = true;
        setPending(transitionId);
        try {
            const outcome = await dispatchBoardTaskTransition({ card: props.card, transitionId,
                readCurrentView, signal: lifetime.signal });
            if (outcome.ok && !lifetime.signal.aborted) refreshTaskItems?.();
            if (!outcome.ok && outcome.reason !== PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE && !lifetime.signal.aborted) {
                Modal.alert(t('common.error'), t('pluginRuntime.actionFailed'));
            }
        } catch {
            if (!lifetime.signal.aborted) Modal.alert(t('common.error'), t('pluginRuntime.actionFailed'));
        } finally {
            if (controller.current === lifetime) {
                inFlight.current = false;
                if (!lifetime.signal.aborted) setPending(null);
            }
        }
    };
    return <View style={styles.action}>
        {item.linkedSessions.map(link => <BoardTaskSessionButton key={JSON.stringify([link.serverId, link.sessionId])}
            cardKey={props.card.key} {...link} disabled={props.disabled}
            onOpen={() => props.onAction?.(props.card, { session: { serverId: link.serverId, sessionId: link.sessionId } })} />)}
        {transitions.map(option => <RoundButton key={option.id} testID={`board-card:${props.card.key}:transition:${option.id}`}
            size="small" display="secondary" title={option.label} loading={pending === option.id}
            disabled={props.disabled || pending !== null} onPress={() => transition(option.id)} />)}
    </View>;
}

/**
 * Canvas retains its own focus/gesture target. Shared WidgetFrame card chrome owns the identity,
 * controls and domain body; its open target is a sibling beneath them.
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
    /**
     * Canvas-owned grid quantization: the room that rounds the card up to the grid, kept under the
     * description (above the facts at the card's foot), never on the open target.
     */
    gridInsetPx?: number;
    renderTarget?: (content: React.ReactNode) => React.ReactNode;
    /**
     * The Canvas grip. It sits inside the card's top corner, level with the title, as a widget card keeps
     * its grip in its header: a sibling of the open target, never a control inside the card's button.
     */
    grip?: React.ReactNode;
}>) {
    return <View style={props.lifted ? styles.lifted : null}>
        <WidgetFrame testID={`board-card:${props.card.key}`} frameStyle="card" placement="board" anatomy="item"
            mark={<BoardCardMark card={props.card} />} title={props.card.title}
            meta={<BoardCardStatus card={props.card} showStatusWord={props.showStatusWord} />}
            menu={<BoardCardActionButton card={props.card} onAction={props.onAction} disabled={props.actionsDisabled} />}
            grip={props.grip} openTarget={props.renderTarget?.(null)}
            accessibilityLabel={`${props.card.title}, ${props.card.status.word}`}
            facts={<BoardCardFacts card={props.card} />}
            // The live domain line is the card's description, 2 under its title (lab store `y:card`); the
            // card has no body room of its own between them.
            source={<View testID={`board-card:${props.card.key}.description`} style={props.gridInsetPx ? { paddingBottom: props.gridInsetPx } : null}>
                <BoardCardBodyContent card={props.card} showStatusWord={props.showStatusWord} />
            </View>} />
    </View>;
});

const styles = StyleSheet.create((theme) => ({
    lifted: shadowLevelStyle(theme.colors.shadowLevels[4]),
    // Retain the current loading-line geometry within the live domain body.
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
        minWidth: 0,
    },
    // The card's quiet facts line (lab y:card facts: meta, ink 3), never a heavier label.
    kind: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
        minWidth: 0,
    },
    context: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    // The live domain line reads as the card's description (lab y:card: body, ink 2).
    body: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    quiet: {
        color: theme.colors.text.tertiary,
    },
    action: { alignItems: 'flex-end' },
}));
