import { SavedHealthCheckSelectorV1Schema, type SavedHealthCheckSelectorV1 } from '../../deployments/healthCheckSourceV1.js';
import { createHealthCheckSourceInstanceIdV1, HealthCheckSubjectV1Schema } from '../../deployments/healthCheckSubjectV1.js';
import { readPluginAutomationSubjectKindV1, projectPluginAutomationSubjectsV1, type PluginAutomationSubjectKindDeclarationV1, type PluginAutomationSubjectProjectionReadV1 } from '../../automations/automationPluginSubjectV1.js';
import { readRecord } from '../../inputs/inputRecords.js';
import type { PluginActionApprovalScopeV2 } from './v2.js';
import { readDatabaseActionAutomationMetadataV1 } from '../../actions/databaseActionMetadata.js';
import type { DatabaseTargetV1 } from '../../databases/databaseTargetIdentityV1.js';
import { readAutomationDatabaseSubjectV1 } from '../../automations/automationSubjectV1.js';
import { readInputPath } from '../../inputs/inputPredicates.js';

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

/** Core resource operands for an admitted contributed Action. */
export function projectPluginActionApprovalScopeV1(args: Readonly<{
  actionId?: string;
  declaration: PluginActionApprovalScopeV2 | undefined;
  pluginId?: string;
  subjectKinds?: readonly PluginAutomationSubjectKindDeclarationV1[];
  input: unknown;
  serverId: string | null | undefined;
}>): PluginAutomationSubjectProjectionReadV1 {
  const database = args.actionId ? readDatabaseActionAutomationMetadataV1(args.actionId) : undefined;
  if (database) {
    if (!args.serverId) return { ok: false, code: 'subject_kind_unavailable' };
    // The contributed host already admitted this Action's canonical input schema.
    const target = readInputPath(args.input, database.primarySubject.field) as DatabaseTargetV1;
    const projected = readAutomationDatabaseSubjectV1(args.serverId, target);
    return projected.ok ? { ok: true, subjects: [{ role: 'operand', subject: projected.subject }] } : projected;
  }
  if (typeof args.declaration === 'object') {
    if (!args.serverId || !args.pluginId) return { ok: false, code: 'subject_kind_unavailable' };
    return projectPluginAutomationSubjectsV1({ serverId: args.serverId, pluginId: args.pluginId,
      projections: [args.declaration], value: args.input, subjectKinds: args.subjectKinds ?? [] });
  }
  if (args.declaration !== 'healthCheck' || !args.serverId) return { ok: true, subjects: [] };
  const selectors = readHealthCheckOperandsV1(args.input);
  if (!selectors) return { ok: false, code: 'invalid_subject_identity' };
  const serverId = args.serverId;
  return { ok: true, subjects: selectors.map(selector => ({ role: 'operand' as const,
    subject: { kind: 'healthCheck' as const, serverId, ...selector } })) };
}

/**
 * A saved-check Action names one check. Setup names the watched subject instead:
 * its operands are the checks it saves, under the source that subject derives,
 * and a subject-only preview has none yet.
 */
function readHealthCheckOperandsV1(value: unknown): readonly SavedHealthCheckSelectorV1[] | null {
  const input = readRecord(value);
  if (input.subject === undefined) {
    const selector = SavedHealthCheckSelectorV1Schema.safeParse({ sourceInstanceId: input.sourceInstanceId, checkId: input.checkId });
    return selector.success ? [selector.data] : null;
  }
  const subject = HealthCheckSubjectV1Schema.safeParse(input.subject);
  const checks = input.checks ?? [];
  if (!subject.success || !Array.isArray(checks)) return null;
  const sourceInstanceId = createHealthCheckSourceInstanceIdV1(subject.data);
  const selectors: SavedHealthCheckSelectorV1[] = [];
  for (const check of checks) {
    const selector = SavedHealthCheckSelectorV1Schema.safeParse({ sourceInstanceId, checkId: readRecord(check).checkId });
    if (!selector.success) return null;
    selectors.push(selector.data);
  }
  return selectors;
}
