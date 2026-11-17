import { SavedHealthCheckSelectorV1Schema } from '../../deployments/healthCheckSourceV1.js';
import { readPluginAutomationSubjectKindV1, projectPluginAutomationSubjectsV1, type PluginAutomationSubjectKindDeclarationV1, type PluginAutomationSubjectProjectionReadV1 } from '../../automations/automationPluginSubjectV1.js';
import { readRecord } from '../../inputs/inputRecords.js';
import type { PluginActionApprovalScopeV2 } from './v2.js';

/** Static picker metadata comes from the same approval scope used at invocation. */
export function readPluginActionApprovalScopeSubjectKindV1(args: Readonly<{
  declaration: PluginActionApprovalScopeV2 | undefined;
  pluginId: string;
  subjectKinds: readonly PluginAutomationSubjectKindDeclarationV1[];
}>): Readonly<
  | { ok: true; subjectKind: null | Readonly<{ kind: Extract<PluginActionApprovalScopeV2, string> }>
      | Readonly<{ kind: 'plugin'; pluginId: string; subjectKindId: string;
          definition: NonNullable<ReturnType<typeof readPluginAutomationSubjectKindV1>> }> }
  | { ok: false; code: 'subject_kind_unavailable' }
> {
  if (!args.declaration) return { ok: true, subjectKind: null };
  if (typeof args.declaration === 'string') return { ok: true, subjectKind: { kind: args.declaration } };
  const definition = readPluginAutomationSubjectKindV1({ ...args, subjectKindId: args.declaration.subjectKindId });
  if (!definition) return { ok: false, code: 'subject_kind_unavailable' };
  return { ok: true, subjectKind: { kind: 'plugin', pluginId: args.pluginId,
    subjectKindId: definition.id, definition } };
}

/** Core resource operands declared by a contributed Action's existing approval scope. */
export function projectPluginActionApprovalScopeV1(args: Readonly<{
  declaration: PluginActionApprovalScopeV2 | undefined;
  pluginId?: string;
  subjectKinds?: readonly PluginAutomationSubjectKindDeclarationV1[];
  input: unknown;
  serverId: string | null | undefined;
}>): PluginAutomationSubjectProjectionReadV1 {
  if (typeof args.declaration === 'object') {
    if (!args.serverId || !args.pluginId) return { ok: false, code: 'subject_kind_unavailable' };
    return projectPluginAutomationSubjectsV1({ serverId: args.serverId, pluginId: args.pluginId,
      projections: [args.declaration], value: args.input, subjectKinds: args.subjectKinds ?? [] });
  }
  if (args.declaration !== 'healthCheck' || !args.serverId) return { ok: true, subjects: [] };
  const input = readRecord(args.input);
  const selector = SavedHealthCheckSelectorV1Schema.parse({ sourceInstanceId: input.sourceInstanceId, checkId: input.checkId });
  return { ok: true, subjects: [{ role: 'operand', subject: { kind: 'healthCheck', serverId: args.serverId, ...selector } }] };
}
