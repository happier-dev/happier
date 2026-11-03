import * as React from 'react';

import { getCurrentAuth } from '@/auth/context/currentAuth';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { writeClipboardStringFromUi } from '@/utils/ui/clipboard';

/** Copy controls retain their source Account and the mounted Action's approval lifetime. */
export function useClipboardWrite(
    scope?: ServerAccountScope | string | null,
    options?: Readonly<{ enabled?: boolean }>,
) {
    const [pendingCount, setPendingCount] = React.useState(0);
    // An open copy control demands its Home. Keep that same demand through a
    // pending native approval after the menu closes, then release it.
    const demanded = options?.enabled !== false || pendingCount > 0;
    const active = useActiveServerSnapshot(scope === undefined && demanded);
    const execution = useMountedActionExecution(demanded ? (scope === undefined ? active.serverId : scope) : null,
        { retainInvocation: true });
    const localExecution = React.useMemo(() => createFrontDoorActionExecute(), []);
    return React.useCallback(async (text: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<boolean> => {
        if (options?.signal?.aborted) return false;
        setPendingCount((count) => count + 1);
        try {
            const result = await writeClipboardStringFromUi(text, (actionId, input) => {
                const auth = getCurrentAuth();
                // Pairing, public shares and signed-out setup have no Account lifetime.
                // Keep the native effect below the same Action policy front door;
                // an explicitly qualified Account must never borrow this local path.
                const accountFreeSource = scope === undefined || scope === null
                    || (typeof scope === 'string' && execution.resolution.kind === 'signed_out');
                return accountFreeSource && auth?.isAuthenticated === false && auth.credentialAuthorityKind === 'none'
                    ? localExecution(actionId, input, { surface: 'ui', actionCaller: { kind: 'host' },
                        signal: options?.signal ?? execution.getSignal() })
                    : execution.execute(actionId, input, options);
            });
            return result.ok && typeof result.result === 'object' && result.result !== null
                && 'status' in result.result && result.result.status === 'copied';
        } catch {
            return false;
        } finally {
            setPendingCount((count) => count - 1);
        }
    }, [execution.execute, execution.getSignal, execution.resolution.kind, localExecution, scope]);
}
