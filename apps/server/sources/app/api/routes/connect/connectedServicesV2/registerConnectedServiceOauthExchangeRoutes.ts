import { z } from "zod";

import type { Fastify } from "../../../types";
import {
  CONNECTED_SERVICE_ERROR_CODES,
  ConnectedServiceErrorCodeSchema,
  ConnectedServiceIdSchema,
  type ConnectedServiceId,
} from "@happier-dev/protocol";

import {
  ConnectedServiceOauthExchangeError,
  ConnectedServiceOauthStateMismatchError,
  ConnectedServiceOauthTimeoutError,
  exchangeConnectedServiceOauthTokens,
} from "./exchangeConnectedServiceOauthTokens";

const CONNECTED_SERVICE_OAUTH_PUBLIC_KEY_MAX_LEN = 512;
const CONNECTED_SERVICE_OAUTH_CODE_MAX_LEN = 4096;
const CONNECTED_SERVICE_OAUTH_VERIFIER_MAX_LEN = 256;
const CONNECTED_SERVICE_OAUTH_REDIRECT_URI_MAX_LEN = 2048;
const CONNECTED_SERVICE_OAUTH_STATE_MAX_LEN = 2048;

const ConnectedServiceOauthExchangeErrorCodeSchema = ConnectedServiceErrorCodeSchema.extract([
  CONNECTED_SERVICE_ERROR_CODES.oauthStateMismatch,
  CONNECTED_SERVICE_ERROR_CODES.oauthTimeout,
  CONNECTED_SERVICE_ERROR_CODES.oauthExchangeFailed,
  CONNECTED_SERVICE_ERROR_CODES.oauthInvalidGrant,
  CONNECTED_SERVICE_ERROR_CODES.oauthInvalidClient,
  CONNECTED_SERVICE_ERROR_CODES.oauthMissingRefreshToken,
]);

const ConnectedServiceOauthExchangeErrorResponseSchema = z.union([
  z.object({
    error: ConnectedServiceOauthExchangeErrorCodeSchema,
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
    if (serviceId === "anthropic" || serviceId === "openai") {
      return reply.code(400).send({ error: CONNECTED_SERVICE_ERROR_CODES.oauthExchangeFailed });
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
        return reply.code(400).send({ error: CONNECTED_SERVICE_ERROR_CODES.oauthTimeout });
      }
      if (error instanceof ConnectedServiceOauthStateMismatchError) {
        return reply.code(400).send({ error: CONNECTED_SERVICE_ERROR_CODES.oauthStateMismatch });
      }
      if (error instanceof ConnectedServiceOauthExchangeError) {
        return reply.code(400).send({ error: error.errorCode });
      }
      return reply.code(400).send({ error: CONNECTED_SERVICE_ERROR_CODES.oauthExchangeFailed });
    }
  });
}
