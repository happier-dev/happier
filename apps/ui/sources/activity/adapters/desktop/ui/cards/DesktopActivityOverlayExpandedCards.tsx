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
import { DesktopActivityOverlayCardActions } from './DesktopActivityOverlayCardActions';
import { DesktopActivityOverlayCardFrame } from './DesktopActivityOverlayCardFrame';

function resolveCardActions(card: DesktopActivityOverlayExpandedCard): readonly DesktopActivityOverlayActionDescriptor[] {
    const canonicalActions = (card.actions ?? []).filter(
        (action) => action.id !== 'open'
            && !action.id.startsWith('open:')
            && ('openActionIdentifier' in card ? action.actionIdentifier !== card.openActionIdentifier : true),
    );
    if (canonicalActions.length > 0) {
        return canonicalActions;
    }

    switch (card.kind) {
        case 'permission_request':
            return [
                ...(card.denyActionIdentifier ? [{
                    id: 'deny',
                    label: t('notifications.actions.deny'),
                    actionIdentifier: card.denyActionIdentifier,
                    data: { requestId: card.requestId, sessionId: card.sessionId },
                    tone: 'danger' as const,
                }] : []),
                ...(card.allowActionIdentifier ? [{
                    id: 'allow',
                    label: t('notifications.actions.allow'),
                    actionIdentifier: card.allowActionIdentifier,
                    data: { requestId: card.requestId, sessionId: card.sessionId },
                    tone: 'primary' as const,
                }] : []),
            ];
        case 'user_question': {
            return [
                ...(card.denyActionIdentifier ? [{
                    id: 'deny',
                    label: t('notifications.actions.deny'),
                    actionIdentifier: card.denyActionIdentifier,
                    data: { requestId: card.requestId, sessionId: card.sessionId },
                    tone: 'danger' as const,
                }] : []),
                ...(card.allowActionIdentifier ? [{
                    id: 'allow',
                    label: t('notifications.actions.allow'),
                    actionIdentifier: card.allowActionIdentifier,
                    data: { requestId: card.requestId, sessionId: card.sessionId },
                    tone: 'primary' as const,
                }] : []),
            ];
        }
        case 'session_overview':
            return [];
        default:
            return [];
    }
}

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

function renderCard(params: Readonly<{
    card: DesktopActivityOverlayExpandedCard;
    visualMode: DesktopActivityOverlayVisualMode;
    onOpenSession: (sessionId: string) => void;
    onAction?: (action: DesktopActivityOverlayActionDescriptor) => void;
}>): React.ReactElement {
    const actions = resolveCardActions(params.card);
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
                <DesktopActivityOverlayCardFrame
                    testID={instanceTestID}
                    visualMode={params.visualMode}
                    eyebrow={params.card.toolLabel}
                    title={params.card.title}
                    body={params.card.summary ?? params.card.questionText}
                    badgeText={params.card.count > 1 ? String(params.card.count) : null}
                >
                    <DesktopActivityOverlayCardActions
                        cardId={params.card.requestId}
                        visualMode={params.visualMode}
                        actions={actions}
                        onAction={params.onAction}
                    />
                </DesktopActivityOverlayCardFrame>,
            );
        case 'user_question':
            return wrapCard(
                params.card,
                <DesktopActivityOverlayCardFrame
                    testID={instanceTestID}
                    visualMode={params.visualMode}
                    eyebrow={params.card.toolLabel}
                    title={params.card.title}
                    body={params.card.questionText ?? params.card.summary}
                    badgeText={params.card.count > 1 ? String(params.card.count) : null}
                >
                    <DesktopActivityOverlayCardActions
                        cardId={params.card.requestId}
                        visualMode={params.visualMode}
                        actions={actions}
                        onAction={params.onAction}
                    />
                </DesktopActivityOverlayCardFrame>,
            );
        case 'quota_summary':
            return wrapCard(
                params.card,
                <DesktopActivityOverlayCardFrame
                    testID={instanceTestID}
                    visualMode={params.visualMode}
                    eyebrow={t('usage.activity')}
                    title={params.card.title}
                    body={params.card.summary}
                />,
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
                        onPress={() => params.onOpenSession(card.sessionId)}
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
                                onPress={() => params.onOpenSession(row.sessionId)}
                            />
                        ))}
                    </View>
                </View>,
            );
    }

    throw new Error(`Unsupported desktop activity overlay card kind: ${String(params.card.kind)}`);
}

export function DesktopActivityOverlayExpandedCards(props: Readonly<{
    model: DesktopActivityOverlayUiModel;
    visualMode: DesktopActivityOverlayVisualMode;
    onOpenSession: (sessionId: string) => void;
    onAction?: (action: DesktopActivityOverlayActionDescriptor) => void;
}>): React.ReactElement {
    const cards = React.useDeferredValue(props.model.expanded.cards ?? []);

    return (
        <View style={styles.cards}>
            {cards.map((card) => renderCard({
                card,
                visualMode: props.visualMode,
                onOpenSession: props.onOpenSession,
                onAction: props.onAction,
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
