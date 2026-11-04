import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';

import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { ConnectedServiceBindingsV2IngressSchema } from '../../connect/connectedServiceBindings.js';
import { readCapabilitySelectionCarrierV1, SessionCapabilitySelectionAuthoringV1Schema } from '../../reach/sessionCapabilitySelectionV1.js';
import { SessionModelSelectionV1Schema } from '../../providers/selection/v1.js';
import { AgentSessionConfigurationSnapshotV1Schema } from '../../runtime/agentSessionV1.js';
import { AgentSessionToolPolicyShapeV1 } from '../../runtime/permissionIntentV1.js';
import { AgentSessionStartupInstructionsMarkerV1Schema } from '../../runtime/agentSessionStartupInstructionsV1.js';
import { SessionAuthoringTerminalV1Schema, SessionAuthoringCheckoutCreationDraftV1Schema } from '../authoring/creationFieldsV1.js';
import { SessionCreationTagV1Schema, deriveSessionCreationTagV1, type SessionCreationTagV1 } from './sessionCreationIdentityV1.js';
import { SessionOrganizationPlacementV1Schema } from './sessionSpawnNewResultV1.js';
import { SecretReferenceOverlayV1Schema } from '../../profiles/secretReferenceOverlayV1.js';
import { SessionDirectoryIntentV1Schema, refineSessionDirectoryIntentCheckoutV1 } from './sessionDirectoryIntentV1.js';
import { SessionIdentityAdditionsV1Schema } from '../identity/sessionBotV1.js';
import { SessionPromptStackV1Schema } from '../context/sessionContextV1.js';
import { ManagedControllerV1Schema } from '../../machines/managed/managedMachineV1.js';
import { SessionDiscussionParticipantV1Schema } from './sessionDiscussionParticipantV1.js';
import { SessionAuthoringSelectionFieldsV1 } from '../authoring/selectionFieldsV1.js';
import { MachineSetupPlanInputV1Schema } from '../../machines/managed/actionsV1.js';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema,
  type ExternalActionExecutionAuthorizationV1, type ExternalActionRequestEnvelope } from '../../actions/externalActionApi.js';

/** Original admitted setup authority; encrypted owner metadata carries it without minting authority. */
export type SessionCreationMachineSetupExecutionV1 = Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  originalActionEnvelope: ExternalActionRequestEnvelope;
}>;
export const SessionCreationMachineSetupExecutionV1Schema: z.ZodMiniType<SessionCreationMachineSetupExecutionV1> = lazyZodSchema(() => z.strictObject({
  authorization: ExternalActionExecutionAuthorizationV1Schema,
  originalActionEnvelope: ExternalActionRequestEnvelopeSchema,
}));

/** Immutable birth provenance, validated against Home's admitted resource before Session creation. */
export const SessionManagedCreationV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: z.string().check(z.trim(), z.minLength(1)),
  managedId: z.string().check(z.trim(), z.minLength(1)),
  controller: z.optional(ManagedControllerV1Schema),
}));
export type SessionManagedCreationV1 = z.infer<typeof SessionManagedCreationV1Schema>;

const createSessionCreationImmutableRecipeSchema = () => z.strictObject({
  ...AgentSessionToolPolicyShapeV1,
  execution: z.strictObject({
    machineId: z.string().check(z.trim(), z.minLength(1)),
    directory: SessionDirectoryIntentV1Schema,
  }),
  organization: SessionOrganizationPlacementV1Schema,
  agentTarget: AgentExecutionTargetV1Schema,
  modelSelection: z.nullable(SessionModelSelectionV1Schema),
  profileId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  approvalProfileId: z.optional(SessionAuthoringSelectionFieldsV1.approvalProfileId),
  identity: z.optional(SessionIdentityAdditionsV1Schema),
  memoryEnabled: z.optional(z.boolean()),
  promptStack: z.optional(SessionPromptStackV1Schema),
  managedCreation: z.optional(SessionManagedCreationV1Schema),
  machineSetupPlanInput: z.optional(z.lazy(() => MachineSetupPlanInputV1Schema)),
  machineSetupExecution: z.optional(SessionCreationMachineSetupExecutionV1Schema),
  checkoutCreationDraft: z.optional(SessionAuthoringCheckoutCreationDraftV1Schema),
  discussionParticipant: z.optional(SessionDiscussionParticipantV1Schema),
  secretReferenceOverlay: z.optional(SecretReferenceOverlayV1Schema),
  requestedPermissionMode: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  agentModeId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  configuration: z.nullable(AgentSessionConfigurationSnapshotV1Schema),
  connectedServices: z.nullable(ConnectedServiceBindingsV2IngressSchema),
  capabilitySelection: z.nullable(SessionCapabilitySelectionAuthoringV1Schema),
  transcriptStorage: z.nullable(z.enum(['persisted', 'direct'])),
  terminal: z.nullable(SessionAuthoringTerminalV1Schema),
  agentSessionStartupInstructionsMarkerV1:
    z.nullable(AgentSessionStartupInstructionsMarkerV1Schema),
  checkout: z.nullable(z.strictObject({
    kind: z.literal('git_worktree'),
    finalDirectory: z.string().check(z.trim(), z.minLength(1)),
    baseRef: z.nullable(z.string().check(z.trim(), z.minLength(1))),
    branchMode: z.enum(['new', 'existing']),
    /** Actual realization evidence, not a requested base or retry identity. */
    branchName: z.optional(z.nullable(z.string())),
  })),
}).check(z.superRefine((recipe, context) => refineSessionDirectoryIntentCheckoutV1(
  { directory: recipe.execution.directory, checkoutCreationDraft: recipe.checkoutCreationDraft ?? recipe.checkout },
  context,
  ['checkout'],
)));
export const SessionCreationImmutableRecipeV1Schema = lazyZodSchema(createSessionCreationImmutableRecipeSchema);
defineStoredReadProjection(SessionCreationImmutableRecipeV1Schema, () => z.pipe(z.transform((value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const recipe = value as Record<string, unknown>;
  let capabilitySelection = recipe.capabilitySelection;
  // Retained creation provenance used the MCP-only carrier before capabilities
  // converged. Missing or malformed provenance must not become defaults.
  if (capabilitySelection === undefined && recipe.mcpSelection !== undefined) {
    if (recipe.mcpSelection === null) capabilitySelection = null;
    else if (typeof recipe.mcpSelection === 'object' && !Array.isArray(recipe.mcpSelection)) {
      capabilitySelection = readCapabilitySelectionCarrierV1(recipe) ?? undefined;
    }
  }
  const execution = recipe.execution;
  return {
    ...recipe,
    ...(capabilitySelection === undefined ? {} : { capabilitySelection }),
    ...(execution && typeof execution === 'object' && !Array.isArray(execution) && 'directory' in execution
      && typeof execution.directory === 'string'
      ? { execution: { ...execution, directory: { kind: 'path', path: execution.directory } } } : {}),
  };
}), createStoredReadSchema(createSessionCreationImmutableRecipeSchema())));
export type SessionCreationImmutableRecipeV1 = z.infer<
  typeof SessionCreationImmutableRecipeV1Schema
>;

export const SessionCreationCorrespondenceV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionCreationTag: SessionCreationTagV1Schema,
  recipe: SessionCreationImmutableRecipeV1Schema,
}));
export type SessionCreationCorrespondenceV1 = z.infer<
  typeof SessionCreationCorrespondenceV1Schema
>;
export const SessionCreationCorrespondenceV1ReadSchema = createStoredReadSchema(SessionCreationCorrespondenceV1Schema);


export function normalizeSessionCreationOrganizationPlacementV1(
  input: z.input<typeof SessionOrganizationPlacementV1Schema> | undefined,
): z.output<typeof SessionOrganizationPlacementV1Schema> {
  const parsed = SessionOrganizationPlacementV1Schema.parse(
    input ?? { folderId: null, tagIds: [] },
  );
  return {
    folderId: parsed.folderId,
    tagIds: [...parsed.tagIds].sort((left, right) => left.localeCompare(right)),
  };
}

export function sessionCreationCorrespondenceMatchesV1(
  left: unknown,
  right: unknown,
): boolean {
  const parsedLeft = SessionCreationCorrespondenceV1ReadSchema.safeParse(left);
  const parsedRight = SessionCreationCorrespondenceV1ReadSchema.safeParse(right);
  return parsedLeft.success
    && parsedRight.success
    && JSON.stringify(semanticCorrespondence(parsedLeft.data)) === JSON.stringify(semanticCorrespondence(parsedRight.data));
}

function semanticCorrespondence(value: SessionCreationCorrespondenceV1) {
  const { branchName: _observedBranch, ...checkout } = value.recipe.checkout ?? {};
  // A fresh admission proof for the same creation key does not change the
  // authored birth. The exact setup input above remains immutable retry meaning.
  const { machineSetupExecution: _admissionProof, ...recipe } = value.recipe;
  return {
    ...value,
    recipe: {
      ...recipe,
      checkout: value.recipe.checkout ? checkout : null,
      ...normalizeSessionCreationSelectionIdentityV1(value.recipe),
    },
  };
}

type SessionCreationSelections = Readonly<Partial<Pick<SessionCreationImmutableRecipeV1, 'modelSelection' | 'configuration'>>>;

/** Ordering times govern later edits, not the meaning of an initial launch retry. */
export function normalizeSessionCreationSelectionIdentityV1(input: SessionCreationSelections): SessionCreationSelections {
  return {
    ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection
      ? { ...input.modelSelection, updatedAt: 0 } : null }),
    ...(input.configuration === undefined ? {} : { configuration: input.configuration ? {
      ...input.configuration,
      mode: { ...input.configuration.mode, updatedAtMs: 0 },
      model: { ...input.configuration.model, updatedAtMs: 0 },
      permissionIntent: { ...input.configuration.permissionIntent, updatedAtMs: 0 },
      options: Object.fromEntries(Object.entries(input.configuration.options).map(([id, option]) =>
        [id, { ...option, updatedAtMs: 0 }])),
    } : null }),
  };
}

export type SessionCreationRecipeInputV1 = Pick<SessionCreationImmutableRecipeV1, 'execution' | 'organization' | 'agentTarget'>
  & Partial<Omit<SessionCreationImmutableRecipeV1, 'execution' | 'organization' | 'agentTarget' | 'allowedTools'>>
  & Readonly<{ allowedTools?: Readonly<SessionCreationImmutableRecipeV1['allowedTools']> }>;

/** Shared immutable birth producer for ordinary Actions and host-owned Session creation. */
export function buildSessionCreationCorrespondence(input: Readonly<{
  identity: Readonly<{ sessionCreationTag: SessionCreationTagV1 }>
    | Readonly<{ callerCreationNamespace: string; creationKey: string }>;
  recipe: SessionCreationRecipeInputV1;
}>): SessionCreationCorrespondenceV1 {
  const sessionCreationTag = 'sessionCreationTag' in input.identity ? input.identity.sessionCreationTag
    : deriveSessionCreationTagV1(input.identity);
  return SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag, recipe: {
    modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null,
    connectedServices: null, capabilitySelection: null, transcriptStorage: null, terminal: null,
    agentSessionStartupInstructionsMarkerV1: null, checkout: null,
    ...input.recipe,
  } });
}
