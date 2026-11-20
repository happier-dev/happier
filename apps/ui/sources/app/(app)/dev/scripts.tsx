import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ScriptsSpecimen } from '@/components/dev/scripts/ScriptsSpecimen';

/** Dev-only: the Scripts page, project file editor and setup review with the lab's data. `?frame=PAGE|FIRST|EDIT|SETUP|SHARED|STATES|RAIL|OUTPUT|LAYERS|UPDATE|SHARE|REVIEWP&phone=1`; UPDATE takes `&state=changed|current|unreadable|checking`, SHARE `&state=ready|reading|unreadable|sharing|notAttached`. */
export default function ScriptsDevScreen() {
    const params = useLocalSearchParams<{ frame?: string; phone?: string; state?: string }>();
    return <ScriptsSpecimen frame={typeof params.frame === 'string' ? params.frame : null} phone={params.phone === '1'}
        state={typeof params.state === 'string' ? params.state : null} />;
}
