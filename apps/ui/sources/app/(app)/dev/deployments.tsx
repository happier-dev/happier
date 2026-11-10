import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { DeploymentsSpecimen } from '@/components/dev/deployments/DeploymentsSpecimen';

/** Dev-only: Project → Deployments over fixture data. `?state=empty|error|loading`, `?receipt=<receipt state>`, `?deploy=unsupported|denied|offline|started|conflict`, `?machine=<name part>`, `?cancellable=true|false`, `?tabs=populated|empty|loading|error|denied|paged|failing|notNeeded|team`, `?restore=restored|rolledBack|unknown|recovery|stale|empty`, `?preview=unset|linked|enrollment`. */
export default function DeploymentsDevScreen() {
    const params = useLocalSearchParams<{ state?: string; receipt?: string; deploy?: string; machine?: string; cancellable?: string; tabs?: string; restore?: string; preview?: string }>();
    return <DeploymentsSpecimen state={params.state ?? 'populated'} receipt={params.receipt ?? 'succeeded'} deploy={params.deploy} machine={params.machine} cancellable={params.cancellable} tabs={params.tabs} restore={params.restore} preview={params.preview} />;
}
