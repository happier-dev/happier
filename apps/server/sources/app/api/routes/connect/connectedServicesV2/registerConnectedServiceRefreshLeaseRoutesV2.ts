import { z } from "zod";

import type { Fastify } from "../../../types";
import { db } from "@/storage/db";
import { ConnectedServiceIdSchema, type ConnectedServiceId } from "@happier-dev/protocol";

import { ConnectedServiceProfileIdSchema } from "./profileIdSchema";

export function registerConnectedServiceRefreshLeaseRoutesV2(
  app: Fastify,
  params: Readonly<{ refreshLeaseMaxMs: number }>,
): void {
  const refreshLeaseMaxMs = params.refreshLeaseMaxMs;

  app.post("/v2/connect/:serviceId/profiles/:profileId/refresh-lease", {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        serviceId: ConnectedServiceIdSchema,
        profileId: ConnectedServiceProfileIdSchema,
      }),
      body: z.object({
        machineId: z.string().min(1),
        leaseMs: z.number().int().min(1),
      }),
      response: {
        200: z.object({
          acquired: z.boolean(),
          leaseUntil: z.number().int().nonnegative(),
        }),
        404: z.object({ error: z.literal("connect_credential_not_found") }),
      },
    },
  }, async (request, reply) => {
    const userId = request.userId;
    const serviceId = request.params.serviceId satisfies ConnectedServiceId;
    const profileId = request.params.profileId;
    const { machineId } = request.body;
    const leaseMs = Math.min(request.body.leaseMs, refreshLeaseMaxMs);

    const now = Date.now();
    const nextExpiry = new Date(now + leaseMs);

    const row = await db.serviceAccountToken.findUnique({
      where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
      select: { id: true, refreshLeaseOwnerMachineId: true, refreshLeaseExpiresAt: true },
    });
    if (!row) return reply.code(404).send({ error: "connect_credential_not_found" });

    const currentExpiryMs = row.refreshLeaseExpiresAt ? row.refreshLeaseExpiresAt.getTime() : null;
    const isExpired = currentExpiryMs !== null && currentExpiryMs <= now;
    const canAcquire = currentExpiryMs === null || isExpired || row.refreshLeaseOwnerMachineId === machineId;

    if (!canAcquire) {
      return reply.send({ acquired: false, leaseUntil: currentExpiryMs ?? now });
    }

    const updated = await db.serviceAccountToken.update({
      where: { id: row.id },
      data: {
        refreshLeaseOwnerMachineId: machineId,
        refreshLeaseExpiresAt: nextExpiry,
      },
      select: { refreshLeaseExpiresAt: true },
    });

    return reply.send({ acquired: true, leaseUntil: updated.refreshLeaseExpiresAt?.getTime() ?? now });
  });
}

