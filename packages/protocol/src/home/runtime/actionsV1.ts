import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { RelayAccessConfigV1Schema } from '../../system/tasks/relayAccessConfigV1.js';
import { SystemTaskResultSchema } from '../../system/tasks/spec.js';
import { ServerReleaseCapabilitiesSchema } from '../../features/payload/capabilities/serverReleaseCapabilities.js';
import { HomeOwnerClaimAccountIdV1Schema } from '../governance/claim.js';
import type { HomeRuntimeActionIdV1 } from './actionIdsV1.js';
export { HOME_RUNTIME_ACTION_IDS_V1, isHomeRuntimeActionIdV1, type HomeRuntimeActionIdV1 } from './actionIdsV1.js';

const Id = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const Empty = lazyZodSchema(() => z.strictObject({}));
const RuntimeTarget = lazyZodSchema(() => z.strictObject({
  channel: z.enum(['stable', 'preview', 'dev']), mode: z.enum(['user', 'system']),
}));
const PersonalHomePurpose = lazyZodSchema(() => z.strictObject({
  kind: z.literal('personal-home'), canonicalServerUrl: z.string().check(z.trim(), z.url()),
}));
const RuntimeInput = lazyZodSchema(() => z.strictObject({
  runtimeTarget: z.optional(RuntimeTarget), purpose: z.optional(PersonalHomePurpose),
  anonymousSignupEnabled: z.optional(z.boolean()),
  expectedPersonalHomeState: z.optional(z.strictObject({
    installed: z.boolean(), canonicalServerUrl: z.nullable(z.string()), dataPresent: z.boolean(),
  })),
}));
const PersonalHomeInput = lazyZodSchema(() => z.strictObject({
  runtimeTarget: z.optional(RuntimeTarget), purpose: PersonalHomePurpose,
}));
const Unavailable = lazyZodSchema(() => z.strictObject({ status: z.literal('unavailable'), reason: Id }));
const Started = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('task_started'), taskId: Id }),
  z.strictObject({ status: z.literal('completed'), taskId: Id, result: SystemTaskResultSchema }),
  z.strictObject({ status: z.literal('outcome_unknown'), taskId: z.optional(Id) }), Unavailable,
]));
const Completed = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('completed') }), Unavailable,
]));
const Picked = lazyZodSchema(() => z.union([z.strictObject({ path: z.nullable(Id) }), Unavailable]));
export const HomeRuntimeRestartInputV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: Id, channel: z.optional(z.enum(['stable', 'preview', 'dev'])), mode: z.optional(z.enum(['user', 'system'])),
}));
export const HomeRuntimeRestartOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('completed'), taskId: Id, result: SystemTaskResultSchema }),
  z.strictObject({ status: z.literal('outcome_unknown'), taskId: z.optional(Id) }), Unavailable,
]));
export type HomeRuntimeRestartInputV1 = z.output<typeof HomeRuntimeRestartInputV1Schema>;
export type HomeRuntimeRestartOutputV1 = z.output<typeof HomeRuntimeRestartOutputV1Schema>;

/** Closed Action inputs adapt existing local task options; SSH credentials never enter this family. */
export const HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1 = {
  'relay.access.status': Empty,
  'relay.access.configure': lazyZodSchema(() => z.strictObject({
    config: RelayAccessConfigV1Schema, upstreamUrl: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  })),
  'relay.access.disable': Empty,
  'relay.runtime.status': RuntimeInput,
  'relay.runtime.install_or_update': RuntimeInput,
  'relay.runtime.start': RuntimeInput,
  'relay.runtime.stop': RuntimeInput,
  'relay.runtime.restart': RuntimeInput,
  'relay.runtime.uninstall': RuntimeInput,
  'relay.runtime.personal_home.inspect': PersonalHomeInput,
  'relay.runtime.personal_home.backup': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PersonalHomeInput, {
    personalHomeOperation: z.optional(z.strictObject({ outputPath: z.optional(Id) })),
  }))),
  'relay.runtime.personal_home.verify_backup': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PersonalHomeInput, {
    personalHomeOperation: z.strictObject({ archivePath: Id }),
  }))),
  'relay.runtime.personal_home.restore': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PersonalHomeInput, {
    personalHomeOperation: z.strictObject({ archivePath: Id, confirmOverwrite: z.optional(z.literal(true)), expectedHomeServerIdentityId: z.optional(Id) }),
  }))),
  'relay.runtime.personal_home.recover_restore': PersonalHomeInput,
  'relay.runtime.personal_home.erase': PersonalHomeInput,
  'relay.runtime.personal_home.claim': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PersonalHomeInput, {
    personalHomeOperation: z.strictObject({ accountId: HomeOwnerClaimAccountIdV1Schema }),
  }))),
  'relay.runtime.personal_home.relocate': lazyZodSchema(() => z.strictObject({
    hostId: Id, expectedRevision: z.union([z.number().check(z.int(), z.nonnegative()), z.literal('absent')]),
    sourceServerId: Id, operationId: Id, sourceDescriptorRevision: z.number().check(z.int(), z.positive()),
    recoveryAction: z.optional(z.enum(['finish_move', 'return_to_source'])),
  })),
  'relay.runtime.personal_home.choose_archive': Empty,
  'relay.runtime.personal_home.choose_backup_destination': Empty,
  'relay.runtime.open_path': lazyZodSchema(() => z.strictObject({ path: Id })),
  'relay.runtime.reveal_output': lazyZodSchema(() => z.strictObject({ path: Id })),
  'relay.runtime.task.cancel': lazyZodSchema(() => z.strictObject({ taskId: Id })),
  'home.runtime.get': lazyZodSchema(() => z.strictObject({ force: z.optional(z.boolean()) })),
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
  'relay.runtime.task.cancel': lazyZodSchema(() => z.union([
    z.strictObject({ status: z.enum(['cancellation_requested', 'already_settled']), taskId: Id }),
    z.strictObject({ status: z.literal('outcome_unknown'), taskId: Id }), Unavailable,
  ])),
  'home.runtime.get': lazyZodSchema(() => z.union([
    z.strictObject({ status: z.literal('ready'), serverRelease: z.nullable(ServerReleaseCapabilitiesSchema),
      // Older answering clients omit this diagnostic; omission never means ready.
      searchReadiness: z.optional(z.enum(['ready', 'indexing', 'unavailable', 'unknown'])),
    }), Unavailable,
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
    case 'relay.runtime.task.cancel': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'home.runtime.get': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'home.runtime.restart': return { actionId, input: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
  }
}
