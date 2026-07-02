import { z } from "zod";
import type { Prisma } from "@prisma/client";

import type { Fastify } from "../../../types";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
  CONNECTED_SERVICE_ERROR_CODES,
  ConnectedServiceIdSchema,
  SealedConnectedServiceCredentialV1Schema,
  type ConnectedServiceId,
} from "@happier-dev/protocol";

import { encodeCredentialTokenBytes, decodeCredentialTokenString } from "./credentialTokenCodec";
import { ConnectedServiceProfileIdSchema } from "./profileIdSchema";
import {
  type ConnectedServiceCredentialMetadataV2,
  isConnectedServiceCredentialMetadataV2,
  normalizeConnectedServiceCredentialMetadataV2,
} from "./credentialMetadataV2";
import {
  isConnectedServiceCredentialMetadataV3,
  normalizeConnectedServiceCredentialMetadataV3,
} from "../connectedServicesV3/credentialMetadataV3";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";
import { deleteConnectedServiceCredentialInTx } from "../connectedServicesV3/authGroupRepository";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { recordConnectedServiceAccountProfileChange } from "../connectedServicesAccountProfileChange";
import { isConnectedServiceProviderIdentityMismatch } from "../credentialHealthMetadata";

const DeleteConnectedServiceCredentialQuerySchema = z.object({
  cleanupGroupReferences: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, z.boolean().optional()),
}).strict();

export function registerConnectedServiceCredentialRoutesV2(
  app: Fastify,
  params: Readonly<{ credentialMaxLen: number }>,
): void {
  const credentialMaxLen = params.credentialMaxLen;

  app.post("/v2/connect/:serviceId/profiles/:profileId/credential", {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        serviceId: ConnectedServiceIdSchema,
        profileId: ConnectedServiceProfileIdSchema,
      }),
      body: z.object({
        sealed: SealedConnectedServiceCredentialV1Schema,
        metadata: z.object({
          kind: z.enum(["oauth", "token"]),
          providerEmail: z.string().min(1).nullable().optional(),
          providerAccountId: z.string().min(1).nullable().optional(),
          expiresAt: z.number().int().nonnegative().nullable().optional(),
        }).optional(),
        reconnect: z.object({
          allowProviderIdentityChange: z.boolean().optional().default(false),
        }).optional(),
      }),
      response: {
        200: z.object({ success: z.literal(true) }),
        413: z.object({ error: z.literal("connect_credential_invalid") }),
        409: z.object({ error: z.literal(CONNECTED_SERVICE_ERROR_CODES.reconnectProviderIdentityMismatch) }),
      },
    },
  }, async (request, reply) => {
    const userId = request.userId;
    const serviceId = request.params.serviceId satisfies ConnectedServiceId;
    const profileId = request.params.profileId;
    const sealed = request.body.sealed;
    const meta = request.body.metadata;

    if (sealed.ciphertext.length > credentialMaxLen) {
      return reply.code(413).send({ error: "connect_credential_invalid" });
    }

    const metadata: ConnectedServiceCredentialMetadataV2 = {
      v: 2,
      format: sealed.format,
      kind: meta?.kind ?? "oauth",
      providerEmail: meta?.providerEmail ?? null,
      providerAccountId: meta?.providerAccountId ?? null,
    };

    const existing = await db.serviceAccountToken.findUnique({
      where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
      select: { metadata: true },
    });
    const existingMetadata = isConnectedServiceCredentialMetadataV2(existing?.metadata)
      ? normalizeConnectedServiceCredentialMetadataV2(existing.metadata)
      : isConnectedServiceCredentialMetadataV3(existing?.metadata)
        ? normalizeConnectedServiceCredentialMetadataV3(existing.metadata)
        : null;
    if (
      existingMetadata
      && isConnectedServiceProviderIdentityMismatch({ existing: existingMetadata, incoming: metadata })
      && request.body.reconnect?.allowProviderIdentityChange !== true
    ) {
      return reply.code(409).send({ error: CONNECTED_SERVICE_ERROR_CODES.reconnectProviderIdentityMismatch });
    }

    const prismaMetadata: Prisma.InputJsonValue = metadata;

    await inTx(async (tx) => {
      await tx.serviceAccountToken.upsert({
        where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
        update: {
          updatedAt: new Date(),
          token: encodeCredentialTokenBytes(sealed.ciphertext),
          metadata: prismaMetadata,
          expiresAt: meta?.expiresAt ? new Date(meta.expiresAt) : null,
        },
        create: {
          accountId: userId,
          vendor: serviceId,
          profileId,
          token: encodeCredentialTokenBytes(sealed.ciphertext),
          metadata: prismaMetadata,
          expiresAt: meta?.expiresAt ? new Date(meta.expiresAt) : null,
        },
      });
      await recordConnectedServiceAccountProfileChange({ tx, accountId: userId });
    });

    return reply.send({ success: true });
  });

  app.get("/v2/connect/:serviceId/profiles/:profileId/credential", {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        serviceId: ConnectedServiceIdSchema,
        profileId: ConnectedServiceProfileIdSchema,
      }),
      response: {
        200: z.object({
          sealed: SealedConnectedServiceCredentialV1Schema,
          metadata: z.object({
            kind: z.enum(["oauth", "token"]),
            providerEmail: z.string().nullable().optional(),
            providerAccountId: z.string().nullable().optional(),
            expiresAt: z.number().int().nonnegative().nullable().optional(),
          }),
        }),
        404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
        409: z.object({ error: z.literal("connect_credential_unsupported_format") }),
      },
    },
  }, async (request, reply) => {
    const userId = request.userId;
    const serviceId = request.params.serviceId satisfies ConnectedServiceId;
    const profileId = request.params.profileId;

    const row = await db.serviceAccountToken.findUnique({
      where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
      select: { token: true, metadata: true, expiresAt: true },
    });
    if (!row) return reply.code(404).send({ error: "connect_credential_not_found" });

    if (!isConnectedServiceCredentialMetadataV2(row.metadata)) {
      return reply.code(409).send({ error: "connect_credential_unsupported_format" });
    }

    return reply.send({
      sealed: {
        format: row.metadata.format,
        ciphertext: decodeCredentialTokenString(row.token),
      },
      metadata: {
        kind: row.metadata.kind,
        providerEmail: row.metadata.providerEmail ?? null,
        providerAccountId: row.metadata.providerAccountId ?? null,
        expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
      },
    });
  });

  app.delete("/v2/connect/:serviceId/profiles/:profileId/credential", {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        serviceId: ConnectedServiceIdSchema,
        profileId: ConnectedServiceProfileIdSchema,
      }),
      querystring: DeleteConnectedServiceCredentialQuerySchema,
      response: {
        200: z.object({ success: z.literal(true) }),
        404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
        409: z.object({ error: z.literal("connect_credential_referenced_by_group") }),
      },
    },
  }, async (request, reply) => {
    const userId = request.userId;
    const serviceId = request.params.serviceId satisfies ConnectedServiceId;
    const profileId = request.params.profileId;

    const result = await inTx(async (tx) => {
      const deleteResult = await deleteConnectedServiceCredentialInTx(tx, {
        accountId: userId,
        serviceId,
        profileId,
        allowReferencedGroupCleanup: request.query.cleanupGroupReferences === true
          || !isServerFeatureEnabledForRequest("connectedServices.accountGroups", process.env),
      });
      if (deleteResult === "deleted") {
        await recordConnectedServiceAccountProfileChange({ tx, accountId: userId });
      }
      return deleteResult;
    });
    if (result === "not_found") return reply.code(404).send({ error: "connect_credential_not_found" });
    if (result === "referenced") {
      return reply.code(409).send({ error: "connect_credential_referenced_by_group" });
    }

    return reply.send({ success: true });
  });
}
