import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ToolDetailsSpecimen } from '@/components/dev/tools/ToolDetailsSpecimen';

/** Dev-only: the tool-call details page over a recorded Action call. `?call=archive|spawn`. */
export default function ToolDetailsDevScreen() {
    const params = useLocalSearchParams<{ call?: string }>();
    return <ToolDetailsSpecimen call={params.call ?? 'archive'} />;
}
