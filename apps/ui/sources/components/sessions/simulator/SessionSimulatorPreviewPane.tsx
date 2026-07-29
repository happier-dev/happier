import * as React from 'react';
import { View } from 'react-native';

import { SimulatorPreviewPane } from '@/components/devices/simulator/SimulatorPreviewPane';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';

export function SessionSimulatorPreviewPane(props: Readonly<{
    sessionId: string;
    viewModel: SimulatorPreviewViewModel;
    actions: Partial<SimulatorPreviewActions>;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? `session-simulator:${props.sessionId}`;
    return (
        <View testID={testID}>
            <SimulatorPreviewPane
                viewModel={props.viewModel}
                actions={props.actions}
                testID={`${testID}-preview`}
            />
        </View>
    );
}
