import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { IsolationRecoverySpecimen } from '@/components/dev/inbox/IsolationRecoverySpecimen';

/** Dev-only: the Agent isolation change that settled "not confirmed", over the reconnect CHECK's answer. `?state=needs|satisfied|off|applying|unavailable`. */
export default function IsolationRecoveryDevScreen() {
    const params = useLocalSearchParams<{ state?: string }>();
    return <IsolationRecoverySpecimen state={typeof params.state === 'string' ? params.state : 'needs'} />;
}
