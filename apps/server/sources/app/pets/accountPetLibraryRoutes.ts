import { z } from "zod";

import {
    AccountPetCreateResponseV1Schema,
    AccountPetDeleteResponseV1Schema,
    AccountPetListResponseV1Schema,
} from "@happier-dev/protocol";

import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import type { Fastify } from "@/app/api/types";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { readPetsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";

import { listAccountPetsForAccount, readAccountPetAssetForAccount } from "./accountPetLibraryReadService";
import { createAccountPetForAccount, deleteAccountPetForAccount } from "./accountPetLibraryWriteService";

const BASE64_EXPANSION_NUMERATOR = 4;
const BASE64_EXPANSION_DENOMINATOR = 3;
const ACCOUNT_PET_CREATE_JSON_OVERHEAD_BYTES = 16 * 1024;

function resolveAccountPetCreateBodyLimitBytes(): number {
    const limits = readPetsFeatureEnv(process.env);
    const maxBinaryPayloadBytes = Math.max(
        limits.maxCanonicalSpritesheetBytes,
        limits.maxCanonicalPackageBytes,
    );
    return Math.ceil((maxBinaryPayloadBytes * BASE64_EXPANSION_NUMERATOR) / BASE64_EXPANSION_DENOMINATOR)
        + limits.maxManifestBytes
        + ACCOUNT_PET_CREATE_JSON_OVERHEAD_BYTES;
}

function sendAssetHeaders(reply: { header: (name: string, value: string) => unknown }, asset: { mediaType: string; digest: string; sizeBytes: number }) {
    reply.header("Content-Type", asset.mediaType);
    reply.header("ETag", `"${asset.digest}"`);
    reply.header("Cache-Control", "private");
    reply.header("Content-Length", String(asset.sizeBytes));
}

export function registerAccountPetLibraryRoutes(app: Fastify): void {
    const petsSyncApp = createServerFeatureGatedRouteApp(app, "pets.sync");
    const petsCompanionApp = createServerFeatureGatedRouteApp(petsSyncApp, "pets.companion");

    petsSyncApp.get("/v1/account/pets", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            response: {
                200: AccountPetListResponseV1Schema,
            },
        },
    }, async (request, reply) => {
        const pets = await listAccountPetsForAccount({ accountId: request.userId });
        return reply.send({ ok: true, pets });
    });

    petsSyncApp.post("/v1/account/pets", {
        preHandler: app.authenticate,
        bodyLimit: resolveAccountPetCreateBodyLimitBytes(),
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            body: z.unknown(),
            response: {
                201: AccountPetCreateResponseV1Schema,
                200: AccountPetCreateResponseV1Schema,
                400: AccountPetCreateResponseV1Schema,
                403: AccountPetCreateResponseV1Schema,
                500: AccountPetCreateResponseV1Schema,
            },
        },
    }, async (request, reply) => {
        const result = await createAccountPetForAccount({
            accountId: request.userId,
            request: request.body,
        });
        if (!result.ok && result.errorCode === "invalid_request") {
            return reply.code(400).send(result);
        }
        if (!result.ok && result.errorCode === "quota_exceeded") {
            return reply.code(400).send(result);
        }
        if (!result.ok && result.errorCode === "custom_pet_sync_requires_plaintext") {
            return reply.code(403).send(result);
        }
        if (!result.ok) {
            return reply.code(500).send(result);
        }
        return reply.code(201).send(result);
    });

    petsCompanionApp.get("/v1/account/pets/:petId/spritesheet", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            params: z.object({
                petId: z.string().min(1),
            }),
        },
    }, async (request, reply) => {
        const asset = await readAccountPetAssetForAccount({
            accountId: request.userId,
            petId: request.params.petId,
            assetId: null,
        });
        if (!asset) {
            return reply.code(404).send({ error: "not_found" });
        }
        sendAssetHeaders(reply, asset);
        return asset.bytes;
    });

    petsSyncApp.delete("/v1/account/pets/:petId", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            params: z.object({
                petId: z.string().min(1),
            }),
            response: {
                200: AccountPetDeleteResponseV1Schema,
                404: AccountPetDeleteResponseV1Schema,
                500: AccountPetDeleteResponseV1Schema,
            },
        },
    }, async (request, reply) => {
        const result = await deleteAccountPetForAccount({
            accountId: request.userId,
            petId: request.params.petId,
        });
        if (!result.ok && result.errorCode === "not_found") {
            return reply.code(404).send(result);
        }
        if (!result.ok) {
            return reply.code(500).send(result);
        }
        return reply.send(result);
    });

    petsCompanionApp.get("/v1/account/pets/:petId/assets/:assetId", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            params: z.object({
                petId: z.string().min(1),
                assetId: z.string().min(1),
            }),
        },
    }, async (request, reply) => {
        const asset = await readAccountPetAssetForAccount({
            accountId: request.userId,
            petId: request.params.petId,
            assetId: request.params.assetId,
        });
        if (!asset) {
            return reply.code(404).send({ error: "not_found" });
        }
        sendAssetHeaders(reply, asset);
        return asset.bytes;
    });
}
