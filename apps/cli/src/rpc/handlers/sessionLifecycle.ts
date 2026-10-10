import type { RpcActionExecutor } from './_actionDispatchAdapter';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { readStoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import type { SessionSpawnDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import {
    type ActionSpecRpcRegistrationScope,
    SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES,
    SESSION_LIFECYCLE_RPC_SCOPES,
    SESSION_SPAWN_NEW_RPC_SCOPES,
} from './actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers, type RegisterActionSpecRpcHandlersParams } from './registerActionSpecRpcHandlers';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import {
    awaitSpawnedSessionId,
    type SpawnSessionNonceResolver,
} from '@/session/services/awaitSpawnedSessionId';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { SpawnDaemonSessionRequestSchema } from './spawnSessionOptionsContract';
import type { SessionLifecycleActionHandler } from '@/session/actions/lifecycle/sessionLifecycleTypes';
import { SessionRequesterBootstrapRpcRequestV1Schema, openSessionRequesterBootstrapRpcRequestV1,
    SessionRequesterHandoffBootstrapRpcRequestV1Schema, openSessionRequesterHandoffBootstrapRpcRequestV1,
    SessionRequesterHandoffPreflightBootstrapRpcRequestV1Schema, openSessionRequesterHandoffPreflightBootstrapRpcRequestV1,
    type SessionRequesterHandoffBootstrapRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { CurrentMachineInstallation } from '@/daemon/identity/currentMachineInstallation';
import { admitRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createMachineSessionDirectTargetTransport } from './sessionServerStartLifecycleAdapter';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { readAccountRoleOverridesFromSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ResolveRequesterSessionRuntimeContext, RequesterSessionRuntimeContext, AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { readDefaultSessionIdFromRpcInput } from './registerActionSpecRpcHandlers';
import { isAdmittedRequesterSessionBootstrapCurrent } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import type { SessionHandoffPrepareTargetResultGetSuccessResponse } from '@happier-dev/protocol';

function matchesPreparedHandoffNativeTarget(
    input: Pick<SpawnSessionOptions, 'agentTarget' | 'backendTarget' | 'directory' | 'resume' | 'transcriptStorage' | 'runtimeDescriptorV1'>,
    prepared: SessionHandoffPrepareTargetResultGetSuccessResponse | undefined,
): boolean {
    if (!prepared) return false;
    const selectedTarget = input.agentTarget ?? input.backendTarget;
    const preparedTarget = prepared.resume.agentTarget ?? {
        kind: 'backend' as const, backendId: prepared.resume.agent, sourceKind: 'built_in' as const,
    };
    return !!selectedTarget
        && input.resume === prepared.resume.resume && input.directory === prepared.resume.directory
        && input.transcriptStorage === prepared.resume.transcriptStorage
        && buildBackendTargetKeyV2(selectedTarget) === buildBackendTargetKeyV2(preparedTarget)
        && sameStrictJsonValue(input.runtimeDescriptorV1 ?? null, prepared.runtimeDescriptorV1 ?? null);
}

type RpcRegistrar = RpcHandlerRegistrar;
type RequesterSessionRuntimeOwner = Readonly<{
    serverId: string;
    resolve: ResolveRequesterSessionRuntimeContext;
    release(context: RequesterSessionRuntimeContext): Promise<void>;
    stopForHandoff?(sessionId: string, expectedSpawnNonce: string): Promise<'stopped' | 'already_inactive' | 'failed'>;
}>;

async function withRequesterSessionRuntime(input: unknown, context: RpcHandlerContext,
    sessionId: string, owner: RequesterSessionRuntimeOwner | undefined,
    handler: (input: unknown, context?: RpcHandlerContext) => Promise<unknown>): Promise<unknown> {
    const refused = () => ({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
    if (!owner || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) return refused();
    const admission = context.machineAdmission;
    const runtime = await owner.resolve(sessionId, admission ? { serverId: owner.serverId,
        accountId: admission.actorAccountId, machineId: admission.machineId, installationId: admission.installationId } : undefined);
    if (!runtime) return refused();
    try {
        const bootstrap = runtime.bootstrap;
        if (bootstrap.getBoundSessionId() !== sessionId || bootstrap.attribution.serverId !== owner.serverId
            || !await isAdmittedRequesterSessionBootstrapCurrent({ ...context, requesterSessionBootstrap: bootstrap })) return refused();
        return await handler(input, { ...context, requesterSessionBootstrap: bootstrap,
            localActionContext: { ...context.localActionContext, requesterWorkAttributionV1: bootstrap.attribution } });
    } finally { await owner.release(runtime); }
}

function isHandoffPhaseBound(input: unknown, context: RpcHandlerContext | undefined): boolean {
    const binding = context?.callerInputAuthorization?.binding;
    if (binding?.handoffPreflight) {
        const admission = binding.handoffAdmission;
        return !!admission && !!input && typeof input === 'object'
            && Reflect.get(input, 'sessionId') === admission.sessionId
            && Reflect.get(input, 'sourceMachineId') === admission.sourceMachineId
            && Reflect.get(input, 'targetMachineId') === admission.targetMachineId;
    }
    if (!binding?.handoffContinuation) return true;
    const admission = binding.handoffAdmission;
    if (!admission || !input || typeof input !== 'object'
        || Reflect.get(input, 'handoffId') !== binding.handoffContinuation.handoffId) return false;
    return [['sessionId', admission.sessionId], ['sourceMachineId', admission.sourceMachineId],
        ['targetMachineId', admission.targetMachineId]].every(([key, expected]) =>
        !Object.hasOwn(input, key!) || Reflect.get(input, key!) === expected);
}

type SessionLifecycleActionId =
    | 'session.stop'
    | 'session.fork'
    | 'session.continue_with_replay'
    | 'session.rollback'
    | 'session.checkpoint_code_rollback'
    | 'session.checkpoint'
    | 'session.restore'
    | 'session.handoff'
    | 'session.handoff.prepare_target'
    | 'session.handoff.prepare_target.resume'
    | 'session.handoff.prepare_target_result.get'
    | 'session.handoff.commit'
    | 'session.handoff.abort'
    | 'session.handoff.status.get';

export type SessionLifecycleActionHandlers = Partial<Record<
    SessionLifecycleActionId,
    (input: unknown, context?: RpcHandlerContext) => Promise<unknown>
>>;
export { SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES };

export type SessionHandoffRequesterBootstrapBoundary = Readonly<{
    serverId: string;
    serverHttpBaseUrl: string;
    happyHomeDir: string;
    getObservedServerIdentityId(): string | null | Promise<string | null>;
    readInstallation?(): Promise<CurrentMachineInstallation | null>;
    retainHandoffRequesterCustody?(request: SessionRequesterHandoffBootstrapRpcRequestV1['input'],
        bootstrap: AdmittedRequesterSessionBootstrap): Promise<void>;
}>;

/** Handoff ingress owns both private carriers; preflight reads never acquire persistent transfer custody. */
export async function withSessionHandoffRequesterBootstrap(params: Readonly<{
    method: string;
    input: unknown;
    context?: RpcHandlerContext;
    boundary?: SessionHandoffRequesterBootstrapBoundary;
    handler(input: unknown, context?: RpcHandlerContext): Promise<unknown>;
}>): Promise<unknown> {
    const { input, context, boundary, handler } = params;
    const kind = input && typeof input === 'object' ? Reflect.get(input, 'kind') : undefined;
    const readOnly = kind === 'requester_session_handoff_preflight_bootstrap_v1';
    if (!readOnly && kind !== 'requester_session_handoff_bootstrap_v1') return await handler(input, context);
    const refused = () => ({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
    const parsed = readOnly ? SessionRequesterHandoffPreflightBootstrapRpcRequestV1Schema.safeParse(input)
        : SessionRequesterHandoffBootstrapRpcRequestV1Schema.safeParse(input);
    if (params.method !== (readOnly ? RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3
        : RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3) || !parsed.success
        || !boundary || !context?.machineAdmission || !context.verifyMachineAdmissionCurrent
        || parsed.data.input.targetMachineId !== context.machineAdmission.machineId
        || !await context.verifyMachineAdmissionCurrent() || !isHandoffPhaseBound(parsed.data.input, context)) return refused();
    let bootstrap = parsed.data.requesterBootstrap;
    if ('kind' in bootstrap) {
        const installation = await boundary.readInstallation?.().catch(() => null);
        const opened = installation && installation.machineId === context.machineAdmission.machineId
            && installation.identity.installationId === context.machineAdmission.installationId
            ? (readOnly ? openSessionRequesterHandoffPreflightBootstrapRpcRequestV1 : openSessionRequesterHandoffBootstrapRpcRequestV1)({
                request: parsed.data, machineId: installation.machineId, installationId: installation.identity.installationId,
                installationPrivateKey: decodeBase64(installation.identity.privateKey, 'base64url') }) : null;
        if (!opened) return refused();
        bootstrap = opened.requesterBootstrap;
    } else if (readOnly || context.machineAdmission.encryptionMode === 'plain'
        && (bootstrap.credentials.secret || bootstrap.credentials.encryption)) return refused();
    let active = true;
    const custody = await admitRequesterSessionBootstrap({ bootstrap, boundary,
        context: readOnly ? { ...context,
            verifyMachineAdmissionCurrent: async () => active && await context.verifyMachineAdmissionCurrent!() } : context,
        existingSessionId: parsed.data.input.sessionId }).catch(() => null);
    if (!custody) return refused();
    try {
        const authorization = context.callerInputAuthorization
            ? await custody.admitted.projectExternalActionAuthorization(context.callerInputAuthorization,
                await boundary.getObservedServerIdentityId() ?? '', context.signal) : undefined;
        if (context.callerInputAuthorization && !authorization) { await custody.cleanupOnFailure(); return refused(); }
        if (!readOnly && parsed.data.kind === 'requester_session_handoff_bootstrap_v1') {
            const binding = await custody.admitted.bindExistingSession(parsed.data.input.sessionId);
            if (!binding) { await custody.cleanupOnFailure(); return refused(); }
            await boundary.retainHandoffRequesterCustody?.(parsed.data.input, custody.admitted);
        }
        const result = await handler(parsed.data.input, { ...context, requesterSessionBootstrap: custody.admitted,
            ...(authorization ? { callerInputAuthorization: authorization } : {}) });
        if (!readOnly) {
            if (!result || typeof result !== 'object' || Reflect.get(result, 'ok') !== true) await custody.cleanupOnFailure();
            else custody.admitted.savedSecretOperationContext.withdrawCatalog();
        }
        return result;
    } catch {
        if (readOnly) context.signal.throwIfAborted();
        else await custody.cleanupOnFailure();
        return refused();
    }
    finally {
        if (readOnly) { active = false; await custody.cleanupOnFailure(); }
    }
}

export function createSessionLifecycleRpcActionExecutor(
    handlers: SessionLifecycleActionHandlers,
): RpcActionExecutor {
    return {
        execute: async (actionId, input, context) => {
            const handler = handlers[actionId as SessionLifecycleActionId];
            if (!handler) {
                return {
                    ok: false,
                    errorCode: 'unsupported_action',
                    error: `unsupported_action:${actionId}`,
                };
            }
            return {
                ok: true,
                result: await handler(input, context
                    ? {
                        signal: context.signal ?? new AbortController().signal,
                        ...(context.machineAdmission ? { machineAdmission: context.machineAdmission } : {}),
                        ...(context.verifyMachineAdmissionCurrent ? { verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent } : {}),
                        ...(context.requesterSessionBootstrap ? { requesterSessionBootstrap: context.requesterSessionBootstrap } : {}),
                        ...(context.sessionActionOrigin ? { sessionActionOrigin: context.sessionActionOrigin } : {}),
                        ...(context.callerInputAuthorization ? { callerInputAuthorization: context.callerInputAuthorization } : {}),
                        callerAuthority: context.authority ?? 'account_automation',
                        ...(context.operationProgress || context.operationOwnerUpdate
                            ? {
                                localActionContext: {
                                    ...(context.operationProgress
                                        ? { operationProgress: context.operationProgress }
                                        : {}),
                                    ...(context.operationOwnerUpdate
                                        ? { operationOwnerUpdate: context.operationOwnerUpdate }
                                        : {}),
                                },
                            }
                            : {}),
                    }
                    : undefined),
            };
        },
    };
}

export function registerSessionLifecycleRpcHandlers(params: Readonly<{
    rpcHandlerManager: RpcRegistrar;
    actionExecutor: RpcActionExecutor;
    actionIds?: readonly SessionLifecycleActionId[];
    scopes?: readonly ActionSpecRpcRegistrationScope[];
    observeExecution?: RegisterActionSpecRpcHandlersParams['observeExecution'];
    mapResponseForMethod?: RegisterActionSpecRpcHandlersParams['mapResponseForMethod'];
    mapRequestForMethod?: RegisterActionSpecRpcHandlersParams['mapRequestForMethod'];
    requesterBootstrapBoundary?: SessionHandoffRequesterBootstrapBoundary;
    requesterSessionRuntime?: RequesterSessionRuntimeOwner;
}>): void {
    registerActionSpecRpcHandlers({
        rpcHandlerManager: { registerHandler: (method, handler) => params.rpcHandlerManager.registerHandler(method, async (input, context) => {
            if (input && typeof input === 'object' && Reflect.get(input, 'kind') === 'requester_session_handoff_bootstrap_v1') {
                return await withSessionHandoffRequesterBootstrap({ method, input, context,
                    boundary: params.requesterBootstrapBoundary, handler });
            }
            const admission = context?.machineAdmission;
            const phaseInput = input && typeof input === 'object' && Reflect.get(input, 'kind') === 'targeted_action_rpc'
                ? Reflect.get(input, 'input') : input;
            if (!isHandoffPhaseBound(phaseInput, context)) return { ok: false, errorCode: 'invalid_request' };
            if (!admission || admission.actorAccountId === admission.custodianAccountId || context.requesterSessionBootstrap) {
                return await handler(input, context);
            }
            let lifecycleInput = input;
            if (input && typeof input === 'object' && Reflect.get(input, 'kind') === 'targeted_action_rpc') {
                const parsed = TargetedActionRpcRequestV1Schema.safeParse(input);
                if (!parsed.success || parsed.data.target.kind !== 'machine'
                    || parsed.data.target.machineId !== admission.machineId) {
                    return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
                }
                lifecycleInput = parsed.data.input;
            }
            const replay = lifecycleInput && typeof lifecycleInput === 'object' ? Reflect.get(lifecycleInput, 'replay') : undefined;
            const sessionId = readDefaultSessionIdFromRpcInput(lifecycleInput)
                ?? (replay && typeof replay === 'object' && typeof Reflect.get(replay, 'previousSessionId') === 'string'
                    ? String(Reflect.get(replay, 'previousSessionId')).trim() : undefined)
                ?? (context.callerInputAuthorization?.binding.handoffContinuation
                    ? context.callerInputAuthorization.binding.handoffAdmission?.sessionId : undefined);
            if (!sessionId) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
            return await withRequesterSessionRuntime(input, context, sessionId, params.requesterSessionRuntime, handler);
        }) },
        actionExecutor: params.actionExecutor,
        actionIds: params.actionIds,
        scopes: params.scopes ?? SESSION_LIFECYCLE_RPC_SCOPES,
        ...(params.observeExecution ? { observeExecution: params.observeExecution } : {}),
        ...(params.mapResponseForMethod ? { mapResponseForMethod: params.mapResponseForMethod } : {}),
        ...(params.mapRequestForMethod ? { mapRequestForMethod: params.mapRequestForMethod } : {}),
    });
}

async function resolveProductionSessionSpawnNewActionExecutor(params: Readonly<{
    sessionSpawnDirectTargetTransport?: SessionSpawnDirectTargetTransport;
    requesterContext?: RpcHandlerContext;
}> = {}): Promise<RpcActionExecutor> {
    const requester = params.requesterContext?.requesterSessionBootstrap;
    const credentials = requester?.credentials ?? await readStoredCredentials().catch(() => null);
    if (!credentials) {
        return {
            execute: async () => ({
                ok: false,
                errorCode: 'not_authenticated',
                error: 'not_authenticated',
            }),
        };
    }
    return createCliActionExecutorFromCredentials({
        credentials,
        ...(requester ? {
            requesterSessionBootstrap: requester,
            serverId: requester.attribution.serverId,
            serverApiUrl: requester.serverHttpBaseUrl,
            machineId: requester.attribution.machineId,
            readCredentials: async () => await requester.isCurrent() ? requester.credentials : null,
            actionsSettingsProvider: {
                getActionsSettings: () => normalizeActionsSettingsV1(requester.savedSecretOperationContext.readSnapshot()?.settings.actionsSettingsV1),
                getAccountSettings: () => requester.savedSecretOperationContext.readSnapshot()?.settings ?? null,
                getAccountRoleOverrides: () => {
                    const snapshot = requester.savedSecretOperationContext.readSnapshot();
                    return snapshot ? readAccountRoleOverridesFromSnapshot(snapshot)
                        : { status: 'unavailable', reason: 'source-unavailable' };
                },
            },
        } : {}),
        ...(params.sessionSpawnDirectTargetTransport
            ? { sessionSpawnDirectTargetTransport: params.sessionSpawnDirectTargetTransport }
            : {}),
    });
}

/**
 * Registers the public Action transport alongside, but never through, the
 * private daemon Session-lifecycle spawn transport below.
 */
export function registerSessionSpawnNewRpcHandlers(params: Readonly<{
    rpcHandlerManager: RpcRegistrar;
    actionExecutor?: RpcActionExecutor;
    /** Exact daemon receiver transport retained after server-scoped machine routing. */
    sessionSpawnDirectTargetTransport?: SessionSpawnDirectTargetTransport;
    requesterBootstrapBoundary?: Readonly<{
        serverId: string;
        serverHttpBaseUrl: string;
        happyHomeDir: string;
        getObservedServerIdentityId(): string | null;
        readInstallation?(): Promise<CurrentMachineInstallation | null>;
        spawnLifecycleHandler: SessionLifecycleActionHandler;
        resolveSpawnSessionByNonce?: SpawnSessionNonceResolver;
    }>;
    observeExecution?: RegisterActionSpecRpcHandlersParams['observeExecution'];
}>): void {
    registerActionSpecRpcHandlers({
        rpcHandlerManager: {
            registerHandler: (method, handler) => params.rpcHandlerManager.registerHandler(method, async (input, context) => {
                if (!input || typeof input !== 'object'
                    || Reflect.get(input, 'kind') !== 'requester_session_bootstrap_v1') return await handler(input, context);
                const parsed = SessionRequesterBootstrapRpcRequestV1Schema.safeParse(input);
                const boundary = params.requesterBootstrapBoundary;
                if (!parsed.success || !boundary || !context || !context.machineAdmission
                    || parsed.data.input.executionTarget.machineId !== context.machineAdmission.machineId) {
                    return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
                }
                let requesterBootstrap = parsed.data.requesterBootstrap;
                if ('kind' in requesterBootstrap) {
                    if (!context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) {
                        return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
                    }
                    const installation = await boundary.readInstallation?.().catch(() => null);
                    const opened = installation && installation.machineId === context.machineAdmission.machineId
                        && installation.identity.installationId === context.machineAdmission.installationId
                        ? openSessionRequesterBootstrapRpcRequestV1({ request: parsed.data,
                            machineId: installation.machineId, installationId: installation.identity.installationId,
                            installationPrivateKey: decodeBase64(installation.identity.privateKey, 'base64url') }) : null;
                    if (!opened) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
                    requesterBootstrap = opened.requesterBootstrap;
                } else if (context.machineAdmission.encryptionMode === 'plain'
                    && (requesterBootstrap.credentials.secret || requesterBootstrap.credentials.encryption)) {
                    // TLS protects token-only Plain sign-in. Account keys require installation confidentiality,
                    // not an assumption that Machine content itself is encrypted.
                    return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
                }
                let custody: Awaited<ReturnType<typeof admitRequesterSessionBootstrap>>;
                try { custody = await admitRequesterSessionBootstrap({ bootstrap: requesterBootstrap, boundary, context }); }
                catch { custody = null; }
                if (!custody) return { ok: false, errorCode: context.signal.aborted ? 'cancelled' : 'target_unavailable',
                    error: context.signal.aborted ? 'cancelled' : 'target_unavailable' };
                const projectedAuthorization = context.callerInputAuthorization
                    ? await custody.admitted.projectExternalActionAuthorization(context.callerInputAuthorization,
                        boundary.getObservedServerIdentityId() ?? '', context.signal)
                    : undefined;
                if (context.callerInputAuthorization && !projectedAuthorization) {
                    await custody.cleanupOnFailure();
                    return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
                }
                const requesterContext = Object.freeze({ ...context, requesterSessionBootstrap: custody.admitted,
                    ...(projectedAuthorization ? { callerInputAuthorization: projectedAuthorization } : {}) });
                try {
                    const response = await handler(parsed.data.input, requesterContext);
                    if (!response || typeof response !== 'object'
                        || !['success', 'pending'].includes(String(Reflect.get(response, 'type')))) await custody.cleanupOnFailure();
                    return response;
                } catch {
                    await custody.cleanupOnFailure();
                    return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
                }
            }),
        },
        resolveActionExecutor: async request => !request.ingress?.requesterSessionBootstrap && params.actionExecutor
            ? params.actionExecutor
            : await resolveProductionSessionSpawnNewActionExecutor({
            ...(request.ingress ? { requesterContext: request.ingress } : {}),
            ...(request.ingress?.requesterSessionBootstrap && params.requesterBootstrapBoundary ? {
                sessionSpawnDirectTargetTransport: createMachineSessionDirectTargetTransport({
                    machineId: request.ingress.requesterSessionBootstrap.attribution.machineId,
                    spawnLifecycleHandler: async (input, context) => {
                        const requester = request.ingress!.requesterSessionBootstrap!;
                        if (!input || typeof input !== 'object'
                            || (requester.preparedSessionId !== undefined
                                && Reflect.get(input, 'existingSessionId') !== requester.preparedSessionId)
                            || typeof Reflect.get(input, 'sessionCreationTag') !== 'string'
                            || !await requester.isCurrent()) {
                            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                                errorMessage: 'Requester Session creation identity unavailable' };
                        }
                        return await params.requesterBootstrapBoundary!.spawnLifecycleHandler(input,
                            { ...context, ...request.ingress, requesterSessionBootstrap: requester });
                    },
                    ...(params.requesterBootstrapBoundary.resolveSpawnSessionByNonce
                        ? { resolveSpawnSessionByNonce: params.requesterBootstrapBoundary.resolveSpawnSessionByNonce } : {}),
                }),
            } : {}),
            ...(params.sessionSpawnDirectTargetTransport
                && !request.ingress?.requesterSessionBootstrap
                ? { sessionSpawnDirectTargetTransport: params.sessionSpawnDirectTargetTransport }
                : {}),
        }),
        scopes: SESSION_SPAWN_NEW_RPC_SCOPES,
        ...(params.observeExecution ? { observeExecution: params.observeExecution } : {}),
    });
}

/**
 * Private machine transport owner for the pre-Action Session lifecycle RPCs.
 * This transport has its own request vocabulary and lifecycle contract; it
 * must never project raw machine payloads into the public session.spawn_new
 * Action schema.
 */
export function registerPrivateSpawnSessionRpcHandlers(params: Readonly<{
    rpcHandlerManager: RpcRegistrar;
    spawnLifecycleHandler: SessionLifecycleActionHandler;
    resolveSpawnSessionByNonce?: SpawnSessionNonceResolver;
    /**
     * The advertised Session-spawn V1 owner must return the authoritative
     * create-or-rejoin fact with every resolved Session id.
     */
    requireSessionCreationOutcome?: boolean;
    requesterSessionRuntime?: RequesterSessionRuntimeOwner;
    handoffTargetResume?: Readonly<{ prepareJobStore: ReturnType<typeof createSessionHandoffPrepareTargetJobStore>; machineId?: string }>;
}>): void {
    const settlePrimaryFreshSpawn = async (response: unknown): Promise<unknown> => {
        if (!response || typeof response !== 'object' || (response as { type?: unknown }).type !== 'success') {
            return response;
        }
        const sessionId = typeof (response as { sessionId?: unknown }).sessionId === 'string'
            ? (response as { sessionId: string }).sessionId.trim()
            : '';
        if (sessionId) {
            const normalized = normalizeSpawnSessionNonceResolution({
                status: 'success',
                sessionId,
                sessionCreationOutcome: (response as { sessionCreationOutcome?: unknown })
                    .sessionCreationOutcome,
            });
            if (
                params.requireSessionCreationOutcome === true
                && (
                    normalized.status !== 'success'
                    || !normalized.sessionCreationOutcome
                )
            ) {
                return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                    errorMessage: 'Advertised session-spawn V1 did not return create-or-rejoin outcome',
                };
            }
            return {
                type: 'success',
                sessionId,
                ...(normalized.status === 'success' && normalized.sessionCreationOutcome
                    ? { sessionCreationOutcome: normalized.sessionCreationOutcome }
                    : {}),
            };
        }
        const spawnNonce = typeof (response as { spawnNonce?: unknown }).spawnNonce === 'string'
            ? (response as { spawnNonce: string }).spawnNonce.trim()
            : '';
        if (!spawnNonce || !params.resolveSpawnSessionByNonce) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'Spawn succeeded without a resolvable session identity',
            };
        }
        const settled = await awaitSpawnedSessionId({
            result: response,
            spawnNonce,
            resolveSpawnSessionByNonce: params.resolveSpawnSessionByNonce,
        });
        if (
            params.requireSessionCreationOutcome === true
            && settled.type === 'success'
            && !settled.sessionCreationOutcome
        ) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Advertised session-spawn V1 did not return create-or-rejoin outcome',
            };
        }
        return settled;
    };

    const handle = async (
        input: unknown,
        providerSafe: boolean,
        context?: RpcHandlerContext,
    ): Promise<unknown> => {
        const parsed = SpawnDaemonSessionRequestSchema.safeParse(input);
        if (!parsed.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid session spawn request',
            };
        }
        const binding = context?.callerInputAuthorization?.binding;
        if (binding?.handoffContinuation && (providerSafe || !binding.handoffAdmission
            || binding.actionId !== 'session.spawn_new' || parsed.data.type !== 'resume-session'
            || parsed.data.sessionId !== binding.handoffAdmission.sessionId
            || binding.machineId !== binding.handoffAdmission.targetMachineId
            || binding.installationId !== binding.handoffAdmission.targetInstallationId)) {
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid Session handoff resume' };
        }
        let launchAccepted = false;
        let resumeContext = context;
        let admittedSpawnData = parsed.data;
        if (binding?.handoffContinuation) {
            const store = params.handoffTargetResume?.prepareJobStore;
            const job = await store?.findByHandoffId(binding.handoffContinuation.handoffId);
            const prepared = job?.prepareTargetResult;
            if (!store || !job || !prepared
                || job.status.status !== 'ready_for_cutover' || !parsed.data.spawnNonce
                || job.schemaVersion === 2 && (job.recordKind !== 'prepared_target'
                    || job.sessionId !== parsed.data.sessionId || job.terminal.status !== 'open'
                    || job.resume.status === 'preexisting_unowned'
                    || (job.resume.status === 'attempted' || job.resume.status === 'confirmed')
                        && job.resume.attemptId !== parsed.data.spawnNonce)
                || job.prepareTargetRequest && (job.prepareTargetRequest.sessionId !== binding.handoffAdmission?.sessionId
                    || job.prepareTargetRequest.targetMachineId !== binding.machineId)
                || !matchesPreparedHandoffNativeTarget(parsed.data, prepared)) {
                return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                    errorMessage: 'Session handoff does not match the prepared native target' };
            }
            if (job.prepareTargetRequest?.stateTransfer === 'existing') admittedSpawnData = { ...parsed.data, handoffStateTransfer: 'existing' };
            resumeContext = { ...context!, beforeSessionRunnerLaunch: async () => {
                if (context?.signal.aborted) return false;
                try {
                    await store.upgradeReadyV1ToPreparedV2({ jobId: job.jobId, sessionId: parsed.data.sessionId! });
                    const accepted = await store.transitionPredecessorV2(job.jobId, current => {
                        if (current.recordKind !== 'prepared_target' || current.terminal.status !== 'open'
                            || current.status.status !== 'ready_for_cutover' || current.sessionId !== parsed.data.sessionId
                            || current.resume.status === 'preexisting_unowned'
                            || (current.resume.status === 'attempted' || current.resume.status === 'confirmed')
                                && current.resume.attemptId !== parsed.data.spawnNonce) return null;
                        if (current.resume.status !== 'not_attempted') return null;
                        const now = Date.now();
                        return { ...current, transitionRevision: current.transitionRevision + 1, updatedAtMs: now,
                            resume: { status: 'attempted', attemptId: parsed.data.spawnNonce!, acceptedAtMs: now },
                            targetCleanup: { status: 'pending' } };
                    });
                    launchAccepted = accepted?.recordKind === 'prepared_target' && accepted.terminal.status === 'open'
                        && (accepted.resume.status === 'attempted' || accepted.resume.status === 'confirmed')
                        && accepted.resume.attemptId === parsed.data.spawnNonce;
                    return launchAccepted;
                } catch { return false; }
            } };
        } else if (params.handoffTargetResume && parsed.data.type === 'resume-session' && parsed.data.sessionId
            && parsed.data.executionAuthorization?.requestId) {
            const job = await params.handoffTargetResume.prepareJobStore.findByHandoffId(parsed.data.executionAuthorization.requestId);
            const request = job?.prepareTargetRequest;
            const targetMachineId = context?.machineAdmission?.machineId ?? context?.requesterSessionBootstrap?.attribution.machineId ?? params.handoffTargetResume.machineId;
            if (request?.stateTransfer === 'existing') {
                if (request.sessionId !== parsed.data.sessionId || request.targetMachineId !== targetMachineId
                    || job?.status.status !== 'ready_for_cutover'
                    || !matchesPreparedHandoffNativeTarget(parsed.data, job.prepareTargetResult)) {
                    return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                        errorMessage: 'Session handoff does not match the prepared native target' };
                }
                admittedSpawnData = { ...parsed.data, handoffStateTransfer: 'existing' };
            }
        }
        const admission = context?.machineAdmission;
        const foreignResume = admission && admission.actorAccountId !== admission.custodianAccountId
            && !context.requesterSessionBootstrap;
        if (foreignResume && (parsed.data.type !== 'resume-session' || !parsed.data.sessionId)) {
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Requester Session credential unavailable' };
        }
        const response = foreignResume && resumeContext ? await withRequesterSessionRuntime(admittedSpawnData, resumeContext,
            parsed.data.sessionId!, params.requesterSessionRuntime, params.spawnLifecycleHandler)
            : await params.spawnLifecycleHandler(admittedSpawnData, resumeContext);
        if (binding?.handoffContinuation && !launchAccepted && response && typeof response === 'object'
            && Reflect.get(response, 'type') === 'success') {
            const store = params.handoffTargetResume!.prepareJobStore;
            const job = await store.findByHandoffId(binding.handoffContinuation.handoffId);
            if (job?.schemaVersion === 2 && job.recordKind === 'prepared_target'
                && (job.resume.status === 'attempted' || job.resume.status === 'confirmed')
                && job.resume.attemptId === parsed.data.spawnNonce && job.terminal.status === 'open') return response;
            if (job) {
                await store.upgradeReadyV1ToPreparedV2({ jobId: job.jobId, sessionId: parsed.data.sessionId! });
                await store.transitionPredecessorV2(job.jobId, current => current.recordKind === 'prepared_target'
                    && current.resume.status === 'not_attempted' && current.terminal.status === 'open'
                    ? { ...current, transitionRevision: current.transitionRevision + 1, updatedAtMs: Date.now(),
                        resume: { status: 'preexisting_unowned' }, targetCleanup: { status: 'not_owned', reason: 'preexisting_or_adopted' } }
                    : null);
            }
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Prepared Session handoff runner was not launched' };
        }
        // Inactive resume deliberately reports a bare success envelope. It is
        // a different lifecycle operation, not an unresolvable fresh spawn.
        if (providerSafe || parsed.data.type === 'resume-session') {
            return response;
        }
        return await settlePrimaryFreshSpawn(response);
    };

    params.rpcHandlerManager.registerHandler(
        RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
        async (input, context) => await handle(input, true, context),
    );
    params.rpcHandlerManager.registerHandler(
        RPC_METHODS.SPAWN_HAPPY_SESSION,
        async (input, context) => await handle(input, false, context),
    );
}
