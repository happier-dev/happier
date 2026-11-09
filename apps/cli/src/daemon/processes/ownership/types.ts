import type { ProcessOwnerRef } from '@/processes/ownerTag';
import type { ProcessStartIdentity } from '@/processes/census/processCensus';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { ProcessActionExecution } from '../actions/processActionExecutor';
import type { MachineProcessesStartAgainResultV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';

export type { ProcessOwnerRef } from '@/processes/ownerTag';
export type HappierProcessRoot = Readonly<{
    owner: ProcessOwnerRef;
    pid: number;
    start: ProcessStartIdentity;
    live: boolean;
    /** Current native generation has an existing lifecycle stop request in flight. */
    state?: 'stopping';
    ownerCreatedAtMs: number;
    /** Linux's persisted witness is boot-relative; compare in that clock domain. */
    ownerCreatedStartTimeMs?: number;
    endedAtMs?: number;
    workspacePath?: string;
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
    containment?: Readonly<{ kind: 'linux_unit' | 'linux_container'; prefix: string }> | Readonly<{ kind: 'windows_job'; name: string }>;
    stop?: () => void | Promise<unknown>;
    startAgain?: (execution: ProcessActionExecution) => Promise<MachineProcessesStartAgainResultV1>;
}>;
export type ProcessEvidenceReasonCode =
    | 'linux_scope' | 'linux_container' | 'windows_job' | 'macos_no_fence' | 'no_systemd_user_manager' | 'job_join_failed'
    | 'outside_fence' | 'live_root_chain' | 'chain_broken_at_exit' | 'no_live_root'
    | 'marker_matches' | 'marker_cleared' | 'foreign_home_marker'
    | 'marker_owner_unknown' | 'marker_predates_owner' | 'same_group_port_opened_while_running'
    | 'no_group_or_port_match' | 'principal_unreadable' | 'other_principal' | 'required_fields_unreadable';
export type ProcessEvidence = Readonly<{
    kind: 'fence' | 'parent_chain' | 'marker' | 'group_and_port';
    state: 'met' | 'not_met' | 'not_available';
    reason: ProcessEvidenceReasonCode;
    at?: Readonly<{ pid: number; exitedAtMs?: number }>;
}>;
export type ProcessOwnershipLevel = 'proven' | 'likely' | 'left_behind' | 'not_happier' | 'unknown';
export type ResolvedProcessOwnership = Readonly<{
    pid: number; start: ProcessStartIdentity; owner: ProcessOwnerRef | null; ownerEnded: boolean;
    level: ProcessOwnershipLevel; evidence: readonly ProcessEvidence[];
    chain: readonly Readonly<{ pid: number; name: string; exitedAtMs?: number }>[];
    workspacePath?: string;
}>;
export type ListenerFact = Readonly<{ pid?: number; port: number }>;

/** Native service authority is not interchangeable with raw Machine process control. */
export function resolveRawProcessControlRefusal(owner: ProcessOwnerRef | null): 'native_service_control_required' | null {
    return owner?.kind === 'container' ? 'native_service_control_required' : null;
}

export function processOwnerKey(owner: ProcessOwnerRef): string {
    switch (owner.kind) {
        case 'session': return `session:${owner.sessionId}`;
        case 'terminal': return `terminal:${owner.terminalId}`;
        case 'service': return `service:${owner.serviceId}`;
        case 'container': return `container:${JSON.stringify([owner.serverId, owner.machineId, owner.serviceId, owner.containerId])}`;
        case 'run': return `run:${owner.runId}`;
        case 'happier': return `happier:${owner.component ?? 'daemon'}`;
        default: return owner.kind;
    }
}
export function equalProcessStart(a: ProcessStartIdentity, b: ProcessStartIdentity): boolean {
    return a.startTimeMs === b.startTimeMs && (!a.native || !b.native || a.native === b.native);
}
