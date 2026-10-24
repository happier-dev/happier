import { z } from "zod";
import type { Fastify } from "../../../types";
import { db } from "@/storage/db";
import { ConnectedServiceIdSchema, SealedConnectedServiceCredentialV1Schema, type ConnectedServiceId } from "@happier-dev/protocol";

import { encodeCredentialTokenBytes, decodeCredentialTokenString } from "./credentialTokenCodec";
import { type ConnectedServiceCredentialMetadataV2, isConnectedServiceCredentialMetadataV2 } from "./credentialMetadataV2";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";
import { mutateConnectedServiceCredential } from "../credentials/mutation";
import { resolveConnectedServiceCredentialRevision } from "../credentials/credentialRevision";

export function registerConnectedServiceV1ShimRoutes(app: Fastify, params: Readonly<{ credentialMaxLen: number }>): void {
  const credentialMaxLen = params.credentialMaxLen;

  // Back-compat shims (v1), operating on profileId="default".
  app.post("/v1/connect/:vendor/register-sealed", {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        vendor: ConnectedServiceIdSchema,
      }),
      body: z.object({
        sealed: SealedConnectedServiceCredentialV1Schema,
        metadata: z.object({
          kind: z.enum(["oauth", "token"]),
          providerEmail: z.string().min(1).nullable().optional(),
          providerAccountId: z.string().min(1).nullable().optional(),
          providerOrganizationId: z.string().min(1).nullable().optional(),
          expiresAt: z.number().int().nonnegative().nullable().optional(),
        }).optional(),
      }),
      response: {
        200: z.object({ success: z.literal(true), credentialRevision: z.string() }),
        400: z.object({ error: z.literal("connect_credential_invalid") }),
        413: z.object({ error: z.literal("connect_credential_invalid") }),
        409: z.object({ error: z.literal("connect_reconnect_provider_identity_mismatch") }),
      },
    },
  }, async (request, reply) => {
    const userId = request.userId;
    const serviceId = request.params.vendor satisfies ConnectedServiceId;
    const profileId = "default";
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
      providerOrganizationId: meta?.providerOrganizationId ?? null,
    };
    const result = await mutateConnectedServiceCredential({
      accountId: userId,
      serviceId,
      profileId,
      token: encodeCredentialTokenBytes(sealed.ciphertext),
      metadata,
      expiresAt: meta?.expiresAt ? new Date(meta.expiresAt) : null,
      storageMode: "sealed",
      incomingIdentity: metadata,
      allowProviderIdentityChange: false,
    });
    if (result.status === "storage_mode_mismatch") {
      return reply.code(400).send({ error: "connect_credential_invalid" });
    }
    if (result.status === "provider_identity_mismatch") {
      return reply.code(409).send({ error: "connect_reconnect_provider_identity_mismatch" });
    }
    if (result.status !== "written") {
      throw new Error(`Unexpected V1 credential mutation result: ${result.status}`);
    }

    return reply.send({ success: true, credentialRevision: result.credentialRevision });
  });

  app.get("/v1/connect/:vendor/credential", {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        vendor: ConnectedServiceIdSchema,
      }),
      response: {
        200: z.object({
          credentialRevision: z.string(),
          sealed: SealedConnectedServiceCredentialV1Schema,
          metadata: z.object({
            kind: z.enum(["oauth", "token"]),
            providerEmail: z.string().nullable().optional(),
            providerAccountId: z.string().nullable().optional(),
            providerOrganizationId: z.string().nullable().optional(),
            expiresAt: z.number().int().nonnegative().nullable().optional(),
          }),
        }),
        404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
        409: z.object({ error: z.literal("connect_credential_unsupported_format") }),
      },
    },
  }, async (request, reply) => {
    const userId = request.userId;
    const serviceId = request.params.vendor satisfies ConnectedServiceId;
    const profileId = "default";

    const row = await db.serviceAccountToken.findUnique({
      where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
      select: { id: true, token: true, metadata: true, expiresAt: true },
    });
    if (!row) return reply.code(404).send({ error: "connect_credential_not_found" });

    if (!isConnectedServiceCredentialMetadataV2(row.metadata)) {
      return reply.code(409).send({ error: "connect_credential_unsupported_format" });
    }

    return reply.send({
      credentialRevision: resolveConnectedServiceCredentialRevision({ rowId: row.id, metadata: row.metadata }),
      sealed: {
        format: row.metadata.format,
        ciphertext: decodeCredentialTokenString(row.token),
      },
      metadata: {
        kind: row.metadata.kind,
        providerEmail: row.metadata.providerEmail ?? null,
        providerAccountId: row.metadata.providerAccountId ?? null,
        providerOrganizationId: row.metadata.providerOrganizationId ?? null,
        expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
      },
    });
  });
}
