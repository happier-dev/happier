import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { HealthNoticeSpecimen } from '@/components/dev/inbox/HealthNoticeSpecimen';

/** Dev-only: a failing-service Inbox notice. `?outcome=approval|placement|selection|uncertain|unavailable|notSetUp`, `?recovered=1`, `?machine=<id>`, `?kind=sentry`, `?eligible=0`. */
export default function HealthNoticeDevScreen() {
    const params = useLocalSearchParams<{ outcome?: string; recovered?: string; machine?: string; kind?: string; eligible?: string }>();
    return <HealthNoticeSpecimen outcome={params.outcome ?? 'opened'} recovered={params.recovered === '1'}
        machineId={params.machine ?? 'machine-specimen'} kind={params.kind === 'sentry' ? 'sentry' : 'service'}
        eligible={params.eligible !== '0'} />;
}
