import * as React from 'react';
import { View } from 'react-native';

import { ActionListSection, type ActionListItem } from '@/components/ui/lists/ActionListSection';
import { t } from '@/text';

type AgentInputActionMenuPopoverContentProps = Readonly<{
    actionMenuActions: ReadonlyArray<ActionListItem>;
}>;

export function AgentInputActionMenuPopoverContent(props: AgentInputActionMenuPopoverContentProps) {
    const hasActionMenu = props.actionMenuActions.length > 0;

    if (!hasActionMenu) {
        return null;
    }

    return (
        <View testID="agent-input-action-menu-overlay">
            <ActionListSection
                title={t('agentInput.actionMenu.title')}
                actions={props.actionMenuActions}
            />
        </View>
    );
}
