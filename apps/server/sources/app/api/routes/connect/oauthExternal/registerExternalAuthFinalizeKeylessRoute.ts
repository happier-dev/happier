import { createHash } from "node:crypto";
import * as privacyKit from "privacy-kit";
import { z } from "zod";

import { type Fastify } from "../../../types";
import { connectExternalIdentity } from "@/app/auth/providers/identity";
import { auth } from "@/app/auth/auth";
import { Context } from "@/context";
import { decryptString } from "@/modules/encrypt";
import { findOAuthProviderById } from "@/app/oauth/providers/registry";
import { db } from "@/storage/db";
import { validateUsername } from "@/app/social/usernamePolicy";
import { loadValidOAuthPending, deleteOAuthPendingBestEffort } from "../connectRoutes.oauthPending";
import { authPendingSchema } from "./oauthExternalSchemas";
import { readAuthOauthKeylessFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveKeylessAutoProvisionEligibility } from "@/app/auth/keyless/resolveKeylessAutoProvisionEligibility";
import { resolveKeylessAccountsAvailability } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";

function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

export function registerExternalAuthFinalizeKeylessRoute(app: Fastify) {
    app.post("/v1/auth/external/:provider/finalize-keyless", {
        schema: {
            params: z.object({ provider: z.string() }),
            body: z.object({
                pending: z.string().min(1),
                proof: z.string().min(1),
                username: z.string().min(1).optional(),
            }),
            response: {
                200: z.object({ success: z.literal(true), token: z.string().min(1) }),
                400: z.object({ error: z.enum(["invalid-pending", "invalid-proof", "username-required", "invalid-username"]) }),
                403: z.object({ error: z.enum(["keyless-disabled", "not-eligible", "e2ee-required"]) }),
                404: z.object({ error: z.literal("unsupported-provider") }),
                409: z.object({ error: z.enum(["restore-required", "username-taken"]) }),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findOAuthProviderById(process.env, providerId);
        if (!provider) return reply.code(404).send({ error: "unsupported-provider" });

        const keylessEnv = readAuthOauthKeylessFeatureEnv(process.env);
        const allowed = keylessEnv.enabled && keylessEnv.providers.includes(providerId);
        if (!allowed) return reply.code(403).send({ error: "keyless-disabled" });

        const pendingKey = request.body.pending.toString().trim();
        if (!pendingKey) return reply.code(400).send({ error: "invalid-pending" });

        const availability = resolveKeylessAccountsAvailability(process.env);
        if (!availability.ok) {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply
                .code(403)
                .send({ error: availability.reason === "e2ee-required" ? "e2ee-required" : "keyless-disabled" });
        }

        const pending = await loadValidOAuthPending(pendingKey);
        if (!pending) return reply.code(400).send({ error: "invalid-pending" });

        let parsedValue: z.infer<typeof authPendingSchema>;
        try {
            const parsed = authPendingSchema.safeParse(JSON.parse(pending.value));
            if (!parsed.success) {
                await deleteOAuthPendingBestEffort(pendingKey);
                return reply.code(400).send({ error: "invalid-pending" });
            }
            parsedValue = parsed.data;
        } catch {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }

        if (parsedValue.flow !== "auth" || parsedValue.provider.toString().trim().toLowerCase() !== providerId) {
            return reply.code(400).send({ error: "invalid-pending" });
        }
        if (parsedValue.authMode !== "keyless") {
            return reply.code(400).send({ error: "invalid-pending" });
        }

        const proof = request.body.proof.toString();
        const proofHash = sha256Hex(proof);
        if (!parsedValue.proofHash || proofHash !== parsedValue.proofHash) {
            return reply.code(400).send({ error: "invalid-proof" });
        }

        let accessToken: string;
        let refreshToken: string | undefined;
        let pendingProfile: unknown;
        try {
            const tokenBytes = privacyKit.decodeBase64(parsedValue.accessTokenEnc);
            accessToken = decryptString(["auth", "external", providerId, "pending_keyless", pendingKey, "token"], tokenBytes);
            if (typeof parsedValue.refreshTokenEnc === "string" && parsedValue.refreshTokenEnc.trim()) {
                const refreshBytes = privacyKit.decodeBase64(parsedValue.refreshTokenEnc);
                refreshToken = decryptString(["auth", "external", providerId, "pending_keyless", pendingKey, "refresh"], refreshBytes);
            }

            const profileBytes = privacyKit.decodeBase64(parsedValue.profileEnc);
            const profileJson = decryptString(
                ["auth", "external", providerId, "pending_keyless", pendingKey, "profile"],
                profileBytes,
            );
            pendingProfile = JSON.parse(profileJson);
        } catch {
            return reply.code(400).send({ error: "invalid-pending" });
        }

        const providerUserId = provider.getProviderUserId(pendingProfile);
        if (!providerUserId) {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }

        const existingIdentity = await db.accountIdentity.findFirst({
            where: { provider: providerId, providerUserId },
            select: { accountId: true },
        });
        if (existingIdentity) {
            const existingAccount = await db.account.findUnique({
                where: { id: existingIdentity.accountId },
                select: { publicKey: true },
            });
            if (existingAccount?.publicKey) {
                await db.repeatKey.deleteMany({ where: { key: pendingKey } });
                return reply.code(409).send({ error: "restore-required" });
            }
            await db.repeatKey.deleteMany({ where: { key: pendingKey } });
            const token = await auth.createToken(existingIdentity.accountId);
            return reply.send({ success: true, token });
        }

        if (!keylessEnv.autoProvision) {
            return reply.code(403).send({ error: "not-eligible" });
        }

        const eligibility = resolveKeylessAutoProvisionEligibility(process.env);
        if (!eligibility.ok) {
            return reply.code(403).send({ error: eligibility.error });
        }

        const usernameProvidedRaw = request.body.username?.toString().trim() || "";
        let desiredUsername: string | null = null;
        if (usernameProvidedRaw) {
            const validation = validateUsername(usernameProvidedRaw, process.env);
            if (!validation.ok) return reply.code(400).send({ error: "invalid-username" });
            desiredUsername = validation.username;
        } else {
            const required = parsedValue.usernameRequired === true;
            if (required) return reply.code(400).send({ error: "username-required" });
            const suggested = parsedValue.suggestedUsername?.toString().trim() || "";
            if (suggested) {
                const validation = validateUsername(suggested, process.env);
                if (validation.ok) desiredUsername = validation.username;
            }
        }

        if (desiredUsername) {
            const taken = await db.account.findFirst({ where: { username: desiredUsername }, select: { id: true } });
            if (taken) {
                return reply.code(409).send({ error: "username-taken" });
            }
        }

        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: eligibility.encryptionMode,
                ...(desiredUsername ? { username: desiredUsername } : {}),
            },
            select: { id: true },
        });

        const ctx = Context.create(account.id);
        try {
            await connectExternalIdentity({
                providerId,
                ctx,
                profile: pendingProfile,
                accessToken,
                refreshToken,
                preferredUsername: desiredUsername,
            });
            await db.repeatKey.deleteMany({ where: { key: pendingKey } });
        } catch (error) {
            await db.account.delete({ where: { id: account.id } }).catch(() => {});
            await db.repeatKey.deleteMany({ where: { key: pendingKey } });
            if (error instanceof Error && error.message === "not-eligible") {
                return reply.code(403).send({ error: "not-eligible" });
            }
            throw error;
        }

        const token = await auth.createToken(account.id);
        return reply.send({ success: true, token });
    });
}
