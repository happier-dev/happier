import { stat } from 'node:fs/promises';

import type {
    ExternalSessionFailureCodeV1,
    ExternalSessionFollowLeaseV1,
    ExternalSessionResolvedIdentityV1,
    ExternalSessionRuntimeContextV1,
    ExternalSessionSurfaceV1,
    ExternalSessionTranscriptPageV1,
    SessionStateUpdateV1,
    ExternalSessionsSource,
} from '@happier-dev/plugin-sdk/sessions';

import { listClaudeExternalSessionCandidates as listClaudeJsonlSessionCandidates } from './candidates.js';
import { resolveClaudeJsonlSessionFile } from './files.js';
import { readClaudeJsonlSessionWorkingDirectory } from './metadata.js';
import {
    resolveCanonicalConfiguredClaudeConfigDir,
    resolveClaudeConfigDir,
    validateClaudeExternalSessionSource,
} from './source.js';
import {
    pageClaudeExternalSessionTranscript as pageClaudeJsonlExternalSessionTranscript,
    readAfterClaudeExternalSessionTranscript as readAfterClaudeJsonlExternalSessionTranscript,
} from './transcript.js';

const CLAUDE_EXTERNAL_SESSION_FOLLOW_MAX_BYTES = 1024 * 1024;
const CLAUDE_EXTERNAL_SESSION_FOLLOW_MAX_ITEMS = 100;

export {
    resolveClaudeJsonlSessionFile as resolveClaudeExternalSessionJsonlFile,
} from './files.js';
export {
    readClaudeJsonlSessionTitle as readClaudeExternalSessionTitle,
    readClaudeJsonlSessionWorkingDirectory as readClaudeExternalSessionWorkingDirectory,
} from './metadata.js';
export {
    pageClaudeRawExternalSessionTranscript,
    readAfterClaudeRawExternalSessionTranscript,
    readClaudeRawJsonlSessionMessages,
} from './rawTranscript.js';

export type ClaudeExternalSessionTakeoverSpawnPlan = Readonly<{
    directory: string;
    backendTarget: Readonly<{ kind: 'backend'; backendId: 'claude'; sourceKind: 'built_in' }>;
    existingSessionId: string;
    resume: string;
    approvedNewDirectoryCreation: true;
    transcriptStorage: 'direct';
    environmentVariables: Readonly<{ CLAUDE_CONFIG_DIR: string }>;
}>;

function normalizeNonEmptyString(value: string | null | undefined): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed || null;
}

function ok<T>(value: T) {
    return { ok: true as const, value };
}

function failed(code: ExternalSessionFailureCodeV1, message: string, retryable?: boolean) {
    return {
        ok: false as const,
        code,
        message,
        ...(typeof retryable === 'boolean' ? { retryable } : {}),
    };
}

function providerUnavailable(message: string) {
    return failed('agent_unavailable', message, true);
}

function buildProviderSessionIdUpdate(providerSessionId: string): SessionStateUpdateV1<'identity.providerSessionId'> {
    return {
        fieldId: 'identity.providerSessionId',
        value: providerSessionId,
    };
}

function resolveMetadataDirectory(metadata: Readonly<Record<string, unknown>>): string | null {
    const keys = ['path', 'directory', 'workingDirectory', 'cwd'];
    for (const key of keys) {
        const value = metadata[key];
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (normalized) return normalized;
    }
    return null;
}

function mergeExternalSessionEnvironmentVariables(values: Array<Record<string, string> | null>): Record<string, string> | undefined {
    const merged: Record<string, string> = {};
    for (const value of values) {
        for (const [key, raw] of Object.entries(value ?? {})) {
            const normalized = String(raw ?? '').trim();
            if (!normalized) continue;
            merged[key] = normalized;
        }
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveClaudeExternalSessionTakeoverSpawnPlan(params: Readonly<{
    sessionId: string;
    remoteSessionId: string;
    directory: string | null | undefined;
    configDir: string | null | undefined;
}>): ClaudeExternalSessionTakeoverSpawnPlan | null {
    const directory = normalizeNonEmptyString(params.directory);
    const configDir = normalizeNonEmptyString(params.configDir);
    if (!directory || !configDir) return null;

    return {
        directory,
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        existingSessionId: params.sessionId,
        resume: params.remoteSessionId,
        approvedNewDirectoryCreation: true,
        transcriptStorage: 'direct',
        environmentVariables: {
            CLAUDE_CONFIG_DIR: configDir,
        },
    };
}

function resolveClaudeExternalSessionIdentity(params: Readonly<{
    providerSessionId: string;
    source: ExternalSessionsSource;
    runtimeDescriptor?: ExternalSessionResolvedIdentityV1['runtimeDescriptor'];
}>): ExternalSessionResolvedIdentityV1 {
    const sessionStateUpdates = [buildProviderSessionIdUpdate(params.providerSessionId)];
    const metadataPatch = { claudeSessionId: params.providerSessionId };
    return {
        providerSessionId: params.providerSessionId,
        source: params.source,
        runtimeDescriptor: params.runtimeDescriptor ?? null,
        vendorMetadata: metadataPatch,
        externalSessionMetadata: metadataPatch,
        sessionStateUpdates,
    };
}

export function canonicalizeClaudeExternalSessionLinkedSource(params: Readonly<{
    remoteSessionId: string;
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
}>): Readonly<{ remoteSessionId: string; source: ExternalSessionsSource }> {
    if (params.source.kind !== 'claudeConfig') {
        return {
            remoteSessionId: params.remoteSessionId,
            source: params.source,
        };
    }

    return {
        remoteSessionId: params.remoteSessionId,
        source: {
            ...params.source,
            configDir: resolveCanonicalConfiguredClaudeConfigDir({ env: params.env }),
        },
    };
}

async function safeTranscriptPage(operation: () => Promise<ExternalSessionTranscriptPageV1>) {
    try {
        return ok(await operation());
    } catch (error) {
        return providerUnavailable(error instanceof Error ? error.message : 'Claude external-session transcript operation failed');
    }
}

async function acquireClaudeJsonlFileFollowLease(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
    providerSessionId: string;
    runtime?: ExternalSessionRuntimeContextV1;
}>): Promise<ExternalSessionFollowLeaseV1 | null> {
    const fileFollow = params.runtime?.transcripts?.fileFollow;
    if (!fileFollow) {
        return null;
    }
    const resolved = await resolveClaudeJsonlSessionFile({
        source: params.source,
        env: params.env,
        remoteSessionId: params.providerSessionId,
    });
    if (!resolved) {
        return null;
    }
    const initialTail = await readAfterClaudeJsonlExternalSessionTranscript({
        source: params.source,
        env: params.env,
        providerSessionId: params.providerSessionId,
        cursor: 'tail',
        maxBytes: CLAUDE_EXTERNAL_SESSION_FOLLOW_MAX_BYTES,
        maxItems: 1,
    });
    let tailCursor = initialTail.nextCursor;
    const listeners = new Set<Parameters<NonNullable<ExternalSessionFollowLeaseV1['subscribeToTranscriptUpdates']>>[0]>();
    async function readTailCursor(): Promise<string | null> {
        return (await readAfterClaudeJsonlExternalSessionTranscript({
            source: params.source,
            env: params.env,
            providerSessionId: params.providerSessionId,
            cursor: 'tail',
            maxBytes: CLAUDE_EXTERNAL_SESSION_FOLLOW_MAX_BYTES,
            maxItems: 1,
        })).nextCursor;
    }
    async function notifyListeners(update: Parameters<Parameters<NonNullable<ExternalSessionFollowLeaseV1['subscribeToTranscriptUpdates']>>[0]>[0]): Promise<void> {
        await Promise.all([...listeners].map(async (listener) => {
            await listener(update);
        }));
    }
    const handle = await fileFollow.follow({
        path: resolved.filePath,
        startAt: 'end',
        strategy: 'poll',
        signal: params.runtime?.signal,
        onLine: async () => {
            if (!tailCursor) {
                return;
            }
            const fromCursor = tailCursor;
            const update = await readAfterClaudeJsonlExternalSessionTranscript({
                source: params.source,
                env: params.env,
                providerSessionId: params.providerSessionId,
                cursor: tailCursor,
                maxBytes: CLAUDE_EXTERNAL_SESSION_FOLLOW_MAX_BYTES,
                maxItems: CLAUDE_EXTERNAL_SESSION_FOLLOW_MAX_ITEMS,
            });
            tailCursor = update.nextCursor ?? tailCursor;
            if (update.items.length === 0 && !update.truncated) {
                return;
            }
            await notifyListeners({
                items: update.items,
                fromCursor,
                nextCursor: update.nextCursor,
                truncated: update.truncated,
            });
        },
        onReset: async () => {
            const fromCursor = tailCursor;
            tailCursor = await readTailCursor() ?? tailCursor;
            await notifyListeners({
                items: [],
                fromCursor,
                nextCursor: tailCursor,
                truncated: true,
            });
        },
        onError: async (error) => {
            await params.runtime?.diagnostics.issue({
                code: 'external_session_file_follow_error',
                severity: 'warning',
                safeMessage: error instanceof Error ? error.message : 'Claude external-session file-follow failed.',
            });
        },
    });

    return {
        release: async () => {
            listeners.clear();
            await handle.close({ finalDrain: true });
        },
        getTailCursor: () => tailCursor,
        subscribeToTranscriptUpdates: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

export function createClaudeExternalSessionSurface(params: Readonly<{
    env?: NodeJS.ProcessEnv;
}> = {}): ExternalSessionSurfaceV1 {
    const readEnv = () => params.env ?? process.env;
    const validateSourceForOperation = (
        source: ExternalSessionsSource,
        operationEnv: NodeJS.ProcessEnv = readEnv(),
    ) => {
        const env = operationEnv;
        const validation = validateClaudeExternalSessionSource({ source, env });
        return validation.ok
            ? { ok: true as const, source: validation.source }
            : failed('source_invalid', validation.error);
    };

    const surface: ExternalSessionSurfaceV1 = {
        resolveSource: ({ source, env: requestEnv }) => {
            const env = requestEnv ?? readEnv();
            const validation = validateClaudeExternalSessionSource({ source, env });
            return validation.ok ? ok({ source: validation.source }) : failed('source_invalid', validation.error);
        },
        listCandidates: async ({ source, cursor, limit, searchTerm, searchMode }) => {
            const env = readEnv();
            const validation = validateSourceForOperation(source);
            if (!validation.ok) return validation;
            try {
                return ok(await listClaudeJsonlSessionCandidates({
                    source: validation.source,
                    env,
                    cursor,
                    limit,
                    searchTerm,
                    searchMode,
                }));
            } catch (error) {
                return providerUnavailable(error instanceof Error ? error.message : 'Claude external-session listing failed');
            }
        },
        getActivity: async ({ source, providerSessionId }) => {
            const env = readEnv();
            const validation = validateSourceForOperation(source);
            if (!validation.ok) return validation;
            const resolved = await resolveClaudeJsonlSessionFile({
                source: validation.source,
                env,
                remoteSessionId: providerSessionId,
            });
            if (!resolved) {
                return ok({ lastActivityAtMs: null, isRunning: false });
            }
            try {
                const file = await stat(resolved.filePath);
                const lastActivityAtMs = file.isFile() ? Math.trunc(file.mtimeMs) : null;
                return ok({
                    lastActivityAtMs,
                    isRunning: false,
                });
            } catch {
                return ok({ lastActivityAtMs: null, isRunning: false });
            }
        },
        pageTranscript: async ({ source, providerSessionId, direction, cursor, maxBytes, maxItems }) => {
            const env = readEnv();
            const validation = validateSourceForOperation(source);
            if (!validation.ok) return validation;
            return await safeTranscriptPage(async () => await pageClaudeJsonlExternalSessionTranscript({
                source: validation.source,
                env,
                providerSessionId,
                direction,
                cursor,
                maxBytes,
                maxItems,
            }));
        },
        readAfterTranscript: async ({ source, providerSessionId, cursor, maxBytes, maxItems }) => {
            const env = readEnv();
            const validation = validateSourceForOperation(source);
            if (!validation.ok) return validation;
            return await safeTranscriptPage(async () => await readAfterClaudeJsonlExternalSessionTranscript({
                source: validation.source,
                env,
                providerSessionId,
                cursor,
                maxBytes,
                maxItems,
            }));
        },
        resolveFollowTranscriptPath: async ({ source, providerSessionId }) => {
            const env = readEnv();
            const validation = validateSourceForOperation(source);
            if (!validation.ok) return validation;
            const resolved = await resolveClaudeJsonlSessionFile({
                source: validation.source,
                env,
                remoteSessionId: providerSessionId,
            });
            return resolved
                ? ok({ path: resolved.filePath, sourceId: providerSessionId })
                : failed('follow_not_supported', 'Claude external-session transcript file is unavailable.');
        },
        acquireFollowLease: async ({ source, providerSessionId, runtime }) => {
            const env = readEnv();
            const validation = validateSourceForOperation(source);
            if (!validation.ok) return validation;
            try {
                const lease = await acquireClaudeJsonlFileFollowLease({
                    source: validation.source,
                    env,
                    providerSessionId,
                    runtime,
                });
                return lease
                    ? ok(lease)
                    : failed('follow_not_supported', 'Claude external-session file-follow is unavailable.');
            } catch (error) {
                return providerUnavailable(error instanceof Error ? error.message : 'Claude external-session file-follow failed');
            }
        },
        resolveLinkIdentity: ({ providerSessionId, source, runtimeDescriptor }) => {
            const env = readEnv();
            const validation = validateSourceForOperation(source);
            if (!validation.ok) return validation;
            return ok(resolveClaudeExternalSessionIdentity({
                providerSessionId,
                source: validation.source,
                runtimeDescriptor,
            }));
        },
        resolveLinkedIdentity: ({ metadata, providerSessionId, source }) => {
            const env = readEnv();
            if (source.kind !== 'claudeConfig') {
                return failed('source_invalid', 'provider/source mismatch');
            }
            const canonical = canonicalizeClaudeExternalSessionLinkedSource({
                remoteSessionId: providerSessionId,
                source,
                env,
            });
            return ok({
                ...resolveClaudeExternalSessionIdentity({
                    providerSessionId: canonical.remoteSessionId,
                    source: canonical.source,
                    runtimeDescriptor: null,
                }),
            });
        },
        resolveTakeoverLaunch: async ({ linkedSessionId, providerSessionId, source, metadata }) => {
            const env = readEnv();
            const validation = validateSourceForOperation(source);
            if (!validation.ok) return validation;
            const configDir = resolveClaudeConfigDir({ source: validation.source, env });
            const directory =
                resolveMetadataDirectory(metadata)
                ?? await readClaudeJsonlSessionWorkingDirectory({
                    source: validation.source,
                    remoteSessionId: providerSessionId,
                    env,
                });
            const plan = resolveClaudeExternalSessionTakeoverSpawnPlan({
                sessionId: linkedSessionId,
                remoteSessionId: providerSessionId,
                directory,
                configDir,
            });
            if (!plan) {
                return failed('takeover_not_available', 'Claude external-session takeover requires a working directory.');
            }
            const sessionStateUpdates = [buildProviderSessionIdUpdate(providerSessionId)];
            return ok({
                providerSessionId,
                source: validation.source,
                launch: {
                    directory: plan.directory,
                    environmentVariables: mergeExternalSessionEnvironmentVariables([plan.environmentVariables]),
                    sessionStateUpdates,
                },
            });
        },
    };
    return surface;
}

export const claudeExternalSessionSurface = createClaudeExternalSessionSurface();
export const resolveClaudeExternalSessionSource = claudeExternalSessionSurface.resolveSource;
export const listClaudeExternalSessionCandidates = claudeExternalSessionSurface.listCandidates;
export const getClaudeExternalSessionActivity = claudeExternalSessionSurface.getActivity;
export const pageClaudeExternalSessionTranscript = claudeExternalSessionSurface.pageTranscript;
export const readClaudeExternalSessionAfterTranscript = claudeExternalSessionSurface.readAfterTranscript;
export const resolveClaudeExternalSessionFollowTranscriptPath = claudeExternalSessionSurface.resolveFollowTranscriptPath;
export const acquireClaudeExternalSessionFollowLease = claudeExternalSessionSurface.acquireFollowLease;
export const resolveClaudeExternalSessionLinkIdentity = claudeExternalSessionSurface.resolveLinkIdentity;
export const resolveLinkedClaudeExternalSessionIdentity = claudeExternalSessionSurface.resolveLinkedIdentity;
export const resolveClaudeExternalSessionTakeoverLaunch = claudeExternalSessionSurface.resolveTakeoverLaunch;
