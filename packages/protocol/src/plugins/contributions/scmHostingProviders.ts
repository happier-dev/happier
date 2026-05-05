import { z } from 'zod';

import {
  ScmHostingProviderKindSchema as BaseScmHostingProviderKindSchema,
} from '../../scmPullRequests.js';

export const ScmHostingProviderKindSchema = BaseScmHostingProviderKindSchema;
export type ScmHostingProviderKind = z.infer<typeof ScmHostingProviderKindSchema>;

export const ScmHostingProviderContributionKindSchema = z.enum([
  'github',
  'gitlab',
  'bitbucket',
  'custom',
]);
export type ScmHostingProviderContributionKind =
  z.infer<typeof ScmHostingProviderContributionKindSchema>;

const SchemeWithColonSchema = z.string().trim().regex(
  /^[A-Za-z][A-Za-z0-9+.-]*:$/,
  'URL schemes must include the trailing colon',
);

export const ScmHostingProviderUrlSafetySchema = z.object({
  allowedSchemes: z.array(SchemeWithColonSchema).default(['https:']),
}).strict().default({ allowedSchemes: ['https:'] });
export type ScmHostingProviderUrlSafety =
  z.infer<typeof ScmHostingProviderUrlSafetySchema>;

export const ScmHostingProviderContributionSchema = z.object({
  id: z.string().trim().min(1),
  kind: ScmHostingProviderContributionKindSchema,
  displayName: z.string().trim().min(1),
  baseUrl: z.string().url(),
  description: z.string().trim().min(1).optional(),
  urlSafety: ScmHostingProviderUrlSafetySchema,
}).strict();
export type ScmHostingProviderContribution =
  z.infer<typeof ScmHostingProviderContributionSchema>;
