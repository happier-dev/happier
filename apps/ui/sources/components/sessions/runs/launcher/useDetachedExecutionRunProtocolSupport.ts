import * as React from 'react';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createUiExecutionRunActionDeps } from '@/sync/ops/actions/executionRunActionDeps';

type ProtocolSupport = Awaited<ReturnType<NonNullable<ActionExecutorDeps['executionRunCheckProtocolV2']>>>;

/** Read the same Describe-based support result as launch admission, only for a mounted detached draft. */
export function useDetachedExecutionRunProtocolSupport(machineId: string | null, scope: ServerAccountScope | null): ProtocolSupport | null {
    const [observation, setObservation] = React.useState<Readonly<{
        machineId: string;
        scope: ServerAccountScope;
        result: ProtocolSupport;
    }> | null>(null);

    React.useEffect(() => {
        if (!machineId || !scope) return;
        const controller = new AbortController();
        void (async () => {
            const result = await createUiExecutionRunActionDeps(scope).executionRunCheckProtocolV2?.(null, {
                detachedScope: true, startAndWait: false, exactInputResults: true,
                runScopedAgentBindings: false, secretReferenceOverlay: false,
            }, { serverId: scope.serverId, targetMachineId: machineId, signal: controller.signal });
            if (result && !controller.signal.aborted) setObservation({ machineId, scope, result });
        })();
        return () => controller.abort();
    }, [machineId, scope]);

    return observation?.machineId === machineId && observation.scope === scope ? observation.result : null;
}
