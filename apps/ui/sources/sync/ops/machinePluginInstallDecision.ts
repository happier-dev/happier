import {
    HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
    HostPrivatePluginInstallDecisionV1Schema,
    type HostPrivatePluginInstallDecisionV1,
} from '@happier-dev/protocol/marketplace/internal';
import { isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpc';

import { randomUUID } from '@/platform/randomUUID';
import {
    decideMachinePluginDevelopmentSourceRootAsPresentUser,
    decideMachinePluginInstallReviewAsPresentUser,
} from '@/sync/ops/machinePluginInstallPresentUserDecision.mjs';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type PositiveDecision = Omit<
    Extract<HostPrivatePluginInstallDecisionV1, Readonly<{ decision: 'installAndTrust' }>>,
    'v' | 'actorEvidence' | 'optionalSelections'
> & Readonly<{
    confirmPresentUser: () => Promise<
        readonly Readonly<{ accessId: string; selected: boolean }>[] | null
    >;
}>;
type TrustSourceRootDecision = Omit<
    Extract<HostPrivatePluginInstallDecisionV1, Readonly<{ decision: 'trustSourceRoot' }>>,
    'v' | 'actorEvidence'
> & Readonly<{
    confirmPresentUser: () => Promise<boolean>;
}>;
type CancelDecision = Omit<
    Extract<HostPrivatePluginInstallDecisionV1, Readonly<{ decision: 'cancel' }>>,
    'v'
>;

export type MachinePluginInstallDecisionInput =
    | PositiveDecision
    | TrustSourceRootDecision
    | CancelDecision;

export type MachinePluginInstallDecisionOutcome = Readonly<{
    kind:
        | 'committed'
        | 'failed'
        | 'conflict'
        | 'expired'
        | 'cancelled'
        | 'unavailable'
        | 'outcomeUnknown'
        | 'busy'
        | 'reviewRequired';
    detail: string | null;
    /**
     * The daemon's own change payload, retained verbatim **only** for the one
     * outcome that carries a follow-up decision, so a multi-step review
     * (source-root trust answered with an install-and-trust review) is read by
     * the caller's canonical change reader instead of being re-modelled here.
     * Terminal outcomes stay a bare `{ kind, detail }` result.
     */
    change?: unknown;
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
        && kind !== 'reviewRequired'
    ) {
        return null;
    }
    const detail = readNonEmptyString(value.message) ?? readNonEmptyString(value.code);
    return kind === 'reviewRequired' ? { kind, detail, change: value } : { kind, detail };
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
        const callAuthenticatedPrivateRpc = async (
            method: typeof HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
            payload: HostPrivatePluginInstallDecisionV1,
        ) => await machineRpcWithServerScope({
            machineId,
            serverId: opts.serverId ?? undefined,
            timeoutMs: opts.timeoutMs ?? undefined,
            method,
            payload,
        });
        if (opts.decision.decision === 'trustSourceRoot') {
            const { confirmPresentUser, pendingChangeId } = opts.decision;
            rawPayload = await decideMachinePluginDevelopmentSourceRootAsPresentUser({
                pendingChangeId,
                confirmPresentUser,
                isAuthorityCurrent: opts.isAuthorityCurrent,
                createInteractionId: randomUUID,
                nowMs: Date.now,
                callAuthenticatedPrivateRpc,
            });
        } else if (opts.decision.decision === 'installAndTrust') {
            const affirmativeDecision = opts.decision;
            const { confirmPresentUser, ...decision } = affirmativeDecision;
            rawPayload = await decideMachinePluginInstallReviewAsPresentUser({
                pendingChangeId: decision.pendingChangeId,
                confirmPresentUser,
                isAuthorityCurrent: opts.isAuthorityCurrent,
                createInteractionId: randomUUID,
                nowMs: Date.now,
                callAuthenticatedPrivateRpc,
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
