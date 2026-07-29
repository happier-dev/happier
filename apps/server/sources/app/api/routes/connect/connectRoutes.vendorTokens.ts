import { z } from "zod";

import { type Fastify } from "../../types";
import { encryptString } from "@/modules/encrypt";
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
                200: z.object({ success: z.literal(true) }),
                409: z.object({ error: z.literal("connect_credential_conflict") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        const encrypted = encryptString(["user", userId, "vendors", request.params.vendor, "token"], request.body.token);
        const result = await mutateLegacyConnectedServiceVendorToken({
            accountId: userId,
            vendor: request.params.vendor,
            token: encrypted,
        });
        if (result.status === "connected_credential_conflict") {
            return reply.code(409).send({ error: "connect_credential_conflict" });
        }
        reply.send({ success: true });
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
                200: z.object({ success: z.literal(true) }),
                409: z.object({ error: z.literal("connect_credential_conflict") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        const result = await deleteLegacyConnectedServiceVendorToken({
            accountId: userId,
            vendor: request.params.vendor,
        });
        if (result.status === "connected_credential_conflict") {
            return reply.code(409).send({ error: "connect_credential_conflict" });
        }
        reply.send({ success: true });
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
