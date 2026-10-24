import { z } from "zod";
import type { Fastify } from "../../../types";
import { db } from "@/storage/db";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { inTx } from "@/storage/inTx";
import {
  ConnectedServiceIdSchema,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceCredentialMutationGuardV1Schema,
  ConnectedServiceCredentialMutationSuccessV1Schema,
  ConnectedServiceCredentialMutationSupersededV1Schema,
  CONNECTED_SERVICE_ERROR_CODES,
  SealedConnectedServiceCredentialV1Schema,
  type ConnectedServiceId,
} from "@happier-dev/protocol";

import { encodeCredentialTokenBytes, decodeCredentialTokenString } from "./credentialTokenCodec";
import { ConnectedServiceProfileIdSchema } from "./profileIdSchema";
import {
  type ConnectedServiceCredentialMetadataV2,
  isConnectedServiceCredentialMetadataV2,
} from "./credentialMetadataV2";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";
import { ConnectedServiceCredentialDeleteQuerySchema } from "../connectedServicesV3/credentialDeleteQuerySchema";
import { deleteConnectedServiceCredentialInTx } from "../connectedServicesV3/authGroupRepository";
import { recordConnectedServiceAccountProfileChange } from "../connectedServicesAccountProfileChange";
import { mutateConnectedServiceCredential } from "../credentials/mutation";
import { resolveConnectedServiceCredentialRevision } from "../credentials/credentialRevision";

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
      body: ConnectedServiceCredentialMutationGuardV1Schema.safeExtend({
        sealed: SealedConnectedServiceCredentialV1Schema,
        metadata: z.object({
          kind: z.enum(["oauth", "token"]),
          providerEmail: z.string().min(1).nullable().optional(),
          providerAccountId: z.string().min(1).nullable().optional(),
          providerOrganizationId: z.string().min(1).nullable().optional(),
          expiresAt: z.number().int().nonnegative().nullable().optional(),
        }).optional(),
        reconnect: z.object({
          allowProviderIdentityChange: z.boolean().optional().default(false),
        }).optional(),
      }),
      response: {
        200: ConnectedServiceCredentialMutationSuccessV1Schema,
        400: z.unknown(),
        413: z.object({ error: z.literal("connect_credential_invalid") }),
        409: z.union([
          z.object({ error: z.literal(CONNECTED_SERVICE_ERROR_CODES.reconnectProviderIdentityMismatch) }),
          ConnectedServiceCredentialMutationSupersededV1Schema,
        ]),
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
      allowProviderIdentityChange: request.body.reconnect?.allowProviderIdentityChange === true,
      ...(request.body.expectedCredentialRevision !== undefined
        ? { expectedCredentialRevision: request.body.expectedCredentialRevision }
        : {}),
      ...(request.body.refreshLeaseOwnerId
        ? { refreshLeaseOwnerId: request.body.refreshLeaseOwnerId }
        : {}),
    });
    if (result.status === "provider_identity_mismatch") {
      return reply.code(409).send({ error: CONNECTED_SERVICE_ERROR_CODES.reconnectProviderIdentityMismatch });
    }
    if (result.status === "storage_mode_mismatch") {
      return reply.code(400).send({ error: "connect_credential_invalid" });
    }
    if (result.status === "superseded") {
      return reply.code(409).send({
        error: CONNECTED_SERVICE_ERROR_CODES.credentialMutationSuperseded,
        reason: result.reason,
        credentialRevision: result.credentialRevision,
      });
    }

    return reply.send({ success: true, credentialRevision: result.credentialRevision });
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
          credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
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
    const serviceId = request.params.serviceId satisfies ConnectedServiceId;
    const profileId = request.params.profileId;

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

  app.delete("/v2/connect/:serviceId/profiles/:profileId/credential", {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        serviceId: ConnectedServiceIdSchema,
        profileId: ConnectedServiceProfileIdSchema,
      }),
      querystring: ConnectedServiceCredentialDeleteQuerySchema,
      response: {
        200: z.object({ success: z.literal(true) }),
        400: z.object({ error: z.literal("connect_credential_invalid") }),
        404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
        409: z.union([
          z.object({ error: z.literal("connect_credential_referenced_by_group") }),
          ConnectedServiceCredentialMutationSupersededV1Schema,
        ]),
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
        storageMode: "sealed",
        ...(request.query.expectedCredentialRevision
          ? { expectedCredentialRevision: request.query.expectedCredentialRevision }
          : {}),
        allowReferencedGroupCleanup: request.query.cleanupGroupReferences === true
          || !isServerFeatureEnabledForRequest("connectedServices.accountGroups", process.env),
      });
      if (deleteResult === "deleted") {
        await recordConnectedServiceAccountProfileChange(tx, { accountId: userId });
      }
      return deleteResult;
    });
    if (result === "storage_mode_mismatch") {
      return reply.code(400).send({ error: "connect_credential_invalid" });
    }
    if (result === "not_found") return reply.code(404).send({ error: "connect_credential_not_found" });
    if (result === "referenced") {
      return reply.code(409).send({ error: "connect_credential_referenced_by_group" });
    }
    if (typeof result === "object" && result.type === "superseded") {
      return reply.code(409).send({
        error: CONNECTED_SERVICE_ERROR_CODES.credentialMutationSuperseded,
        reason: "revision_mismatch",
        credentialRevision: result.credentialRevision,
      });
    }

    return reply.send({ success: true });
  });
}
