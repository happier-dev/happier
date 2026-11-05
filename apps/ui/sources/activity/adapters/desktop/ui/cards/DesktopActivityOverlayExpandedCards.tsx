import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { t } from '@/text';
import { activityInstanceKey, normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';

import type {
    DesktopActivityOverlayFocusTargetRef,
    DesktopActivityOverlayInitialFocusTarget,
} from '../resolveDesktopActivityOverlayInitialFocusTarget';
import type { DesktopActivityOverlayVisualModeForTestID as DesktopActivityOverlayVisualMode } from '../shared/desktopActivityOverlaySelectors';
import { DesktopActivityOverlaySessionRow } from '../DesktopActivityOverlaySessionRow';
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
import { DesktopActivityOverlayCardFrame } from './DesktopActivityOverlayCardFrame';
import { DesktopActivityOverlayCompletionStateCard } from './DesktopActivityOverlayCompletionStateCard';
import { DesktopActivityOverlayPermissionRequestCard } from './DesktopActivityOverlayPermissionRequestCard';
import { DesktopActivityOverlayQuotaSummaryCard } from './DesktopActivityOverlayQuotaSummaryCard';
import { DesktopActivityOverlayUserQuestionCard } from './DesktopActivityOverlayUserQuestionCard';
import type { BotFaceSnapshot } from '../../presentation/notchBotTypes';
import { DesktopActivityOverlayBotRow, type NotchBotHandlers } from '../faces/DesktopActivityOverlayFaces';

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

function renderCard(params: Readonly<{
    card: DesktopActivityOverlayExpandedCard;
    visualMode: DesktopActivityOverlayVisualMode;
    onOpenSession: (sessionId: string, serverId?: string | null) => void;
    onAction?: DesktopActivityOverlayActionHandler;
    completionAutoDismissPaused: boolean;
    onDismissCompletionCard: (cardId: string) => void;
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
            return wrapCard(
                params.card,
                <DesktopActivityOverlayCardFrame
                    testID={instanceTestID}
                    visualMode={params.visualMode}
                    title={params.card.title}
                    body={t('notifications.activity.readyFallbackBody')}
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
                <DesktopActivityOverlayAutoDismissCompletionCard
                    card={params.card}
                    paused={params.completionAutoDismissPaused}
                    onDismiss={params.onDismissCompletionCard}
                >
                    <DesktopActivityOverlayCompletionStateCard
                        card={params.card}
                        testID={instanceTestID}
                        visualMode={params.visualMode}
                        {...cardFocusProps}
                        onAction={params.onAction}
                    />
                </DesktopActivityOverlayAutoDismissCompletionCard>,
            );
        case 'session_overview': {
            const card = params.card;
            return wrapCard(
                card,
                <View testID={instanceTestID}>
                    <DesktopActivityOverlaySessionRow
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
        case 'multi_session_list':
            const rows = params.card.rows;
            return wrapCard(
                params.card,
                <View testID={instanceTestID}>
                    <View style={styles.rows}>
                        {rows.map((row) => (
                            <DesktopActivityOverlaySessionRow
                                key={buildSessionRowKey(row.sessionId, row.serverId)}
                                pressableRef={resolveRowFocusRef(row.sessionId, row.serverId)}
                                testID={`desktop-activity-overlay-session-row-${row.sessionId}`}
                                visualMode={params.visualMode}
                                title={row.title}
                                subtitle={row.subtitle}
                                statusText={row.statusText}
                                previewText={row.previewText}
                                tone={row.tone}
                                agentId={row.agentId}
                                machineId={row.machineId}
                                botFace={row.botFace}
                                serverId={row.serverId}
                                onPress={() => params.onOpenSession(row.sessionId, row.serverId)}
                            />
                        ))}
                    </View>
                </View>,
            );
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
    onAction?: DesktopActivityOverlayActionHandler;
    completionAutoDismissPaused?: boolean;
    initialFocusTarget?: DesktopActivityOverlayInitialFocusTarget | null;
    initialFocusRef?: DesktopActivityOverlayFocusTargetRef;
    onDismissKey?: () => void;
    /**
     * The opened list's Bot section (N3 F8): every Show-Bots member first, each followed by its own
     * pending ask, then the Sessions that are not Bots. Absent, the list is Sessions only.
     */
    bots?: Readonly<{ faces: readonly BotFaceSnapshot[]; handlers: NotchBotHandlers }> | null;
}>): React.ReactElement {
    const botFaces = props.bots?.faces ?? NO_FACES;
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
    const render = (card: DesktopActivityOverlayExpandedCard) => renderCard({
        card,
        visualMode: props.visualMode,
        onOpenSession: props.onOpenSession,
        onAction: props.onAction,
        completionAutoDismissPaused: props.completionAutoDismissPaused === true,
        onDismissCompletionCard: dismissCompletionCard,
        initialFocusTarget: props.initialFocusTarget ?? null,
        initialFocusRef: props.initialFocusRef,
        onDismissKey: props.onDismissKey,
    });
    // A Bot that asks says where it runs: its Session's context line.
    const contextOf = (sessionId: string, serverId: string | null) => allRows
        .find((row) => sessionRowKey(row.sessionId, row.serverId) === sessionRowKey(sessionId, serverId))?.subtitle ?? null;
    const resolveRowFocusRef = (sessionId: string, serverId: string | null) => {
        const focusTarget = props.initialFocusTarget;
        return focusTarget?.kind === 'session_row' && focusTarget.sessionId === sessionId && focusTarget.serverId === serverId
            ? props.initialFocusRef
            : undefined;
    };
    // Each block says whether it ends on an ask; one hairline then closes it (lab `.nt-sep`).
    const blocks: { node: React.ReactNode; endsOnAsk: boolean }[] = [];
    if (props.bots && botFaces.length > 0) {
        const lastFace = botFaces[botFaces.length - 1];
        const asksOf = (face: BotFaceSnapshot) => allCards.filter((card): card is RequestCard => isRequestCard(card)
            && card.sessionId === face.sessionId && card.serverId === face.serverId);
        blocks.push({
            endsOnAsk: asksOf(lastFace).length > 0,
            node: (
                <View key="bots" testID="desktop-activity-overlay-bots-section" style={styles.rows}>
                    {botFaces.map((face) => {
                        const key = sessionRowKey(face.sessionId, face.serverId);
                        const asks = asksOf(face);
                        return (
                            <React.Fragment key={key}>
                                <DesktopActivityOverlayBotRow
                                    face={face}
                                    handlers={props.bots!.handlers}
                                    askCount={asks.length}
                                    askContext={asks.length > 0 ? contextOf(face.sessionId, face.serverId) : null}
                                />
                                {asks.length > 0 ? <View style={styles.asks}>{asks.map(render)}</View> : null}
                                {asks.length > 0 && face !== lastFace ? <View style={styles.separator} /> : null}
                            </React.Fragment>
                        );
                    })}
                </View>
            ),
        });
    }
    for (const group of askGroups) {
        blocks.push({ endsOnAsk: true, node: (
            <View key={`asks:${group.key}`} testID={`desktop-activity-overlay-ask-group-${group.sessionId}`} style={styles.rows}>
                {group.row ? (
                    <DesktopActivityOverlaySessionRow
                        testID={`desktop-activity-overlay-session-row-${group.sessionId}`}
                        visualMode={props.visualMode}
                        pressableRef={resolveRowFocusRef(group.sessionId, group.serverId)}
                        title={group.row.title}
                        subtitle={group.row.subtitle}
                        statusText={group.row.statusText}
                        previewText={group.row.previewText}
                        tone={group.row.tone}
                        agentId={group.row.agentId}
                        machineId={group.row.machineId}
                        botFace={group.row.botFace}
                        serverId={group.row.serverId}
                        asking={{ count: group.cards.length }}
                        onPress={() => props.onOpenSession(group.sessionId, group.serverId)}
                    />
                ) : null}
                <View style={styles.asks}>{group.cards.map(render)}</View>
            </View>
        ) });
    }
    for (const card of visibleCards) blocks.push({ endsOnAsk: false, node: render(card) });

    return (
        <View style={styles.cards}>
            {blocks.map((block, index) => (
                <React.Fragment key={index}>
                    {index > 0 && blocks[index - 1].endsOnAsk ? <View style={styles.separator} /> : null}
                    {block.node}
                </React.Fragment>
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    cards: {
        gap: theme.space.s10,
    },
    rows: {
        gap: theme.space.s2,
    },
    // An ask well sits a step below its identity row and a step above whatever follows.
    asks: {
        gap: theme.space.s8,
        marginTop: theme.space.s4,
        marginBottom: theme.space.s6,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        marginHorizontal: theme.space.s4,
        backgroundColor: theme.colors.border.default,
    },
}));
