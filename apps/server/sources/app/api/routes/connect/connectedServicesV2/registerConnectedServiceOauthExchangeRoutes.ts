import { z } from "zod";

import type { Fastify } from "../../../types";
import { ConnectedServiceIdSchema, type ConnectedServiceId } from "@happier-dev/protocol";

import {
  ConnectedServiceOauthStateMismatchError,
  ConnectedServiceOauthTimeoutError,
  exchangeConnectedServiceOauthTokens,
} from "./exchangeConnectedServiceOauthTokens";

const CONNECTED_SERVICE_OAUTH_PUBLIC_KEY_MAX_LEN = 512;
const CONNECTED_SERVICE_OAUTH_CODE_MAX_LEN = 4096;
const CONNECTED_SERVICE_OAUTH_VERIFIER_MAX_LEN = 256;
const CONNECTED_SERVICE_OAUTH_REDIRECT_URI_MAX_LEN = 2048;
const CONNECTED_SERVICE_OAUTH_STATE_MAX_LEN = 2048;

const ConnectedServiceOauthExchangeErrorResponseSchema = z.union([
  z.object({
    error: z.enum([
      "connect_oauth_state_mismatch",
      "connect_oauth_timeout",
      "connect_oauth_exchange_failed",
    ]),
  }),
  // Fastify validation errors can occur before the handler (e.g. max-length checks). When using
  // zod serializerCompiler, ensure we accept the default error shape for 400 responses.
  z.object({
    statusCode: z.literal(400),
    error: z.string().min(1),
    message: z.string().min(1),
  }).passthrough(),
]);

export function registerConnectedServiceOauthExchangeRoutes(app: Fastify): void {
  app.post("/v2/connect/:serviceId/oauth/exchange", {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        serviceId: ConnectedServiceIdSchema,
      }),
      body: z.object({
        publicKey: z.string().min(1).max(CONNECTED_SERVICE_OAUTH_PUBLIC_KEY_MAX_LEN),
        code: z.string().min(1).max(CONNECTED_SERVICE_OAUTH_CODE_MAX_LEN),
        verifier: z.string().min(1).max(CONNECTED_SERVICE_OAUTH_VERIFIER_MAX_LEN),
        redirectUri: z.string().url().max(CONNECTED_SERVICE_OAUTH_REDIRECT_URI_MAX_LEN),
        state: z.string().min(1).max(CONNECTED_SERVICE_OAUTH_STATE_MAX_LEN).nullable().optional(),
      }),
      response: {
        200: z.object({ bundle: z.string().min(1) }),
        400: ConnectedServiceOauthExchangeErrorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const serviceId = request.params.serviceId satisfies ConnectedServiceId;
    if (serviceId === "anthropic") {
      const state = typeof request.body.state === "string" ? request.body.state.trim() : "";
      if (!state) {
        return reply.code(400).send({ error: "connect_oauth_state_mismatch" });
      }
    }
    try {
      const exchanged = await exchangeConnectedServiceOauthTokens({
        serviceId,
        publicKeyB64Url: request.body.publicKey,
        code: request.body.code,
        verifier: request.body.verifier,
        redirectUri: request.body.redirectUri,
        state: request.body.state ?? null,
        now: Date.now(),
      });
      return reply.send({ bundle: exchanged.bundleB64Url });
    } catch (error) {
      if (error instanceof ConnectedServiceOauthTimeoutError) {
        return reply.code(400).send({ error: "connect_oauth_timeout" });
      }
      if (error instanceof ConnectedServiceOauthStateMismatchError) {
        return reply.code(400).send({ error: "connect_oauth_state_mismatch" });
      }
      return reply.code(400).send({ error: "connect_oauth_exchange_failed" });
    }
  });
}

