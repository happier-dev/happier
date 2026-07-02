import { z } from "zod";

import type { Fastify } from "../../../types";
import { db } from "@/storage/db";
import { ConnectedServiceIdSchema, type ConnectedServiceId } from "@happier-dev/protocol";

import { ConnectedServiceProfileIdSchema } from "./profileIdSchema";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";

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
      }),
      response: {
        200: z.object({
          acquired: z.boolean(),
          leaseUntil: z.number().int().nonnegative(),
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

    const now = Date.now();
    const nowDate = new Date(now);
    const nextExpiry = new Date(now + leaseMs);

    const acquired = await db.serviceAccountToken.updateMany({
      where: {
        accountId: userId,
        vendor: serviceId,
        profileId,
        OR: [
          { refreshLeaseExpiresAt: null },
          { refreshLeaseExpiresAt: { lte: nowDate } },
          { refreshLeaseOwnerMachineId: ownerId },
        ],
      },
      data: {
        refreshLeaseOwnerMachineId: ownerId,
        refreshLeaseExpiresAt: nextExpiry,
      },
    });

    if (acquired.count === 1) {
      return reply.send({ acquired: true, leaseUntil: nextExpiry.getTime() });
    }

    const row = await db.serviceAccountToken.findUnique({
      where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
      select: { refreshLeaseExpiresAt: true },
    });
    if (!row) return reply.code(404).send({ error: "connect_credential_not_found" });

    return reply.send({ acquired: false, leaseUntil: row.refreshLeaseExpiresAt?.getTime() ?? now });
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
