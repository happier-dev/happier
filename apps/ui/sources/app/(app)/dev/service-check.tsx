import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ServiceCheckKeyFlowSpecimen } from '@/components/dev/deployments/ServiceCheckKeyFlowSpecimen';

/** Dev-only: a Key flow check's page and the Checks list (lab p7Flows/p7Surfaces). `?state=failing|unknown|passing`, `?view=page|list|cards`. */
export default function ServiceCheckDevScreen() {
    const params = useLocalSearchParams<{ state?: string; view?: string }>();
    const state = params.state === 'unknown' || params.state === 'passing' ? params.state : 'failing';
    const view = params.view === 'list' || params.view === 'cards' ? params.view : 'page';
    return <ServiceCheckKeyFlowSpecimen state={state} view={view} />;
}
