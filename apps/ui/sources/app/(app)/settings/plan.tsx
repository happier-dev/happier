import * as React from 'react';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';

import { PlanSupporterScreen } from '@/components/settings/plans/PlanSupporterScreen';
import { usePlanSurfaceVisibility } from '@/components/settings/plans/usePlanSurfaceVisibility';

// The page draws its own large title (lab sp3Plan); the header keeps only the way back.
const SCREEN_OPTIONS = { headerTitle: '' } as const;

export default function PlanSupporterRoute() {
    const visibility = usePlanSurfaceVisibility();
    const params = useLocalSearchParams<{ supporterCode?: string; offer?: string }>();
    if (!visibility.visible) {
        // Both bits off: the page does not exist on this server and a direct link lands on Settings.
        return visibility.resolved ? <Redirect href="/settings" /> : null;
    }
    return (
        <>
            <Stack.Screen options={SCREEN_OPTIONS} />
            <PlanSupporterScreen
                plans={visibility.plans}
                supporter={visibility.supporter}
                prefilledSupporterCode={typeof params.supporterCode === 'string' ? params.supporterCode : null}
                showSupporterOffer={params.offer === 'supporter'}
            />
        </>
    );
}
