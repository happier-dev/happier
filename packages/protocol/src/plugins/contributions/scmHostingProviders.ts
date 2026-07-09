import { z } from 'zod';

import {
  ScmHostingProviderKindSchema as BaseScmHostingProviderKindSchema,
  ScmHostingProviderCapabilitiesSchema,
} from '../../scm/pullRequests.js';

export const ScmHostingProviderKindSchema = BaseScmHostingProviderKindSchema;
export type ScmHostingProviderKind = z.infer<typeof ScmHostingProviderKindSchema>;

export const ScmHostingProviderContributionKindSchema = z.enum([
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
  'custom',
]);
export type ScmHostingProviderContributionKind =
  z.infer<typeof ScmHostingProviderContributionKindSchema>;

const SchemeWithColonSchema = z.string().trim().regex(
  /^[A-Za-z][A-Za-z0-9+.-]*:$/,
  'URL schemes must include the trailing colon',
);

const HttpsUrlSchema = z.string().url().refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'URL must use https');

export const ScmHostingProviderUrlSafetySchema = z.object({
  allowedSchemes: z.array(SchemeWithColonSchema).default(['https:']),
  allowedBaseUrls: z.array(z.string().url()).default([]),
  allowedOrigins: z.array(z.string().url()).default([]),
}).strict().default({ allowedSchemes: ['https:'], allowedBaseUrls: [], allowedOrigins: [] });
export type ScmHostingProviderUrlSafety =
  z.infer<typeof ScmHostingProviderUrlSafetySchema>;

export const ScmHostingProviderRemoteHostMatchersSchema = z.object({
  exactHosts: z.array(z.string().trim().min(1)).default([]),
  suffixHosts: z.array(z.string().trim().min(1)).default([]),
}).strict().default({ exactHosts: [], suffixHosts: [] });
export type ScmHostingProviderRemoteHostMatchers =
  z.infer<typeof ScmHostingProviderRemoteHostMatchersSchema>;

export const ScmHostingProviderAuthReadinessSchema = z.object({
  materializationKinds: z.array(z.string().trim().min(1)).default([]),
  credentialPayloadKind: z.string().trim().min(1).optional(),
  cloudOnly: z.boolean().default(false),
}).strict().default({ materializationKinds: [], cloudOnly: false });
export type ScmHostingProviderAuthReadiness =
  z.infer<typeof ScmHostingProviderAuthReadinessSchema>;

export const ScmHostingProviderContributionSchema = z.object({
  id: z.string().trim().min(1),
  kind: ScmHostingProviderContributionKindSchema,
  displayName: z.string().trim().min(1),
  baseUrl: HttpsUrlSchema,
  description: z.string().trim().min(1).optional(),
  remoteHostMatchers: ScmHostingProviderRemoteHostMatchersSchema,
  urlSafety: ScmHostingProviderUrlSafetySchema,
  capabilities: ScmHostingProviderCapabilitiesSchema,
  auth: ScmHostingProviderAuthReadinessSchema,
}).strict();
export type ScmHostingProviderContribution =
  z.input<typeof ScmHostingProviderContributionSchema>;
