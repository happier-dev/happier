import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { SimulatorDeviceHardwareButtonV1 } from '@happier-dev/protocol/devices/simulator/operationsV1';

import { IconButton, type IconButtonIconName } from '@/components/ui/buttons/IconButton';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';
import { t } from '@/text';

import { simulatorStreamStyles } from './styles';
import type { useSimulatorDeviceOperation } from './useSimulatorDeviceOperation';

const RAIL_BUTTONS: readonly Readonly<{
    button: SimulatorDeviceHardwareButtonV1;
    iconName: IconButtonIconName;
    label: () => string;
    testSuffix: string;
}>[] = [
    { button: 'home', iconName: 'house', label: () => t('simulatorPreview.toolbar.homeButton'), testSuffix: 'button-home' },
    { button: 'back', iconName: 'arrow-left', label: () => t('simulatorPreview.toolbar.backButton'), testSuffix: 'button-back' },
    { button: 'recents', iconName: 'stack', label: () => t('simulatorPreview.toolbar.recentButton'), testSuffix: 'button-recent' },
];

/**
 * The device's common actions beside its screen: the hardware buttons the producer advertises, a
 * screenshot that lands in the Session, and frame refresh. Buttons and screenshot are device
 * operations (Actions), so they work whether or not the person holds input control. Vertical beside
 * the screen; a horizontal strip under it on a narrow pane.
 */
export function SimulatorToolbar(props: Readonly<{
    viewModel: SimulatorPreviewViewModel;
    actions: Partial<SimulatorPreviewActions>;
    operations: ReturnType<typeof useSimulatorDeviceOperation>;
    /** The Session a screenshot lands in; without one there is nowhere to put it, so none is offered. */
    sessionId?: string;
    orientation?: 'vertical' | 'horizontal';
    testID: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const { controls, selectedSimulatorId } = props.viewModel;
    const horizontal = props.orientation === 'horizontal';
    const buttons = RAIL_BUTTONS.filter((entry) => controls.hardwareButtons.includes(entry.button));
    const sessionId = props.sessionId;
    const canScreenshot = Boolean(sessionId) && controls.deviceOperations.includes('screenshot');
    const canRefreshFrame = controls.canRequestKeyframe;
    const deviceGroup = buttons.length > 0 || canScreenshot;
    if (!selectedSimulatorId || (!deviceGroup && !canRefreshFrame)) return null;

    // The rail's own gap, so stacked targets tile it without overlapping.
    const gap = theme.space.s8;
    const gaps = horizontal ? { interactiveTargetGapPx: gap } : { interactiveTargetVerticalGapPx: gap };
    const { pending, run } = props.operations;
    return (
        <View
            testID={props.testID}
            style={[simulatorStreamStyles.rail, horizontal ? simulatorStreamStyles.railHorizontal : null]}
        >
            {buttons.map((entry) => (
                <IconButton
                    key={entry.button}
                    testID={`${props.testID}-${entry.testSuffix}`}
                    iconName={entry.iconName}
                    variant="plain"
                    accessibilityLabel={entry.label()}
                    tooltip={entry.label()}
                    busy={pending === `hardware:${entry.button}`}
                    onPress={() => { void run(`hardware:${entry.button}`, selectedSimulatorId, { operation: 'hardware', button: entry.button }); }}
                    {...gaps}
                />
            ))}
            {canScreenshot && sessionId ? (
                <IconButton
                    testID={`${props.testID}-screenshot`}
                    iconName="camera"
                    variant="plain"
                    accessibilityLabel={t('simulatorPreview.device.screenshot')}
                    tooltip={t('simulatorPreview.device.screenshot')}
                    busy={pending === 'screenshot'}
                    onPress={() => { void run('screenshot', selectedSimulatorId, { operation: 'screenshot', sessionId }); }}
                    {...gaps}
                />
            ) : null}
            {deviceGroup && canRefreshFrame ? (
                <View style={[simulatorStreamStyles.railDivider, horizontal ? simulatorStreamStyles.railDividerHorizontal : null]} />
            ) : null}
            {canRefreshFrame ? (
                <IconButton
                    testID={`${props.testID}-request-keyframe`}
                    iconName="arrow-clockwise"
                    variant="plain"
                    accessibilityLabel={t('simulatorPreview.toolbar.refreshFrame')}
                    tooltip={t('simulatorPreview.toolbar.refreshFrame')}
                    disabled={!controls.canWatch}
                    onPress={() => { void props.actions.requestKeyframe?.(); }}
                    {...gaps}
                />
            ) : null}
        </View>
    );
}
