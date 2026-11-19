import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { SessionRowStatusSpecimen } from '@/components/dev/sessions/SessionRowStatusSpecimen';

/** Dev-only: Session row status at Lines 1, 2 and 3 (lab ideas-1118-shell scene 7). `?only=phone` draws Lines 2 alone. */
export default function SessionRowsDevScreen() {
    const params = useLocalSearchParams<{ only?: string }>();
    return <SessionRowStatusSpecimen only={typeof params.only === 'string' ? params.only : null} />;
}
