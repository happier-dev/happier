import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ScmHostingRepositoryIdentityV1Schema } from './hostingRepositoryIdentity.js';

export const ScmHostingPullRequestLifecycleActionV1Schema = lazyZodSchema(() => z.enum([
    'opened', 'reopened', 'synchronize', 'closed', 'merged',
]));
export const ScmHostingPullRequestAuthorAssociationV1Schema = lazyZodSchema(() => z.enum([
    'internal', 'external', 'unknown',
]));
export type ScmHostingPullRequestAuthorAssociationV1 = z.infer<typeof ScmHostingPullRequestAuthorAssociationV1Schema>;
/** Authoritative per-occurrence Forge facts; preview admission and fork policy stay with consumers. */
export const ScmHostingPullRequestLifecycleV1Schema = lazyZodSchema(() => z.strictObject({
    id: z.string().check(z.regex(/^[1-9][0-9]*$/)),
    number: z.number().check(z.int(), z.minimum(1)),
    action: ScmHostingPullRequestLifecycleActionV1Schema,
    headSha: z.string().check(z.regex(/^[a-fA-F0-9]{40}$/)),
    headRef: z.string().check(z.minLength(1)), baseRef: z.string().check(z.minLength(1)),
    baseRepository: ScmHostingRepositoryIdentityV1Schema,
    /** A retained PR can outlive its source repository. */
    headRepository: z.nullable(ScmHostingRepositoryIdentityV1Schema),
    // Forge author ids include numeric ids, GUIDs and opaque Account ids. Some
    // lifecycle payloads identify the author without publishing a login.
    author: z.strictObject({ id: z.string().check(z.minLength(1)), login: z.nullable(z.string().check(z.minLength(1))),
        kind: z.enum(['human', 'bot', 'unsupported']) }),
    /** Providers without association evidence and retained occurrences require approval. */
    authorAssociation: z._default(ScmHostingPullRequestAuthorAssociationV1Schema, 'unknown'),
}));
export type ScmHostingPullRequestLifecycleV1 = z.infer<typeof ScmHostingPullRequestLifecycleV1Schema>;
export const ScmHostingPullRequestLifecycleV1ProtocolSchema = projectZodProtocolSchema(ScmHostingPullRequestLifecycleV1Schema);
export const ScmHostingPullRequestLifecycleActionV1ProtocolSchema = projectZodProtocolSchema(ScmHostingPullRequestLifecycleActionV1Schema);
