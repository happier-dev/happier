import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_ICON_BUTTON_SIZE } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
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
    /**
     * A summary row nobody has reached yet (PERF-WF3B): the `⋯` is drawn where its button sits, without
     * the button or its menu. The row mounts the real menu as a pointer or focus reaches it, so
     * keyboard and screen-reader users meet the real button; a press that lands on the mark anyway
     * (a pen without hover, an assistive click) opens the menu the same way.
     */
    resting?: boolean;
    testID?: string;
}>): React.ReactElement | null {
    // Once pressed, this row keeps its real menu so focus has a trigger to return to.
    const [pressedWhileResting, setPressedWhileResting] = React.useState(false);
    if (props.actions.length === 0) return null;
    if (props.resting === true && props.trigger !== 'caret' && !pressedWhileResting) {
        return <WorkflowBlockActionsMark testID={props.testID} onPress={() => setPressedWhileResting(true)} />;
    }
    return <WorkflowBlockActionsDropdown {...props} initiallyOpen={pressedWhileResting} />;
}

/**
 * The resting `⋯`: the plain IconButton's square and glyph. It is not a stop for focus or assistive
 * technology (the reached row's real button is); a press on it opens the menu.
 */
function WorkflowBlockActionsMark(props: Readonly<{ testID?: string; onPress: () => void }>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <Pressable
            testID={props.testID}
            accessible={false}
            focusable={false}
            tabIndex={-1}
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={props.onPress}
            style={{ width: HAPPIER_ICON_BUTTON_SIZE, height: HAPPIER_ICON_BUTTON_SIZE, alignItems: 'center', justifyContent: 'center' }}
        >
            <Icon name="dots-three" size={MORE_GLYPH_SIZE} color={theme.colors.button.secondary.tint} />
        </Pressable>
    );
}

const MORE_GLYPH_SIZE = 18;

function WorkflowBlockActionsDropdown(props: Readonly<{
    blockLabel: string;
    actions: readonly WorkflowBlockAction[];
    trigger?: 'more' | 'caret';
    testID?: string;
    initiallyOpen: boolean;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(props.initiallyOpen);

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
                iconSize={props.trigger === 'caret' ? ICON_SIZE.xs : MORE_GLYPH_SIZE}
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
