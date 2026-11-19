import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { VirtualizedList, type VirtualizedListProps } from '@/components/ui/lists/virtualized';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

import { activityInstanceKey, normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';

import {
    type DesktopActivityOverlayFocusTargetRef,
    type DesktopActivityOverlayInitialFocusTarget,
    resolveDesktopActivityOverlayInitialFocusTarget,
} from '../resolveDesktopActivityOverlayInitialFocusTarget';
import type { DesktopActivityOverlayVisualModeForTestID as DesktopActivityOverlayVisualMode } from '../shared/desktopActivityOverlaySelectors';
import { DesktopActivityOverlayLeadRowClearance, DesktopActivityOverlaySessionRow } from '../DesktopActivityOverlaySessionRow';
import type {
    DesktopActivityOverlayActionHandler,
    DesktopActivityOverlayExpandedCard,
    DesktopActivityOverlaySessionRowModel,
    DesktopActivityOverlayUiModel,
} from '../shared/desktopActivityOverlayUiModel';
import {
    resolveDesktopActivityOverlayCardInstanceTestID,
    resolveDesktopActivityOverlayCardKindTestID,
} from '../shared/desktopActivityOverlaySelectors.mjs';
import { DesktopActivityOverlayCardActionStateProvider } from './DesktopActivityOverlayCardActionState';
import { DesktopActivityOverlayCardFrame } from './DesktopActivityOverlayCardFrame';
import { DesktopActivityOverlayCompletionStateCard } from './DesktopActivityOverlayCompletionStateCard';
import { DesktopActivityOverlayPermissionRequestCard } from './DesktopActivityOverlayPermissionRequestCard';
import { DesktopActivityOverlayQuotaSummaryCard } from './DesktopActivityOverlayQuotaSummaryCard';
import { DesktopActivityOverlayUserQuestionCard } from './DesktopActivityOverlayUserQuestionCard';
import type { BotFaceSnapshot } from '../../presentation/notchBotTypes';
import { DesktopActivityOverlayBotRow, NotchConversationMenu, type NotchConversationHandlers, type NotchConversationTarget } from '../faces/DesktopActivityOverlayFaces';

function wrapCard(
    card: DesktopActivityOverlayExpandedCard,
    child: React.ReactElement,
): React.ReactElement {
    return (
        <View key={card.id} testID={resolveDesktopActivityOverlayCardKindTestID(card.kind)}>
            {child}
        </View>
    );
}

const NO_FACES: readonly BotFaceSnapshot[] = [];

function sessionRowKey(sessionId: string, serverId: string | null): string {
    return `${serverId ?? ''}:${sessionId}`;
}

function buildSessionRowKey(sessionId: string, serverId: string | null): string {
    const address = normalizeSessionAddress(serverId, sessionId);
    return activityInstanceKey(
        address ?? { serverId: null, sessionId },
        'desktop_overlay_row',
    );
}

function DesktopActivityOverlayAutoDismissCompletionCard(props: React.PropsWithChildren<Readonly<{
    card: Extract<DesktopActivityOverlayExpandedCard, { kind: 'completion_state' }>;
    paused: boolean;
    onDismiss: (cardId: string) => void;
}>>): React.ReactElement {
    React.useEffect(() => {
        if (props.paused || props.card.sticky || props.card.autoDismissMs <= 0) {
            return;
        }

        const timeoutId = setTimeout(() => {
            props.onDismiss(props.card.id);
        }, props.card.autoDismissMs);

        return () => {
            clearTimeout(timeoutId);
        };
    }, [props.card.autoDismissMs, props.card.id, props.card.sticky, props.onDismiss, props.paused]);

    return <>{props.children}</>;
}

function ConversationRow(props: React.ComponentProps<typeof DesktopActivityOverlaySessionRow> & Readonly<{
    target: NotchConversationTarget;
    conversationHandlers?: NotchConversationHandlers;
}>): React.ReactElement {
    const { target, conversationHandlers, ...row } = props;
    if (!conversationHandlers) return <DesktopActivityOverlaySessionRow {...row} liftKey={target.sessionId} />;
    return <NotchConversationMenu target={target} handlers={conversationHandlers}
        testID={`desktop-activity-overlay-session-menu-${target.sessionId}`}
        trigger={menu => <DesktopActivityOverlaySessionRow {...row} liftKey={target.sessionId}
            onContextMenu={menu.onContextMenu} onKeyDown={menu.onKeyDown} />} />;
}

function renderCard(params: Readonly<{
    card: Exclude<DesktopActivityOverlayExpandedCard, { kind: 'multi_session_list' }>;
    visualMode: DesktopActivityOverlayVisualMode;
    onOpenSession: (sessionId: string, serverId?: string | null) => void;
    conversationHandlers?: NotchConversationHandlers;
    onAction?: DesktopActivityOverlayActionHandler;
    onDismissKey?: () => void;
    initialFocusTarget: DesktopActivityOverlayInitialFocusTarget | null;
    initialFocusRef?: DesktopActivityOverlayFocusTargetRef;
}>): React.ReactElement {
    const instanceTestID = resolveDesktopActivityOverlayCardInstanceTestID(params.card);
    const focusTarget = params.initialFocusTarget;
    const initialFocusActionId = focusTarget?.kind === 'card_action' && focusTarget.cardId === params.card.id
        ? focusTarget.actionId
        : null;
    const resolveRowFocusRef = (sessionId: string, serverId: string | null) => (
        focusTarget?.kind === 'session_row'
        && focusTarget.cardId === params.card.id
        && focusTarget.sessionId === sessionId
        && focusTarget.serverId === serverId
            ? params.initialFocusRef
            : undefined
    );
    const cardFocusProps = initialFocusActionId
        ? { initialFocusActionId, initialFocusRef: params.initialFocusRef }
        : {};

    switch (params.card.kind) {
        case 'idle_state':
            // One line that says what is true: no title band over it, and no finished-turn copy naming no Session.
            return wrapCard(
                params.card,
                <DesktopActivityOverlayCardFrame
                    testID={instanceTestID}
                    visualMode={params.visualMode}
                    title={params.card.title}
                />,
            );
        case 'permission_request':
            return wrapCard(
                params.card,
                <DesktopActivityOverlayPermissionRequestCard
                    card={params.card}
                    testID={instanceTestID}
                    visualMode={params.visualMode}
                    {...cardFocusProps}
                    onAction={params.onAction}
                />,
            );
        case 'user_question':
            return wrapCard(
                params.card,
                <DesktopActivityOverlayUserQuestionCard
                    card={params.card}
                    testID={instanceTestID}
                    visualMode={params.visualMode}
                    {...cardFocusProps}
                    onAction={params.onAction}
                    onDismissKey={params.onDismissKey}
                />,
            );
        case 'quota_summary':
            return wrapCard(
                params.card,
                <DesktopActivityOverlayQuotaSummaryCard
                    card={params.card}
                    testID={instanceTestID}
                    visualMode={params.visualMode}
                />,
            );
        case 'completion_state':
            return wrapCard(
                params.card,
                <DesktopActivityOverlayCompletionStateCard
                    card={params.card}
                    testID={instanceTestID}
                    visualMode={params.visualMode}
                    {...cardFocusProps}
                    onAction={params.onAction}
                />,
            );
        case 'session_overview': {
            const card = params.card;
            return wrapCard(
                card,
                <View testID={instanceTestID}>
                    <ConversationRow
                        target={card}
                        conversationHandlers={params.conversationHandlers}
                        testID={`desktop-activity-overlay-session-row-${card.sessionId}`}
                        visualMode={params.visualMode}
                        pressableRef={resolveRowFocusRef(card.sessionId, card.serverId)}
                        title={card.title}
                        subtitle={card.subtitle}
                        statusText={card.statusText ?? null}
                        previewText={card.previewText}
                        tone={card.tone}
                        agentId={card.agentId}
                        machineId={card.machineId}
                        botFace={card.botFace}
                        serverId={card.serverId}
                        onPress={() => params.onOpenSession(card.sessionId, card.serverId)}
                    />
                </View>,
            );
        }
        default: {
            const unsupportedCard = params.card as { kind?: unknown };
            throw new Error(`Unsupported desktop activity overlay card kind: ${String(unsupportedCard.kind)}`);
        }
    }
}

type RequestCard = Extract<DesktopActivityOverlayExpandedCard, { kind: 'permission_request' | 'user_question' }>;

function isRequestCard(card: DesktopActivityOverlayExpandedCard): card is RequestCard {
    return card.kind === 'permission_request' || card.kind === 'user_question';
}

export function DesktopActivityOverlayExpandedCards(props: Readonly<{
    model: Pick<DesktopActivityOverlayUiModel, 'expanded'>;
    visualMode: DesktopActivityOverlayVisualMode;
    onOpenSession: (sessionId: string, serverId?: string | null) => void;
    conversationHandlers?: NotchConversationHandlers;
    onAction?: DesktopActivityOverlayActionHandler;
    completionAutoDismissPaused?: boolean;
    initialFocusRef?: DesktopActivityOverlayFocusTargetRef;
    onDismissKey?: () => void;
    /**
     * The opened list's Bot section (N3 F8): every Show-Bots member first, each followed by its own
     * pending ask, then the Sessions that are not Bots. Absent, the list is Sessions only.
     */
    bots?: Readonly<{ faces: readonly BotFaceSnapshot[]; handlers: NotchConversationHandlers }> | null;
    /** The expanded panel owns the scroll viewport; a conversation renders its own few ask cards inline. */
    scroll?: Omit<VirtualizedListProps<ExpandedRow>, 'data' | 'renderItem' | 'keyExtractor'> & Readonly<{ maxHeight: number }>;
    /** How much of its trailing end the first row keeps clear for the panel's pin standing over it. */
    leadRowClearance?: number;
    /** The surface already names the asker (the pinned conversation's header): its asks stand without their row. */
    askerShown?: boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const botFaces = props.bots?.faces ?? NO_FACES;
    const firstBot = botFaces[0];
    const focusRequested = Boolean(props.initialFocusRef);
    const focusTarget = React.useMemo(() => focusRequested
        ? resolveDesktopActivityOverlayInitialFocusTarget(props.model, firstBot)
        : null, [firstBot, focusRequested, props.model]);
    const botKeys = React.useMemo(() => new Set(botFaces.map((face) => sessionRowKey(face.sessionId, face.serverId))), [botFaces]);
    const isBot = (sessionId: string, serverId: string | null) => botKeys.has(sessionRowKey(sessionId, serverId));
    const allCards = props.model.expanded.cards ?? [];
    const allRows = props.model.expanded.rows;
    // Every ask stands under the Session that asks it (lab ntdock-T: identity, then the ask well), so
    // two Sessions asking the same thing still read as two. A Bot's asks follow its Bot row; every other
    // Session's asks follow that Session's own row, and the Session is not listed again below.
    const askGroups: { key: string; sessionId: string; serverId: string | null; row: DesktopActivityOverlaySessionRowModel | null; cards: RequestCard[] }[] = [];
    for (const card of allCards) {
        if (!isRequestCard(card) || isBot(card.sessionId, card.serverId)) continue;
        const key = sessionRowKey(card.sessionId, card.serverId);
        const group = askGroups.find((candidate) => candidate.key === key);
        if (group) {
            group.cards.push(card);
            continue;
        }
        const row = card.session
            ?? allRows.find((candidate) => sessionRowKey(candidate.sessionId, candidate.serverId) === key)
            ?? null;
        askGroups.push({ key, sessionId: card.sessionId, serverId: card.serverId, row, cards: [card] });
    }
    const askKeys = new Set(askGroups.map((group) => group.key));
    const isListedAbove = (sessionId: string, serverId: string | null) => (
        isBot(sessionId, serverId) || askKeys.has(sessionRowKey(sessionId, serverId))
    );
    const cards = allCards.flatMap((card): DesktopActivityOverlayExpandedCard[] => {
        if (isRequestCard(card)) return [];
        if (card.kind === 'session_overview' && isListedAbove(card.sessionId, card.serverId)) return [];
        if (card.kind === 'multi_session_list') {
            const rows = card.rows.filter((row) => !isListedAbove(row.sessionId, row.serverId));
            return rows.length === 0 ? [] : [rows.length === card.rows.length ? card : { ...card, rows }];
        }
        return [card];
    });
    const [dismissedCompletionCardIds, setDismissedCompletionCardIds] = React.useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const presentCompletionCardIds = React.useMemo(() => new Set(
        cards
            .filter((card) => card.kind === 'completion_state')
            .map((card) => card.id),
    ), [cards]);
    const dismissCompletionCard = React.useCallback((cardId: string) => {
        setDismissedCompletionCardIds((previous) => {
            if (previous.has(cardId)) {
                return previous;
            }
            const next = new Set(previous);
            next.add(cardId);
            return next;
        });
    }, []);

    React.useEffect(() => {
        setDismissedCompletionCardIds((previous) => {
            if (previous.size === 0) {
                return previous;
            }
            const next = new Set<string>();
            for (const cardId of previous) {
                if (presentCompletionCardIds.has(cardId)) {
                    next.add(cardId);
                }
            }
            return next.size === previous.size ? previous : next;
        });
    }, [presentCompletionCardIds]);
    const remainingCards = cards.filter((card) => (
        card.kind !== 'completion_state' || !dismissedCompletionCardIds.has(card.id)
    ));
    // A finished turn's card leaves on its own; the island then shows the Sessions it already knows
    // rather than an empty panel.
    const sessionRows = allRows.filter((row) => !isListedAbove(row.sessionId, row.serverId));
    const listsAbove = botFaces.length > 0 || askGroups.length > 0;
    const visibleCards: DesktopActivityOverlayExpandedCard[] = remainingCards.length === 0 && cards.length > 0 && sessionRows.length > 0
        ? [{
            id: 'multi-session-list',
            kind: 'multi_session_list' as const,
            title: props.model.expanded.title,
            rows: sessionRows,
        }]
        : remainingCards;
    // Under Bots or asks, the list always continues with the remaining Sessions (lab ntdock-T).
    if (listsAbove && sessionRows.length > 0
        && !visibleCards.some((card) => card.kind === 'multi_session_list' || card.kind === 'session_overview')) {
        visibleCards.push({ id: 'multi-session-list', kind: 'multi_session_list', title: props.model.expanded.title, rows: sessionRows });
    }
    const render = (card: Exclude<DesktopActivityOverlayExpandedCard, { kind: 'multi_session_list' }>) => renderCard({
        card,
        visualMode: props.visualMode,
        onOpenSession: props.onOpenSession,
        conversationHandlers: props.conversationHandlers,
        onAction: props.onAction,
        initialFocusTarget: focusTarget,
        initialFocusRef: props.initialFocusRef,
        onDismissKey: props.onDismissKey,
    });
    const rowsByKey = new Map(allRows.map(row => [sessionRowKey(row.sessionId, row.serverId), row]));
    const botAsks = new Map<string, RequestCard[]>();
    for (const card of allCards) {
        if (!isRequestCard(card) || !isBot(card.sessionId, card.serverId)) continue;
        const key = sessionRowKey(card.sessionId, card.serverId);
        const asks = botAsks.get(key);
        if (asks) asks.push(card);
        else botAsks.set(key, [card]);
    }
    const isFocusedSession = (sessionId: string, serverId: string | null) => focusTarget?.kind === 'session_row'
        && focusTarget.sessionId === sessionId && focusTarget.serverId === serverId;
    const resolveRowFocusRef = (sessionId: string, serverId: string | null) => (
        isFocusedSession(sessionId, serverId) ? props.initialFocusRef : undefined
    );
    const sessionRow = (row: DesktopActivityOverlaySessionRowModel, asking?: number) => (
        <ConversationRow
            target={row}
            conversationHandlers={props.conversationHandlers}
            testID={`desktop-activity-overlay-session-row-${row.sessionId}`}
            visualMode={props.visualMode}
            pressableRef={resolveRowFocusRef(row.sessionId, row.serverId)}
            title={row.title} subtitle={row.subtitle} statusText={row.statusText} previewText={row.previewText}
            tone={row.tone} agentId={row.agentId} machineId={row.machineId} botFace={row.botFace} serverId={row.serverId}
            asking={asking ? { count: asking } : undefined}
            onPress={() => props.onOpenSession(row.sessionId, row.serverId)}
        />
    );
    // Descriptors hold every item in reading order; row elements are constructed only when the list asks for them.
    const rows: ExpandedRow[] = [];
    let previousEndsOnAsk = false;
    const add = (key: string, render: () => React.ReactNode, endsOnAsk: boolean, continues = false, focus = false) => {
        rows.push({ key, render, gap: rows.length === 0 ? 0 : continues ? theme.space.s2 : theme.space.s10,
            separator: previousEndsOnAsk, focus });
        previousEndsOnAsk = endsOnAsk;
    };
    const containsFocusCard = (cards: readonly DesktopActivityOverlayExpandedCard[]) => focusTarget?.kind === 'card_action'
        && cards.some(card => card.id === focusTarget.cardId);
    if (props.bots) for (const [index, face] of botFaces.entries()) {
        const key = sessionRowKey(face.sessionId, face.serverId);
        const asks = botAsks.get(key) ?? [];
        add(`bot:${key}`, () => (
            <View testID={index === 0 ? 'desktop-activity-overlay-bots-section' : undefined} style={styles.rows}>
                <DesktopActivityOverlayBotRow face={face} handlers={props.bots!.handlers}
                    pressableRef={resolveRowFocusRef(face.sessionId, face.serverId)} askCount={asks.length}
                    askContext={asks.length > 0 ? rowsByKey.get(key)?.subtitle ?? null : null} />
                {asks.length > 0 ? <View style={styles.asks}>{asks.map(render)}</View> : null}
            </View>
        ), asks.length > 0, index > 0, isFocusedSession(face.sessionId, face.serverId) || containsFocusCard(asks));
    }
    for (const group of askGroups) {
        add(`asks:${group.key}`, () => (
            <View testID={`desktop-activity-overlay-ask-group-${group.sessionId}`} style={styles.rows}>
                {group.row && !props.askerShown ? sessionRow(group.row, group.cards.length) : null}
                <View style={props.askerShown ? styles.asksOnly : styles.asks}>{group.cards.map(render)}</View>
            </View>
        ), true, false, isFocusedSession(group.sessionId, group.serverId) || containsFocusCard(group.cards));
    }
    for (const card of visibleCards) {
        if (card.kind === 'multi_session_list') {
            for (const [index, row] of card.rows.entries()) add(buildSessionRowKey(row.sessionId, row.serverId),
                () => <View testID={index === 0 ? resolveDesktopActivityOverlayCardKindTestID(card.kind) : undefined}>
                    <View testID={index === 0 ? resolveDesktopActivityOverlayCardInstanceTestID(card) : undefined}>{sessionRow(row)}</View>
                </View>, false, index > 0, isFocusedSession(row.sessionId, row.serverId));
        } else add(`card:${card.id}`, () => render(card), false, false,
            containsFocusCard([card]) || card.kind === 'session_overview' && isFocusedSession(card.sessionId, card.serverId));
    }
    const leadClearance = props.leadRowClearance ?? 0;
    const drawRow = (row: ExpandedRow) => <View style={{ paddingTop: row.gap }}>
        {row.separator ? <View style={[styles.separator, { marginBottom: row.gap }]} /> : null}
        {leadClearance > 0 && row.key === rows[0]?.key ? (
            <DesktopActivityOverlayLeadRowClearance.Provider value={leadClearance}>{row.render()}</DesktopActivityOverlayLeadRowClearance.Provider>
        ) : row.render()}
    </View>;
    return <DesktopActivityOverlayCardActionStateProvider cards={allCards}>
        {/* Completion lifetime belongs to this inventory, including cards currently outside the viewport. */}
        {cards.map(card => card.kind === 'completion_state' && !dismissedCompletionCardIds.has(card.id)
            ? <DesktopActivityOverlayAutoDismissCompletionCard key={card.id} card={card}
                paused={props.completionAutoDismissPaused === true} onDismiss={dismissCompletionCard} /> : null)}
        {props.scroll ? <ExpandedCardList rows={rows} drawRow={drawRow} scroll={props.scroll}
            focusRequested={focusRequested} />
            : <View>{rows.map(row => <React.Fragment key={row.key}>{drawRow(row)}</React.Fragment>)}</View>}
    </DesktopActivityOverlayCardActionStateProvider>;
}

type ExpandedRow = Readonly<{
    key: string;
    render: () => React.ReactNode;
    gap: number;
    separator: boolean;
    focus: boolean;
}>;

function ExpandedCardList(props: Readonly<{
    rows: readonly ExpandedRow[];
    drawRow: (row: ExpandedRow) => React.ReactElement;
    scroll: NonNullable<React.ComponentProps<typeof DesktopActivityOverlayExpandedCards>['scroll']>;
    focusRequested: boolean;
}>) {
    const [contentHeight, setContentHeight] = React.useState<number | null>(null);
    const { maxHeight, onContentSizeChange, style, ...scroll } = props.scroll;
    const handleContentSizeChange = React.useCallback((width: number, height: number) => {
        setContentHeight(height);
        onContentSizeChange?.(width, height);
    }, [onContentSizeChange]);
    const initialIndex = props.focusRequested ? props.rows.findIndex(row => row.focus) : -1;
    return <VirtualizedList {...scroll} data={props.rows} keyExtractor={row => row.key}
        renderItem={({ item }) => props.drawRow(item)} estimatedItemSize={PAGE_LIST_METRICS.rowMinHeightPx}
        initialScrollIndex={initialIndex > 0 ? initialIndex : undefined}
        onContentSizeChange={handleContentSizeChange}
        style={[style, { flexGrow: 0, flexShrink: 1, minHeight: 0,
            height: Math.min(maxHeight, contentHeight ?? props.rows.length * PAGE_LIST_METRICS.rowMinHeightPx) }]} />;
}

const styles = StyleSheet.create((theme) => ({
    rows: {
        gap: theme.space.s2,
    },
    // An ask well sits a step below its identity row and a step above whatever follows.
    asks: {
        gap: theme.space.s8,
        marginTop: theme.space.s4,
        marginBottom: theme.space.s6,
    },
    // Under a header that already names the asker, the asks keep only their own rhythm.
    asksOnly: {
        gap: theme.space.s8,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        marginHorizontal: theme.space.s4,
        backgroundColor: theme.colors.border.default,
    },
}));
