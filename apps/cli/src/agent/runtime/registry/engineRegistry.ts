import { DirectSessionsProviderIdSchema } from '@happier-dev/protocol';

import { resolveMergedContributionRegistry } from '../../../extensions/registry/createResolvedContributionRegistry';
import type {
    ResolvedBackendContribution,
    ResolvedCatalogEntry,
    ResolvedContributionRegistry,
    ResolvedProviderContribution,
} from '../../../extensions/registry/types';
import { pluginReloadController } from '../../../extensions/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '../../../extensions/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../../../extensions/runtime/resolveExecutablePluginRuntimeRegistry';

import {
    createEmptyBackendExecutionSurfaces,
    type BackendExecutionSurfaces,
    type CliBindingsGetter,
    type CliEngineAdapter,
    type CliRuntimeBindings,
    type EngineAdapterResolution,
    type EngineResolutionSelectedSource,
    type ResolvedCliEngineRegistry,
} from './engineRegistryTypes';
import { createMissingCliEngineAdapter } from './createCliBindings';
import { resolvePluginRuntimeAdapterSurfaces } from './resolvePluginRuntimeAdapterSurfaces';
import type { ExtensionContextV1, RegisterBackendEngineV1 } from '@happier-dev/extension-sdk';
import { configuration } from '@/configuration';
import { isFeatureId } from '@happier-dev/protocol';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { logger } from '@/ui/logger';
import { resolveProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import type { CatalogAgentLookupId } from '@/backends/types';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import {
    createExecutionRunPermissionHandler,
    resolveExecutionRunPermissionDecision,
} from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/sessionLoop/runHostSessionRuntime';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const EXTENSION_CONTEXT_V1_BINDER = Symbol('happier.extensionContextV1.binder');

type ExtensionContextV1Binder = Readonly<{
    bindHostSessionRuntime: (params: HostSessionRuntimeFactoryParams) => void;
    bindExecutionRun: (params: Readonly<{ permissionMode?: string | null }>) => void;
}>;

function readExtensionContextV1Binder(ctx: ExtensionContextV1): ExtensionContextV1Binder | null {
    const record = ctx as unknown as Record<PropertyKey, unknown>;
    const binder = record[EXTENSION_CONTEXT_V1_BINDER];
    return binder && typeof binder === 'object' ? (binder as ExtensionContextV1Binder) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizePathSegment(value: string): string {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '') || 'unknown';
}

function sanitizeEnvKeySegment(value: string): string {
    return String(value ?? '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+/, '')
        .replace(/_+$/, '') || 'UNKNOWN';
}

function parseEnvBoundedInt(name: string, opts: Readonly<{ min: number; max: number; fallback: number }>): number {
    const raw = process.env[name];
    if (typeof raw !== 'string' || raw.trim().length === 0) return opts.fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return opts.fallback;
    return Math.min(opts.max, Math.max(opts.min, parsed));
}

function parseEnvBoolean(name: string, opts?: Readonly<{ defaultValue?: boolean }>): boolean {
    const raw = process.env[name];
    if (typeof raw !== 'string') return opts?.defaultValue ?? false;
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0) return opts?.defaultValue ?? false;
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return opts?.defaultValue ?? false;
}

function resolveExtensionArtifactsDir(params: Readonly<{ backendId: string }>): string | null {
    const backendId = sanitizePathSegment(params.backendId);
    const upper = sanitizeEnvKeySegment(params.backendId);

    const perBackendKey = `HAPPIER_${upper}_DEBUG_ARTIFACTS_DIR`;
    const perBackend = process.env[perBackendKey];
    if (typeof perBackend === 'string' && perBackend.trim().length > 0) {
        return perBackend.trim();
    }

    const globalRoot = process.env.HAPPIER_DEBUG_ARTIFACTS_DIR;
    if (typeof globalRoot === 'string' && globalRoot.trim().length > 0) {
        return `${globalRoot.trim()}/extensions/${backendId}`;
    }

    // Default location is safe, but only used when explicitly enabled by env gating above.
    return join(configuration.happyHomeDir, 'cli', 'logs', 'extensions', backendId);
}

type BoundContextScope =
    | Readonly<{
        kind: 'hostSession';
        getSession: () => ApiSessionClient;
        getTranscriptSession: () => TranscriptSessionPort;
        getPermissionHandler: () => ProviderEnforcedPermissionHandler;
        getPermissionMode: () => unknown;
    }>
    | Readonly<{
        kind: 'executionRun';
        permissionMode: string;
        permissionHandler: ReturnType<typeof createExecutionRunPermissionHandler>;
    }>;

function createHostExtensionContextV1(params?: ResolveEngineRegistryParams): ExtensionContextV1 {
    const configValues = Object.freeze({
        currentCliVersion: configuration.currentCliVersion,
        happyHomeDir: params?.happyHomeDir ?? null,
    });

    // Keep this stable and side-effect-free. Implementations may memoize feature queries.
    const featureEnabledMemo = new Map<string, boolean>();
    const features: ExtensionContextV1['features'] = Object.freeze({
        isEnabled: (featureIdRaw: string) => {
            const cached = featureEnabledMemo.get(featureIdRaw);
            if (cached !== undefined) {
                return cached;
            }
            if (!isFeatureId(featureIdRaw)) {
                featureEnabledMemo.set(featureIdRaw, false);
                return false;
            }
            const decision = resolveCliFeatureDecision({
                featureId: featureIdRaw,
                env: process.env,
            });
            const enabled = decision.state === 'enabled';
            featureEnabledMemo.set(featureIdRaw, enabled);
            return enabled;
        },
    });

    const abortController = new AbortController();

    let currentScope: BoundContextScope | null = null;
    let initialScopeBoundResolve: (() => void) | null = null;
    const initialScopeBound = new Promise<void>((resolve) => {
        initialScopeBoundResolve = resolve;
    });

    const backendId = params?.backendId?.trim() || 'unknown';
    const artifactsEnabled = parseEnvBoolean('HAPPIER_EXTENSION_ARTIFACTS_ENABLED', { defaultValue: false });
    const telemetryEnabled = parseEnvBoolean('HAPPIER_EXTENSION_TELEMETRY_ENABLED', { defaultValue: false });
    const artifactsDir = artifactsEnabled || telemetryEnabled ? resolveExtensionArtifactsDir({ backendId }) : null;
    const maxBytes = parseEnvBoundedInt('HAPPIER_EXTENSION_ARTIFACTS_MAX_BYTES', { min: 0, max: 10_000_000, fallback: 1_000_000 });
    let artifactsBytesWritten = 0;
    let artifactsTruncationWritten = false;
    let telemetryBytesWritten = 0;
    let telemetryTruncationWritten = false;

    function appendBoundedLineSync(params2: Readonly<{ filePath: string; line: string; kind: 'artifacts' | 'telemetry' }>): void {
        if (!params2.line) return;
        if (maxBytes === 0) return;

        const state = params2.kind === 'artifacts'
            ? { bytesWritten: artifactsBytesWritten, truncationWritten: artifactsTruncationWritten }
            : { bytesWritten: telemetryBytesWritten, truncationWritten: telemetryTruncationWritten };

        const buf = Buffer.from(params2.line);
        if (maxBytes > 0 && state.bytesWritten >= maxBytes) {
            if (!state.truncationWritten) {
                state.truncationWritten = true;
                appendFileSync(params2.filePath, '\n...[truncated]\n');
            }
            return;
        }

        const remaining = maxBytes > 0 ? Math.max(0, maxBytes - state.bytesWritten) : buf.length;
        const slice = maxBytes > 0 ? buf.subarray(0, remaining) : buf;
        appendFileSync(params2.filePath, slice);
        state.bytesWritten += slice.length;

        if (params2.kind === 'artifacts') {
            artifactsBytesWritten = state.bytesWritten;
            artifactsTruncationWritten = state.truncationWritten;
        } else {
            telemetryBytesWritten = state.bytesWritten;
            telemetryTruncationWritten = state.truncationWritten;
        }
    }

    function appendJsonLine(params2: Readonly<{ kind: 'artifacts' | 'telemetry'; value: unknown }>): void {
        if (!artifactsDir) return;
        const filePath = `${artifactsDir}/extension-${params2.kind}.jsonl`;
        const record = {
            at: Date.now(),
            backendId,
            kind: params2.kind,
            value: params2.value,
        };
        try {
            mkdirSync(dirname(filePath), { recursive: true });
            appendBoundedLineSync({ filePath, line: `${JSON.stringify(record)}\n`, kind: params2.kind });
        } catch (error) {
            logger.debug('[ExtensionContextV1] Failed to write extension record (non-fatal)', error);
        }
    }

    const ensureScope = async (): Promise<BoundContextScope> => {
        if (!currentScope) {
            await initialScopeBound;
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return currentScope!;
    };

    const binder: ExtensionContextV1Binder = Object.freeze({
        bindHostSessionRuntime: (runtimeParams) => {
            const getSession = () => runtimeParams.session as unknown as ApiSessionClient;
            const getTranscriptSession = () => runtimeParams.transcriptSession as unknown as TranscriptSessionPort;
            const getPermissionHandler = () => runtimeParams.permissionHandler as unknown as ProviderEnforcedPermissionHandler;
            const getPermissionMode = () => runtimeParams.getPermissionMode?.() ?? 'default';
            currentScope = Object.freeze({
                kind: 'hostSession',
                getSession,
                getTranscriptSession,
                getPermissionHandler,
                getPermissionMode,
            });
            initialScopeBoundResolve?.();
            initialScopeBoundResolve = null;
        },
        bindExecutionRun: (executionRunParams) => {
            const permissionMode = typeof executionRunParams.permissionMode === 'string'
                && executionRunParams.permissionMode.trim().length > 0
                ? executionRunParams.permissionMode.trim()
                : 'default';
            const permissionHandler = createExecutionRunPermissionHandler({
                backendId,
                permissionMode,
            });
            currentScope = Object.freeze({
                kind: 'executionRun',
                permissionMode,
                permissionHandler,
            });
            initialScopeBoundResolve?.();
            initialScopeBoundResolve = null;
        },
    });

    return Object.freeze({
        logger: Object.freeze({
            debug: (message: string, fields?: Readonly<Record<string, unknown>>) => logger.debug(message, fields),
            info: (message: string, fields?: Readonly<Record<string, unknown>>) => logger.info(message, fields),
            warn: (message: string, fields?: Readonly<Record<string, unknown>>) => logger.warn(message, fields),
            error: (message: string, fields?: Readonly<Record<string, unknown>>) => logger.warn(`[ERROR] ${message}`, fields),
        }),
        config: Object.freeze({
            values: configValues,
        }),
        features,
        managedTools: Object.freeze({
            resolve: async (toolId: string) => {
                // V1: treat the tool id as the catalog agent lookup id for provider CLI runtime resolution.
                // The concrete shapes are stabilized by the runtime lane; callers may cast the result.
                return resolveProviderCliLaunchSpec(toolId as CatalogAgentLookupId, { processEnv: process.env });
            },
        }),
        sessions: Object.freeze({
            send: async (request: unknown) => {
                const scope = await ensureScope();
                if (scope.kind === 'executionRun') {
                    logger.debug('[ExtensionContextV1] sessions.send (execution-run no-op)', { request });
                    return { ok: true };
                }
                const session = scope.getSession();
                if (!isRecord(request) || typeof request.kind !== 'string') {
                    logger.debug('[ExtensionContextV1] sessions.send invalid request (ignored)', { request });
                    return { ok: false, error: 'invalid_request' };
                }
                if (request.kind === 'userText' && typeof request.text === 'string') {
                    session.sendUserTextMessage(request.text, isRecord(request.opts) ? request.opts as any : undefined);
                    return { ok: true };
                }
                if (request.kind === 'sessionEvent' && request.event) {
                    session.sendSessionEvent(request.event as any, typeof request.id === 'string' ? request.id : undefined);
                    return { ok: true };
                }
                if (request.kind === 'agentMessageEphemeral' && typeof request.provider === 'string' && request.body && isRecord(request.opts)) {
                    const localId = typeof request.opts.localId === 'string' ? request.opts.localId : '';
                    const createdAt = typeof request.opts.createdAt === 'number' ? request.opts.createdAt : Date.now();
                    session.sendAgentMessageEphemeral(request.provider as any, request.body as any, {
                        localId,
                        createdAt,
                        updatedAt: typeof request.opts.updatedAt === 'number' ? request.opts.updatedAt : createdAt,
                        ...(request.opts.meta ? { meta: request.opts.meta as any } : {}),
                    });
                    return { ok: true };
                }
                if (request.kind === 'agentMessageCommitted' && typeof request.provider === 'string' && request.body && isRecord(request.opts)) {
                    const localId = typeof request.opts.localId === 'string' ? request.opts.localId : '';
                    await session.sendAgentMessageCommitted(request.provider as any, request.body as any, {
                        localId,
                        ...(request.opts.meta ? { meta: request.opts.meta as any } : {}),
                    });
                    return { ok: true };
                }
                logger.debug('[ExtensionContextV1] sessions.send unknown kind (ignored)', { kind: request.kind });
                return { ok: false, error: 'unsupported_kind' };
            },
            subscribe: (request: unknown, onEvent: (event: unknown) => void) => {
                void onEvent;
                let unsubscribed = false;
                let unsubscribeImpl: (() => void) | null = null;

                void ensureScope().then((scope) => {
                    if (unsubscribed) return;
                    if (scope.kind === 'executionRun') {
                        // No-op: execution-run session subscription surface is not wired in V1.
                        return;
                    }
                    const sessionAny = scope.getSession() as any;
                    const eventName =
                        isRecord(request) && typeof request.eventName === 'string' ? request.eventName : 'metadata-updated';
                    if (typeof sessionAny.on !== 'function' || typeof sessionAny.off !== 'function') {
                        return;
                    }
                    const handler = (payload: unknown) => onEvent(payload);
                    sessionAny.on(eventName, handler);
                    unsubscribeImpl = () => {
                        try {
                            sessionAny.off(eventName, handler);
                        } catch {
                            // Best effort
                        }
                    };
                }).catch(() => {
                    // Best effort
                });

                return {
                    unsubscribe: () => {
                        unsubscribed = true;
                        unsubscribeImpl?.();
                    },
                };
            },
            writeMetadata: async (request: unknown) => {
                const scope = await ensureScope();
                if (scope.kind === 'executionRun') {
                    logger.debug('[ExtensionContextV1] sessions.writeMetadata (execution-run no-op)', { request });
                    return;
                }
                const session = scope.getSession();
                if (!isRecord(request) || typeof request.kind !== 'string') return;
                if (request.kind === 'set') {
                    const next = isRecord(request.metadata) ? request.metadata : {};
                    await session.updateMetadata(() => next as any);
                } else if (request.kind === 'update' && typeof request.handler === 'function') {
                    await session.updateMetadata(request.handler as any);
                }
            },
            writeAgentState: async (request: unknown) => {
                const scope = await ensureScope();
                if (scope.kind === 'executionRun') {
                    logger.debug('[ExtensionContextV1] sessions.writeAgentState (execution-run no-op)', { request });
                    return;
                }
                const session = scope.getSession();
                if (!isRecord(request) || typeof request.kind !== 'string') return;
                if (request.kind === 'set') {
                    const next = isRecord(request.agentState) ? request.agentState : {};
                    await session.updateAgentState(() => next as any);
                } else if (request.kind === 'update' && typeof request.handler === 'function') {
                    await session.updateAgentState(request.handler as any);
                }
            },
        }),
        transcripts: Object.freeze({
            append: async (turn: unknown) => {
                const scope = await ensureScope();
                if (scope.kind === 'executionRun') {
                    logger.debug('[ExtensionContextV1] transcripts.append (execution-run no-op)', { turn });
                    return;
                }
                if (!isRecord(turn) || typeof turn.kind !== 'string') return;
                const session = scope.getSession();
                const transcript = scope.getTranscriptSession();
                if (turn.kind === 'userText' && typeof turn.text === 'string') {
                    session.sendUserTextMessage(turn.text, isRecord(turn.opts) ? turn.opts as any : undefined);
                    return;
                }
                if (turn.kind === 'agentMessageCommitted' && typeof turn.provider === 'string' && turn.body && typeof turn.localId === 'string') {
                    await transcript.sendAgentMessageCommitted(turn.provider as any, turn.body as any, {
                        localId: turn.localId,
                        ...(isRecord(turn.meta) ? { meta: turn.meta as any } : {}),
                    });
                    return;
                }
                if (turn.kind === 'agentMessageEphemeral' && typeof turn.provider === 'string' && turn.body && typeof turn.localId === 'string') {
                    const createdAt = typeof turn.createdAt === 'number' ? turn.createdAt : Date.now();
                    const updatedAt = typeof turn.updatedAt === 'number' ? turn.updatedAt : createdAt;
                    await transcript.sendAgentMessageEphemeral?.(turn.provider as any, turn.body as any, {
                        localId: turn.localId,
                        createdAt,
                        updatedAt,
                        ...(isRecord(turn.meta) ? { meta: turn.meta as any } : {}),
                    } as any);
                }
            },
        }),
        permissions: Object.freeze({
            requestDecision: async (request: unknown) => {
	                const scope = await ensureScope();
		                if (scope.kind === 'executionRun') {
		                    // Execution runs may run without an interactive prompt surface. If an extracted backend
		                    // asks the host for a decision, apply deterministic execution-run semantics.
		                    const toolName = isRecord(request) && typeof request.toolName === 'string'
		                        ? request.toolName
		                        : null;
		                    if (!toolName) {
		                        return { decision: 'denied' };
		                    }
		                    return {
		                        decision: resolveExecutionRunPermissionDecision({
		                            permissionMode: scope.permissionMode,
		                            backendId,
		                            toolName,
		                        }),
		                    };
		                }
                const handler = scope.getPermissionHandler();
                if (isRecord(request) && typeof request.toolCallId === 'string' && typeof request.toolName === 'string') {
                    return await handler.handleToolCall(request.toolCallId, request.toolName, request.input);
                }
                return { decision: 'approved_for_session' };
            },
            getEffectiveMode: () => {
                const scope = currentScope;
                if (!scope) return 'default';
                if (scope.kind === 'executionRun') return scope.permissionMode;
                return scope.getPermissionMode();
            },
        }),
        telemetry: Object.freeze({
            emit: (observation: unknown) => {
                if (!telemetryEnabled) {
                    logger.debug('[ExtensionContextV1] telemetry.emit (disabled)', { observation });
                    return;
                }
                appendJsonLine({ kind: 'telemetry', value: observation });
            },
        }),
        artifacts: Object.freeze({
            write: async (record: unknown) => {
                if (!artifactsEnabled) {
                    logger.debug('[ExtensionContextV1] artifacts.write (disabled)', { record });
                    return;
                }
                appendJsonLine({ kind: 'artifacts', value: record });
            },
        }),
        abort: Object.freeze({
            signal: abortController.signal,
        }),
        [EXTENSION_CONTEXT_V1_BINDER]: binder,
    });
}

export type {
    BackendExecutionSurfaces,
    EngineAdapterResolution,
    EngineResolutionDiagnostic,
    EngineResolutionDiagnosticCode,
    EngineResolutionSelectedSource,
    ResolvedCliEngineRegistry,
} from './engineRegistryTypes';

type ResolveEngineRegistryParams = Readonly<{
    happyHomeDir?: string;
    backendId?: string;
}>;

function toEngineSelectedSource(
    backendProvenance: EngineAdapterResolution['provenance'],
    providerRuntimePreference?: 'system-first' | 'managed-first' | null,
): EngineResolutionSelectedSource | undefined {
    if (backendProvenance === 'external') {
        return 'plugin';
    }
    if (providerRuntimePreference === 'managed-first') {
        return 'managed';
    }
    if (providerRuntimePreference === 'system-first') {
        return 'system';
    }
    return undefined;
}

async function resolveCatalogExecutionSurfacesForEntry(entry: ResolvedCatalogEntry): Promise<BackendExecutionSurfaces> {
    const directSessions = DirectSessionsProviderIdSchema.safeParse(entry.id).success
        && entry.getDirectSessionProviderOps
        ? await entry.getDirectSessionProviderOps()
        : null;

    return {
        terminalRuntime: entry.getTerminalRuntimeOps ? await entry.getTerminalRuntimeOps() : null,
        directSessions,
        attach: entry.getProviderAttachOps ? await entry.getProviderAttachOps() : null,
        sessionHandoff: entry.getSessionHandoffProviderOps ? await entry.getSessionHandoffProviderOps() : null,
    };
}

function resolveBindingsGetter(entry: Readonly<{
    getBindings?: CliBindingsGetter | undefined;
}>): CliBindingsGetter | null {
    return typeof entry.getBindings === 'function' ? entry.getBindings : null;
}

async function resolveBackendBindings(params: Readonly<{
    backend: ResolvedBackendContribution;
    provider: ResolvedProviderContribution;
    executionSurfaces: BackendExecutionSurfaces;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    extensionContext: ExtensionContextV1;
}>): Promise<CliEngineAdapter | null> {
    const backendWithBinding = params.backend as ResolvedBackendContribution & Readonly<{
        getBindings?: CliBindingsGetter | undefined;
    }>;
    const getBindings = resolveBindingsGetter(backendWithBinding);
    if (!getBindings) {
        const runtimeRegistry = params.runtimeRegistry;
        if (!runtimeRegistry) {
            return null;
        }
        const engineEntry = runtimeRegistry.backendEnginesByBackendId.get(params.backend.id);
        const registration = engineEntry?.registration as RegisterBackendEngineV1 | undefined;
        if (!registration) {
            return null;
        }
        const engine = await registration.create(params.extensionContext);
        if (!engine.bindings) {
            return null;
        }
        const binder = readExtensionContextV1Binder(params.extensionContext);
        const rawBindings = engine.bindings as unknown as CliRuntimeBindings;
        const wrappedBindings: CliRuntimeBindings = Object.freeze({
            async createSessionRuntime(sessionParams: unknown) {
                const plan = await rawBindings.createSessionRuntime(sessionParams);
                if (!binder) return plan as any;
                if (!plan || typeof plan !== 'object') return plan as any;
                const planRecord = plan as any;
                const config = planRecord.config;
                const createSessionRuntime = config?.createSessionRuntime;
                if (typeof createSessionRuntime !== 'function') return plan as any;
                const wrappedConfig = Object.freeze({
                    ...config,
                    createSessionRuntime: async (runtimeParams: HostSessionRuntimeFactoryParams) => {
                        binder.bindHostSessionRuntime(runtimeParams);
                        return await createSessionRuntime(runtimeParams);
                    },
                });
                return Object.freeze({
                    ...planRecord,
                    config: wrappedConfig,
                });
            },
            createExecutionRunBackend(opts: any) {
                binder?.bindExecutionRun({ permissionMode: opts?.permissionMode });
                return rawBindings.createExecutionRunBackend(opts);
            },
        });
        return {
            bindings: wrappedBindings,
            facets: engine.facets ?? undefined,
            messageMeta: engine.messageMeta ?? undefined,
        };
    }

    const bindingFactory = await getBindings();
    return await bindingFactory({
        backend: params.backend,
        provider: params.provider,
        executionSurfaces: params.executionSurfaces,
    });
}

function createMissingProviderContribution(params: Readonly<{
    backend: ResolvedBackendContribution;
}>): ResolvedProviderContribution {
    return {
        id: params.backend.providerId,
        provenance: params.backend.provenance,
        source: params.backend.source,
        definition: {
            kindVersion: 1,
            id: params.backend.providerId,
            ownedBackendIds: Object.freeze([]),
        },
    };
}

async function resolveEngineAdapterResolutionFromRegistry(params: Readonly<{
    backendId: string;
    contributions: ResolvedContributionRegistry;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    extensionContext: ExtensionContextV1;
}>): Promise<EngineAdapterResolution | null> {
    const backend = params.contributions.backendDefinitionsById.get(params.backendId);
    if (!backend) {
        return null;
    }

    const provider = params.contributions.providerDefinitionsById.get(backend.providerId);
    if (!provider) {
        const missingProvider = createMissingProviderContribution({ backend });
        return {
            backendId: backend.id,
            providerId: backend.providerId,
            provenance: backend.provenance,
            selectedSource: toEngineSelectedSource(backend.provenance, undefined),
            backend,
            provider: missingProvider,
            engineAdapter: createMissingCliEngineAdapter({ backend }),
            executionSurfaces: createEmptyBackendExecutionSurfaces(),
            diagnostics: Object.freeze([{
                code: 'engine_provider_missing',
                message: `Missing provider contribution '${backend.providerId}' for backend '${backend.id}'`,
                backendId: backend.id,
                providerId: backend.providerId,
                pluginId: backend.pluginId,
            }]),
        };
    }

    if (backend.provenance === 'first_party') {
        const entry = params.contributions.catalogEntriesById[backend.id];
        const executionSurfaces = entry
            ? await resolveCatalogExecutionSurfacesForEntry(entry)
            : createEmptyBackendExecutionSurfaces();
        const backendWithBinding = backend as ResolvedBackendContribution & Readonly<{ getBindings?: CliBindingsGetter | undefined }>;
        const hasExplicitBindings = Boolean(resolveBindingsGetter(backendWithBinding));
        const engineAdapter = await resolveBackendBindings({
            backend,
            provider,
            executionSurfaces,
            runtimeRegistry: params.runtimeRegistry,
            extensionContext: params.extensionContext,
        });
        return {
            backendId: backend.id,
            providerId: provider.id,
            provenance: backend.provenance,
            selectedSource: !hasExplicitBindings && params.runtimeRegistry ? 'plugin' : toEngineSelectedSource(
                backend.provenance,
                provider.runtimeSpec?.sourcePreferenceDefault,
            ),
            backend,
            provider,
            engineAdapter: engineAdapter ?? createMissingCliEngineAdapter({ backend }),
            executionSurfaces,
            diagnostics: Object.freeze([]),
        };
    }

    const runtimeRegistry = params.runtimeRegistry;
    if (!runtimeRegistry) {
        return {
            backendId: backend.id,
            providerId: provider.id,
            provenance: backend.provenance,
            selectedSource: 'plugin',
            backend,
            provider,
            engineAdapter: createMissingCliEngineAdapter({ backend }),
            executionSurfaces: createEmptyBackendExecutionSurfaces(),
            diagnostics: Object.freeze([{
                code: 'engine_backend_missing',
                message: `No executable runtime registry available for plugin backend '${backend.id}'`,
                backendId: backend.id,
                providerId: provider.id,
                pluginId: backend.pluginId,
            }]),
        };
    }

    const pluginResolution = await resolvePluginRuntimeAdapterSurfaces({
        backend,
        provider,
        runtimeRegistry,
    });
    const engineAdapter = await resolveBackendBindings({
        backend,
        provider,
        executionSurfaces: pluginResolution.surfaces,
        runtimeRegistry,
        extensionContext: params.extensionContext,
    });
    return {
        backendId: backend.id,
        providerId: provider.id,
        provenance: backend.provenance,
        selectedSource: 'plugin',
        backend,
        provider,
        engineAdapter: engineAdapter ?? createMissingCliEngineAdapter({ backend }),
        executionSurfaces: pluginResolution.surfaces,
        diagnostics: pluginResolution.diagnostics,
    };
}

export async function resolveCliEngineRegistry(
    params?: ResolveEngineRegistryParams,
): Promise<ResolvedCliEngineRegistry> {
    const activeRuntimeRegistry = pluginReloadController.getState().activeRegistry;
    const contributions = activeRuntimeRegistry?.contributions
        ?? await resolveMergedContributionRegistry({
            happyHomeDir: params?.happyHomeDir,
        });
    let runtimeRegistryPromise: Promise<ResolvedExecutablePluginRuntimeRegistry> | null = activeRuntimeRegistry
        ? Promise.resolve(activeRuntimeRegistry)
        : null;
    const resolutionPromises = new Map<string, Promise<EngineAdapterResolution | null>>();

    async function resolveRuntimeRegistry(): Promise<ResolvedExecutablePluginRuntimeRegistry> {
        if (!runtimeRegistryPromise) {
            runtimeRegistryPromise = resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: params?.happyHomeDir,
                contributions,
            });
        }
        return await runtimeRegistryPromise;
    }

    return Object.freeze({
        contributions,
        async resolveForBackendId(backendId: string): Promise<EngineAdapterResolution | null> {
            const existing = resolutionPromises.get(backendId);
            if (existing) {
                return await existing;
            }
            const resolutionPromise = (async (): Promise<EngineAdapterResolution | null> => {
                let resolutionContributions = contributions;
                let backend = resolutionContributions.backendDefinitionsById.get(backendId) ?? null;
                let runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null = null;
                const extensionContext = createHostExtensionContextV1({ ...(params ?? {}), backendId });

                const backendWithBinding = backend as (ResolvedBackendContribution & Readonly<{ getBindings?: CliBindingsGetter | undefined }>) | null;
                const hasExplicitBindings = backendWithBinding ? Boolean(resolveBindingsGetter(backendWithBinding)) : false;

                if (!backend || backend.provenance === 'external' || !hasExplicitBindings) {
                    runtimeRegistry = await resolveRuntimeRegistry();
                    resolutionContributions = runtimeRegistry.contributions;
                    backend = resolutionContributions.backendDefinitionsById.get(backendId) ?? backend;
                }

                if (!backend) {
                    return null;
                }

                return await resolveEngineAdapterResolutionFromRegistry({
                    backendId,
                    contributions: resolutionContributions,
                    runtimeRegistry,
                    extensionContext,
                });
            })();
            resolutionPromises.set(backendId, resolutionPromise);
            return await resolutionPromise;
        },
        async resolveExecutionSurfaces(backendId?: string | null): Promise<BackendExecutionSurfaces> {
            if (!backendId) {
                return createEmptyBackendExecutionSurfaces();
            }
            const resolution = await this.resolveForBackendId(backendId);
            return resolution?.executionSurfaces ?? createEmptyBackendExecutionSurfaces();
        },
    });
}

export async function resolveBackendEngineAdapterResolution(
    backendId?: string | null,
    params?: ResolveEngineRegistryParams,
): Promise<EngineAdapterResolution | null> {
    if (!backendId) {
        return null;
    }
    const registry = await resolveCliEngineRegistry(params);
    return await registry.resolveForBackendId(backendId);
}

export async function resolveBackendExecutionSurfaces(
    backendId?: string | null,
    params?: ResolveEngineRegistryParams,
): Promise<BackendExecutionSurfaces> {
    const resolution = await resolveBackendEngineAdapterResolution(backendId, params);
    return resolution?.executionSurfaces ?? createEmptyBackendExecutionSurfaces();
}
