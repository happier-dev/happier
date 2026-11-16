import * as React from 'react';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

/**
 * New Session is open with this Machine selected: one call stays open while the intent lasts, so the
 * Machine's daemon has its session host started (runner code loaded) before Start. Picking another
 * Machine or closing New Session cancels it, and the daemon lets an unused host end. No polling; a
 * refused or failed call is not retried (the Session still starts, only without the head start).
 */
export function useNewSessionIntent(input: Readonly<{
    machineId: string | null;
    binding: ServerCredentialAccountScopeBinding | null | undefined;
    enabled: boolean;
}>): void {
    const { binding, machineId, enabled } = input;
    const key = JSON.stringify([binding?.scope, binding?.revision, machineId, enabled]);
    const bindingRef = React.useRef(binding);
    bindingRef.current = binding;
    React.useEffect(() => {
        const current = bindingRef.current;
        if (!enabled || !machineId || !current) return;
        const controller = new AbortController();
        machineRpcWithServerScope({ machineId, serverId: current.serverId, accountId: current.accountId,
            method: RPC_METHODS.DAEMON_SESSION_CREATION_INTENT, payload: {}, signal: controller.signal, operationTimeoutMs: null,
        }).catch(() => {
            // Advisory: the machine RPC owner records reachability; an older daemon answers method-not-found.
        });
        return () => controller.abort();
    }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- `key` names every input that changes the call
}
