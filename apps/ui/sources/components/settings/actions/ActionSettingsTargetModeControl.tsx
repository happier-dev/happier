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
    flooredReason: {
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 12, default: 12 }),
        lineHeight: 16,
        marginTop: 6,
    },
}));

export type ActionSettingsTargetModeControlProps = Readonly<{
    controlState: ActionSettingsTargetControlState;
    accessibilityLabel: string;
    disabled?: boolean;
    layout?: 'inline' | 'stacked';
    testIDPrefix: string;
    onChange: (value: ActionSettingsApprovalControlValue | ActionSettingsBooleanControlValue) => void;
}>;

export const ActionSettingsTargetModeControl = React.memo(function ActionSettingsTargetModeControl(props: ActionSettingsTargetModeControlProps) {
    const styles = stylesheet;
    // CON-5: when the action is floored on the agent surface, the `allowed` option is forbidden (the
    // policy requires human consent), so it is dropped from the segmented control and a reason is
    // shown below. `ask_first` becomes the lowest selectable state.
    const floored = props.controlState.kind === 'approval' && props.controlState.floored === true;
    const approvalTabs = React.useMemo<readonly SegmentedTab<ActionSettingsApprovalControlValue>[]>(() => {
        const tabs: SegmentedTab<ActionSettingsApprovalControlValue>[] = [
            { id: 'off', label: t('settingsActions.modes.off') },
            { id: 'ask_first', label: t('settingsActions.modes.askFirst') },
        ];
        if (!floored) {
            tabs.push({ id: 'allowed', label: t('settingsActions.modes.allowed') });
        }
        return tabs;
    }, [floored]);

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
                accessibilityLabel={props.accessibilityLabel}
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
            {floored ? (
                <Text testID={`${props.testIDPrefix}:floored-reason`} style={styles.flooredReason}>
                    {t('settingsActions.reasons.requiredByAgentPolicy')}
                </Text>
            ) : null}
        </View>
    );
});
