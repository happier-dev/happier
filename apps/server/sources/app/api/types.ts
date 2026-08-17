import { FastifyBaseLogger, FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { IncomingMessage, Server, ServerResponse } from "http";
import type { PeerTcpTunnelRelayTransportFactory } from "@/app/local/services/preview/tunnel";
import type { PeerMediationObservabilityEmitter } from "@/app/api/socket/peer/mediation/observability/events";
import type { PeerMediationViewerSocketOwnershipVerifier } from "@/app/api/socket/viewerSocketOwnership";
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
    interface FastifyRequest {
        userId: string;
        /** Verified credential provenance; missing is never present-user authority. */
        authTokenKind?: "account" | "terminal";
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
        createPeerTcpTunnelRelayTransport?: PeerTcpTunnelRelayTransportFactory;
        peerMediationObservability?: PeerMediationObservabilityEmitter;
        verifyPeerMediationViewerSocketOwnership?: PeerMediationViewerSocketOwnershipVerifier;
    }
}
