import type * as React from 'react';
import type { View } from 'react-native';

import {
    resolveDesktopActivityOverlayCompletionStateActions,
    resolveDesktopActivityOverlayRequestCardActions,
} from './cards/resolveDesktopActivityOverlayCardActions';
import type { DesktopActivityOverlayUiModel } from './shared/desktopActivityOverlayUiModel';

/**
 * The single ref the route points at whichever control it resolved. `View` is the shared instance
 * type: `Pressable` forwards a `View`, and the app `TextInput` forwards its host node; both expose
 * React Native's `focus()`.
 */
export type DesktopActivityOverlayFocusTargetRef = React.Ref<View>;

/**
 * Where keyboard focus lands when the island is expanded from the keyboard.
 *
 * `surface` is the truthful answer for a model with nothing to act on: the shell is programmatically
 * focusable (`tabIndex={-1}`, never a tab stop) so Escape still reaches its owner instead of the
 * document body.
 */
export type DesktopActivityOverlayInitialFocusTarget =
    | Readonly<{ kind: 'card_action'; cardId: string; actionId: string }>
    | Readonly<{ kind: 'session_row'; cardId: string; sessionId: string; serverId: string | null }>
    | Readonly<{ kind: 'surface' }>;

/**
 * Resolves the first meaningful action in rendered reading order. Card actions come from the same
 * canonical resolvers the cards render, so a card whose actions collapse to nothing is skipped
 * rather than focused.
 */
export function resolveDesktopActivityOverlayInitialFocusTarget(
    model: Pick<DesktopActivityOverlayUiModel, 'expanded'>,
): DesktopActivityOverlayInitialFocusTarget {
    for (const card of model.expanded.cards ?? []) {
        switch (card.kind) {
            case 'permission_request':
            case 'user_question': {
                const actionId = resolveDesktopActivityOverlayRequestCardActions(card)[0]?.id;
                if (actionId) {
                    return { kind: 'card_action', cardId: card.id, actionId };
                }
                break;
            }
            case 'completion_state': {
                const actionId = resolveDesktopActivityOverlayCompletionStateActions(card)[0]?.id;
                if (actionId) {
                    return { kind: 'card_action', cardId: card.id, actionId };
                }
                break;
            }
            case 'session_overview':
                return {
                    kind: 'session_row',
                    cardId: card.id,
                    sessionId: card.sessionId,
                    serverId: card.serverId,
                };
            case 'multi_session_list': {
                const firstRow = card.rows[0];
                if (firstRow) {
                    return {
                        kind: 'session_row',
                        cardId: card.id,
                        sessionId: firstRow.sessionId,
                        serverId: firstRow.serverId,
                    };
                }
                break;
            }
            default:
                // `idle_state` and `quota_summary` render copy only.
                break;
        }
    }

    return { kind: 'surface' };
}
