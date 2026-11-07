import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { ActionListSection, type ActionListItem } from '@/components/ui/lists/ActionListSection';
import { t } from '@/text';

type AgentInputActionMenuPopoverContentProps = Readonly<{
    actionMenuActions: ReadonlyArray<ActionListItem>;
    /** Present only for an editable composer that is not embedded: the + menu's last row. */
    onCustomizeComposer?: () => void;
    /** The pointer left the menu: a picker open beside it closes after the shared submenu grace. */
    onPointerLeave?: (event: unknown) => void;
    /** The picker a row opened: beside its row, or pushed inside the menu's sheet on a phone. */
    children?: React.ReactNode;
}>;

/**
 * The composer's + menu (calm-shell C2plus): the controls placed In + with their current values, then
 * "Customize composer…" on its own below a hairline. It reads as a menu, so it carries no section title.
 */
export function AgentInputActionMenuPopoverContent(props: AgentInputActionMenuPopoverContentProps) {
    const { theme } = useUnistyles();
    const hasActions = props.actionMenuActions.length > 0;
    const customize = props.onCustomizeComposer;
    const customizeActions = React.useMemo<ReadonlyArray<ActionListItem>>(() => customize ? [{
        id: 'customize-composer',
        testID: 'agent-input-action-menu-customize',
        label: t('navigationPlacement.customizeComposer'),
        icon: <Icon name="sliders-horizontal" size={16} color={theme.colors.composer.chipTint} />,
        onPress: customize,
    }] : [], [customize, theme.colors.composer.chipTint]);

    if (!hasActions && customizeActions.length === 0) {
        return null;
    }

    return (
        <View
            testID="agent-input-action-menu-overlay"
            accessibilityLabel={t('agentInput.actionMenu.title')}
            onPointerLeave={props.onPointerLeave}
        >
            {hasActions ? <ActionListSection actions={props.actionMenuActions} /> : null}
            {customizeActions.length > 0 ? <ActionListSection separatorAbove={hasActions} actions={customizeActions} /> : null}
            {props.children}
        </View>
    );
}
