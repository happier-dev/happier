import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { TeamSharedSpecimen } from '@/components/dev/teams/TeamSharedSpecimen';

/** Dev-only: Team overview "Shared with this Team" (lab L12). `?state=overview|empty|unknown|loading|failed`. */
export default function TeamSharedDevScreen() {
    const params = useLocalSearchParams<{ state?: string }>();
    return <TeamSharedSpecimen state={typeof params.state === 'string' ? params.state : null} />;
}
