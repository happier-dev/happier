import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { SessionDefaultsSpecimen } from '@/components/dev/sessionDefaults/SessionDefaultsSpecimen';

/** Dev-only: Project › Session defaults (lab L11). `?state=loading|failed&scope=me|project`. */
export default function SessionDefaultsDevScreen() {
    const params = useLocalSearchParams<{ state?: string; scope?: string }>();
    return <SessionDefaultsSpecimen state={typeof params.state === 'string' ? params.state : null}
        scope={typeof params.scope === 'string' ? params.scope : null} />;
}
