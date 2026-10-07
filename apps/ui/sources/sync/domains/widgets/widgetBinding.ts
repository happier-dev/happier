import { readWidgetConnectedAccountPurposeV1, type WidgetBindingResolutionV1, type WidgetDefinitionRefV1, type WidgetInputDescriptorV1, type WidgetInputIssueV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { InstalledWidgetTarget } from '@/components/widgets/InstalledWidgetSurface';
import { isSameInputOptionValue, readInputPath } from '@happier-dev/protocol/inputs';
import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';
import type { JsonValue, PluginContributionIdentityV1, PluginProjectedResourceV2, QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type ConfiguredWidgetTargetResolution =
  | Readonly<{ status: 'ready'; target: InstalledWidgetTarget; runtime: PluginUiProjectionCurrentness; input: Readonly<Record<string, JsonValue>> }>
  | Readonly<{ status: 'loading'; reasonCode: string }>
  | Readonly<{ status: 'selection_required' | 'invalid' | 'unavailable' | 'denied'; reasonCode: string; fields?: readonly WidgetInputIssueV1[]; repair?: WidgetInputRepairOutcome }>;
/** Credential-free facts for one next action; Connect never needs a shared inputs writer. */
export type WidgetInputRepairOutcome = Readonly<{
  kind: 'connect' | 'session_denied' | 'session_unavailable' | 'type_unavailable' | 'input';
  field?: Readonly<{ path: string; label: string; selectedLabel?: string }>;
  connection?: Readonly<{ scope: ServerAccountScope; machineId: string; purpose: QualifiedConnectedAccountPurposeV1 }>;
}>;
type WidgetRepairContext = Readonly<{ instance: WidgetInstanceV1;
  descriptor: WidgetInputDescriptorV1 & Readonly<{ resources?: readonly PluginContributionIdentityV1[] }>;
  sessionLabel?: string;
  connection?: Readonly<{ scope: ServerAccountScope; machineId: string | null; resources: readonly PluginProjectedResourceV2[] }>;
}>;
export type ConfiguredWidgetTargetInput = Readonly<{
  scope: WidgetSurfaceRefV1; resolvedInput: WidgetBindingResolutionV1;
  definition?: WidgetDefinitionRefV1;
  targetKind: 'app' | 'session';
  sessionInputPath?: string; appRuntime: PluginUiProjectionCurrentness;
  repairContext?: WidgetRepairContext;
  readSession(ref: Readonly<{ serverId: string; sessionId: string }>):
    | Readonly<{ status: 'ready'; session: Session; runtime: PluginUiProjectionCurrentness }>
    | Exclude<ConfiguredWidgetTargetResolution, { status: 'ready' }>;
}>;

export function resolveConfiguredWidgetTarget(input: ConfiguredWidgetTargetInput): ConfiguredWidgetTargetResolution {
  const result = resolveConfiguredWidgetTargetFacts(input);
  return input.repairContext ? withWidgetInputRepairOutcome(result, input.repairContext) : result;
}

/** Project the admitted binder's facts once for every installed/builtin/authored surface. */
export function withWidgetInputRepairOutcome<T extends ConfiguredWidgetTargetResolution>(result: T, context: WidgetRepairContext): T & Readonly<{ repair?: WidgetInputRepairOutcome }> {
  if (result.status === 'ready' || result.status === 'loading' || result.repair) return result;
  const issue = result.fields?.find(field => field.status === result.status) ?? result.fields?.[0];
  const code = issue?.reasonCode ?? result.reasonCode;
  const kind = result.reasonCode === 'widget_session_access_denied' ? 'session_denied'
    : result.reasonCode === 'widget_session_unavailable' ? 'session_unavailable'
    : code === 'widget_viewer_connection_missing' ? 'connect'
    : code === 'input_type_unavailable' || result.reasonCode === 'widget_type_unavailable' ? 'type_unavailable'
    : issue || result.status === 'invalid' || result.status === 'selection_required' ? 'input' : null;
  if (!kind) return result;
  const hint = context.descriptor.inputs?.fields.find(field => field.path === issue?.path);
  const binding = hint && context.instance.bindings[hint.path];
  const sessionRef = hint?.path === context.descriptor.sessionInputPath && binding?.kind === 'value'
    ? VoiceTrackedSessionAddressV1Schema.safeParse(binding.value) : null;
  // Prefer public choice labels, then ordinary literals. Never serialize arbitrary
  // saved objects, secret fields or another viewer's credential metadata into copy.
  const selectedLabel = hint?.widget !== 'secret' && binding?.kind === 'value'
    ? (sessionRef?.success ? context.sessionLabel : undefined)
      ?? hint?.options?.find(option => isSameInputOptionValue(option.value, binding.value))?.label
      ?? (typeof binding.value === 'string' || typeof binding.value === 'number' ? String(binding.value)
        : sessionRef?.success ? sessionRef.data.sessionId : undefined) : undefined;
  const declared = kind === 'connect' && hint && binding?.kind === 'viewer' && context.connection?.machineId
    ? readWidgetConnectedAccountPurposeV1({ descriptor: context.descriptor, resources: context.connection.resources,
      path: hint.path, purpose: binding.purpose }) : null;
  return { ...result, repair: { kind, ...(declared && context.connection?.machineId ? { connection: {
    scope: context.connection.scope, machineId: context.connection.machineId, purpose: declared.purpose } } : {}),
    ...(hint ? { field: { path: hint.path, label: hint.title,
    ...(selectedLabel ? { selectedLabel } : {}) } } : {}) } };
}

function resolveConfiguredWidgetTargetFacts(input: ConfiguredWidgetTargetInput): ConfiguredWidgetTargetResolution {
  if (input.resolvedInput.status !== 'ready') return {
    status: input.resolvedInput.status,
    reasonCode: input.resolvedInput.fields[0]?.reasonCode ?? 'widget_inputs_unavailable',
    fields: input.resolvedInput.fields,
  };
  if (!input.sessionInputPath) {
    if (input.targetKind === 'session') return { status: 'selection_required', reasonCode: 'widget_session_selection_missing' };
    if (input.appRuntime.serverId !== input.scope.serverId) return { status: 'denied', reasonCode: 'widget_target_scope_mismatch' };
    return { status: 'ready', target: { kind: 'app' }, runtime: input.appRuntime, input: input.resolvedInput.input };
  }
  const selected = readInputPath(input.resolvedInput.input, input.sessionInputPath);
  if (selected === undefined) return { status: 'selection_required', reasonCode: 'widget_session_selection_missing',
    fields: [{ path: input.sessionInputPath, status: 'selection_required', reasonCode: 'widget_session_selection_missing' }] };
  const ref = VoiceTrackedSessionAddressV1Schema.safeParse(selected);
  if (!ref.success) return { status: 'invalid', reasonCode: 'widget_session_selection_invalid',
    fields: [{ path: input.sessionInputPath, status: 'invalid', reasonCode: 'widget_session_selection_invalid' }] };
  if (ref.data.serverId !== input.scope.serverId) return { status: 'denied', reasonCode: 'widget_target_scope_mismatch' };
  const current = input.readSession(ref.data);
  if (current.status !== 'ready') return current;
  if (current.session.id !== ref.data.sessionId || current.session.serverId !== ref.data.serverId
    || input.definition?.kind !== 'builtin' && current.runtime.serverId !== ref.data.serverId) return { status: 'denied', reasonCode: 'widget_target_identity_mismatch' };
  return { status: 'ready', target: { kind: 'session', sessionId: ref.data.sessionId, session: current.session }, runtime: current.runtime, input: input.resolvedInput.input };
}
