import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { DeployReviewSpecimen } from '@/components/dev/deployments/DeployReviewSpecimen';

/** Dev-only: the deploy approval page over a stored approval. `?variant=review|multi|promotion|desktop|plain`, `?machine=<id>`. */
export default function DeployReviewDevScreen() {
    const params = useLocalSearchParams<{ variant?: string; machine?: string }>();
    return <DeployReviewSpecimen variant={params.variant ?? 'review'} machineId={params.machine ?? 'machine-specimen'} />;
}
