import type {
    RestrictedCredentialRouteBinding,
    RestrictedCredentialRouteMachineField,
    RestrictedCredentialRouteSessionSelector,
} from "../types";
import type { VerifiedEphemeralSessionRunnerPrincipal } from "@happier-dev/protocol/ephemeralRunner/principal";
import type {
    AuthTokenAuthenticationEvidenceV1,
    AuthTokenAuthority,
    AuthTokenKind,
} from "@happier-dev/protocol";
import { isApiTokenGrantRestrictedV1, type ApiTokenGrantV1 } from "@happier-dev/protocol/auth/apiTokenGrant";
import { canCredentialDecideV1 } from "@happier-dev/protocol/actions/decisionAuthority";
import { getActionSpec, type ActionId } from "@happier-dev/protocol/actions";
import type { VerifiedApiTokenPrincipal } from "@/app/auth/auth";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { resolveSessionAccessForOperation, type EffectiveSessionAccess, type SessionCapability } from "@/app/session/access/sessionAccess";
import { inTx } from "@/storage/inTx";
import { readExternalActionPendingResetStartPurpose } from '@/app/auth/externalActionPendingResetStartPurpose';

export const PRESENT_USER_REQUIRED_ERROR = "present_user_required" as const;
export const SESSION_RUNTIME_PUBLIC_AUTH_FORBIDDEN_ERROR = "session_runtime_public_auth_forbidden" as const;

/** The same grant, target and effective Session access admission for every direct PAT transport. */
export async function admitApiTokenSessionOperation(input: Readonly<{
    principal: VerifiedApiTokenPrincipal;
    sessionId: string;
    actionId: ActionId;
    capability?: SessionCapability;
    authentication?: SessionAccessAuthentication;
    targetMachineId?: string | null;
}>): Promise<Readonly<{ ok: true; access: EffectiveSessionAccess }>
    | Readonly<{ ok: false; error: "credential_scope_denied" | "present_user_required" }>> {
    const grant = input.principal.grant;
    const authentication = {
        env: process.env,
        ...input.authentication,
        authority: input.principal.authority,
        authenticationEvidence: input.principal.authenticationEvidence,
        apiTokenGrant: grant,
    } satisfies SessionAccessAuthentication;
    const decision = await inTx(tx => resolveSessionAccessForOperation(tx, {
        accountId: input.principal.accountId, sessionId: input.sessionId, authentication,
        apiTokenAction: { actionId: input.actionId, targetMachineId: input.targetMachineId },
        ...(input.capability ? { capability: input.capability } : {}),
    }));
    if (decision.status !== "allowed") return { ok: false, error: "credential_scope_denied" };
    if (input.capability === "approveRuntimePermissions"
        && !canCredentialDecideV1({ authority: authentication.authority, grant })) {
        return { ok: false, error: "present_user_required" };
    }
    return { ok: true, access: decision.access };
}

type OptionalPublicAuthCandidate = Readonly<{
    userId: string;
    authTokenKind: AuthTokenKind;
    authority: AuthTokenAuthority;
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
}>;

type RejectedRestrictedPublicAuthCandidate = Readonly<{
    status: "rejected_restricted";
    authTokenKind: "ephemeral_session_runner";
}>;

export type OptionalPublicAuthDisposition =
    | Readonly<{ status: "anonymous" }>
    | Readonly<{
        status: "authenticated";
        principal: Omit<OptionalPublicAuthCandidate, "authority"> & Readonly<{
            authority: Exclude<AuthTokenAuthority, "session_runtime">;
        }>;
    }>
    | Readonly<{ status: "session_runtime_forbidden" }>;

/**
 * One disposition for credentials presented to optional-auth public surfaces.
 *
 * PAT and Directory credentials retain their established anonymous-compatible
 * behavior, while an ordinary Account/terminal credential may enrich the public
 * request. A verified restricted Session runtime is different: silently dropping
 * it would let that credential continue through a public token/cookie path with
 * authority it was never issued to exercise.
 */
export function resolveOptionalPublicAuthDisposition(
    verified: OptionalPublicAuthCandidate | RejectedRestrictedPublicAuthCandidate | null,
): OptionalPublicAuthDisposition {
    if (!verified) return { status: "anonymous" };
    if ("status" in verified) return { status: "session_runtime_forbidden" };
    if (verified.authTokenKind === "ephemeral_session_runner") {
        return { status: "session_runtime_forbidden" };
    }
    if (
        (verified.authTokenKind === "account" || verified.authTokenKind === "terminal")
        && verified.authority !== "session_runtime"
    ) {
        return {
            status: "authenticated",
            principal: { ...verified, authority: verified.authority },
        };
    }
    return { status: "anonymous" };
}

type AuthenticatedRouteRequest = Readonly<{
    method?: string;
    url?: string;
    authTokenKind?: unknown;
    userId?: unknown;
    sessionRuntimePrincipal?: VerifiedEphemeralSessionRunnerPrincipal;
    apiTokenPrincipal?: Readonly<{ grant: ApiTokenGrantV1 }>;
    params?: unknown;
    body?: unknown;
    query?: unknown;
    externalActionExecutionAuthorized?: unknown;
    externalActionEffectActionId?: unknown;
    routeOptions?: Readonly<{
        url?: string;
        config?: Readonly<{
            allowApiToken?: unknown;
            allowScopedApiToken?: unknown;
            apiTokenSessionAction?: unknown;
            apiTokenSessionActionWhen?: Readonly<{ field: 'withdraw'; equals: 'true'; actionId: ActionId }>;
            allowAccountDirectoryToken?: unknown;
            restrictedCredentialBinding?: RestrictedCredentialRouteBinding;
        }>;
    }>;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

/** The incumbent static Session operation; query-selected semantics are admitted at this same boundary. */
export function resolveApiTokenSessionActionForRoute(request: AuthenticatedRouteRequest): ActionId | undefined {
    const action = request.routeOptions?.config?.apiTokenSessionAction;
    const mode = request.routeOptions?.config?.apiTokenSessionActionWhen;
    if (mode) {
        const value = readRecord(request.query)?.[mode.field];
        if (value === mode.equals) return mode.actionId;
        if (value !== undefined && value !== 'false') return undefined;
    }
    return typeof action === 'string' ? action as ActionId : undefined;
}

/**
 * Signed composite Actions may use the incumbent Session readers under their
 * normal access/projection owner. A mutation must name the route's actual
 * effect, including query-selected custody semantics, not merely its root.
 */
export function isExternalActionSessionRoutePurposeAllowed(
    request: AuthenticatedRouteRequest,
    effectActionId: string,
): boolean {
    const config = request.routeOptions?.config;
    if (config?.apiTokenSessionAction === undefined && config?.apiTokenSessionActionWhen === undefined) return true;
    const actionId = resolveApiTokenSessionActionForRoute(request);
    if ((effectActionId === 'session.pending.resetStart.set' && actionId === 'session.message.send')
        || (effectActionId === 'session.pending.resetStart.cancel' && actionId === 'session.pending.withdraw')) {
        return readExternalActionPendingResetStartPurpose({ actionId: effectActionId,
            method: request.method ?? '', path: request.url ?? request.routeOptions?.url ?? '', body: request.body }) !== null;
    }
    return actionId !== undefined
        && (getActionSpec(actionId).sideEffectClass === 'read' || actionId === effectActionId);
}

export function readRestrictedCredentialRouteField(
    request: AuthenticatedRouteRequest,
    field: RestrictedCredentialRouteSessionSelector | RestrictedCredentialRouteMachineField,
): unknown {
    if (typeof field !== "string") {
        const values = field.map(candidate => readRestrictedCredentialRouteField(request, candidate))
            .filter(value => value !== undefined);
        return values.length === 1 ? values[0] : undefined;
    }
    const params = readRecord(request.params);
    const body = readRecord(request.body);
    const query = readRecord(request.query);
    switch (field) {
        case "params.sessionId":
            return params?.sessionId;
        case "params.destinationSessionId":
            return params?.destinationSessionId;
        case "body.sessionId":
            return body?.sessionId;
        case "body.consumer.sessionId": {
            const consumer = readRecord(body?.consumer);
            return consumer?.kind === "session" ? consumer.sessionId : undefined;
        }
        case "query.sessionId":
            return query?.sessionId;
        case "query.sessionAccessSessionId":
            return query?.sessionAccessSessionId;
        case "body.machineId":
            return body?.machineId;
        case "body.initiatorMachineId":
            return body?.initiatorMachineId;
    }
}

/**
 * A Runner credential is admitted on a route that declares how the request
 * names its Session and Machine, and only when those exact values are the ones
 * the credential was issued for. A route that declares no binding is not a
 * Runner surface and fails closed.
 */
function isEphemeralSessionRunnerRequestBound(request: AuthenticatedRouteRequest): boolean {
    const principal = request.sessionRuntimePrincipal;
    if (!principal || request.userId !== principal.accountId) return false;
    const binding = request.routeOptions?.config?.restrictedCredentialBinding;
    if (!binding) return false;
    if (binding.scope === "account") return true;
    if (readRestrictedCredentialRouteField(request, binding.session) !== principal.sessionId) return false;
    if (binding.machine === undefined) return true;
    const machineId = readRestrictedCredentialRouteField(request, binding.machine);
    if (binding.machineOptional === true && (machineId === undefined || machineId === null)) return true;
    return machineId === principal.machineId;
}

/** Restricted kinds never gain ordinary Home transport capabilities. */
export function isRestrictedAuthTokenKind(
    kind: unknown,
): boolean {
    switch (kind) {
        case "account":
        case "terminal":
            return false;
        case "api_token":
        case "account_directory":
        case "ephemeral_session_runner":
        default:
            return true;
    }
}

/**
 * Restricted credentials are opt-in at the HTTP route boundary, and
 * Directory-only routes reject ordinary Home credentials. A verified external
 * Action execution has already reconstructed its exact current PAT principal;
 * the explicit domain handler therefore applies that PAT's normal authority
 * without a second route-local Action-id registry.
 */
export function isRestrictedAuthTokenDeniedForRoute(
    request: AuthenticatedRouteRequest,
): boolean {
    switch (request.authTokenKind) {
        case "account":
            return request.routeOptions?.config?.allowAccountDirectoryToken === true;
        case "terminal":
            return request.routeOptions?.config?.allowAccountDirectoryToken === true;
        case "api_token":
            if (request.externalActionExecutionAuthorized === true) return false;
            if (resolveApiTokenSessionActionForRoute(request) !== undefined
                && request.routeOptions?.config?.restrictedCredentialBinding?.scope === "session") return false;
            if (request.routeOptions?.config?.allowApiToken !== true) return true;
            return request.apiTokenPrincipal !== undefined
                && isApiTokenGrantRestrictedV1(request.apiTokenPrincipal.grant)
                && request.routeOptions.config.allowScopedApiToken !== true;
        case "account_directory":
            return request.routeOptions?.config?.allowAccountDirectoryToken !== true;
        case "ephemeral_session_runner":
            return !isEphemeralSessionRunnerRequestBound(request);
        default:
            return true;
    }
}
