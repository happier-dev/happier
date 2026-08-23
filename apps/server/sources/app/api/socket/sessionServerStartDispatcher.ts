import { randomUUID } from "node:crypto";

import {
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
    SessionServerStartIngressRequestV1Schema,
    SessionServerStartDispatchRequestV1Schema,
    SessionServerStartDispatchResultV1Schema,
    parseAutomationRunExecutionRecipeV1,
    sameAutomationAccountCurrentnessWitnessV1,
    supportsMachineOperationProtocolCapabilityV1,
    validateAutomationSessionStartRequestEnvelopeOuterForModeV1,
    validateAutomationRunExecutionRecipeOuterV1,
    type SessionServerStartDispatchRequestV1,
    type SessionServerStartDispatchResultV1,
    type SessionServerStartIngressResponseV1,
} from "@happier-dev/protocol";
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import type { Server } from "socket.io";

import { fetchAutomationAccountCurrentnessWitnessTx } from "@/app/automations/automationAccountCurrentness";
import { retainAutomationRunProducedSession } from "@/app/automations/automationRunService";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { inTx } from "@/storage/inTx";

import { forwardRpcCall, type RpcForwardResult } from "./rpc/forwardRpcCall";
import { readVerifiedMachineSocketInstallationIdFromSocketData } from "./machineSocketInstallationProof";
import type { RpcAckResponseEmitter, RpcForwardTargetGuard } from "./rpc/_types";

export type SessionServerStartForwardRpcCall = typeof forwardRpcCall;

type ResolveCurrentTarget = (
    request: SessionServerStartDispatchRequestV1,
) => Promise<boolean>;

function unavailable(): SessionServerStartDispatchResultV1 {
    return { type: "error", code: "target_unavailable", retryable: true };
}

function cancelled(): SessionServerStartDispatchResultV1 {
    return { type: "error", code: "cancelled", retryable: true };
}

function pendingUnknown(): SessionServerStartDispatchResultV1 {
    return { type: "pending", retryWithSameCreationKey: true, outcome: "unknown" };
}

function isExactMachineDaemonTarget(
    target: Pick<RpcAckResponseEmitter, "data">,
    machineId: string,
    machineInstallationId: string,
): boolean {
    const data = target.data;
    return data?.clientType === "machine-scoped"
        && typeof data.machineId === "string"
        && data.machineId.trim() === machineId
        && readVerifiedMachineSocketInstallationIdFromSocketData(data) === machineInstallationId;
}

async function resolveCurrentTargetFromServer(
    request: SessionServerStartDispatchRequestV1,
): Promise<boolean> {
    return await inTx(async (tx) => {
        const [machine, currentness] = await Promise.all([
            tx.machine.findFirst({
                where: {
                    accountId: request.target.accountId,
                    id: request.target.machineId,
                    installationId: request.target.machineInstallationId,
                },
                select: {
                    revokedAt: true,
                    replacedByMachineId: true,
                    operationProtocolCapabilities: true,
                    operationProtocolCapabilitiesRevision: true,
                },
            }),
            fetchAutomationAccountCurrentnessWitnessTx(tx, request.target.accountId),
        ]);
        return machine !== null
            && classifyMachineAvailabilityState(machine) === "available"
            && typeof machine.operationProtocolCapabilitiesRevision === "number"
            && machine.operationProtocolCapabilitiesRevision >= 1
            && supportsMachineOperationProtocolCapabilityV1(
                machine.operationProtocolCapabilities,
                "sessionSpawn",
            )
            && currentness !== null
            && sameAutomationAccountCurrentnessWitnessV1(
                request.start.accountCurrentness,
                currentness,
            );
    });
}

function createExactMachineDaemonGuard(params: Readonly<{
    request: SessionServerStartDispatchRequestV1;
    resolveCurrentTarget: ResolveCurrentTarget;
}>): RpcForwardTargetGuard {
    const current = async (): Promise<boolean> => {
        try {
            return await params.resolveCurrentTarget(params.request);
        } catch {
            return false;
        }
    };
    const isExact = (target: Pick<RpcAckResponseEmitter, "data">): boolean =>
        isExactMachineDaemonTarget(
            target,
            params.request.target.machineId,
            params.request.target.machineInstallationId,
        );

    return {
        filterTargets: async (targets) => {
            if (!await current()) return [];
            return targets.filter(isExact);
        },
        runOperation: async ({ target, operation, readLatestTarget }) => {
            if (!isExact(target) || !await current()) {
                return { status: "unavailable" };
            }
            const latestTarget = await readLatestTarget();
            if (!latestTarget || !isExact(latestTarget) || !await current()) {
                return { status: "unavailable" };
            }
            const value = await operation();
            const latestTargetAfterResponse = await readLatestTarget();
            if (!latestTargetAfterResponse || !isExact(latestTargetAfterResponse) || !await current()) {
                return { status: "unavailable" };
            }
            return { status: "current", value };
        },
    };
}

/**
 * The sole server-origin bridge for Automation Session starts. It never opens
 * the opaque V2 request: it validates only server-held target/currentness
 * facts, then uses the reserved exact-machine Socket method.
 */
export function createSessionServerStartDaemonDispatcher(params: Readonly<{
    io: Server;
    forwardRpc?: SessionServerStartForwardRpcCall;
    /** Test boundary; production reads the canonical Account and Machine owners. */
    resolveCurrentTarget?: ResolveCurrentTarget;
}>): (
    raw: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<SessionServerStartDispatchResultV1> {
    const forwardRpc = params.forwardRpc ?? forwardRpcCall;
    const resolveCurrentTarget = params.resolveCurrentTarget ?? resolveCurrentTargetFromServer;

    return async (raw, options = {}): Promise<SessionServerStartDispatchResultV1> => {
        const parsed = SessionServerStartDispatchRequestV1Schema.safeParse(raw);
        if (!parsed.success) {
            return { type: "error", code: "invalid_input", retryable: false };
        }
        if (options.signal?.aborted) return cancelled();

        const request = parsed.data;
        try {
            if (!await resolveCurrentTarget(request)) return unavailable();
        } catch {
            return unavailable();
        }
        if (options.signal?.aborted) return cancelled();

        const targetGuard = createExactMachineDaemonGuard({ request, resolveCurrentTarget });
        const requestId = options.signal ? randomUUID() : null;
        let targetSocketId: string | null = null;
        let submittedUnknown = false;
        const forwardCancellation = requestId && options.signal
            ? {
                targetRequestId: requestId,
                signal: options.signal,
                onTargetSelected: (target: RpcAckResponseEmitter) => {
                    targetSocketId = target.id;
                },
            }
            : null;
        const cancelTarget = (): void => {
            if (!targetSocketId || !requestId) return;
            try {
                params.io.to(targetSocketId).emit(SOCKET_RPC_EVENTS.CANCEL, { requestId });
            } catch {
                // Cancellation is best effort at the transport boundary; the
                // daemon still sees the local timeout/currentness fences.
            }
        };
        options.signal?.addEventListener("abort", cancelTarget, { once: true });

        let forwarded: RpcForwardResult;
        try {
            forwarded = await forwardRpc({
                io: params.io,
                targetUserId: request.target.accountId,
                method: `${request.target.machineId}:${SESSION_SERVER_START_DAEMON_RPC_METHOD_V1}`,
                callParams: request,
                authorization: {
                    kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_SERVER_START_SERVER_ORIGIN,
                },
                targetGuard,
                onSubmittedUnknown: () => {
                    submittedUnknown = true;
                },
                ...(forwardCancellation ? { cancellation: forwardCancellation } : {}),
            });
        } catch {
            return options.signal?.aborted
                ? cancelled()
                : { type: "error", code: "machine_offline", retryable: true };
        } finally {
            options.signal?.removeEventListener("abort", cancelTarget);
        }
        if (!forwarded.ok) {
            if (submittedUnknown) return pendingUnknown();
            return options.signal?.aborted ? cancelled() : unavailable();
        }

        const result = SessionServerStartDispatchResultV1Schema.safeParse(forwarded.result);
        return result.success
            ? result.data
            : { type: "error", code: "spawn_failed", retryable: true };
    };
}

type SessionServerStartIngressRun = Readonly<{
    automationId: string;
    state: string;
    claimedByMachineId: string | null;
    attempt: number;
    leaseExpiresAt: Date | null;
    originKind: string;
    executionInputEnvelope: string | null;
}>;

type SessionServerStartIngressTargetMachine = Readonly<{
    id: string;
    accountId: string;
    installationId: string | null;
    revokedAt: Date | null;
    replacedByMachineId: string | null;
    operationProtocolCapabilities: unknown | null;
    operationProtocolCapabilitiesRevision: number | null;
}>;

type SessionServerStartIngressDispatchResolution =
    | Readonly<{ kind: "available"; dispatch: SessionServerStartDispatchRequestV1 }>
    | Readonly<{ kind: "unavailable" }>
    | Readonly<{ kind: "incompatibleTarget" }>;

type RetainSessionServerStartProducedSession = (params: {
    accountId: string;
    machineId: string;
    runId: string;
    attempt: number;
    result: SessionServerStartDispatchResultV1;
}) => Promise<unknown>;

function requiresProducedSessionRetention(result: SessionServerStartDispatchResultV1): boolean {
    return result.type === "success";
}

function originForAutomationRun(originKind: string): "schedule" | "manual" | "event" | "conversation" | null {
    switch (originKind) {
        case "scheduled": return "schedule";
        case "manual": return "manual";
        case "pluginEvent": return "event";
        case "conversation": return "conversation";
        default: return null;
    }
}

/**
 * Reconstructs the only server-stamped daemon request from authenticated socket
 * identity plus the active durable Run. In particular, no field from the
 * inbound ingress request supplies Account, Automation, origin, target,
 * installation, or Account-currentness authority.
 */
export function deriveSessionServerStartDispatchFromIngress(params: Readonly<{
    accountId: string;
    sourceMachineId: string;
    request: unknown;
    now: Date;
    accountCurrentness: Awaited<ReturnType<typeof fetchAutomationAccountCurrentnessWitnessTx>>;
    run: SessionServerStartIngressRun | null;
    targetMachine: SessionServerStartIngressTargetMachine | null;
}>): SessionServerStartDispatchRequestV1 | null {
    const request = SessionServerStartIngressRequestV1Schema.safeParse(params.request);
    if (!request.success || params.accountCurrentness === null) return null;
    const requestEnvelope = validateAutomationSessionStartRequestEnvelopeOuterForModeV1({
        mode: params.accountCurrentness.mode,
        envelope: request.data.requestEnvelope,
    });
    if (requestEnvelope.kind !== "available") return null;
    const run = params.run;
    if (
        run === null
        || run.state !== "running"
        || run.claimedByMachineId !== params.sourceMachineId
        || run.attempt !== request.data.attempt
        || run.leaseExpiresAt === null
        || run.leaseExpiresAt.getTime() <= params.now.getTime()
    ) return null;

    const parsedRecipe = parseAutomationRunExecutionRecipeV1(run.executionInputEnvelope);
    if (parsedRecipe.kind !== "available") return null;
    const outer = validateAutomationRunExecutionRecipeOuterV1({
        recipe: parsedRecipe.recipe,
        accountCurrentness: params.accountCurrentness,
    });
    if (outer.kind !== "available" || outer.recipe.target.kind !== "newSession") return null;

    const origin = originForAutomationRun(run.originKind);
    const targetMachine = params.targetMachine;
    const installationId = targetMachine?.installationId?.trim() ?? "";
    if (
        origin === null
        || targetMachine === null
        || targetMachine.accountId !== params.accountId
        || targetMachine.id !== outer.recipe.target.spawn.executionTarget.machineId
        || !installationId
        || classifyMachineAvailabilityState(targetMachine) !== "available"
        || typeof targetMachine.operationProtocolCapabilitiesRevision !== "number"
        || targetMachine.operationProtocolCapabilitiesRevision < 1
        || !supportsMachineOperationProtocolCapabilityV1(
            targetMachine.operationProtocolCapabilities,
            "sessionSpawn",
        )
    ) return null;

    return {
        v: 1,
        kind: "session.serverStart.dispatch",
        target: {
            accountId: params.accountId,
            machineId: targetMachine.id,
            machineInstallationId: installationId,
        },
        start: {
            automationId: run.automationId,
            runId: request.data.runId,
            origin,
            accountCurrentness: params.accountCurrentness,
            requestEnvelope: requestEnvelope.envelope,
        },
    };
}

function isIncompatibleSessionServerStartTarget(params: Readonly<{
    accountId: string;
    expectedMachineId: string;
    targetMachine: SessionServerStartIngressTargetMachine | null;
}>): boolean {
    const targetMachine = params.targetMachine;
    const installationId = targetMachine?.installationId?.trim() ?? "";
    if (
        targetMachine === null
        || targetMachine.accountId !== params.accountId
        || targetMachine.id !== params.expectedMachineId
        || !installationId
        || classifyMachineAvailabilityState(targetMachine) !== "available"
    ) return false;
    return typeof targetMachine.operationProtocolCapabilitiesRevision !== "number"
        || targetMachine.operationProtocolCapabilitiesRevision < 1
        || !supportsMachineOperationProtocolCapabilityV1(
            targetMachine.operationProtocolCapabilities,
            "sessionSpawn",
        );
}

async function resolveSessionServerStartDispatchFromServer(params: Readonly<{
    accountId: string;
    sourceMachineId: string;
    request: unknown;
}>): Promise<SessionServerStartIngressDispatchResolution> {
    const request = SessionServerStartIngressRequestV1Schema.safeParse(params.request);
    if (!request.success) return { kind: "unavailable" };

    return await inTx(async (tx) => {
        const now = new Date();
        const [accountCurrentness, run] = await Promise.all([
            fetchAutomationAccountCurrentnessWitnessTx(tx, params.accountId),
            tx.automationRun.findFirst({
                where: {
                    id: request.data.runId,
                    accountId: params.accountId,
                    claimedByMachineId: params.sourceMachineId,
                    attempt: request.data.attempt,
                    state: "running",
                    leaseExpiresAt: { gt: now },
                },
                select: {
                    automationId: true,
                    state: true,
                    claimedByMachineId: true,
                    attempt: true,
                    leaseExpiresAt: true,
                    originKind: true,
                    executionInputEnvelope: true,
                },
            }),
        ]);
        if (accountCurrentness === null || run === null) return { kind: "unavailable" };

        const parsedRecipe = parseAutomationRunExecutionRecipeV1(run.executionInputEnvelope);
        const outer = parsedRecipe.kind === "available"
            ? validateAutomationRunExecutionRecipeOuterV1({
                recipe: parsedRecipe.recipe,
                accountCurrentness,
            })
            : { kind: "contentInvalid" as const };
        if (outer.kind !== "available" || outer.recipe.target.kind !== "newSession") {
            return { kind: "unavailable" };
        }

        const targetMachine = await tx.machine.findFirst({
            where: {
                accountId: params.accountId,
                id: outer.recipe.target.spawn.executionTarget.machineId,
            },
            select: {
                id: true,
                accountId: true,
                installationId: true,
                revokedAt: true,
                replacedByMachineId: true,
                operationProtocolCapabilities: true,
                operationProtocolCapabilitiesRevision: true,
            },
        });
        const dispatch = deriveSessionServerStartDispatchFromIngress({
            accountId: params.accountId,
            sourceMachineId: params.sourceMachineId,
            request: request.data,
            now,
            accountCurrentness,
            run,
            targetMachine,
        });
        if (dispatch !== null) return { kind: "available", dispatch };
        return isIncompatibleSessionServerStartTarget({
            accountId: params.accountId,
            expectedMachineId: outer.recipe.target.spawn.executionTarget.machineId,
            targetMachine,
        })
            ? { kind: "incompatibleTarget" }
            : { kind: "unavailable" };
    });
}

/**
 * The one server ingress for Automation Session starts. It receives no caller
 * authority beyond the machine-authenticated socket, derives a stamped request
 * from durable state, then chooses local direct dispatch or the pre-existing
 * exact-machine closed Socket bridge.
 */
export function createSessionServerStartAutomationIngress(params: Readonly<{
    forward?: (
        raw: unknown,
        options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<SessionServerStartDispatchResultV1>;
    /** Test boundary; production rederives from the canonical Account/Run/Machine owners. */
    resolveDispatch?: (params: Readonly<{
        accountId: string;
        sourceMachineId: string;
        request: unknown;
    }>) => Promise<SessionServerStartIngressDispatchResolution>;
    /** Test boundary; production retains only through the canonical Automation Run owner. */
    retainProducedSession?: RetainSessionServerStartProducedSession;
}>): (params: Readonly<{
    accountId: string;
    sourceMachineId: string;
    request: unknown;
    signal?: AbortSignal;
}>) => Promise<SessionServerStartIngressResponseV1> {
    const forward = params.forward;
    const resolveDispatch = params.resolveDispatch ?? resolveSessionServerStartDispatchFromServer;
    const retainProducedSession = params.retainProducedSession ?? retainAutomationRunProducedSession;

    return async (input): Promise<SessionServerStartIngressResponseV1> => {
        const parsed = SessionServerStartIngressRequestV1Schema.safeParse(input.request);
        if (!parsed.success) {
            return { v: 1, kind: "result", result: { type: "error", code: "invalid_input", retryable: false } };
        }
        if (input.signal?.aborted) {
            return { v: 1, kind: "result", result: cancelled() };
        }
        let resolution: SessionServerStartIngressDispatchResolution;
        try {
            resolution = await resolveDispatch({
                accountId: input.accountId,
                sourceMachineId: input.sourceMachineId,
                request: parsed.data,
            });
        } catch {
            resolution = { kind: "unavailable" };
        }
        if (resolution.kind === "incompatibleTarget") {
            return {
                v: 1,
                kind: "result",
                result: { type: "error", code: "incompatible_target", retryable: false },
            };
        }
        if (resolution.kind !== "available") {
            return { v: 1, kind: "result", result: unavailable() };
        }
        const dispatch = resolution.dispatch;
        if (input.signal?.aborted) {
            return { v: 1, kind: "result", result: cancelled() };
        }
        if (dispatch.target.machineId === input.sourceMachineId) {
            return { v: 1, kind: "local", dispatch };
        }
        if (!forward) {
            return { v: 1, kind: "result", result: unavailable() };
        }
        const result = await forward(dispatch, input.signal ? { signal: input.signal } : undefined);
        if (requiresProducedSessionRetention(result)) {
            const retained = await retainProducedSession({
                accountId: input.accountId,
                machineId: input.sourceMachineId,
                runId: parsed.data.runId,
                attempt: parsed.data.attempt,
                result,
            });
            // A successful target reply is not safe to acknowledge as known
            // until the sole Automation Run writer has attached its canonical
            // Session identity. Unknown remains retryable by the same key.
            if (result.type === "success" && retained === null) {
                return { v: 1, kind: "result", result: pendingUnknown() };
            }
        }
        return {
            v: 1,
            kind: "result",
            result,
        };
    };
}
