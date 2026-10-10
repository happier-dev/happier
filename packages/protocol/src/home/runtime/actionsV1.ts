import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { RelayAccessConfigV1Schema } from '../../system/tasks/relayAccessConfigV1.js';
import { SystemTaskResultSchema } from '../../system/tasks/spec.js';
import { ServerReleaseCapabilitiesSchema } from '../../features/payload/capabilities/serverReleaseCapabilities.js';
import { HomeOwnerClaimAccountIdV1Schema } from '../governance/claim.js';
import type { HomeRuntimeActionIdV1 } from './actionIdsV1.js';
export { HOME_RUNTIME_ACTION_IDS_V1, isHomeRuntimeActionIdV1, type HomeRuntimeActionIdV1 } from './actionIdsV1.js';

const Id = lazyZodSchema(() => z.string().trim().min(1));
const Empty = lazyZodSchema(() => z.object({}).strict());
const RuntimeTarget = lazyZodSchema(() => z.object({
  channel: z.enum(['stable', 'preview', 'dev']), mode: z.enum(['user', 'system']),
}).strict());
const PersonalHomePurpose = lazyZodSchema(() => z.object({
  kind: z.literal('personal-home'), canonicalServerUrl: z.string().trim().url(),
}).strict());
const RuntimeInput = lazyZodSchema(() => z.object({
  runtimeTarget: RuntimeTarget.optional(), purpose: PersonalHomePurpose.optional(),
  anonymousSignupEnabled: z.boolean().optional(),
  expectedPersonalHomeState: z.object({
    installed: z.boolean(), canonicalServerUrl: z.string().nullable(), dataPresent: z.boolean(),
  }).strict().optional(),
}).strict());
const PersonalHomeInput = lazyZodSchema(() => z.object({
  runtimeTarget: RuntimeTarget.optional(), purpose: PersonalHomePurpose,
}).strict());
const Unavailable = lazyZodSchema(() => z.object({ status: z.literal('unavailable'), reason: Id }).strict());
const Started = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('task_started'), taskId: Id }).strict(),
  z.object({ status: z.literal('completed'), taskId: Id, result: SystemTaskResultSchema }).strict(),
  z.object({ status: z.literal('outcome_unknown'), taskId: Id.optional() }).strict(), Unavailable,
]));
const Completed = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('completed') }).strict(), Unavailable,
]));
const Picked = lazyZodSchema(() => z.union([z.object({ path: Id.nullable() }).strict(), Unavailable]));
export const HomeRuntimeRestartInputV1Schema = lazyZodSchema(() => z.object({
  machineId: Id, channel: z.enum(['stable', 'preview', 'dev']).optional(), mode: z.enum(['user', 'system']).optional(),
}).strict());
export const HomeRuntimeRestartOutputV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('completed'), taskId: Id, result: SystemTaskResultSchema }).strict(),
  z.object({ status: z.literal('outcome_unknown'), taskId: Id.optional() }).strict(), Unavailable,
]));
export type HomeRuntimeRestartInputV1 = z.output<typeof HomeRuntimeRestartInputV1Schema>;
export type HomeRuntimeRestartOutputV1 = z.output<typeof HomeRuntimeRestartOutputV1Schema>;

/** Closed Action inputs adapt existing local task options; SSH credentials never enter this family. */
export const HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1 = {
  'relay.access.status': Empty,
  'relay.access.configure': lazyZodSchema(() => z.object({
    providerId: z.enum(['localOnly', 'lan', 'tailscaleServe', 'tailscaleFunnel', 'cloudflareNamed']),
    config: RelayAccessConfigV1Schema, upstreamUrl: z.string().trim().min(1).nullable().optional(),
  }).strict().refine(input => input.providerId === input.config.providerId, { path: ['providerId'], message: 'Relay provider must match configuration' })),
  'relay.access.disable': Empty,
  'relay.runtime.status': RuntimeInput,
  'relay.runtime.install_or_update': RuntimeInput,
  'relay.runtime.start': RuntimeInput,
  'relay.runtime.stop': RuntimeInput,
  'relay.runtime.restart': RuntimeInput,
  'relay.runtime.uninstall': RuntimeInput,
  'relay.runtime.personal_home.inspect': PersonalHomeInput,
  'relay.runtime.personal_home.backup': lazyZodSchema(() => PersonalHomeInput.extend({
    personalHomeOperation: z.object({ outputPath: Id.optional() }).strict().optional(),
  }).strict()),
  'relay.runtime.personal_home.verify_backup': lazyZodSchema(() => PersonalHomeInput.extend({
    personalHomeOperation: z.object({ archivePath: Id }).strict(),
  }).strict()),
  'relay.runtime.personal_home.restore': lazyZodSchema(() => PersonalHomeInput.extend({
    personalHomeOperation: z.object({ archivePath: Id, confirmOverwrite: z.literal(true).optional(), expectedHomeServerIdentityId: Id.optional() }).strict(),
  }).strict()),
  'relay.runtime.personal_home.recover_restore': PersonalHomeInput,
  'relay.runtime.personal_home.erase': PersonalHomeInput,
  'relay.runtime.personal_home.claim': lazyZodSchema(() => PersonalHomeInput.extend({
    personalHomeOperation: z.object({ accountId: HomeOwnerClaimAccountIdV1Schema }).strict(),
  }).strict()),
  'relay.runtime.personal_home.relocate': lazyZodSchema(() => z.object({
    hostId: Id, expectedRevision: z.union([z.number().int().nonnegative(), z.literal('absent')]),
    sourceServerId: Id, operationId: Id, sourceDescriptorRevision: z.number().int().positive(),
    recoveryAction: z.enum(['finish_move', 'return_to_source']).optional(),
  }).strict()),
  'relay.runtime.personal_home.choose_archive': Empty,
  'relay.runtime.personal_home.choose_backup_destination': Empty,
  'relay.runtime.open_path': lazyZodSchema(() => z.object({ path: Id }).strict()),
  'relay.runtime.reveal_output': lazyZodSchema(() => z.object({ path: Id }).strict()),
  'home.runtime.get': lazyZodSchema(() => z.object({ force: z.boolean().optional() }).strict()),
  'home.runtime.restart': HomeRuntimeRestartInputV1Schema,
} as const;
export const HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1 = {
  'relay.access.status': Started, 'relay.access.configure': Started, 'relay.access.disable': Started,
  'relay.runtime.status': Started, 'relay.runtime.install_or_update': Started,
  'relay.runtime.start': Started, 'relay.runtime.stop': Started, 'relay.runtime.restart': Started, 'relay.runtime.uninstall': Started,
  'relay.runtime.personal_home.inspect': Started, 'relay.runtime.personal_home.backup': Started,
  'relay.runtime.personal_home.verify_backup': Started, 'relay.runtime.personal_home.restore': Started,
  'relay.runtime.personal_home.recover_restore': Started, 'relay.runtime.personal_home.erase': Started,
  'relay.runtime.personal_home.claim': Started, 'relay.runtime.personal_home.relocate': Started,
  'relay.runtime.personal_home.choose_archive': Picked, 'relay.runtime.personal_home.choose_backup_destination': Picked,
  'relay.runtime.open_path': Completed, 'relay.runtime.reveal_output': Completed,
  'home.runtime.get': lazyZodSchema(() => z.union([
    z.object({ status: z.literal('ready'), serverRelease: ServerReleaseCapabilitiesSchema.nullable() }).strict(), Unavailable,
  ])),
  'home.runtime.restart': HomeRuntimeRestartOutputV1Schema,
} as const;
export type HomeRuntimeActionInputByIdV1 = {
  [Id in HomeRuntimeActionIdV1]: z.output<(typeof HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1)[Id]>;
};
export type HomeRuntimeActionRequestV1 = {
  [Id in HomeRuntimeActionIdV1]: Readonly<{ actionId: Id; input: HomeRuntimeActionInputByIdV1[Id] }>;
}[HomeRuntimeActionIdV1];

export function parseHomeRuntimeActionRequestV1(actionId: HomeRuntimeActionIdV1, input: unknown): HomeRuntimeActionRequestV1 {
  switch (actionId) {
    case 'relay.access.status': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.access.configure': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.access.disable': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.status': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.install_or_update': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.start': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.stop': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.restart': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.uninstall': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.personal_home.inspect': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.personal_home.backup': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.personal_home.verify_backup': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.personal_home.restore': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.personal_home.recover_restore': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.personal_home.erase': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.personal_home.claim': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.personal_home.relocate': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.personal_home.choose_archive': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.personal_home.choose_backup_destination': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.open_path': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'relay.runtime.reveal_output': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'home.runtime.get': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'home.runtime.restart': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
  }
}
