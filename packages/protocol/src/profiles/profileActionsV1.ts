import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { LaunchProfileIdV2Schema } from './v2/profileId.js';
import { LaunchProfileV2Schema, StoredLaunchProfileV2Schema } from './v2/schema.js';
import { AIBackendProfileSchema } from './backendProfileSchema.js';
import { EnvVarRequirementSchema } from './environmentVariables.js';
import { ProfileRecordIdV1Schema, ProfileRecordV1Schema, ProfileReferenceGuardRevisionV1Schema, ProfileRowRevisionV1Schema } from './profileRecordSchemaV1.js';
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

const Address = lazyZodSchema(() => z.object({ id: ProfileRecordIdV1Schema }).strict());
const EditAddress = lazyZodSchema(() => Address.extend({ expectedRevision: ProfileRowRevisionV1Schema }).strict());
const CapturedRowAddress = lazyZodSchema(() => Address.extend({ expectedRevision: ProfileReferenceGuardRevisionV1Schema }).strict());
const EditorInput = lazyZodSchema(() => CapturedRowAddress.extend({
  expectedArtifactRevision: ArtifactRevisionV1Schema.optional(),
}).strict());
const RowUpdatedResult = lazyZodSchema(() => z.object({ status: z.literal('updated'), id: ProfileRecordIdV1Schema,
  revision: ProfileRowRevisionV1Schema }).strict());
const RefusalResult = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('conflict'), id: ProfileRecordIdV1Schema, revision: z.number().int().min(-1) }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal('invalid'), reason: z.enum([
    'duplicate-id', 'duplicate-name', 'profile-not-found', 'read-only', 'legacy-creation-unsupported', 'invalid-definition',
    'entry_conflict', 'entry_not_found', 'invalid_parameters',
  ]), id: ProfileRecordIdV1Schema.optional() }).strict(),
]));
const MutationResult = lazyZodSchema(() => z.union([RowUpdatedResult, RefusalResult]));
const DeleteResult = lazyZodSchema(() => z.union([
  RowUpdatedResult.extend({ authoringMemoryCleanup: z.object({
    status: z.literal('unavailable'), reason: z.literal('authoring_memory_cleanup_failed'),
  }).strict().optional() }).strict(),
  RefusalResult,
]));
const EnabledResult = lazyZodSchema(() => z.union([RowUpdatedResult, RefusalResult,
  z.object({ status: z.literal('preference-updated'), id: ProfileRecordIdV1Schema, enabled: z.boolean(),
    settingsVersion: ProfileRowRevisionV1Schema }).strict(),
]));
const ReadResult = lazyZodSchema(() => {
  const opened = z.object({ status: z.literal('present'), profile: AiLaunchProfileV1Schema }).strict();
  const membership = { record: ProfileRecordV1Schema, revision: ProfileRowRevisionV1Schema };
  const artifact = opened.extend({ location: ArtifactRevisionV1Schema.extend({
    kind: z.literal('artifact'), artifactId: z.string().min(1), access: ArtifactCallerAccessV1Schema,
  }).strict() }).strict();
  return z.union([
    RefusalResult,
    opened.extend({ location: z.object({ kind: z.literal('builtin') }).strict() }).strict(),
    opened.extend({ ...membership, location: z.object({
      kind: z.literal('account_row'), revision: ProfileRowRevisionV1Schema,
    }).strict() }).strict(),
    artifact,
    artifact.extend(membership).strict(),
  ]);
});
const SearchResult = lazyZodSchema(() => z.union([MutationResult,
  z.object({ status: z.literal('listed'), records: z.array(z.object({ record: ProfileRecordV1Schema,
    revision: ProfileRowRevisionV1Schema }).strict()), profiles: z.array(z.object({
      profile: LaunchProfileListItemV1Schema,
      location: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('builtin') }).strict(),
        z.object({ kind: z.literal('account_row'), revision: ProfileRowRevisionV1Schema }).strict(),
        z.object({ kind: z.literal('artifact'), artifactId: z.string().min(1),
          headerVersion: ProfileRowRevisionV1Schema, bodyVersion: ProfileRowRevisionV1Schema }).strict(),
      ]),
    }).strict()), complete: z.literal(true) }).strict(),
]));
const CreateInput = lazyZodSchema(() => z.object({
  profile: LaunchProfileV2Schema, expectedRevision: z.literal('absent'),
}).strict());
const SaveInput = lazyZodSchema(() => EditAddress.extend({
  profile: z.union([StoredLaunchProfileV2Schema, AIBackendProfileSchema.strict()]),
  expectedArtifactRevision: ArtifactRevisionV1Schema.optional(),
}).strict().superRefine((input, context) => {
  if (input.id !== input.profile.id) context.addIssue({ code: 'custom', path: ['profile', 'id'], message: 'Profile identity must match addressed row' });
}));
const SelectInput = lazyZodSchema(() => z.object({ id: ProfileRecordIdV1Schema.nullable() }).strict());
// The incumbent favorites preference uses '' for the machine environment option.
const FavoriteId = lazyZodSchema(() => z.union([ProfileRecordIdV1Schema, z.literal('')]));
const FavoriteInput = lazyZodSchema(() => z.object({ id: FavoriteId, favorite: z.boolean() }).strict());
const DraftId = lazyZodSchema(() => z.string().min(1));
const EditorResult = lazyZodSchema(() => z.union([MutationResult,
  z.object({ status: z.literal('opened'), id: ProfileRecordIdV1Schema, draftId: DraftId }).strict(),
]));
const SelectResult = lazyZodSchema(() => z.union([MutationResult,
  z.object({ status: z.literal('selected'), id: ProfileRecordIdV1Schema.nullable() }).strict(),
]));
const FavoriteResult = lazyZodSchema(() => z.union([MutationResult,
  z.object({ status: z.literal('updated'), id: FavoriteId, favorite: z.boolean() }).strict(),
]));
const DiscardInput = lazyZodSchema(() => z.object({ draftId: DraftId }).strict());
const DiscardResult = lazyZodSchema(() => z.union([MutationResult,
  z.object({ status: z.literal('discarded'), draftId: DraftId }).strict(),
]));
const ResourceId = lazyZodSchema(() => z.string().refine(resourceId => {
  // This field carries the immutable Resource id, not its encoded binding reference.
  if (resourceId.startsWith(SHARED_SAVED_SECRET_REF_V1_PREFIX)) return false;
  try { formatSharedSavedSecretRefV1(resourceId); return true; }
  catch { return false; }
}, 'Saved-secret Resource id must fit its canonical shared reference'));

/** Strict semantic ingress; saved credentials cross this boundary only as captured references. */
export const PROFILE_ACTION_INPUT_SCHEMAS_V1 = {
  'launch_profiles.read': Address,
  'launch_profiles.search': lazyZodSchema(() => z.object({ query: z.string().optional() }).strict()),
  'launch_profiles.select': SelectInput,
  'launch_profiles.create': CreateInput,
  'launch_profiles.edit': EditorInput,
  'launch_profiles.save': SaveInput,
  'launch_profiles.duplicate': lazyZodSchema(() => EditAddress.extend({
    newProfileId: LaunchProfileIdV2Schema, name: LaunchProfileV2Schema.shape.name,
    now: z.number().finite().nonnegative(),
  }).strict()),
  'launch_profiles.enabled.set': lazyZodSchema(() => z.union([
    EditAddress.extend({ enabled: z.boolean() }).strict(),
    z.object({ subject: z.object({ kind: z.literal('builtin'),
      id: ProfileRecordIdV1Schema.refine(isHistoricalBuiltInAiLaunchProfileIdV1, 'Subject must be an incumbent builtin Profile'),
    }).strict(), expectedSettingsVersion: ProfileRowRevisionV1Schema, enabled: z.boolean() }).strict(),
  ])),
  'launch_profiles.favorite.set': FavoriteInput,
  'launch_profiles.delete': EditAddress,
  'launch_profiles.prompt_stack.update': lazyZodSchema(() => CapturedRowAddress.extend({ intent: PromptStackIntentV1Schema }).strict()),
  'launch_profiles.secrets.select': lazyZodSchema(() => CapturedRowAddress.extend({
    envName: EnvVarRequirementSchema.shape.name,
    selection: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }).strict(),
      z.object({ kind: z.literal('resource'), resourceId: ResourceId,
        expectedResourceRevision: ProfileRowRevisionV1Schema }).strict(),
    ]),
  }).strict()),
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
      case 'launch_profiles.save': result = await (await resolveOperations()).save(request.input); break;
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
