import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { MachineSignInsSpecimen } from '@/components/dev/machines/MachineSignInsSpecimen';

/** Dev-only: the Setup tab's Sign-ins (lab L10) and its shared-OS-user warning. `?state=list|warning`. */
export default function MachineSignInsDevScreen() {
    const params = useLocalSearchParams<{ state?: string }>();
    return <MachineSignInsSpecimen state={params.state === 'warning' ? 'warning' : 'list'} />;
}
