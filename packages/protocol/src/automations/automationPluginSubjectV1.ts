import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '../plugins/actions/jsonSchemaValidation.js';
import { readInputPath } from '../inputs/inputPredicates.js';
import type { PluginSubjectKindContributionV1 } from '../plugins/contributions/subjectKinds.js';
import type { PluginSubjectProjectionV1 } from '../plugins/actions/v2.js';
import type { ActionDefinitionSummaryV1 } from '../actions/actionDefinitionV1.js';
import { AutomationSubjectV1Schema, type AutomationSubjectV1, type AutomationSubjectContextV1 } from './automationSubjectV1.js';

type PluginAutomationSubjectV1 = Extract<AutomationSubjectV1, { kind: 'plugin' }>;
/** Existing catalog entries retain plugin qualification beside their local descriptor. */
export type PluginAutomationSubjectKindDeclarationV1 = Readonly<{
  pluginId: string;
  definition: PluginSubjectKindContributionV1;
}>;
export type PluginAutomationSubjectReadV1 = Readonly<
  | { ok: true; subject: PluginAutomationSubjectV1 }
  | { ok: false; code: 'subject_kind_unavailable' | 'invalid_subject_identity' }
>;
export type PluginAutomationSubjectProjectionReadV1 = Readonly<
  | { ok: true; subjects: readonly AutomationSubjectContextV1[] }
  | { ok: false; code: 'subject_kind_unavailable' | 'invalid_subject_identity' }
>;

/** Action-trigger authoring consumes the operand declared by the selected Action. */
export function isPluginAutomationActionSubjectV1(subject: PluginAutomationSubjectV1, action: Readonly<{
  pluginId: string;
  approvalScope?: ActionDefinitionSummaryV1['approvalScope'];
}>): boolean {
  return action.pluginId === subject.pluginId && typeof action.approvalScope === 'object'
    && action.approvalScope.subjectKindId === subject.subjectKindId;
}

/** Kind lookup uses the same qualified catalog at picker discovery and identity admission. */
export function readPluginAutomationSubjectKindV1(params: Readonly<{
  pluginId: string;
  subjectKindId: string;
  subjectKinds: readonly PluginAutomationSubjectKindDeclarationV1[];
}>): PluginSubjectKindContributionV1 | undefined {
  return params.subjectKinds.find(kind => kind.pluginId === params.pluginId
    && kind.definition.id === params.subjectKindId)?.definition;
}

/** The declaration's identity schema is admitted once at the subject ingress. */
export function readPluginAutomationSubjectV1(params: Readonly<{
  serverId: string;
  pluginId: string;
  subjectKindId: string;
  identity: unknown;
  subjectKinds: readonly PluginAutomationSubjectKindDeclarationV1[];
}>): PluginAutomationSubjectReadV1 {
  const declaration = readPluginAutomationSubjectKindV1(params);
  if (!declaration) return { ok: false, code: 'subject_kind_unavailable' };
  const parsed = AutomationSubjectV1Schema.safeParse({ kind: 'plugin', serverId: params.serverId,
    pluginId: params.pluginId, subjectKindId: params.subjectKindId, identity: params.identity });
  if (!parsed.success || parsed.data.kind !== 'plugin') return { ok: false, code: 'invalid_subject_identity' };
  let validatesIdentity: ReturnType<typeof compilePluginJsonSchema>;
  try { validatesIdentity = compilePluginJsonSchema(declaration.identitySchema); }
  catch { return { ok: false, code: 'subject_kind_unavailable' }; }
  if (!isValidPluginJsonSchemaValue(validatesIdentity, parsed.data.identity)) return { ok: false, code: 'invalid_subject_identity' };
  return { ok: true, subject: parsed.data };
}

/** Action inputs and Event payloads consume the same admitted operand projection. */
export function projectPluginAutomationSubjectsV1(params: Readonly<{
  serverId: string;
  pluginId: string;
  value: unknown;
  projections: readonly PluginSubjectProjectionV1[];
  subjectKinds: readonly PluginAutomationSubjectKindDeclarationV1[];
}>): PluginAutomationSubjectProjectionReadV1 {
  const subjects: AutomationSubjectContextV1[] = [];
  for (const projection of params.projections) {
    const read = readPluginAutomationSubjectV1({ ...params, subjectKindId: projection.subjectKindId,
      identity: readInputPath(params.value, projection.identityField) });
    if (!read.ok) return read;
    subjects.push({ role: 'operand', subject: read.subject });
  }
  return { ok: true, subjects };
}
