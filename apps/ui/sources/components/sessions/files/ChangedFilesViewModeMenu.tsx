import * as React from 'react';
import { Pressable, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
    getSelectableChangedFilesViewModes,
    type ChangedFilesViewMode,
} from '@/scm/scmAttribution';
import { t } from '@/text';
import { StyleSheet as RNStyleSheet } from 'react-native';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

type ChangedFilesViewModeMenuProps = Readonly<{
    theme: any;
    changedFilesViewMode: ChangedFilesViewMode;
    showTurnViewToggle?: boolean;
    showTurnAgentReportedViewToggle?: boolean;
    showTurnCheckpointViewToggle?: boolean;
    showSessionViewToggle?: boolean;
    showSelectedViewToggle?: boolean;
    onChangedFilesViewMode?: (mode: ChangedFilesViewMode) => void;
    testID?: string;
    triggerLabel?: string;
    triggerLabelColor?: string;
    triggerStyle?: StyleProp<ViewStyle>;
    triggerTextStyle?: StyleProp<TextStyle>;
    accessibilityLabel?: string;
    popoverAnchorAlign?: 'start' | 'center' | 'end';
}>;

function getModeIcon(mode: ChangedFilesViewMode): IconName {
    if (mode === 'selected') return 'file-plus';
    if (mode === 'turn') return 'clock';
    if (mode === 'turn_agent_reported') return 'chats-circle';
    if (mode === 'turn_checkpoint') return 'git-commit';
    if (mode === 'session') return 'clock-counter-clockwise';
    return 'list-bullets';
}

function getModeLabel(mode: ChangedFilesViewMode): string {
    if (mode === 'selected') return t('files.toolbar.selectedForCommitView');
    if (mode === 'turn') return t('files.toolbar.turnView');
    if (mode === 'turn_agent_reported') return t('files.toolbar.agentReportedTurnView');
    if (mode === 'turn_checkpoint') return t('files.toolbar.checkpointTurnView');
    if (mode === 'session') return t('files.toolbar.sessionView');
    return t('files.toolbar.repositoryView');
}

export const ChangedFilesViewModeMenu = React.memo((props: ChangedFilesViewModeMenuProps) => {
    const [open, setOpen] = React.useState(false);
    const selectableModes = React.useMemo(() => getSelectableChangedFilesViewModes({
        showTurnViewToggle: props.showTurnViewToggle === true,
        showTurnAgentReportedViewToggle: props.showTurnAgentReportedViewToggle === true,
        showTurnCheckpointViewToggle: props.showTurnCheckpointViewToggle === true,
        showSessionViewToggle: props.showSessionViewToggle === true,
        showSelectedViewToggle: props.showSelectedViewToggle === true,
    }), [
        props.showSelectedViewToggle,
        props.showSessionViewToggle,
        props.showTurnAgentReportedViewToggle,
        props.showTurnCheckpointViewToggle,
        props.showTurnViewToggle,
    ]);

    const selectedMode = selectableModes.includes(props.changedFilesViewMode)
        ? props.changedFilesViewMode
        : selectableModes[0];

    const items = React.useMemo<DropdownMenuItem[]>(() => selectableModes.map((mode) => ({
        id: mode,
        title: getModeLabel(mode),
        icon: <Icon name={getModeIcon(mode)} size={14} color={props.theme.colors.text.secondary} />,
    })), [props.theme.colors.text.secondary, selectableModes]);

    const onSelect = React.useCallback((itemId: string) => {
        if (
            itemId !== 'repository'
            && itemId !== 'selected'
            && itemId !== 'turn'
            && itemId !== 'turn_agent_reported'
            && itemId !== 'turn_checkpoint'
            && itemId !== 'session'
        ) {
            return;
        }
        props.onChangedFilesViewMode?.(itemId);
    }, [props.onChangedFilesViewMode]);

    if (selectableModes.length <= 1 || !selectedMode) return null;

    const triggerLabel = props.triggerLabel ?? t('files.toolbar.view');
    const triggerLabelColor = props.triggerLabelColor ?? props.theme.colors.text.secondary;

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            selectedId={selectedMode}
            onSelect={onSelect}
            search={false}
            matchTriggerWidth={false}
            maxWidthCap={220}
            placement="bottom"
            popoverAnchorAlign={props.popoverAnchorAlign ?? 'end'}
            trigger={({ toggle, open: triggerOpen }) => (
                <Pressable
                    testID={props.testID}
                    accessibilityRole="button"
                    accessibilityLabel={props.accessibilityLabel ?? t('files.toolbar.view')}
                    onPress={toggle}
                    style={({ pressed }) => [
                        {
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            paddingHorizontal: 10,
                            height: 30,
                            borderRadius: 8,
                            borderWidth: RNStyleSheet.hairlineWidth,
                            borderColor: props.theme.colors.border.subtle,
                            backgroundColor: props.theme.colors.surface.base,
                            gap: 6,
                        },
                        props.triggerStyle,
                        { opacity: pressed ? 0.78 : 1 },
                    ]}
                >
                    <Icon name={getModeIcon(selectedMode)} size={14} color={props.theme.colors.text.secondary} />
                    <Text
                        numberOfLines={1}
                        style={[
                            {
                                minWidth: 0,
                                flexShrink: 1,
                                fontSize: 12,
                                color: triggerLabelColor,
                                ...Typography.default('semiBold'),
                            },
                            props.triggerTextStyle,
                        ]}
                    >
                        {triggerLabel}
                    </Text>
                    <View style={{ marginLeft: -2 }}>
                        <Icon name={triggerOpen ? 'caret-up' : 'caret-down'} size={14} color={props.theme.colors.text.secondary} />
                    </View>
                </Pressable>
            )}
        />
    );
});
