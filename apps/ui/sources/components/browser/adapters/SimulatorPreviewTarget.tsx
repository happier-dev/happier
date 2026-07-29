import * as React from 'react';
import { View } from 'react-native';

import { SimulatorPreviewPane } from '@/components/devices/simulator/SimulatorPreviewPane';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';

export function SimulatorPreviewTarget(props: Readonly<{
    viewModel: SimulatorPreviewViewModel;
    actions: Partial<SimulatorPreviewActions>;
    testID: string;
}>): React.ReactElement {
    return (
        <View testID={props.testID}>
            <SimulatorPreviewPane
                viewModel={props.viewModel}
                actions={props.actions}
                testID={`${props.testID}-preview`}
            />
        </View>
    );
}
