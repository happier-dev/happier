import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ScriptsSpecimen } from '@/components/dev/scripts/ScriptsSpecimen';

/** Dev-only: the Scripts page, project file editor and setup review with the lab's data. `?frame=PAGE|FIRST|EDIT|SETUP|SHARED|STATES|RAIL|OUTPUT&phone=1`. */
export default function ScriptsDevScreen() {
    const params = useLocalSearchParams<{ frame?: string; phone?: string }>();
    return <ScriptsSpecimen frame={typeof params.frame === 'string' ? params.frame : null} phone={params.phone === '1'} />;
}
