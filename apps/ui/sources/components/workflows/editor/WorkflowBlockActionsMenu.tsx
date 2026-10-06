import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Popover } from '@/components/ui/popover/Popover';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS } from '@/components/ui/popover/modalAwareFloatingPopoverPortalOptions';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { workflowEditorStyles } from './workflowEditorStyles';

/**
 * Per-block overflow actions.
 *
 * Move up/down/in/out always appear here, so reordering never depends on a drag
 * gesture and stays reachable by keyboard and screen reader. Actions that cannot
 * make progress are omitted rather than shown inert.
 */

export type WorkflowBlockAction = Readonly<{
    id: 'duplicate' | 'moveUp' | 'moveDown' | 'moveIn' | 'moveOut' | 'remove';
    label: string;
    destructive?: boolean;
    onSelect: () => void;
}>;

export function WorkflowBlockActionsMenu(props: Readonly<{
    blockLabel: string;
    actions: readonly WorkflowBlockAction[];
    testID?: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);

    if (props.actions.length === 0) return null;

    return (
        <>
            <View ref={anchorRef} collapsable={false}>
            <IconButton
                testID={props.testID}
                iconName="dots-three"
                iconSize={18}
                variant="plain"
                accessibilityRole="button"
                // This is the block's overflow menu, not Add. Announcing "Add a
                // block to this workflow" told every screen-reader user the
                // wrong thing about what pressing it does.
                accessibilityLabel={t('common.moreActions')}
                accessibilityHint={props.blockLabel}
                onPress={() => setOpen((value) => !value)}
                expanded={open}
                hasPopup="menu"
            />
            </View>
            <Popover
                open={open}
                anchorRef={anchorRef}
                onRequestClose={() => setOpen(false)}
                placement="auto"
                closeOnAnchorPress
                portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
            >
                {() => (
                    <View style={workflowEditorStyles.menuSurface} accessibilityRole="menu">
                        {props.actions.map((action) => (
                            <HappierPressable
                                key={action.id}
                                testID={props.testID === undefined ? undefined : `${props.testID}-${action.id}`}
                                accessibilityRole="menuitem"
                                accessibilityLabel={action.label}
                                onPress={() => {
                                    setOpen(false);
                                    action.onSelect();
                                }}
                                style={(state) => [
                                    workflowEditorStyles.menuRow,
                                    state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                                ]}
                            >
                                <Text style={action.destructive === true
                                    ? workflowEditorStyles.menuRowLabelDestructive
                                    : workflowEditorStyles.menuRowLabel}
                                >
                                    {action.label}
                                </Text>
                            </HappierPressable>
                        ))}
                    </View>
                )}
            </Popover>
        </>
    );
}
