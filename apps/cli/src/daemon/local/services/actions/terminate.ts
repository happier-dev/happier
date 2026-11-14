import type { LocalServiceActionRequestV1 } from '@happier-dev/protocol';

import type { ProcessTreeTerminationInput, ProcessTreeTerminationOutcome, ProcessTreeTerminationResult } from '@/processes/terminate/terminateProcessTree';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import type { LocalServiceActionExecutionOutcome } from './executor';

/** Listener identity and port-release verification surround the single shared tree terminator. */
export type TerminateProcessIdentity = Readonly<{
    pid: number;
    startTime?: number;
    command?: string;
    cwd?: string;
}>;

export type TerminateListenerProbeInput = Readonly<{
    host: string;
    port: number;
    /** An in-flight inventory scan started before this timestamp cannot verify this action. */
    notBefore?: number;
}>;

export type TerminateListenerProbeResult =
    | Readonly<{ status: 'held'; identity: TerminateProcessIdentity }>
    | Readonly<{ status: 'free' }>
    | Readonly<{ status: 'indeterminate' }>;

export type TerminateProcessControl = Readonly<{
    probeListener(input: TerminateListenerProbeInput): Promise<TerminateListenerProbeResult>;
    terminateTree(input: ProcessTreeTerminationInput): Promise<ProcessTreeTerminationResult>;
}>;

export type TerminateDetectedServiceConfig = Readonly<{
    /** Override the shared terminator's dev-server grace budget. */
    graceMs?: number;
}>;

export type TerminateDetectedServiceInput = Readonly<{
    request: LocalServiceActionRequestV1;
    entry: NormalizedLocalServiceInventoryEntry;
    now: number;
    /** An already-approved containing Action supplies fresh native fact checks, not another approval. */
    execution?: Readonly<{ signal?: AbortSignal; tree?: boolean; authorizeSnapshot?: ProcessTreeTerminationInput['authorizeSnapshot']; authorizeSignal?: ProcessTreeTerminationInput['authorizeSignal'] }>;
}>;

export type TerminateDetectedService = (input: TerminateDetectedServiceInput) => Promise<LocalServiceActionExecutionOutcome>;

function identityMatches(expected: TerminateProcessIdentity, actual: TerminateProcessIdentity): boolean {
    if (actual.pid !== expected.pid) return false;
    if (typeof expected.startTime === 'number' && actual.startTime !== expected.startTime) return false;
    if (expected.command && actual.command && expected.command !== actual.command) return false;
    if (expected.cwd && actual.cwd && expected.cwd !== actual.cwd) return false;
    return true;
}

function isPortReleased(probe: TerminateListenerProbeResult, identity: TerminateProcessIdentity): boolean {
    if (probe.status === 'free') return true;
    return probe.status === 'held' && (probe.identity.pid !== identity.pid
        || (typeof identity.startTime === 'number' && typeof probe.identity.startTime === 'number'
            && probe.identity.startTime !== identity.startTime));
}

function refusedOutcome(outcome: ProcessTreeTerminationOutcome): LocalServiceActionExecutionOutcome {
    switch (outcome.reason) {
        case 'native_service_control_required': return { status: 'denied', reasonCode: 'native_service_control_required' };
        case 'ownership_unavailable': return { status: 'denied', reasonCode: 'process_identity_unavailable' };
        case 'identity_changed': return { status: 'denied', reasonCode: 'identity_changed' };
        case 'protected_process': return { status: 'denied', reasonCode: 'protected_process' };
        case 'permission_denied': return { status: 'failed', reasonCode: 'terminate_permission_denied' };
        case 'signal_failed': return { status: 'failed', reasonCode: 'terminate_signal_failed' };
        default: return { status: 'failed', reasonCode: 'process_tree_unresolved' };
    }
}

export function createTerminateDetectedService(
    control: TerminateProcessControl,
    config: TerminateDetectedServiceConfig = {},
): TerminateDetectedService {
    return async ({ request, entry, now, execution }) => {
        if (execution?.signal?.aborted) return { status: 'denied', reasonCode: 'access_denied' };
        const provenance = entry.provenance?.process;
        const pid = provenance?.pid;
        if (!provenance || typeof pid !== 'number') return { status: 'denied', reasonCode: 'process_identity_unavailable' };
        if (!Number.isInteger(pid) || pid <= 1) return { status: 'denied', reasonCode: 'unsafe_pid' };

        const probeInput: TerminateListenerProbeInput = { host: entry.address.host, port: entry.port };
        const expected: TerminateProcessIdentity = {
            pid,
            ...(typeof provenance.processStartTimeMs === 'number' ? { startTime: provenance.processStartTimeMs } : {}),
            ...(provenance.command ? { command: provenance.command } : {}),
            ...(provenance.cwd ? { cwd: provenance.cwd } : {}),
        };
        const current = await control.probeListener({ ...probeInput, notBefore: now });
        if (execution?.signal?.aborted) return { status: 'denied', reasonCode: 'access_denied' };
        if (current.status === 'indeterminate') return { status: 'failed', reasonCode: 'listener_state_unverifiable' };
        if (current.status === 'free') return { status: 'succeeded' };
        if (!identityMatches(expected, current.identity)) return { status: 'denied', reasonCode: 'identity_changed' };

        let result: ProcessTreeTerminationResult;
        try {
            result = await control.terminateTree({
                targets: [{ pid, ...(typeof current.identity.startTime === 'number' ? { start: { startTimeMs: current.identity.startTime } } : {}) }],
                tree: execution?.tree ?? true,
                policy: request.force ? 'kill' : 'stop',
                rootKind: 'dev_server',
                ...(execution ? { authorizeSnapshot: async (snapshot, targets) => !execution.signal?.aborted
                    && (!execution.authorizeSnapshot || await execution.authorizeSnapshot(snapshot, targets))
                    && !execution.signal?.aborted,
                    authorizeSignal: async () => !execution.signal?.aborted
                        && (!execution.authorizeSignal || await execution.authorizeSignal()) && !execution.signal?.aborted } : {}),
                ...(config.graceMs === undefined ? {} : { graceMs: config.graceMs }),
            });
        } catch {
            return { status: 'failed', reasonCode: 'terminate_signal_failed' };
        }
        const refused = result.outcomes.find(outcome => outcome.outcome === 'refused');
        if (refused) return refusedOutcome(refused);
        if (result.status === 'unavailable') return { status: 'failed', reasonCode: 'process_tree_unresolved' };
        if (!result.outcomes.some(outcome => outcome.pid === pid)) return { status: 'failed', reasonCode: 'process_tree_unresolved' };
        const survived = result.outcomes.some(outcome => outcome.outcome === 'survived');
        const ended = result.outcomes.some(outcome => outcome.outcome === 'ended');

        // Tree liveness and generation verification belong to the shared terminator. The
        // listener owner only verifies its socket after that operation has completed.
        const notBefore = Date.now();
        const after = await control.probeListener({ ...probeInput, notBefore });
        if (isPortReleased(after, current.identity)) {
            return survived ? { status: 'failed', reasonCode: 'terminate_signal_failed' } : { status: 'succeeded' };
        }
        if (after.status === 'indeterminate') return { status: 'failed', reasonCode: 'port_release_unverified' };
        return { status: 'failed', reasonCode: ended || survived ? 'port_not_released' : 'terminate_no_process_signaled' };
    };
}
