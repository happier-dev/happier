import { ResolvedSessionProjectFilesV1Schema } from '../../machines/machineIsolationV1.js';
import * as zMini from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { SessionSpawnEnvironmentVariablesV2Schema, SessionSpawnNewSelectionV2BaseSchema } from './sessionSpawnNewSelectionV2.js';
import {
  AgentSessionStartupInstructionsV1Schema,
} from '../../runtime/agentSessionStartupInstructionsV1.js';
import {
  PluginSessionInputAttachmentsV1Schema,
  requireSessionInputContent,
} from '../messages/sessionInputAuthoringV1.js';
import { RawIngressStructuredInputV1Schema } from '../../runtime/input/structuredInputV1.js';
import { ReviewCommentDraftMessageV1Schema } from '../../messages/structured/reviewCommentsV1.js';
export { SessionAuthoringCheckoutCreationDraftV1Schema } from '../authoring/creationFieldsV1.js';
export type { SessionAuthoringCheckoutCreationDraftV1 } from '../authoring/creationFieldsV1.js';
import { SessionCreationKeyV1Schema } from './sessionCreationIdentityV1.js';
import { SessionSpawnSourceContextV1Schema } from './sessionSpawnSourceContextV1.js';
import { SessionInitialAccessDraftV1Schema } from '../access/sessionInitialAccessDraftV1.js';
import { SessionManagerV1Schema } from '../follow/sessionManagerV1.js';
import { refineSessionDirectoryIntentCheckoutV1 } from './sessionDirectoryIntentV1.js';
import { SessionInitialTriggerV1Schema } from '../../workflows/triggers/workflowTriggerActionsV1.js';
import { SessionIdentityAdditionsV1Schema } from '../identity/sessionBotV1.js';
import { SessionPromptStackV1Schema } from '../context/sessionContextV1.js';
import { SessionManagedCreationV1Schema } from './sessionCreationCorrespondenceV1.js';
import { SessionDiscussionParticipantV1Schema } from './sessionDiscussionParticipantV1.js';
import { SessionAttestedContextV1Schema } from './sessionAttestedContextV1.js';
import { SessionSectionPlacementV1Schema } from './sessionSpawnNewResultV1.js';
import { PluginUiNewSessionSeedOriginV1Schema } from '../../plugins/ui/newSessionSeedOrigin.js';
import { MachineSetupPlanInputV1Schema } from '../../machines/managed/actionsV1.js';
import { AgentInstallJobConsentSchema } from '../../daemon/agentInstallJobs.js';
import { SessionPlacementSelectionV1Schema, SessionProjectFilesSourceV1Schema } from './sessionPlacementSelectionV1.js';
import { WorkspaceAddressV1Schema } from '../../workspaces/workspaceRefV1.js';
import type { SessionExecutionTargetV1 } from './sessionExecutionTargetV1.js';
import { ConnectedServicesLaunchAuthIntentV1Schema } from '../../connect/connectedServicesLaunchAuthIntentV1.js';
export { SessionAttestedContextV1Schema, type SessionAttestedContextV1 } from './sessionAttestedContextV1.js';

/**
 * One Message-owned input admitted before the new Session runtime may start.
 * The creation key owns retry identity, so this shape carries content only;
 * callers cannot establish a second Message idempotency owner.
 */
export const SessionSpawnNewInitialInputV1Schema = lazyZodSchema(() => z.strictObject({
  text: z.optional(z.string()),
  attachments: zMini.optional(PluginSessionInputAttachmentsV1Schema),
  /** Composer references and semantic attachments before a Session exists. */
  structuredInput: zMini.optional(RawIngressStructuredInputV1Schema),
  /** Session-independent drafts; spawn settlement adds the new Session ID. */
  reviewComments: z.optional(z.strictObject({
    comments: z.array(ReviewCommentDraftMessageV1Schema),
    displayText: z.string().check(z.minLength(1)),
  })),
}).check(z.superRefine(requireSessionInputContent)));
export type SessionSpawnNewInitialInputV1 = z.infer<typeof SessionSpawnNewInitialInputV1Schema>;

/**
 * Run this Session's Agent inside one of the person's managed targets (a container or
 * sandbox row they hold). The spawn directory maps onto `workspaceRoot` inside the target.
 * An Agent-originated placement asks the person first unless they waived it in Action settings.
 */
export const SessionManagedTargetPlacementV1Schema = lazyZodSchema(() => z.strictObject({
  managedId: z.string().check(z.trim(), z.minLength(1)),
  workspaceRoot: z.string().check(z.trim(), z.minLength(1)),
  projectFiles: z.optional(ResolvedSessionProjectFilesV1Schema),
  projectFilesSource: z.optional(SessionProjectFilesSourceV1Schema),
  /** Source locator opened by the parent Action's reviewed Project admission. */
  projectFilesSourceWorkspace: z.optional(WorkspaceAddressV1Schema),
}));
export type SessionManagedTargetPlacementV1 = z.infer<typeof SessionManagedTargetPlacementV1Schema>;

/** Ordinary spawn installs software; removal, app execution and updates have separate reviews. */
export const SessionSpawnMachineSetupInputV1Schema = lazyZodSchema(() => {
  const { homeId, machineId, sources, exclusions } = MachineSetupPlanInputV1Schema.shape;
  return z.strictObject({ homeId, machineId, sources, exclusions });
});

/**
 * The sole public request for an ordinary authored hosted Session. Legacy flat
 * spawn fields are normalized before this boundary and are never accepted as a
 * second canonical creation vocabulary.
 */
export const SessionSpawnNewInputV2BaseSchema = lazyZodSchema(() => z.strictObject({
  ...SessionSpawnNewSelectionV2BaseSchema.shape,
  /** Opaque native Agent argv for this launch; the host never reparses these as control flags. */
  agentArgs: z.optional(z.array(z.string())),
  creationKey: zMini.optional(SessionCreationKeyV1Schema),
  /** Reviewed software setup completes on the selected Machine before Agent startup. */
  machineSetupPlanInput: z.optional(SessionSpawnMachineSetupInputV1Schema),
  /** Place the Session's Agent inside one of the person's managed targets. */
  managedTargetPlacement: z.optional(SessionManagedTargetPlacementV1Schema),
  /** One Session only; receiving admission requires interactive Manage intent. */
  isolationOverride: z.optional(z.literal('directly')),
  /** Explicit placement and Project files intent; absent follows the selected Machine's policy. */
  sessionPlacement: z.optional(SessionPlacementSelectionV1Schema),
  /** Create's consent for the chosen Agent's existing reviewed install Action. */
  agentInstallConsent: z.optional(AgentInstallJobConsentSchema),
  /** Transport observer preference; send only after negotiating Session-spawn epoch three. */
  observeSessionCommit: z.optional(z.literal(true)),
  /** Owner-private original authoring destination, negotiated with the target daemon. */
  authoringOrigin: z.optional(PluginUiNewSessionSeedOriginV1Schema),
  /** Host-owned identity facts persisted at ordinary Session birth. */
  identity: zMini.optional(SessionIdentityAdditionsV1Schema),
  /** Plugin-only, immutable integrator facts; never authored by an Agent or token. */
  attestedContext: zMini.optional(SessionAttestedContextV1Schema),
  /** Host-verified resource this Session was created with; never current Controller authority. */
  managedCreation: zMini.optional(SessionManagedCreationV1Schema),
  /** Current Discussion ownership is validated by the ordinary Session birth owner. */
  discussionParticipant: z.optional(SessionDiscussionParticipantV1Schema),
  /** Complete selected Session context committed before its first preparation. */
  promptStack: zMini.optional(SessionPromptStackV1Schema),
  initialInput: z.optional(SessionSpawnNewInitialInputV1Schema),
  initialTriggers: z.optional(z.array(z.lazy(() => SessionInitialTriggerV1Schema))),
  initialAccess: zMini.optional(SessionInitialAccessDraftV1Schema),
  manager: zMini.optional(SessionManagerV1Schema),
  agentSessionStartupInstructionsV1: zMini.optional(AgentSessionStartupInstructionsV1Schema),
  /**
   * Create this Session as a continuation of an existing one. Because this
   * schema is `.strict()`, a daemon that predates the field REJECTS the request
   * instead of silently dropping the source recipe — operation-scoped safe
   * degradation, not compatibility by silent ignore.
   */
  sourceContext: zMini.optional(SessionSpawnSourceContextV1Schema),
  /**
   * Raw launch environment forwarded verbatim to the spawned process. Only the
   * CLI's direct-to-daemon path may carry it: the browser-safe server-start
   * draft below omits it so values never enter server-visible creation state.
   */
  environmentVariables: z.optional(SessionSpawnEnvironmentVariablesV2Schema),
}));

function refineDiscussionParticipantSpawn(input: {
  discussionParticipant?: unknown; initialInput?: unknown; initialTriggers?: readonly unknown[]; sourceContext?: unknown;
}, context: z.core.ParsePayload): void {
  if (input.discussionParticipant === undefined) return;
  for (const key of ['initialInput', 'sourceContext'] as const) {
    if (input[key] !== undefined) context.issues.push({ code: 'custom', path: [key],
      message: 'A Discussion participant is prepared without starting a turn', input: context.value, continue: true });
  }
  if ((input.initialTriggers?.length ?? 0) > 0) context.issues.push({ code: 'custom', path: ['initialTriggers'],
    message: 'A Discussion participant is prepared without starting a trigger', input: context.value, continue: true });
}

function refineSessionPlacementSpawn(input: {
  executionTarget?: SessionExecutionTargetV1;
  sessionPlacement?: z.infer<typeof SessionPlacementSelectionV1Schema>;
  managedCreation?: unknown;
}, context: z.core.$RefinementCtx): void {
  const placement = input.sessionPlacement;
  if (placement?.kind === 'machine' && input.executionTarget
    && (placement.target.serverId !== input.executionTarget.serverId || placement.target.machineId !== input.executionTarget.machineId)) {
    context.addIssue({ code: 'custom', path: ['sessionPlacement'], message: 'Session placement must match its execution target' });
  }
  if (placement?.kind === 'managed' && input.managedCreation === undefined) {
    context.addIssue({ code: 'custom', path: ['sessionPlacement'], message: 'Managed placement requires this Session managed creation' });
  }
}

export const SessionSpawnNewInputV2Schema = lazyZodSchema(() => SessionSpawnNewInputV2BaseSchema.check(
  z.superRefine(refineSessionDirectoryIntentCheckoutV1), z.superRefine(refineDiscussionParticipantSpawn), z.superRefine(refineSessionPlacementSpawn),
));

export type SessionSpawnNewInputV2 = z.infer<typeof SessionSpawnNewInputV2Schema>;

/** The destination is admitted; its ordinary creation owner still selects an omitted Agent. */
export const SessionSpawnNewTargetedAuthoringInputV2Schema = lazyZodSchema(() => z.partial(SessionSpawnNewInputV2BaseSchema, {
  agentTarget: true,
}).check(z.superRefine(refineSessionDirectoryIntentCheckoutV1), z.superRefine(refineDiscussionParticipantSpawn), z.superRefine(refineSessionPlacementSpawn)));
export type SessionSpawnNewTargetedAuthoringInputV2 = z.infer<typeof SessionSpawnNewTargetedAuthoringInputV2Schema>;

/** Action admission translates product vocabulary once into the existing creation graph. */
export const SessionSpawnNewActionInputV2BaseSchema = lazyZodSchema(() => z.strictObject({
  ...SessionSpawnNewInputV2BaseSchema.shape,
  executionTarget: z.optional(SessionSpawnNewInputV2BaseSchema.shape.executionTarget),
  agentTarget: z.optional(SessionSpawnNewInputV2BaseSchema.shape.agentTarget),
  /** Flat model authoring waits for the selected Project's Agent choice. */
  modelSelectionInput: z.optional(z.strictObject({
    modelId: z.string().check(z.trim(), z.minLength(1)),
    providerConnectionId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
  })),
  connectedServicesAuthIntent: z.optional(ConnectedServicesLaunchAuthIntentV1Schema),
  organizationPlacement: z.optional(SessionSectionPlacementV1Schema),
}));
export const SessionSpawnNewActionInputV2Schema = lazyZodSchema(() => SessionSpawnNewActionInputV2BaseSchema.check(
  z.superRefine(refineSessionDirectoryIntentCheckoutV1), z.superRefine(refineDiscussionParticipantSpawn), z.superRefine(refineSessionPlacementSpawn),
));
export type SessionSpawnNewActionAuthoringInputV2 = z.infer<typeof SessionSpawnNewActionInputV2Schema>;
export type SessionSpawnNewActionInputV2 = Omit<SessionSpawnNewInputV2, 'organizationPlacement'> & {
  organizationPlacement?: z.infer<typeof SessionSectionPlacementV1Schema>;
};

/** Voice preserves authoring omissions for the canonical creation preparation owner. */
export const SessionSpawnNewActionVoiceInputV2Schema = lazyZodSchema(() => z.extend(z.partial(SessionSpawnNewActionInputV2BaseSchema, {
  agentTarget: true,
}), {
  /** Voice authoring intent; consumed before preparing the ordinary creation Action. */
  newSession: z.optional(z.literal(true)),
}).check(z.superRefine(refineSessionDirectoryIntentCheckoutV1), z.superRefine(refineDiscussionParticipantSpawn), z.superRefine(refineSessionPlacementSpawn)));

function projectSessionSpawnNewActionSelectionV2(input: SessionSpawnNewActionAuthoringInputV2) {
  const { organizationPlacement, modelSelectionInput: _modelSelectionInput,
    connectedServicesAuthIntent: _connectedServicesAuthIntent, ...selection } = input;
  return { ...selection, ...(organizationPlacement ? { organizationPlacement: {
    folderId: organizationPlacement.sectionId, tagIds: organizationPlacement.tagIds,
  } } : {}) };
}

export function admitSessionSpawnNewActionInputV2(input: SessionSpawnNewActionAuthoringInputV2): SessionSpawnNewInputV2 {
  return SessionSpawnNewInputV2Schema.parse(projectSessionSpawnNewActionSelectionV2(input));
}

/** Preserve authoring omissions while opening the exact public request, before effective creation admission. */
export function admitSessionSpawnNewTargetedAuthoringInputV2(input: SessionSpawnNewActionAuthoringInputV2): SessionSpawnNewTargetedAuthoringInputV2 {
  return SessionSpawnNewTargetedAuthoringInputV2Schema.parse(projectSessionSpawnNewActionSelectionV2(input));
}

export function projectSessionSpawnNewActionAuthoringInputV2(input: Omit<SessionSpawnNewInputV2, 'agentTarget' | 'executionTarget'> & {
  agentTarget?: SessionSpawnNewInputV2['agentTarget']; executionTarget?: SessionSpawnNewInputV2['executionTarget'];
}): SessionSpawnNewActionAuthoringInputV2 {
  const { organizationPlacement, ...selection } = input;
  return SessionSpawnNewActionInputV2Schema.parse({ ...selection, ...(organizationPlacement ? { organizationPlacement: {
    sectionId: organizationPlacement.folderId, tagIds: organizationPlacement.tagIds,
  } } : {}) });
}

export function projectSessionSpawnNewActionInputV2(input: SessionSpawnNewInputV2): SessionSpawnNewActionInputV2 {
  const { organizationPlacement, ...selection } = input;
  return { ...selection, ...(organizationPlacement ? { organizationPlacement: {
    sectionId: organizationPlacement.folderId, tagIds: organizationPlacement.tagIds,
  } } : {}) };
}

export const SessionSpawnNewActionAgentAuthoringInputV2Schema = lazyZodSchema(() => z.partial(z.omit(SessionSpawnNewActionInputV2BaseSchema, { observeSessionCommit: true, isolationOverride: true }), {
  executionTarget: true,
  agentTarget: true,
}).check(z.superRefine(refineSessionDirectoryIntentCheckoutV1), z.superRefine(refineDiscussionParticipantSpawn), z.superRefine(refineSessionPlacementSpawn)));

/** Session Agents may inherit these choices; the start owner resolves them before creation admission. */
export const SessionSpawnNewAgentAuthoringInputV2Schema = lazyZodSchema(() => z.partial(z.omit(SessionSpawnNewInputV2BaseSchema, { observeSessionCommit: true, isolationOverride: true }), {
  executionTarget: true,
  agentTarget: true,
}).check(z.superRefine(refineSessionDirectoryIntentCheckoutV1), z.superRefine(refineDiscussionParticipantSpawn), z.superRefine(refineSessionPlacementSpawn)));

/**
 * Browser-safe omission of host-sealed creation facts. The daemon-only
 * server-start transport consumes this exact projection without owning a
 * second Session input schema.
 */
export const SessionServerStartSpawnDraftV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.omit(SessionSpawnNewInputV2BaseSchema, {
  creationKey: true,
  observeSessionCommit: true,
  initialInput: true,
  environmentVariables: true,
  agentArgs: true,
  attestedContext: true,
  authoringOrigin: true,
})).check(z.superRefine(refineSessionDirectoryIntentCheckoutV1), z.superRefine(refineDiscussionParticipantSpawn), z.superRefine(refineSessionPlacementSpawn)));

export type SessionServerStartSpawnDraftV1 = Omit<
  SessionSpawnNewInputV2,
  'creationKey' | 'observeSessionCommit' | 'initialInput' | 'environmentVariables' | 'agentArgs' | 'attestedContext' | 'authoringOrigin'
>;
