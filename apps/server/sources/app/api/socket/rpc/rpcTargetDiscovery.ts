import type { Server } from "socket.io";
import type { SocketRpcAnsweringClientV1 } from '@happier-dev/protocol/socketRpc';

import { classifyMachineAvailabilityState, readMachineAvailabilityState } from "@/app/machines/machineStateGuards";
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
        log({ module: "websocket-rpc", level: "error" }, `Error checking rpc handler availability: ${error}`);
        return "unknown";
    }
}

/** Only a successful authenticated Machine-room census proves presence or absence. */
export async function readMachineRpcTargetPresence(params: Readonly<{
    io: Server;
    userId: string;
    method: string;
    fetchTimeoutMs?: number;
}>): Promise<'method-absent' | 'disconnected' | 'unknown'> {
    const separator = params.method.indexOf(':');
    if (separator <= 0) return 'unknown';
    const machineId = params.method.slice(0, separator);
    try {
        // Session and Machine RPC namespaces share the transport. Only the canonical Machine
        // row establishes that this namespace denotes a Machine, including legacy installations.
        const machine = await db.machine.findFirst({
            where: { accountId: params.userId, id: machineId },
            select: { revokedAt: true, replacedByMachineId: true },
        });
        if (!machine) return 'unknown';
        if (classifyMachineAvailabilityState(machine) !== 'available') return 'disconnected';
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
    } catch {
        // A failed cluster/DB lookup is not affirmative evidence that a daemon disconnected.
        log({ module: 'websocket-rpc', level: 'warn', machineId }, 'Machine RPC daemon presence lookup failed');
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
}>): Promise<Readonly<{ targets: RpcAckResponseEmitter[]; methodRoomEmpty: boolean }> | null> {
    const room = buildRpcMethodRoom({
        userId: params.userId,
        method: params.method,
    });
    const startedAt = Date.now();

    const admitTargets = async (targets: RpcAckResponseEmitter[]) => {
        const availableTargets: RpcAckResponseEmitter[] = [];
        for (const target of targets) {
            const clientType = typeof target.data?.clientType === 'string' ? target.data.clientType : '';
            const machineId = typeof target.data?.machineId === 'string' ? target.data.machineId : '';
            if (clientType !== 'machine-scoped' || !machineId
                || await readMachineAvailabilityState({ accountId: params.userId, machineId }) === 'available') {
                availableTargets.push(target);
            }
        }
        return params.targetGuard ? await params.targetGuard.filterTargets(availableTargets) : availableTargets;
    };

    try {
        // A local room member is positive routing evidence and does not depend on
        // every Redis peer answering. Single-client discovery still needs a global census.
        if (!params.answeringClient?.requireSingle || params.answeringClient.clientId) {
            const localTargets = readLocalSocketRoom(params.io, room);
            const admitted = await admitTargets(localTargets);
            if (selectRpcTarget({ targets: admitted, excludedSocketId: params.excludedSocketId,
                answeringClient: params.answeringClient }).type === 'target') return { targets: admitted, methodRoomEmpty: false };
        }
        const canUsePartial = !params.answeringClient?.requireSingle || Boolean(params.answeringClient.clientId);
        const snapshot = await readSocketRoomSnapshot({ io: params.io, room, timeoutMs: params.fetchTimeoutMs,
            ...(canUsePartial ? { acceptPartial: async sockets => selectRpcTarget({
                targets: await admitTargets(sockets as RpcAckResponseEmitter[]),
                excludedSocketId: params.excludedSocketId, answeringClient: params.answeringClient,
            }).type === 'target' } : {}),
        });
        const targets = snapshot.sockets as RpcAckResponseEmitter[];
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
        recordSocketClusterFetchSockets({
            durationMs: Date.now() - startedAt,
            result: "error",
            reason: classifySocketClusterFetchFailureReason(error),
        });
        log(
            { module: "websocket-rpc", level: "warn", room, ...params.correlation },
            `RPC target discovery failed for ${room}: ${error instanceof Error ? error.message : String(error)}`,
        );
        // An unsuccessful census cannot prove that a connected daemon lacks a method.
        return null;
    }
}
