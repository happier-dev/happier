import { z } from "zod";

import type { Fastify } from "../../../types";

import {
  pollOpenAiCodexDeviceAuthTransaction,
  startOpenAiCodexDeviceAuthTransaction,
} from "./openaiCodex/openAiCodexDeviceAuthTransaction";
import { isValidOpenAiCodexDeviceAuthRecipientPublicKey } from "./openaiCodex/openaiCodexDeviceAuth";
import { resolveApiHotEndpointRateLimit } from "../../../utils/apiRateLimitCatalog";

const CONNECTED_SERVICE_OAUTH_PUBLIC_KEY_MAX_LEN = 512;
const DEVICE_AUTH_TRANSACTION_ID_MAX_LEN = 160;
const RELEASED_DEVICE_AUTH_USER_CODE_MAX_LEN = 160;

/**
 * The `deviceAuthId` response/poll shape adapts exact UI/server-v0.2.1 at
 * 4913c1e533c872a0712ba1c25b3104fd470aacc2 to the current transaction owner.
 * Remove that legacy shape when exact 0.2.1 leaves the supported predecessor window.
 */
export function registerConnectedServiceOpenAiCodexDeviceAuthRoutes(app: Fastify): void {
  app.post("/v2/connect/openai-codex/oauth/device/start", {
    preHandler: app.authenticate,
    config: {
      rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.deviceAuth.start"),
    },
    schema: {
      body: z.object({
        publicKey: z.string()
          .min(1)
          .max(CONNECTED_SERVICE_OAUTH_PUBLIC_KEY_MAX_LEN)
          .refine(isValidOpenAiCodexDeviceAuthRecipientPublicKey),
      }),
      response: {
        200: z.object({
          transactionId: z.string().min(1),
          deviceAuthId: z.string().min(1),
          userCode: z.string().min(1),
          intervalMs: z.number().int().min(1),
          verificationUrl: z.string().url(),
        }),
      },
    },
  }, async (request, reply) => {
    const started = await startOpenAiCodexDeviceAuthTransaction({
      accountId: request.userId,
      recipientPublicKeyB64Url: request.body.publicKey,
      now: Date.now(),
    });
    return reply.send({
      ...started,
      // Alias the current opaque server-owned handle, never the provider device secret.
      deviceAuthId: started.transactionId,
    });
  });

  app.post("/v2/connect/openai-codex/oauth/device/poll", {
    preHandler: app.authenticate,
    config: {
      rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.deviceAuth.poll"),
    },
    schema: {
      body: z.union([
        z.object({
          transactionId: z.string().min(1).max(DEVICE_AUTH_TRANSACTION_ID_MAX_LEN),
        }).strict(),
        z.object({
          publicKey: z.string().min(1).max(CONNECTED_SERVICE_OAUTH_PUBLIC_KEY_MAX_LEN),
          deviceAuthId: z.string().min(1).max(DEVICE_AUTH_TRANSACTION_ID_MAX_LEN),
          userCode: z.string().min(1).max(RELEASED_DEVICE_AUTH_USER_CODE_MAX_LEN),
          intervalMs: z.number().int().min(1).optional(),
        }).strict(),
      ]),
      response: {
        200: z.union([
          z.object({ status: z.literal("pending"), retryAfterMs: z.number().int().min(1) }),
          z.object({ status: z.literal("success"), bundle: z.string().min(1) }),
        ]),
        404: z.object({ error: z.literal("device_auth_transaction_not_found") }),
        410: z.object({ error: z.literal("device_auth_transaction_expired") }),
      },
    },
  }, async (request, reply) => {
    const poll = await pollOpenAiCodexDeviceAuthTransaction({
      accountId: request.userId,
      transactionId: "transactionId" in request.body
        ? request.body.transactionId
        : request.body.deviceAuthId,
      now: Date.now(),
    });

    if (poll.status === "not_found") {
      return reply.code(404).send({ error: "device_auth_transaction_not_found" });
    }
    if (poll.status === "expired") {
      return reply.code(410).send({ error: "device_auth_transaction_expired" });
    }
    if (poll.status === "pending") {
      return reply.send({ status: "pending", retryAfterMs: poll.retryAfterMs });
    }

    return reply.send({ status: "success", bundle: poll.bundle });
  });
}
