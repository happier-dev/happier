import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { AllDeploymentsSpecimen } from '@/components/dev/deployments/AllDeploymentsSpecimen';

/** Dev-only: Projects → All deployments over fixture data. `?state=populated|loading|empty|partial|paged|error|denied|stale`. */
export default function AllDeploymentsDevScreen() {
    const params = useLocalSearchParams<{ state?: string; columns?: string }>();
    return <AllDeploymentsSpecimen state={params.state ?? 'populated'} requestsColumn={params.columns === 'requests'} />;
}
