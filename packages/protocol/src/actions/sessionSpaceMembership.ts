import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { QualifiedSessionSpaceTagV1Schema } from '../collections/spaces/collectionSpacesV1.js';

const Id = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export const SessionSpaceSettingsTargetV1Schema = lazyZodSchema(() => z.omit(QualifiedSessionSpaceTagV1Schema, { tagId: true }));
export const SessionSpaceMembershipTargetV1Schema = lazyZodSchema(() => z.strictObject({
    spaceId: Id, spaceSettingsTarget: SessionSpaceSettingsTargetV1Schema,
}));
export type SessionSpaceMembershipTargetV1 = z.infer<typeof SessionSpaceMembershipTargetV1Schema>;
export const SessionSpaceMembershipSetInputV1Schema = lazyZodSchema(() => z.strictObject({
    sessionId: Id,
    operation: z.enum(['add', 'move', 'remove']),
    spaceId: Id,
    sourceSpaceId: z.optional(Id),
    spaceSettingsTarget: SessionSpaceSettingsTargetV1Schema,
}).check(z.refine(value => value.operation === 'move' ? value.sourceSpaceId !== undefined : value.sourceSpaceId === undefined,
    { message: 'Move requires an explicit source Space; Add and Remove do not accept one' })));
export type SessionSpaceMembershipSetInputV1 = z.infer<typeof SessionSpaceMembershipSetInputV1Schema>;
export const SessionSpaceMembershipSetResultV1Schema = lazyZodSchema(() => z.strictObject({
    sessionId: Id, operation: z.enum(['add', 'move', 'remove']), spaceId: Id,
    tagIds: z.array(Id), smartMatchMayRemain: z.boolean(),
}));
export type SessionSpaceMembershipSetResultV1 = z.infer<typeof SessionSpaceMembershipSetResultV1Schema>;
