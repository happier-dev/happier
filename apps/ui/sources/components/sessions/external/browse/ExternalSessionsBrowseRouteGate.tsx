import * as React from 'react';

import type { FeatureDecisionScopeParams } from '@/hooks/server/useFeatureDecision';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';

export function ExternalSessionsBrowseRouteGate(props: React.PropsWithChildren<Readonly<{
    scope?: FeatureDecisionScopeParams;
}>>): React.ReactElement | null {
    const decision = useFeatureDecision('sessions.direct', props.scope);

    if (decision?.state !== 'enabled') {
        return null;
    }

    return <>{props.children}</>;
}
