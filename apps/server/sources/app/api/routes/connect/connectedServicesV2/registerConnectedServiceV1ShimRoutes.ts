import { z } from "zod/mini";
import type { Fastify } from "../../../types";
import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import { SealedConnectedServiceCredentialV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';

import { encodeCredentialTokenBytes } from "./credentialTokenCodec";
import { type ConnectedServiceCredentialMetadataV2 } from "./credentialMetadataV2";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";
import { mutateConnectedServiceCredential } from "../credentials/mutation";
import {
  readQualifiedConnectedServiceCredentialForLegacyProjection,
} from "../qualifiedConnectedAccounts/credentialRepository";
import {
  classifyQualifiedConnectedAccountLegacyAuthenticationMode,
  resolveLegacyQualifiedConnectedAccountService,
} from "../qualifiedConnectedAccounts/identity";

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
        metadata: z.optional(z.object({
          kind: z.enum(["oauth", "token"]),
          providerEmail: z.optional(z.nullable(z.string().check(z.minLength(1)))),
          providerAccountId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
          expiresAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        })),
      }),
      response: {
        200: z.object({ success: z.literal(true), credentialRevision: z.string() }),
        400: z.object({ error: z.literal("connect_credential_invalid") }),
        409: z.union([
          z.object({ error: z.literal("connect_reconnect_provider_identity_mismatch") }),
          z.object({ error: z.literal("connect_credential_unsupported_format") }),
        ]),
        413: z.object({ error: z.literal("connect_credential_invalid") }),
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
    if (
      result.status === "storage_mode_mismatch"
      || result.status === "revision_required"
    ) {
      return reply.code(400).send({ error: "connect_credential_invalid" });
    }
    if (result.status === "provider_identity_mismatch") return reply.code(409).send({ error: "connect_reconnect_provider_identity_mismatch" });
    if (result.status === "unsupported_format") return reply.code(409).send({ error: "connect_credential_unsupported_format" });
    if (result.status !== "written") throw new Error(`Unexpected V1 credential mutation result: ${result.status}`);

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
          credentialRevision: z.optional(z.string()),
          sealed: SealedConnectedServiceCredentialV1Schema,
          metadata: z.object({
            kind: z.enum(["oauth", "token"]),
            providerEmail: z.optional(z.nullable(z.string())),
            providerAccountId: z.optional(z.nullable(z.string())),
            expiresAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
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
    if (result.status === "not_found") {
      return reply.code(404).send({
        error: "connect_credential_not_found",
      });
    }
    if (result.status !== "resolved") {
      return reply.code(409).send({
        error: "connect_credential_unsupported_format",
      });
    }
    const snapshot = result.credential;
    if (
      snapshot.content.t !== "encrypted"
      || snapshot.authenticationModeId === null
    ) {
      return reply.code(409).send({
        error: "connect_credential_unsupported_format",
      });
    }
    const classification =
      classifyQualifiedConnectedAccountLegacyAuthenticationMode({
        service,
        authenticationModeId: snapshot.authenticationModeId,
      });
    if (!classification) {
      return reply.code(409).send({ error: "connect_credential_unsupported_format" });
    }

    const response = {
      sealed: {
        format: "account_scoped_v1" as const,
        ciphertext: snapshot.content.c,
      },
      metadata: {
        kind: classification.credentialKind,
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
}
