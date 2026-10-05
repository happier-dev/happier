import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ChangesSpecimen } from '@/components/dev/changes/ChangesSpecimen';

/** Dev-only: the turn-end card, Files, Walkthrough and Commits (Walkthrough lab WT1-WT4, WT8, WT9). `?only=<frame id>`, `?phone=1`. */
export default function ChangesDevScreen() {
    const params = useLocalSearchParams<{ only?: string; phone?: string }>();
    return (
        <ChangesSpecimen
            only={typeof params.only === 'string' ? params.only : null}
            phone={params.phone === '1'}
        />
    );
}
