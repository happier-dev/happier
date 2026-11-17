import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema } from '../../teams/principal.js';

export const ProjectSourceOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema,
]));
// Unlike presentation extras, an ambiguous persisted owner cannot be dropped into validity.
defineStoredReadProjection(ProjectSourceOwnerV1Schema, () => ProjectSourceOwnerV1Schema);
export type ProjectSourceOwnerV1 = z.infer<typeof ProjectSourceOwnerV1Schema>;

/** Source identity without repository, attachments or executable resource contents. */
export const ProjectSourceIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  revision: z.number().check(z.int(), z.positive()),
  name: z.string().check(z.trim(), z.minLength(1)),
  owner: z.optional(ProjectSourceOwnerV1Schema),
}));
export type ProjectSourceIdentityV1 = z.infer<typeof ProjectSourceIdentityV1Schema>;

/** Display labels from the Source read's existing admitted Team snapshot; never grants. */
export const ProjectSourceAudienceTeamV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: TeamPrincipalRefV1Schema.shape.teamId, name: z.string(),
}));
export type ProjectSourceAudienceTeamV1 = z.infer<typeof ProjectSourceAudienceTeamV1Schema>;
