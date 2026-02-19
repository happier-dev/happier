import { open } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { Metadata } from '@/api/types';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';

type SessionLogTailRequest = {
    maxBytes?: number;
};

type SessionLogTailResponse = {
    success: boolean;
    path?: string;
    tail?: string;
    truncated?: boolean;
    bytesRead?: number;
    totalBytes?: number;
    error?: string;
};

const DEFAULT_MAX_BYTES = 200_000;
const MIN_MAX_BYTES = 1_024;
const MAX_MAX_BYTES = 1_000_000;

function normalizeMaxBytes(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_BYTES;
    const normalized = Math.floor(value);
    return Math.min(MAX_MAX_BYTES, Math.max(MIN_MAX_BYTES, normalized));
}

function canonicalizePath(path: string): string {
    const resolved = resolve(path);
    try {
        return realpathSync(resolved);
    } catch {
        try {
            const parent = realpathSync(dirname(resolved));
            return resolve(parent, basename(resolved));
        } catch {
            return resolved;
        }
    }
}

function isPathInside(targetPath: string, allowedDir: string): boolean {
    const rel = relative(allowedDir, targetPath);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function readTail(path: string, maxBytes: number): Promise<{
    tail: string;
    truncated: boolean;
    bytesRead: number;
    totalBytes: number;
}> {
    const file = await open(path, 'r');
    try {
        const metadata = await file.stat();
        const start = Math.max(0, metadata.size - maxBytes);
        const size = Math.max(0, metadata.size - start);
        if (size === 0) {
            return { tail: '', truncated: false, bytesRead: 0, totalBytes: metadata.size };
        }

        const buffer = Buffer.alloc(size);
        const { bytesRead } = await file.read(buffer, 0, size, start);
        return {
            tail: buffer.subarray(0, bytesRead).toString('utf8'),
            truncated: start > 0,
            bytesRead,
            totalBytes: metadata.size,
        };
    } finally {
        await file.close();
    }
}

export function registerSessionLogTailHandler(
    rpcHandlerManager: RpcHandlerRegistrar,
    opts: {
        getSessionMetadata?: () => Metadata | null;
    },
): void {
    rpcHandlerManager.registerHandler<SessionLogTailRequest, SessionLogTailResponse>(
        RPC_METHODS.SESSION_LOG_TAIL,
        async (request) => {
            try {
                const metadata = opts.getSessionMetadata?.() ?? null;
                const sessionLogPath = typeof metadata?.sessionLogPath === 'string' ? metadata.sessionLogPath.trim() : '';
                if (!sessionLogPath) {
                    return {
                        success: false,
                        error: 'Session log path is unavailable for this session',
                    };
                }

                if (!sessionLogPath.toLowerCase().endsWith('.log')) {
                    return {
                        success: false,
                        error: 'Session log path must point to a .log file',
                    };
                }

                const happyHomeDir = typeof metadata?.happyHomeDir === 'string' ? metadata.happyHomeDir.trim() : '';
                if (!happyHomeDir) {
                    return {
                        success: false,
                        error: 'Session happyHomeDir is unavailable for log validation',
                    };
                }

                const canonicalLogPath = canonicalizePath(sessionLogPath);
                const canonicalLogsDir = canonicalizePath(resolve(happyHomeDir, 'logs'));
                if (!isPathInside(canonicalLogPath, canonicalLogsDir)) {
                    return {
                        success: false,
                        error: `Session log path is outside allowed logs directory: ${canonicalLogsDir}`,
                    };
                }

                const maxBytes = normalizeMaxBytes(request?.maxBytes);
                const tail = await readTail(canonicalLogPath, maxBytes);
                return {
                    success: true,
                    path: canonicalLogPath,
                    tail: tail.tail,
                    truncated: tail.truncated,
                    bytesRead: tail.bytesRead,
                    totalBytes: tail.totalBytes,
                };
            } catch (error) {
                logger.debug('[session.log.tail] Failed to read session log tail', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to read session log tail',
                };
            }
        },
    );
}
