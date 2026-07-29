import * as React from 'react';
import { View } from 'react-native';

import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';

import { SimulatorDevicePicker } from './SimulatorDevicePicker';
import { SimulatorInputLayer } from './SimulatorInputLayer';
import { SimulatorSidebandPanel } from './SimulatorSidebandPanel';
import { SimulatorStreamView } from './SimulatorStreamView';
import { SimulatorToolbar } from './SimulatorToolbar';
import { SimulatorUnavailableState } from './SimulatorUnavailableState';
import { simulatorStreamStyles } from './styles';

export function SimulatorPreviewPane(props: Readonly<{
    viewModel: SimulatorPreviewViewModel;
    actions: Partial<SimulatorPreviewActions>;
    testID: string;
}>): React.ReactElement {
    return (
        <View testID={props.testID} style={simulatorStreamStyles.paneRoot}>
            <SimulatorDevicePicker
                devices={props.viewModel.devices}
                selectedSimulatorId={props.viewModel.selectedSimulatorId}
                onSelectDevice={(simulatorId) => props.actions.selectDevice?.(simulatorId)}
                testID={`${props.testID}-picker`}
            />
            <View style={simulatorStreamStyles.paneContent}>
                <View style={simulatorStreamStyles.paneMain}>
                    <View style={simulatorStreamStyles.streamShell}>
                        {props.viewModel.resource ? (
                            <View style={simulatorStreamStyles.bodyOverlayHost}>
                                <SimulatorStreamView
                                    controls={props.viewModel.controls}
                                    lease={props.viewModel.lease}
                                    onLowerQuality={props.actions.lowerQuality}
                                    onRequestKeyframe={props.actions.requestKeyframe}
                                    playerState={props.viewModel.stream}
                                    resource={props.viewModel.resource}
                                    testID={`${props.testID}-stream`}
                                />
                                {props.viewModel.controls.canControl ? (
                                    <View pointerEvents="box-none" style={simulatorStreamStyles.inputOverlay}>
                                        <SimulatorInputLayer
                                            viewModel={props.viewModel}
                                            onSendControl={(control) => {
                                                void props.actions.sendControl?.(control);
                                            }}
                                            testID={`${props.testID}-input`}
                                        />
                                    </View>
                                ) : null}
                            </View>
                        ) : (
                            <SimulatorUnavailableState
                                reasonCode={props.viewModel.availability.reasonCode}
                                testID={`${props.testID}-stream`}
                            />
                        )}
                    </View>
                    {props.viewModel.resource ? (
                        <SimulatorToolbar
                            viewModel={props.viewModel}
                            actions={props.actions}
                            testID={`${props.testID}-toolbar`}
                        />
                    ) : null}
                </View>
                <SimulatorSidebandPanel
                    sidebands={props.viewModel.sidebands}
                    diagnostics={props.viewModel.diagnostics}
                    onRequestSideband={(kind) => {
                        void props.actions.requestSideband?.(kind);
                    }}
                    testID={`${props.testID}-sidebands`}
                />
            </View>
        </View>
    );
}
