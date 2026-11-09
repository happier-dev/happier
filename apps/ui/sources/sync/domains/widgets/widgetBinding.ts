import { readWidgetInputTargetV1, validateWidgetWorkspaceInputV1, readWidgetConnectedAccountPurposeV1, type WidgetBindingResolutionV1, type WidgetDefinitionRefV1, type WidgetDefinitionV1, type WidgetInputDescriptorV1, type WidgetInputIssueV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { InstalledWidgetTarget } from '@/components/widgets/InstalledWidgetSurface';
import { isSameInputOptionValue, readInputPath } from '@happier-dev/protocol/inputs';
import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { createProtocolStoredReadSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import type { JsonValue} from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginProjectedResourceV2} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceAddressV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import type { ProjectWidgetAreaContextV1 } from './projectWidgetAreaContext';
import type { SessionRecordingVisibility } from '@/sync/domains/session/listing/recordingPrivacy';

export const WidgetSessionAddressReadSchema = createStoredReadSchema(VoiceTrackedSessionAddressV1Schema);
export const WidgetConnectedAccountSelectionReadSchema = createProtocolStoredReadSchema(QualifiedConnectedAccountRefSchema);

export type ConfiguredWidgetTargetResolution =
  | Readonly<{ status: 'ready'; target: InstalledWidgetTarget | Readonly<{ kind: 'workspace'; workspace: WorkspaceAddressV1; checkout: WorkspaceRefV1 }>; projectContext?: ProjectWidgetAreaContextV1; runtime: PluginUiProjectionCurrentness; input: Readonly<Record<string, JsonValue>> }>
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
  isSessionVisible?: SessionRecordingVisibility;
  connection?: Readonly<{ scope: ServerAccountScope; machineId: string | null; resources: readonly PluginProjectedResourceV2[] }>;
}>;
export type ConfiguredWidgetTargetInput = Readonly<{
  scope: WidgetSurfaceRefV1; resolvedInput: WidgetBindingResolutionV1;
  definition?: WidgetDefinitionRefV1;
  /** Parsed body from the admitted Account/Session definition, not catalog summary metadata. */
  authoredBody?: WidgetDefinitionV1['body'];
  targetKind: 'app' | 'session' | 'project';
  projectContext?: ProjectWidgetAreaContextV1 | null;
  descriptor: WidgetInputDescriptorV1;
  providedContext?: Readonly<Record<string, readonly JsonValue[]>>;
  workspaceRefs?: readonly WorkspaceRefV1[];
  appRuntime: PluginUiProjectionCurrentness;
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
  const declaredTarget = readWidgetInputTargetV1(context.descriptor);
  const sessionRef = declaredTarget.kind === 'session' && hint?.path === declaredTarget.path && binding?.kind === 'value'
    ? WidgetSessionAddressReadSchema.safeParse(binding.value) : null;
  // Prefer the canonical Session name or public choice label. Only a plain literal
  // field may name itself: a missing reference/choice is not a displayable id.
  const selectedLabel = hint && hint.widget !== 'secret' && binding?.kind === 'value'
    ? sessionRef?.success && context.isSessionVisible?.(sessionRef.data) === false ? hint.title
      : (sessionRef?.success ? context.sessionLabel : undefined)
      ?? hint?.options?.find(option => isSameInputOptionValue(option.value, binding.value))?.label
      ?? (!hint?.options && !hint?.optionsSourceId && !hint?.inputType && !sessionRef?.success
        && (typeof binding.value === 'string' || typeof binding.value === 'number') ? String(binding.value) : undefined) : undefined;
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
  const declaredTarget = readWidgetInputTargetV1(input.descriptor);
  if (declaredTarget.kind === 'invalid') return { status: 'invalid', reasonCode: declaredTarget.reasonCode,
    fields: declaredTarget.paths.map(path => ({ path, status: 'invalid', reasonCode: declaredTarget.reasonCode })) };
  if (input.targetKind === 'project') {
    const project = input.projectContext;
    const lifetime = input.appRuntime.accountLifetime;
    if (!lifetime?.isCurrent() || input.scope.owner.kind !== 'project'
      || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, input.scope.serverId))
      return { status: 'denied', reasonCode: 'widget_target_scope_mismatch' };
    if (!project?.target) return { status: 'unavailable', reasonCode: 'widget_project_source_unavailable' };
    if (project.scope.authority?.isCurrent() === false
      || !areServerProfileIdentifiersEquivalent(project.scope.serverId, input.scope.serverId)
      || project.target.projectKey !== input.scope.owner.projectId)
      return { status: 'denied', reasonCode: 'widget_target_scope_mismatch' };
    return { status: 'ready', target: project.target, projectContext: project, runtime: input.appRuntime, input: input.resolvedInput.input };
  }
  if (declaredTarget.kind === 'workspace') {
    const path = declaredTarget.path;
    const selected = readInputPath(input.resolvedInput.input, path);
    if (selected === undefined) return { status: 'selection_required',
      reasonCode: 'widget_workspace_selection_invalid', fields: [{ path, status: selected === undefined ? 'selection_required' : 'invalid', reasonCode: 'widget_workspace_selection_invalid' }] };
    // The path is read from the admitted strict-JSON input; the shared path reader returns unknown.
    if (input.appRuntime.accountLifetime && !input.appRuntime.accountLifetime.isCurrent())
      return { status: 'denied', reasonCode: 'widget_target_scope_mismatch' };
    const admitted = validateWidgetWorkspaceInputV1({ value: selected as JsonValue, serverId: input.scope.serverId,
      workspaceRefs: input.workspaceRefs ?? [] }, workspaceRefResolutionContextV1());
    if (admitted.status !== 'valid') return { ...admitted, fields: [{ path, ...admitted }] };
    // Equality may accept target-platform spelling differences; only the admitted
    // checkout supplies the actual path bytes passed to filesystem/SCM readers.
    const workspace = workspaceAddressFromRefV1(admitted.checkout);
    return { status: 'ready', target: { kind: 'workspace', workspace, checkout: admitted.checkout }, runtime: input.appRuntime, input: input.resolvedInput.input };
  }
  if (declaredTarget.kind === 'app') {
    if (input.targetKind === 'session') return { status: 'selection_required', reasonCode: 'widget_session_selection_missing' };
    // Authored bodies are rendered locally in the admitted viewer's scope.
    // The AppShell union has no unique server/machine with zero or several
    // members. It is not that body's authority: live Resource nodes separately
    // admit their exact contribution origin against the Account lifetime.
    if (input.definition?.kind !== 'builtin' && (!input.authoredBody || input.authoredBody.kind === 'installed')) {
      // An app union has no scalar machine/server. Its captured Account owns catalog admission;
      // the plugin host still selects and validates this contribution's exact execution origin.
      const lifetime = input.appRuntime.accountLifetime;
      const serverId = input.appRuntime.serverId ?? (lifetime?.isCurrent() ? lifetime.scope.serverId : null);
      if (!serverId || !areServerProfileIdentifiersEquivalent(serverId, input.scope.serverId))
        return { status: 'denied', reasonCode: 'widget_target_scope_mismatch' };
    }
    return { status: 'ready', target: { kind: 'app' }, runtime: input.appRuntime, input: input.resolvedInput.input };
  }
  const path = declaredTarget.path;
  const selected = readInputPath(input.resolvedInput.input, path);
  if (selected === undefined) return { status: 'selection_required', reasonCode: 'widget_session_selection_missing',
    fields: [{ path, status: 'selection_required', reasonCode: 'widget_session_selection_missing' }] };
  const ref = WidgetSessionAddressReadSchema.safeParse(selected);
  if (!ref.success) return { status: 'invalid', reasonCode: 'widget_session_selection_invalid',
    fields: [{ path, status: 'invalid', reasonCode: 'widget_session_selection_invalid' }] };
  if (!areServerProfileIdentifiersEquivalent(ref.data.serverId, input.scope.serverId)) return { status: 'denied', reasonCode: 'widget_target_scope_mismatch' };
  const current = input.readSession(ref.data);
  if (current.status !== 'ready') return current;
  if (current.session.id !== ref.data.sessionId || !areServerProfileIdentifiersEquivalent(current.session.serverId, ref.data.serverId)
    || input.definition?.kind !== 'builtin' && input.authoredBody?.kind !== 'builtin'
      && (!current.runtime.serverId || !areServerProfileIdentifiersEquivalent(current.runtime.serverId, ref.data.serverId))) return { status: 'denied', reasonCode: 'widget_target_identity_mismatch' };
  return { status: 'ready', target: { kind: 'session', sessionId: ref.data.sessionId, session: current.session }, runtime: current.runtime, input: input.resolvedInput.input };
}
