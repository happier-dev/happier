import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
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
    // The control hugs its words: three short choices never stretch across a row or wrap a label.
    control: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        columnGap: theme.space.s12,
        rowGap: theme.space.s6,
        maxWidth: '100%',
    },
    // Beneath its row's words (a narrow pane or a phone), the control starts where they start.
    controlStacked: {
        justifyContent: 'flex-start',
        alignSelf: 'flex-start',
        marginTop: theme.space.s8,
    },
    // The link starts its own line box at the top; centred on the segments it reads as their caption.
    useDefault: {
        alignSelf: 'center',
    },
    // A shared-to-use value reads as the row's value, in the value column's ink.
    readOnlyValue: {
        color: theme.colors.text.secondary,
    },
    unavailable: {
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 13, default: 13 }),
        lineHeight: 18,
    },
}));

export type ActionSettingsTargetModeControlProps = Readonly<{
    controlState: ActionSettingsTargetControlState;
    accessibilityLabel: string;
    disabled?: boolean;
    /** A person who can only use this setting (a profile shared to use) sees its value, not a control. */
    readOnly?: boolean;
    layout?: 'inline' | 'stacked';
    testIDPrefix: string;
    onChange: (value: ActionSettingsApprovalControlValue | ActionSettingsBooleanControlValue) => void;
}>;

export const ActionSettingsTargetModeControl = React.memo(function ActionSettingsTargetModeControl(props: ActionSettingsTargetModeControlProps) {
    const styles = stylesheet;

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
                disabled={props.disabled || props.readOnly}
                testID={`${props.testIDPrefix}:enabled`}
                value={props.controlState.value === 'on'}
                onValueChange={(value) => props.onChange(value ? 'on' : 'off')}
            />
        );
    }
    const state = props.controlState;
    const stacked = props.layout === 'stacked';
    const approvalTabs: readonly SegmentedTab<ActionSettingsApprovalControlValue>[] = state.approvalWaivable
        ? [
            { id: 'off', label: t('settingsActions.modes.off') },
            { id: 'ask_first', label: t('settingsActions.modes.askFirst'),
                ...(state.approvalPromptUnavailable ? { disabled: true,
                    unavailableReason: t('settingsActions.targets.foreign_session_html_resources.subtitle') } : {}) },
            { id: 'allowed', label: t('settingsActions.modes.allowed') },
        ]
        : [
            { id: 'off', label: t('settingsActions.modes.off') },
            { id: 'ask_first', label: t('settingsActions.modes.askFirst') },
        ];
    // Inheriting is how the value is held, not a fourth choice: the segment it resolves to is chosen on the
    // outlined (default) thumb, which announces "default". The settings writer restores inheritance when that answer is chosen.
    const inheriting = state.value === 'default';
    const activeTabId: ActionSettingsApprovalControlValue = inheriting
        ? (state.approvalRequiredByPolicy ? 'ask_first' : 'allowed')
        : state.value;
    if (props.readOnly) {
        const label = approvalTabs.find((tab) => tab.id === activeTabId)?.label ?? '';
        return (
            <Text testID={`${props.testIDPrefix}:mode:value`} variant="body" style={styles.readOnlyValue}>{label}</Text>
        );
    }
    const segments = (
        <SegmentedTabBar
            key="segments"
            role="radiogroup"
            accessibilityLabel={props.accessibilityLabel}
            disabled={props.disabled}
            testIDPrefix={`${props.testIDPrefix}:mode`}
            tabs={approvalTabs}
            activeTabId={activeTabId}
            valueSource={inheriting ? 'inherited' : 'set'}
            segmentSizing="content"
            onSelectTab={props.onChange}
        />
    );
    // An explicit reset while the value is the person's own. It sits on the side away from
    // the segments' anchor, so appearing never moves the segment that was just pressed.
    const useDefault = state.approvalWaivable && state.value !== 'off' && !inheriting ? (
        <View key="useDefault" style={styles.useDefault}>
            <TextLinkButton
                testID={`${props.testIDPrefix}:mode:useDefault`}
                label={t('settingsActions.modes.useDefault')}
                tone="quiet"
                disabled={props.disabled}
                onPress={() => props.onChange('default')}
            />
        </View>
    ) : null;
    return (
        <View
            testID={`${props.testIDPrefix}:mode`}
            style={[styles.control, stacked ? styles.controlStacked : null]}
        >
            {stacked ? segments : useDefault}
            {stacked ? useDefault : segments}
        </View>
    );
});
