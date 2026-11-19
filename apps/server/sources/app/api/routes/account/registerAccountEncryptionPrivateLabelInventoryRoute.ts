import { z } from "zod/mini";
import { AccountEncryptionMigratePrivateLabelInventoryV1Schema } from "@happier-dev/protocol/account/encryptionMigrate";

import type { Fastify } from "@/app/api/types";
import { PresentUserRequiredResponseSchema, requirePresentUser } from "@/app/api/utils/requirePresentUser";
import { readAccountPrivateLabelMigrationInventoryInTx } from "@/app/encryption/accountPrivateLabelContent";
import { inReadSnapshot } from "@/storage/inTx";

/** Home migration authority is independent of Account Directory credentials. */
export function registerAccountEncryptionPrivateLabelInventoryRoute(app: Fastify): void {
    app.get("/v1/account/encryption/migrate/private-labels/inventory", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: { response: {
            200: AccountEncryptionMigratePrivateLabelInventoryV1Schema,
            400: z.strictObject({ error: z.literal("encryption_unavailable") }),
            403: PresentUserRequiredResponseSchema,
        } },
    }, async (request, reply) => {
        const result = await inReadSnapshot(tx => readAccountPrivateLabelMigrationInventoryInTx(tx, request.userId));
        if (result.kind !== "available") return reply.code(400).send({ error: result.kind });
        return reply.send(result.inventory);
    });
}
