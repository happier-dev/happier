import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from "../../zodRuntimePolicy.js";

import { TeamIdSchema } from "../membership.js";
import {
  TeamIdentityConnectionIdSchema,
  TeamIdentityConnectionMutationResultV1Schema,
  TeamIdentityConnectionV1Schema,
  IdentityConnectionV1Schema,
} from "./connection.js";

export const TeamIdentityWorkosConnectionCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  teamId: TeamIdSchema,
  displayName: z.optional(z.string().check(z.minLength(1), z.maxLength(256))),
}));
export type TeamIdentityWorkosConnectionCreateInputV1 = z.infer<typeof TeamIdentityWorkosConnectionCreateInputV1Schema>;
export const TeamIdentityWorkosConnectionCreateResultV1Schema = TeamIdentityConnectionMutationResultV1Schema;
export type TeamIdentityWorkosConnectionCreateResultV1 = z.infer<typeof TeamIdentityWorkosConnectionCreateResultV1Schema>;

export const TeamIdentityWorkosAdminPortalLinkCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  teamId: TeamIdSchema,
  connectionId: TeamIdentityConnectionIdSchema,
  directorySourceId: z.optional(z.string().check(z.minLength(1), z.maxLength(256))),
  intent: z.enum(["sso", "dsync"]),
}));
export type TeamIdentityWorkosAdminPortalLinkCreateInputV1 = z.infer<typeof TeamIdentityWorkosAdminPortalLinkCreateInputV1Schema>;

export const TeamIdentityWorkosAdminPortalLinkCreateResultV1Schema = lazyZodSchema(() => z.strictObject({
  url: z.url(),
}));
export type TeamIdentityWorkosAdminPortalLinkCreateResultV1 = z.infer<typeof TeamIdentityWorkosAdminPortalLinkCreateResultV1Schema>;

export const TeamIdentityWorkosReconcileInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  teamId: TeamIdSchema,
  connectionId: TeamIdentityConnectionIdSchema,
  expectedRevision: z.number().check(z.int(), z.positive()),
}));
export type TeamIdentityWorkosReconcileInputV1 = z.infer<typeof TeamIdentityWorkosReconcileInputV1Schema>;

export const TeamIdentityWorkosConnectionCandidateV1Schema = lazyZodSchema(() => z.strictObject({
  connectionId: z.string().check(z.minLength(1), z.maxLength(512)),
  displayName: z.string().check(z.minLength(1), z.maxLength(256)),
  strategy: z.string().check(z.minLength(1), z.maxLength(256)),
  status: z.string().check(z.minLength(1), z.maxLength(256)),
}));
export type TeamIdentityWorkosConnectionCandidateV1 = z.infer<typeof TeamIdentityWorkosConnectionCandidateV1Schema>;

export function identityWorkosReconcileResultV1Schema<T extends z.ZodMiniType>(connectionSchema: T) {
  return z.discriminatedUnion("outcome", [
    z.strictObject({ outcome: z.literal("setting_up"), connection: connectionSchema }),
    z.strictObject({ outcome: z.literal("connected"), connection: connectionSchema }),
    z.strictObject({ outcome: z.literal("needs_attention"), connection: connectionSchema }),
    z.strictObject({
      outcome: z.literal("selection_required"),
      connection: connectionSchema,
      candidates: z.array(TeamIdentityWorkosConnectionCandidateV1Schema).check(z.minLength(2)),
    }),
  ]);
}
export const IdentityWorkosReconcileResultV1Schema = lazyZodSchema(() => identityWorkosReconcileResultV1Schema(IdentityConnectionV1Schema));
export type IdentityWorkosReconcileResultV1 = z.infer<typeof IdentityWorkosReconcileResultV1Schema>;
export const TeamIdentityWorkosReconcileResultV1Schema = lazyZodSchema(() => identityWorkosReconcileResultV1Schema(TeamIdentityConnectionV1Schema));
export type TeamIdentityWorkosReconcileResultV1 = z.infer<typeof TeamIdentityWorkosReconcileResultV1Schema>;

export const TeamIdentityWorkosConnectionSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  teamId: TeamIdSchema,
  connectionId: TeamIdentityConnectionIdSchema,
  expectedRevision: z.number().check(z.int(), z.positive()),
  workosConnectionId: z.string().check(z.minLength(1), z.maxLength(512)),
}));
export type TeamIdentityWorkosConnectionSetInputV1 = z.infer<typeof TeamIdentityWorkosConnectionSetInputV1Schema>;
