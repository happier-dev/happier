import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { LaunchProfileIdV2Schema } from './v2/profileId.js';
import { LaunchProfilePlacementPreferenceV1Schema, LaunchProfileCheckoutPreferenceV1Schema } from './launchPreferencesV1.js';
import { LaunchProfileV2Schema } from './v2/schema.js';
import { EnvVarRequirementSchema } from './environmentVariables.js';
import { ProfileRecordIdV1Schema, ProfileRecordV1Schema, ProfileReferenceGuardRevisionV1Schema, ProfileRowRevisionV1Schema,
  ProfileSecretBindingOverridesV1Schema, ProfileLegacyCloneSourceV1Schema } from './profileRecordSchemaV1.js';
import { ArtifactRevisionV1Schema } from '../artifacts/artifactActionsV1.js';
import { ArtifactCallerAccessV1Schema } from '../artifacts/artifactAccessV1.js';
import type { ProfileOperations } from './profileOperations.js';
import { LaunchProfileListItemV1Schema } from './listProjection.js';
import { AiLaunchProfileV1Schema, isHistoricalBuiltInAiLaunchProfileIdV1 } from './read.js';
import type { ActionExecuteFailure, ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import {
  DaemonProviderProfileMigrationPreviewRequestV1Schema, DaemonProviderProfileMigrationPreviewResponseV1Schema,
  DaemonProviderProfileMigrationConfirmRequestV1Schema, DaemonProviderProfileMigrationConfirmResponseV1Schema,
  DaemonProviderProfileMigrationConflictConfirmRequestV1Schema, DaemonProviderProfileMigrationConflictConfirmResponseV1Schema,
} from '../rpc/providers.js';
import { SHARED_SAVED_SECRET_REF_V1_PREFIX, formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { PROFILE_ACTION_IDS_V1, type ProfileActionIdV1 } from './profileActionIdsV1.js';
import { PromptStackIntentV1Schema } from '../prompts/library/promptStacksV1.js';
export { PROFILE_ACTION_IDS_V1, isProfileActionIdV1, type ProfileActionIdV1 } from './profileActionIdsV1.js';

export const ProfileActionIdV1Schema = lazyZodSchema(() => z.enum(PROFILE_ACTION_IDS_V1));

const Address = lazyZodSchema(() => z.strictObject({ id: ProfileRecordIdV1Schema }));
const EditAddress = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(Address, { expectedRevision: ProfileRowRevisionV1Schema })));
const CapturedRowAddress = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(Address, { expectedRevision: ProfileReferenceGuardRevisionV1Schema })));
const EditorInput = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(CapturedRowAddress, {
  expectedArtifactRevision: z.optional(ArtifactRevisionV1Schema),
})));
const RowUpdatedResult = lazyZodSchema(() => z.strictObject({ status: z.literal('updated'), id: ProfileRecordIdV1Schema,
  revision: ProfileRowRevisionV1Schema }));
const RefusalResult = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('conflict'), id: ProfileRecordIdV1Schema, revision: z.number().check(z.int(), z.minimum(-1)) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.string().check(z.minLength(1)) }),
  z.strictObject({ status: z.literal('invalid'), reason: z.enum([
    'duplicate-id', 'duplicate-name', 'profile-not-found', 'read-only', 'legacy-creation-unsupported', 'invalid-definition',
    'entry_conflict', 'entry_not_found', 'invalid_parameters',
  ]), id: z.optional(ProfileRecordIdV1Schema) }),
]));
const MutationResult = lazyZodSchema(() => z.union([RowUpdatedResult, RefusalResult]));
const DeleteResult = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RowUpdatedResult, { authoringMemoryCleanup: z.optional(z.strictObject({
    status: z.literal('unavailable'), reason: z.literal('authoring_memory_cleanup_failed'),
  })) })),
  RefusalResult,
]));
const EnabledResult = lazyZodSchema(() => z.union([RowUpdatedResult, RefusalResult,
  z.strictObject({ status: z.literal('preference-updated'), id: ProfileRecordIdV1Schema, enabled: z.boolean(),
    settingsVersion: ProfileRowRevisionV1Schema }),
]));
const ReadResult = lazyZodSchema(() => {
  const opened = z.strictObject({ status: z.literal('present'), profile: AiLaunchProfileV1Schema });
  const membership = { record: ProfileRecordV1Schema, revision: ProfileRowRevisionV1Schema };
  const artifact = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(opened, { location: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ArtifactRevisionV1Schema, {
    kind: z.literal('artifact'), artifactId: z.string().check(z.minLength(1)), access: ArtifactCallerAccessV1Schema,
  })) }));
  return z.union([
    RefusalResult,
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(opened, { location: z.strictObject({ kind: z.literal('builtin') }) })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(opened, { ...membership, location: z.strictObject({
      kind: z.literal('account_row'), revision: ProfileRowRevisionV1Schema,
    }) })),
    artifact,
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(artifact, membership)),
  ]);
});
const SearchResult = lazyZodSchema(() => z.union([MutationResult,
  z.strictObject({ status: z.literal('listed'), records: z.array(z.strictObject({ record: ProfileRecordV1Schema,
    revision: ProfileRowRevisionV1Schema })), profiles: z.array(z.strictObject({
      profile: LaunchProfileListItemV1Schema,
      location: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('builtin') }),
        z.strictObject({ kind: z.literal('account_row'), revision: ProfileRowRevisionV1Schema }),
        z.strictObject({ kind: z.literal('artifact'), artifactId: z.string().check(z.minLength(1)),
          headerVersion: ProfileRowRevisionV1Schema, bodyVersion: ProfileRowRevisionV1Schema }),
      ]),
    })), complete: z.literal(true) }),
]));
const CreateInput = lazyZodSchema(() => z.strictObject({
  profile: LaunchProfileV2Schema, expectedRevision: z.literal('absent'),
}));
const SaveInput = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(CapturedRowAddress, {
  profile: AiLaunchProfileV1Schema,
  secretBindings: z.optional(ProfileSecretBindingOverridesV1Schema),
  skillSeeds: z.optional(z.array(z.string().check(z.minLength(1)))),
  legacyCloneSource: z.optional(ProfileLegacyCloneSourceV1Schema),
  expectedArtifactRevision: z.optional(ArtifactRevisionV1Schema),
})).check(z.superRefine((input, context) => {
  if (input.id !== input.profile.id) context.addIssue({ code: 'custom', path: ['profile', 'id'], message: 'Profile identity must match addressed row' });
})));
const SelectInput = lazyZodSchema(() => z.strictObject({ id: z.nullable(ProfileRecordIdV1Schema) }));
// The incumbent favorites preference uses '' for the machine environment option.
const FavoriteId = lazyZodSchema(() => z.union([ProfileRecordIdV1Schema, z.literal('')]));
const FavoriteInput = lazyZodSchema(() => z.strictObject({ id: FavoriteId, favorite: z.boolean() }));
const DraftId = lazyZodSchema(() => z.string().check(z.minLength(1)));
const EditorResult = lazyZodSchema(() => z.union([MutationResult,
  z.strictObject({ status: z.literal('opened'), id: ProfileRecordIdV1Schema, draftId: DraftId }),
]));
const SelectResult = lazyZodSchema(() => z.union([MutationResult,
  z.strictObject({ status: z.literal('selected'), id: z.nullable(ProfileRecordIdV1Schema) }),
]));
const FavoriteResult = lazyZodSchema(() => z.union([MutationResult,
  z.strictObject({ status: z.literal('updated'), id: FavoriteId, favorite: z.boolean() }),
]));
const DiscardInput = lazyZodSchema(() => z.strictObject({ draftId: DraftId }));
const DiscardResult = lazyZodSchema(() => z.union([MutationResult,
  z.strictObject({ status: z.literal('discarded'), draftId: DraftId }),
]));
const ResourceId = lazyZodSchema(() => z.string().check(z.refine(resourceId => {
  // This field carries the immutable Resource id, not its encoded binding reference.
  if (resourceId.startsWith(SHARED_SAVED_SECRET_REF_V1_PREFIX)) return false;
  try { formatSharedSavedSecretRefV1(resourceId); return true; }
  catch { return false; }
}, 'Saved-secret Resource id must fit its canonical shared reference')));
const SecretSelection = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('resource'), resourceId: ResourceId,
    expectedResourceRevision: ProfileRowRevisionV1Schema }),
]));
const NamedSecretSelection = lazyZodSchema(() => z.strictObject({
  envName: EnvVarRequirementSchema.shape.name, selection: SecretSelection,
}));

/** Strict semantic ingress; saved credentials cross this boundary only as captured references. */
export const PROFILE_ACTION_INPUT_SCHEMAS_V1 = {
  'launch_profiles.read': Address,
  'launch_profiles.search': lazyZodSchema(() => z.strictObject({ query: z.optional(z.string()) })),
  'launch_profiles.select': SelectInput,
  'launch_profiles.create': CreateInput,
  'launch_profiles.edit': EditorInput,
  'launch_profiles.save': SaveInput,
  'launch_profiles.duplicate': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(CapturedRowAddress, {
    placement: z.optional(LaunchProfilePlacementPreferenceV1Schema), checkout: z.optional(LaunchProfileCheckoutPreferenceV1Schema),
    newProfileId: LaunchProfileIdV2Schema, name: LaunchProfileV2Schema.shape.name,
    now: z.number().check(z.nonnegative()),
  }))),
  'launch_profiles.enabled.set': lazyZodSchema(() => z.union([
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(EditAddress, { enabled: z.boolean() })),
    z.strictObject({ subject: z.strictObject({ kind: z.literal('builtin'),
      id: ProfileRecordIdV1Schema.check(z.refine(isHistoricalBuiltInAiLaunchProfileIdV1, 'Subject must be an incumbent builtin Profile')),
    }), expectedSettingsVersion: ProfileRowRevisionV1Schema, enabled: z.boolean() }),
  ])),
  'launch_profiles.favorite.set': FavoriteInput,
  'launch_profiles.delete': EditAddress,
  'launch_profiles.prompt_stack.update': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(CapturedRowAddress, { intent: PromptStackIntentV1Schema }))),
  'launch_profiles.secrets.select': lazyZodSchema(() => z.union([
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(CapturedRowAddress, NamedSecretSelection.shape)),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(CapturedRowAddress, { selections: z.array(NamedSecretSelection) })),
  ])),
  'launch_profiles.legacy.preview': DaemonProviderProfileMigrationPreviewRequestV1Schema,
  'launch_profiles.legacy.convert': DaemonProviderProfileMigrationConfirmRequestV1Schema,
  'launch_profiles.legacy.resolve_conflict': DaemonProviderProfileMigrationConflictConfirmRequestV1Schema,
  'launch_profiles.draft.discard': DiscardInput,
} as const;

export const PROFILE_ACTION_OUTPUT_SCHEMAS_V1 = {
  'launch_profiles.read': ReadResult,
  'launch_profiles.search': SearchResult,
  'launch_profiles.select': SelectResult,
  'launch_profiles.create': MutationResult,
  'launch_profiles.edit': EditorResult,
  'launch_profiles.save': MutationResult,
  'launch_profiles.duplicate': MutationResult,
  'launch_profiles.enabled.set': EnabledResult,
  'launch_profiles.favorite.set': FavoriteResult,
  'launch_profiles.delete': DeleteResult,
  'launch_profiles.prompt_stack.update': MutationResult,
  'launch_profiles.secrets.select': MutationResult,
  'launch_profiles.legacy.preview': DaemonProviderProfileMigrationPreviewResponseV1Schema,
  'launch_profiles.legacy.convert': DaemonProviderProfileMigrationConfirmResponseV1Schema,
  'launch_profiles.legacy.resolve_conflict': DaemonProviderProfileMigrationConflictConfirmResponseV1Schema,
  'launch_profiles.draft.discard': DiscardResult,
} as const;

export type ProfileActionInputByIdV1 = {
  readonly [TId in ProfileActionIdV1]: z.output<(typeof PROFILE_ACTION_INPUT_SCHEMAS_V1)[TId]>;
};
export type ProfileActionOutputByIdV1 = {
  readonly [TId in ProfileActionIdV1]: z.output<(typeof PROFILE_ACTION_OUTPUT_SCHEMAS_V1)[TId]>;
};
export type ProfileActionRequestV1 = {
  [TId in ProfileActionIdV1]: Readonly<{ actionId: TId; input: ProfileActionInputByIdV1[TId] }>;
}[ProfileActionIdV1];

/** Pair the discriminant with its schema before crossing the host execution port. */
export function parseProfileActionRequestV1(actionId: ProfileActionIdV1, input: unknown): ProfileActionRequestV1 {
  switch (actionId) {
    case 'launch_profiles.read': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.search': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.select': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.create': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.edit': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.save': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.duplicate': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.enabled.set': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.favorite.set': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.delete': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.prompt_stack.update': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.secrets.select': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.legacy.preview': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.legacy.convert': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.legacy.resolve_conflict': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'launch_profiles.draft.discard': return { actionId, input: PROFILE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
  }
}

type HostOperation<TId extends ProfileActionIdV1> = (input: ProfileActionInputByIdV1[TId], context: ActionExecutorContext)
  => Promise<ProfileActionOutputByIdV1[TId] | ActionExecuteFailure>;
export type ProfileActionHostPortsV1 = Readonly<{
  operations: ProfileOperations | (() => Promise<ProfileOperations>);
  readSkillLibrary?: (signal?: AbortSignal) => Promise<readonly Readonly<{ id: string; name: string }>[] >;
  select?: HostOperation<'launch_profiles.select'>;
  favorite?: HostOperation<'launch_profiles.favorite.set'>;
  edit?: HostOperation<'launch_profiles.edit'>;
  discardDraft?: HostOperation<'launch_profiles.draft.discard'>;
  selectSecret?: HostOperation<'launch_profiles.secrets.select'>;
  legacyPreview?: HostOperation<'launch_profiles.legacy.preview'>;
  legacyConvert?: HostOperation<'launch_profiles.legacy.convert'>;
  legacyResolveConflict?: HostOperation<'launch_profiles.legacy.resolve_conflict'>;
}>;

/** Host ports perform transport/navigation; the existing domain service owns CRUD decisions. */
export function createProfileActionExecuteV1(ports: ProfileActionHostPortsV1) {
  const resolveOperations = async () => typeof ports.operations === 'function' ? await ports.operations() : ports.operations;
  return async (request: ProfileActionRequestV1, context: ActionExecutorContext): Promise<ActionExecuteResult> => {
    let result: ProfileActionOutputByIdV1[ProfileActionIdV1] | ActionExecuteFailure;
    const unsupported = (): ActionExecuteFailure => ({ ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${request.actionId}` });
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    switch (request.actionId) {
      case 'launch_profiles.read': result = (await resolveOperations()).read(request.input); break;
      case 'launch_profiles.search': result = (await resolveOperations()).search(request.input); break;
      case 'launch_profiles.create': result = await (await resolveOperations()).save(request.input); break;
      case 'launch_profiles.save': {
        let input = request.input;
        if (input.skillSeeds?.length && ports.readSkillLibrary) {
          const items = await ports.readSkillLibrary(context.signal);
          const skillSeeds: string[] = [];
          for (const reference of input.skillSeeds) {
            const byId = items.find(item => item.id === reference);
            const matches = byId ? [byId] : items.filter(item => item.name === reference);
            if (matches.length !== 1) return { ok: false, errorCode: 'not_found', error: 'not_found' };
            skillSeeds.push(matches[0]!.id);
          }
          input = { ...input, skillSeeds: [...new Set(skillSeeds)] };
        }
        result = await (await resolveOperations()).save(input); break;
      }
      case 'launch_profiles.duplicate': result = await (await resolveOperations()).duplicate(request.input); break;
      case 'launch_profiles.enabled.set': result = await (await resolveOperations()).setEnabled(request.input); break;
      case 'launch_profiles.delete': result = await (await resolveOperations()).remove(request.input); break;
      case 'launch_profiles.prompt_stack.update': result = await (await resolveOperations()).updatePromptStack(request.input); break;
      case 'launch_profiles.select': result = ports.select ? await ports.select(request.input, context) : unsupported(); break;
      case 'launch_profiles.favorite.set': result = ports.favorite ? await ports.favorite(request.input, context) : unsupported(); break;
      case 'launch_profiles.edit': result = ports.edit ? await ports.edit(request.input, context) : unsupported(); break;
      case 'launch_profiles.draft.discard': result = ports.discardDraft ? await ports.discardDraft(request.input, context) : unsupported(); break;
      case 'launch_profiles.secrets.select': result = ports.selectSecret ? await ports.selectSecret(request.input, context) : unsupported(); break;
      case 'launch_profiles.legacy.preview': result = ports.legacyPreview ? await ports.legacyPreview(request.input, context) : unsupported(); break;
      case 'launch_profiles.legacy.convert': result = ports.legacyConvert ? await ports.legacyConvert(request.input, context) : unsupported(); break;
      case 'launch_profiles.legacy.resolve_conflict': result = ports.legacyResolveConflict ? await ports.legacyResolveConflict(request.input, context) : unsupported(); break;
    }
    return 'ok' in result ? result : { ok: true, result };
  };
}
