import { z } from "zod";

import { type Fastify } from "../types";
import { encryptString } from "@/modules/encrypt";
import { db } from "@/storage/db";
import { parseIntEnv } from "@/config/env";

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
            params: z.object({ vendor: z.enum(["openai", "anthropic", "gemini"]) }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const encrypted = encryptString(["user", userId, "vendors", request.params.vendor, "token"], request.body.token);
        await db.serviceAccountToken.upsert({
            where: { accountId_vendor: { accountId: userId, vendor: request.params.vendor } },
            update: { updatedAt: new Date(), token: encrypted },
            create: { accountId: userId, vendor: request.params.vendor, token: encrypted },
        });
        reply.send({ success: true });
    });

    app.get("/v1/connect/:vendor/token", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ vendor: z.enum(["openai", "anthropic", "gemini"]) }),
            response: { 200: z.object({ hasToken: z.boolean() }) },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const token = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor: { accountId: userId, vendor: request.params.vendor } },
            select: { id: true },
        });
        return reply.send({ hasToken: Boolean(token) });
    });

    app.delete("/v1/connect/:vendor", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ vendor: z.enum(["openai", "anthropic", "gemini"]) }),
            response: { 200: z.object({ success: z.literal(true) }) },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        await db.serviceAccountToken.deleteMany({
            where: { accountId: userId, vendor: request.params.vendor },
        });
        reply.send({ success: true });
    });

    app.get("/v1/connect/tokens", {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    tokens: z.array(
                        z.object({
                            vendor: z.enum(["openai", "anthropic", "gemini"]),
                            hasToken: z.boolean(),
                        }),
                    ),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const tokens = await db.serviceAccountToken.findMany({ where: { accountId: userId }, select: { vendor: true } });
        return reply.send({
            tokens: tokens.map((t) => ({ vendor: t.vendor as any, hasToken: true })),
        });
    });
}
