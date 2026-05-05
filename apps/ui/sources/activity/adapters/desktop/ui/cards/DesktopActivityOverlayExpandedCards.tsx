import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { t } from '@/text';

import type { DesktopActivityOverlayVisualMode } from '../DesktopActivityOverlayVisualMode';
import { DesktopActivityOverlaySessionRow } from '../DesktopActivityOverlaySessionRow';
import type {
    DesktopActivityOverlayActionDescriptor,
    DesktopActivityOverlayExpandedCard,
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

function wrapCard(
    card: DesktopActivityOverlayExpandedCard,
    child: React.ReactElement,
): React.ReactElement {
    return (
        <View key={resolveDesktopActivityOverlayCardInstanceTestID(card)} testID={resolveDesktopActivityOverlayCardKindTestID(card.kind)}>
            {child}
        </View>
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
    onAction?: (action: DesktopActivityOverlayActionDescriptor) => void;
    completionAutoDismissPaused: boolean;
    onDismissCompletionCard: (cardId: string) => void;
}>): React.ReactElement {
    const instanceTestID = resolveDesktopActivityOverlayCardInstanceTestID(params.card);

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
                    onAction={params.onAction}
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
                        onAction={params.onAction}
                    />
                </DesktopActivityOverlayAutoDismissCompletionCard>,
            );
        case 'session_overview': {
            const card = params.card;
            return wrapCard(
                card,
                <View testID={instanceTestID} style={styles.sessionRowShell}>
                    <DesktopActivityOverlaySessionRow
                        isLast
                        testID={`desktop-activity-overlay-session-row-${card.sessionId}`}
                        visualMode={params.visualMode}
                        title={card.title}
                        subtitle={card.subtitle}
                        statusText={card.statusText ?? null}
                        previewText={card.previewText}
                        onPress={() => params.onOpenSession(card.sessionId, card.serverId)}
                    />
                </View>,
            );
        }
        case 'multi_session_list':
            const rows = params.card.rows;
            return wrapCard(
                params.card,
                <View testID={instanceTestID} style={styles.sessionRowsShell}>
                    <View style={styles.rows}>
                        {rows.map((row, rowIndex) => (
                            <DesktopActivityOverlaySessionRow
                                key={row.sessionId}
                                isLast={rowIndex === rows.length - 1}
                                testID={`desktop-activity-overlay-session-row-${row.sessionId}`}
                                visualMode={params.visualMode}
                                title={row.title}
                                subtitle={row.subtitle}
                                statusText={row.statusText}
                                previewText={row.previewText}
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

export function DesktopActivityOverlayExpandedCards(props: Readonly<{
    model: DesktopActivityOverlayUiModel;
    visualMode: DesktopActivityOverlayVisualMode;
    onOpenSession: (sessionId: string, serverId?: string | null) => void;
    onAction?: (action: DesktopActivityOverlayActionDescriptor) => void;
    completionAutoDismissPaused?: boolean;
}>): React.ReactElement {
    const cards = props.model.expanded.cards ?? [];
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
    const visibleCards = cards.filter((card) => (
        card.kind !== 'completion_state' || !dismissedCompletionCardIds.has(card.id)
    ));

    return (
        <View style={styles.cards}>
            {visibleCards.map((card) => renderCard({
                card,
                visualMode: props.visualMode,
                onOpenSession: props.onOpenSession,
                onAction: props.onAction,
                completionAutoDismissPaused: props.completionAutoDismissPaused === true,
                onDismissCompletionCard: dismissCompletionCard,
            }))}
        </View>
    );
}

const styles = StyleSheet.create({
    cards: {
        gap: 6,
    },
    sessionRowShell: {
        paddingHorizontal: 2,
        paddingVertical: 2,
    },
    sessionRowsShell: {
        paddingHorizontal: 2,
        paddingVertical: 2,
    },
    rows: {
        gap: 0,
    },
});
