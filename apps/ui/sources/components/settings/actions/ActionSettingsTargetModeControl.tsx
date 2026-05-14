import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type {
    ActionSettingsApprovalControlValue,
    ActionSettingsBooleanControlValue,
    ActionSettingsTargetControlState,
} from './actionSettingsTargets';

const stylesheet = StyleSheet.create((theme) => ({
    segmentedContainer: {
        width: Platform.select({ ios: 228, default: 250 }),
        maxWidth: '100%',
        opacity: 1,
    },
    segmentedContainerStacked: {
        width: '100%',
        marginTop: Platform.select({ ios: 8, default: 8 }),
    },
    segmentedDisabled: {
        opacity: 0.56,
    },
    unavailable: {
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 13, default: 13 }),
        lineHeight: 18,
    },
}));

export type ActionSettingsTargetModeControlProps = Readonly<{
    controlState: ActionSettingsTargetControlState;
    disabled?: boolean;
    layout?: 'inline' | 'stacked';
    testIDPrefix: string;
    onChange: (value: ActionSettingsApprovalControlValue | ActionSettingsBooleanControlValue) => void;
}>;

export const ActionSettingsTargetModeControl = React.memo(function ActionSettingsTargetModeControl(props: ActionSettingsTargetModeControlProps) {
    const styles = stylesheet;
    const approvalTabs = React.useMemo<readonly SegmentedTab<ActionSettingsApprovalControlValue>[]>(() => [
        { id: 'off', label: t('settingsActions.modes.off') },
        { id: 'ask_first', label: t('settingsActions.modes.askFirst') },
        { id: 'allowed', label: t('settingsActions.modes.allowed') },
    ], []);

    if (props.controlState.kind === 'unavailable') {
        return (
            <Text style={styles.unavailable}>
                {t('common.unavailable')}
            </Text>
        );
    }

    if (props.controlState.kind === 'switch') {
        return (
            <Switch
                compact
                disabled={props.disabled}
                testID={`${props.testIDPrefix}:enabled`}
                value={props.controlState.value === 'on'}
                onValueChange={(value) => props.onChange(value ? 'on' : 'off')}
            />
        );
    }

    return (
        <View
            testID={`${props.testIDPrefix}:mode`}
            style={[
                styles.segmentedContainer,
                props.layout === 'stacked' ? styles.segmentedContainerStacked : null,
                props.disabled ? styles.segmentedDisabled : null,
            ]}
            pointerEvents={props.disabled ? 'none' : 'auto'}
        >
            <SegmentedTabBar
                compact
                testIDPrefix={`${props.testIDPrefix}:mode`}
                tabs={approvalTabs}
                activeTabId={props.controlState.value}
                onSelectTab={props.onChange}
            />
        </View>
    );
});
