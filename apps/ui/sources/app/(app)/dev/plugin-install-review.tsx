import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { PluginInstallReviewSpecimen } from '@/components/dev/plugins/PluginInstallReviewSpecimen';

/** Dev-only: the combined plugin install review over stored fixture approvals. `?state=review|settled|single`, `?machine=<id>` for `single`. */
export default function PluginInstallReviewDevScreen() {
    const params = useLocalSearchParams<{ state?: string; machine?: string }>();
    return <PluginInstallReviewSpecimen state={params.state ?? 'review'} machineId={params.machine} />;
}
