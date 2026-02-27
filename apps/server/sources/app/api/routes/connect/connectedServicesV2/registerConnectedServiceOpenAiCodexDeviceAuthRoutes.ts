import { z } from "zod";

import type { Fastify } from "../../../types";

import {
  exchangeOpenAiCodexDeviceAuthApprovalForBundle,
  pollOpenAiCodexDeviceAuthOnce,
  startOpenAiCodexDeviceAuth,
} from "./openaiCodex/openaiCodexDeviceAuth";

const CONNECTED_SERVICE_OAUTH_PUBLIC_KEY_MAX_LEN = 512;
const DEVICE_AUTH_ID_MAX_LEN = 1024;
const DEVICE_AUTH_USER_CODE_MAX_LEN = 256;

export function registerConnectedServiceOpenAiCodexDeviceAuthRoutes(app: Fastify): void {
  app.post("/v2/connect/openai-codex/oauth/device/start", {
    preHandler: app.authenticate,
    schema: {
      body: z.object({
        publicKey: z.string().min(1).max(CONNECTED_SERVICE_OAUTH_PUBLIC_KEY_MAX_LEN),
      }),
      response: {
        200: z.object({
          deviceAuthId: z.string().min(1),
          userCode: z.string().min(1),
          intervalMs: z.number().int().min(1),
          verificationUrl: z.string().url(),
        }),
      },
    },
  }, async (_request, reply) => {
    const started = await startOpenAiCodexDeviceAuth({});
    return reply.send(started);
  });

  app.post("/v2/connect/openai-codex/oauth/device/poll", {
    preHandler: app.authenticate,
    schema: {
      body: z.object({
        publicKey: z.string().min(1).max(CONNECTED_SERVICE_OAUTH_PUBLIC_KEY_MAX_LEN),
        deviceAuthId: z.string().min(1).max(DEVICE_AUTH_ID_MAX_LEN),
        userCode: z.string().min(1).max(DEVICE_AUTH_USER_CODE_MAX_LEN),
        intervalMs: z.number().int().min(1).max(60_000).optional(),
      }),
      response: {
        200: z.union([
          z.object({ status: z.literal("pending"), retryAfterMs: z.number().int().min(1) }),
          z.object({ status: z.literal("success"), bundle: z.string().min(1) }),
        ]),
      },
    },
  }, async (request, reply) => {
    const poll = await pollOpenAiCodexDeviceAuthOnce({
      deviceAuthId: request.body.deviceAuthId,
      userCode: request.body.userCode,
      intervalMs: typeof request.body.intervalMs === "number" ? request.body.intervalMs : 5_000,
    });

    if (poll.status === "pending") {
      return reply.send({ status: "pending", retryAfterMs: poll.retryAfterMs });
    }

    const exchanged = await exchangeOpenAiCodexDeviceAuthApprovalForBundle({
      publicKeyB64Url: request.body.publicKey,
      authorizationCode: poll.authorizationCode,
      codeVerifier: poll.codeVerifier,
      now: Date.now(),
    });
    return reply.send({ status: "success", bundle: exchanged.bundleB64Url });
  });
}
