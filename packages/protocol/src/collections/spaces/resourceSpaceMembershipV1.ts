import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const Id = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
/** Manual resource associations are organization records; definitions contain only their selection mode. */
export const ResourceSpaceMembershipV1Schema = lazyZodSchema(() => z.strictObject({ mode: z.enum(['filter_or_manual', 'manual_only']) }));
export type ResourceSpaceMembershipV1 = z.infer<typeof ResourceSpaceMembershipV1Schema>;
const Resource = { resourceKind: z.literal('artifact'), resourceId: Id };
/** Closed mutation input. The authenticated Account alone owns every affected association. */
export const ResourceSpaceMembershipMutationV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
    z.strictObject({ ...Resource, operation: z.literal('add'), spaceId: Id }),
    z.strictObject({ ...Resource, operation: z.literal('remove'), spaceId: Id }),
    z.strictObject({ ...Resource, operation: z.literal('move'), spaceId: Id, sourceSpaceId: Id }),
    z.strictObject({ ...Resource, operation: z.literal('reset') }),
    z.strictObject({ resourceKind: z.literal('artifact'), operation: z.literal('delete_space'), spaceId: Id }),
]));
export type ResourceSpaceMembershipMutationV1 = z.infer<typeof ResourceSpaceMembershipMutationV1Schema>;
export const ResourceSpaceMembershipMutationResultV1Schema = lazyZodSchema(() => z.strictObject({ changed: z.boolean() }));
export const ResourceSpaceMembershipQueryV1Schema = lazyZodSchema(() => z.strictObject({ resourceKind: z.literal('artifact'), spaceId: Id }));
export const ResourceSpaceMembershipQueryResultV1Schema = lazyZodSchema(() => z.strictObject({ resourceIds: z.array(Id) }));
