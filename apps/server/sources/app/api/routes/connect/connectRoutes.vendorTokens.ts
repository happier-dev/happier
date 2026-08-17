import { z } from "zod";

import { type Fastify } from "../../types";
import { db } from "@/storage/db";
import { parseIntEnv } from "@/config/env";
import {
    deleteLegacyConnectedServiceVendorToken,
    mutateLegacyConnectedServiceVendorToken,
} from "./credentials/mutation";
import { ConnectedServiceCloudVendorKeySchema } from "@happier-dev/protocol";
import { collectLegacyConnectedServiceVendorKeysFromRows } from "./legacyConnectedServiceVendors";
import {
    listAllQualifiedConnectedAccountsInTx,
    listQualifiedConnectedAccounts,
} from "./qualifiedConnectedAccounts/credentialRepository";
import {
    resolveLegacyQualifiedConnectedAccountService,
    resolveLegacyServiceIdForQualifiedConnectedAccountService,
} from "./qualifiedConnectedAccounts/identity";

function resolveVendorTokenMaxLen(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(env.VENDOR_TOKEN_MAX_LEN, 4096, { min: 256, max: 65536 });
}

export function connectVendorTokenRoutes(app: Fastify) {
    const maxTokenLen = resolveVendorTokenMaxLen(process.env);

    //
    // Inference vendor token endpoints (existing)
    //

    app.post("/v1/connect/:vendor/register", {
        preHandler: app.authenticate,
        schema: {
            body: z.object({ token: z.string().min(1).max(maxTokenLen) }),
            params: z.object({ vendor: ConnectedServiceCloudVendorKeySchema }),
            response: {
                400: z.object({ error: z.literal("connect_credential_invalid") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        await mutateLegacyConnectedServiceVendorToken({
            accountId: userId,
            vendor: request.params.vendor,
        });
        return reply.code(400).send({ error: "connect_credential_invalid" });
    });

    app.get("/v1/connect/:vendor/token", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ vendor: ConnectedServiceCloudVendorKeySchema }),
            response: { 200: z.object({ hasToken: z.boolean() }) },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const accounts = await listQualifiedConnectedAccounts({
            accountId: userId,
            service: resolveLegacyQualifiedConnectedAccountService(
                request.params.vendor,
            ),
        });
        return reply.send({
            hasToken: accounts.some(
                (account) => account.ref.accountId === "default",
            ),
        });
    });

    app.delete("/v1/connect/:vendor", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ vendor: ConnectedServiceCloudVendorKeySchema }),
            response: {
                400: z.object({ error: z.literal("connect_credential_invalid") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        await deleteLegacyConnectedServiceVendorToken({
            accountId: userId,
            vendor: request.params.vendor,
        });
        return reply.code(400).send({ error: "connect_credential_invalid" });
    });

    app.get("/v1/connect/tokens", {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    tokens: z.array(
                        z.object({
                            vendor: ConnectedServiceCloudVendorKeySchema,
                            hasToken: z.boolean(),
                        }),
                    ),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const accounts = await listAllQualifiedConnectedAccountsInTx(db, {
            accountId: userId,
        });
        return reply.send({
            tokens: collectLegacyConnectedServiceVendorKeysFromRows(
                accounts.flatMap((account) => {
                    const vendor =
                        resolveLegacyServiceIdForQualifiedConnectedAccountService(
                            account.ref.service,
                        );
                    return vendor === null
                        ? []
                        : [{
                            vendor,
                            profileId: account.ref.accountId,
                        }];
                }),
            ).map((vendor) => ({
                    vendor,
                    hasToken: true,
                })),
        });
    });
}
