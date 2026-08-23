import { Buffer } from "node:buffer";

import type { FastifyReply, FastifyRequest } from "fastify";

import {
    EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
    ExternalActionRequestEnvelopeV1Schema,
    projectExternalActionHttpErrorV1,
    type ExternalActionHttpErrorCodeV1,
} from "@happier-dev/protocol/actions";

import { auth } from "@/app/auth/auth";
import {
    type ExternalActionDaemonDispatcher,
    type ExternalActionServerPrincipal,
} from "@/app/api/socket/externalActionDispatcher";

import type { Fastify } from "../../types";

type ExternalActionRouteParams = Readonly<{
    actionId: string;
}>;

export type VerifyExternalActionPat = typeof auth.verifyPat;

export type RegisterExternalActionRoutesDependencies = Readonly<{
    verifyPat?: VerifyExternalActionPat;
    dispatch?: ExternalActionDaemonDispatcher;
}>;

function readBearerAuthorization(value: string | string[] | undefined): string | null {
    if (typeof value !== "string") return null;
    const match = /^Bearer ([^\s]+)$/.exec(value);
    return match ? match[1] : null;
}

function sendExternalActionJson(reply: FastifyReply, statusCode: number, payload: unknown): FastifyReply {
    const serialized = JSON.stringify(payload);
    const body = typeof serialized === "string" ? serialized : "null";
    return reply
        .code(statusCode)
        .header("cache-control", "no-store")
        .header("content-type", "application/json; charset=utf-8")
        .header("content-length", String(Buffer.byteLength(body, "utf8")))
        .send(body);
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

function placementFailureResponse(params: Readonly<{
    actionId: string;
    requestId?: string;
    code: "target_required" | "target_not_local" | "target_unavailable";
}>) {
    return {
        v: 1 as const,
        actionId: params.actionId,
        ...(params.requestId === undefined ? {} : { requestId: params.requestId }),
        execution: {
            ok: false as const,
            errorCode: params.code,
            error: params.code,
        },
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
    const verifyPat = dependencies.verifyPat ?? auth.verifyPat.bind(auth);
    const dispatch = dependencies.dispatch ?? app.forwardExternalActionToMachine;

    // Explicitly shadow global CORS handling: this public Action endpoint is
    // bearer-only and must not become browser-callable through preflight.
    app.options<{ Params: ExternalActionRouteParams }>("/v1/actions/:actionId", {
        config: { cors: false },
    }, async (_request, reply) => reply.code(404).send());

    app.post<{
        Params: ExternalActionRouteParams;
        Body: unknown;
    }>("/v1/actions/:actionId", {
        bodyLimit: EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
        config: { allowApiToken: true, cors: false },
        errorHandler: (error, _request, reply) => {
            if (isFastifyBodyLimitError(error)) {
                sendExternalActionHttpError(reply, "request_too_large");
                return;
            }
            throw error;
        },
        preHandler: [
            async (_request, reply) => {
                reply.header("cache-control", "no-store");
            },
            async (request, reply) => {
                if (!readBearerAuthorization(request.headers.authorization)) {
                    return sendExternalActionJson(reply, 401, { error: "invalid_token" });
                }
            },
            app.authenticate,
        ],
    }, async (request, reply) => {
        const lifetime = createRequestLifetime(request, reply);
        try {
            // `authenticate` establishes only connection admission. Re-read
            // the PAT to retain immutable credential provenance for the daemon.
            const token = readBearerAuthorization(request.headers.authorization);
            if (
                !token
                || request.authTokenKind !== "api_token"
                || request.authAuthority !== "account_automation"
            ) {
                return sendExternalActionJson(reply, 401, { error: "invalid_token" });
            }

            const verified = await verifyPat(token, lifetime.signal);
            if (!verified.ok || verified.accountId !== request.userId) {
                return sendExternalActionJson(reply, 401, { error: "invalid_token" });
            }

            const envelope = ExternalActionRequestEnvelopeV1Schema.safeParse(request.body);
            if (!envelope.success) {
                return sendExternalActionHttpError(reply, "invalid_envelope");
            }

            const principal: ExternalActionServerPrincipal = {
                accountId: verified.accountId,
                principalId: verified.principalId,
                credentialId: verified.credentialId,
                authority: verified.authority,
            };
            const result = await dispatch({
                actionId: request.params.actionId,
                envelope: envelope.data,
                principal,
            }, { signal: lifetime.signal });
            if (result.kind === "placement_error") {
                return sendExternalActionJson(reply, 200, placementFailureResponse({
                    actionId: request.params.actionId,
                    ...(envelope.data.requestId === undefined
                        ? {}
                        : { requestId: envelope.data.requestId }),
                    code: result.code,
                }));
            }
            if (!result.response.execution.ok && result.response.execution.errorCode === "invalid_action") {
                return sendExternalActionHttpError(reply, "invalid_action");
            }
            return sendExternalActionJson(reply, 200, result.response);
        } finally {
            lifetime.dispose();
        }
    });
}
