export { readTeamMemberApprovalPresentation } from './specs/teamMemberApproval.js';

import { StructuredQuestionAnswersV1Schema } from '../tools/structuredQuestionAnswersV1.js';
import { ActionInvokeInputSchema } from './actionInvokeInput.js';
import { WORKFLOW_TRIGGER_ADD_ACTION_ID, WORKFLOW_TRIGGER_UPDATE_ACTION_ID } from './workflowTriggerActionIds.js';
import { readOfflineAutomationEventName } from '../automations/automationTriggerDefinition.js';
import { WorkflowTriggerAddRequestV1Schema, WorkflowTriggerUpdateRequestV1Schema } from '../workflows/triggers/workflowTriggerActionsV1.js';
import { ApprovalRequestGetResultV1Schema } from '../approvals/approvalRequestPublicRead.js';
import { isDiscussionReplyActionIdV1 } from '../discussions/actionIds.js';
import { readContributedActionReviewV1 } from './contributedActionReviewV1.js';
import { NativePermissionChoiceAnswerV1Schema, NativePermissionChoiceV1Schema, NativePermissionChoicesV1Schema } from '../sessions/permissions/respondRpcParamsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ApprovalStaleFailureDetailsSchema, buildApprovalOriginFailure } from '../approvals/approvalStaleReason.js';
import { readApprovalExecutionFailure } from '../approvals/approvalExecutionFailure.js';
import { StoredApprovalRequestSchema, ApprovalRequestV1Schema, ApprovalRequestV2Schema, type StoredApprovalRequestV2, type ApprovalExecutionOriginV1, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '../approvals/targetActionApprovalRequestV1.js';
import { AgentRuntimeJsonValueV1Schema } from '../runtime/agentSessionV1.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { evaluateInputPredicate, InputPathSchema } from '../inputs/inputPredicates.js';
import type { PluginActionConfirmationV2 } from '../plugins/actions/v2.js';
import { resolvePluginLocalizedStringV2Text } from '../plugins/contributions/publicTypes.js';
import { getActionSpec, type ActionSpec, type ApprovalPresentationContext } from './actionSpecs.js';
import type { ApprovalTechnicalInputPath } from './specs/definition.js';
import { matchesConfidentialInputPath, resolveEffectiveActionInputFields } from './actionInputHintsRuntime.js';
import { actionInputFieldAcceptsNull } from './actionInputSchemaPath.js';
import { ActionIdSchema, SESSION_ACCESS_CONTEXT_SET_ACTION_ID_V1, type ActionId } from './actionIds.js';
import { VoiceConversationTargetSchema } from './voiceConversationActionFamily.js';
import type { ActionInputFieldHint, ActionInputOption } from './actionInputHintsRuntime.js';
import { readCanonicalPaddedBase64DecodedLength } from '../crypto/base64.js';
import type { PrivateLabelStoredV1 } from '../crypto/privateLabelV1.js';
import { normalizeUiSurfaceCapabilityRequestV1 } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { SessionSurfaceItemV1Schema, type SessionSurfaceItemV1 } from '../sessions/board/item.js';
import { SetSessionAccessContextResponseV1Schema, type SetSessionAccessContextResponseV1 } from '../sessions/access/sessionAccessOperationsV1.js';
import { z } from '../zodRuntimePolicy.js';
import { readWidgetActionSurfaceV1 } from '../widgets/actionsV1.js';
import { unwrapActionInputSchema } from './actionInputSchemaPath.js';
import { isSettingsDeclarationActionIdV1 } from './settingsDeclarationActionFamily.js';
import {
  readApprovalAgentReference, readApprovalConnectedAccountTarget, readApprovalDeclaredModelSelection, readApprovalModelReference, readApprovalPurposeBindings, readApprovalSavedSecretReference,
} from './actionApprovalValueReferences.js';
import { ReachPlaceV1Schema } from '../reach/reachPlaceV1.js';
import { ReachRuleDraftV1Schema } from '../reach/reachRuleV1.js';
import { ReachRulesChangeV1Schema } from '../reach/reachRulesChangeV1.js';
import { PrincipalRefV1Schema } from '../teams/principal.js';
import { TeamUpdateInputV1Schema } from '../teams/team.js';
import { TEAM_GROUP_UPDATE_ACTION_ID_V1, TEAM_POLICY_SET_ACTION_ID_V1, TEAM_SETUP_RUN_ACTION_ID_V1 } from '../teams/actionIdsV1.js';
import { HomeGovernancePolicySetInputV1Schema } from '../home/governance/policy.js';
import { SERVER_CONFIG_REGISTRY_BASE } from '../serverConfig/registry.js';
import { MACHINE_PRESET_ACTION_IDS_V1, MACHINE_PRESET_CREATE_ACTION_ID_V1 } from '../machines/managed/machinePresetActionIdsV1.js';
import { MACHINE_POOL_ACTION_IDS_V1 } from '../machines/pools/actionIdsV1.js';
import { MachinePoolCreateActionInputV1Schema, MachinePoolUpdateActionInputV1Schema } from '../machines/pools/v1.js';
import {
  PluginChangePendingReviewResultSchema,
  type PluginChangePendingReviewResult,
} from '../marketplace/pluginInstallationReviewV1.js';

type SettledSessionTeamGrants = Readonly<NonNullable<SetSessionAccessContextResponseV1['teamGrants']>>;

export type SettledSessionTeamApproval =
  | Readonly<{ kind: 'teamSet'; team: Extract<ApprovalActionReference, { kind: 'team' }>; teamGrantName: string | null; grants: SettledSessionTeamGrants }>
  | Readonly<{ kind: 'teamCleared'; grants: SettledSessionTeamGrants }>;

/** The context and remaining access are one settled fact from the same execution result. */
export function readSettledSessionTeamApproval(request: Readonly<{
  actionId: string; execution?: ApprovalRequest['execution'];
}>): SettledSessionTeamApproval | null {
  if (request.actionId !== SESSION_ACCESS_CONTEXT_SET_ACTION_ID_V1 || !request.execution?.ok) return null;
  const result = SetSessionAccessContextResponseV1Schema.safeParse(request.execution.result);
  if (!result.success || result.data.teamGrants === undefined) return null;
  const { primaryTeamId, teamGrants: grants } = result.data;
  return primaryTeamId === null ? { kind: 'teamCleared', grants } : {
    kind: 'teamSet', team: { kind: 'team', id: primaryTeamId },
    teamGrantName: grants.find(grant => grant.teamId === primaryTeamId)?.name.trim() || null,
    grants,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Public reads never spend or transport the private Artifact's replay authority. */
function projectPublicApprovalExecutionOrigin(origin: ApprovalExecutionOriginV1 | StoredApprovalRequestV2['executionOriginV1']) {
  const { externalActionExecutionAuthorization: _authorization, externalActionInputSignature: _signature,
    originalActionEnvelope: _envelope, requesterSessionMachineId: _requesterMachine, ...metadata } = origin;
  return metadata;
}

/** Decisions and public reads share the target Action's existing observation policy. */
export function projectApprovalExecutionForObservation(request: ApprovalRequest | TargetActionApprovalRequestV1): ApprovalRequest['execution'] {
  const execution = request.execution;
  if (!execution) return undefined;
  const actionId = ActionIdSchema.safeParse('actionId' in request ? request.actionId : undefined);
  const project = actionId.success ? getActionSpec(actionId.data).projectObservationOutput : undefined;
  // Legacy generic V1 records preserve unknown fields; even a claimed target kind
  // cannot make their annotations trusted current receipt metadata.
  const target = request.v === 1 ? TargetActionApprovalRequestV1Schema.safeParse(request) : null;
  const currentExecution = request.v === 2 ? request.execution : target?.success ? target.data.execution : undefined;
  const operationCredentialUses = currentExecution?.operationCredentialUses;
  const targetDetails = target?.success && !execution.ok
    && (execution.errorCode === 'approval_stale' || execution.errorCode === 'approval_origin_unavailable')
    ? ApprovalStaleFailureDetailsSchema.safeParse(execution.details) : null;
  const failure = request.v === 2 && !execution.ok ? readApprovalExecutionFailure(request) : null;
  const failureCause = failure?.failureCause ?? (target?.success && !execution.ok ? currentExecution?.failureCause : undefined);
  const details = failure?.details ?? (targetDetails?.success && execution.errorCode === buildApprovalOriginFailure(targetDetails.data.reason).errorCode
    ? targetDetails.data : undefined);
  return {
    executedAtMs: execution.executedAtMs, ok: execution.ok,
    ...(currentExecution?.requestId === undefined ? {} : { requestId: currentExecution.requestId }),
    ...(currentExecution?.effectAttempted !== undefined
      ? { effectAttempted: currentExecution.effectAttempted } : {}),
    ...(execution.ok && execution.result !== undefined ? { result: project ? project(execution.result) : execution.result } : {}),
    ...(execution.errorCode === undefined ? {} : { errorCode: execution.errorCode }),
    ...(execution.error === undefined ? {} : { error: execution.error }),
    ...(details === undefined ? {} : { details }),
    ...(failureCause === undefined ? {} : { failureCause }),
    ...(operationCredentialUses?.length ? { operationCredentialUses } : {}),
  };
}

/** Shared by every public approval Action surface; private Artifact readers retain custody. */
function projectAutomaticChecksForPublicRead(checks: NonNullable<StoredApprovalRequestV2['automaticChecks']>, projectInput: (input: unknown) => unknown) {
  const { subjects: _subjects, selected, humanDecision: human, ...automaticChecks } = checks;
  return { ...automaticChecks, selected: selected.map(({ subject: _subject, ...reference }) => reference),
    ...(human ? { humanDecision: {
    kind: human.kind, decidedAtMs: human.decidedAtMs,
    ...(human.authority === 'present_user' ? { authority: 'present_user' } : {}),
    ...(human.decidedVia === 'voice' ? { decidedVia: 'voice' } : {}),
    ...(human.narrowedInput === undefined ? {} : { narrowedInput: projectInput(human.narrowedInput) }),
  } } : {}) };
}

export function projectApprovalRequestForPublicRead(request: ApprovalRequest | TargetActionApprovalRequestV1): unknown {
  const target = TargetActionApprovalRequestV1Schema.safeParse(request);
  if (target.success) {
    const projectInput = (input: unknown) => target.data.secretInputPaths === undefined ? null
      : projectTargetActionApprovalInput(input, target.data.secretInputPaths)?.input ?? null;
    return {
      ...target.data,
      input: projectInput(target.data.input),
      ...(target.data.executionOriginV1
        ? { executionOriginV1: projectPublicApprovalExecutionOrigin(target.data.executionOriginV1) } : {}),
      ...(target.data.decision ? { decision: {
        kind: target.data.decision.kind, decidedAtMs: target.data.decision.decidedAtMs,
        ...(target.data.decision.decidedVia === 'voice' ? { decidedVia: 'voice' } : {}),
      } } : {}),
      ...(target.data.execution ? { execution: projectApprovalExecutionForObservation(target.data) } : {}),
      ...(target.data.automaticChecks ? { automaticChecks: projectAutomaticChecksForPublicRead(target.data.automaticChecks, projectInput) } : {}),
    };
  }
  const builtIn = StoredApprovalRequestSchema.parse(request);
  // Released V1 storage preserves unknown fields for forward readability. That
  // custody contract does not publish unknown authority or credential fields.
  const disclosed: Record<string, unknown> = Object.fromEntries(Object.keys(builtIn.v === 2 ? ApprovalRequestV2Schema.shape : ApprovalRequestV1Schema.shape)
    .filter(key => Object.hasOwn(builtIn, key)).map(key => [key, Reflect.get(builtIn, key)]));
  const actionId = ActionIdSchema.safeParse(builtIn.actionId);
  const spec = actionId.success ? getActionSpec(actionId.data) : null;
  const projectInput = (input: unknown) => spec?.projectObservationInput ? spec.projectObservationInput(input) : input;
  disclosed.actionArgs = projectInput(builtIn.actionArgs);
  if (builtIn.v === 2) disclosed.executionOriginV1 = projectPublicApprovalExecutionOrigin(builtIn.executionOriginV1);
  if (builtIn.origin) {
    // Native tool wrappers can repeat pre-projection operands in several shapes;
    // the public actionArgs already carries their canonical observation.
    const { toolInput: _rawInput, ...origin } = builtIn.origin;
    disclosed.origin = origin;
  }
  // Private review previews have no shared observation schema. The Action's
  // public input projection is authoritative when its operands are sensitive.
  if (spec?.projectObservationInput) delete disclosed.preview;
  if (builtIn.decision) disclosed.decision = {
    kind: builtIn.decision.kind, decidedAtMs: builtIn.decision.decidedAtMs,
    ...(builtIn.decision.authority === 'present_user' ? { authority: 'present_user' } : {}),
    ...(builtIn.v === 2 && builtIn.decision.decidedVia === 'voice' ? { decidedVia: 'voice' } : {}),
    ...(builtIn.decision.narrowedInput === undefined ? {} : { narrowedInput: projectInput(builtIn.decision.narrowedInput) }),
  };
  if (builtIn.v === 2 && builtIn.automaticChecks) {
    disclosed.automaticChecks = projectAutomaticChecksForPublicRead(builtIn.automaticChecks, projectInput);
  }
  if (builtIn.execution) disclosed.execution = projectApprovalExecutionForObservation(builtIn);
  return disclosed;
}

export type ApprovalStructuredAnswer = Readonly<{
  question: string;
  values: readonly string[];
}>;

export type ApprovalUnrepresentableReason =
  | 'malformed_entry'
  | 'duplicate_question'
  | 'exceeds_protocol_bounds'
  | 'missing_required_context';

export type ApprovalStructuredAnswersProjection =
  | Readonly<{ kind: 'valid'; answers: readonly ApprovalStructuredAnswer[] }>
  | Readonly<{ kind: 'unrepresentable'; reason: ApprovalUnrepresentableReason }>;

/**
 * One line of a structured value as people read it: a humanized key and its scalar value, or a
 * group heading (`value: null`) whose members follow one level deeper. Every leaf of the literal
 * appears exactly once, in order, so the entries are a faithful reading of the same value.
 */
export type ApprovalStructuredValueEntry = Readonly<{
  label: string; value: string | null; depth: number;
  /** A declared reference (a Home, a session, an Account): people read it by its name. */
  reference?: ApprovalActionReference;
  /** A schema version or an empty value: present, but read only when asked for. */
  technical?: true;
  /** Declared literal formats and epoch moments use the same reading as ordinary fields. */
  valueFormat?: 'timestamp' | 'clear' | 'code';
  selectedOptions?: readonly Pick<ActionInputOption, 'label' | 'labelKey'>[];
  /** A Home override uses the registry's name, including when the stored value is cleared. */
  homeSetting?: Readonly<{ key: string; cleared: boolean }>;
}>;

export type ApprovalActionFieldRow =
  | Readonly<{
    kind: 'value'; path: string; title: string; value: string; reference?: ApprovalActionReference;
    /** A boolean choice reads through the client's localized yes/no labels. */
    valueFormat?: 'boolean' | 'unavailable' | 'confidential' | 'timestamp' | 'code' | 'clear';
    /** Declared choices carry their localization keys; clients never infer labels from enum values. */
    selectedOptions?: readonly Pick<ActionInputOption, 'label' | 'labelKey'>[];
    /** A readable reading of a structured (JSON) value; `value` stays the exact literal. */
    entries?: readonly ApprovalStructuredValueEntry[];
    /** A schema version argument: present, but read only when asked for. */
    technical?: true;
  }>
  | Readonly<{ kind: 'structuredAnswers'; path: string; title: string; answers: readonly ApprovalStructuredAnswer[] }>
  | Readonly<{ kind: 'unrepresentable'; path: string; title: string; reason: ApprovalUnrepresentableReason }>;

export type ApprovalActionReference =
  | Readonly<{
      kind: 'session';
      id: string;
      serverId?: string;
      presentation?: 'destructive_target';
    }>
  | Readonly<{ kind: 'home'; id: string; unavailableWithoutName?: true }>
  | Readonly<{ kind: 'account'; id: string }>
  /** A Home directory entry, named by the reviewer's authorized read on this Home. */
  | Readonly<{ kind: 'homeAccount'; id: string }>
  /** A Discussion, read by the title its viewer can read. */
  | Readonly<{ kind: 'discussion'; id: string }>
  /** A saved Home layout item, read through the presenting Account's existing layout projection. */
  | Readonly<{ kind: 'homeLayoutItem'; id: string }>
  | Readonly<{ kind: 'homeSetupStep'; id: string }>
  /** Pending label content stays bound to the row and is opened only on the viewing Account's device. */
  | Readonly<{ kind: 'privateLabel'; id: string; field: 'name' | 'description'; stored: PrivateLabelStoredV1;
      owner: 'teamGroup' | 'teamPool' | 'privatePool' | Readonly<{ kind: 'retainedPool'; expectedRevision: number }> }>
  | Readonly<{ kind: 'team'; id: string }>
  | Readonly<{ kind: 'group'; id: string; teamId: string }>
  | Readonly<{ kind: 'teamMembership'; id: string; teamId: string }>
  | Readonly<{ kind: 'signInConnection' | 'signInProvider'; id: string; teamId: string | null }>
  | Readonly<{ kind: 'teamDirectorySource'; id: string; teamId: string }>
  | Readonly<{ kind: 'teamDirectoryGroup'; id: string; teamId: string; sourceId?: string }>
  | Readonly<{ kind: 'teamExternalGroupBinding'; id: string; teamId: string }>
  | Readonly<{ kind: 'teamInvitation'; id: string; teamId: string }>
  | Readonly<{ kind: 'teamCredentialResource'; id: string; unavailableWithoutName: true }>
  | Readonly<{ kind: 'teamCredentialExternalKey'; id: string; resourceId: string }>
  | Readonly<{ kind: 'teamCredentialLimit'; id: string; resourceId: string; resourceRevision: number }>
  | Readonly<{ kind: 'teamCredentialAudience'; id: string; resourceId: string; audience: 'group' | 'teamMembership' }>
  /** An explicit null is the default picker’s None choice. An omitted field has no reference. */
  | Readonly<{ kind: 'approvalProfile'; id: string | null }>
  | Readonly<{ kind: 'setting'; id: string }>
  | Readonly<{ kind: 'providerConnection'; id: string; displayName?: string; catalogSourceKey?: string; agentTargetKey?: string }>
  | Readonly<{ kind: 'providerModel'; id: string; connectionId: string; agentTargetKey: string; catalogSourceKey?: string }>
  /** A Team resource's model, read with its Team rather than through the Agent's native catalog. */
  | Readonly<{ kind: 'teamModel'; id: string; teamId: string; resourceId: string; agentTargetKey: string }>
  | Readonly<{ kind: 'providerContribution'; id: string }>
  /** An Agent's own model (no Provider connection): read by the Agent catalog's title for it. */
  | Readonly<{ kind: 'agentModel'; id: string; agentTargetKey: string }>
  /** The Connected Account (or pool) one connected service is bound to: read as "Service · account". */
  | Readonly<{
      kind: 'connectedAccount'; id: string; service: string; pool?: true;
      /** The Provider purpose slot this binding fills: its declared title names the row, not the humanized purpose id. */
      purpose?: Readonly<{ id: string; contributionKey?: string; connectionId?: string }>;
    }>
  /** A Saved Secret, read by its name and never by its value; one that is gone reads as unavailable. */
  | Readonly<{ kind: 'savedSecret'; id: string }>
  | Readonly<{ kind: 'managedMachine'; id: string; homeId?: string; unavailableWithoutName?: true }>
  | Readonly<{ kind: 'machinePreset'; id: string; homeId?: string }>
  | Readonly<{ kind: 'machinePool'; id: string }>
  | Readonly<{ kind: 'artifact' | 'skill'; id: string; unavailableWithoutName?: true }>
  | Readonly<{ kind: 'mcpServer' | 'project' | 'agent' | 'registrySource' | 'builtinWidget'; id: string }>
  /** A saved, built-in or plugin Workflow (its canonical definition reference), read by its title. */
  | Readonly<{ kind: 'workflow'; id: string }>
  /** An existing Workflow Run, read by its Workflow's title and when it started. */
  | Readonly<{ kind: 'workflowRun'; id: string }>
  | Readonly<{ kind: 'machine'; id: string; serverId?: string; workspaceRoot?: string; unavailableWithoutName?: true }>
  /** A workspace the app already knows (a ref id): read by its folder name and its machine. */
  | Readonly<{ kind: 'workspace'; id: string; unavailableWithoutName?: true }>
  /** A persisted workspace-sync link: read by the two folders it joins and their machines. */
  | Readonly<{ kind: 'workspaceSyncRelationship'; id: string }>;

// These are declared Action field keys, not a guess from an opaque value or suffix.
const SESSION_REFERENCE_KEYS = new Set([
  'sessionId', 'managerSessionId', 'expectedManagerSessionId', 'leadSessionId', 'expectedLeadSessionId',
  'sourceSessionId', 'targetSessionId',
  'underSessionId', 'parentSessionId', 'originSessionId',
]);

const PRINCIPAL_OPERAND_REFERENCES = new Map<string, 'account' | 'team'>([
  ['initialOwnerAccountId', 'account'],
  ['recipientAccountId', 'account'],
  ['primaryTeamId', 'team'],
]);

/** A declared reference key read by its name: a session, a Home, an Account or a Discussion. */
function describeApprovalKeyReference(key: string | undefined, value: unknown): ApprovalActionReference | undefined {
  if (typeof value !== 'string' || !value.trim() || key === undefined) return undefined;
  if (SESSION_REFERENCE_KEYS.has(key)) return { kind: 'session', id: value.trim() };
  const principal = PRINCIPAL_OPERAND_REFERENCES.get(key);
  if (principal) return { kind: principal, id: value.trim() };
  if (key === 'serverId') return { kind: 'home', id: value.trim() };
  if (key === 'accountId') return { kind: 'account', id: value.trim() };
  if (key === 'discussionId') return { kind: 'discussion', id: value.trim() };
  // A Team id names a Team wherever an Action carries it; its name reads instead of the id.
  if (key === 'teamId') return { kind: 'team', id: value.trim() };
  // A Project key names that Project wherever an Action carries it (`projectKey`, `target.projectKey`).
  // `self` is the grouping contract's "its own Project" choice, not a Project.
  if (key === 'projectKey' && value.trim() !== 'self') return { kind: 'project', id: value.trim() };
  return readApprovalSavedSecretReference('', key, value);
}

/**
 * What says nothing about the request's target: a schema version, a concurrency revision or an empty
 * value. Target ids stay in view, so an approval always shows exactly what it acts on; only a named
 * reference moves its raw id.
 */
function isTechnicalApprovalKey(key: string | undefined): boolean {
  // Every `expected…Revision` or `expectedUpdatedAt` operand is an optimistic-concurrency check (item, layout, metadata, intent…).
  return key === 'v' || (key !== undefined && /^expected(?:[A-Z][A-Za-z]*)?(?:Revision|UpdatedAt)$/.test(key))
    // A retry key makes a request idempotent; it says nothing about what the request does.
    || key === 'creationKey' || key === 'idempotencyKey';
}

/**
 * Inside a structured value, a commit hash or a Git ref (`sourceHeadSha`, `fetchRef`) is a code people compare, not
 * a fact they read: it waits in Technical details beside the address and branch it pins. Nested only, so an Action
 * whose deciding argument is itself a ref keeps it in view.
 */
function isRevisionCodeApprovalEntry(key: string | undefined, value: unknown): boolean {
  if (key === undefined || typeof value !== 'string') return false;
  // Named and shaped alike, so a `…Ref` naming a secret or a template stays a readable fact.
  return /^(?:sha|[a-z][A-Za-z]*Sha)$/.test(key) && /^[0-9a-fA-F]{7,64}$/.test(value)
    || /^(?:ref|[a-z][A-Za-z]*Ref)$/.test(key) && value.startsWith('refs/');
}

/** A typed resource audience names the person, Team or Group itself, rather than its discriminator and keys. */
function readApprovalPrincipalReference(value: unknown): ApprovalActionReference | undefined {
  if (!isRecord(value)) return undefined;
  const principal = PrincipalRefV1Schema.safeParse(value);
  if (!principal.success) return undefined;
  switch (principal.data.kind) {
    case 'account': return { kind: 'account', id: principal.data.accountId };
    case 'team': return { kind: 'team', id: principal.data.teamId };
    case 'group': return { kind: 'group', id: principal.data.groupId, teamId: principal.data.teamId };
  }
}

function describeApprovalReference(actionId: string, field: ActionInputFieldHint, values: readonly unknown[], input: unknown, referenceForField?: NonNullable<ActionSpec['approvalPresentation']>['referenceForField']): ApprovalActionReference | undefined {
  if (values.length !== 1) return undefined;
  const value = values[0];
  const declaredReference = referenceForField?.(field.path, value, input);
  if (declaredReference) return declaredReference;
  if ((actionId === 'skills.rules.set' || actionId === 'mcp.rules.set') && field.path === 'change.write.place') {
    return describeApprovalPlaceReference(value);
  }
  if (field.path === 'target' && (actionId === 'ui.voice_global.start' || actionId === 'ui.voice_global.get')) {
    // Only this declared typed union owns this discriminator. Arbitrary JSON that happens
    // to contain kind/sessionId keys remains data, including access principals/configuration.
    const target = VoiceConversationTargetSchema.safeParse(value);
    if (target.success && target.data.kind === 'session' && target.data.sessionAddress) {
      return { kind: 'session', id: target.data.sessionAddress.sessionId, serverId: target.data.sessionAddress.serverId };
    }
    return undefined;
  }
  const reference = describeActionSpecificApprovalReference(actionId, field, value, input)
    ?? describeApprovalOperandReference(field.path, value, field.inputType, actionId);
  return actionId === 'session.delete' && field.path === 'sessionId' && reference?.kind === 'session'
    ? { ...reference, presentation: 'destructive_target' }
    : reference;
}

/**
 * What an operand names wherever any Action carries it, host or plugin-contributed: its declared key or
 * declared input type, never the Action. A plugin Action's `sessionId` reads by the Session's name exactly
 * like a host Action's.
 */
function describeApprovalOperandReference(path: string, value: unknown, inputType?: ActionInputFieldHint['inputType'],
  actionId = ''): ApprovalActionReference | undefined {
  const leaf = path.split('.').at(-1);
  // Declared target fields name an Agent and a model wherever an Action carries them.
  if (leaf === 'agentTarget') return readApprovalAgentReference(value);
  if (leaf === 'modelSelection') return readApprovalModelReference(value);
  // A declared target binding or model selection reads as what it names wherever an Action carries it.
  const declared = readApprovalDeclaredModelSelection(value) ?? readApprovalConnectedAccountTarget(value)?.reference
    ?? readApprovalPrincipalReference(value);
  if (declared) return declared;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const savedSecret = readApprovalSavedSecretReference(actionId, leaf, value, inputType);
  if (savedSecret) return savedSecret;
  // A Home identity reads by the Home's name, like a `serverId` key.
  if (path === 'homeId') return { kind: 'home', id: value.trim() };
  // A Machine id names a Machine on every Action (`machineId`, `executionTarget.machineId`).
  if (leaf === 'machineId') return { kind: 'machine', id: value };
  return inputType && 'hostType' in inputType && inputType.hostType === 'session'
    ? { kind: 'session' as const, id: value.trim() }
    : describeApprovalKeyReference(leaf, value);
}

/** A host Action's own reading of one of its operands, ahead of the readings every Action shares. */
function describeActionSpecificApprovalReference(actionId: string, field: ActionInputFieldHint, value: unknown, input: unknown): ApprovalActionReference | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (actionId.startsWith('machines.managed.') && field.path === 'managedId'
      && isRecord(input) && typeof input.homeId === 'string' && input.homeId.trim()) {
    return { kind: 'managedMachine', id: value.trim(), homeId: input.homeId.trim() };
  }
  // Team-scoped references keep the Team needed by their exact authorized read.
  if (actionId.startsWith('teams.') && (field.path === 'groupId' || field.path === 'membershipId') && isRecord(input)
      && typeof input.teamId === 'string' && input.teamId.trim()) {
    return { kind: field.path === 'groupId' ? 'group' : 'teamMembership', id: value.trim(), teamId: input.teamId.trim() };
  }
  if (actionId.startsWith('artifact.') && field.path === 'artifactId') return { kind: 'artifact', id: value };
  if (actionId === 'skills.rules.set' && field.path === 'items.[].skillId') return { kind: 'skill', id: value };
  if (actionId === 'mcp.rules.set' && field.path === 'items.[].serverId') return { kind: 'mcpServer', id: value };
  if (actionId.startsWith('mcp.') && field.path === 'serverId') return { kind: 'mcpServer', id: value };
  if (actionId.startsWith('skills.') && field.path === 'skillId') return { kind: 'skill', id: value };
  // An Agent's enable request names the library skill or MCP server it asks for (P8 U8.5); a native skill has no page.
  if (actionId === 'session.capabilities.set' && field.path === 'id' && isRecord(input)) {
    if (input.kind === 'skill') return { kind: 'skill', id: value };
    if (input.kind === 'mcp_server') return { kind: 'mcpServer', id: value };
  }
  if (actionId.startsWith('workspace.sync.')) {
    if (field.path === 'controllerMachineId' || field.path === 'targetMachineId') return { kind: 'machine', id: value };
    if (field.path === 'relationshipId') return { kind: 'workspaceSyncRelationship', id: value };
    if (field.path === 'sourceWorkspaceRefId') return { kind: 'workspace', id: value };
  }
  // A Project workspace Action (forget, update) acts on that accepted checkout: it reads by its folder and machine.
  if (actionId.startsWith('projects.workspace.') && field.path === 'workspaceId') return { kind: 'workspace', id: value };
  if ((actionId === 'skills.rules.set' || actionId === 'mcp.rules.set') && field.path === 'change.write.agentId') return { kind: 'agent', id: value };
  if (actionId.startsWith('registries.sources.') && field.path === 'sourceId') return { kind: 'registrySource', id: value };
  if (field.path === 'anchor' && isSettingsDeclarationActionIdV1(actionId)) {
    return { kind: 'setting', id: value };
  }
  return undefined;
}

/** A connection being created reads by the name it is created with: beside that name operand the connection row adds nothing, and its id stays in Technical details. */
function isRedundantCreatedConnection(actionId: string, reference: ApprovalActionReference | undefined, input: unknown): boolean {
  return actionId.startsWith('providers.connections.create') && reference?.kind === 'providerConnection'
    && reference.displayName !== undefined && isRecord(input) && typeof input.displayName === 'string'
    && input.displayName.trim() === reference.displayName;
}

function describeApprovalPlaceReference(value: unknown): ApprovalActionReference | undefined {
  const place = ReachPlaceV1Schema.safeParse(value);
  if (!place.success || place.data.t === 'allMachines') return undefined;
  if (place.data.t === 'project') return { kind: 'project', id: place.data.projectKey };
  return { kind: 'machine', id: place.data.machineId,
    ...(place.data.t === 'workspace' ? { workspaceRoot: place.data.workspaceRoot } : {}) };
}

function describeApprovalRuleEntries(values: readonly unknown[]): readonly ApprovalStructuredValueEntry[] {
  const rules = values.flatMap(value => Array.isArray(value) ? value : [value]);
  if (rules.length === 0) return [{ label: 'Change', value: 'Remove all rules', depth: 0 }];
  return rules.flatMap(value => {
    const rule = ReachRuleDraftV1Schema.parse(value);
    const reference = describeApprovalPlaceReference(rule.target);
    return [
      { label: 'Where', value: rule.target.t === 'allMachines' ? 'Everywhere' : JSON.stringify(rule.target), depth: 0,
        ...(reference ? { reference } : {}) },
      ...(rule.agentId ? [{ label: 'Agent', value: rule.agentId, depth: 0, reference: { kind: 'agent' as const, id: rule.agentId } }] : []),
      { label: 'Change', value: rule.enabled ? 'Turn on' : 'Turn off', depth: 0 },
    ];
  });
}

function describeApprovalReachChange(value: unknown): readonly ApprovalStructuredValueEntry[] {
  const change = ReachRulesChangeV1Schema.parse(value);
  if (change.kind === 'replace') return describeApprovalRuleEntries([change.rules]);
  const place = change.write.place;
  const reference = describeApprovalPlaceReference(place);
  return [{ label: 'Where', value: place.t === 'allMachines' ? 'Everywhere' : JSON.stringify(place), depth: 0,
    ...(reference ? { reference } : {}) },
    ...(change.write.agentId ? [{ label: 'Agent', value: change.write.agentId, depth: 0,
      reference: { kind: 'agent' as const, id: change.write.agentId } }] : []),
    { label: 'Change', value: change.write.state === 'on' ? 'Turn on' : change.write.state === 'off' ? 'Turn off' : 'Use inherited rules', depth: 0 }];
}

function describeMcpReviewConfiguration(value: unknown): readonly ApprovalStructuredValueEntry[] {
  if (!isRecord(value)) return [];
  const { where, toolPolicy, configOverrides, ...configuration } = value;
  const entries: ApprovalStructuredValueEntry[] = [];
  appendApprovalStructuredMembers(configuration, 0, entries);
  if (isRecord(toolPolicy)) {
    const defaults: Readonly<Record<string, string>> = { ask: 'Ask', allow_read_only: 'Allow read-only', allow_all: 'Allow all' };
    const settings: Readonly<Record<string, string>> = { off: 'Off', ask: 'Ask', allow: 'Allow' };
    entries.push({ label: 'Default tool policy', value: defaults[String(toolPolicy.default)] ?? String(toolPolicy.default), depth: 0 });
    entries.push(...Object.entries(isRecord(toolPolicy.overrides) ? toolPolicy.overrides : {}).map(([name, setting]) => ({
      label: name, value: settings[String(setting)] ?? String(setting), depth: 0,
    })));
  }
  if (where !== undefined) {
    const place = ReachPlaceV1Schema.safeParse(where);
    entries.push(...(place.success ? [{ label: 'Where', value: JSON.stringify(place.data), depth: 0,
      reference: describeApprovalPlaceReference(place.data) }] : describeApprovalReachChange(where)));
  }
  if (Array.isArray(configOverrides)) {
    entries.push(...configOverrides.flatMap(override => describeMcpReviewConfiguration(override)));
  }
  return entries;
}

export type ApprovalActionFieldsPresentation = Readonly<{
  rows: readonly ApprovalActionFieldRow[];
  unrepresentable: Readonly<{ path: string; reason: ApprovalUnrepresentableReason }> | null;
}>;

export type ApprovalRequestApproveAdmission = Readonly<
  | {
      status: 'available';
      presentation: ApprovalActionFieldsPresentation;
    }
  | {
      status: 'unavailable';
      reason: 'legacy_request';
      presentation: ApprovalActionFieldsPresentation;
    }
  | {
      status: 'unavailable';
      reason: 'context_unavailable';
      details: NonNullable<ApprovalActionFieldsPresentation['unrepresentable']>;
      presentation: ApprovalActionFieldsPresentation;
    }
>;

type TargetActionApprovalApproveAdmission = ApprovalRequestApproveAdmission | Readonly<{
  status: 'unavailable';
  reason: 'live_invocation_unavailable';
  presentation: ApprovalActionFieldsPresentation;
}>;

export type PluginInstallApprovalPendingReview = Extract<
  PluginChangePendingReviewResult,
  Readonly<{ reviewKind: 'installation' }>
>;

/**
 * Reads the daemon-owned candidate retained by a plugin-install approval.
 * Requested source operands are never a substitute for this evaluated review.
 */
export function readPluginInstallApprovalPendingReview(preview: unknown): PluginInstallApprovalPendingReview | null {
  const pluginInstall = isRecord(preview) && isRecord(preview.pluginInstall)
    ? preview.pluginInstall
    : null;
  const parsed = PluginChangePendingReviewResultSchema.safeParse(pluginInstall?.pendingReview);
  return parsed.success && parsed.data.reviewKind === 'installation'
    ? parsed.data
    : null;
}

function describePluginInstallApprovalDisclosure(
  request: Pick<ApprovalRequest, 'actionId' | 'preview'>,
): ApprovalActionFieldsPresentation | null {
  if (request.actionId !== 'plugins.install') return null;
  const pendingReview = readPluginInstallApprovalPendingReview(request.preview);
  const path = 'preview.pluginInstall.pendingReview';
  if (!pendingReview) {
    const unavailable = { path, reason: 'missing_required_context' as const };
    return {
      rows: [{ kind: 'unrepresentable', ...unavailable, title: 'Daemon-evaluated install and trust disclosure' }],
      unrepresentable: unavailable,
    };
  }
  // The whole evaluated envelope: whether this is a first install or an
  // update asking for new scope (and which) is part of what the person decides.
  const entries: ApprovalStructuredValueEntry[] = [];
  appendApprovalStructuredMembers(pendingReview, 0, entries);
  return {
    rows: [{
      kind: 'value',
      path,
      title: 'Daemon-evaluated install and trust disclosure',
      value: JSON.stringify(pendingReview),
      entries,
    }],
    unrepresentable: null,
  };
}

const STRUCTURED_ANSWER_FIELD_PATH_BY_ACTION_ID: Readonly<Record<string, string>> = {
  'session.user_action.answer': 'answers',
};

function visitSegments(value: unknown, segments: readonly string[], index: number, output: unknown[]): void {
  if (index >= segments.length) {
    output.push(value);
    return;
  }
  const segment = segments[index];
  if (!segment) return;
  if (segment === '[]') {
    if (!Array.isArray(value)) return;
    for (const entry of value) visitSegments(entry, segments, index + 1, output);
    return;
  }
  if (!isRecord(value)) return;
  visitSegments(value[segment], segments, index + 1, output);
}

export function getApprovalFieldValues(input: unknown, path: string): readonly unknown[] {
  if (path === 'answers.[].values' && isRecord(input) && Array.isArray(input.answers)) {
    return input.answers.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      if (Array.isArray(entry.values)) return entry.values;
      return typeof entry.answer === 'string' ? [entry.answer] : [];
    });
  }
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return [];
  const output: unknown[] = [];
  visitSegments(input, segments, 0, output);
  return output;
}

export function shouldHideApprovalField(path: string, allPaths: readonly string[]): boolean {
  if (!path || path.endsWith('.[]')) return true;
  return allPaths.some((candidate) => candidate !== path
    && (candidate.startsWith(`${path}.`) || candidate.startsWith(`${path}.[`)));
}

export function formatApprovalFieldValues(values: readonly unknown[], options: Readonly<{ preserveStructuredValues?: boolean }> = {}): string | null {
  // An explicit empty list is a supplied clear/revoke operand, not missing context.
  const displayValues = options.preserveStructuredValues ? values : values.flatMap((value) => (Array.isArray(value) && value.length > 0 ? value : [value]));
  const formatted = displayValues
    .map((value) => {
      // An explicitly blank string is still supplied content (for example an
      // empty prompt document), unlike an absent operand.
      if (typeof value === 'string') return value.trim() || JSON.stringify(value);
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (value === null && options.preserveStructuredValues) return 'null';
      if (value && typeof value === 'object') {
        try {
          return JSON.stringify(value) ?? '';
        } catch {
          return '';
        }
      }
      return '';
    })
    .filter((value) => value.length > 0);
  return formatted.length > 0 ? formatted.join(', ') : null;
}

function humanizeApprovalKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function formatApprovalScalar(value: unknown): string {
  if (typeof value === 'string') return value.trim() || JSON.stringify(value);
  if (Array.isArray(value)) return value.length === 0 ? '[]' : value.map(formatApprovalScalar).join(', ');
  if (isRecord(value)) return '{}';
  return String(value);
}

function formatApprovalByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const kilobytes = bytes / 1024;
  return kilobytes < 1024 ? `${kilobytes.toFixed(1)} KB` : `${(kilobytes / 1024).toFixed(1)} MB`;
}

function isApprovalScalar(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((item) => !Array.isArray(item) && !isRecord(item));
  return !isRecord(value) || Object.keys(value).length === 0;
}

/** A discriminator (`kind: 'corePage'`) reads as words; any other value stays as it was sent. */
function formatApprovalEntryValue(key: string | undefined, value: unknown): string {
  if ((key === 'kind' || key === 'type') && typeof value === 'string' && /^[a-z][A-Za-z0-9_-]*$/.test(value)) {
    return humanizeApprovalKey(value);
  }
  return formatApprovalScalar(value);
}

/** The `…At` convention every Protocol shape uses for an epoch-millisecond moment (`createdAt`, `archivedAt`). */
function isApprovalTimestamp(key: string | undefined, value: unknown): boolean {
  return key !== undefined && /[a-z]At(Ms)?$/.test(key) && typeof value === 'number' && Number.isInteger(value) && value >= 1e12;
}

/** A value that stands for "not set": a `null`, or a moment of `0` (`updatedAtMs: 0`). */
function isApprovalSentinelValue(key: string | undefined, value: unknown): boolean {
  return value === null || value === 0 && key !== undefined && /[a-z]At(Ms)?$/.test(key);
}

/**
 * A typed value people read as one word or one path: `{ kind: 'managed' }` reads "Managed",
 * `{ kind: 'path', path: '/repo' }` reads "/repo" (its kind names its only other member).
 */
function readApprovalKindValue(value: unknown): string | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  const others = Object.keys(value).filter((key) => key !== 'kind');
  if (others.length === 0) return formatApprovalEntryValue('kind', value.kind);
  const member = others.length === 1 && others[0] === value.kind ? value[value.kind] : undefined;
  return typeof member === 'string' && member.trim() ? member.trim() : null;
}

/** A set value with its bookkeeping (`{ value, updatedAtMs }`): the value is what people read. */
function readApprovalStampedValue(value: unknown): { value: unknown } | null {
  if (!isRecord(value) || !Object.hasOwn(value, 'value')) return null;
  return Object.keys(value).every((key) => key === 'value' || key === 'updatedAt' || key === 'updatedAtMs')
    && isApprovalScalar(value.value) ? { value: value.value } : null;
}

function isEmptyApprovalValue(value: unknown): boolean {
  return (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);
}

type ApprovalStructuredReferences = Readonly<{
  path: string;
  fields: ReadonlyMap<string, ActionInputFieldHint | null>;
  input?: unknown;
  parent?: unknown;
  clearPaths?: readonly string[];
  codePaths?: readonly string[];
  homeSettingMapPaths?: readonly string[];
  referenceForField?: NonNullable<ActionSpec['approvalPresentation']>['referenceForField'];
  technicalPaths?: readonly string[];
}>;

function appendApprovalStructuredEntries(
  key: string | undefined,
  label: string,
  value: unknown,
  depth: number,
  output: ApprovalStructuredValueEntry[],
  widgetStructure = false,
  references?: ApprovalStructuredReferences,
): void {
  const field = references?.fields.get(references.path);
  label = field?.title ?? label;
  if (references?.technicalPaths?.includes(references.path)) {
    output.push({ label, value: formatApprovalEntryValue(key, value), depth, technical: true });
    return;
  }
  if (value === null && references?.clearPaths?.includes(references.path)) {
    output.push({ label, value: 'null', depth, valueFormat: 'clear' });
    return;
  }
  const declaredReference = references?.referenceForField?.(references.path, value, references.input, references.parent)
    ?? (field ? readApprovalSavedSecretReference('', undefined, value, field.inputType) : undefined);
  if (declaredReference) {
    output.push({ label, value: formatApprovalEntryValue(key, value), depth, reference: declaredReference });
    return;
  }
  const selectedOptions = field ? readApprovalSelectedOptions(field, [value]) : undefined;
  if (selectedOptions) {
    output.push({ label, value: selectedOptions.map(option => option.label).join(', '), depth, selectedOptions });
    return;
  }
  if (references?.homeSettingMapPaths?.includes(references.path) && isRecord(value)) {
    output.push({ label, value: null, depth });
    output.push(...describeHomeSettingsApprovalEntries(value).map(entry => ({ ...entry, depth: entry.depth + depth + 1 })));
    return;
  }
  if (references?.codePaths?.includes(references.path)) {
    output.push({ label, value: formatApprovalEntryValue(key, value), depth, valueFormat: 'code' });
    return;
  }
  // A declared descendant must be visited even when its containing object or flat list could read as one line.
  const containsDeclaration = (Array.isArray(value) || isRecord(value))
    && (references?.fields.has(references.path) === true || hasDeclaredApprovalReadingBelow(value, references));
  if (containsDeclaration) {
    output.push({ label, value: null, depth });
    appendApprovalStructuredMembers(value, depth + 1, output, widgetStructure, references);
    return;
  }
  const principal = !widgetStructure ? readApprovalPrincipalReference(value) : undefined;
  if (principal) {
    output.push({ label, value: principal.id, depth, reference: principal });
    return;
  }
  const encodedBytes = key === 'contentBase64' && typeof value === 'string'
    ? readCanonicalPaddedBase64DecodedLength(value) : null;
  if (encodedBytes !== null) {
    // A file's encoded bytes are not something people read: its size is. The literal keeps the bytes.
    output.push({ label: 'Size', value: formatApprovalByteSize(encodedBytes), depth });
    return;
  }
  if (isApprovalScalar(value)) {
    // Inside a JSON value only Home and Account ids name themselves: their ids are exact identities.
    // A session-looking key there stays data, so an arbitrary value cannot borrow a session's name.
    const keyReference = describeApprovalKeyReference(key, value);
    const reference = keyReference?.kind === 'session' || keyReference?.kind === 'discussion' ? undefined : keyReference;
    const technical = !reference && (isTechnicalApprovalKey(key) || isRevisionCodeApprovalEntry(key, value) || isEmptyApprovalValue(value)
      || isApprovalSentinelValue(key, value)
      || widgetStructure && key !== undefined && ['id', 'instanceId', 'groupId', 'artifactId', 'pluginId', 'localId', 'pageId', 'area', 'layoutId', 'kind'].includes(key));
    output.push({
      label, value: formatApprovalEntryValue(key, value), depth,
      ...(reference ? { reference } : {}),
      ...(technical ? { technical: true as const } : {}),
      ...(isApprovalTimestamp(key, value) ? { valueFormat: 'timestamp' as const } : {}),
    });
    return;
  }
  const account = !widgetStructure ? readApprovalConnectedAccountTarget(value) : undefined;
  if (account) {
    // A connected-service binding reads as the Account or pool it names; its plugin, local and group ids stay in Technical details.
    output.push({ label, value: account.id, depth, reference: account.reference });
    return;
  }
  const stamped = !widgetStructure ? readApprovalStampedValue(value) : null;
  if (stamped) {
    appendApprovalStructuredEntries(key, label, stamped.value, depth, output, widgetStructure);
    return;
  }
  const kindValue = !widgetStructure ? readApprovalKindValue(value) : null;
  if (kindValue !== null && isRecord(value) && Object.keys(value).length === 2) {
    output.push({ label, value: kindValue, depth });
    return;
  }
  const discriminatorOnly = !widgetStructure && isRecord(value) && Object.keys(value).length === 1
    && (typeof value.kind === 'string' || typeof value.type === 'string');
  if (discriminatorOnly) {
    // A group that only says what kind it is reads as one line ("Owner  Home"), not a heading over "Kind".
    const discriminator = typeof value.kind === 'string' ? 'kind' : 'type';
    output.push({ label, value: formatApprovalEntryValue(discriminator, value[discriminator]), depth });
    return;
  }
  const kindLed = !widgetStructure ? describeKindLedApprovalGroup(value) : null;
  if (kindLed) {
    // A group led by its kind whose other members are plain words reads as one line too
    // ("Owner  Core page · Usage · Main"), not a heading over Kind / Page id / Area.
    output.push({ label, value: kindLed, depth });
    return;
  }
  if (!widgetStructure && key === 'options' && isRecord(value)) {
    // Configuration options read as flat "Label  Value" lines; the group's own name adds nothing.
    for (const [optionKey, option] of Object.entries(value)) {
      const chosen = readApprovalStampedValue(option)?.value ?? option;
      if (typeof chosen === 'string' && APPROVAL_WORD_VALUE.test(chosen)) {
        output.push({ label: humanizeApprovalKey(optionKey), value: humanizeApprovalKey(chosen), depth });
      } else {
        appendApprovalStructuredEntries(optionKey, humanizeApprovalKey(optionKey), option, depth, output, widgetStructure);
      }
    }
    return;
  }
  output.push({ label, value: null, depth });
  appendApprovalStructuredMembers(value, depth + 1, output,
    widgetStructure && !['bindings', 'context', 'inputSchema', 'inputs', 'network'].includes(key ?? ''));
}

// Words only: a value with digits or separators-only shapes (ids, hashes, uuids) keeps its own row.
const APPROVAL_WORD_VALUE = /^[a-z][A-Za-z_-]*$/;

/** A kind and a few plain words, joined: no ids, references, versions or nested values. */
function describeKindLedApprovalGroup(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const discriminator = typeof value.kind === 'string' ? 'kind' : typeof value.type === 'string' ? 'type' : null;
  if (!discriminator) return null;
  const members = Object.entries(value);
  const words: string[] = [formatApprovalEntryValue(discriminator, value[discriminator])];
  for (const [key, member] of members) {
    if (key === discriminator) continue;
    if (typeof member !== 'string' || !APPROVAL_WORD_VALUE.test(member)
      || isTechnicalApprovalKey(key) || describeApprovalKeyReference(key, member)) return null;
    words.push(humanizeApprovalKey(member));
  }
  return words.join(' · ');
}

/** Value-dependent reference declarations need a walk; exact paths use the existing declared-prefix map. */
function hasDeclaredApprovalReadingBelow(value: unknown, references: ApprovalStructuredReferences | undefined): boolean {
  if (!references?.referenceForField || !(Array.isArray(value) || isRecord(value))) return false;
  const members: [string, unknown][] = Array.isArray(value) ? value.map(item => ['[]', item]) : Object.entries(value);
  return members.some(([key, item]) => {
    const path = `${references.path}.${key}`;
    return references.fields.has(path) || references.referenceForField?.(path, item, references.input, value) !== undefined
      || hasDeclaredApprovalReadingBelow(item, { ...references, path, parent: value });
  });
}

function appendApprovalStructuredMembers(value: unknown, depth: number, output: ApprovalStructuredValueEntry[], widgetStructure = false,
  references?: ApprovalStructuredReferences): void {
  const members: [string | undefined, string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [undefined, String(index + 1), item])
    : Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, humanizeApprovalKey(key), item]);
  for (const [key, label, item] of members) appendApprovalStructuredEntries(key, label, item, depth, output, widgetStructure,
    references ? { ...references, path: `${references.path}.${key ?? '[]'}`, parent: value } : undefined);
}

function describeHomeSettingsApprovalEntries(values: Record<string, unknown>): readonly ApprovalStructuredValueEntry[] {
  const entries: ApprovalStructuredValueEntry[] = [];
  for (const [key, setting] of Object.entries(values)) {
    const declaration = Object.hasOwn(SERVER_CONFIG_REGISTRY_BASE, key) ? SERVER_CONFIG_REGISTRY_BASE[key] : undefined;
    // The declared map uses the Home's runtime registry, including keys not in
    // the base registry. Preserve clears so the viewing Account can name them.
    const homeSetting = !declaration || (declaration.editable === 'home' && declaration.sensitivity === 'plain')
      ? { key, cleared: setting === null } : undefined;
    const label = humanizeApprovalKey(key);
    // Here the registry key is an operand of the change, just like a reference ID.
    if (homeSetting) entries.push({ label, value: key, depth: 0, technical: true });
    if (homeSetting?.cleared) {
      entries.push({ label: key, value: 'null', depth: 0, homeSetting });
      continue;
    }
    const index = entries.length;
    appendApprovalStructuredEntries(key, label, setting, 0, entries);
    const first = entries[index];
    if (homeSetting && first) entries[index] = { ...first, homeSetting };
  }
  return entries;
}

/**
 * The connected services a session is created with, one line per bound Account or pool; the client names it.
 * The ids stay in Technical details beside it. A binding that names no Account (native sign-in) has no line.
 */
function describeApprovalConnectedServices(value: unknown): readonly ApprovalStructuredValueEntry[] | undefined {
  const bindings = isRecord(value) && isRecord(value.bindingsByServiceId) ? value.bindingsByServiceId : null;
  if (!bindings) return undefined;
  const entries = Object.entries(bindings).flatMap(([service, binding]): ApprovalStructuredValueEntry[] => {
    if (!isRecord(binding) || binding.source !== 'connected') return [];
    const groupId = binding.selection === 'group' && typeof binding.groupId === 'string' ? binding.groupId.trim() : '';
    const accountId = binding.selection !== 'group' && typeof binding.profileId === 'string' ? binding.profileId.trim() : '';
    const id = groupId || accountId;
    if (!id) return [];
    return [{ label: 'Connected account', value: id, depth: 0,
      reference: { kind: 'connectedAccount', id, service, ...(groupId ? { pool: true as const } : {}) } }];
  });
  return entries.length > 0 ? entries : undefined;
}

/** The stored Group map uses ids as keys; readable details give each id its own reference row. */
function teamDefaultsForApprovalDetails(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.groups)) return value;
  const groups = Object.entries(value.groups);
  return groups.length === 0 ? value : {
    ...value,
    groups: groups.map(([teamGroupId, defaults]) => ({ teamGroupId, defaults })),
  };
}

/** Readable entries for one structured JSON value; scalars and flat lists read fine as they are. */
function describeApprovalStructuredValue(values: readonly unknown[], widgetStructure = false,
  references?: ApprovalStructuredReferences): readonly ApprovalStructuredValueEntry[] | undefined {
  const containsDeclaration = (Array.isArray(values[0]) || isRecord(values[0]))
    && (references?.fields.has(references.path) === true || hasDeclaredApprovalReadingBelow(values[0], references));
  if (values.length !== 1 || isApprovalScalar(values[0]) && !containsDeclaration) return undefined;
  const output: ApprovalStructuredValueEntry[] = [];
  appendApprovalStructuredMembers(values[0], 0, output, widgetStructure, references);
  return output;
}

function readMachineCatalogApprovalReference(path: string, value: unknown, input: unknown): ApprovalActionReference | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const id = value.trim();
  if (path === 'id' || path === 'preset.id') {
    const address = path === 'preset.id' && isRecord(input) ? input.preset : input;
    const homeId = isRecord(address) && typeof address.homeId === 'string' ? address.homeId : undefined;
    return { kind: 'machinePreset', id, ...(homeId ? { homeId } : {}) };
  }
  if (path === 'homeId' || path === 'preset.homeId' || path === 'workspace.serverId'
    || path === 'memoryDemand.basis.operation.serverId') return { kind: 'home', id, unavailableWithoutName: true };
  if (path === 'poolId' || path === 'controllerPoolId' || path === 'patch.controllerPoolId') return { kind: 'machinePool', id };
  if (path === 'machineId' || path === 'members.[].machineId' || path === 'memberMachineIds.[]'
    || path === 'controller.machineId' || path === 'patch.controller.machineId'
    || path === 'memoryDemand.basis.operation.machineId') {
    return { kind: 'machine', id, unavailableWithoutName: true };
  }
  if (path === 'workspace.refId') return { kind: 'workspace', id, unavailableWithoutName: true };
  if (path === 'sharedWithTeamId') return { kind: 'team', id };
  return undefined;
}

function readTeamSetupApprovalReference(path: string, value: unknown, input: unknown): ApprovalActionReference | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const id = value.trim();
  const key = path.split('.').at(-1);
  if (key === 'homeId' || key === 'serverId') return { kind: 'home', id, unavailableWithoutName: true };
  if (key === 'machineId') return { kind: 'machine', id, unavailableWithoutName: true };
  if (key === 'workspaceId' && path.startsWith('repositories.[].input.source.')) return { kind: 'workspace', id, unavailableWithoutName: true };
  if (path === 'repositories.[].input.materialization.workspaceAction.relationshipId') return { kind: 'workspaceSyncRelationship', id };
  if (key === 'managedId' && (path === 'repositories.[].input.source.checkout.managedId'
    || path === 'repositories.[].input.materialization.targetManaged.managedId'
    || path.endsWith('.plan.basis.managedId')) && isRecord(input) && typeof input.homeId === 'string') {
    return { kind: 'managedMachine', id, homeId: input.homeId };
  }
  if (path === 'machine.targets.[].preset.id') return readMachineCatalogApprovalReference('id', value, input);
  return undefined;
}

export function projectApprovalStructuredAnswers(values: readonly unknown[]): ApprovalStructuredAnswersProjection {
  const entries = values.flatMap((value) => {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
  });
  const candidate = Object.create(null) as Record<string, readonly string[]>;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.question !== 'string') {
      return { kind: 'unrepresentable', reason: 'malformed_entry' };
    }
    if (Object.hasOwn(candidate, entry.question)) {
      return { kind: 'unrepresentable', reason: 'duplicate_question' };
    }
    const rawValues = Array.isArray(entry.values)
      ? entry.values
      : (entry.answer === undefined ? [] : [entry.answer]);
    if (rawValues.length === 0 || rawValues.some((value) => typeof value !== 'string')) {
      return { kind: 'unrepresentable', reason: 'malformed_entry' };
    }
    candidate[entry.question] = rawValues as readonly string[];
  }
  const parsed = StructuredQuestionAnswersV1Schema.safeParse(candidate);
  if (!parsed.success) return { kind: 'unrepresentable', reason: 'exceeds_protocol_bounds' };
  return {
    kind: 'valid',
    answers: Object.entries(parsed.data).map(([question, values]) => ({ question, values })),
  };
}

function readApprovalPresentationPreview(input: Readonly<{ actionId: string; preview?: unknown }>) {
  if (isRecord(input.preview)
    && input.preview.actionId === input.actionId
    && Object.hasOwn(input.preview, 'actionArgs')) {
    return input.preview;
  }
  return null;
}

/**
 * Selects the host-owned observation-safe arguments persisted in the approval
 * preview. Released artifacts without that envelope fall back to the Action's
 * own observation projection; raw secret-bearing arguments are never selected
 * merely because the presentation envelope is absent or mismatched.
 */
export function resolveApprovalPresentationInput(input: Readonly<{
  actionId: string;
  actionArgs: unknown;
  preview?: unknown;
}>): unknown {
  const preview = readApprovalPresentationPreview(input);
  if (preview) return preview.actionArgs;
  try {
    const spec = getActionSpec(input.actionId as ActionId);
    return spec.projectObservationInput
      ? spec.projectObservationInput(input.actionArgs)
      : input.actionArgs;
  } catch {
    return {};
  }
}

/** The producer and its continuation bind the same declared private review. */
export function projectApprovalReviewInput(spec: ActionSpec, input: unknown): unknown {
  const review = spec.approvalPresentation;
  if (!review?.projectInput) return spec.projectObservationInput?.(input) ?? input;
  const projected = review.projectInput(input);
  return review.inputSchema ? review.inputSchema.parse(projected) : projected;
}

const NativePermissionApprovalOccurrenceSchema = lazyZodSchema(() => {
  const offer = NativePermissionChoicesV1Schema.shape;
  return z.strictObject({
    sessionId: z.string(), requestId: z.string(), turnId: z.optional(z.string()),
    nativeChoices: z.strictObject({ ...offer,
      choices: z.array(z.omit(NativePermissionChoiceV1Schema, { response: true })),
    }),
  });
});

/** Read the host-captured occurrence, never labels supplied with the answer. */
function describeNativePermissionChoice(input: Readonly<{
  actionId: string; actionArgs: Record<string, unknown>; preview?: unknown;
}>): ApprovalActionFieldsPresentation {
  const answer = NativePermissionChoiceAnswerV1Schema.safeParse(input.actionArgs.nativeChoice);
  const occurrence = NativePermissionApprovalOccurrenceSchema.safeParse(readApprovalPresentationPreview(input)?.sessionPermissionRequest);
  const captured = occurrence.success ? occurrence.data : null;
  const choice = answer.success && captured
    && (input.actionArgs.sessionId === undefined || captured.sessionId === input.actionArgs.sessionId)
    && captured.requestId === input.actionArgs.requestId
    && (input.actionArgs.turnId === undefined || captured.turnId === input.actionArgs.turnId)
    && captured.nativeChoices.requirementId === answer.data.requirementId
    ? captured.nativeChoices.choices.find(choice => choice.id === answer.data.choiceId) : undefined;
  if (!captured || !choice || !choice.label.trim()) {
    const unavailable = { path: 'nativeChoice', reason: 'missing_required_context' as const };
    return { rows: [{ kind: 'unrepresentable', title: 'Permission choice', ...unavailable }], unrepresentable: unavailable };
  }
  const scopeLabels = { once: 'Once', session: 'This session', localPersistent: 'Saved locally' } satisfies Record<typeof choice.scope, string>;
  return { rows: [
    { kind: 'value', path: 'sessionId', title: 'Session', value: captured.sessionId,
      reference: { kind: 'session', id: captured.sessionId } },
    { kind: 'value', path: 'requestId', title: 'Request id', value: captured.requestId, technical: true },
    ...(captured.turnId ? [{ kind: 'value' as const, path: 'turnId', title: 'Turn id', value: captured.turnId, technical: true as const }] : []),
    { kind: 'value', path: 'nativeChoice', title: 'Permission choice', value: choice.label },
    { kind: 'value', path: 'nativeChoice.scope', title: 'Scope', value: choice.scope,
      selectedOptions: [{ label: scopeLabels[choice.scope] }] },
    ...(choice.rulePreview ? [{ kind: 'value' as const, path: 'nativeChoice.rulePreview', title: 'Rule', value: choice.rulePreview }] : []),
    ...(answer.success && answer.data.feedback ? [{ kind: 'value' as const, path: 'nativeChoice.feedback', title: 'Feedback', value: answer.data.feedback }] : []),
  ], unrepresentable: null };
}

/** One Protocol-owned reading governs both rendered fields and approval admission. */
/** A pressed contribution reads by its own field names; its ids and raw declared input stay under Technical details. */
function describeContributedActionInvocation(actionArgs: unknown, preview: unknown): ApprovalActionFieldsPresentation | null {
  const review = readContributedActionReviewV1(preview);
  const invocation = ActionInvokeInputSchema.safeParse(actionArgs);
  if (!invocation.success) return null;
  const declared = invocation.data.input;
  const rows: ApprovalActionFieldRow[] = review ? review.fields.flatMap(field => {
    const value = field.path.split('.').reduce<unknown>((at, key) => isRecord(at) ? at[key] : undefined, declared);
    if (value === undefined || value === null) return [];
    const reference = describeApprovalOperandReference(field.path, value);
    // A structured value has no one-line reading; its exact literal stays under Technical details.
    const structured = !reference && typeof value === 'object';
    return [{ kind: 'value' as const, path: `input.${field.path}`,
      title: field.title, value: typeof value === 'string' ? value : JSON.stringify(value), ...(reference ? { reference } : {}),
      ...(structured ? { technical: true as const } : {}) }];
  }) : describeUndeclaredContributedInput(declared);
  rows.push(
    { kind: 'value', path: 'action.pluginId', title: 'Plugin id', value: invocation.data.action.pluginId, technical: true },
    { kind: 'value', path: 'action.localId', title: 'Action id', value: invocation.data.action.localId, technical: true },
    { kind: 'value', path: 'input', title: 'Declared Action input', value: JSON.stringify(declared ?? null), technical: true },
  );
  return { rows, unrepresentable: null };
}

/**
 * Without the contribution's declaration (the receiver could not read its catalog), its input reads by its own keys
 * in words, one row per value. Keys that name an identifier only route the press, so they stay under Technical details.
 */
function describeUndeclaredContributedInput(value: unknown, path: readonly string[] = []): ApprovalActionFieldRow[] {
  if (isRecord(value)) return Object.entries(value).flatMap(([key, entry]) => describeUndeclaredContributedInput(entry, [...path, key]));
  // A list of records has no one-line reading; the raw input under Technical details carries it.
  if (value === undefined || value === null || path.length === 0 || (Array.isArray(value) && value.some(isRecord))) return [];
  const key = path[path.length - 1]!;
  // An operand that names something (a Session, a Machine, a Team) reads by that name, its id in Technical details.
  const reference = describeApprovalOperandReference(path.join('.'), value);
  return [{ kind: 'value', path: `input.${path.join('.')}`, title: humanizeApprovalKey(path.join('_')),
    value: formatApprovalScalar(value), ...(reference ? { reference }
      : /(^id|Ids?)$/.test(key) ? { technical: true as const } : {}) }];
}

function readApprovalSelectedOptions(field: ActionInputFieldHint, values: readonly unknown[]): readonly Pick<ActionInputOption, 'label' | 'labelKey'>[] | undefined {
  if (field.widget === 'select' && values.length === 1) {
    const option = field.options?.find(candidate => candidate.value === values[0]);
    return option ? [option] : undefined;
  }
  if ((field.widget === 'multiselect' || field.widget === 'text_list') && field.options) {
    return values.flatMap(value => value === undefined ? [] : Array.isArray(value) ? value : [value]).map(value =>
      field.options?.find(candidate => candidate.value === value) ?? { label: String(value) });
  }
  return undefined;
}

export type WorkflowTriggerApprovalInput = Readonly<{ actionId?: string | null; actionArgs?: unknown }>;

export function readWorkflowTriggerApproval(input: WorkflowTriggerApprovalInput) {
  const add = input.actionId === WORKFLOW_TRIGGER_ADD_ACTION_ID ? WorkflowTriggerAddRequestV1Schema.safeParse(input.actionArgs) : null;
  const update = input.actionId === WORKFLOW_TRIGGER_UPDATE_ACTION_ID ? WorkflowTriggerUpdateRequestV1Schema.safeParse(input.actionArgs) : null;
  const added = add?.success ? add.data : null;
  const updated = update?.success ? update.data : null;
  const trigger = added?.trigger ?? updated?.patch.trigger;
  if (!added && !updated) return null;
  return { added, updated, trigger: trigger && (trigger.kind !== 'sessionLifecycle' || 'events' in trigger) ? trigger : null };
}

type WorkflowTriggerApproval = NonNullable<ReturnType<typeof readWorkflowTriggerApproval>>;
type ReviewedWorkflowTrigger = NonNullable<WorkflowTriggerApproval['trigger']>;
export type WorkflowTriggerApprovalLabels = Readonly<{
  when: string; folder: string; disabled: string;
  summarize: (trigger: ReviewedWorkflowTrigger) => string;
}>;

function formatReviewedTrigger(trigger: ReviewedWorkflowTrigger): string {
  switch (trigger.kind) {
    case 'schedule': {
      const { schedule } = trigger;
      if (schedule.kind === 'once') {
        const date = new Date(schedule.scheduledAt);
        return Number.isFinite(date.getTime()) ? `Once at ${date.toISOString()}` : 'Once at the selected time';
      }
      if (schedule.kind === 'interval' && schedule.everyMs !== null) return `Every ${schedule.everyMs / 1000} seconds`;
      return ['On a schedule', schedule.scheduleExpr, schedule.timezone].filter(Boolean).join(' · ');
    }
    case 'pluginEvent': {
      const event = readOfflineAutomationEventName(trigger.eventRef, 'en') ?? 'Plugin Event';
      const source = 'displayLabel' in trigger ? trigger.displayLabel : null;
      return source && source !== event ? `${event} · ${source}` : event;
    }
    case 'action':
      if (!('phase' in trigger)) return 'Action approval';
      return `${trigger.phase === 'before' ? 'Before' : 'After'} ${trigger.actionIds.map(id => {
        const action = ActionIdSchema.safeParse(id);
        return action.success ? getActionSpec(action.data).title : 'a plugin Action';
      }).join(', ')}`;
    case 'sessionLifecycle':
      return trigger.events.map(event => humanizeApprovalKey(event.replace(/^parent/, ''))).join(' · ');
    case 'runLifecycle':
      return trigger.condition === 'terminal' ? 'When the Run ends' : 'When the Run needs you';
    case 'prComment':
      return 'When a pull request has a comment';
    case 'ciFailed':
      return 'When a CI check fails';
  }
}

const defaultWorkflowTriggerApprovalLabels: WorkflowTriggerApprovalLabels = {
  when: 'When', folder: 'Folder', disabled: 'Disabled', summarize: formatReviewedTrigger,
};

export function formatWorkflowTriggerApprovalSummary(change: WorkflowTriggerApproval,
  labels = defaultWorkflowTriggerApprovalLabels): string | null {
  if (!change.trigger) return null;
  const summary = labels.summarize(change.trigger);
  return change.added?.trigger.enabled === false ? `${summary} · ${labels.disabled}` : summary;
}

/** One disclosure of admitted trigger operands, used by review cards and text readers. */
function presentWorkflowTriggerApproval(
  input: WorkflowTriggerApprovalInput,
  presentation: ApprovalActionFieldsPresentation,
  labels = defaultWorkflowTriggerApprovalLabels,
): ApprovalActionFieldsPresentation {
  if (presentation.unrepresentable) return presentation;
  const change = readWorkflowTriggerApproval(input);
  if (!change) return presentation;
  const { added, updated } = change;
  const value = formatWorkflowTriggerApprovalSummary(change, labels);
  return { ...presentation, rows: [
    ...(value ? [{ kind: 'value' as const, path: 'trigger.summary', title: labels.when, value }] : []),
    ...presentation.rows.flatMap((row): typeof presentation.rows => {
      if (row.kind !== 'value') return [row];
      if (row.path === 'project' && added?.project) {
        return [{ ...row, technical: true }, { kind: 'value', path: 'project.directory',
          title: labels.folder, value: added.project.directory }];
      }
      if (row.path === 'observationOnly' && added?.observationOnly
        && Object.keys(added.observationOnly).length === 1) return [];
      if (row.path === 'patch' && updated && value) {
        const { trigger: _summarized, ...otherChanges } = updated.patch;
        if (Object.keys(otherChanges).length === 0) return [{ ...row, technical: true }];
        const remaining = describeActionResultFields({ result: { patch: otherChanges } })?.rows[0];
        return remaining?.kind === 'value' ? [{ ...remaining, title: row.title }] : [{ ...row, technical: true }];
      }
      return [row.path === 'trigger' || row.path === 'automationId' || row.path === 'triggerId' || row.path === 'observationOnly'
        ? { ...row, technical: true } : row];
    }),
  ] };
}

/** Read only the authorized receipt's review fields. The structured Action result keeps its original contract. */
export function describeWorkflowApprovalReadText(result: unknown): string | null {
  const receipt = ApprovalRequestGetResultV1Schema.safeParse(result);
  if (!receipt.success || !('actionId' in receipt.data.request)) return null;
  return describeWorkflowApprovalRequestText(receipt.data.request);
}

export function describeWorkflowApprovalRequestText(
  request: Pick<ApprovalRequest, 'actionId' | 'actionArgs' | 'preview' | 'status'>,
): string | null {
  if (request.actionId !== WORKFLOW_TRIGGER_ADD_ACTION_ID && request.actionId !== WORKFLOW_TRIGGER_UPDATE_ACTION_ID) return null;
  const { rows, unrepresentable } = describeApprovalRequestFields(request);
  if (unrepresentable) return null;
  const fields = rows.flatMap(row => row.kind === 'value' && !row.technical && !row.reference
    ? [`${row.title}: ${row.entries ? row.entries.filter(entry => !entry.technical && !entry.reference && entry.value !== null)
      .map(entry => `${entry.label}: ${entry.value}`).join(', ') : row.value}`] : []);
  if (fields.length === 0) return null;
  return [getActionSpec(request.actionId).title, ...fields.map(field => field.replace(/[\r\n]+/gu, ' '))].join('\n');
}

export function describeApprovalActionFields(input: Readonly<{
  actionId: string;
  actionArgs: unknown;
  preview?: unknown;
  status?: ApprovalRequest['status'];
  context?: ApprovalPresentationContext;
}>): ApprovalActionFieldsPresentation {
  let spec;
  try {
    spec = getActionSpec(input.actionId as ActionId);
  } catch {
    return { rows: [], unrepresentable: { path: '', reason: 'missing_required_context' } };
  }
  if (input.actionId === 'action.invoke') {
    const contributed = describeContributedActionInvocation(input.actionArgs, input.preview);
    if (contributed) return contributed;
  }
  if (input.actionId === 'session.permission.respond' && isRecord(input.actionArgs)
    && input.actionArgs.nativeChoice !== undefined) {
    return describeNativePermissionChoice({ ...input, actionArgs: input.actionArgs });
  }
  const review = spec.approvalPresentation;
  const settled = input.status && ['executed', 'failed', 'outcome_unknown', 'rejected', 'canceled'].includes(input.status);
  // Safe presentation data is not executable input. Only terminal history or a
  // live-only continuation can read its declared schema from stored review.
  const storedReview = review?.inputSchema && (settled || spec.approvalInputCustody === 'live_only')
    ? review.inputSchema.safeParse(spec.approvalInputCustody === 'live_only'
      ? readApprovalPresentationPreview(input)?.actionArgs : input.actionArgs) : null;
  if (review?.projectInput && !storedReview?.success && !spec.inputSchema.safeParse(input.actionArgs).success) {
    const reason = 'missing_required_context' as const;
    return { rows: [{ kind: 'unrepresentable', path: '', title: spec.title, reason }],
      unrepresentable: { path: '', reason } };
  }
  // Observation previews can intentionally omit private domain content. Only the domain's
  // explicit review projection may disclose that content; never fall back to raw secret input.
  // A settled Discussion reply retains its operands. The mounted reader can
  // resolve names for that exact destination at display time.
  const presentSettledReplyDestination = settled && storedReview?.success && input.context?.discussionReplyDestination
    && isDiscussionReplyActionIdV1(input.actionId) && spec.inputSchema.safeParse(storedReview.data).success;
  const projectedInput = storedReview?.success && !presentSettledReplyDestination ? storedReview.data : review?.projectInput
    ? review.projectInput(storedReview?.success ? storedReview.data : input.actionArgs, input.context)
    : resolveApprovalPresentationInput(input);
  const parsedReview = review?.inputSchema?.safeParse(projectedInput);
  if (parsedReview && !parsedReview.success) {
    const reason = 'missing_required_context' as const;
    return { rows: [{ kind: 'unrepresentable', path: '', title: spec.title, reason }], unrepresentable: { path: '', reason } };
  }
  const presentationInput = parsedReview?.success ? parsedReview.data : projectedInput;
  const presentationSpec = review?.inputSchema || review?.inputHints
    ? { ...spec, inputSchema: review.inputSchema ?? spec.inputSchema, inputHints: review.inputHints ?? spec.inputHints } : spec;
  // Form visibility only decides what a person fills in; review also retains fixed operands.
  const resolved = [...resolveEffectiveActionInputFields(presentationSpec, presentationInput, { includeHidden: true })];
  const coveredRoots = new Set(resolved.map(field => field.path.split('.')[0]));
  const schema = unwrapActionInputSchema(presentationSpec.inputSchema).schema;
  const shape = schema instanceof z.ZodMiniObject ? schema.shape as Record<string, z.core.$ZodType> : {};
  // Form hints refine a field's reading; without hints, the canonical review
  // projection determines which operands can be shown.
  // Existing hints also declare intentional safe omissions (for example a saved credential
  // reference in a Provider review). Do not invent a required secret disclosure beside them.
  // The observation owner can deliberately omit invocation operands. Derive
  // unhinted review fields from that canonical projection, while an explicit
  // approval projection still defines its full reviewed-input contract.
  const observationInput = !spec.approvalPresentation?.projectInput && spec.projectObservationInput
    ? spec.approvalInputCustody !== 'live_only' && readApprovalPresentationPreview(input)
      && spec.inputSchema.safeParse(input.actionArgs).success
      ? spec.projectObservationInput(input.actionArgs)
      : presentationInput
    : null;
  const schemaKeys = !spec.approvalPresentation?.projectInput && spec.projectObservationInput
    ? isRecord(observationInput) ? Object.keys(observationInput) : []
    : Object.keys(shape);
  // An explicitly empty list can keep every operand private. A declared safe
  // schema or projection can still supply the full list of reviewed fields.
  const inferReviewFields = !review?.inputHints || review.inputSchema !== undefined || review.projectInput !== undefined;
  const keys = new Set(inferReviewFields && (presentationSpec.inputHints?.fields.length ?? 0) === 0
    ? [...schemaKeys, ...(isRecord(presentationInput) ? Object.keys(presentationInput) : [])]
    : []);
  for (const path of keys) {
    if (coveredRoots.has(path)) continue;
    const fieldSchema = shape[path];
    resolved.push({ path, title: humanizeApprovalKey(path), widget: 'json', visible: true, disabled: false,
      required: fieldSchema !== undefined && !z.safeParse(fieldSchema, undefined).success });
  }
  const referenceFields = new Map<string, ActionInputFieldHint | null>();
  for (const field of resolved) {
    const nested = resolved.some(parent => parent.widget === 'json' && field.path.startsWith(`${parent.path}.`));
    if (!nested && (!field.inputType || !('hostType' in field.inputType) || field.inputType.hostType !== 'savedSecretReference')) continue;
    referenceFields.set(field.path, field);
    const segments = field.path.split('.');
    while (segments.length > 1) {
      segments.pop();
      const parent = segments.join('.');
      if (!referenceFields.has(parent)) referenceFields.set(parent, null);
    }
  }
  // Structured parents keep their context; all declared children are read in-place, once per member.
  const presented = resolved.filter(field => !referenceFields.get(field.path) || !resolved.some(parent =>
    parent.widget === 'json' && field.path.startsWith(`${parent.path}.`)));
  const paths = presented.map((field) => field.path);
  // The Action declares which operands only identify or route the request; they read under Technical details.
  const isMachineCatalogAction = !settled && (MACHINE_PRESET_ACTION_IDS_V1.some(id => id === input.actionId)
    || MACHINE_POOL_ACTION_IDS_V1.some(id => id === input.actionId));
  const isTeamSetupReview = !settled && input.actionId === TEAM_SETUP_RUN_ACTION_ID_V1;
  const fallbackReferenceForField = isMachineCatalogAction ? readMachineCatalogApprovalReference
    : isTeamSetupReview ? readTeamSetupApprovalReference : undefined;
  const declaredReferenceForField = review?.referenceForField;
  const referenceForField: NonNullable<ActionSpec['approvalPresentation']>['referenceForField'] =
    declaredReferenceForField && fallbackReferenceForField
      ? (path, value, args, parent) => declaredReferenceForField(path, value, args, parent)
        ?? fallbackReferenceForField(path, value, args)
      : declaredReferenceForField ?? fallbackReferenceForField;
  const technicalPaths = [
    ...(spec.approvalPresentation?.technicalInputPaths ?? []).flatMap((entry: ApprovalTechnicalInputPath) => {
      if (typeof entry === 'string') return [entry];
      const discriminant = getApprovalFieldValues(presentationInput, entry.when.path);
      return discriminant.length === 1 && discriminant[0] === entry.when.equals ? [entry.path] : [];
    }),
    ...(isMachineCatalogAction ? ['controller.installationId', 'patch.controller.installationId',
      'memoryDemand.basis.operation.operationId', 'cursor', 'requestKey'] : []),
    ...(isTeamSetupReview ? [
      'clientId', 'repositories.[].id',
      'repositories.[].input.source.checkout.controller.installationId',
      'repositories.[].input.materialization.targetManaged.controller.installationId',
      'machine.targets.[].removeItemKeys', 'machine.targets.[].removalPlans.[].itemKey',
      ...['recipePlans', 'removalPlans'].flatMap(plan =>
        ['basis.operationId', 'basis.admittedInputDigest', 'steps.[].id', 'nativeFacts.[].stepId', 'planDigest']
          .map(path => `machine.targets.[].${plan}.[].plan.${path}`)),
    ] : []),
    ...(input.actionId === MACHINE_PRESET_CREATE_ACTION_ID_V1 ? ['id'] : []),
    ...(spec.inputSchema === MachinePoolCreateActionInputV1Schema ? ['poolId'] : []),
  ];
  const codePaths = spec.approvalPresentation?.codeInputPaths ?? [];
  for (const path of [...technicalPaths, ...codePaths, ...(review?.clearInputPaths ?? []), ...(review?.homeSettingMapInputPaths ?? [])]) {
    const segments = path.split('.');
    while (segments.length > 0) {
      const prefix = segments.join('.');
      if (!referenceFields.has(prefix)) referenceFields.set(prefix, null);
      segments.pop();
    }
  }
  const structuredAnswerPath = STRUCTURED_ANSWER_FIELD_PATH_BY_ACTION_ID[input.actionId];
  // Home policy forms flatten populated documents. A whole-document reset has
  // no populated child field, so give the explicit null its own review row.
  const clearedHomePolicyFields = spec.inputSchema === HomeGovernancePolicySetInputV1Schema
    ? Object.keys(HomeGovernancePolicySetInputV1Schema.shape).filter(path =>
      getApprovalFieldValues(presentationInput, path)[0] === null && actionInputFieldAcceptsNull(spec, path))
    : [];
  const rows: ApprovalActionFieldRow[] = clearedHomePolicyFields.map(path => ({
    kind: 'value', path, title: humanizeApprovalKey(path), value: 'null',
    selectedOptions: [{ label: 'Not set', labelKey: 'homeSettings.row.notSet' }],
  }));
  let unrepresentable: ApprovalActionFieldsPresentation['unrepresentable'] = inferReviewFields && resolved.length === 0
    && (!isRecord(presentationInput) || Object.keys(presentationInput).length > 0
      || (isRecord(input.actionArgs) && Object.keys(input.actionArgs).length > 0))
    ? { path: '', reason: 'missing_required_context' } : null;

  for (const field of presented) {
    if (clearedHomePolicyFields.includes(field.path) || shouldHideApprovalField(field.path, paths)) continue;
    const values = getApprovalFieldValues(presentationInput, field.path);
    if (structuredAnswerPath !== undefined && field.path === structuredAnswerPath) {
      const projection = projectApprovalStructuredAnswers(values);
      if (projection.kind === 'unrepresentable') {
        unrepresentable ??= { path: field.path, reason: projection.reason };
        rows.push({ kind: 'unrepresentable', path: field.path, title: field.title, reason: projection.reason });
      } else if (projection.answers.length > 0) {
        rows.push({ kind: 'structuredAnswers', path: field.path, title: field.title, answers: projection.answers });
      }
      continue;
    }
    if (values.length === 1 && values[0] === null && review?.clearInputPaths?.includes(field.path)) {
      rows.push({ kind: 'value', path: field.path, title: field.title, value: 'null', valueFormat: 'clear' });
      continue;
    }
    const literal = formatApprovalFieldValues(values, { preserveStructuredValues: field.widget === 'json' });
    // A chosen option reads by the label the form that set it shows.
    const rulesAction = input.actionId === 'skills.rules.set' || input.actionId === 'mcp.rules.set';
    const reachPlace = rulesAction && field.path === 'change.write.place' || field.path === 'where.write.place';
    const place = reachPlace ? ReachPlaceV1Schema.safeParse(values[0]) : null;
    const selectedOptions = readApprovalSelectedOptions(field, values);
    const choices = selectedOptions?.map(option => option.label).join(', ');
    const value = place?.success && place.data.t === 'allMachines' ? 'Everywhere'
      : choices || literal;
    // Required context belongs to the captured invocation (or its explicit
    // review schema), never to an intentionally reduced observation preview.
    // These operands decide presence only; displayed values stay projected.
    const contextValues = getApprovalFieldValues(review?.projectInput ? presentationInput : input.actionArgs, field.path);
    if (formatApprovalFieldValues(contextValues, { preserveStructuredValues: field.widget === 'json' }) === null) {
      // A required field whose schema declares `null` and that carries exactly
      // that null is present context with nothing to display, not missing context.
      const declaredNull = contextValues.length > 0
        && contextValues.every((entry) => entry === null)
        && actionInputFieldAcceptsNull(spec, field.path);
      // Live-only input deliberately leaves required private fields out of the
      // durable observation projection. Their presence is guaranteed by the
      // admitted invocation that retains the raw input; omission here means
      // withheld, not missing approval context.
      const withheldByLiveOnlyCustody = spec.approvalInputCustody === 'live_only';
      if (field.visible && field.required && !declaredNull && !withheldByLiveOnlyCustody) {
        const reason = 'missing_required_context' as const;
        unrepresentable ??= { path: field.path, reason };
        rows.push({ kind: 'unrepresentable', path: field.path, title: field.title, reason });
      }
    }
    const poolReplacementClearsDescription = isMachineCatalogAction && spec.inputSchema === MachinePoolUpdateActionInputV1Schema
      && field.path === 'description' && values.every(value => value === undefined);
    if (poolReplacementClearsDescription) {
      rows.push({ kind: 'value', path: field.path, title: field.title, value: 'null', valueFormat: 'clear' });
      continue;
    }
    if (values.length === 1 && values[0] === null) {
      const choice = field.path === 'description' && (spec.inputSchema === TeamUpdateInputV1Schema || input.actionId === TEAM_GROUP_UPDATE_ACTION_ID_V1)
          ? { label: '—', labelKey: 'common.none' } : undefined;
      if (choice) {
        rows.push({ kind: 'value', path: field.path, title: field.title, value: 'null', selectedOptions: [choice] });
        continue;
      }
    }
    if (value === null) continue;
    const reference = reachPlace ? describeApprovalPlaceReference(values[0]) : describeApprovalReference(input.actionId, field, values, presentationInput, referenceForField);
    // A typed value that reads as one word or path ("Directory  /repo") needs no entries under it.
    const kindValue = !isMachineCatalogAction && field.widget === 'json' && !reference && !referenceFields.has(field.path) && !place?.success && values.length === 1
      ? readApprovalKindValue(values[0]) : null;
    // A typed reference already reads by its name; entries are for values nothing else can read.
    let entries = review?.homeSettingMapInputPaths?.includes(field.path) && isRecord(values[0])
      ? describeHomeSettingsApprovalEntries(values[0])
      : (rulesAction && field.path === 'change.rules' || field.path === 'where.rules') ? describeApprovalRuleEntries(values)
      : (rulesAction && field.path.startsWith('items.') || referenceFields.get(field.path)) && values.length > 1 ? values.map(value => ({
        label: field.title, value: String(value), depth: 0,
        reference: describeApprovalReference(input.actionId, field, [value], presentationInput, referenceForField),
      }))
      : field.widget === 'json' && !reference && !place?.success ? describeApprovalStructuredValue(
        input.actionId === TEAM_POLICY_SET_ACTION_ID_V1 && field.path === 'managedDefaults' ? values.map(teamDefaultsForApprovalDetails) : values,
        input.actionId.startsWith('widgets.') && (['instance', 'group', 'fragment', 'definition'].includes(field.path)
          || ['surface', 'ref', 'to'].includes(field.path)
            && readWidgetActionSurfaceV1(input.actionArgs)?.owner.kind === 'pluginArea'),
        {
          path: field.path, fields: referenceFields, input: presentationInput, referenceForField, technicalPaths,
          clearPaths: review?.clearInputPaths, codePaths, homeSettingMapPaths: review?.homeSettingMapInputPaths,
        }) : undefined;
    if (input.actionId === 'mcp.servers.tools.set' && field.path === 'tools') {
      const settings: Readonly<Record<string, string>> = { off: 'Off', ask: 'Ask', allow: 'Allow', inherit: 'Use server default' };
      entries = values.flatMap(value => isRecord(value) ? Object.entries(value).map(([name, setting]) => ({
        label: name, value: settings[String(setting)] ?? String(setting), depth: 0,
      })) : []);
    }
    if (input.actionId.startsWith('mcp.') && (field.path === 'servers' || field.path === 'configOverrides')) {
      entries = values.flatMap(value => Array.isArray(value) ? value : [value]).flatMap(describeMcpReviewConfiguration);
    }
    if (input.actionId === 'agents.acp.backends.upsert' && field.path === 'backend.launch' && entries) {
      const methods: Readonly<Record<string, string>> = { Command: 'Command', Npm: 'npm package', Uv: 'Python package', Archive: 'Downloaded binary' };
      entries = entries.map(entry => entry.depth === 0 && entry.label === 'Kind'
        ? { ...entry, label: 'Method', value: methods[entry.value ?? ''] ?? entry.value } : entry);
    }
    if (field.path.split('.').at(-1) === 'connectedServices' && values.length === 1) {
      entries = describeApprovalConnectedServices(values[0]) ?? entries;
    }
    if (field.path.split('.').at(-1) === 'purposeBindingDefaults' && values.length === 1 && isRecord(presentationInput)) {
      // Each slot is read through the Provider's declared purpose title, so the connection and contribution name its owner.
      const bindings = readApprovalPurposeBindings(values[0], {
        ...(typeof presentationInput.contributionKey === 'string' ? { contributionKey: presentationInput.contributionKey } : {}),
        ...(typeof presentationInput.connectionId === 'string' ? { connectionId: presentationInput.connectionId } : {}),
      });
      if (bindings) entries = bindings.map(({ purpose, id, reference }) => ({ label: humanizeApprovalKey(purpose), value: id, depth: 0, reference }));
    }
    if (kindValue !== null) entries = undefined;
    const technical = technicalPaths.includes(field.path)
      || isRedundantCreatedConnection(input.actionId, reference, presentationInput)
      // A Team Group already reads with its Team ("Design reviewers, Platform"), so its Team row would say it twice.
      || input.actionId.startsWith('teams.') && field.path === 'teamId' && isRecord(presentationInput)
        && typeof presentationInput.groupId === 'string'
      || !reference && (isTechnicalApprovalKey(field.path.split('.').at(-1))
      // An operand that carries nothing (`savedSecretId: null`) is no reading; its exact literal stays in Details.
      || values.length > 0 && values.every(value => value === null)
      || values.length > 0 && values.every(isEmptyApprovalValue) && !(rulesAction && field.path === 'change.rules')
      // The visual summary already names this item. Preserve its exact identity
      // in Details, rather than adding an opaque id to that first reading.
      || field.path === 'itemId' && Boolean(readApprovalVisualItem(input.actionId, presentationInput)?.title?.trim())
      || input.actionId.startsWith('providers.') && field.path === 'action'
      // The terminal key is how the daemon finds its terminal and its size is the client's pane; people know the terminal by its folder and Machine.
      || input.actionId === 'agents.acp.backends.upsert' && ['backend.id', 'backend.name'].includes(field.path)
      || (input.actionId.startsWith('widgets.fragment.') || input.actionId.startsWith('widgets.definition.'))
        && (field.path === 'artifactId' || field.path === 'newArtifactId'));
    rows.push({
      // An intent read as its value ("Directory intent" → "Directory  /repo") is named by what it is.
      kind: 'value', path: field.path, title: kindValue !== null ? field.title.replace(/\s+intent$/i, '') : field.title,
      value: reference?.kind === 'privateLabel' ? reference.id : kindValue ?? value,
      ...(selectedOptions?.some(option => option.labelKey) ? { selectedOptions: selectedOptions.map(({ label, labelKey }) => ({
        label, ...(labelKey ? { labelKey } : {}),
      })) } : {}),
      ...(reference ? { reference } : {}),
      ...(values.length === 1 && typeof values[0] === 'boolean' ? { valueFormat: 'boolean' as const }
        : reference && PRINCIPAL_OPERAND_REFERENCES.has(field.path) ? { valueFormat: 'unavailable' as const }
        : codePaths.includes(field.path) || reference?.kind === 'setting' ? { valueFormat: 'code' as const }
        // An epoch moment (`expiresAt`) reads as a date and time; the exact literal stays in `value`.
        : values.length === 1 && isApprovalTimestamp(field.path.split('.').at(-1), values[0]) ? { valueFormat: 'timestamp' as const } : {}),
      ...(entries ? { entries } : {}),
      ...(technical ? { technical: true as const } : {}),
    });
  }
  // A previewed visual is read by looking at it; its arguments stay one disclosure away.
  if (resolveApprovalVisualPreview(input)) {
    const at = rows.findIndex((row) => row.path === 'item' && row.kind === 'value');
    const row = rows[at];
    if (row && row.kind === 'value') rows[at] = { ...row, technical: true };
  }
  const network = describeApprovalVisualNetwork(input.actionId, presentationInput)
    ?? describeApprovalWidgetNetwork(input.actionId, presentationInput);
  if (network) {
    // The one consequence a visual approval exists for, next to the visual it belongs to.
    const at = rows.findIndex((row) => row.path === (network.path.startsWith('instance') ? 'instance' : 'item'));
    const owner = rows[at];
    if (network.path === 'instance.networkOverride' && owner?.kind === 'value' && owner.entries) {
      // The Network row says it in words; the override's raw members stay in Details only.
      let inOverride = false;
      rows[at] = { ...owner, entries: owner.entries.map((entry) => {
        if (entry.depth === 0) inOverride = entry.label === humanizeApprovalKey('networkOverride');
        return inOverride && entry.value !== null ? { ...entry, technical: true as const } : entry;
      }) };
    }
    rows.splice(at < 0 ? rows.length : at + 1, 0, network);
  }
  // A structured row with nothing readable left is read in Details, never as a bare title.
  return presentWorkflowTriggerApproval({ actionId: input.actionId, actionArgs: presentationInput }, {
    rows: rows.map(row => row.kind === 'value' && row.entries && !row.technical
      && !row.entries.some(entry => entry.value !== null && !entry.technical) ? { ...row, technical: true as const } : row),
    unrepresentable,
  }, input.context?.workflowTriggerLabels);
}

/**
 * What a completed Action returned, read like its arguments: one row per field under its readable name, a
 * Session, Machine, Home or Account by its name, a moment as a time, a nested value as readable entries.
 * A `success: true` only repeats the call's own Completed, and a value the call was given (its target id)
 * only repeats Details; both leave. A result that is not an object stays with its caller (null).
 */
export function describeActionResultFields(input: Readonly<{ result: unknown; actionArgs?: unknown }>): ApprovalActionFieldsPresentation | null {
  if (!isRecord(input.result)) return null;
  const args = isRecord(input.actionArgs) ? input.actionArgs : {};
  const rows: ApprovalActionFieldRow[] = [];
  for (const [key, value] of Object.entries(input.result)) {
    if (value === undefined || (key === 'success' || key === 'ok') && value === true) continue;
    if (typeof value === 'string' && args[key] === value) continue;
    // The Action declared these keys on its own output, so a Session id here is the Session it acted on.
    const reference = typeof value === 'string' && value.trim() && key === 'machineId'
      ? { kind: 'machine' as const, id: value.trim() } : describeApprovalKeyReference(key, value);
    const entries = reference ? undefined : describeApprovalStructuredValue([value]);
    const technical = !reference && (isTechnicalApprovalKey(key) || value === null || isEmptyApprovalValue(value)
      || typeof value === 'string' && !value.trim());
    rows.push({
      kind: 'value', path: key, title: humanizeApprovalKey(key),
      value: typeof value === 'string' ? formatApprovalEntryValue(key, value)
        : formatApprovalFieldValues([value], { preserveStructuredValues: true }) ?? '',
      ...(reference ? { reference } : {}),
      ...(typeof value === 'boolean' ? { valueFormat: 'boolean' as const }
        : isApprovalTimestamp(key, value) ? { valueFormat: 'timestamp' as const } : {}),
      ...(entries ? { entries } : {}),
      ...(technical ? { technical: true as const } : {}),
    });
  }
  return { rows, unrepresentable: null };
}

/** The visual a Session visual approval asks to show, read once for its rows and its preview. */
function readApprovalVisualItem(actionId: string, input: unknown): Readonly<{
  title: string | null; source: Record<string, unknown>; height?: SessionSurfaceItemV1['height'];
}> | null {
  if (actionId !== 'session.board.item.upsert' || !isRecord(input) || !isRecord(input.item)) return null;
  const source = input.item.source;
  if (!isRecord(source)) return null;
  const height = SessionSurfaceItemV1Schema.shape.height.safeParse(input.item.height);
  return { title: typeof input.item.title === 'string' ? input.item.title : null, source,
    ...(height.success ? { height: height.data } : {}) };
}

export type ApprovalVisualPreview =
  | Readonly<{ kind: 'declarative'; title: string | null; document: unknown }>
  | Readonly<{ kind: 'html'; title: string | null; source: unknown; height?: SessionSurfaceItemV1['height']; requestedCapabilities: Readonly<{ network: 'none' }> }>;

/**
 * The visual itself, for the person deciding. Nothing is approved yet, so an HTML visual previews
 * with no network and no requested Actions or Resources; its admitted network is the Network row.
 */
export function resolveApprovalVisualPreview(input: Readonly<{
  actionId: string; actionArgs: unknown; preview?: unknown;
}>): ApprovalVisualPreview | null {
  const visual = readApprovalVisualItem(input.actionId, resolveApprovalPresentationInput(input));
  if (!visual) return null;
  if (visual.source.kind === 'declarative' && visual.source.document !== undefined) {
    return { kind: 'declarative', title: visual.title, document: visual.source.document };
  }
  if (visual.source.kind === 'hostedHtml' && visual.source.source !== undefined) {
    return { kind: 'html', title: visual.title, source: visual.source.source,
      ...(visual.height ? { height: visual.height } : {}), requestedCapabilities: { network: 'none' } };
  }
  return null;
}

/** What network an HTML visual gets once approved, captured in its exact input. */
function describeApprovalVisualNetwork(actionId: string, input: unknown): ApprovalActionFieldRow | null {
  const source = readApprovalVisualItem(actionId, input)?.source;
  if (!source || source.kind !== 'hostedHtml') return null;
  // An invalid request is refused by admission; it has no network to state.
  const capabilities = normalizeUiSurfaceCapabilityRequestV1(source.requestedCapabilities);
  if (!capabilities) return null;
  return { kind: 'value', path: 'item.source.requestedCapabilities', title: 'Network', value: describeApprovalNetworkValue(capabilities) };
}

/** The network a placed widget gets from its own override, in the same words as a Session visual. */
function describeApprovalWidgetNetwork(actionId: string, input: unknown): ApprovalActionFieldRow | null {
  if (actionId !== 'widgets.item.add' || !isRecord(input) || !isRecord(input.instance) || input.instance.networkOverride === undefined) return null;
  const policy = normalizeUiSurfaceCapabilityRequestV1(input.instance.networkOverride);
  if (!policy) return null;
  return { kind: 'value', path: 'instance.networkOverride', title: 'Network', value: describeApprovalNetworkValue(policy) };
}

function describeApprovalNetworkValue(policy: Readonly<{ network: string; networkOrigins?: readonly string[] }>): string {
  return policy.network === 'open' ? 'Any site'
    : policy.network === 'origins' ? `Only ${(policy.networkOrigins ?? []).join(', ')}`
      : 'No network access';
}

/**
 * Installed Actions have no built-in ActionSpec. Their admitted JSON supplies
 * the operand values; confirmation declarations supply paths and titles.
 * Declared confidential inputs remain opaque. Value-free Connected Account and
 * Saved Secret bindings retain their exact identity like every other admitted
 * operand; diagnostic key spelling cannot decide what an effect may hide.
 */
export function projectTargetActionApprovalInput(input: unknown, secretInputPaths: readonly string[] | undefined): Readonly<{
  input: JsonValue;
  confidentialPaths: readonly string[];
}> | null {
  const parsed = AgentRuntimeJsonValueV1Schema.safeParse(input);
  const parsedSecretPaths = z.safeParse(z.array(InputPathSchema), secretInputPaths);
  if (!parsed.success || !parsedSecretPaths.success) return null;
  const secretPaths = parsedSecretPaths.data.map(path => path.split('.'));
  const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);
  const confidentialPaths: string[] = [];
  const pending: Array<Readonly<{ source: JsonValue; destination: JsonValue[] | Record<string, JsonValue>; path: readonly string[] }>> = [];
  const project = (value: JsonValue, path: readonly string[]): JsonValue => {
    if (secretPaths.some(secret => matchesConfidentialInputPath(secret, path))) {
      confidentialPaths.push(path.join('.'));
      return '[REDACTED]';
    }
    if (value === null || typeof value !== 'object') return value;
    if (!isJsonArray(value) && value._isSecretValue === true) {
      confidentialPaths.push(path.join('.'));
      // Preserve the carrier's value-free identity so later readers can still
      // recognize a confidential operand, including a root-level carrier.
      return { _isSecretValue: true };
    }
    const destination: JsonValue[] | Record<string, JsonValue> = isJsonArray(value) ? [] : Object.create(null);
    pending.push({ source: value, destination, path });
    return destination;
  };
  const redacted = project(parsed.data, []);
  while (pending.length) {
    const next = pending.pop()!;
    if (isJsonArray(next.source) && Array.isArray(next.destination)) {
      for (const [index, value] of next.source.entries()) {
        next.destination.push(project(value, [...next.path, String(index)]));
      }
    } else if (!isJsonArray(next.source) && next.source !== null && typeof next.source === 'object' && !Array.isArray(next.destination)) {
      for (const [key, value] of Object.entries(next.source)) {
        next.destination[key] = project(value, [...next.path, key]);
      }
    }
  }
  return { input: redacted, confidentialPaths };
}

type TargetActionApprovalInputField = NonNullable<TargetActionApprovalRequestV1['inputFields']>[number];

/** Choose the declared read-back for the projected intent before presenting or retaining it. */
export function resolveTargetActionConfirmationPresentation(
  confirmation: PluginActionConfirmationV2 | undefined,
  projection: ReturnType<typeof projectTargetActionApprovalInput>,
): Pick<PluginActionConfirmationV2, 'title' | 'body' | 'confirmLabel' | 'inputFields'> | undefined {
  const variant = confirmation?.variant;
  return variant && projection && evaluateInputPredicate(variant.when, projection.input) ? variant : confirmation;
}

/** Declared operands shared by immediate confirmations and retained target Action reviews. */
export function projectTargetActionApprovalOperandRows(
  projection: NonNullable<ReturnType<typeof projectTargetActionApprovalInput>>,
  fields: readonly TargetActionApprovalInputField[],
  resolveText: (text: TargetActionApprovalInputField['title']) => string = resolvePluginLocalizedStringV2Text,
  formatValue?: (path: string, value: unknown) => string | null,
): readonly Extract<ApprovalActionFieldRow, { kind: 'value' }>[] {
  return fields.flatMap(field => {
    const segments = field.path.split('.');
    if (projection.confidentialPaths.some(path => {
      const concealed = path ? path.split('.') : [];
      return concealed.length <= segments.length
        && matchesConfidentialInputPath(segments.slice(0, concealed.length), concealed);
    })) return [];
    const values: unknown[] = [];
    visitSegments(projection.input, segments, 0, values);
    const value = values.length === 1 ? values[0] : undefined;
    const label = typeof value === 'string' && field.valueLabels && Object.hasOwn(field.valueLabels, value)
      ? field.valueLabels[value] : undefined;
    const choice = values.length === 1 ? formatValue?.(field.path, value) : null;
    const literal = label === undefined ? choice ?? formatApprovalFieldValues(values, { preserveStructuredValues: true }) : resolveText(label);
    const reference = choice == null && values.length === 1 ? describeApprovalOperandReference(field.path, value) : undefined;
    return literal === null ? [] : [{
      kind: 'value', path: `input.${field.path}`, title: resolveText(field.title), value: literal, ...(reference ? { reference } : {}),
    }];
  });
}

function describeTargetActionApprovalFields(request: TargetActionApprovalFieldsRequest, context?: ApprovalPresentationContext): ApprovalActionFieldsPresentation {
  const unavailable = (): ApprovalActionFieldsPresentation => {
    const details = { path: 'input', reason: 'missing_required_context' as const };
    return { rows: [{ kind: 'unrepresentable', ...details, title: 'Arguments' }], unrepresentable: details };
  };
  const projection = projectTargetActionApprovalInput(request.input, request.secretInputPaths);
  if (!projection) return unavailable();
  const { input: redacted, confidentialPaths } = projection;
  const confidentialTitle = (path: string): string => {
    const actual = path.split('.');
    const declared = request.secretInputPaths?.find(candidate => matchesConfidentialInputPath(candidate.split('.'), actual));
    return (declared && request.secretInputLabels && Object.hasOwn(request.secretInputLabels, declared)
      ? request.secretInputLabels[declared] : undefined)
      ?? (path ? humanizeApprovalKey(path) : 'Arguments');
  };
  const confidentialRows: ApprovalActionFieldRow[] = confidentialPaths.map(path => ({
    kind: 'value', path: path ? `input.${path}` : 'input', title: confidentialTitle(path),
    value: '', valueFormat: 'confidential',
  }));
  const fields = isRecord(redacted) && Object.keys(redacted).length > 0
    ? Object.entries(redacted).map(([key, value]) => ({ key, value }))
    : [{ key: '', value: redacted }];
  try {
    const fallback = request.inputFields?.length ? undefined : context?.targetActionFieldPresentation;
    const rows = confidentialRows.concat(projectTargetActionApprovalOperandRows(projection,
      fallback?.fields ?? request.inputFields ?? [], context?.resolvePluginConfirmationText, fallback?.formatValue));
    const hasDeclaredFacts = fallback !== undefined || rows.length > confidentialPaths.length;
    for (const { key, value } of fields) {
      if (confidentialPaths.includes('') || confidentialPaths.includes(key)) continue;
      // The built-in formatter deliberately trims and joins values. Arbitrary
      // plugin operands must instead preserve whitespace, nesting and nulls.
      const literal = JSON.stringify(value);
      if (literal === undefined) return unavailable();
      // An operand that names something reads by that name, as on a host Action; its id stays in Technical details.
      const reference = key ? describeApprovalOperandReference(key, value) : undefined;
      // A structured operand has no one-line reading: its exact literal stays disclosed under Technical details.
      const structured = !reference && typeof value === 'object' && value !== null;
      rows.push({ kind: 'value', path: key ? `input.${key}` : 'input',
        title: key ? humanizeApprovalKey(key) : 'Arguments', value: reference && typeof value === 'string' ? value : literal,
        ...(reference ? { reference } : {}),
        ...(hasDeclaredFacts || structured ? { technical: true as const } : {}) });
    }
    // Only the original admitted invocation can supply the hidden operands.
    return { rows, unrepresentable: confidentialPaths.length && request.approvalInputCustody !== 'live_only'
      ? { path: 'input', reason: 'missing_required_context' } : null };
  } catch {
    // JSON admission has no depth quota. If this platform cannot serialize the
    // complete value for its reader, partial disclosure cannot authorize it.
    return unavailable();
  }
}

type TargetActionApprovalFieldsRequest = Readonly<{
  kind: 'plugin_target_action'; input: unknown; secretInputPaths?: readonly string[]; status?: TargetActionApprovalRequestV1['status'];
  secretInputLabels?: Readonly<Record<string, string>>;
  inputFields?: Readonly<NonNullable<TargetActionApprovalRequestV1['inputFields']>>;
  approvalInputCustody?: 'live_only';
}>;

function isTargetActionApprovalFieldsRequest(request: object): request is TargetActionApprovalFieldsRequest {
  return 'kind' in request && request.kind === 'plugin_target_action';
}

export function describeApprovalRequestFields(
  request: (Pick<ApprovalRequest, 'actionId' | 'actionArgs' | 'preview'> & Partial<Pick<ApprovalRequest, 'status'>>)
    | TargetActionApprovalFieldsRequest,
  context?: ApprovalPresentationContext,
): ApprovalActionFieldsPresentation {
  // `'actionId' in request` would leave the target member as `& Record<'actionId', unknown>`.
  if (isTargetActionApprovalFieldsRequest(request)) {
    return describeTargetActionApprovalFields(request, context);
  }
  const actionPresentation = describeApprovalActionFields({
    actionId: request.actionId,
    actionArgs: request.actionArgs,
    ...(context ? { context } : {}),
    ...(request.status === undefined ? {} : { status: request.status }),
    ...(request.preview === undefined ? {} : { preview: request.preview }),
  });
  const pluginInstallDisclosure = describePluginInstallApprovalDisclosure(request);
  const presentation = pluginInstallDisclosure
    ? {
        rows: [...actionPresentation.rows, ...pluginInstallDisclosure.rows],
        unrepresentable: actionPresentation.unrepresentable ?? pluginInstallDisclosure.unrepresentable,
      }
    : actionPresentation;
  // A consumed request is history, not another admission attempt. Missing historical
  // operands remain visibly unavailable; never offer rejection/re-submission as its next action.
  if (request.status && ['executed', 'failed', 'outcome_unknown', 'rejected', 'canceled'].includes(request.status)) {
    return { rows: presentation.rows.map(row => row.kind === 'unrepresentable'
      ? { kind: 'value' as const, path: row.path, title: row.title, value: '', valueFormat: 'unavailable' as const } : row),
      unrepresentable: null };
  }
  return presentation;
}

/**
 * The single Protocol-owned admission for an Approve decision.
 *
 * Released V1 requests stay readable and rejectable, but cannot prove the
 * immutable execution origin needed for replay. Current requests additionally
 * fail closed when the Action's required observation-safe context could not be
 * represented. UI controls and the executor consume this same result so a
 * button cannot advertise an effect that the decision owner will reject.
 */
export function resolveApprovalRequestApproveAdmission(
  request: ApprovalRequest, context?: ApprovalPresentationContext,
): ApprovalRequestApproveAdmission;
export function resolveApprovalRequestApproveAdmission(
  request: ApprovalRequest | TargetActionApprovalRequestV1, context?: ApprovalPresentationContext,
): TargetActionApprovalApproveAdmission;
export function resolveApprovalRequestApproveAdmission(
  request: ApprovalRequest | TargetActionApprovalRequestV1, context?: ApprovalPresentationContext,
): TargetActionApprovalApproveAdmission {
  if (!('actionId' in request)) {
    const presentation = describeApprovalRequestFields(request, context);
    const origin = request.executionOriginV1;
    // Native Machine confirmation stays with the mounted press. Older builds
    // could leave a detached request in its place, without the admitted checks.
    if (request.status === 'open' && request.approvalInputCustody === 'live_only'
      && !request.automaticChecks && !request.requesterConfirmation
      && request.requestedSurface === 'ui' && origin?.surface === 'ui'
      && origin.authority === 'present_user' && origin.caller.kind === 'host'
      && !origin.hostChild && request.replayPlacement
      && request.replayPlacement.serverId === origin.serverId
      && request.replayPlacement.machineId === origin.machineId) {
      return { status: 'unavailable', reason: 'live_invocation_unavailable', presentation };
    }
    return presentation.unrepresentable
      ? { status: 'unavailable', reason: 'context_unavailable', details: presentation.unrepresentable, presentation }
      : { status: 'available', presentation };
  }
  // Current durable requests retain the complete replay input. Validate before
  // typed projectors run; live-only records validate their private operands at
  // the invocation owner and keep only safe observation fields here.
  if (request.v === 2) {
    const actionId = ActionIdSchema.safeParse(request.actionId);
    if (actionId.success) {
      const spec = getActionSpec(actionId.data);
      if (spec.projectObservationInput && spec.approvalInputCustody !== 'live_only') {
        const admitted = spec.inputSchema.safeParse(request.actionArgs);
        if (!admitted.success) {
          const details = { path: admitted.error.issues[0]?.path.join('.') ?? '', reason: 'missing_required_context' as const };
          return { status: 'unavailable', reason: 'context_unavailable', details,
            presentation: { rows: [{ kind: 'unrepresentable', ...details, title: spec.title }], unrepresentable: details } };
        }
      }
    }
  }
  const presentation = describeApprovalRequestFields(request, context);
  if (request.v === 1 || !ActionIdSchema.safeParse(request.actionId).success) {
    return { status: 'unavailable', reason: 'legacy_request', presentation };
  }
  if (presentation.unrepresentable) {
    return {
      status: 'unavailable',
      reason: 'context_unavailable',
      details: presentation.unrepresentable,
      presentation,
    };
  }
  return { status: 'available', presentation };
}
