import { getRelayAccessProvider, normalizeRelayAccessCanonicalPublicServerUrl, type RelayAccessExecutionContext,
  type RelayAccessStatus, type BuiltinAccessProviderRoleResult } from '@happier-dev/cli-common/relayAccess';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { HostReviewedChildrenPlanV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { MachineReachabilityConfigureInputV1Schema, MachineReachabilityInspectInputV1Schema } from '@happier-dev/protocol/machines/reachability/actionsV1';
import { AccessProviderRoleResultV1Schema, accessProviderRefsEqualV1, type AccessProviderMembershipIntentV1, type AccessProviderRoleV1, type AccessProviderRouteV1,
  type AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { actionInputValidationFailure, actionInputIssueFailure,
  projectActionInputJsonSchemaIssues } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveAccessProviderSelectionForHost } from '@/plugins/projection/registry/accessProviders';
import { checkContributedActionSettingsAvailability } from '@/plugins/runtime/invocation/actions/executeContributedAction';

type Capture = Readonly<{
  runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
  context: ActionExecutorContext;
}>;
type PrepareHook = NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>;
type RoleOptions = Readonly<{ setupCredentialFile?: string; target?: 'machine' | 'domainRoute' | 'homeRelay';
  route?: AccessProviderRouteV1; membershipIntent?: AccessProviderMembershipIntentV1 }>;
export type HomeRelayRoleTarget = Readonly<{ route: AccessProviderRouteV1; currentSelection: AccessProviderSelectionV1 | null;
  currentRoute?: AccessProviderRouteV1 }>;
const unavailable = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });

/** One selected descriptor and declared input contract serve preparation and invocation. */
function prepareRole(capture: Capture, machineId: string, selection: AccessProviderSelectionV1,
  role: AccessProviderRoleV1, options: RoleOptions = {}) {
  const selected = resolveAccessProviderSelectionForHost({ registry: capture.runtimeRegistry.contributes, selection, target: options.target ?? 'machine' });
  if (!selected.ok) return selected;
  // Built-ins use the host inspect/configure Actions and their nested P20 plan,
  // not synthetic contributed child Actions for join/leave.
  if (selected.kind === 'builtin') {
    const action = selected.definition.actions[role];
    if (!action) return unavailable('access_provider_target_unsupported');
  }
  const input = { machineId, config: selected.selection.config,
    credentialRefs: selected.selection.credentialRefs, ...(options.route ? { route: options.route } : {}),
    ...(role === 'inspect' && options.membershipIntent ? { membershipIntent: options.membershipIntent } : {}),
    ...(role === 'join' && options.setupCredentialFile ? { setupCredentialFile: options.setupCredentialFile } : {}) };
  if (selected.kind === 'builtin') return { ...selected, input };
  const localId = selected.definition.actions[role];
  const actionIdentity = localId ? { pluginId: selected.contribution.pluginId, localId } : undefined;
  const action = actionIdentity ? capture.runtimeRegistry.contributes.actionsById?.get(
    buildQualifiedPluginContributionKey(actionIdentity)) : undefined;
  if (!action || !actionIdentity) return unavailable('access_provider_unavailable');
  // Preserve the existing enablement owner; the executor alone folds Require.
  const disabled = checkContributedActionSettingsAvailability({ action, surface: 'plugin',
    actionsSettings: capture.context.actionsSettings ?? undefined });
  if (disabled) return disabled;
  const schema = action.definition.inputSchema;
  if (schema) {
    const validate = compilePluginJsonSchema(schema);
    if (!isValidPluginJsonSchemaValue(validate, input)) {
      return actionInputIssueFailure(...projectActionInputJsonSchemaIssues(validate, schema, input));
    }
  }
  return { ...selected, input, child: { action: actionIdentity, role, input } };
}

/** Pure demanded-role preparation at the receiving host's captured catalog/state. */
export async function prepareReachabilityReviewedChildrenForHost(
  request: Parameters<PrepareHook>[0] & Pick<Capture, 'runtimeRegistry'>
    & Readonly<{ selections: readonly AccessProviderSelectionV1[]; currentIngress?: AccessProviderSelectionV1; homeRelay?: HomeRelayRoleTarget }>,
): ReturnType<PrepareHook> {
  if (request.actionId !== 'machines.reachability.inspect' && request.actionId !== 'machines.reachability.configure') return null;
  const configured = request.actionId === 'machines.reachability.configure'
    ? MachineReachabilityConfigureInputV1Schema.safeParse(request.input) : undefined;
  if (configured && !configured.success) return actionInputValidationFailure(configured.error);
  const inspected = request.actionId === 'machines.reachability.inspect'
    ? MachineReachabilityInspectInputV1Schema.safeParse(request.input) : undefined;
  if (inspected && !inspected.success) return actionInputValidationFailure(inspected.error);
  const input = configured?.success ? configured.data : inspected?.success ? inspected.data : undefined;
  if (!input) return actionInputIssueFailure();
  const change = input.change;
  if (change?.kind === 'homeRelay' || inspected?.success && inspected.data.homeRelay) {
    const target = request.homeRelay;
    if (!target) return unavailable('target_unavailable');
    const selection = configured?.success && change?.kind === 'homeRelay' ? change.selection : target.currentSelection;
    const effect = configured?.success;
    const role = effect ? selection ? 'configure' : 'disable' : 'inspect';
    const demanded = selection ?? (effect ? target.currentSelection : null);
    if (!demanded) return null;
    const prepared = prepareRole(request, input.machineId, demanded, role, { target: 'homeRelay',
      route: role === 'configure' ? target.route : target.currentRoute ?? target.route });
    if (!prepared.ok) return prepared;
    return prepared.kind === 'plugin' ? { children: [prepared.child] } : null;
  }
  const selections: AccessProviderSelectionV1[] = [];
  const replacingBuiltin = change?.kind === 'privateNetwork' && change.intent === 'join'
    && 'kind' in change.selection.provider ? change.selection : undefined;
  const priorSelections = replacingBuiltin ? request.selections.filter(selection =>
    !accessProviderRefsEqualV1(selection.provider, replacingBuiltin.provider)) : request.selections;
  for (const selection of [...priorSelections, ...(change?.kind === 'privateNetwork' ? [change.selection] : [])]) {
    const existing = selections.find(candidate => accessProviderRefsEqualV1(candidate.provider, selection.provider));
    if (existing) {
      if (!sameStrictJsonValue(existing, selection)) return unavailable('provider_conflict');
    } else selections.push(selection);
  }
  const children: HostReviewedChildrenPlanV1['children'][number][] = [];
  for (const selection of selections) {
    const membershipIntent = change?.kind === 'privateNetwork' && sameStrictJsonValue(change.selection, selection)
      ? change.intent : undefined;
    const prepared = prepareRole(request, input.machineId, selection, 'inspect',
      membershipIntent ? { membershipIntent } : {});
    if (!prepared.ok) return prepared;
    if (prepared.kind === 'plugin') children.push(prepared.child);
    if (membershipIntent && configured?.success) {
      const settled = prepareRole(request, input.machineId, selection, 'inspect');
      if (!settled.ok) return settled;
      if (settled.kind === 'plugin') children.push(settled.child);
    }
  }
  const proposedIngress = change?.kind === 'posture' && change.posture.defaultServiceIngress.kind === 'provider'
    ? change.posture.defaultServiceIngress.selection : undefined;
  for (const ingress of [request.currentIngress, proposedIngress]) {
    if (!ingress || 'kind' in ingress.provider) continue;
    const prepared = prepareRole(request, input.machineId, ingress, 'inspect', { target: 'domainRoute' });
    if (prepared.ok && prepared.kind === 'plugin'
      && !children.some(child => sameStrictJsonValue(child, prepared.child))) children.push(prepared.child);
  }
  // Inspect prepares observations only; proposing membership remains a safe read.
  if (configured?.success && change?.kind === 'privateNetwork') {
    const file = configured.data.reviewedPlanBasis.credentialFileReview;
    const prepared = prepareRole(request, input.machineId, change.selection, change.intent,
      change.intent === 'join' && file ? { setupCredentialFile: file.path } : {});
    if (!prepared.ok) return prepared;
    if (prepared.kind === 'plugin') children.push(prepared.child);
  }
  return children.length ? { children } : null;
}

/** Runtime consumes the executor's exact active-parent port; it issues no proof. */
export function createReachabilityProviderHost(input: Capture & Readonly<{
  target: Readonly<{ machineId: string }>;
  parent: Readonly<{ actionId: string; requestId: string }>;
  isCurrent(): Promise<boolean>;
  native: RelayAccessExecutionContext;
}>) {
  return {
    resolve: (selection: AccessProviderSelectionV1, target: NonNullable<RoleOptions['target']> = 'machine') =>
      resolveAccessProviderSelectionForHost({ registry: input.runtimeRegistry.contributes, selection, target }),
    async prepareRole(selection: AccessProviderSelectionV1, role: AccessProviderRoleV1, options: RoleOptions = {}) {
      return prepareRole(input, input.target.machineId, selection, role, options);
    },
    async invoke(selection: AccessProviderSelectionV1, role: AccessProviderRoleV1, options: RoleOptions = {}):
      Promise<ActionExecuteFailure | Readonly<{ ok: true; result: BuiltinAccessProviderRoleResult }>> {
      const selected = prepareRole(input, input.target.machineId, selection, role, options);
      if (!selected.ok) return selected;
      if (selected.kind === 'builtin') {
        // These roles are already inside the named host inspect/configure
        // Action. Never recursively invoke that same Action as its own child.
        // All builtin effects remain the reviewed P20 program, not this reader.
        const codec = getRelayAccessProvider(selected.selection.provider);
        if (options.target === 'homeRelay') {
          const ctx = { ...input.native, upstreamUrl: options.route?.upstream ?? null, ...(options.route ? { route: options.route } : {}) };
          const params = { config: selected.selection, ctx, signal: input.context.signal };
          if (role === 'disable') {
            await codec.disable?.(params);
            return { ok: true, result: { kind: 'confirmed', facts: { state: 'stopped' } } };
          }
          if (role === 'configure' || role === 'inspect') {
            const status = await (role === 'configure' && codec.configure ? codec.configure(params) : codec.status(params));
            return { ok: true, result: projectBuiltinHomeRole(status) };
          }
        }
        if (role !== 'inspect' || !codec.inspect) return unavailable('access_provider_target_unsupported');
        return { ok: true as const, result: await codec.inspect({
          config: selected.selection, ctx: input.native, signal: input.context.signal, membershipIntent: options.membershipIntent }) };
      }
      const port = input.context.hostReviewedChild;
      if (!port) return unavailable('admission_unavailable');
      const outcome = await port.invoke(selected.child);
      if (!outcome.ok) return outcome;
      const result = AccessProviderRoleResultV1Schema.safeParse(outcome.result);
      if (!result.success) return unavailable('invalid_action_output');
      const facts: BuiltinAccessProviderRoleResult = result.data;
      return { ok: true as const, result: facts };
    },
  };
}

function projectBuiltinHomeRole(status: RelayAccessStatus): BuiltinAccessProviderRoleResult {
  const publicUrl = normalizeRelayAccessCanonicalPublicServerUrl(status.shareUrl);
  const details = status.details !== null && typeof status.details === 'object' ? status.details : {};
  const diagnosticCode = 'code' in details ? details.code : 'reason' in details ? details.reason : null;
  if (status.state === 'error' || status.state === 'unknown') {
    return { kind: 'unknown', code: typeof diagnosticCode === 'string' ? diagnosticCode : 'provider_command_failed' };
  }
  const authorizationUrl = status.state === 'needs_auth' && 'approvalUrl' in details && typeof details.approvalUrl === 'string'
    ? details.approvalUrl : null;
  const state = status.state === 'enabled' ? 'ready' : status.state === 'disabled' ? 'stopped'
    : status.state === 'needs_auth' ? 'needsAuth' : 'unknown';
  return { kind: 'confirmed', facts: { state, ...(publicUrl ? { publicUrl } : {}), ...(authorizationUrl ? { authorizationUrl } : {}) } };
}
