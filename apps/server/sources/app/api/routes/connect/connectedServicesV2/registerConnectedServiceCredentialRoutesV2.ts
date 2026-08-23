import { z } from "zod";
import type { Fastify } from "../../../types";
import {
  CONNECTED_SERVICE_ERROR_CODES,
  ConnectedServiceCredentialMutationSupersededV1Schema,
  ConnectedServiceIdSchema,
  SealedConnectedServiceCredentialV1Schema,
  type ConnectedServiceId,
} from "@happier-dev/protocol";

import { encodeCredentialTokenBytes } from "./credentialTokenCodec";
import { ConnectedServiceProfileIdSchema } from "./profileIdSchema";
import { type ConnectedServiceCredentialMetadataV2 } from "./credentialMetadataV2";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { mutateConnectedServiceCredential } from "../credentials/mutation";
import {
  connectedServiceCredentialMutationGuardFields,
  validateConnectedServiceCredentialMutationGuard,
} from "../credentials/mutationGuardSchema";
import { ConnectedServiceCredentialDeleteQuerySchema } from "../credentials/credentialDeleteQuerySchema";
import {
  deleteQualifiedConnectedServiceCredentialForStorageMode,
  readQualifiedConnectedServiceCredentialForLegacyProjection,
} from "../qualifiedConnectedAccounts/credentialRepository";
import {
  classifyQualifiedConnectedAccountLegacyAuthenticationMode,
  resolveLegacyQualifiedConnectedAccountService,
} from "../qualifiedConnectedAccounts/identity";

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
        ...connectedServiceCredentialMutationGuardFields,
      }).superRefine(validateConnectedServiceCredentialMutationGuard),
      response: {
        200: z.object({ success: z.literal(true), credentialRevision: z.string() }),
        400: z.unknown(),
        413: z.object({ error: z.literal("connect_credential_invalid") }),
        409: z.union([
          z.object({ error: z.literal(CONNECTED_SERVICE_ERROR_CODES.reconnectProviderIdentityMismatch) }),
          z.object({
            error: z.literal(CONNECTED_SERVICE_ERROR_CODES.credentialMutationSuperseded),
            reason: z.enum(["revision_mismatch", "refresh_lease_lost"]),
            credentialRevision: z.string().nullable(),
          }),
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
      ...(request.body.refreshLeaseOwnerId ? { refreshLeaseOwnerId: request.body.refreshLeaseOwnerId } : {}),
    });
    if (result.status === "provider_identity_mismatch") {
      return reply.code(409).send({ error: CONNECTED_SERVICE_ERROR_CODES.reconnectProviderIdentityMismatch });
    }
    if (
      result.status === "storage_mode_mismatch"
      || result.status === "revision_required"
      // The Account is at the credential ceiling. The precise typed code lives on the
      // v4 surface; this released legacy shape only carries "will not be accepted".
      || result.status === "capacity_exhausted"
    ) {
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
          credentialRevision: z.string().optional(),
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
    const service =
      resolveLegacyQualifiedConnectedAccountService(serviceId);

    const result =
      await readQualifiedConnectedServiceCredentialForLegacyProjection({
        accountId: userId,
        ref: {
          service,
          accountId: profileId,
        },
      });
    if (result.status !== "resolved") {
      if (result.status === "not_found") {
        return reply.code(404).send({
          error: "connect_credential_not_found",
        });
      }
      return reply.code(409).send({
        error: "connect_credential_unsupported_format",
      });
    }
    const snapshot = result.credential;
    if (
      snapshot.content.t !== "encrypted"
      || snapshot.authenticationModeId === null
    ) {
      return reply.code(409).send({ error: "connect_credential_unsupported_format" });
    }
    // Passive old-reader retrieval preserves the historical kind even when
    // the mode is no longer supported for current profile selection.
    const legacyMode =
      classifyQualifiedConnectedAccountLegacyAuthenticationMode({
        service,
        authenticationModeId: snapshot.authenticationModeId,
      });
    if (!legacyMode) {
      return reply.code(409).send({
        error: "connect_credential_unsupported_format",
      });
    }
    const response = {
      sealed: {
        format: "account_scoped_v1" as const,
        ciphertext: snapshot.content.c,
      },
      metadata: {
        kind: legacyMode.credentialKind,
        providerEmail:
          snapshot.metadata.providerIdentity?.email ?? null,
        providerAccountId:
          snapshot.metadata.providerIdentity?.accountId ?? null,
        expiresAt: snapshot.expiresAt,
      },
    };
    return snapshot.revisionSemantics === "revisioned"
      && snapshot.credentialRevision !== null
      ? reply.send({ ...response, credentialRevision: snapshot.credentialRevision })
      : reply.send(response);
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

    const result =
      await deleteQualifiedConnectedServiceCredentialForStorageMode({
        accountId: userId,
        ref: {
          service:
            resolveLegacyQualifiedConnectedAccountService(serviceId),
          accountId: profileId,
        },
        expectedStorageMode: "sealed",
        ...(request.query.expectedCredentialRevision
          ? { expectedCredentialRevision: request.query.expectedCredentialRevision }
          : {}),
        cleanupGroupReferences: request.query.cleanupGroupReferences === true
          || !isServerFeatureEnabledForRequest("connectedServices.accountGroups", process.env),
      });
    if (
      result.status === "storage_mode_mismatch"
      || result.status === "revision_required"
    ) {
      return reply.code(400).send({ error: "connect_credential_invalid" });
    }
    if (result.status === "not_found") return reply.code(404).send({ error: "connect_credential_not_found" });
    if (result.status === "referenced") {
      return reply.code(409).send({ error: "connect_credential_referenced_by_group" });
    }
    if (result.status === "superseded") {
      return reply.code(409).send({
        error: CONNECTED_SERVICE_ERROR_CODES.credentialMutationSuperseded,
        reason: "revision_mismatch",
        credentialRevision: result.credentialRevision,
      });
    }

    return reply.send({ success: true });
  });
}
