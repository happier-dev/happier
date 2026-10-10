import * as React from 'react';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/**
 * Per-block overflow actions.
 *
 * Move up/down/in/out always appear here, so reordering never depends on a drag
 * gesture and stays reachable by keyboard and screen reader. Actions that cannot
 * make progress are omitted rather than shown inert.
 */

export type WorkflowBlockAction = Readonly<{
    id: 'duplicate' | 'addBranch' | 'addOtherwise' | 'moveUp' | 'moveDown' | 'moveIn' | 'moveOut' | 'remove';
    label: string;
    destructive?: boolean;
    onSelect: () => void;
}>;

export function WorkflowBlockActionsMenu(props: Readonly<{
    blockLabel: string;
    actions: readonly WorkflowBlockAction[];
    /**
     * `more` (default): the block's `⋯`. `caret`: a small caret beside a label it belongs to (a lane's
     * name), so a lane's menu never stacks a second `⋯` above its first step's (DESIGN-5 N10).
     */
    trigger?: 'more' | 'caret';
    testID?: string;
}>): React.ReactElement | null {
    const [open, setOpen] = React.useState(false);

    if (props.actions.length === 0) return null;

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={props.actions.map((action) => ({
                id: action.id,
                title: action.label,
                destructive: action.destructive,
                testID: props.testID === undefined ? undefined : `${props.testID}-${action.id}`,
            }))}
            onSelect={(id) => props.actions.find((action) => action.id === id)?.onSelect()}
            placement="auto"
            matchTriggerWidth={false}
            trigger={({ open, toggle }) => <IconButton
                testID={props.testID}
                iconName={props.trigger === 'caret' ? 'caret-down' : 'dots-three'}
                iconSize={props.trigger === 'caret' ? ICON_SIZE.xs : 18}
                variant="plain"
                accessibilityRole="button"
                // This is the block's overflow menu, not Add. Announcing "Add a
                // block to this workflow" told every screen-reader user the
                // wrong thing about what pressing it does.
                accessibilityLabel={t('common.moreActions')}
                accessibilityHint={props.blockLabel}
                onPress={toggle}
                expanded={open}
                hasPopup="menu"
            />}
        />
    );
}
