import type { Server } from "socket.io";
import type { SocketRpcAnsweringClientV1 } from '@happier-dev/protocol/socketRpc';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { projectActionFailureCauseV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { recordSocketClusterFetchSockets } from "@/app/monitoring/metrics/index";
import { log } from "@/utils/logging/log";
import { db } from "@/storage/db";
import { getMachineSocketRoom } from "../../socketRooms";
import { readLocalSocketRoom, readSocketRoomSnapshot } from '../socketRoomDiscovery';

import type { RpcAckResponseEmitter, RpcForwardTargetGuard } from "./_types";
import { buildRpcMethodRoom } from "./rpcMethodRoom";
import { readSocketRegisteredRpcMethods } from './rpcRegisteredMethods';
import { selectRpcTarget } from './rpcTargetSelection';

export function classifySocketClusterFetchFailureReason(error: unknown): "timeout" | "transport" | "unknown" {
    if (!(error instanceof Error)) {
        return "unknown";
    }
    const message = error.message.toLowerCase();
    return message.includes("timeout") ? "timeout" : "unknown";
}

/** A registered target proves presence; only a complete census proves absence. */
export async function readRegisteredRpcTargetPresence(params: Readonly<{
    userId: string;
    io: Server;
    method: string;
}>): Promise<"present" | "absent" | "unknown"> {
    try {
        const snapshot = await readSocketRoomSnapshot({
            io: params.io,
            room: buildRpcMethodRoom({ userId: params.userId, method: params.method }),
            acceptPartial: async sockets => sockets.length > 0,
        });
        if (snapshot.sockets.length > 0) return "present";
        if (snapshot.complete) return "absent";
        if (snapshot.error) throw snapshot.error;
        return "unknown";
    } catch (error) {
        log({ module: "websocket-rpc", level: "error",
            failureCause: projectActionFailureCauseV1(error, 'rpc.discovery.presence', { allowUnknownErrorCode: false }) },
        'RPC handler availability lookup failed');
        return "unknown";
    }
}

/** Only a successful authenticated Machine-room census proves presence or absence. */
export async function readMachineRpcTargetPresence(params: Readonly<{
    io: Server;
    userId: string;
    method: string;
    fetchTimeoutMs?: number;
    machineAdmission?: SocketRpcMachineAdmissionContextV1;
}>): Promise<'method-absent' | 'disconnected' | 'unknown'> {
    const separator = params.method.indexOf(':');
    if (separator <= 0) return 'unknown';
    const machineId = params.method.slice(0, separator);
    try {
        // A matching request admission already proves the namespace and lifecycle.
        // Session and unadmitted legacy routes still need their namespace resolved.
        if (params.machineAdmission?.machineId !== machineId
            || params.machineAdmission.custodianAccountId !== params.userId) {
            const machine = await db.machine.findFirst({
                where: { accountId: params.userId, id: machineId },
                select: { revokedAt: true, replacedByMachineId: true },
            });
            if (!machine) return 'unknown';
            if (classifyMachineAvailabilityState(machine) !== 'available') return 'disconnected';
        }
        const snapshot = await readSocketRoomSnapshot({ io: params.io,
            room: getMachineSocketRoom(params.userId, machineId), timeoutMs: params.fetchTimeoutMs });
        const targets = snapshot.sockets as RpcAckResponseEmitter[];
        const daemons = targets.filter(target => target.data?.clientType === 'machine-scoped'
            && target.data.machineId === machineId);
        if (daemons.length === 0) return snapshot.complete ? 'disconnected' : 'unknown';
        // A daemon still registering, or a registered handler missing from its method
        // room, does not prove unsupported. Use the existing Home registration owner.
        return snapshot.complete && daemons.every(target => {
            const methods = readSocketRegisteredRpcMethods(target);
            return methods !== null && !methods.includes(params.method);
        }) ? 'method-absent' : 'unknown';
    } catch (error) {
        // A failed cluster/DB lookup is not affirmative evidence that a daemon disconnected.
        log({ module: 'websocket-rpc', level: 'warn', machineId,
            failureCause: projectActionFailureCauseV1(error, 'rpc.discovery.machine_presence', { allowUnknownErrorCode: false }) },
        'Machine RPC daemon presence lookup failed');
        return 'unknown';
    }
}

export async function discoverRpcTargets(params: Readonly<{
    io: Server;
    userId: string;
    method: string;
    fetchTimeoutMs?: number;
    excludedSocketId?: string;
    answeringClient?: SocketRpcAnsweringClientV1;
    targetGuard?: RpcForwardTargetGuard;
    correlation?: Readonly<{ requestId: string; callerSocketId?: string }>;
}>): Promise<Readonly<{ targets: RpcAckResponseEmitter[]; methodRoomEmpty: boolean; failureCause?: ActionFailureCauseV1 }>> {
    const room = buildRpcMethodRoom({
        userId: params.userId,
        method: params.method,
    });
    const startedAt = Date.now();
    const requiresGlobalUniqueness = Boolean(params.answeringClient?.requireSingle && !params.answeringClient.clientId);
    let observedTargets: RpcAckResponseEmitter[] = [];

    const admitTargets = async (targets: RpcAckResponseEmitter[]) =>
        params.targetGuard ? await params.targetGuard.filterTargets(targets) : targets;

    try {
        // A local room member is positive routing evidence and does not depend on
        // every Redis peer answering. Single-client discovery still needs a global census.
        if (!requiresGlobalUniqueness) {
            const localTargets = readLocalSocketRoom(params.io, room);
            const admitted = await admitTargets(localTargets);
            if (selectRpcTarget({ targets: admitted, excludedSocketId: params.excludedSocketId,
                answeringClient: params.answeringClient }).type === 'target') return { targets: admitted, methodRoomEmpty: false };
        }
        const canUsePartial = !requiresGlobalUniqueness;
        const snapshot = await readSocketRoomSnapshot({ io: params.io, room, timeoutMs: params.fetchTimeoutMs,
            ...(canUsePartial ? { acceptPartial: async sockets => selectRpcTarget({
                targets: await admitTargets(sockets as RpcAckResponseEmitter[]),
                excludedSocketId: params.excludedSocketId, answeringClient: params.answeringClient,
            }).type === 'target' } : {}),
        });
        const targets = snapshot.sockets as RpcAckResponseEmitter[];
        observedTargets = targets;
        const admitted = await admitTargets(targets);
        if (!snapshot.complete && (!canUsePartial || selectRpcTarget({ targets: admitted,
            excludedSocketId: params.excludedSocketId, answeringClient: params.answeringClient }).type !== 'target')) {
            throw snapshot.error ?? new Error('Incomplete RPC target census');
        }
        recordSocketClusterFetchSockets({
            durationMs: Date.now() - startedAt,
            result: "ok",
        });
        return { targets: admitted, methodRoomEmpty: snapshot.complete && targets.length === 0 };
    } catch (error) {
        const timeout = classifySocketClusterFetchFailureReason(error) === 'timeout';
        const cause = timeout ? Object.assign(new Error('RPC discovery timeout'), { code: 'ETIMEDOUT' }) : error;
        const phase = requiresGlobalUniqueness ? 'rpc.discovery.global_uniqueness' : 'rpc.discovery.target';
        const failureCause = projectActionFailureCauseV1(cause, phase);
        const logCause = projectActionFailureCauseV1(cause, phase, { allowUnknownErrorCode: false });
        recordSocketClusterFetchSockets({
            durationMs: Date.now() - startedAt,
            result: "error",
            reason: classifySocketClusterFetchFailureReason(error),
        });
        log(
            { module: "websocket-rpc", level: "warn", room, ...params.correlation, failureCause: logCause,
                requiresGlobalUniqueness, observedTargetSocketIds: observedTargets.map(target => target.id),
                localTargetSocketIds: observedTargets.filter(target => params.io.sockets?.sockets?.has(target.id))
                    .map(target => target.id) },
            'RPC target discovery failed',
        );
        // An unsuccessful census cannot prove that a connected daemon lacks a method.
        return { targets: [], methodRoomEmpty: false, failureCause };
    }
}
