import { randomUUID } from "node:crypto";

import {
    type ActionExecuteResult,
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    type ExternalActionRequestEnvelopeV1,
} from "@happier-dev/protocol/actions";
import { ACTION_API_SERVER_ORIGIN } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import type { Server } from "socket.io";

import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import {
    readSessionPublisherAuthorityProjection,
    type createSessionPublisherPresence,
} from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";

import { forwardRpcCall, type RpcForwardResult } from "./rpc/forwardRpcCall";
import { readVerifiedMachineSocketInstallationIdFromSocketData } from "./machineSocketInstallationProof";
import type { RpcAckResponseEmitter, RpcForwardTargetGuard } from "./rpc/_types";

/**
 * Reserved to the server's external Action bridge. The corresponding daemon
 * handler is intentionally not callable or registerable by ordinary sockets.
 */
export { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 };

export type ExternalActionServerPrincipal = Readonly<{
    accountId: string;
    principalId: string;
    credentialId: string;
    authority: "account_automation";
}>;

export type ExternalActionDaemonPlacement = Readonly<{
    machineId: string;
    target: Readonly<{ kind: "machine"; machineId: string }>;
}>;

export type ExternalActionDaemonDispatchRequest = Readonly<{
    actionId: string;
    envelope: ExternalActionRequestEnvelopeV1;
    principal: ExternalActionServerPrincipal;
    placement: ExternalActionDaemonPlacement;
}>;

/**
 * The server deliberately does not validate a public Action id. That is the
 * target daemon's Action-owner decision; this boundary only proves that a
 * response belongs to the requested relay.
 */
export type ExternalActionDaemonResponse = Readonly<{
    v: 1;
    actionId: string;
    requestId?: string;
    execution: ActionExecuteResult;
}>;

export type ExternalActionPlacementErrorCode =
    | "target_required"
    | "target_not_local"
    | "target_unavailable";

export type ExternalActionDaemonDispatchResult =
    | Readonly<{ kind: "response"; response: ExternalActionDaemonResponse }>
    | Readonly<{ kind: "placement_error"; code: ExternalActionPlacementErrorCode }>;

export type ExternalActionDaemonDispatcher = (
    request: Readonly<{
        actionId: string;
        envelope: ExternalActionRequestEnvelopeV1;
        principal: ExternalActionServerPrincipal;
    }>,
    options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<ExternalActionDaemonDispatchResult>;

export type ExternalActionForwardRpcCall = typeof forwardRpcCall;

type MachineResolution = "available" | "not_owned" | "unavailable";

type ResolveMachine = (params: Readonly<{
    accountId: string;
    machineId: string;
}>) => Promise<MachineResolution>;

type ResolveSessionMachine = (params: Readonly<{
    accountId: string;
    sessionId: string;
}>) => Promise<string | null>;

type SessionPublisherPresenceForExternalAction = Pick<
    ReturnType<typeof createSessionPublisherPresence>,
    "isCurrentPublisherProjection"
>;

type SocketDataCarrier = Readonly<{ data?: unknown }>;

function hasOwn(value: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function parseDaemonResponse(
    raw: unknown,
    expected: Readonly<{ actionId: string; requestId?: string }>,
): ExternalActionDaemonResponse | null {
    const response = readRecord(raw);
    if (!response || response.v !== 1 || response.actionId !== expected.actionId) return null;

    if (expected.requestId === undefined) {
        if (hasOwn(response, "requestId")) return null;
    } else if (response.requestId !== expected.requestId) {
        return null;
    }

    const execution = readRecord(response.execution);
    if (!execution) return null;
    if (execution.ok === true && hasOwn(execution, "result")) {
        return {
            v: 1,
            actionId: expected.actionId,
            ...(expected.requestId === undefined ? {} : { requestId: expected.requestId }),
            execution: { ok: true, result: execution.result },
        };
    }
    if (
        execution.ok === false
        && typeof execution.errorCode === "string"
        && typeof execution.error === "string"
    ) {
        return {
            v: 1,
            actionId: expected.actionId,
            ...(expected.requestId === undefined ? {} : { requestId: expected.requestId }),
            execution: {
                ok: false,
                errorCode: execution.errorCode,
                error: execution.error,
                ...(hasOwn(execution, "details") ? { details: execution.details } : {}),
            },
        };
    }
    return null;
}

async function resolveMachineFromServer(params: Readonly<{
    accountId: string;
    machineId: string;
}>): Promise<MachineResolution> {
    const machine = await db.machine.findFirst({
        where: { accountId: params.accountId, id: params.machineId },
        select: { revokedAt: true, replacedByMachineId: true },
    });
    if (!machine) return "not_owned";
    return classifyMachineAvailabilityState(machine) === "available"
        ? "available"
        : "unavailable";
}

async function resolveSessionMachineFromServer(params: Readonly<{
    io: Server;
    presence?: SessionPublisherPresenceForExternalAction;
    accountId: string;
    sessionId: string;
}>): Promise<string | null> {
    if (!params.presence) return null;
    let sockets: readonly SocketDataCarrier[];
    try {
        // Socket.IO's RemoteSocket has more fields than this resolver needs.
        sockets = await params.io.in(`user:${params.accountId}`).fetchSockets() as SocketDataCarrier[];
    } catch {
        return null;
    }

    const machineIds = new Set<string>();
    for (const socket of sockets) {
        const projection = readSessionPublisherAuthorityProjection(socket.data);
        if (!projection) continue;
        try {
            if (await params.presence.isCurrentPublisherProjection({
                expectedAccountId: params.accountId,
                expectedSessionId: params.sessionId,
                projection,
            })) {
                machineIds.add(projection.machineId);
            }
        } catch {
            // A currentness read is fail-closed; another current publisher may
            // still be discovered, but an uncertain candidate is never used.
        }
    }
    return machineIds.size === 1 ? [...machineIds][0] : null;
}

function isExactMachineDaemonTarget(
    target: Pick<RpcAckResponseEmitter, "data">,
    machineId: string,
): boolean {
    const data = target.data;
    return data?.clientType === "machine-scoped"
        && typeof data.machineId === "string"
        && data.machineId.trim() === machineId
        && readVerifiedMachineSocketInstallationIdFromSocketData(data) !== null;
}

function createExactMachineDaemonGuard(params: Readonly<{
    accountId: string;
    machineId: string;
    sessionId?: string;
    resolveMachine: ResolveMachine;
    resolveSessionMachine: ResolveSessionMachine;
}>): RpcForwardTargetGuard {
    const current = async (): Promise<boolean> => {
        try {
            if (await params.resolveMachine({
                accountId: params.accountId,
                machineId: params.machineId,
            }) !== "available") {
                return false;
            }
            if (params.sessionId === undefined) return true;
            return await params.resolveSessionMachine({
                accountId: params.accountId,
                sessionId: params.sessionId,
            }) === params.machineId;
        } catch {
            return false;
        }
    };
    const exact = (target: Pick<RpcAckResponseEmitter, "data">): boolean => (
        isExactMachineDaemonTarget(target, params.machineId)
    );

    return {
        filterTargets: async (targets) => {
            if (!await current()) return [];
            return targets.filter(exact);
        },
        runOperation: async ({ target, operation, readLatestTarget }) => {
            if (!exact(target) || !await current()) return { status: "unavailable" };
            const latestTarget = await readLatestTarget();
            if (!latestTarget || !exact(latestTarget) || !await current()) {
                return { status: "unavailable" };
            }
            const value = await operation();
            const latestTargetAfterResponse = await readLatestTarget();
            if (!latestTargetAfterResponse || !exact(latestTargetAfterResponse) || !await current()) {
                return { status: "unavailable" };
            }
            return { status: "current", value };
        },
    };
}

/**
 * The sole server-side relay for an external Action request. The server owns
 * credential provenance and exact daemon placement only; the target daemon is
 * the first process allowed to interpret Action id, input, or policy.
 */
export function createExternalActionDaemonDispatcher(params: Readonly<{
    io: Server;
    forwardRpc?: ExternalActionForwardRpcCall;
    resolveMachine?: ResolveMachine;
    resolveSessionMachine?: ResolveSessionMachine;
    sessionPublisherPresence?: SessionPublisherPresenceForExternalAction;
}>): ExternalActionDaemonDispatcher {
    const forwardRpc = params.forwardRpc ?? forwardRpcCall;
    const resolveMachine = params.resolveMachine ?? resolveMachineFromServer;
    const resolveSessionMachine = params.resolveSessionMachine ?? (async ({ accountId, sessionId }) => (
        await resolveSessionMachineFromServer({
            io: params.io,
            presence: params.sessionPublisherPresence,
            accountId,
            sessionId,
        })
    ));

    return async (request, options = {}): Promise<ExternalActionDaemonDispatchResult> => {
        const target = request.envelope.target;
        if (!target) {
            return { kind: "placement_error", code: "target_required" };
        }
        if (options.signal?.aborted) {
            return { kind: "placement_error", code: "target_unavailable" };
        }

        let machineId: string;
        let sessionId: string | undefined;
        if (target.kind === "machine") {
            machineId = target.machineId;
        } else {
            sessionId = target.sessionId;
            try {
                const resolved = await resolveSessionMachine({
                    accountId: request.principal.accountId,
                    sessionId,
                });
                if (!resolved) return { kind: "placement_error", code: "target_unavailable" };
                machineId = resolved;
            } catch {
                return { kind: "placement_error", code: "target_unavailable" };
            }
        }

        let availability: MachineResolution;
        try {
            availability = await resolveMachine({
                accountId: request.principal.accountId,
                machineId,
            });
        } catch {
            return { kind: "placement_error", code: "target_unavailable" };
        }
        if (availability !== "available") {
            return {
                kind: "placement_error",
                code: target.kind === "machine" && availability === "not_owned"
                    ? "target_not_local"
                    : "target_unavailable",
            };
        }
        if (options.signal?.aborted) {
            return { kind: "placement_error", code: "target_unavailable" };
        }

        const placement: ExternalActionDaemonPlacement = {
            machineId,
            target: { kind: "machine", machineId },
        };
        const targetGuard = createExactMachineDaemonGuard({
            accountId: request.principal.accountId,
            machineId,
            ...(sessionId === undefined ? {} : { sessionId }),
            resolveMachine,
            resolveSessionMachine,
        });
        const requestId = options.signal ? randomUUID() : null;
        let targetSocketId: string | null = null;
        const cancellation = requestId && options.signal
            ? {
                targetRequestId: requestId,
                signal: options.signal,
                onTargetSelected: (targetSocket: RpcAckResponseEmitter) => {
                    targetSocketId = targetSocket.id;
                },
            }
            : null;
        const cancelTarget = (): void => {
            if (!targetSocketId || !requestId) return;
            try {
                params.io.to(targetSocketId).emit(SOCKET_RPC_EVENTS.CANCEL, { requestId });
            } catch {
                // Cancellation is best effort at the transport boundary.
            }
        };
        options.signal?.addEventListener("abort", cancelTarget, { once: true });

        let forwarded: RpcForwardResult;
        try {
            forwarded = await forwardRpc({
                io: params.io,
                targetUserId: request.principal.accountId,
                method: `${machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
                callParams: {
                    actionId: request.actionId,
                    envelope: request.envelope,
                    principal: request.principal,
                    placement,
                } satisfies ExternalActionDaemonDispatchRequest,
                authorization: ACTION_API_SERVER_ORIGIN,
                targetGuard,
                ...(cancellation ? { cancellation } : {}),
            });
        } catch {
            return { kind: "placement_error", code: "target_unavailable" };
        } finally {
            options.signal?.removeEventListener("abort", cancelTarget);
        }
        if (!forwarded.ok) return { kind: "placement_error", code: "target_unavailable" };

        const response = parseDaemonResponse(forwarded.result, {
            actionId: request.actionId,
            ...(request.envelope.requestId === undefined ? {} : { requestId: request.envelope.requestId }),
        });
        return response
            ? { kind: "response", response }
            : { kind: "placement_error", code: "target_unavailable" };
    };
}
