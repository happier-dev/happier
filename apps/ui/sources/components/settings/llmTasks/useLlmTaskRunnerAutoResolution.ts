import * as React from 'react';
import type { LlmTaskPermissionMode } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import type { LlmTaskIdV1, LlmTaskRunnerResolutionWireV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerSelection';

import { useSetting } from '@/sync/domains/state/storage';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readLlmTaskRunnerResolutionForMachine } from '@/sync/ops/actions/llmTaskRunnerResolution';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export type LlmTaskRunnerAutoResolutionState =
    | Readonly<{ status: 'idle' }>
    | Readonly<{ status: 'checking'; last: LlmTaskRunnerResolutionWireV1 | null }>
    | Readonly<{ status: 'ready'; resolution: LlmTaskRunnerResolutionWireV1 }>
    | Readonly<{ status: 'failed'; last: LlmTaskRunnerResolutionWireV1 | null }>;

const IDLE: LlmTaskRunnerAutoResolutionState = Object.freeze({ status: 'idle' });

type Observation = Readonly<{ key: string; lifetime: ServerAccountScopeLifetime; resolution: LlmTaskRunnerResolutionWireV1 | null; failed: boolean }>;

/**
 * What Auto picks for a task on one Machine, read from that Machine's runner owner. It reads only while
 * the row shows Auto, keeps the last answer for the same Machine and Account while it re-reads, and
 * re-reads when the enabled Agents change.
 */
export function useLlmTaskRunnerAutoResolution(params: Readonly<{
    task: LlmTaskIdV1;
    machineId: string | null;
    serverId: string | null;
    permissionMode: LlmTaskPermissionMode;
    /** The Session's own Agent, when the surface has one; it wins Auto's cost ties. */
    sessionAgentTargetKey: string | null;
    enabled: boolean;
}>): LlmTaskRunnerAutoResolutionState {
    const bindings = useServerCredentialAccountScopeBindings(params.serverId ? [params.serverId] : []);
    const lifetime = params.serverId ? bindings.values().next().value ?? null : null;
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const key = JSON.stringify([params.task, params.machineId, params.serverId, params.permissionMode, params.sessionAgentTargetKey]);
    const [observation, setObservation] = React.useState<Observation | null>(null);
    const [checking, setChecking] = React.useState(false);
    const active = params.enabled && params.machineId !== null && params.serverId !== null && lifetime !== null;

    React.useEffect(() => {
        if (!active || !params.machineId || !params.serverId || !lifetime) return;
        const { machineId, serverId, task, permissionMode, sessionAgentTargetKey } = params;
        const abort = new AbortController();
        let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
        setChecking(true);
        void (async () => {
            let resolution: LlmTaskRunnerResolutionWireV1 | null = null;
            try {
                account = await captureLazyActionAccountContext(serverId, abort.signal);
                if (abort.signal.aborted || !lifetime.isCurrent()) return;
                resolution = await readLlmTaskRunnerResolutionForMachine(account, {
                    machineId, task, choice: { v: 1, mode: 'auto', permissionMode }, sessionAgentTargetKey, signal: abort.signal,
                });
            } catch {
                resolution = null;
            } finally {
                account?.dispose();
            }
            if (abort.signal.aborted || !lifetime.isCurrent()) return;
            setObservation(previous => ({ key, lifetime,
                // A failed read keeps the last answer for the same Machine and Account.
                resolution: resolution ?? (previous?.key === key && previous.lifetime === lifetime ? previous.resolution : null),
                failed: resolution === null }));
            setChecking(false);
        })();
        return () => { abort.abort(); account?.dispose(); };
    }, [active, key, lifetime, backendEnabledByTargetKey]);

    const current = observation && observation.key === key && observation.lifetime === lifetime ? observation : null;
    const status = !active ? 'idle' : checking || !current ? 'checking' : current.failed || !current.resolution ? 'failed' : 'ready';
    const resolution = current?.resolution ?? null;
    return React.useMemo((): LlmTaskRunnerAutoResolutionState => {
        if (status === 'idle') return IDLE;
        if (status === 'ready' && resolution) return { status, resolution };
        return { status: status === 'ready' ? 'failed' : status, last: resolution };
    }, [status, resolution]);
}
