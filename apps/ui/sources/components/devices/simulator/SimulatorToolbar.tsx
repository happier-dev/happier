import * as React from 'react';
import { View } from 'react-native';
import type { MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';

import { simulatorStreamStyles } from './styles';

function ToolbarIconButton(props: Readonly<{
    iconName: React.ComponentProps<typeof IconButton>['iconName'];
    label: string;
    disabled?: boolean;
    onPress?: () => void;
    testID: string;
}>): React.ReactElement {
    const disabled = props.disabled ?? false;
    return (
        <IconButton
            testID={props.testID}
            iconName={props.iconName}
            accessibilityLabel={props.label}
            tooltip={props.label}
            size={34}
            iconSize={16}
            disabled={disabled}
            onPress={() => props.onPress?.()}
        />
    );
}

function supportsInput(viewModel: SimulatorPreviewViewModel, kind: MachineLiveStreamControlSidebandV1['kind']): boolean {
    return viewModel.controls.supportedInputKinds.includes(kind);
}

function leaseStatusLabel(viewModel: SimulatorPreviewViewModel): string {
    if (viewModel.controls.canControl) {
        return t('streamPlayer.controls.controlling');
    }
    if (viewModel.lease.state === 'held-by-other') {
        return viewModel.lease.holderLabel
            ? t('simulatorPreview.toolbar.heldByOtherWithHolder', { holder: viewModel.lease.holderLabel })
            : t('simulatorPreview.toolbar.heldByOther');
    }
    return t('streamPlayer.controls.readOnly');
}

export function SimulatorToolbar(props: Readonly<{
    viewModel: SimulatorPreviewViewModel;
    actions: Partial<SimulatorPreviewActions>;
    testID: string;
}>): React.ReactElement {
    const canControl = props.viewModel.controls.canControl;
    const canWatch = props.viewModel.controls.canWatch;
    const showAcquire = props.viewModel.lease.state === 'available';
    const showRelease = props.viewModel.lease.state === 'held-by-me';
    const showOrientation = canControl && supportsInput(props.viewModel, 'orientation');
    const showHardwareButton = canControl && supportsInput(props.viewModel, 'hardware_button');
    const showQuality = props.viewModel.controls.canSetQuality
        || props.viewModel.controls.canSetFps
        || props.viewModel.controls.canSetScale;
    const showOverflow = showRelease || showOrientation || showHardwareButton;
    const overflowAnchorRef = React.useRef<View | null>(null);
    const [overflowOpen, setOverflowOpen] = React.useState(false);

    return (
        <View testID={props.testID} style={simulatorStreamStyles.toolbar}>
            <View testID={`${props.testID}-lease`} style={simulatorStreamStyles.toolbarGroup}>
                <View style={simulatorStreamStyles.readonlyBadge}>
                    <Text style={simulatorStreamStyles.badgeText}>
                        {leaseStatusLabel(props.viewModel)}
                    </Text>
                </View>
                {showAcquire ? (
                    <ToolbarIconButton
                        iconName="hand-left-outline"
                        label={t('simulatorPreview.toolbar.acquireControl')}
                        onPress={props.actions.acquireLease}
                        testID={`${props.testID}-acquire-lease`}
                    />
                ) : null}
            </View>
            <View testID={`${props.testID}-stream`} style={simulatorStreamStyles.toolbarGroup}>
                {props.viewModel.controls.canRequestKeyframe ? (
                    <ToolbarIconButton
                        iconName="refresh-outline"
                        disabled={!canWatch}
                        label={t('simulatorPreview.toolbar.refreshFrame')}
                        onPress={canWatch ? props.actions.requestKeyframe : undefined}
                        testID={`${props.testID}-request-keyframe`}
                    />
                ) : null}
                {props.viewModel.controls.canRequestSnapshot ? (
                    <ToolbarIconButton
                        iconName="camera-outline"
                        disabled={!canWatch}
                        label={t('simulatorPreview.toolbar.snapshot')}
                        onPress={canWatch ? props.actions.requestSnapshot : undefined}
                        testID={`${props.testID}-request-snapshot`}
                    />
                ) : null}
                {showQuality ? (
                    <View testID={`${props.testID}-quality`} style={simulatorStreamStyles.toolbarQualityGroup}>
                        <Text style={simulatorStreamStyles.badgeText}>{t('simulatorPreview.toolbar.quality')}</Text>
                        {props.viewModel.controls.canSetQuality ? (
                            <ToolbarIconButton
                                iconName="cellular-outline"
                                disabled={!canWatch}
                                label={t('simulatorPreview.toolbar.reduceBandwidth')}
                                onPress={canWatch ? props.actions.lowerQuality : undefined}
                                testID={`${props.testID}-lower-quality`}
                            />
                        ) : null}
                        {props.viewModel.controls.canSetFps ? (
                            <ToolbarIconButton
                                iconName="speedometer-outline"
                                disabled={!canWatch}
                                label={t('simulatorPreview.toolbar.fps')}
                                onPress={canWatch ? props.actions.setFps : undefined}
                                testID={`${props.testID}-set-fps`}
                            />
                        ) : null}
                        {props.viewModel.controls.canSetScale ? (
                            <ToolbarIconButton
                                iconName="resize-outline"
                                disabled={!canWatch}
                                label={t('simulatorPreview.toolbar.scale')}
                                onPress={canWatch ? props.actions.setScale : undefined}
                                testID={`${props.testID}-set-scale`}
                            />
                        ) : null}
                    </View>
                ) : null}
            </View>
            {showOverflow ? (
                <View ref={overflowAnchorRef} testID={`${props.testID}-overflow-anchor`}>
                    <IconButton
                        testID={`${props.testID}-overflow`}
                        iconName="ellipsis-horizontal"
                        accessibilityLabel={t('simulatorPreview.toolbar.moreControls')}
                        tooltip={t('simulatorPreview.toolbar.moreControls')}
                        size={34}
                        iconSize={16}
                        onPress={() => setOverflowOpen((current) => !current)}
                    />
                    <Popover
                        open={overflowOpen}
                        anchorRef={overflowAnchorRef}
                        placement="top"
                        onRequestClose={() => setOverflowOpen(false)}
                    >
                        {() => (
                            <View testID={`${props.testID}-overflow-panel`} style={simulatorStreamStyles.toolbarOverflowPanel}>
                                {showRelease ? (
                                    <ToolbarIconButton
                                        iconName="lock-open-outline"
                                        label={t('simulatorPreview.toolbar.releaseControl')}
                                        onPress={props.actions.releaseLease}
                                        testID={`${props.testID}-release-lease`}
                                    />
                                ) : null}
                                {showRelease ? (
                                    <ToolbarIconButton
                                        iconName="time-outline"
                                        label={t('simulatorPreview.toolbar.renewControl')}
                                        onPress={props.actions.renewLease}
                                        testID={`${props.testID}-renew-lease`}
                                    />
                                ) : null}
                                {showOrientation ? (
                                    <ToolbarIconButton
                                        iconName="phone-landscape-outline"
                                        label={t('simulatorPreview.toolbar.rotateLeft')}
                                        onPress={props.actions.rotateLeft}
                                        testID={`${props.testID}-rotate-left`}
                                    />
                                ) : null}
                                {showHardwareButton ? (
                                    <ToolbarIconButton
                                        iconName="radio-button-on-outline"
                                        label={t('simulatorPreview.toolbar.homeButton')}
                                        onPress={props.actions.pressHome}
                                        testID={`${props.testID}-button-home`}
                                    />
                                ) : null}
                                {showHardwareButton ? (
                                    <ToolbarIconButton
                                        iconName="arrow-back-outline"
                                        label={t('simulatorPreview.toolbar.backButton')}
                                        onPress={props.actions.pressBack}
                                        testID={`${props.testID}-button-back`}
                                    />
                                ) : null}
                                {showHardwareButton ? (
                                    <ToolbarIconButton
                                        iconName="albums-outline"
                                        label={t('simulatorPreview.toolbar.recentButton')}
                                        onPress={props.actions.pressRecent}
                                        testID={`${props.testID}-button-recent`}
                                    />
                                ) : null}
                                {showHardwareButton ? (
                                    <ToolbarIconButton
                                        iconName="volume-high-outline"
                                        label={t('simulatorPreview.toolbar.volumeUp')}
                                        onPress={props.actions.pressVolumeUp}
                                        testID={`${props.testID}-button-volume-up`}
                                    />
                                ) : null}
                                {showHardwareButton ? (
                                    <ToolbarIconButton
                                        iconName="volume-low-outline"
                                        label={t('simulatorPreview.toolbar.volumeDown')}
                                        onPress={props.actions.pressVolumeDown}
                                        testID={`${props.testID}-button-volume-down`}
                                    />
                                ) : null}
                            </View>
                        )}
                    </Popover>
                </View>
            ) : null}
        </View>
    );
}
