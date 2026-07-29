import { z } from "zod";

import type { Fastify } from "../../../types";
import { ConnectedServiceIdSchema, type ConnectedServiceId } from "@happier-dev/protocol";

import { listQualifiedConnectedAccounts } from "../qualifiedConnectedAccounts/credentialRepository";
import {
  resolveLegacyCredentialKindForAuthenticationMode,
  resolveLegacyQualifiedConnectedAccountService,
} from "../qualifiedConnectedAccounts/identity";

export function registerConnectedServiceProfilesRoutesV2(app: Fastify): void {
  app.get("/v2/connect/:serviceId/profiles", {
    preHandler: app.authenticate,
    schema: {
      params: z.object({ serviceId: ConnectedServiceIdSchema }),
      response: {
        200: z.object({
          serviceId: ConnectedServiceIdSchema,
          profiles: z.array(z.object({
            profileId: z.string().min(1),
            status: z.enum(["connected", "refreshing", "needs_reauth", "refresh_failed_retryable"]),
            kind: z.enum(["oauth", "token"]).nullable().optional(),
            providerEmail: z.string().nullable().optional(),
            providerAccountId: z.string().nullable().optional(),
            expiresAt: z.number().int().nonnegative().nullable().optional(),
            lastUsedAt: z.number().int().nonnegative().nullable().optional(),
          })),
        }),
      },
    },
  }, async (request, reply) => {
    const userId = request.userId;
    const serviceId = request.params.serviceId satisfies ConnectedServiceId;

    const accounts = await listQualifiedConnectedAccounts({
      accountId: userId,
      service:
        resolveLegacyQualifiedConnectedAccountService(serviceId),
    });

    const profiles = accounts.flatMap((account) => {
      const kind = account.authenticationModeId
        ? resolveLegacyCredentialKindForAuthenticationMode({
          serviceId,
          authenticationModeId: account.authenticationModeId,
        })
        : null;
      if (!kind) return [];
      return [{
        profileId: account.ref.accountId,
        status: account.status,
        kind,
        providerEmail:
          account.providerIdentity?.email ?? null,
        providerAccountId:
          account.providerIdentity?.accountId ?? null,
        expiresAt: account.expiresAt,
        lastUsedAt: account.lastUsedAt,
      }];
    });

    return reply.send({ serviceId, profiles });
  });
}
