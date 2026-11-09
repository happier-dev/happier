import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ModelPickerStatesSpecimen } from '@/components/dev/modelPicker/ModelPickerStatesSpecimen';

/** Dev-only: the New Session model pane in its loading, empty, pending and normal states. `?frame=<id>`. */
export default function ModelPickerStatesDevScreen() {
    const params = useLocalSearchParams<{ frame?: string }>();
    return <ModelPickerStatesSpecimen frame={typeof params.frame === 'string' ? params.frame : null} />;
}
