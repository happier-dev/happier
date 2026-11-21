import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';
import { t } from '@/text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

import { SimulatorDevicePicker } from './SimulatorDevicePicker';
import { SimulatorInputLayer } from './SimulatorInputLayer';
import { SimulatorSidebandPanel } from './SimulatorSidebandPanel';
import { SimulatorStreamView } from './SimulatorStreamView';
import { SimulatorToolbar } from './SimulatorToolbar';
import { SimulatorViewerBar } from './SimulatorViewerBar';
import { simulatorStreamStyles } from './styles';
import { useSimulatorDeviceOperation } from './useSimulatorDeviceOperation';

/**
 * The device viewer. Identity and state first (the bar), the live screen as the main content, the
 * common device actions on a rail beside it, rare tools in an on-demand panel. Below the shared
 * two-column stack width the rail moves under the screen, the Tools panel takes the screen's place,
 * and the person can hand the whole pane to the screen (controls hidden, one button brings them back).
 */
export function SimulatorPreviewPane(props: Readonly<{
    viewModel: SimulatorPreviewViewModel;
    actions: Partial<SimulatorPreviewActions>;
    /** The Session this viewer belongs to: where a screenshot lands. */
    sessionId?: string;
    testID: string;
}>): React.ReactElement {
    const { viewModel, actions } = props;
    useCurrentUiContextLocalCommands(actions.selectDevice ? viewModel.devices
        .filter(device => device.state !== 'stopped')
        .map(device => ({ key: `simulator.select:${device.simulatorId}`,
            title: `${t('simulatorPreview.viewer.switchDevice')}: ${device.label}`,
            invoke: () => actions.selectDevice?.(device.simulatorId),
        })) : [], { contextKey: props.sessionId ?? props.testID });
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const [paneWidth, setPaneWidth] = React.useState(0);
    const [toolsOpen, setToolsOpen] = React.useState(false);
    const [controlsHidden, setControlsHidden] = React.useState(false);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        setPaneWidth((current) => (current === width ? current : width));
    }, []);
    const stacked = paneWidth > 0 && paneWidth < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx;
    const immersive = stacked && controlsHidden;
    const toolsShown = toolsOpen && !immersive;
    const resource = viewModel.resource;
    const toggleTools = React.useCallback(() => setToolsOpen((current) => !current), []);
    const closeTools = React.useCallback(() => setToolsOpen(false), []);
    const retry = actions.openStream ? () => { void actions.openStream?.(); } : undefined;
    const operations = useSimulatorDeviceOperation(actions);
    const runOperation = operations.run;
    const selectDevice = actions.selectDevice;
    // Booting answers with the running device's identity; the viewer opens it as soon as it is up.
    const startDevice = React.useCallback(async (simulatorId: string) => {
        const result = await runOperation(`boot:${simulatorId}`, simulatorId, { operation: 'boot' });
        if (result?.ok) selectDevice?.(result.device?.simulatorId ?? simulatorId);
    }, [runOperation, selectDevice]);
    const selectedSimulatorId = viewModel.selectedSimulatorId;
    const powerOff = React.useCallback(() => {
        if (selectedSimulatorId) void runOperation('power_off', selectedSimulatorId, { operation: 'power_off' });
    }, [runOperation, selectedSimulatorId]);

    return (
        // The rail, capsule and menus float over or beside the live picture: they take its coat.
        <GlassLivePictureBackdropContext.Provider value>
            <View
                testID={props.testID}
                style={[simulatorStreamStyles.paneRoot, { paddingBottom: bottomChromeHeight }]}
                onLayout={onLayout}
            >
                {viewModel.resource && viewModel.snapshotRefreshState === 'error' ? (
                    <SurfaceStateCard
                        kind="warning"
                        size="line"
                        title={t('simulatorPreview.viewer.inventoryUnavailable')}
                        testID={`${props.testID}-inventory-error`}
                    />
                ) : null}
                {!resource ? (
                    <SimulatorDevicePicker
                        devices={viewModel.devices}
                        kind={viewModel.kind}
                        selectedSimulatorId={viewModel.selectedSimulatorId}
                        onSelectDevice={(simulatorId) => actions.selectDevice?.(simulatorId)}
                        onStartDevice={(simulatorId) => { void startDevice(simulatorId); }}
                        pendingOperation={operations.pending}
                        testID={`${props.testID}-picker`}
                    />
                ) : (
                    <>
                        {immersive ? null : (
                            <SimulatorViewerBar
                                viewModel={viewModel}
                                actions={actions}
                                toolsOpen={toolsShown}
                                onToggleTools={toggleTools}
                                onHideControls={stacked ? () => setControlsHidden(true) : undefined}
                                stacked={stacked}
                                onStartDevice={(simulatorId) => { void startDevice(simulatorId); }}
                                onPowerOff={powerOff}
                                powerOffPending={operations.pending === 'power_off'}
                                testID={`${props.testID}-bar`}
                            />
                        )}
                        <View style={[simulatorStreamStyles.content, stacked ? simulatorStreamStyles.contentStacked : null]}>
                            {/* The stage stays mounted while Tools covers it, so the decoder keeps its picture. */}
                            <View style={[simulatorStreamStyles.stage, stacked && toolsShown ? simulatorStreamStyles.hidden : null]}>
                                <SimulatorStreamView
                                    controls={viewModel.controls}
                                    playerState={viewModel.stream}
                                    resource={resource}
                                    onRetry={retry}
                                    testID={`${props.testID}-stream`}
                                />
                                {viewModel.controls.canControl ? (
                                    <View pointerEvents="box-none" style={simulatorStreamStyles.fill}>
                                        <SimulatorInputLayer
                                            viewModel={viewModel}
                                            onSendControl={(control) => {
                                                void actions.sendControl?.(control);
                                            }}
                                            testID={`${props.testID}-input`}
                                        />
                                    </View>
                                ) : null}
                                {immersive ? (
                                    <View style={simulatorStreamStyles.showControls}>
                                        <IconButton
                                            testID={`${props.testID}-show-controls`}
                                            iconName="arrows-in"
                                            accessibilityLabel={t('simulatorPreview.viewer.showControls')}
                                            tooltip={t('simulatorPreview.viewer.showControls')}
                                            onPress={() => setControlsHidden(false)}
                                        />
                                    </View>
                                ) : null}
                            </View>
                            {immersive || (stacked && toolsShown) ? null : (
                                <SimulatorToolbar
                                    viewModel={viewModel}
                                    actions={actions}
                                    operations={operations}
                                    sessionId={props.sessionId}
                                    orientation={stacked ? 'horizontal' : 'vertical'}
                                    testID={`${props.testID}-toolbar`}
                                />
                            )}
                            {toolsShown ? (
                                <SimulatorSidebandPanel
                                    viewModel={viewModel}
                                    actions={actions}
                                    operations={operations}
                                    onClose={closeTools}
                                    stacked={stacked}
                                    testID={`${props.testID}-sidebands`}
                                />
                            ) : null}
                        </View>
                    </>
                )}
            </View>
        </GlassLivePictureBackdropContext.Provider>
    );
}
