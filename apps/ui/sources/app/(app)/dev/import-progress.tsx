import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ImportProgressSpecimen } from '@/components/dev/externalSessions/ImportProgressSpecimen';

/** Dev-only: the External Session import card's states. `?frame=awaiting|running|partial`. */
export default function ImportProgressDevScreen() {
    const params = useLocalSearchParams<{ frame?: string }>();
    return <ImportProgressSpecimen frame={typeof params.frame === 'string' ? params.frame : null} />;
}
