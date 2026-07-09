import { randomUUID } from 'node:crypto';

import type {
    TranscriptFileFollowHandleV1,
    TranscriptFileFollowInputV1,
    TranscriptFileFollowPolicyInputV1,
    TranscriptFileFollowRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

import { createJsonlFollowController } from '@/api/session/fileBackedTranscripts/jsonl';
import type {
    JsonlFollowerMetricEvent,
    JsonlFollowPolicyInputV1,
} from '@/api/session/fileBackedTranscripts/jsonl';

import { PluginContextServiceError } from '../errors';
import type { TranscriptFileFollowPathGrantRegistry } from './fileFollowGrants';
import {
    isTranscriptFileFollowPathInsideRoot,
    normalizeTranscriptFileFollowAbsolutePath,
    resolveTranscriptFileFollowRealPath,
} from './fileFollowGrants';

type WatchFile = (file: string, onFileChange: (file: string) => void) => () => void;

const MIN_POLL_INTERVAL_MS = 25;
const MAX_POLL_INTERVAL_MS = 60_000;

type TranscriptFileFollowAccessRequest = Readonly<{
    path: string;
    pluginId?: string;
    runtimeId?: string;
    sessionId?: string | null;
}>;

type AuthorizedTranscriptFileFollowPath = Readonly<{
    filePath: string;
    expiresAtMs?: number;
}>;

export type PluginTranscriptFileFollowAccessPolicy = (
    request: TranscriptFileFollowAccessRequest,
) => boolean | Promise<boolean>;

export function createPluginTranscriptFileFollowService(params?: Readonly<{
    pluginId?: string;
    runtimeId?: string;
    readSessionId?: () => string | null;
    allowedPaths?: readonly string[];
    allowedPathRoots?: readonly string[];
    canFollowPath?: PluginTranscriptFileFollowAccessPolicy;
    fileFollowPathGrants?: TranscriptFileFollowPathGrantRegistry;
    policy?: JsonlFollowPolicyInputV1;
    watchFile?: WatchFile;
    addDisposable?: (disposable: Readonly<{ dispose: () => void | Promise<void> }>) => unknown;
}>): TranscriptFileFollowRuntimeServiceV1 {
    const allowedPaths = new Set((params?.allowedPaths ?? []).flatMap((path) => {
        const normalized = normalizeTranscriptFileFollowAbsolutePath(path);
        return normalized ? [normalized] : [];
    }));
    const allowedPathRoots = (params?.allowedPathRoots ?? []).flatMap((path) => {
        const normalized = normalizeTranscriptFileFollowAbsolutePath(path);
        return normalized ? [normalized] : [];
    });

    const service: TranscriptFileFollowRuntimeServiceV1 = Object.freeze({
        async follow(input: TranscriptFileFollowInputV1): Promise<TranscriptFileFollowHandleV1> {
            const filePath = normalizeTranscriptFileFollowAbsolutePath(input.path);
            if (!filePath) {
                throw new PluginContextServiceError(
                    'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_INVALID',
                    'ctx.transcripts.fileFollow.follow requires an absolute transcript path',
                );
            }
            if (input.strategy !== undefined && input.strategy !== 'poll') {
                throw new PluginContextServiceError(
                    'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_STRATEGY_UNSUPPORTED',
                    `ctx.transcripts.fileFollow.follow strategy '${String(input.strategy)}' is not supported`,
                );
            }
            if (input.startAt !== 'beginning' && input.startAt !== 'end') {
                throw new PluginContextServiceError(
                    'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_START_INVALID',
                    'ctx.transcripts.fileFollow.follow startAt must be beginning or end',
                );
            }
            if (typeof input.onLine !== 'function') {
                throw new PluginContextServiceError(
                    'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_HANDLER_INVALID',
                    'ctx.transcripts.fileFollow.follow requires an onLine handler',
                );
            }
            if (input.signal?.aborted === true) {
                throw new PluginContextServiceError(
                    'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_ABORTED',
                    'ctx.transcripts.fileFollow.follow was aborted before it started',
                );
            }
            const authorizedPath = await resolveFollowFilePath({
                filePath,
                pluginId: params?.pluginId,
                runtimeId: params?.runtimeId,
                sessionId: params?.readSessionId?.() ?? null,
                allowedPaths,
                allowedPathRoots,
                canFollowPath: params?.canFollowPath,
                fileFollowPathGrants: params?.fileFollowPathGrants,
            });
            if (!authorizedPath) {
                throw new PluginContextServiceError(
                    'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED',
                    'ctx.transcripts.fileFollow.follow path is not granted',
                );
            }
            const followFilePath = authorizedPath.filePath;

            const id = `transcript-file-follow:${randomUUID()}`;
            let sequence = 0;
            let closed = false;
            let lineHandlerCallDepth = 0;
            let allowFinalDrainDelivery = false;
            let closePromise: Promise<void> | null = null;
            let expiryTimer: NodeJS.Timeout | null = null;
            const clearExpiryTimer = () => {
                if (expiryTimer) {
                    clearTimeout(expiryTimer);
                    expiryTimer = null;
                }
            };
            const controller = createJsonlFollowController({
                filePath: followFilePath,
                startAtEnd: input.startAt === 'end',
                policy: normalizePluginFileFollowPolicy(input.policy, params?.policy),
                watchFile: params?.watchFile,
                onLine: async (line) => {
                    if (closed && !allowFinalDrainDelivery) {
                        return;
                    }
                    sequence += 1;
                    lineHandlerCallDepth += 1;
                    let result: void | Promise<void>;
                    try {
                        result = input.onLine(Object.freeze({
                            line,
                            sourcePath: followFilePath,
                            sequence,
                        }));
                    } finally {
                        lineHandlerCallDepth = Math.max(0, lineHandlerCallDepth - 1);
                    }
                    await result;
                },
                onError: (error) => {
                    notifyPluginErrorHandler(input, error);
                },
                metrics: {
                    onEvent: (event) => {
                        notifyPluginResetHandler(input, event);
                    },
                },
            });

            const close = async (options?: Parameters<TranscriptFileFollowHandleV1['close']>[0]): Promise<void> => {
                if (closed) {
                    return closePromise ?? Promise.resolve();
                }
                closed = true;
                clearExpiryTimer();
                input.signal?.removeEventListener('abort', abortListener);
                const finalDrain = options?.finalDrain === true && lineHandlerCallDepth === 0;
                allowFinalDrainDelivery = finalDrain;
                closePromise = withOptionalTimeout(
                    controller.dispose({ finalDrain }),
                    options?.drainTimeoutMs,
                    'ctx.transcripts.fileFollow.close timed out',
                ).finally(() => {
                    allowFinalDrainDelivery = false;
                });
                await closePromise;
            };

            const abortListener = () => {
                void close();
            };
            input.signal?.addEventListener('abort', abortListener, { once: true });
            const armExpiryTimer = () => {
                if (authorizedPath.expiresAtMs === undefined) {
                    return;
                }
                const expiresInMs = Math.max(0, authorizedPath.expiresAtMs - Date.now());
                expiryTimer = setTimeout(() => {
                    void close();
                }, expiresInMs);
                expiryTimer.unref?.();
            };

            const handle: TranscriptFileFollowHandleV1 = Object.freeze({
                id,
                async drainNow(options) {
                    if (closed) {
                        return;
                    }
                    await withOptionalTimeout(
                        controller.drainNow(),
                        options?.timeoutMs,
                        'ctx.transcripts.fileFollow.drainNow timed out',
                    );
                },
                close,
            });

            try {
                await controller.attach();
                armExpiryTimer();
            } catch (error) {
                clearExpiryTimer();
                input.signal?.removeEventListener('abort', abortListener);
                await controller.dispose().catch(() => undefined);
                throw error;
            }
            params?.addDisposable?.(Object.freeze({
                dispose: () => close(),
            }));
            return handle;
        },
    });

    return service;
}

function notifyPluginErrorHandler(input: TranscriptFileFollowInputV1, error: unknown): void {
    if (!input.onError) {
        return;
    }
    Promise.resolve(input.onError(error)).catch(() => undefined);
}

function notifyPluginResetHandler(input: TranscriptFileFollowInputV1, event: JsonlFollowerMetricEvent): void {
    if (event.type !== 'file_reset' || !input.onReset) {
        return;
    }
    Promise.resolve(input.onReset({ reason: event.reason })).catch(() => undefined);
}

function normalizePluginFileFollowPolicy(
    input: TranscriptFileFollowPolicyInputV1 | undefined,
    base: JsonlFollowPolicyInputV1 | undefined,
): JsonlFollowPolicyInputV1 {
    const normalized = { ...(base ?? {}) };
    if (input?.pollIntervalMs !== undefined) {
        const pollIntervalMs = normalizeBoundedPollInterval(input.pollIntervalMs, 'pollIntervalMs');
        normalized.activeBurstPollIntervalMs = pollIntervalMs;
        normalized.activeFallbackPollIntervalMs = pollIntervalMs;
        normalized.idleFallbackPollIntervalMs = pollIntervalMs;
    }
    if (input?.missingFileRetryIntervalMs !== undefined) {
        normalized.missingFileRetryIntervalMs = normalizeBoundedPollInterval(
            input.missingFileRetryIntervalMs,
            'missingFileRetryIntervalMs',
        );
    }
    if (input?.maxDrainRowsPerTick !== undefined) {
        normalized.maxDrainRowsPerTick = normalizePositiveInteger(input.maxDrainRowsPerTick, 'maxDrainRowsPerTick');
    }
    if (input?.maxDrainBytesPerTick !== undefined) {
        normalized.maxDrainBytesPerTick = normalizePositiveInteger(input.maxDrainBytesPerTick, 'maxDrainBytesPerTick');
    }
    return normalized;
}
function normalizeBoundedPollInterval(value: number, fieldName: string): number {
    const normalized = normalizePositiveInteger(value, fieldName);
    if (normalized < MIN_POLL_INTERVAL_MS || normalized > MAX_POLL_INTERVAL_MS) {
        throw new PluginContextServiceError(
            'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_POLICY_INVALID',
            `ctx.transcripts.fileFollow.follow policy.${fieldName} must be between ${MIN_POLL_INTERVAL_MS} and ${MAX_POLL_INTERVAL_MS}`,
        );
    }
    return normalized;
}

function normalizePositiveInteger(value: number, fieldName: string): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new PluginContextServiceError(
            'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_POLICY_INVALID',
            `ctx.transcripts.fileFollow.follow policy.${fieldName} must be a positive integer`,
        );
    }
    return Math.trunc(value);
}

async function resolveFollowFilePath(params: Readonly<{
    filePath: string;
    pluginId?: string;
    runtimeId?: string;
    sessionId?: string | null;
    allowedPaths: ReadonlySet<string>;
    allowedPathRoots: readonly string[];
    canFollowPath?: PluginTranscriptFileFollowAccessPolicy;
    fileFollowPathGrants?: TranscriptFileFollowPathGrantRegistry;
}>): Promise<AuthorizedTranscriptFileFollowPath | null> {
    const realFilePathRequired = params.allowedPaths.size > 0
        || params.allowedPathRoots.length > 0
        || Boolean(params.fileFollowPathGrants)
        || Boolean(params.canFollowPath);
    const realFilePath = realFilePathRequired
        ? await resolveTranscriptFileFollowRealPath(params.filePath)
        : null;
    if (realFilePathRequired && !realFilePath) {
        return null;
    }
    if (realFilePath) {
        for (const allowedPath of params.allowedPaths) {
            const realAllowedPath = await resolveTranscriptFileFollowRealPath(allowedPath);
            if (realAllowedPath && realAllowedPath === realFilePath) {
                return Object.freeze({ filePath: realFilePath });
            }
        }
        for (const root of params.allowedPathRoots) {
            const realRoot = await resolveTranscriptFileFollowRealPath(root);
            if (realRoot && isTranscriptFileFollowPathInsideRoot(realFilePath, realRoot)) {
                return Object.freeze({ filePath: realFilePath });
            }
        }
    }
    if (params.fileFollowPathGrants && params.pluginId && params.runtimeId) {
        const granted = await params.fileFollowPathGrants.resolveFollowPath({
            path: params.filePath,
            pluginId: params.pluginId,
            runtimeId: params.runtimeId,
            sessionId: params.sessionId ?? null,
        });
        if (granted) {
            return Object.freeze({
                filePath: granted.path,
                ...(granted.expiresAtMs !== undefined ? { expiresAtMs: granted.expiresAtMs } : {}),
            });
        }
    }
    if (realFilePath && await params.canFollowPath?.({
        path: params.filePath,
        pluginId: params.pluginId,
        runtimeId: params.runtimeId,
        sessionId: params.sessionId ?? null,
    }) === true) {
        return Object.freeze({ filePath: realFilePath });
    }
    return null;
}

async function withOptionalTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number | undefined,
    message: string,
): Promise<T> {
    if (timeoutMs === undefined) {
        return await promise;
    }
    const normalizedTimeoutMs = normalizePositiveInteger(timeoutMs, 'timeoutMs');
    let timeout: NodeJS.Timeout | null = null;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => {
                    reject(new PluginContextServiceError('PLUGIN_TRANSCRIPTS_FILE_FOLLOW_TIMEOUT', message));
                }, normalizedTimeoutMs);
            }),
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}
