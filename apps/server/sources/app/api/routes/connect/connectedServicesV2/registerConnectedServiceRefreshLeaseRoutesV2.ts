import { z } from "zod";

import type { Fastify } from "../../../types";
import { ConnectedServiceIdSchema, type ConnectedServiceId } from "@happier-dev/protocol";

import { ConnectedServiceProfileIdSchema } from "./profileIdSchema";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";
import { resolveLegacyQualifiedConnectedAccountService } from "../qualifiedConnectedAccounts/identity";
import { acquireQualifiedConnectedServiceRefreshLease } from "../qualifiedConnectedAccounts/credentialRepository";

function registerConnectedServiceRefreshLeaseRoute(
  app: Fastify,
  params: Readonly<{ refreshLeaseMaxMs: number; routePrefix: "/v2" | "/v3" }>,
): void {
  const refreshLeaseMaxMs = params.refreshLeaseMaxMs;

  app.post(`${params.routePrefix}/connect/:serviceId/profiles/:profileId/refresh-lease`, {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        serviceId: ConnectedServiceIdSchema,
        profileId: ConnectedServiceProfileIdSchema,
      }),
      body: z.object({
        machineId: z.string().min(1),
        ownerId: z.string().min(1).optional(),
        leaseMs: z.number().int().min(1),
        expectedCredentialRevision: z.string().trim().min(1).max(128).optional(),
      }),
      response: {
        200: z.object({
          acquired: z.boolean(),
          leaseUntil: z.number().int().nonnegative(),
          ownerId: z.string(),
          credentialRevision: z.string(),
        }),
        404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
      },
    },
  }, async (request, reply) => {
    const userId = request.userId;
    const serviceId = request.params.serviceId satisfies ConnectedServiceId;
    const profileId = request.params.profileId;
    const { machineId } = request.body;
    const ownerId = request.body.ownerId?.trim() || machineId;
    const leaseMs = Math.min(request.body.leaseMs, refreshLeaseMaxMs);

    const result = await acquireQualifiedConnectedServiceRefreshLease({
      accountId: userId,
      ref: {
        service: resolveLegacyQualifiedConnectedAccountService(serviceId),
        accountId: profileId,
      },
      ownerId,
      ttlMs: leaseMs,
      ...(request.body.expectedCredentialRevision !== undefined
        ? {
          expectedCredentialRevision:
            request.body.expectedCredentialRevision,
        }
        : {}),
    });
    if (result.status === "not_found") {
      return reply.code(404).send({ error: "connect_credential_not_found" });
    }
    return reply.send({
      acquired: result.acquired,
      leaseUntil: result.leaseUntil,
      ownerId: result.ownerId,
      credentialRevision: result.credentialRevision,
    });
  });
}

export function registerConnectedServiceRefreshLeaseRoutesV2(
  app: Fastify,
  params: Readonly<{ refreshLeaseMaxMs: number }>,
): void {
  registerConnectedServiceRefreshLeaseRoute(app, { ...params, routePrefix: "/v2" });
}

export function registerConnectedServiceRefreshLeaseRoutesV3(
  app: Fastify,
  params: Readonly<{ refreshLeaseMaxMs: number }>,
): void {
  registerConnectedServiceRefreshLeaseRoute(app, { ...params, routePrefix: "/v3" });
}
