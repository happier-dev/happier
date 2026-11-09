import * as React from 'react';
import type { TriggerTargetV1 } from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { buildTriggerWorkflowSeed, storeTriggerWorkflowSeed, type TriggerRetarget } from './triggerWorkflowSeed';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** Save as workflow: opens a trigger's own steps as an unsaved workflow draft (`/workflows/new`). */
export function useOpenTriggerAsWorkflow(accountLifetime?: ServerAccountScopeLifetime | null): (target: TriggerTargetV1, retarget: TriggerRetarget) => void {
    const router = useRouter();
    return React.useCallback((target, retarget) => {
        const seed = buildTriggerWorkflowSeed(target, retarget);
        if (seed === null) return;
        if (accountLifetime !== undefined && !accountLifetime?.isCurrent()) return;
        router.push({ pathname: '/workflows/new', params: { triggerWorkflowSeedId: storeTriggerWorkflowSeed(seed, accountLifetime),
            ...(accountLifetime ? { serverId: accountLifetime.scope.serverId } : {}) } } as never);
    }, [router, accountLifetime]);
}
