import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { WorkerPickerStatesSpecimen } from '@/components/dev/projects/WorkerPickerStatesSpecimen';

/** Dev-only: the Project work destination list with your own workers and Machines shared with you. `?picker=service|run`. */
export default function WorkerPickerStatesDevScreen() {
    const params = useLocalSearchParams<{ picker?: string }>();
    return <WorkerPickerStatesSpecimen service={params.picker !== 'run'} />;
}
