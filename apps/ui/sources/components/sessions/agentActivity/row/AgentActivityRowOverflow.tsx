import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { IconAction } from '@/components/ui/buttons/IconAction';
import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/Icon';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Modal } from '@/modal';
import { t } from '@/text';

import type { AgentActivityRowActionId } from '../agentActivityRowEntry';

/**
 * The row's only action affordance.
 *
 * It replaces four always-visible 30x30 icon buttons — under the 44pt floor, and loud enough that
 * four rows of them outweighed the content they belonged to. One menu, one target, and the target
 * only exists when there is something in it: an empty `actions` list renders nothing rather than an
 * ellipsis that opens an empty sheet.
 *
 * Confirmation for the destructive action lives here, not in the host. A host that forgets it ships
 * a one-tap irreversible delete, and there were three prospective hosts.
 */

const ACTION_ICONS = {
    open_full: 'arrow-square-out',
    open_advanced: 'sliders-horizontal',
    send: 'paper-plane-tilt',
    stop: 'stop',
    delete: 'trash',
    delete_team: 'users',
} as const satisfies Record<AgentActivityRowActionId, IconName>;

const ACTION_LABEL_KEYS = {
    open_full: 'session.agentActivity.action.openFull',
    open_advanced: 'session.agentActivity.action.openAdvanced',
    send: 'session.agentActivity.action.send',
    stop: 'session.agentActivity.action.stop',
    delete: 'session.agentActivity.action.delete',
    delete_team: 'session.agentActivity.action.deleteTeam',
} as const satisfies Record<AgentActivityRowActionId, string>;

/**
 * Danger styling, and — for the two irreversible actions only — a confirmation.
 *
 * Stopping a run is the user's own stop and is recoverable by launching again, so it confirms
 * nothing; deleting is not, so it always does. Sharing one style between a constructive and a
 * destructive action is defect A10.
 */
const DESTRUCTIVE_ACTIONS: ReadonlySet<AgentActivityRowActionId> = new Set([
    'stop',
    'delete',
    'delete_team',
]);

/**
 * Confirmation copy per action, because the two destructive actions destroy different things.
 *
 * Deleting a teammate names the row; deleting a team cannot, since the row is one member of it —
 * so its message states the blast radius instead of a name. One confirmation owner, two truths, and
 * no action can acquire a confirmation without copy that says what it removes.
 */
type AgentActivityConfirmation = Readonly<{
    title: string;
    message: string;
    confirmText: string;
}>;

function resolveConfirmation(
    actionId: AgentActivityRowActionId,
    rowTitle: string,
): AgentActivityConfirmation | null {
    if (actionId === 'delete') {
        return {
            title: t('session.agentActivity.action.deleteConfirmTitle'),
            message: t('session.agentActivity.action.deleteConfirmMessage', { title: rowTitle }),
            confirmText: t('session.agentActivity.action.deleteConfirmAction'),
        };
    }
    if (actionId === 'delete_team') {
        return {
            title: t('session.agentActivity.action.deleteTeamConfirmTitle'),
            message: t('session.agentActivity.action.deleteTeamConfirmMessage'),
            confirmText: t('session.agentActivity.action.deleteTeamConfirmAction'),
        };
    }
    return null;
}

/** 28pt box + 8pt slop = the 44pt touch target, without a 44pt glyph. */
const OVERFLOW_HIT_SLOP = 8;
const OVERFLOW_GLYPH_PX = 18;

export type AgentActivityRowOverflowProps = Readonly<{
    entryId: string;
    /** The row title, used as the menu heading and in the delete confirmation. */
    title: string;
    actions: readonly AgentActivityRowActionId[];
    onAction: (entryId: string, actionId: AgentActivityRowActionId) => void;
    testID?: string;
}>;

export const AgentActivityRowOverflow = React.memo((props: AgentActivityRowOverflowProps) => {
    const { theme } = useUnistyles();
    const { entryId, onAction, title } = props;

    const runAction = React.useCallback((actionId: AgentActivityRowActionId) => {
        const confirmation = resolveConfirmation(actionId, title);
        if (!confirmation) {
            onAction(entryId, actionId);
            return;
        }
        void (async () => {
            const confirmed = await Modal.confirm(confirmation.title, confirmation.message, {
                confirmText: confirmation.confirmText,
                destructive: true,
            });
            if (confirmed) onAction(entryId, actionId);
        })();
    }, [entryId, onAction, title]);

    const actions = React.useMemo((): ItemAction[] => props.actions.map((actionId) => ({
        id: actionId,
        title: t(ACTION_LABEL_KEYS[actionId]),
        icon: ACTION_ICONS[actionId],
        destructive: DESTRUCTIVE_ACTIONS.has(actionId),
        onPress: () => runAction(actionId),
    })), [props.actions, runAction]);

    if (actions.length === 0) return null;

    return (
        <ItemRowActions
            title={title}
            actions={actions}
            // Always a menu, never inline icons: this row's actions include a destructive one, and
            // a wide window is not a reason to put it a stray tap away from the row press.
            compactThreshold={Number.POSITIVE_INFINITY}
            compactActionIds={[]}
            overflowTriggerTestID={props.testID}
            renderOverflowTrigger={({ toggle, testID, accessibilityLabel }) => (
                <IconAction
                    testID={testID}
                    size="sm"
                    hitSlop={OVERFLOW_HIT_SLOP}
                    accessibilityLabel={accessibilityLabel}
                    onPress={(event) => {
                        event?.stopPropagation?.();
                        toggle();
                    }}
                >
                    <Icon
                        name="dots-three"
                        size={OVERFLOW_GLYPH_PX}
                        color={theme.colors.text.secondary}
                    />
                </IconAction>
            )}
        />
    );
});

AgentActivityRowOverflow.displayName = 'AgentActivityRowOverflow';
