import { FastifyBaseLogger, FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { IncomingMessage, Server, ServerResponse } from "http";
import type { PeerTcpTunnelRelayTransportFactory } from "@/app/machines/peer/mediation/tunnel/peerRelayStreamTransport";
import type { PeerMediationObservabilityEmitter } from "@/app/api/socket/peer/mediation/observability/events";
import type { PeerMediationViewerSocketOwnershipVerifier } from "@/app/api/socket/viewerSocketOwnership";
import type { ExternalActionDaemonDispatcher } from "@/app/api/socket/externalActionDispatcher";
import type { ExternalProviderBrokerDispatch } from "@/app/api/routes/providers/registerExternalProviderApiRoutes";
import type { TeamCredentialResourceTestBrokerDispatch } from "@/app/api/routes/providers/externalProviderBrokerDispatcher";
import type { VerifiedApiTokenPrincipal } from "@/app/auth/auth";
import type { AccountStoredContentCompatibilityEvaluation } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import type { MachineDaemonPresenceSocketServer } from "@/app/machines/machineDaemonPresence";
import type {
    AutomationReplyHandoffDispatchResultV1,
    SessionServerStartDispatchResultV1,
} from "@happier-dev/protocol";
import type { AuthTokenAuthenticationEvidenceV1 } from "@happier-dev/protocol";
import type { VerifiedEphemeralSessionRunnerPrincipal } from "@happier-dev/protocol/ephemeralRunner/principal";
import type { ExternalActionTargetV1, ExternalActionExecutionAuthorizationBindingV1 } from "@happier-dev/protocol/actions";
import type { ActionId } from "@happier-dev/protocol/actions";
import type { CallerInputConstraintsV1 } from "@happier-dev/protocol/auth/apiTokenGrant";
import type { CurrentSessionPublisherAuthority } from '@/app/presence/sessionPublisherPresence';

/**
 * Exact request field that names the Session an HTTP route acts on. A route
 * declares the one it reads; admission never searches the request for a
 * Session, so a route that names none is simply not Runner-reachable.
 */
export type RestrictedCredentialRouteSessionField =
    | "params.sessionId"
    | "params.destinationSessionId"
    | "body.sessionId"
    | "body.consumer.sessionId"
    | "query.sessionId"
    | "query.sessionAccessSessionId";

/** The change feed accepts either existing selector, never both or neither for a PAT. */
export type RestrictedCredentialRouteSessionSelector = RestrictedCredentialRouteSessionField
    | readonly ["query.sessionId", "query.sessionAccessSessionId"];

/** Exact request field that names the Machine an HTTP route acts on. */
export type RestrictedCredentialRouteMachineField =
    | "body.machineId"
    | "body.initiatorMachineId";

/**
 * How a route binds a restricted Runner credential to the Session and Machine
 * that credential was issued for.
 *
 * Under the 2026-09-05 ruling the Runner is an ordinary daemon runtime under a
 * Session+Machine-scoped principal: there is no server-local list of Runner
 * "operations". A route states where its request names the Session (and, when
 * it acts on a Machine, where it names that), and HTTP admission binds those
 * exact values to the principal. Which Session capability the operation then
 * requires stays with the domain owner that already resolves Session access;
 * this boundary never duplicates that decision.
 */
export type RestrictedCredentialRouteBinding =
    /** Account-scoped: the route reads nothing Session-specific. */
    | Readonly<{ scope: "account" }>
    | Readonly<{
        scope: "session";
        session: RestrictedCredentialRouteSessionSelector;
        machine?: RestrictedCredentialRouteMachineField;
        /** The Machine field is optional in this route's body; absent means Session-only. */
        machineOptional?: true;
    }>;

export type Fastify = FastifyInstance<
    Server<typeof IncomingMessage, typeof ServerResponse>,
    IncomingMessage,
    ServerResponse<IncomingMessage>,
    FastifyBaseLogger,
    ZodTypeProvider
>;

declare module 'fastify' {
    interface FastifyContextConfig {
        /** Raw API-token bearer requests are denied unless an HTTP route explicitly opts in. */
        allowApiToken?: true;
        /** Explicit scope-aware surface; an ordinary PAT opt-in does not admit restricted grants. */
        allowScopedApiToken?: true;
        /** Session operation checked through the shared grant and effective-access admission owner. */
        apiTokenSessionAction?: ActionId;
        /** Exact semantic mode on the existing pending-delete route; unknown/combined values fail closed. */
        apiTokenSessionActionWhen?: Readonly<{ field: 'withdraw'; equals: 'true'; actionId: ActionId }>;
        /** Account Directory tokens are denied unless a Directory route opts in. */
        allowAccountDirectoryToken?: true;
        /** Released pre-provenance Home credentials are denied when a route family opts out. */
        allowLegacyHomeToken?: false;
        /** Runner credentials are denied unless the route binds them to their exact Session/Machine. */
        restrictedCredentialBinding?: RestrictedCredentialRouteBinding;
        /** Keeps connection authentication rejection distinct from an authenticated subject failure. */
        connectionAuthFailureError?: "authentication_failed" | "invalid_token";
        /** Route-family error whose declared response schema represents a denied restricted credential. */
        restrictedAuthFailureError?: "team_forbidden";
        /** Public bearer-only routes can opt out of the global CORS hook. */
        cors?: false;
    }
    interface FastifyInstance {
        /** Sole live Session publisher locality resolver; offline locality remains unavailable. */
        resolveCurrentSessionMachine?: (input: Readonly<{ accountId: string; sessionId: string }>) => Promise<string | null>;
        /** Same publisher owner, exposing its request-local initial-mint fact. */
        resolveCurrentSessionPublisher?: (input: Readonly<{ accountId: string; sessionId: string }>) => Promise<CurrentSessionPublisherAuthority | null>;
        disconnectApiTokenSockets?: (tokenIds: readonly string[]) => void;
    }
    interface FastifyRequest {
        userId: string;
        /** Verified credential provenance; missing is never present-user authority. */
        authTokenKind?: "account" | "account_directory" | "terminal" | "api_token" | "ephemeral_session_runner";
        /** Server-stamped authority for Action ingress; never caller-provided input. */
        authAuthority?: "present_user" | "account_automation";
        /** Explicit compatibility provenance; missing never means current. */
        authTokenLegacy?: boolean;
        /** Epoch of the exact verified signed bearer; never inferred from current Account state. */
        authTokenEpoch?: number;
        /** Server-produced method/provider facts carried by the verified credential. */
        authTokenAuthenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
        /** Request-local verified provenance for an admitted PAT; never a raw bearer. */
        apiTokenPrincipal?: VerifiedApiTokenPrincipal;
        /** Exact server-revalidated Runner scope; Account ownership is not authorization. */
        sessionRuntimePrincipal?: VerifiedEphemeralSessionRunnerPrincipal;
        /** Exact Machine-bound external Action proof admitted this request. */
        externalActionExecutionAuthorized?: true;
        /** Exact immutable binding admitted by the installed execution proof. */
        externalActionExecutionAuthorizationBinding?: ExternalActionExecutionAuthorizationBindingV1;
        /** Immutable caller input ceiling from verified invocation admission, not a later PAT grant. */
        externalActionInputConstraints?: CallerInputConstraintsV1;
        /** Effect id from the verified Machine signature; never read from caller input. */
        externalActionEffectActionId?: string;
        /** Root Action id from the verified execution binding; never read from caller input. */
        externalActionRootActionId?: string;
        /** Exact target from the verified Machine signature; never read from route input. */
        externalActionExecutionTarget?: ExternalActionTargetV1;
        /** Exact admitted request correlation, stamped only after Machine-signature verification. */
        externalActionExecutionRequestId?: string;
        /** Digest from the incumbent admitted Action envelope; private correlation only. */
        externalActionExecutionRequestEnvelopeDigest?: string;
        /** Current installation whose signature admitted the protected request body. */
        externalActionExecutionMachineId?: string;
        /** Custodian from the verified execution binding, independent of requester principal. */
        externalActionExecutionCustodianAccountId?: string;
        /** Home-derived retained guest scope; only verified controller signatures stamp it. */
        externalActionManagedGuestActivity?: Readonly<{ machineId: string; installationId: string; encryptionMode: 'plain' | 'e2ee' }>;
        startTime?: number;
        accountStoredContentCompatibility?: AccountStoredContentCompatibilityEvaluation;
    }
    interface FastifyInstance {
        authenticate: any;
        forwardRpcForUser: (params: {
            userId: string;
            method: string;
            params: unknown;
            timeoutMs?: number;
        }) => Promise<
            | { ok: true; result: unknown }
            | { ok: false; error: string; errorCode?: string }
        >;
        forwardAutomationReplyHandoffToMachine: (
            params: unknown,
        ) => Promise<AutomationReplyHandoffDispatchResultV1>;
        forwardSessionServerStartToMachine: (
            params: unknown,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) => Promise<SessionServerStartDispatchResultV1>;
        forwardExternalActionToMachine: ExternalActionDaemonDispatcher;
        forwardExternalProviderBrokerRequest?: ExternalProviderBrokerDispatch;
        forwardTeamCredentialBrokerResourceTest?: TeamCredentialResourceTestBrokerDispatch;
        disconnectAccountSockets: (accountId: string) => void;
        machineDaemonPresence: MachineDaemonPresenceSocketServer;
        createPeerTcpTunnelRelayTransport?: PeerTcpTunnelRelayTransportFactory;
        peerMediationObservability?: PeerMediationObservabilityEmitter;
        verifyPeerMediationViewerSocketOwnership?: PeerMediationViewerSocketOwnershipVerifier;
    }
}
