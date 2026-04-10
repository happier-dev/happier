import type { Server } from "socket.io";

import { getRedisClient } from "@/storage/redis/redis";

export type MachineSocketOwnershipRegistryConfig =
    | { enabled: false }
    | { enabled: true; instanceId: string; ttlSeconds?: number };

export type MachineSocketOwnerSnapshot = Readonly<{
    socketId: string;
    runtimeId?: string;
    cliVersion?: string;
    publicReleaseChannel?: string;
    startupSource?: string;
    serviceManaged?: boolean;
    serviceLabel?: string;
}>;

type MachineSocketOwnerInput = Readonly<{
    runtimeId?: string;
    cliVersion?: string;
    publicReleaseChannel?: string;
    startupSource?: string;
    serviceManaged?: boolean;
    serviceLabel?: string;
    takeoverRequested?: boolean;
}>;

type ClaimOwnerResult =
    | Readonly<{ result: "granted" }>
    | Readonly<{ result: "already-owned-by-self" }>
    | Readonly<{ result: "takeover-granted" }>
    | Readonly<{ result: "conflict"; owner: MachineSocketOwnerSnapshot }>;

const DEFAULT_MACHINE_SOCKET_OWNER_TTL_SECONDS = 120;

const CLAIM_IF_AVAILABLE_OR_SELF_OR_TAKEOVER_SCRIPT = [
    "local existingSocketId = redis.call('HGET', KEYS[1], 'socketId')",
    "local existingRuntimeId = redis.call('HGET', KEYS[1], 'runtimeId')",
    "local existingServiceManaged = redis.call('HGET', KEYS[1], 'serviceManaged')",
    "local takeoverRequested = ARGV[11] == '1'",
    "if (not existingSocketId) or existingSocketId == ARGV[1] or (ARGV[2] ~= '' and existingRuntimeId == ARGV[2]) then",
    "  redis.call('HSET', KEYS[1], 'socketId', ARGV[1], 'runtimeId', ARGV[2], 'instanceId', ARGV[3], 'updatedAt', ARGV[4], 'cliVersion', ARGV[5], 'publicReleaseChannel', ARGV[6], 'startupSource', ARGV[7], 'serviceManaged', ARGV[8], 'serviceLabel', ARGV[9])",
    "  redis.call('EXPIRE', KEYS[1], ARGV[10])",
    "  if existingSocketId and (existingSocketId == ARGV[1] or (ARGV[2] ~= '' and existingRuntimeId == ARGV[2])) then return 'self' end",
    "  return 'granted'",
    "end",
    "if takeoverRequested and existingServiceManaged ~= 'true' then",
    "  redis.call('HSET', KEYS[1], 'socketId', ARGV[1], 'runtimeId', ARGV[2], 'instanceId', ARGV[3], 'updatedAt', ARGV[4], 'cliVersion', ARGV[5], 'publicReleaseChannel', ARGV[6], 'startupSource', ARGV[7], 'serviceManaged', ARGV[8], 'serviceLabel', ARGV[9])",
    "  redis.call('EXPIRE', KEYS[1], ARGV[10])",
    "  return 'takeover'",
    "end",
    "return 'conflict'",
].join(" ");

const DEL_IF_SOCKET_ID_SCRIPT =
    "if redis.call('HGET', KEYS[1], 'socketId') == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

const REFRESH_IF_SOCKET_ID_SCRIPT = [
    "if redis.call('HGET', KEYS[1], 'socketId') ~= ARGV[1] then return 0 end",
    "redis.call('HSET', KEYS[1], 'updatedAt', ARGV[2], 'instanceId', ARGV[3])",
    "redis.call('EXPIRE', KEYS[1], ARGV[4])",
    "return 1",
].join(" ");

function normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOwnerSnapshot(
    socketId: string,
    owner: MachineSocketOwnerInput,
): MachineSocketOwnerSnapshot {
    return {
        socketId,
        ...(owner.runtimeId ? { runtimeId: owner.runtimeId } : null),
        ...(owner.cliVersion ? { cliVersion: owner.cliVersion } : null),
        ...(owner.publicReleaseChannel ? { publicReleaseChannel: owner.publicReleaseChannel } : null),
        ...(owner.startupSource ? { startupSource: owner.startupSource } : null),
        ...(typeof owner.serviceManaged === "boolean" ? { serviceManaged: owner.serviceManaged } : null),
        ...(owner.serviceLabel ? { serviceLabel: owner.serviceLabel } : null),
    };
}

function isManualOwner(owner: MachineSocketOwnerSnapshot): boolean {
    return owner.serviceManaged !== true;
}

function resolveOwnershipKey(params: Readonly<{ accountId: string; machineId: string }>): string {
    return `machine-owner:${params.accountId}:${params.machineId}`;
}

function resolveMachineSocketOwnerTtlSeconds(config: MachineSocketOwnershipRegistryConfig): number {
    if (!config.enabled) return 0;
    if (typeof config.ttlSeconds === "number" && Number.isFinite(config.ttlSeconds) && config.ttlSeconds > 0) {
        return Math.floor(config.ttlSeconds);
    }
    const raw = normalizeOptionalString(process.env.HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS);
    if (!raw) return DEFAULT_MACHINE_SOCKET_OWNER_TTL_SECONDS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MACHINE_SOCKET_OWNER_TTL_SECONDS;
    return parsed;
}

export function createMachineSocketOwnershipRegistry(params: Readonly<{
    io: Server;
    config: MachineSocketOwnershipRegistryConfig;
}>) {
    const localOwners = new Map<string, MachineSocketOwnerSnapshot>();
    const refreshTimers = new Map<string, NodeJS.Timeout>();
    const ttlSeconds = resolveMachineSocketOwnerTtlSeconds(params.config);

    function readLocalSocket(socketId: string) {
        return params.io.sockets.sockets.get(socketId);
    }

    function isSocketLive(socketId: string): boolean {
        return readLocalSocket(socketId)?.connected === true;
    }

    function disconnectSocketById(socketId: string): void {
        try {
            params.io.in(socketId).disconnectSockets(true);
        } catch {
            try {
                readLocalSocket(socketId)?.disconnect(true);
            } catch {
                // best-effort only
            }
        }
    }

    async function evictOwnerBySocketId(key: string, socketId: string): Promise<void> {
        localOwners.delete(key);
        stopRefreshLoop(key);
        disconnectSocketById(socketId);
        if (!params.config.enabled) return;

        const redis = getRedisClient();
        await redis.eval(DEL_IF_SOCKET_ID_SCRIPT, 1, key, socketId);
    }

    function pruneStaleLocalOwner(key: string): void {
        const current = localOwners.get(key);
        if (!current) return;
        if (isSocketLive(current.socketId)) return;
        localOwners.delete(key);
        const timer = refreshTimers.get(key);
        if (timer) {
            clearInterval(timer);
            refreshTimers.delete(key);
        }
    }

    async function readRedisOwner(key: string): Promise<MachineSocketOwnerSnapshot | null> {
        if (!params.config.enabled) return null;
        const redis = getRedisClient();
        const [
            socketId,
            runtimeId,
            cliVersion,
            publicReleaseChannel,
            startupSource,
            serviceManaged,
            serviceLabel,
        ] = await redis.hmget(
            key,
            "socketId",
            "runtimeId",
            "cliVersion",
            "publicReleaseChannel",
            "startupSource",
            "serviceManaged",
            "serviceLabel",
        );
        if (typeof socketId !== "string" || socketId.trim().length === 0) return null;
        return {
            socketId,
            ...(normalizeOptionalString(runtimeId) ? { runtimeId: normalizeOptionalString(runtimeId) } : null),
            ...(normalizeOptionalString(cliVersion) ? { cliVersion: normalizeOptionalString(cliVersion) } : null),
            ...(normalizeOptionalString(publicReleaseChannel) ? { publicReleaseChannel: normalizeOptionalString(publicReleaseChannel) } : null),
            ...(normalizeOptionalString(startupSource) ? { startupSource: normalizeOptionalString(startupSource) } : null),
            ...(serviceManaged === "true" ? { serviceManaged: true } : serviceManaged === "false" ? { serviceManaged: false } : null),
            ...(normalizeOptionalString(serviceLabel) ? { serviceLabel: normalizeOptionalString(serviceLabel) } : null),
        };
    }

    function startRefreshLoop(key: string, socketId: string): void {
        if (!params.config.enabled) return;
        if (refreshTimers.has(key)) return;
        const redis = getRedisClient();
        const intervalMs = Math.max(1000, Math.floor((ttlSeconds * 1000) / 2));
        const instanceId = params.config.instanceId;
        const timer = setInterval(() => {
            void redis.eval(
                REFRESH_IF_SOCKET_ID_SCRIPT,
                1,
                key,
                socketId,
                Date.now().toString(),
                instanceId,
                ttlSeconds.toString(),
            );
        }, intervalMs);
        timer.unref?.();
        refreshTimers.set(key, timer);
    }

    function stopRefreshLoop(key: string): void {
        const timer = refreshTimers.get(key);
        if (!timer) return;
        clearInterval(timer);
        refreshTimers.delete(key);
    }

    return {
        async claimOwner(paramsForClaim: Readonly<{
            accountId: string;
            machineId: string;
            socketId: string;
            owner: MachineSocketOwnerInput;
        }>): Promise<ClaimOwnerResult> {
            const key = resolveOwnershipKey(paramsForClaim);
            pruneStaleLocalOwner(key);

            const takeoverRequested = paramsForClaim.owner.takeoverRequested === true;
            const normalizedOwner = normalizeOwnerSnapshot(paramsForClaim.socketId, paramsForClaim.owner);
            const localOwner = localOwners.get(key);
            const redisOwnerBeforeClaim =
                params.config.enabled && (takeoverRequested || Boolean(normalizedOwner.runtimeId))
                    ? await readRedisOwner(key)
                    : null;
            let takeoverSocketId: string | null = null;
            if (localOwner) {
                if (localOwner.socketId === paramsForClaim.socketId) {
                    localOwners.set(key, normalizedOwner);
                    startRefreshLoop(key, paramsForClaim.socketId);
                    return { result: "already-owned-by-self" };
                }

                if (localOwner.runtimeId && normalizedOwner.runtimeId && localOwner.runtimeId === normalizedOwner.runtimeId) {
                    if (localOwner.socketId !== paramsForClaim.socketId) {
                        disconnectSocketById(localOwner.socketId);
                    }
                    localOwners.set(key, normalizedOwner);
                    stopRefreshLoop(key);
                    startRefreshLoop(key, paramsForClaim.socketId);
                    return { result: "already-owned-by-self" };
                }

                if (isSocketLive(localOwner.socketId)) {
                    if (takeoverRequested && isManualOwner(localOwner)) {
                        takeoverSocketId = localOwner.socketId;
                    } else {
                        return { result: "conflict", owner: localOwner };
                    }
                } else {
                    await evictOwnerBySocketId(key, localOwner.socketId);
                }
            }

            if (params.config.enabled) {
                const redis = getRedisClient();
                const claimResult = await redis.eval(
                    CLAIM_IF_AVAILABLE_OR_SELF_OR_TAKEOVER_SCRIPT,
                    1,
                    key,
                    paramsForClaim.socketId,
                    normalizedOwner.runtimeId ?? "",
                    params.config.instanceId,
                    Date.now().toString(),
                    normalizedOwner.cliVersion ?? "",
                    normalizedOwner.publicReleaseChannel ?? "",
                    normalizedOwner.startupSource ?? "",
                    typeof normalizedOwner.serviceManaged === "boolean" ? String(normalizedOwner.serviceManaged) : "",
                    normalizedOwner.serviceLabel ?? "",
                    ttlSeconds.toString(),
                    takeoverRequested ? "1" : "0",
                );
                if (claimResult === "conflict") {
                    const owner = await readRedisOwner(key);
                    if (owner) {
                        return { result: "conflict", owner };
                    }
                }
                if (claimResult === "self") {
                    const priorSocketId =
                        redisOwnerBeforeClaim?.socketId && redisOwnerBeforeClaim.socketId !== paramsForClaim.socketId
                            ? redisOwnerBeforeClaim.socketId
                            : null;
                    if (priorSocketId) {
                        disconnectSocketById(priorSocketId);
                    }
                    localOwners.set(key, normalizedOwner);
                    stopRefreshLoop(key);
                    startRefreshLoop(key, paramsForClaim.socketId);
                    return { result: "already-owned-by-self" };
                }
                if (claimResult === "takeover") {
                    const takeoverTargetSocketId =
                        takeoverSocketId
                        || (localOwner?.socketId && localOwner.socketId !== paramsForClaim.socketId ? localOwner.socketId : null)
                        || redisOwnerBeforeClaim?.socketId
                        || null;
                    if (takeoverTargetSocketId && takeoverTargetSocketId !== paramsForClaim.socketId) {
                        disconnectSocketById(takeoverTargetSocketId);
                    }
                    localOwners.set(key, normalizedOwner);
                    stopRefreshLoop(key);
                    startRefreshLoop(key, paramsForClaim.socketId);
                    return { result: "takeover-granted" };
                }
            }

            if (takeoverSocketId) {
                disconnectSocketById(takeoverSocketId);
                localOwners.set(key, normalizedOwner);
                stopRefreshLoop(key);
                startRefreshLoop(key, paramsForClaim.socketId);
                return { result: "takeover-granted" };
            }

            localOwners.set(key, normalizedOwner);
            stopRefreshLoop(key);
            startRefreshLoop(key, paramsForClaim.socketId);
            return { result: "granted" };
        },

        async releaseOwner(paramsForRelease: Readonly<{
            accountId: string;
            machineId: string;
            socketId: string;
        }>): Promise<void> {
            const key = resolveOwnershipKey(paramsForRelease);
            const localOwner = localOwners.get(key);
            if (localOwner?.socketId === paramsForRelease.socketId) {
                localOwners.delete(key);
                stopRefreshLoop(key);
            }
            if (!params.config.enabled) return;

            const redis = getRedisClient();
            await redis.eval(DEL_IF_SOCKET_ID_SCRIPT, 1, key, paramsForRelease.socketId);
        },
    };
}
