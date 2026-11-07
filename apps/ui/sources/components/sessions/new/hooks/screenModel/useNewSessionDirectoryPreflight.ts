import * as React from 'react';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionCreationTargetPreparationResultV1Schema, projectSessionCreationTargetPreparationRpcFailureV1,
    type SessionCreationTargetPreparationResultV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';

import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type RpcFailure = NonNullable<ReturnType<typeof projectSessionCreationTargetPreparationRpcFailureV1>>;
type RpcLaunchFailure = Extract<RpcFailure, { launchError?: unknown }>;
type DirectoryFailureCode = Extract<SessionCreationTargetPreparationResultV1, { ok: false }>['code']
    | NonNullable<RpcLaunchFailure['launchError']>['code'] | 'unavailable';
export type NewSessionDirectoryPreflight = Readonly<{ ready: boolean; code: DirectoryFailureCode | null }>;

function readRpcFailureCode(raw: unknown): DirectoryFailureCode {
    const failure = projectSessionCreationTargetPreparationRpcFailureV1(raw);
    return failure && 'launchError' in failure ? failure.launchError?.code ?? 'unavailable' : 'unavailable';
}

/** A finite read at the Agent's filesystem boundary, only for separated paths.
 * Folder edits cancel the previous read; there is no polling. */
export function useNewSessionDirectoryPreflight(input: Readonly<{
    machineId: string | null;
    binding: ServerCredentialAccountScopeBinding | null | undefined;
    enabled: boolean;
    requesterReady: boolean;
    path: string;
}>): NewSessionDirectoryPreflight {
    const { binding, machineId, path, enabled, requesterReady } = input;
    const key = JSON.stringify([binding?.scope, binding?.revision, machineId, path, enabled, requesterReady]);
    const [state, setState] = React.useState<Readonly<{ key: string; code: DirectoryFailureCode | null }> | null>(null);
    React.useEffect(() => {
        if (!enabled || !requesterReady || !machineId || !path || !binding) return;
        const controller = new AbortController();
        const current = () => !controller.signal.aborted && binding.isCurrent();
        void machineRpcWithServerScope({ machineId, serverId: binding.serverId, accountId: binding.accountId,
            method: RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
            payload: { directory: { kind: 'path', path } }, signal: controller.signal, operationTimeoutMs: null,
        }).then(raw => {
            if (!current()) return;
            const result = SessionCreationTargetPreparationResultV1Schema.safeParse(raw);
            setState({ key, code: result.success ? result.data.ok ? null : result.data.code
                : readRpcFailureCode(raw) });
        }, error => { if (current()) setState({ key,
            code: readRpcFailureCode(error) }); });
        return () => controller.abort();
    }, [binding, enabled, key, machineId, path, requesterReady]);
    if (!enabled) return { ready: true, code: null };
    if (!binding?.isCurrent() || !state || state.key !== key) return { ready: false, code: null };
    return { ready: state.code === null, code: state.code };
}
