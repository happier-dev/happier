import { z } from "zod";
import type { Prisma } from "@prisma/client";

import type { Fastify } from "../../../types";
import { db } from "@/storage/db";
import {
  ConnectedServiceIdSchema,
  SealedConnectedServiceCredentialV1Schema,
  type ConnectedServiceId,
} from "@happier-dev/protocol";

import { encodeCredentialTokenBytes, decodeCredentialTokenString } from "./credentialTokenCodec";
import { ConnectedServiceProfileIdSchema } from "./profileIdSchema";
import { type ConnectedServiceCredentialMetadataV2, isConnectedServiceCredentialMetadataV2 } from "./credentialMetadataV2";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";

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
      }),
      response: {
        200: z.object({ success: z.literal(true) }),
        413: z.object({ error: z.literal("connect_credential_invalid") }),
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
    const prismaMetadata: Prisma.InputJsonValue = metadata;

    await db.serviceAccountToken.upsert({
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
      response: {
        200: z.object({ success: z.literal(true) }),
        404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
      },
    },
  }, async (request, reply) => {
    const userId = request.userId;
    const serviceId = request.params.serviceId satisfies ConnectedServiceId;
    const profileId = request.params.profileId;

    const existing = await db.serviceAccountToken.findUnique({
      where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
      select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: "connect_credential_not_found" });

    await db.serviceAccountToken.delete({ where: { id: existing.id } });
    return reply.send({ success: true });
  });
}
