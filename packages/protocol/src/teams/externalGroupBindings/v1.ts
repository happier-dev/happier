import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { TeamGroupIdSchema, TeamIdSchema } from '../membership.js';
import {
  TEAM_EXTERNAL_GROUP_BINDING_ACTION_IDS_V1,
  type TeamExternalGroupBindingActionIdV1,
} from './actionIds.js';

const IdSchema = lazyZodSchema(() => z.string().min(1).max(256));

export const TeamExternalGroupBindingOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('directory_source'), directorySourceId: IdSchema }).strict(),
  z.object({ kind: z.literal('identity_connection'), teamIdentityConnectionId: IdSchema }).strict(),
]));
export type TeamExternalGroupBindingOwnerV1 = z.infer<typeof TeamExternalGroupBindingOwnerV1Schema>;

export const TeamExternalGroupBindingV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  id: IdSchema,
  teamId: TeamIdSchema,
  owner: TeamExternalGroupBindingOwnerV1Schema,
  externalGroupId: IdSchema,
  mode: z.enum(['directory_created', 'native_target']),
  target: z.object({
    teamGroupId: TeamGroupIdSchema,
    name: z.string().min(1),
    archivedAt: z.number().nullable(),
  }).strict(),
}).strict());
export type TeamExternalGroupBindingV1 = z.infer<typeof TeamExternalGroupBindingV1Schema>;

const TeamExternalGroupBindingsListInputBaseV1 = {
  v: z.literal(1),
  teamId: TeamIdSchema,
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).nullable().optional(),
} as const;
export const TeamExternalGroupBindingsListInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('ownerKind', [
  z.object({
    ...TeamExternalGroupBindingsListInputBaseV1,
    ownerKind: z.literal('directory_source'),
    directorySourceId: IdSchema,
  }).strict(),
  z.object({
    ...TeamExternalGroupBindingsListInputBaseV1,
    ownerKind: z.literal('identity_connection'),
    teamIdentityConnectionId: IdSchema,
  }).strict(),
]));
export type TeamExternalGroupBindingsListInputV1 = z.infer<typeof TeamExternalGroupBindingsListInputV1Schema>;

export const TeamExternalGroupBindingsPageV1Schema = lazyZodSchema(() => z.object({
  items: z.array(TeamExternalGroupBindingV1Schema),
  nextCursor: z.string().nullable(),
}).strict());
export type TeamExternalGroupBindingsPageV1 = z.infer<typeof TeamExternalGroupBindingsPageV1Schema>;

export const TeamExternalGroupBindingSetInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  owner: TeamExternalGroupBindingOwnerV1Schema,
  externalGroupId: IdSchema,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('directory_created') }).strict(),
    z.object({ kind: z.literal('native_target'), teamGroupId: TeamGroupIdSchema }).strict(),
  ]),
}).strict());
export type TeamExternalGroupBindingSetInputV1 = z.infer<typeof TeamExternalGroupBindingSetInputV1Schema>;

export const TeamExternalGroupBindingRemoveInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  bindingId: IdSchema,
}).strict());
export type TeamExternalGroupBindingRemoveInputV1 = z.infer<typeof TeamExternalGroupBindingRemoveInputV1Schema>;

export const TeamExternalGroupBindingRemoveResultV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  outcome: z.enum(['removed', 'already_absent']),
}).strict());
export type TeamExternalGroupBindingRemoveResultV1 = z.infer<typeof TeamExternalGroupBindingRemoveResultV1Schema>;

export const TeamExternalGroupBindingTeamParamsV1Schema = lazyZodSchema(() => z.object({ teamId: TeamIdSchema }).strict());
export const TeamExternalGroupBindingParamsV1Schema = lazyZodSchema(() => z.object({
  teamId: TeamIdSchema,
  bindingId: IdSchema,
}).strict());
export const TeamExternalGroupBindingsListQueryV1Schema = lazyZodSchema(() => z.discriminatedUnion('ownerKind', [
  z.object({
    ownerKind: z.literal('directory_source'),
    directorySourceId: IdSchema,
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(512).optional(),
  }).strict(),
  z.object({
    ownerKind: z.literal('identity_connection'),
    teamIdentityConnectionId: IdSchema,
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(512).optional(),
  }).strict(),
]));
export const TeamExternalGroupBindingSetBodyV1Schema = lazyZodSchema(() => TeamExternalGroupBindingSetInputV1Schema.omit({ teamId: true }));

export { TEAM_EXTERNAL_GROUP_BINDING_ACTION_IDS_V1, type TeamExternalGroupBindingActionIdV1 } from './actionIds.js';
export const TeamExternalGroupBindingActionIdV1Schema = lazyZodSchema(() => z.enum(TEAM_EXTERNAL_GROUP_BINDING_ACTION_IDS_V1));

export const TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1: Readonly<Record<TeamExternalGroupBindingActionIdV1, string>> = Object.freeze({
  'teams.externalGroupBindings.list': '/v1/teams/:teamId/external-group-bindings',
  'teams.externalGroupBindings.set': '/v1/teams/:teamId/external-group-bindings',
  'teams.externalGroupBindings.remove': '/v1/teams/:teamId/external-group-bindings/:bindingId',
});

export const TEAM_EXTERNAL_GROUP_BINDING_ACTION_METHODS_V1 = Object.freeze({
  'teams.externalGroupBindings.list': 'GET',
  'teams.externalGroupBindings.set': 'PUT',
  'teams.externalGroupBindings.remove': 'DELETE',
} satisfies Record<TeamExternalGroupBindingActionIdV1, 'GET' | 'PUT' | 'DELETE'>);

export const TEAM_EXTERNAL_GROUP_BINDING_ACTION_INPUT_SCHEMAS_V1 = Object.freeze({
  'teams.externalGroupBindings.list': TeamExternalGroupBindingsListInputV1Schema,
  'teams.externalGroupBindings.set': TeamExternalGroupBindingSetInputV1Schema,
  'teams.externalGroupBindings.remove': TeamExternalGroupBindingRemoveInputV1Schema,
} satisfies Record<TeamExternalGroupBindingActionIdV1, z.ZodTypeAny>);

export const TEAM_EXTERNAL_GROUP_BINDING_ACTION_OUTPUT_SCHEMAS_V1 = Object.freeze({
  'teams.externalGroupBindings.list': TeamExternalGroupBindingsPageV1Schema,
  'teams.externalGroupBindings.set': TeamExternalGroupBindingV1Schema,
  'teams.externalGroupBindings.remove': TeamExternalGroupBindingRemoveResultV1Schema,
} satisfies Record<TeamExternalGroupBindingActionIdV1, z.ZodTypeAny>);
