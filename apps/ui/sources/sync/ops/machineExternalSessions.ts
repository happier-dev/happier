import {
    ExternalSessionOperationActionResponseV1Schema,
    ExternalSessionOperationCancelInputV1Schema,
    ExternalSessionOperationDiscardInputV1Schema,
    ExternalSessionOperationResumeInputV1Schema,
    ExternalSessionOperationRetryInputV1Schema,
    ExternalSessionOperationStatusInputV1Schema,
    ExternalSessionMaterializeStartInputV1Schema,
    ExternalSessionTakeoverStartInputV1Schema,
    type ExternalSessionOperationActionResponseV1,
    type ExternalSessionOperationReferenceV1,
    type ExternalSessionMaterializeStartInputV1,
    type ExternalSessionTakeoverStartInputV1,
} from '@happier-dev/protocol/sessions';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalSessionAttachRequestSchema, ExternalSessionAttachResponseSchema, ExternalSessionDetachRequestSchema, ExternalSessionDetachResponseSchema, ExternalSessionFollowPolicySetRequestSchema, ExternalSessionFollowPolicySetResponseSchema, ExternalSessionLinkEnsureRequestSchema, ExternalSessionLinkEnsureResponseSchema, ExternalSessionStatusGetRequestSchema, ExternalSessionStatusGetResponseSchema, ExternalSessionCandidateDeleteRequestSchema, ExternalSessionCandidateDeleteResponseSchema, ExternalSessionsCandidatesListRequestSchema, ExternalSessionsCandidatesListResponseSchema, ExternalSessionTranscriptPageRequestSchema, ExternalSessionTranscriptPageResponseSchema, ExternalSessionTranscriptReadAfterRequestSchema, ExternalSessionTranscriptReadAfterResponseSchema, type ExternalSessionAttachRequest, type ExternalSessionAttachResponse, type ExternalSessionDetachRequest, type ExternalSessionDetachResponse, type ExternalSessionFollowPolicySetRequest, type ExternalSessionFollowPolicySetResponse, type ExternalSessionLinkEnsureRequest, type ExternalSessionLinkEnsureResponse, type ExternalSessionStatusGetRequest, type ExternalSessionStatusGetResponse, type ExternalSessionCandidateDeleteRequest, type ExternalSessionCandidateDeleteResponse, type ExternalSessionsCandidatesListRequest, type ExternalSessionsCandidatesListResponse, type ExternalSessionTranscriptPageRequest, type ExternalSessionTranscriptPageResponse, type ExternalSessionTranscriptReadAfterRequest, type ExternalSessionTranscriptReadAfterResponse } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { ExternalSessionTranscriptRefreshReadAfterRequestV1Schema, ExternalSessionTranscriptRefreshReadAfterResponseV1Schema, shouldResyncExternalSessionTranscriptReadAfterV1, type ExternalSessionTranscriptRefreshReadAfterRequestV1, type ExternalSessionTranscriptRefreshReadAfterResponseV1 } from '@happier-dev/protocol/sessions/external/secureRefreshV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
} from '@happier-dev/protocol/rpcErrors';
import type { ZodType } from 'zod';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveReplacementAwareMachineRpcTarget, type ReplacementAwareMachineRpcTarget } from '@/sync/domains/machines/identity/resolveReplacementAwareMachineRpcTarget';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import { readAccountSettingsForScope } from '@/sync/domains/state/accountSettingsPersistence';
import { storage } from '@/sync/domains/state/storage';
import { readReplacementAwareMachineRpcTarget } from './machineRpcTarget';

type MachineExternalSessionsOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
    signal?: AbortSignal;
}>;

type ExternalSessionTakeoverOperationRequest = Readonly<{
    machineId: string;
}> & ExternalSessionTakeoverStartInputV1;
type MachineExternalSessionTakeoverOpts = MachineExternalSessionsOpts & Readonly<{
    accountLifetime?: ServerAccountScopeLifetime;
}>;
type ExternalSessionMaterializeOperationRequest = Readonly<{
    machineId: string;
}> & ExternalSessionMaterializeStartInputV1;
type MachineExternalSessionOperationRequest = Readonly<{
    machineId: string;
}> & ExternalSessionOperationReferenceV1;

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

function mapReleasedExternalSessionResponseToCanonical(response: unknown, method: string): unknown {
    if (!response || typeof response !== 'object' || Array.isArray(response)) return response;
    const record = response as Record<string, unknown>;
    const isLegacyReadAfter = method === RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER_LEGACY;
    if ((isLegacyReadAfter || method === RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE_LEGACY) && record.ok === true) {
        // The prospective ../0.2 transcript owners distinguish page limits from
        // source resets while preserving each released provider's `truncated`
        // boolean. Translate that seam into the current continuation facts;
        // missing/unknown reasons retain the released conservative behavior.
        const { truncationReason, ...released } = record;
        if (truncationReason === 'page_limit') {
            return { ...released, truncated: false, ...(isLegacyReadAfter ? { hasMore: true } : {}) };
        }
        if (truncationReason === 'source_discontinuity') {
            return {
                ...released,
                truncated: true,
                diagnostics: [{ code: 'external_session_source_diagnostic', severity: 'required', count: 1, positions: [] }],
            };
        }
    }
    if (record.ok !== false || record.errorCode !== 'provider_unavailable') return response;
    // cli-v0.2.1, cli-v0.2.2-preview.1775586717.26498, and the inspected
    // remote-dev predecessor use the provider-named literal. Keep that spelling
    // at the action-specific fallback boundary until those daemon targets and
    // rollback/coexistence directions are unsupported.
    return { ...record, errorCode: 'agent_unavailable' };
}

async function callExternalSessionMachineRpc<Request, Response>(params: Readonly<{
    machineId: string;
    method: string;
    input: Request;
    requestSchema: ZodType<Request>;
    responseSchema: ZodType<Response>;
    legacy?: Readonly<{
        method: string;
        input: unknown;
        beforeCall?: () => void;
        fallbackOnRelayMethodUnavailable?: true;
    }>;
    opts?: MachineExternalSessionsOpts;
    accountId?: string;
    routeTarget?: ReplacementAwareMachineRpcTarget | null;
    onIssued?: () => void;
}>): Promise<Response> {
    const payload = params.requestSchema.parse(params.input);
    const routeTarget = params.routeTarget === undefined
        ? readReplacementAwareMachineRpcTarget(params.machineId)
        : params.routeTarget;
    if (!routeTarget) {
        throw new Error(`Machine RPC target is unavailable (${params.method})`);
    }
    let response: unknown;
    try {
        response = await machineRpcWithServerScope<unknown, Request>({
            machineId: routeTarget.machineId,
            serverId: params.opts?.serverId,
            ...(params.accountId ? { accountId: params.accountId } : {}),
            ...(params.onIssued ? { onIssued: params.onIssued } : {}),
            timeoutMs: params.opts?.timeoutMs ?? undefined,
            ...(params.opts?.signal ? { signal: params.opts.signal } : {}),
            method: params.method,
            payload,
        });
    } catch (error) {
        // cli-v0.2.1 and cli-v0.2.2-preview.1775586717.26498 expose only
        // daemon.directSessions.*. METHOD_NOT_FOUND proves the canonical handler
        // was not invoked, so retrying the action-specific legacy method cannot
        // duplicate an effect. server-v0.2.1 instead returns METHOD_NOT_AVAILABLE
        // before forwarding; only released read-only methods opt into that signal.
        // Timeouts and ambiguous/domain failures never retry.
        const legacyMethodUnavailable = params.legacy?.fallbackOnRelayMethodUnavailable === true
            && isRpcMethodNotAvailableError(error);
        if (!params.legacy || (!isRpcMethodNotFoundError(error) && !legacyMethodUnavailable)) {
            throw error;
        }
        params.legacy.beforeCall?.();
        response = await machineRpcWithServerScope<unknown, unknown>({
            machineId: routeTarget.machineId,
            serverId: params.opts?.serverId,
            timeoutMs: params.opts?.timeoutMs ?? undefined,
            ...(params.opts?.signal ? { signal: params.opts.signal } : {}),
            method: params.legacy.method,
            payload: params.legacy.input,
        });
        response = mapReleasedExternalSessionResponseToCanonical(response, params.legacy.method);
    }
    const parsed = params.responseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(params.method);
    }
    return parsed.data;
}

function mapCanonicalAgentIdentityToReleasedProviderIdentity<
    Input extends Readonly<{ agentId: string }>,
>(input: Input): Omit<Input, 'agentId'> & Readonly<{ providerId: string }> {
    const { agentId, ...rest } = input;
    return { ...rest, providerId: agentId };
}

function mapRuntimeDescriptorToReleasedShape(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (typeof record.agentId !== 'string' || !record.agent || typeof record.agent !== 'object' || Array.isArray(record.agent)) {
        return value;
    }
    const { agentId, agent, ...descriptorRest } = record;
    const { agentExtra, ...agentRest } = agent as Record<string, unknown>;
    return {
        ...descriptorRest,
        providerId: agentId,
        provider: {
            ...agentRest,
            ...(agentExtra === undefined ? {} : { providerExtra: agentExtra }),
        },
    };
}

function mapLinkEnsureToReleasedShape(input: ExternalSessionLinkEnsureRequest): unknown {
    const { runtimeDescriptorV1, ...rest } = mapCanonicalAgentIdentityToReleasedProviderIdentity(input);
    return {
        ...rest,
        ...(runtimeDescriptorV1 === undefined
            ? {}
            : { runtimeDescriptor: mapRuntimeDescriptorToReleasedShape(runtimeDescriptorV1) }),
    };
}

const EXTERNAL_SESSION_CURSOR_PREFIX = 'happier_external_cursor_v1:';
const CURRENT_ONLY_CANDIDATE_CURSOR_PREFIXES = [
    'plugin_external_sessions_v1_',
    'happier_external_candidate_index_v1:',
] as const;

class ExternalSessionCursorResetRequiredError extends Error {
    readonly code = 'external_session_cursor_reset_required' as const;

    constructor(message = 'Codex transcript cursor reset required before released-daemon fallback') {
        super(message);
        this.name = 'ExternalSessionCursorResetRequiredError';
    }
}

function assertReleasedDaemonAcceptsCandidateCursor(
    input: Readonly<{ cursor?: string | null }>,
): void {
    const cursor = input.cursor;
    if (!cursor) return;

    // cli-v0.2.1, cli-v0.2.2-preview.1775586717.26498, and remote-dev@72b9f5c
    // decode unknown candidate cursors as offset zero. Fence only current CLI cursor
    // prefixes at this legacy fallback; remove with the last supported legacy daemon.
    if (CURRENT_ONLY_CANDIDATE_CURSOR_PREFIXES.some((prefix) => cursor.startsWith(prefix))) {
        throw new ExternalSessionCursorResetRequiredError(
            'External session candidate cursor reset required before released-daemon fallback',
        );
    }
}

function isCurrentRawCodexTranscriptCursor(cursor: string): boolean {
    try {
        const decoded = JSON.parse(new TextDecoder().decode(decodeBase64(cursor, 'base64url'))) as unknown;
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return false;
        const record = decoded as Record<string, unknown>;
        return (
            (
                (record.v === 4 || record.v === 6 || record.v === 7)
                && (
                    record.kind === 'codexForwardStreamVector'
                    || record.kind === 'codexBackwardStreamVector'
                )
            )
            || (
                record.v === 5
                && (
                    record.kind === 'codexForwardStreamVector'
                    || record.kind === 'codexBackwardStreamVector'
                )
            )
            || (
                record.v === 3
                && record.kind === 'codexBackwardStreamVector'
            )
        );
    } catch {
        return false;
    }
}

function assertReleasedDaemonAcceptsTranscriptCursor(
    input: Readonly<{ agentId: string; cursor?: string | null }>,
): void {
    if (!input.cursor) return;

    // Current daemons wrap newly written leaf cursors in a host-owned envelope.
    // cli-v0.2.1 and the matching preview cannot decode that envelope; paging
    // silently restarts from newest, while read-after returns only its legacy
    // truncated shape rather than the current typed outcome. Raw Codex v4/v6
    // and anchored v5/v7 leaf cursors cover persisted cursors written before
    // host qualification. The inspected remote-dev predecessor's Codex
    // backward v3 also cannot be sent to a released daemon because method
    // fallback cannot identify the daemon revision.
    if (
        input.cursor.startsWith(EXTERNAL_SESSION_CURSOR_PREFIX)
        || (
            input.agentId === 'codex'
            && isCurrentRawCodexTranscriptCursor(input.cursor)
        )
    ) {
        throw new ExternalSessionCursorResetRequiredError();
    }
}

export async function machineExternalSessionsCandidatesList(
    input: ExternalSessionsCandidatesListRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionsCandidatesListResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST,
        input,
        requestSchema: ExternalSessionsCandidatesListRequestSchema,
        responseSchema: ExternalSessionsCandidatesListResponseSchema,
        legacy: {
            method: RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY,
            input: mapCanonicalAgentIdentityToReleasedProviderIdentity(input),
            beforeCall: () => assertReleasedDaemonAcceptsCandidateCursor(input),
            fallbackOnRelayMethodUnavailable: true,
        },
        opts,
    });
}

/**
 * Delete one Agent-owned session a resume-only listing surfaced. cli-v0.2.1 and
 * its preview expose the same deletion as
 * `daemon.directSessions.candidate.delete` with the released `providerId`
 * identity, so that alias is the fallback — but only after METHOD_NOT_FOUND,
 * which proves the canonical handler never ran. This is a destructive
 * operation, so it deliberately does not opt into the released relay's
 * METHOD_NOT_AVAILABLE signal the way the read-only methods do: an ambiguous
 * relay answer, a timeout, or any transport failure could each already have
 * deleted the Agent's session.
 */
export async function machineExternalSessionCandidateDelete(
    input: ExternalSessionCandidateDeleteRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionCandidateDeleteResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_CANDIDATE_DELETE,
        input,
        requestSchema: ExternalSessionCandidateDeleteRequestSchema,
        responseSchema: ExternalSessionCandidateDeleteResponseSchema,
        legacy: {
            method: RPC_METHODS.DAEMON_DIRECT_SESSION_CANDIDATE_DELETE_LEGACY,
            // Identity only: `remoteSessionId` is the Agent's own opaque
            // handle and crosses the released hop byte-exact.
            input: mapCanonicalAgentIdentityToReleasedProviderIdentity(input),
        },
        opts,
    });
}

export async function machineExternalSessionLinkEnsure(
    input: ExternalSessionLinkEnsureRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionLinkEnsureResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE,
        input,
        requestSchema: ExternalSessionLinkEnsureRequestSchema,
        responseSchema: ExternalSessionLinkEnsureResponseSchema,
        legacy: {
            method: RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY,
            input: mapLinkEnsureToReleasedShape(input),
        },
        opts,
    });
}

export async function machineExternalSessionAttach(
    input: ExternalSessionAttachRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionAttachResponse> {
    try {
        return await callExternalSessionMachineRpc({
            machineId: input.machineId,
            method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH,
            input,
            requestSchema: ExternalSessionAttachRequestSchema,
            responseSchema: ExternalSessionAttachResponseSchema,
            opts,
        });
    } catch (error) {
        if (!isRpcMethodNotFoundError(error)) throw error;
        // The inspected predecessor's legacy attach succeeds by acquiring a
        // transcript-bearing raw-delta follow lease. Current servers and UIs
        // intentionally reject that retired data plane, so the lease would be
        // silently inert. Fail before acquiring it instead.
        return {
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'background_follow_not_supported',
        };
    }
}

export async function machineExternalSessionDetach(
    input: ExternalSessionDetachRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionDetachResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH,
        input,
        requestSchema: ExternalSessionDetachRequestSchema,
        responseSchema: ExternalSessionDetachResponseSchema,
        legacy: {
            method: RPC_METHODS.DAEMON_DIRECT_SESSION_DETACH_LEGACY,
            input,
        },
        opts,
    });
}

export async function machineExternalSessionFollowPolicySet(
    input: ExternalSessionFollowPolicySetRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionFollowPolicySetResponse> {
    if (input.enabled) {
        try {
            return await callExternalSessionMachineRpc({
                machineId: input.machineId,
                method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
                input,
                requestSchema: ExternalSessionFollowPolicySetRequestSchema,
                responseSchema: ExternalSessionFollowPolicySetResponseSchema,
                opts,
            });
        } catch (error) {
            if (!isRpcMethodNotFoundError(error)) throw error;
            // The inspected predecessor emits transcript-bearing raw deltas,
            // which this client intentionally cannot consume. A legacy method
            // name is not a compatible follow data plane, so fail before the
            // predecessor can persist a policy that would never deliver.
            return {
                ok: false,
                errorCode: 'agent_unavailable',
                error: 'background_follow_not_supported',
            };
        }
    }

    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
        input,
        requestSchema: ExternalSessionFollowPolicySetRequestSchema,
        responseSchema: ExternalSessionFollowPolicySetResponseSchema,
        legacy: {
            method: RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET_LEGACY,
            input: mapCanonicalAgentIdentityToReleasedProviderIdentity(input),
        },
        opts,
    });
}

export async function machineExternalSessionStatusGet(
    input: ExternalSessionStatusGetRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionStatusGetResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET,
        input,
        requestSchema: ExternalSessionStatusGetRequestSchema,
        responseSchema: ExternalSessionStatusGetResponseSchema,
        legacy: {
            method: RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET_LEGACY,
            input: mapCanonicalAgentIdentityToReleasedProviderIdentity(input),
            fallbackOnRelayMethodUnavailable: true,
        },
        opts,
    });
}

export async function machineExternalSessionTranscriptPage(
    input: ExternalSessionTranscriptPageRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionTranscriptPageResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE,
        input,
        requestSchema: ExternalSessionTranscriptPageRequestSchema,
        responseSchema: ExternalSessionTranscriptPageResponseSchema,
        legacy: {
            method: RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE_LEGACY,
            input: mapCanonicalAgentIdentityToReleasedProviderIdentity(input),
            beforeCall: () => assertReleasedDaemonAcceptsTranscriptCursor(input),
            // server-v0.2.1 reports METHOD_NOT_AVAILABLE before forwarding when
            // cli-v0.2.1 has registered only the released direct-session method.
            // This retry is safe only for the read-only transcript operation.
            fallbackOnRelayMethodUnavailable: true,
        },
        opts,
    });
}

export async function machineExternalSessionTranscriptReadAfter(
    input: ExternalSessionTranscriptReadAfterRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionTranscriptReadAfterResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
        input,
        requestSchema: ExternalSessionTranscriptReadAfterRequestSchema,
        responseSchema: ExternalSessionTranscriptReadAfterResponseSchema,
        legacy: {
            method: RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER_LEGACY,
            input: mapCanonicalAgentIdentityToReleasedProviderIdentity(input),
            beforeCall: () => assertReleasedDaemonAcceptsTranscriptCursor(input),
            fallbackOnRelayMethodUnavailable: true,
        },
        opts,
    });
}

export async function machineExternalSessionTranscriptRefreshReadAfter(
    input: ExternalSessionTranscriptRefreshReadAfterRequestV1,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionTranscriptRefreshReadAfterResponseV1> {
    return callExternalSessionMachineRpc({
        machineId: input.binding.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
        input,
        requestSchema: ExternalSessionTranscriptRefreshReadAfterRequestV1Schema,
        responseSchema: ExternalSessionTranscriptRefreshReadAfterResponseV1Schema,
        // The secure refresh contract never downgrades to transcript-bearing
        // released/predecessor RPC shapes.
        opts,
    });
}

/**
 * Applies the one Protocol read-after continuation decision to a released
 * direct-session read-after response. Current daemons answer the released
 * shape with additive rich facts (`hasMore`, bounded `diagnostics`); released
 * daemons omit them, so a released truncated response still conservatively
 * requires a resync. An empty `ok` response without incompleteness or
 * diagnostics is the released collapse of `already_current`, including a null
 * or omitted cursor from an initial tail probe. It stays a clean no-op.
 * Rich stalled pages and nonempty pages without a continuation cursor
 * remain subject to the shared decision's resync requirement.
 */
export function externalSessionTranscriptReadAfterRequiresResyncV1(
    response: Extract<ExternalSessionTranscriptReadAfterResponse, { ok: true }>,
    requestCursor: string,
    options?: Readonly<{ allowAdjacentPage?: boolean }>,
): boolean {
    if (response.truncated === true) return true;
    if (response.items.length === 0
        && (response.nextCursor === requestCursor || (requestCursor === 'tail' && response.nextCursor == null))
        && response.hasMore !== true
        && (response.diagnostics?.length ?? 0) === 0) {
        return false;
    }
    return shouldResyncExternalSessionTranscriptReadAfterV1({
        requestCursor,
        nextCursor: response.nextCursor ?? requestCursor,
        hasMore: response.hasMore === true,
        diagnostics: response.diagnostics,
        allowAdjacentPage: options?.allowAdjacentPage,
    });
}

export async function machineExternalSessionTakeoverStart(
    input: ExternalSessionTakeoverOperationRequest,
    opts?: MachineExternalSessionTakeoverOpts,
): Promise<ExternalSessionOperationActionResponseV1> {
    const lifetime = opts?.accountLifetime;
    const assertAccountCurrent = (): void => {
        if (lifetime && (!lifetime.isCurrent()
            || (opts?.serverId != null
                && !areServerProfileIdentifiersEquivalent(opts.serverId, lifetime.scope.serverId)))) {
            throw Object.assign(new Error('Takeover Account scope is no longer current'), {
                code: 'session_account_scope_retired',
            });
        }
    };
    assertAccountCurrent();
    const state = storage.getState();
    const settings = lifetime
        ? readAccountSettingsForScope({ scope: lifetime.scope, focusedScope: state.settingsScope, focusedSettings: state.settings })
        : state.settings;
    // A background Account's machine id must not follow another Account's
    // replacement projection. Keep the canonical target when its scope is known.
    const routeTarget = resolveReplacementAwareMachineRpcTarget({
        machineId: input.machineId,
        machines: lifetime && !areAccountSettingsScopesEqual(lifetime.scope, state.settingsScope)
            ? []
            : Object.values(state.machines),
    });
    const terminal = input.request.terminal ?? resolveTerminalSpawnOptions({
        settings,
        machineId: routeTarget?.machineId ?? input.machineId,
    });
    try {
        return await callExternalSessionMachineRpc({
            machineId: input.machineId,
            method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START,
            input: { request: { ...input.request, ...(terminal ? { terminal } : {}) } },
            requestSchema: ExternalSessionTakeoverStartInputV1Schema,
            responseSchema: ExternalSessionOperationActionResponseV1Schema,
            opts: lifetime ? { ...opts, serverId: lifetime.scope.serverId } : opts,
            ...(lifetime ? { accountId: lifetime.scope.accountId, onIssued: assertAccountCurrent } : {}),
            routeTarget,
        });
    } catch (error) {
        if (!isRpcMethodNotFoundError(error)) throw error;
        return {
            ok: false,
            error: {
                code: 'upgrade_required',
                message: 'Durable takeover requires a newer daemon.',
            },
        };
    }
}

export async function machineExternalSessionTakeoverPersist(
    input: ExternalSessionTakeoverOperationRequest,
    opts?: MachineExternalSessionTakeoverOpts,
): Promise<ExternalSessionOperationActionResponseV1> {
    return await machineExternalSessionTakeoverStart(input, opts);
}

export async function machineExternalSessionMaterializeStart(
    input: ExternalSessionMaterializeOperationRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionOperationActionResponseV1> {
    try {
        return await callExternalSessionMachineRpc({
            machineId: input.machineId,
            method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START,
            input: { request: input.request },
            requestSchema: ExternalSessionMaterializeStartInputV1Schema,
            responseSchema: ExternalSessionOperationActionResponseV1Schema,
            opts,
        });
    } catch (error) {
        if (!isRpcMethodNotFoundError(error)) throw error;
        return {
            ok: false,
            error: {
                code: 'upgrade_required',
                message: 'Materialization requires a newer daemon.',
            },
        };
    }
}

async function machineExternalSessionOperationAction(
    input: MachineExternalSessionOperationRequest,
    params: Readonly<{
        method: string;
        requestSchema: ZodType<ExternalSessionOperationReferenceV1>;
    }>,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionOperationActionResponseV1> {
    const { machineId, ...reference } = input;
    try {
        return await callExternalSessionMachineRpc({
            machineId,
            method: params.method,
            input: reference,
            requestSchema: params.requestSchema,
            responseSchema: ExternalSessionOperationActionResponseV1Schema,
            opts,
        });
    } catch (error) {
        if (!isRpcMethodNotFoundError(error)) throw error;
        return {
            ok: false,
            error: {
                code: 'upgrade_required',
                message: 'External session operation controls require a newer daemon.',
            },
        };
    }
}

export async function machineExternalSessionOperationStatus(
    input: MachineExternalSessionOperationRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionOperationActionResponseV1> {
    return await machineExternalSessionOperationAction(input, {
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET,
        requestSchema: ExternalSessionOperationStatusInputV1Schema,
    }, opts);
}

export async function machineExternalSessionOperationResume(
    input: MachineExternalSessionOperationRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionOperationActionResponseV1> {
    return await machineExternalSessionOperationAction(input, {
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME,
        requestSchema: ExternalSessionOperationResumeInputV1Schema,
    }, opts);
}

export async function machineExternalSessionOperationRetry(
    input: MachineExternalSessionOperationRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionOperationActionResponseV1> {
    return await machineExternalSessionOperationAction(input, {
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RETRY,
        requestSchema: ExternalSessionOperationRetryInputV1Schema,
    }, opts);
}

export async function machineExternalSessionOperationCancel(
    input: MachineExternalSessionOperationRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionOperationActionResponseV1> {
    return await machineExternalSessionOperationAction(input, {
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_CANCEL,
        requestSchema: ExternalSessionOperationCancelInputV1Schema,
    }, opts);
}

export async function machineExternalSessionOperationDiscard(
    input: MachineExternalSessionOperationRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionOperationActionResponseV1> {
    return await machineExternalSessionOperationAction(input, {
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD,
        requestSchema: ExternalSessionOperationDiscardInputV1Schema,
    }, opts);
}
