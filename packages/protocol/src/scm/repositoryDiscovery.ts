import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ScmHostingRepositoryIdentityV1Schema } from './hostingRepositoryIdentity.js';
import { ScmHostingRepositoryResolveAddressResponseV1Schema } from './repositoryClone.js';

/** One explicit folder search; results are observations, never registered checkouts. */
export const ScmRepositoryDiscoverRequestSchema = lazyZodSchema(() => z.strictObject({
  cwd: z.string().check(z.minLength(1)),
  repositories: z.array(ScmHostingRepositoryIdentityV1Schema),
}));
export type ScmRepositoryDiscoverRequest = z.infer<typeof ScmRepositoryDiscoverRequestSchema>;

export const ScmRepositoryDiscoverMatchSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.minLength(1)),
  repositoryIdentity: ScmHostingRepositoryIdentityV1Schema,
}));
export type ScmRepositoryDiscoverMatch = z.infer<typeof ScmRepositoryDiscoverMatchSchema>;

/** Native filesystem and SCM codes remain intact, including platform-specific errors. */
export const ScmRepositoryDiscoverFailureSchema = lazyZodSchema(() => z.strictObject({
  success: z.literal(false), errorCode: z.string().check(z.minLength(1)), error: z.string(),
}));
export const ScmRepositoryDiscoverResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    success: z.literal(true),
    matches: z.array(ScmRepositoryDiscoverMatchSchema),
    skipped: z.array(z.union([
      z.strictObject({ rootPath: z.string(), errorCode: z.string().check(z.minLength(1)), error: z.string() }),
      z.strictObject({ rootPath: z.string(), origin: ScmHostingRepositoryResolveAddressResponseV1Schema }),
    ])),
  }),
  ScmRepositoryDiscoverFailureSchema,
]));
export type ScmRepositoryDiscoverResponse = z.infer<typeof ScmRepositoryDiscoverResponseSchema>;
