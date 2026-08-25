import { Buffer } from "node:buffer";

import type { FastifyReply, FastifyRequest } from "fastify";

import {
    EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
    ExternalActionActionIdV1Schema,
    ExternalActionRequestEnvelopeV1Schema,
    type ExternalActionServerPrincipalV1,
    type PreparedExternalActionResponseEnvelopeV1,
    projectExternalActionResponseEnvelopeV1,
    projectExternalActionHttpErrorV1,
    prepareExternalActionResponseEnvelopeV1,
    type ExternalActionHttpErrorCodeV1,
} from "@happier-dev/protocol/actions";

import {
    type ExternalActionDaemonDispatcher,
} from "@/app/api/socket/externalActionDispatcher";

import type { Fastify } from "../../types";

type ExternalActionRouteParams = Readonly<{
    actionId: string;
}>;

export type RegisterExternalActionRoutesDependencies = Readonly<{
    dispatch?: ExternalActionDaemonDispatcher;
}>;

function sendExternalActionJson(reply: FastifyReply, statusCode: number, payload: unknown): FastifyReply {
    const serialized = JSON.stringify(payload);
    const body = typeof serialized === "string" ? serialized : "null";
    return sendExternalActionSerializedJson(reply, statusCode, body, Buffer.byteLength(body, "utf8"));
}

function sendExternalActionSerializedJson(
    reply: FastifyReply,
    statusCode: number,
    body: string,
    byteLength: number,
): FastifyReply {
    return reply
        .code(statusCode)
        .header("cache-control", "no-store")
        .header("content-type", "application/json; charset=utf-8")
        .header("content-length", String(byteLength))
        .send(body);
}

function sendExternalActionResponse(
    reply: FastifyReply,
    prepared: PreparedExternalActionResponseEnvelopeV1,
): FastifyReply {
    return sendExternalActionSerializedJson(reply, 200, prepared.body, prepared.byteLength);
}

function sendExternalActionHttpError(
    reply: FastifyReply,
    code: ExternalActionHttpErrorCodeV1,
): FastifyReply {
    const error = projectExternalActionHttpErrorV1(code);
    return sendExternalActionJson(reply, error.statusCode, error.payload);
}

function isFastifyBodyLimitError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "FST_ERR_CTP_BODY_TOO_LARGE";
}

function isFastifyExternalActionBodyParseError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (
            error.code === "FST_ERR_CTP_INVALID_JSON_BODY"
            || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
            || error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
        );
}

function createRequestLifetime(
    request: FastifyRequest,
    reply: FastifyReply,
): Readonly<{ signal: AbortSignal; dispose: () => void }> {
    const controller = new AbortController();
    const abort = (): void => {
        if (!controller.signal.aborted) {
            controller.abort(new Error("External Action request ended"));
        }
    };
    const abortIfResponseDidNotFinish = (): void => {
        if (!reply.raw.writableEnded) abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abortIfResponseDidNotFinish);
    if (request.raw.aborted) abort();
    return {
        signal: controller.signal,
        dispose: () => {
            request.raw.removeListener("aborted", abort);
            reply.raw.removeListener("close", abortIfResponseDidNotFinish);
        },
    };
}

function readExternalActionRequestPrincipal(
    request: FastifyRequest,
): ExternalActionServerPrincipalV1 | null {
    const verified = request.apiTokenPrincipal;
    if (
        request.authTokenKind !== "api_token"
        || request.authAuthority !== "account_automation"
        || !verified
        || verified.authority !== "account_automation"
        || verified.accountId !== request.userId
    ) {
        return null;
    }
    return {
        accountId: verified.accountId,
        principalId: verified.principalId,
        credentialId: verified.credentialId,
        authority: verified.authority,
    };
}

/**
 * Public server Action ingress. It authenticates only a PAT, validates the
 * finite transport envelope, then delegates placement and all Action semantics
 * to the server's single exact-daemon relay.
 */
export function registerExternalActionRoutes(
    app: Fastify,
    dependencies: RegisterExternalActionRoutesDependencies = {},
): void {
    const dispatch = dependencies.dispatch ?? app.forwardExternalActionToMachine;

    // Explicitly shadow global CORS handling: this public Action endpoint is
    // bearer-only and must not become browser-callable through preflight.
    app.options<{ Params: ExternalActionRouteParams }>("/v1/actions/:actionId", {
        config: { cors: false },
    }, async (_request, reply) => reply.header("cache-control", "no-store").code(404).send());

    app.post<{
        Params: ExternalActionRouteParams;
        Body: unknown;
    }>("/v1/actions/:actionId", {
        bodyLimit: EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
        config: { allowApiToken: true, cors: false, connectionAuthFailureError: "invalid_token" },
        errorHandler: (error, _request, reply) => {
            if (isFastifyBodyLimitError(error)) {
                sendExternalActionHttpError(reply, "request_too_large");
                return;
            }
            if (isFastifyExternalActionBodyParseError(error)) {
                sendExternalActionHttpError(reply, "invalid_envelope");
                return;
            }
            throw error;
        },
        onRequest: async (request, reply) => {
            reply.header("cache-control", "no-store");
            await app.authenticate(request, reply);
            if (reply.sent) return;
            if (!readExternalActionRequestPrincipal(request)) {
                return sendExternalActionJson(reply, 401, { error: "invalid_token" });
            }
        },
    }, async (request, reply) => {
        const lifetime = createRequestLifetime(request, reply);
        try {
            // The onRequest admission verified the bearer once and stamped
            // its immutable PAT provenance on this request. Do not retain or
            // forward the plaintext bearer beyond that boundary.
            const principal = readExternalActionRequestPrincipal(request);
            if (!principal) {
                return sendExternalActionJson(reply, 401, { error: "invalid_token" });
            }

            const actionId = ExternalActionActionIdV1Schema.safeParse(request.params.actionId);
            if (!actionId.success) {
                return sendExternalActionHttpError(reply, "invalid_action");
            }

            const envelope = ExternalActionRequestEnvelopeV1Schema.safeParse(request.body);
            if (!envelope.success) {
                return sendExternalActionHttpError(reply, "invalid_envelope");
            }

            const result = await dispatch({
                actionId: actionId.data,
                envelope: envelope.data,
                principal,
            }, { signal: lifetime.signal });
            if (result.kind === "placement_error") {
                const response = projectExternalActionResponseEnvelopeV1({
                    v: 1,
                    actionId: actionId.data,
                    ...(envelope.data.requestId === undefined
                        ? {}
                        : { requestId: envelope.data.requestId }),
                    execution: {
                        ok: false,
                        errorCode: result.code,
                        error: result.code,
                    },
                });
                if (!response) {
                    throw new Error("Protocol rejected external Action placement response");
                }
                return sendExternalActionResponse(
                    reply,
                    prepareExternalActionResponseEnvelopeV1(response),
                );
            }
            if (result.kind === "invalid_request") {
                return sendExternalActionHttpError(reply, result.errorCode);
            }
            return sendExternalActionResponse(reply, result.prepared);
        } finally {
            lifetime.dispose();
        }
    });
}
