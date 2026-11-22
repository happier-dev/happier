import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import {
    SessionStartFailureSpecimen,
    type SessionStartFailureSpecimenCause,
} from '@/components/dev/sessions/SessionStartFailureSpecimen';

const CAUSES: readonly SessionStartFailureSpecimenCause[] = ['retry', 'blocked', 'plugin', 'model', 'teamRefusal'];

/** Dev-only: the Session start-failure notice. `?cause=retry|blocked|plugin|model|teamRefusal` (default: all). */
export default function SessionStartFailureDevScreen() {
    const params = useLocalSearchParams<{ cause?: string }>();
    const cause = CAUSES.find(value => value === params.cause) ?? 'all';
    return <SessionStartFailureSpecimen cause={cause} />;
}
