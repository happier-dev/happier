import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { ActionListSection, type ActionListItem } from '@/components/ui/lists/ActionListSection';
import type { AgentInputActionMenuAction } from '../actionMenuActions';
import { t } from '@/text';

type AgentInputActionMenuPopoverContentProps = Readonly<{
    actionMenuActions: ReadonlyArray<AgentInputActionMenuAction>;
    /** Present only for an editable composer that is not embedded: the + menu's last row. */
    onCustomizeComposer?: () => void;
    /** The pointer left the menu: a picker open beside it closes after the shared submenu grace. */
    onPointerLeave?: (event: unknown) => void;
    /** The picker a row opened: beside its row, or pushed inside the menu's sheet on a phone. */
    children?: React.ReactNode;
}>;

/**
 * The composer's + menu (calm-shell C2plus): the controls placed In + with their current values, a hairline
 * between their declared groups (Attach and Link first), then "Customize composer…" on its own below a
 * hairline. It reads as a menu, so it carries no section title.
 */
export function AgentInputActionMenuPopoverContent(props: AgentInputActionMenuPopoverContentProps) {
    const { theme } = useUnistyles();
    const hasActions = props.actionMenuActions.length > 0;
    // The builder orders rows by group; each run of one group is a section.
    const groups = React.useMemo(() => props.actionMenuActions.reduce<AgentInputActionMenuAction[][]>((runs, action) => {
        const last = runs[runs.length - 1];
        if (last && last[0]!.section === action.section) last.push(action);
        else runs.push([action]);
        return runs;
    }, []), [props.actionMenuActions]);
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
            {groups.map((actions, index) => (
                <ActionListSection key={actions[0]!.section} separatorAbove={index > 0} actions={actions} />
            ))}
            {customizeActions.length > 0 ? <ActionListSection separatorAbove={hasActions} actions={customizeActions} /> : null}
            {props.children}
        </View>
    );
}
