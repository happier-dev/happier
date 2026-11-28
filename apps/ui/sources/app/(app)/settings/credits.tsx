import * as React from 'react';
import { Redirect } from 'expo-router';

import { CreditsScreen } from '@/components/settings/credits/CreditsScreen';
import { usePlanSurfaceVisibility } from '@/components/settings/plans/usePlanSurfaceVisibility';

export default function CreditsRoute() {
    const visibility = usePlanSurfaceVisibility();
    if (!visibility.supporter) return visibility.resolved ? <Redirect href="/settings" /> : null;
    return <CreditsScreen />;
}
