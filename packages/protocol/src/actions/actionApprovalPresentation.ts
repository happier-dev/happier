import { StructuredQuestionAnswersV1Schema } from '../tools/structuredQuestionAnswersV1.js';
import { ApprovalRequestSchema, ApprovalRequestV1Schema, ApprovalRequestV2Schema, type ApprovalExecutionOriginV1, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '../approvals/targetActionApprovalRequestV1.js';
import { AgentRuntimeJsonValueV1Schema } from '../runtime/agentSessionV1.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { InputPathSchema } from '../inputs/inputPredicates.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveEffectiveActionInputFields } from './actionInputHintsRuntime.js';
import { actionInputFieldAcceptsNull } from './actionInputSchemaPath.js';
import { ActionIdSchema, type ActionId } from './actionIds.js';
import { VoiceConversationTargetSchema } from './voiceConversationActionFamily.js';
import type { ActionInputFieldHint, ActionInputOption } from './actionInputHintsRuntime.js';
import { readCanonicalPaddedBase64DecodedLength } from '../crypto/base64.js';
import { normalizeUiSurfaceCapabilityRequestV1 } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { SessionVisualReviewedAdmissionV1Schema } from '../sessions/board/actions.js';
import { SessionSurfaceItemV1Schema, type SessionSurfaceItemV1 } from '../sessions/board/item.js';
import { resolveSessionVisualEffectiveCapabilitiesV1 } from '../sessions/board/visualPolicy.js';
import { z } from 'zod/mini';
import { readWidgetActionSurfaceV1 } from '../widgets/actionsV1.js';
import { unwrapActionInputSchema } from './actionInputSchemaPath.js';
import { isSettingsDeclarationActionIdV1 } from './settingsDeclarationActionFamily.js';
import { readBuiltInSettingDeclarationV1 } from './settings/settingsDeclarations.js';
import { ReachPlaceV1Schema } from '../reach/reachPlaceV1.js';
import { ReachRuleDraftV1Schema } from '../reach/reachRuleV1.js';
import { ReachRulesChangeV1Schema } from '../reach/reachRulesChangeV1.js';
import { BackendTargetRefV2InputSchema, parseBackendTargetKeyV2, readBackendTargetRefV2 } from '../backends/targets/backendTargetRefV2.js';
import {
  PluginChangePendingReviewResultSchema,
  type PluginChangePendingReviewResult,
} from '../marketplace/pluginInstallationReviewV1.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Public reads never spend or transport the private Artifact's replay authority. */
function projectPublicApprovalExecutionOrigin(origin: ApprovalExecutionOriginV1) {
  const { externalActionExecutionAuthorization: _authorization, externalActionInputSignature: _signature,
    originalActionEnvelope: _envelope, ...metadata } = origin;
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
  return {
    executedAtMs: execution.executedAtMs, ok: execution.ok,
    ...(currentExecution?.effectAttempted !== undefined
      ? { effectAttempted: currentExecution.effectAttempted } : {}),
    ...(execution.ok && execution.result !== undefined ? { result: project ? project(execution.result) : execution.result } : {}),
    ...(execution.errorCode === undefined ? {} : { errorCode: execution.errorCode }),
    ...(execution.error === undefined ? {} : { error: execution.error }),
    ...(request.v === 2 && request.execution?.details !== undefined ? { details: request.execution.details } : {}),
    ...(operationCredentialUses?.length ? { operationCredentialUses } : {}),
  };
}

/** Shared by every public approval Action surface; private Artifact readers retain custody. */
export function projectApprovalRequestForPublicRead(request: ApprovalRequest | TargetActionApprovalRequestV1): unknown {
  const target = TargetActionApprovalRequestV1Schema.safeParse(request);
  if (target.success) return {
    ...target.data,
    input: target.data.secretInputPaths === undefined ? null
      : projectTargetActionApprovalInput(target.data.input, target.data.secretInputPaths)?.input ?? null,
    ...(target.data.executionOriginV1
      ? { executionOriginV1: projectPublicApprovalExecutionOrigin(target.data.executionOriginV1) } : {}),
    ...(target.data.decision ? { decision: {
      kind: target.data.decision.kind, decidedAtMs: target.data.decision.decidedAtMs,
      ...(target.data.decision.decidedVia === 'voice' ? { decidedVia: 'voice' } : {}),
    } } : {}),
    ...(target.data.execution ? { execution: projectApprovalExecutionForObservation(target.data) } : {}),
  };
  const builtIn = ApprovalRequestSchema.parse(request);
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
  /** An epoch-millisecond moment (`archivedAt`): the client reads it as a localized time. */
  valueFormat?: 'timestamp';
}>;

export type ApprovalActionFieldRow =
  | Readonly<{
    kind: 'value'; path: string; title: string; value: string; reference?: ApprovalActionReference;
    /** A boolean choice reads through the client's localized yes/no labels. */
    valueFormat?: 'boolean' | 'unavailable' | 'confidential' | 'timestamp';
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
  | Readonly<{ kind: 'home'; id: string }>
  | Readonly<{ kind: 'account'; id: string }>
  | Readonly<{ kind: 'setting'; id: string }>
  | Readonly<{ kind: 'providerConnection'; id: string; displayName?: string; catalogSourceKey?: string; agentTargetKey?: string }>
  | Readonly<{ kind: 'providerModel'; id: string; connectionId: string; agentTargetKey: string; catalogSourceKey?: string }>
  | Readonly<{ kind: 'providerContribution'; id: string }>
  /** An Agent's own model (no Provider connection): read by the Agent catalog's title for it. */
  | Readonly<{ kind: 'agentModel'; id: string; agentTargetKey: string }>
  /** The Connected Account (or pool) one connected service is bound to: read as "Service · account". */
  | Readonly<{ kind: 'connectedAccount'; id: string; service: string; pool?: true }>
  | Readonly<{ kind: 'managedMachine'; id: string; homeId: string }>
  | Readonly<{ kind: 'artifact' | 'skill' | 'mcpServer' | 'project' | 'agent' | 'registrySource'; id: string }>
  | Readonly<{ kind: 'machine'; id: string; workspaceRoot?: string }>
  /** A workspace the app already knows (a ref id): read by its folder name and its machine. */
  | Readonly<{ kind: 'workspace'; id: string }>
  /** A persisted workspace-sync link: read by the two folders it joins and their machines. */
  | Readonly<{ kind: 'workspaceSyncRelationship'; id: string }>;

// These are declared Action field keys, not a guess from an opaque value or suffix.
const SESSION_REFERENCE_KEYS = new Set([
  'sessionId', 'managerSessionId', 'expectedManagerSessionId', 'leadSessionId', 'expectedLeadSessionId',
  'sourceSessionId', 'targetSessionId',
  'underSessionId', 'parentSessionId', 'originSessionId',
]);

/** A declared reference key read by its name: a session, a Home or an Account. */
function describeApprovalKeyReference(key: string | undefined, value: unknown): ApprovalActionReference | undefined {
  if (typeof value !== 'string' || !value.trim() || key === undefined) return undefined;
  if (SESSION_REFERENCE_KEYS.has(key)) return { kind: 'session', id: value.trim() };
  if (key === 'serverId') return { kind: 'home', id: value.trim() };
  if (key === 'accountId') return { kind: 'account', id: value.trim() };
  return undefined;
}

/**
 * What says nothing about the request's target: a schema version, a concurrency revision or an empty
 * value. Target ids stay in view, so an approval always shows exactly what it acts on; only a named
 * reference moves its raw id.
 */
function isTechnicalApprovalKey(key: string | undefined): boolean {
  return key === 'v' || key === 'expectedRevision' || key === 'expectedIntentRevision'
    // A retry key makes a request idempotent; it says nothing about what the request does.
    || key === 'creationKey' || key === 'idempotencyKey';
}

/** An Agent target (a target key or a typed target) read as the Agent it names. */
function readApprovalAgentReference(value: unknown): ApprovalActionReference | undefined {
  const target = BackendTargetRefV2InputSchema.safeParse(value);
  if (!target.success) return undefined;
  try {
    return { kind: 'agent', id: readBackendTargetRefV2(target.data).backendId };
  } catch {
    // Non-bundled identities are resolved by the host's Agent catalog, not by a protocol registry.
    try {
      const persisted = typeof target.data === 'string' ? parseBackendTargetKeyV2(target.data) : target.data;
      if (persisted.kind === 'agent' && 'identity' in persisted) return { kind: 'agent', id: persisted.definitionId
        ?? `${persisted.identity.pluginId}/${persisted.identity.localId}` };
    } catch { /* Malformed references remain literal approval context. */ }
  }
  return undefined;
}

/** A model selection (`{ ref: { agentTargetKey, providerConnectionId, modelId } }`) read as the model it chose. */
function readApprovalModelReference(value: unknown): ApprovalActionReference | undefined {
  const ref = isRecord(value) && isRecord(value.ref) ? value.ref : null;
  if (!ref || typeof ref.modelId !== 'string' || !ref.modelId.trim() || typeof ref.agentTargetKey !== 'string') return undefined;
  if (typeof ref.providerConnectionId === 'string' && ref.providerConnectionId.trim()) {
    return { kind: 'providerModel', id: ref.modelId, connectionId: ref.providerConnectionId, agentTargetKey: ref.agentTargetKey };
  }
  return ref.providerConnectionId === null || ref.providerConnectionId === undefined
    ? { kind: 'agentModel', id: ref.modelId, agentTargetKey: ref.agentTargetKey } : undefined;
}

function describeApprovalReference(actionId: string, field: ActionInputFieldHint, values: readonly unknown[], input: unknown): ApprovalActionReference | undefined {
  if (values.length !== 1) return undefined;
  const value = values[0];
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
  const leaf = field.path.split('.').at(-1);
  // Declared target fields name an Agent and a model wherever an Action carries them.
  if (leaf === 'agentTarget') return readApprovalAgentReference(value);
  if (leaf === 'modelSelection') return readApprovalModelReference(value);
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (actionId.startsWith('machines.managed.') && field.path === 'managedId'
      && isRecord(input) && typeof input.homeId === 'string' && input.homeId.trim()) {
    return { kind: 'managedMachine', id: value.trim(), homeId: input.homeId.trim() };
  }
  // A Home identity reads by the Home's name, like a `serverId` key.
  if (field.path === 'homeId') return { kind: 'home', id: value.trim() };
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
  // A Machine id names a Machine on every Action (`machineId`, `executionTarget.machineId`).
  if (leaf === 'machineId') return { kind: 'machine', id: value };
  if ((actionId === 'skills.rules.set' || actionId === 'mcp.rules.set') && field.path === 'change.write.agentId') return { kind: 'agent', id: value };
  if (actionId.startsWith('registries.sources.') && field.path === 'sourceId') return { kind: 'registrySource', id: value };
  if (field.path === 'anchor' && isSettingsDeclarationActionIdV1(actionId) && readBuiltInSettingDeclarationV1(value)) {
    return { kind: 'setting', id: value };
  }
  if (actionId.startsWith('providers.')) {
    const catalogSourceKey = isRecord(input) && typeof input.catalogSourceKey === 'string'
      ? { catalogSourceKey: input.catalogSourceKey } : {};
    if (field.path === 'connectionId') {
      const name = isRecord(input) && typeof input.displayName === 'string' ? input.displayName.trim() : '';
      const agentTargetKey = isRecord(input) && typeof input.agentTargetKey === 'string' ? input.agentTargetKey : null;
      return { kind: 'providerConnection', id: value.trim(), ...catalogSourceKey, ...(name ? { displayName: name } : {}),
        ...(agentTargetKey ? { agentTargetKey } : {}) };
    }
    if (field.path === 'contributionKey') return { kind: 'providerContribution', id: value.trim() };
    if (field.path === 'modelId' && isRecord(input) && typeof input.connectionId === 'string'
        && typeof input.agentTargetKey === 'string') {
      return { kind: 'providerModel', id: value, connectionId: input.connectionId,
        agentTargetKey: input.agentTargetKey, ...catalogSourceKey };
    }
    if (field.path === 'agentTargetKey') return readApprovalAgentReference(value);
  }
  const key = field.path.split('.').at(-1);
  const reference = field.inputType && 'hostType' in field.inputType && field.inputType.hostType === 'session'
    ? { kind: 'session' as const, id: value.trim() }
    : describeApprovalKeyReference(key, value);
  return actionId === 'session.delete' && field.path === 'sessionId' && reference?.kind === 'session'
    ? { ...reference, presentation: 'destructive_target' }
    : reference;
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
  const entries: ApprovalStructuredValueEntry[] = [];
  appendApprovalStructuredMembers(pendingReview.review, 0, entries);
  return {
    rows: [{
      kind: 'value',
      path: `${path}.review`,
      title: 'Daemon-evaluated install and trust disclosure',
      value: JSON.stringify(pendingReview.review),
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
  const displayValues = options.preserveStructuredValues ? values : values.flatMap((value) => (Array.isArray(value) ? value : [value]));
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

function appendApprovalStructuredEntries(
  key: string | undefined,
  label: string,
  value: unknown,
  depth: number,
  output: ApprovalStructuredValueEntry[],
  widgetStructure = false,
): void {
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
    const reference = keyReference?.kind === 'session' ? undefined : keyReference;
    const technical = !reference && (isTechnicalApprovalKey(key) || isEmptyApprovalValue(value)
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

function appendApprovalStructuredMembers(value: unknown, depth: number, output: ApprovalStructuredValueEntry[], widgetStructure = false): void {
  const members: [string | undefined, string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [undefined, String(index + 1), item])
    : Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, humanizeApprovalKey(key), item]);
  for (const [key, label, item] of members) appendApprovalStructuredEntries(key, label, item, depth, output, widgetStructure);
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

/** Readable entries for one structured JSON value; scalars and flat lists read fine as they are. */
function describeApprovalStructuredValue(values: readonly unknown[], widgetStructure = false): readonly ApprovalStructuredValueEntry[] | undefined {
  if (values.length !== 1 || isApprovalScalar(values[0])) return undefined;
  const output: ApprovalStructuredValueEntry[] = [];
  appendApprovalStructuredMembers(values[0], 0, output, widgetStructure);
  return output;
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

/** One Protocol-owned reading governs both rendered fields and approval admission. */
export function describeApprovalActionFields(input: Readonly<{
  actionId: string;
  actionArgs: unknown;
  preview?: unknown;
  status?: ApprovalRequest['status'];
}>): ApprovalActionFieldsPresentation {
  let spec;
  try {
    spec = getActionSpec(input.actionId as ActionId);
  } catch {
    return { rows: [], unrepresentable: { path: '', reason: 'missing_required_context' } };
  }
  const review = spec.approvalPresentation;
  const settled = input.status && ['executed', 'failed', 'rejected', 'canceled'].includes(input.status);
  // Safe presentation data is not executable input. Only terminal history or a
  // live-only continuation can read its declared schema from stored review.
  const storedReview = review?.inputSchema && (settled || spec.approvalInputCustody === 'live_only')
    ? review.inputSchema.safeParse(spec.approvalInputCustody === 'live_only'
      ? readApprovalPresentationPreview(input)?.actionArgs : input.actionArgs) : null;
  if (review?.projectInput && !spec.inputSchema.safeParse(input.actionArgs).success && !storedReview?.success) {
    const reason = 'missing_required_context' as const;
    return { rows: [{ kind: 'unrepresentable', path: '', title: spec.title, reason }],
      unrepresentable: { path: '', reason } };
  }
  // Observation previews can intentionally omit private domain content. Only the domain's
  // explicit review projection may disclose that content; never fall back to raw secret input.
  const projectedInput = storedReview?.success ? storedReview.data : review?.projectInput
    ? review.projectInput(input.actionArgs)
    : resolveApprovalPresentationInput(input);
  const parsedReview = review?.inputSchema?.safeParse(projectedInput);
  if (parsedReview && !parsedReview.success) {
    const reason = 'missing_required_context' as const;
    return { rows: [{ kind: 'unrepresentable', path: '', title: spec.title, reason }], unrepresentable: { path: '', reason } };
  }
  const presentationInput = parsedReview?.success ? parsedReview.data : projectedInput;
  const presentationSpec = review?.inputSchema || review?.inputHints
    ? { ...spec, inputSchema: review.inputSchema ?? spec.inputSchema, inputHints: review.inputHints ?? spec.inputHints } : spec;
  const resolved = [...resolveEffectiveActionInputFields(presentationSpec, presentationInput)];
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
  const keys = new Set((presentationSpec.inputHints?.fields.length ?? 0) === 0
    ? [...schemaKeys, ...(isRecord(presentationInput) ? Object.keys(presentationInput) : [])]
    : []);
  for (const path of keys) {
    if (coveredRoots.has(path)) continue;
    const fieldSchema = shape[path];
    resolved.push({ path, title: humanizeApprovalKey(path), widget: 'json', visible: true, disabled: false,
      required: fieldSchema !== undefined && !z.safeParse(fieldSchema, undefined).success });
  }
  const paths = resolved.map((field) => field.path);
  // The Action declares which operands only identify or route the request; they read under Technical details.
  const technicalPaths = spec.approvalPresentation?.technicalInputPaths ?? [];
  const structuredAnswerPath = STRUCTURED_ANSWER_FIELD_PATH_BY_ACTION_ID[input.actionId];
  const rows: ApprovalActionFieldRow[] = [];
  let unrepresentable: ApprovalActionFieldsPresentation['unrepresentable'] = resolved.length === 0
    && (!isRecord(presentationInput) || Object.keys(presentationInput).length > 0
      || (isRecord(input.actionArgs) && Object.keys(input.actionArgs).length > 0))
    ? { path: '', reason: 'missing_required_context' } : null;

  for (const field of resolved) {
    if (shouldHideApprovalField(field.path, paths)) continue;
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
    const literal = formatApprovalFieldValues(values, { preserveStructuredValues: field.widget === 'json' });
    // A chosen option reads by the label the form that set it shows.
    const option = field.widget === 'select' && values.length === 1
      ? field.options?.find((candidate) => candidate.value === values[0]) : undefined;
    const rulesAction = input.actionId === 'skills.rules.set' || input.actionId === 'mcp.rules.set';
    const reachPlace = rulesAction && field.path === 'change.write.place' || field.path === 'where.write.place';
    const place = reachPlace ? ReachPlaceV1Schema.safeParse(values[0]) : null;
    const selectedOptions: readonly Pick<ActionInputOption, 'label' | 'labelKey'>[] | undefined = option ? [option]
      : (field.widget === 'multiselect' || field.widget === 'text_list') && field.options
        ? values.flatMap(value => Array.isArray(value) ? value : [value]).map(value =>
          field.options?.find(candidate => candidate.value === value) ?? { label: String(value) }) : undefined;
    const choices = selectedOptions?.map(option => option.label).join(', ');
    const value = place?.success && place.data.t === 'allMachines' ? 'Everywhere'
      : choices || (option && typeof option.label === 'string' ? option.label : literal);
    if (value === null) {
      // A required field whose schema declares `null` and that carries exactly
      // that null is present context with nothing to display, not missing context.
      const declaredNull = values.length > 0
        && values.every((entry) => entry === null)
        && actionInputFieldAcceptsNull(spec, field.path);
      // Live-only input deliberately leaves required private fields out of the
      // durable observation projection. Their presence is guaranteed by the
      // admitted invocation that retains the raw input; omission here means
      // withheld, not missing approval context.
      const withheldByLiveOnlyCustody = spec.approvalInputCustody === 'live_only';
      if (field.required && !declaredNull && !withheldByLiveOnlyCustody) {
        const reason = 'missing_required_context' as const;
        unrepresentable ??= { path: field.path, reason };
        rows.push({ kind: 'unrepresentable', path: field.path, title: field.title, reason });
      }
      continue;
    }
    const reference = reachPlace ? describeApprovalPlaceReference(values[0]) : describeApprovalReference(input.actionId, field, values, presentationInput);
    // A typed value that reads as one word or path ("Directory  /repo") needs no entries under it.
    const kindValue = field.widget === 'json' && !reference && !place?.success && values.length === 1
      ? readApprovalKindValue(values[0]) : null;
    // A typed reference already reads by its name; entries are for values nothing else can read.
    let entries = (rulesAction && field.path === 'change.rules' || field.path === 'where.rules') ? describeApprovalRuleEntries(values)
      : rulesAction && field.path.startsWith('items.') && values.length > 1 ? values.map(value => ({
        label: field.title, value: String(value), depth: 0,
        reference: describeApprovalReference(input.actionId, field, [value], presentationInput),
      }))
      : field.widget === 'json' && !reference && !place?.success ? describeApprovalStructuredValue(values,
        input.actionId.startsWith('widgets.') && (['instance', 'group', 'fragment', 'definition'].includes(field.path)
          || ['surface', 'ref', 'to'].includes(field.path)
            && readWidgetActionSurfaceV1(input.actionArgs)?.owner.kind === 'pluginArea')) : undefined;
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
    if (kindValue !== null) entries = undefined;
    const technical = technicalPaths.includes(field.path)
      || !reference && (isTechnicalApprovalKey(field.path.split('.').at(-1))
      || values.length > 0 && values.every(isEmptyApprovalValue) && !(rulesAction && field.path === 'change.rules')
      // The visual summary already names this item. Preserve its exact identity
      // in Details, rather than adding an opaque id to that first reading.
      || field.path === 'itemId' && Boolean(readApprovalVisualItem(input.actionId, presentationInput)?.title?.trim())
      || input.actionId.startsWith('providers.') && field.path === 'action'
      // The terminal key is how the daemon finds its terminal and its size is the client's pane; people know the terminal by its folder and Machine.
      || input.actionId === 'agents.acp.backends.upsert' && ['backend.id', 'backend.name'].includes(field.path)
      || (input.actionId.startsWith('widgets.fragment.') || input.actionId.startsWith('widgets.definition.'))
        && (field.path === 'artifactId' || field.path === 'newArtifactId'));
    // `field.member` marks that direct member of a structured value (its target's own id, say).
    const technicalMembers = technicalPaths.filter((path) => path.startsWith(`${field.path}.`))
      .map((path) => humanizeApprovalKey(path.slice(field.path.length + 1)));
    if (entries && technicalMembers.length > 0) {
      entries = entries.map((entry) => entry.depth === 0 && entry.value !== null && technicalMembers.includes(entry.label)
        ? { ...entry, technical: true as const } : entry);
    }
    rows.push({
      // An intent read as its value ("Directory intent" → "Directory  /repo") is named by what it is.
      kind: 'value', path: field.path, title: kindValue !== null ? field.title.replace(/\s+intent$/i, '') : field.title,
      value: kindValue ?? value,
      ...(selectedOptions?.some(option => option.labelKey) ? { selectedOptions: selectedOptions.map(({ label, labelKey }) => ({
        label, ...(labelKey ? { labelKey } : {}),
      })) } : {}),
      ...(reference ? { reference } : {}),
      ...(values.length === 1 && typeof values[0] === 'boolean' ? { valueFormat: 'boolean' as const } : {}),
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
  return { rows: rows.map((row) => row.kind === 'value' && row.entries && !row.technical
    && !row.entries.some((entry) => entry.value !== null && !entry.technical) ? { ...row, technical: true as const } : row), unrepresentable };
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

/** What network an HTML visual gets once approved, using the host-captured admission facts. */
function describeApprovalVisualNetwork(actionId: string, input: unknown): ApprovalActionFieldRow | null {
  const source = readApprovalVisualItem(actionId, input)?.source;
  if (!source || source.kind !== 'hostedHtml') return null;
  // An invalid request is refused by admission; it has no network to state.
  const capabilities = normalizeUiSurfaceCapabilityRequestV1(source.requestedCapabilities);
  if (!capabilities) return null;
  const reviewed = SessionVisualReviewedAdmissionV1Schema.safeParse(isRecord(input) ? input.reviewedVisual : undefined);
  const policy = resolveSessionVisualEffectiveCapabilitiesV1(capabilities, {
    isCreate: isRecord(input) && input.expectedItemRevision === null,
    networkSetting: reviewed.success ? reviewed.data.networkSetting : null,
  });
  return { kind: 'value', path: 'item.source.requestedCapabilities', title: 'Network', value: describeApprovalNetworkValue(policy) };
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
 * Installed Actions have no built-in ActionSpec. Their admitted JSON is the
 * review contract; never use the static manifest confirmation as its substitute.
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
    if (secretPaths.some(secret => secret.length === path.length
      && secret.every((segment, index) => segment === '[]' || segment === path[index]))) {
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

function describeTargetActionApprovalFields(request: TargetActionApprovalFieldsRequest): ApprovalActionFieldsPresentation {
  const unavailable = (): ApprovalActionFieldsPresentation => {
    const details = { path: 'input', reason: 'missing_required_context' as const };
    return { rows: [{ kind: 'unrepresentable', ...details, title: 'Arguments' }], unrepresentable: details };
  };
  const projection = projectTargetActionApprovalInput(request.input, request.secretInputPaths);
  if (!projection) return unavailable();
  const { input: redacted, confidentialPaths } = projection;
  const confidentialTitle = (path: string): string => {
    const declared = request.secretInputPaths?.find(candidate => {
      const segments = candidate.split('.');
      const actual = path.split('.');
      return segments.length === actual.length && segments.every((segment, index) => segment === '[]' || segment === actual[index]);
    });
    return (declared && request.secretInputLabels && Object.hasOwn(request.secretInputLabels, declared)
      ? request.secretInputLabels[declared] : undefined)
      ?? (path ? humanizeApprovalKey(path) : 'Arguments');
  };
  const rows: ApprovalActionFieldRow[] = confidentialPaths.map(path => ({
    kind: 'value', path: path ? `input.${path}` : 'input', title: confidentialTitle(path),
    value: '', valueFormat: 'confidential',
  }));
  const fields = isRecord(redacted) && Object.keys(redacted).length > 0
    ? Object.entries(redacted).map(([key, value]) => ({ key, value }))
    : [{ key: '', value: redacted }];
  try {
    for (const { key, value } of fields) {
      if (confidentialPaths.includes('') || confidentialPaths.includes(key)) continue;
      // The built-in formatter deliberately trims and joins values. Arbitrary
      // plugin operands must instead preserve whitespace, nesting and nulls.
      const literal = JSON.stringify(value);
      if (literal === undefined) return unavailable();
      rows.push({ kind: 'value', path: key ? `input.${key}` : 'input',
        title: key ? humanizeApprovalKey(key) : 'Arguments', value: literal });
    }
  } catch {
    // JSON admission has no depth quota. If this platform cannot serialize the
    // complete value for its reader, partial disclosure cannot authorize it.
    return unavailable();
  }
  // Only the original admitted invocation can supply the hidden operands.
  return { rows, unrepresentable: confidentialPaths.length && request.approvalInputCustody !== 'live_only'
    ? { path: 'input', reason: 'missing_required_context' } : null };
}

type TargetActionApprovalFieldsRequest = Readonly<{
  kind: 'plugin_target_action'; input: unknown; secretInputPaths?: readonly string[]; status?: TargetActionApprovalRequestV1['status'];
  secretInputLabels?: Readonly<Record<string, string>>;
  approvalInputCustody?: 'live_only';
}>;

function isTargetActionApprovalFieldsRequest(request: object): request is TargetActionApprovalFieldsRequest {
  return 'kind' in request && request.kind === 'plugin_target_action';
}

export function describeApprovalRequestFields(
  request: (Pick<ApprovalRequest, 'actionId' | 'actionArgs' | 'preview'> & Partial<Pick<ApprovalRequest, 'status'>>)
    | TargetActionApprovalFieldsRequest,
): ApprovalActionFieldsPresentation {
  // `'actionId' in request` would leave the target member as `& Record<'actionId', unknown>`.
  if (isTargetActionApprovalFieldsRequest(request)) {
    return describeTargetActionApprovalFields(request);
  }
  const actionPresentation = describeApprovalActionFields({
    actionId: request.actionId,
    actionArgs: request.actionArgs,
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
  if (request.status && ['executed', 'failed', 'rejected', 'canceled'].includes(request.status)) {
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
  request: ApprovalRequest | TargetActionApprovalRequestV1,
): ApprovalRequestApproveAdmission {
  if (!('actionId' in request)) {
    const presentation = describeApprovalRequestFields(request);
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
  const presentation = describeApprovalRequestFields(request);
  if (request.v === 1) {
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
