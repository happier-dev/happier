import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
    createWorkspaceLockLeaseValue,
    workspaceLockLeaseMatchesOwner,
} from '../workspaceLockLease.mjs';

function parsePositiveEnvInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseLockOwner(lockPath) {
    try {
        const raw = readFileSync(lockPath, 'utf8').trim();
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function serializeLockOwner(nowMs, ownerToken) {
    return JSON.stringify({
        pid: process.pid,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        token: ownerToken,
    });
}

function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code !== 'ESRCH';
    }
}

function lockOwnersMatch(expectedOwner, currentOwner) {
    if (!expectedOwner || !currentOwner) return false;
    if (typeof expectedOwner.token === 'string' && expectedOwner.token) {
        return expectedOwner.token === currentOwner.token;
    }
    return (
        Number(expectedOwner.pid) === Number(currentOwner.pid)
        && Number(expectedOwner.createdAtMs) === Number(currentOwner.createdAtMs)
        && Number(expectedOwner.updatedAtMs) === Number(currentOwner.updatedAtMs)
    );
}

function getReclaimableLockOwner(lockPath, staleAfterMs, nowMs) {
    try {
        const stats = statSync(lockPath);
        const owner = parseLockOwner(lockPath);
        const ownerPid = Number(owner?.pid);
        if (Number.isFinite(ownerPid) && ownerPid > 1 && !isPidAlive(ownerPid)) {
            return owner ?? { pid: ownerPid };
        }
        const updatedAtMs = Number(owner?.updatedAtMs ?? owner?.createdAtMs ?? stats.mtimeMs ?? 0);
        return updatedAtMs > 0 && nowMs - updatedAtMs > staleAfterMs ? owner ?? { updatedAtMs } : null;
    } catch {
        return null;
    }
}

function describeLockOwner(lockPath, nowMs) {
    const owner = parseLockOwner(lockPath);
    if (!owner) return 'owner=unknown';
    const ageMs = Math.max(0, nowMs - Number(owner.updatedAtMs ?? owner.createdAtMs ?? nowMs));
    return `pid=${String(owner.pid ?? 'unknown')} ageMs=${ageMs}`;
}

function callerAlreadyHoldsLock(lockPath, env) {
    return workspaceLockLeaseMatchesOwner({
        lockPath,
        leaseValue: env?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
        owner: parseLockOwner(lockPath),
    });
}

export function deleteLockIfOwnerMatches(lockPath, expectedOwner, {
    rmSyncImpl = rmSync,
    readLockOwner = parseLockOwner,
} = {}) {
    const currentOwner = readLockOwner(lockPath);
    if (!lockOwnersMatch(expectedOwner, currentOwner)) {
        return false;
    }
    rmSyncImpl(lockPath, { force: true });
    return true;
}

export async function withPackageDistBuildLock(fn, {
    env = process.env,
    lockPath,
    pollIntervalMs = parsePositiveEnvInt(env.HAPPIER_PACKAGE_DIST_BUILD_LOCK_POLL_MS, 250),
    staleAfterMs = parsePositiveEnvInt(env.HAPPIER_PACKAGE_DIST_BUILD_LOCK_STALE_AFTER_MS, 240_000),
    timeoutMs = parsePositiveEnvInt(env.HAPPIER_PACKAGE_DIST_BUILD_LOCK_TIMEOUT_MS, 240_000),
    now = Date.now,
    ownerTokenFactory = randomUUID,
    rmSyncImpl = rmSync,
    unlinkSyncImpl = unlinkSync,
} = {}) {
    if (!lockPath) {
        throw new Error('withPackageDistBuildLock requires lockPath');
    }

    if (callerAlreadyHoldsLock(lockPath, env)) {
        return await fn({
            alreadyHeld: true,
            waited: false,
            heldLockValue: env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
        });
    }

    mkdirSync(dirname(lockPath), { recursive: true });

    const startedAt = now();
    let heartbeat = null;
    let waited = false;
    let acquired = false;
    const ownerToken = ownerTokenFactory();
    let acquiredOwner = null;

    while (true) {
        try {
            const fd = openSync(lockPath, 'wx');
            try {
                const createdAtMs = now();
                acquiredOwner = {
                    pid: process.pid,
                    createdAtMs,
                    updatedAtMs: createdAtMs,
                    token: ownerToken,
                };
                writeFileSync(fd, JSON.stringify(acquiredOwner), 'utf8');
            } finally {
                closeSync(fd);
            }
            acquired = true;
            break;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            const reclaimableOwner = getReclaimableLockOwner(lockPath, staleAfterMs, now());
            if (reclaimableOwner) {
                try {
                    deleteLockIfOwnerMatches(lockPath, reclaimableOwner, { rmSyncImpl });
                } catch {
                    // ignore stale-lock cleanup races
                }
                continue;
            }
            if (now() - startedAt > timeoutMs) {
                throw new Error(
                    `Timed out waiting for package dist build lock: ${lockPath} (${describeLockOwner(lockPath, now())})`,
                );
            }
            waited = true;
            await delay(pollIntervalMs);
        }
    }

    try {
        heartbeat = setInterval(() => {
            try {
                const heartbeatAtMs = now();
                acquiredOwner = {
                    ...acquiredOwner,
                    pid: process.pid,
                    createdAtMs: Number(acquiredOwner?.createdAtMs ?? heartbeatAtMs),
                    updatedAtMs: heartbeatAtMs,
                    token: ownerToken,
                };
                writeFileSync(lockPath, JSON.stringify(acquiredOwner), 'utf8');
            } catch {
                // ignore heartbeat write races during teardown
            }
        }, Math.max(500, Math.min(5_000, Math.floor(staleAfterMs / 4))));
        return await fn({
            alreadyHeld: false,
            waited,
            heldLockValue: createWorkspaceLockLeaseValue({ lockPath, ownerToken }),
        });
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (acquired) {
            try {
                deleteLockIfOwnerMatches(lockPath, acquiredOwner, { rmSyncImpl: unlinkSyncImpl });
            } catch {
                // ignore teardown races
            }
        }
    }
}
