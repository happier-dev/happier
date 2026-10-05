import type { WidgetBindingResolutionV1, WidgetDefinitionRefV1, WidgetInputIssueV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { InstalledWidgetTarget } from '@/components/widgets/InstalledWidgetSurface';
import { readInputPath } from '@happier-dev/protocol/inputs';
import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/protocol';

export type ConfiguredWidgetTargetResolution =
  | Readonly<{ status: 'ready'; target: InstalledWidgetTarget; runtime: PluginUiProjectionCurrentness; input: Readonly<Record<string, JsonValue>> }>
  | Readonly<{ status: 'selection_required' | 'invalid' | 'unavailable' | 'denied'; reasonCode: string; fields?: readonly WidgetInputIssueV1[] }>;
/** The current factual refusal handed back to the host's existing inputs editor. */
export type WidgetInputRepairOutcome = Exclude<ConfiguredWidgetTargetResolution, { status: 'ready' }>;
export type ConfiguredWidgetTargetInput = Readonly<{
  scope: WidgetSurfaceRefV1; resolvedInput: WidgetBindingResolutionV1;
  definition?: WidgetDefinitionRefV1;
  targetKind: 'app' | 'session';
  sessionInputPath?: string; appRuntime: PluginUiProjectionCurrentness;
  readSession(ref: Readonly<{ serverId: string; sessionId: string }>):
    | Readonly<{ status: 'ready'; session: Session; runtime: PluginUiProjectionCurrentness }>
    | Exclude<ConfiguredWidgetTargetResolution, { status: 'ready' }>;
}>;

export function resolveConfiguredWidgetTarget(input: ConfiguredWidgetTargetInput): ConfiguredWidgetTargetResolution {
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
