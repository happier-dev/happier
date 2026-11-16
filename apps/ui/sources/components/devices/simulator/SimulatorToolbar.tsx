import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton, type IconButtonIconName } from '@/components/ui/buttons/IconButton';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorDeviceHardwareButtonV1 } from '@happier-dev/protocol/devices/simulator/operationsV1';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';
import { t } from '@/text';

import { simulatorStreamStyles } from './styles';

type RailButton = SimulatorDeviceHardwareButtonV1;

const RAIL_BUTTONS: readonly Readonly<{
    button: RailButton;
    iconName: IconButtonIconName;
    label: () => string;
    testSuffix: string;
}>[] = [
    { button: 'home', iconName: 'house', label: () => t('simulatorPreview.toolbar.homeButton'), testSuffix: 'button-home' },
    { button: 'back', iconName: 'arrow-left', label: () => t('simulatorPreview.toolbar.backButton'), testSuffix: 'button-back' },
    { button: 'recents', iconName: 'stack', label: () => t('simulatorPreview.toolbar.recentButton'), testSuffix: 'button-recent' },
];

function pressAction(actions: Partial<SimulatorPreviewActions>, button: RailButton): (() => Promise<void>) | undefined {
    switch (button) {
        case 'home': return actions.pressHome;
        case 'back': return actions.pressBack;
        case 'recents': return actions.pressRecent;
    }
}

/**
 * The device's common actions beside its screen: the platform's hardware buttons, rotation when the
 * producer backs it, and frame refresh. The rail is the same whether or not the person holds control,
 * so nothing moves when they take it; input-only buttons stay visible and say what they need.
 * Vertical beside the screen; a horizontal strip under it on a narrow pane.
 */
export function SimulatorToolbar(props: Readonly<{
    viewModel: SimulatorPreviewViewModel;
    actions: Partial<SimulatorPreviewActions>;
    orientation?: 'vertical' | 'horizontal';
    testID: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const { controls } = props.viewModel;
    const horizontal = props.orientation === 'horizontal';
    const inputReason = controls.canControl ? undefined : t('simulatorPreview.viewer.takeControlFirst');
    const buttons = RAIL_BUTTONS.filter((entry) => controls.hardwareButtons.includes(entry.button));
    const showRotate = controls.supportedInputKinds.includes('orientation');
    const canRefreshFrame = controls.canRequestKeyframe;
    const deviceGroup = buttons.length > 0 || showRotate;
    if (!deviceGroup && !canRefreshFrame) return null;

    // The rail's own gap, so stacked targets tile it without overlapping.
    const gap = theme.space.s8;
    const gaps = horizontal ? { interactiveTargetGapPx: gap } : { interactiveTargetVerticalGapPx: gap };
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
                    disabled={!controls.canControl}
                    disabledReason={inputReason}
                    onPress={() => { void pressAction(props.actions, entry.button)?.(); }}
                    {...gaps}
                />
            ))}
            {showRotate ? (
                <IconButton
                    testID={`${props.testID}-rotate-left`}
                    iconName="arrow-counter-clockwise"
                    variant="plain"
                    accessibilityLabel={t('simulatorPreview.toolbar.rotateLeft')}
                    tooltip={t('simulatorPreview.toolbar.rotateLeft')}
                    disabled={!controls.canControl}
                    disabledReason={inputReason}
                    onPress={() => { void props.actions.rotateLeft?.(); }}
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
