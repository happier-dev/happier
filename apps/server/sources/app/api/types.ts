import { FastifyBaseLogger, FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { IncomingMessage, Server, ServerResponse } from "http";
import type { PeerTcpTunnelRelayTransportFactory } from "@/app/local/services/preview/tunnel";
import type { PeerMediationObservabilityEmitter } from "@/app/api/socket/peer/mediation/observability/events";
import type { PeerMediationViewerSocketOwnershipVerifier } from "@/app/api/socket/viewerSocketOwnership";
import type { ExternalActionDaemonDispatcher } from "@/app/api/socket/externalActionDispatcher";
import type { VerifiedApiTokenPrincipal } from "@/app/auth/auth";
import type { AccountStoredContentCompatibilityEvaluation } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import type {
    AutomationReplyHandoffDispatchResultV1,
    SessionServerStartDispatchResultV1,
} from "@happier-dev/protocol";

export type Fastify = FastifyInstance<
    Server<typeof IncomingMessage, typeof ServerResponse>,
    IncomingMessage,
    ServerResponse<IncomingMessage>,
    FastifyBaseLogger,
    ZodTypeProvider
>;

declare module 'fastify' {
    interface FastifyContextConfig {
        /** API tokens are denied unless an HTTP route explicitly opts in. */
        allowApiToken?: true;
        /** Keeps connection authentication rejection distinct from an authenticated subject failure. */
        connectionAuthFailureError?: "authentication_failed" | "invalid_token";
        /** Public bearer-only routes can opt out of the global CORS hook. */
        cors?: false;
    }
    interface FastifyRequest {
        userId: string;
        /** Verified credential provenance; missing is never present-user authority. */
        authTokenKind?: "account" | "terminal" | "api_token";
        /** Server-stamped authority for Action ingress; never caller-provided input. */
        authAuthority?: "present_user" | "account_automation";
        /** Request-local verified provenance for an admitted PAT; never a raw bearer. */
        apiTokenPrincipal?: VerifiedApiTokenPrincipal;
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
        disconnectAccountSockets: (accountId: string) => void;
        createPeerTcpTunnelRelayTransport?: PeerTcpTunnelRelayTransportFactory;
        peerMediationObservability?: PeerMediationObservabilityEmitter;
        verifyPeerMediationViewerSocketOwnership?: PeerMediationViewerSocketOwnershipVerifier;
    }
}
