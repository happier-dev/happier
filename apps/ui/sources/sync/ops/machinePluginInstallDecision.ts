import {
    HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
    HostPrivatePluginInstallDecisionV1Schema,
    type HostPrivatePluginInstallDecisionV1,
} from '@happier-dev/protocol/marketplace/internal';
import { isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpc';

import { randomUUID } from '@/platform/randomUUID';
import { decideMachinePluginInstallReviewAsPresentUser } from '@/sync/ops/machinePluginInstallPresentUserDecision.mjs';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type PositiveDecision = Omit<
    Extract<HostPrivatePluginInstallDecisionV1, Readonly<{ decision: 'installAndTrust' }>>,
    'v' | 'actorEvidence' | 'optionalSelections'
> & Readonly<{
    confirmPresentUser: () => Promise<
        readonly Readonly<{ accessId: string; selected: boolean }>[] | null
    >;
}>;
type CancelDecision = Omit<
    Extract<HostPrivatePluginInstallDecisionV1, Readonly<{ decision: 'cancel' }>>,
    'v'
>;

export type MachinePluginInstallDecisionInput = PositiveDecision | CancelDecision;

export type MachinePluginInstallDecisionOutcome = Readonly<{
    kind: 'committed' | 'failed' | 'conflict' | 'expired' | 'cancelled' | 'unavailable' | 'outcomeUnknown' | 'busy';
    detail: string | null;
}>;

export type MachinePluginInstallDecisionResult =
    | Readonly<{ supported: true; outcome: MachinePluginInstallDecisionOutcome }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function parseOutcome(value: unknown): MachinePluginInstallDecisionOutcome | null {
    if (!isRecord(value)) return null;
    const kind = value.kind;
    if (
        kind !== 'committed'
        && kind !== 'failed'
        && kind !== 'conflict'
        && kind !== 'expired'
        && kind !== 'cancelled'
        && kind !== 'unavailable'
        && kind !== 'outcomeUnknown'
        && kind !== 'busy'
    ) {
        return null;
    }
    return {
        kind,
        detail: readNonEmptyString(value.message) ?? readNonEmptyString(value.code),
    };
}

export async function machinePluginInstallDecision(
    machineId: string,
    opts: Readonly<{
        serverId?: string | null;
        timeoutMs?: number | null;
        isAuthorityCurrent: () => boolean;
        decision: MachinePluginInstallDecisionInput;
    }>,
): Promise<MachinePluginInstallDecisionResult> {
    try {
        let rawPayload: unknown;
        if (opts.decision.decision === 'installAndTrust') {
            const affirmativeDecision = opts.decision;
            const { confirmPresentUser, ...decision } = affirmativeDecision;
            rawPayload = await decideMachinePluginInstallReviewAsPresentUser({
                pendingChangeId: decision.pendingChangeId,
                confirmPresentUser,
                isAuthorityCurrent: opts.isAuthorityCurrent,
                createInteractionId: randomUUID,
                nowMs: Date.now,
                callAuthenticatedPrivateRpc: async (method, payload) => await machineRpcWithServerScope({
                    machineId,
                    serverId: opts.serverId ?? undefined,
                    timeoutMs: opts.timeoutMs ?? undefined,
                    method,
                    payload,
                }),
            });
        } else {
            if (!opts.isAuthorityCurrent()) {
                return { supported: false, reason: 'error' };
            }
            rawPayload = { v: 1, ...opts.decision };
            const payload = HostPrivatePluginInstallDecisionV1Schema.parse(rawPayload);
            rawPayload = await machineRpcWithServerScope<unknown, typeof payload>({
                machineId,
                serverId: opts.serverId ?? undefined,
                timeoutMs: opts.timeoutMs ?? undefined,
                method: HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
                payload,
            });
        }
        const response = rawPayload;
        if (isRpcMethodNotFoundResult(response)) {
            return { supported: false, reason: 'not-supported' };
        }
        const outcome = parseOutcome(response);
        return outcome
            ? { supported: true, outcome }
            : { supported: false, reason: 'error' };
    } catch {
        return { supported: false, reason: 'error' };
    }
}
