import type { ActionPurposeBindingAdmission } from '@/daemon/connectedServices/purposeBindings/teamDirectMaterialAdmission';
import type { ManagedNativeCredentialInvocationBinding } from '@/plugins/runtime/invocation/services/types';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { MACHINE_PROVISIONER_EFFECT_ROLES_V1, readMachineProvisionerActionRolesV1, type MachineProvisionerRoleV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { readAccessProviderActionRolesV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { PluginProcessHandle, PluginProcessOutput } from '@happier-dev/plugin-sdk/exec';
import type { ResolvedActionContribution, ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveRegistryConnectedAccountActionPurposeAuthorizations } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import type { PluginActionExecutorResult } from './executeContributedAction';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import { bindManagedMachineRoleCredentials, projectManagedMachineRolePurposeBindingsV1 } from '@happier-dev/cli-common/machines/managed';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionIdsV1';

/** Managed-resource custody supplied only by the authenticated host operation owner. */
export type AdmittedManagedProviderOperationExecutionRequest = Readonly<{
  managedId: string;
  homeId: string;
  intentRevision: number;
  controller?: Readonly<{ machineId: string; installationId: string }>;
  /** Captured only from the authenticated Home's admitted Account operation. */
  accountMachine?: ManagedMachineV1;
  purposeBinding?: ConnectedAccountInvocationPurposeBinding;
  contribution: Readonly<{ pluginId: string; localId: string; occurrenceId: string }>;
  role: MachineProvisionerRoleV1;
  /** Owned bytes from this exact row's retained SavedSecret; never an SDK selector. */
  readBootstrapCredential?(): Promise<Uint8Array>;
  /** Acquire installer's generated guest-host identity from that same retained resource. */
  readGuestHostCredential?(): Promise<Uint8Array>;
  /** Deferred, exact-binding inference material, independent of cloud-purpose custody. */
  managedNativeCredentials?: ManagedNativeCredentialInvocationBinding;
  /** Existing purpose lease; the operation owner retains its cleanup lifetime. */
  exactPurposeBindingSubjectId?: string;
  /** Captured Team route; execution follows the same custody admission as a local lease. */
  executeBrokeredAction?: Extract<ActionPurposeBindingAdmission, { kind: 'brokered' }>['execute'];
  /** Host-only live output delivery while the native Exec or Stream Action is pending. */
  onProcessOutput?: (output: PluginProcessOutput) => void;
  /** Host-only input of the native Stream channel while its Action is pending. */
  bindProcessInput?: (process: Pick<PluginProcessHandle, 'write' | 'closeStdin'>) => () => void;
  /** Installer/task-owned budget for the explicitly selected native Exec process. */
  execTimeoutMs?: number | null;
  /** Rechecks the retained row/native reference, controller, intent and credential lease. */
  isCurrent(): boolean | Promise<boolean>;
}>;

/** Exact host-owned launch credential lease before a managed row exists. */
export type AdmittedConnectedAccountPurposeBindingExecutionRequest = Readonly<{
  exactPurposeBindingSubjectId?: string;
  executeBrokeredAction?: Extract<ActionPurposeBindingAdmission, { kind: 'brokered' }>['execute'];
  isCurrent(): boolean | Promise<boolean>;
}>;

type ManagedProviderCustodyParams = Readonly<{
  contributes: ResolvedContributionRegistry;
  runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
  action: ResolvedActionContribution;
  operation?: AdmittedManagedProviderOperationExecutionRequest;
  probeBinding?: AdmittedConnectedAccountPurposeBindingExecutionRequest;
}>;

/**
 * The local currentness of custody that `checkManagedProviderOperationCustody`
 * admitted: the host's row or lease signal plus the admitted occurrence. Role
 * and shape cannot change within one dispatch, so they are not decided again.
 */
export async function isAdmittedManagedProviderCustodyCurrent(params: ManagedProviderCustodyParams): Promise<boolean> {
  const custody = params.operation ?? params.probeBinding;
  if (!custody) return true;
  const pluginId = params.operation?.contribution.pluginId ?? params.action.pluginId;
  const occurrenceId = params.operation?.contribution.occurrenceId
    ?? (pluginId ? params.contributes.occurrenceIdsByPluginId?.[pluginId] : undefined);
  if (!pluginId || occurrenceId === undefined) return false;
  try {
    return await custody.isCurrent() === true
      && params.runtimeRegistry?.readPluginOccurrenceId?.(pluginId) === occurrenceId;
  } catch {
    return false;
  }
}

export async function checkManagedProviderOperationCustody(params: Readonly<{
  contributes: ResolvedContributionRegistry;
  runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
  action: ResolvedActionContribution;
  input: unknown;
  approvalContext?: ActionExecutorContext;
  operation?: AdmittedManagedProviderOperationExecutionRequest;
  probeBinding?: AdmittedConnectedAccountPurposeBindingExecutionRequest;
}>): Promise<PluginActionExecutorResult | null> {
  const accessMatches = (params.contributes.accessProviders ?? []).flatMap(contribution => {
    if (contribution.pluginId !== params.action.pluginId) return [];
    return readAccessProviderActionRolesV1(contribution.definition)
      .filter(binding => binding.action === params.action.definition.id)
      .map(({ role }) => ({ contribution, role }));
  });
  if (accessMatches.length > 0) {
    const invalid = () => ({ ok: false as const, errorCode: 'admission_unavailable',
      error: 'The access-provider role requires current exact host admission',
      actionHandlerInvocation: 'notStarted' as const });
    const pluginId = params.action.pluginId;
    const identity = pluginId ? { pluginId, localId: params.action.definition.id } : undefined;
    const admitted = identity ? readHostReviewedChildOperationV1(params.approvalContext,
      formatQualifiedPluginActionId(identity), params.input) : null;
    // The executor alone binds the active exact child role/input/target. The
    // provider guard consumes that proof, not another legacy operation carrier.
    if (!identity || !admitted || params.operation || params.probeBinding
      || !(admitted.parent.actionId === 'machines.reachability.configure'
        || admitted.parent.actionId === 'machines.reachability.inspect'
          && accessMatches.some(match => match.role === 'inspect'))) return invalid();
    // Connected Account purpose custody is a separate owner contract. Without
    // its admitted binding, keep the existing refusal rather than infer one
    // from the reviewed operation or from a selected credential reference.
    const purposes = resolveRegistryConnectedAccountActionPurposeAuthorizations({ registry: params.contributes,
      qualifiedActionId: buildQualifiedPluginContributionKey(identity) });
    if (!purposes || purposes.length > 0) return invalid();
    return null;
  }
  const matches = (params.contributes.machineProvisioners ?? []).flatMap((contribution) => {
    if (contribution.pluginId !== params.action.pluginId) return [];
    return readMachineProvisionerActionRolesV1(contribution.definition)
      .filter((binding) => binding.action === params.action.definition.id)
      .map(({ role }) => ({ contribution, role }));
  });
  const effectRole = matches.some((binding) => (
    MACHINE_PROVISIONER_EFFECT_ROLES_V1.some((role) => role === binding.role)
  ));
  const requiresManagedCustody = effectRole || matches.some(({ role }) => role === 'reconcile' || role === 'cleanup');
  if (params.operation === undefined && params.probeBinding === undefined && !requiresManagedCustody) return null;
  const invalid = (): PluginActionExecutorResult => ({
    ok: false, errorCode: 'plugin_managed_provider_operation_custody_invalid',
    error: 'The native provisioner role requires current managed-resource custody',
    actionHandlerInvocation: 'notStarted',
  });
  // A prepared image belongs to its admitted preset operation, before any
  // managed Machine exists. Consume the same private exact-child issuer used
  // by other host effects rather than inventing a managed resource for it.
  if (matches.some(({ role }) => role === 'preparationBuild' || role === 'preparationInspect' || role === 'preparationDestroy')) {
    const identity = params.action.pluginId ? { pluginId: params.action.pluginId, localId: params.action.definition.id } : undefined;
    const admitted = identity ? readHostReviewedChildOperationV1(params.approvalContext,
      formatQualifiedPluginActionId(identity), params.input) : null;
    if (!identity || !admitted || admitted.parent.actionId !== MACHINE_PRESET_PREPARE_ACTION_ID_V1
      || params.operation) return invalid();
    const purposes = resolveRegistryConnectedAccountActionPurposeAuthorizations({ registry: params.contributes,
      qualifiedActionId: buildQualifiedPluginContributionKey(identity) });
    if (!purposes || purposes.length > 0 && !params.probeBinding) return invalid();
    return await isAdmittedManagedProviderCustodyCurrent(params) ? null : invalid();
  }
  if (params.probeBinding !== undefined) {
    const probe = params.probeBinding;
    const pluginId = params.action.pluginId;
    const expectedOccurrenceId = pluginId ? params.contributes.occurrenceIdsByPluginId?.[pluginId] : undefined;
    if (params.operation !== undefined || requiresManagedCustody || !params.runtimeRegistry
      || !pluginId || expectedOccurrenceId === undefined
      || (!probe.exactPurposeBindingSubjectId?.trim() && !probe.executeBrokeredAction)
      || !matches.some(({ role }) => role === 'check' || role === 'options')) return invalid();
    return await isAdmittedManagedProviderCustodyCurrent(params) ? null : invalid();
  }
  const operation = params.operation;
  if (operation?.accountMachine) {
    const machine = operation.accountMachine;
    const launch = machine.launch;
    if (!launch) return invalid();
    const binding = operation.purposeBinding;
    const identity = { pluginId: operation.contribution.pluginId, localId: params.action.definition.id };
    const reviewed = readHostReviewedChildOperationV1(params.approvalContext, formatQualifiedPluginActionId(identity), params.input);
    if (params.runtimeRegistry?.executionRealm !== 'account' || machine.controller || operation.controller
      || !reviewed || !binding || binding.identity.pluginId !== identity.pluginId || binding.identity.localId !== identity.localId
      || binding.managedOperation?.role !== operation.role
      || operation.managedId !== machine.id || operation.homeId !== machine.homeId || operation.intentRevision !== machine.intentRevision
      || !matches.some(({ contribution, role }) => role === operation.role && contribution.identity.pluginId === launch.provider.pluginId
        && contribution.identity.localId === launch.provider.localId)) return invalid();
    const scopes = resolveRegistryConnectedAccountActionPurposeAuthorizations({ registry: params.contributes,
      qualifiedActionId: buildQualifiedPluginContributionKey(identity) });
    if (!scopes) return invalid();
    try {
      const selected = bindManagedMachineRoleCredentials({ authorizations: scopes, provider: launch.provider,
        credentials: launch.credentials, qualification: {
          descriptor: matches.find(candidate => candidate.role === operation.role)!.contribution.definition, launch: launch.choices,
        } });
      const expected = projectManagedMachineRolePurposeBindingsV1(selected);
      const teamSelections = binding.purposeBindings.teamResourceSelections ?? [];
      const expectedTeamSelections = expected.teamResourceSelections ?? [];
      if (selected.length !== binding.purposes.length
        || expected.bindings.length !== binding.purposeBindings.bindings.length
        || expectedTeamSelections.length !== teamSelections.length
        || expected.bindings.some(expectedBinding => !binding.purposeBindings.bindings.some(candidate =>
          pluginJsonValuesEqual(candidate, expectedBinding)))
        || expectedTeamSelections.some(expectedSelection => !teamSelections.some(candidate =>
          pluginJsonValuesEqual(candidate, expectedSelection)))
        || selected.length > 0 && !operation.exactPurposeBindingSubjectId && !operation.executeBrokeredAction) return invalid();
    } catch { return invalid(); }
    return await isAdmittedManagedProviderCustodyCurrent(params) ? null : invalid();
  }
  if (!operation || !params.runtimeRegistry
    || !operation.managedId.trim() || !operation.homeId.trim()
    || !operation.controller?.machineId.trim() || !operation.controller.installationId.trim()
    || !Number.isSafeInteger(operation.intentRevision) || operation.intentRevision < 0
    || operation.exactPurposeBindingSubjectId?.trim() === ''
    || (operation.onProcessOutput !== undefined && operation.role !== 'exec' && operation.role !== 'stream')
    || (operation.bindProcessInput !== undefined && operation.role !== 'stream')
    || (operation.execTimeoutMs !== undefined && operation.role !== 'exec')
    || !matches.some(({ contribution, role }) => (
      role === operation.role
      && contribution.identity.pluginId === operation.contribution.pluginId
      && contribution.identity.localId === operation.contribution.localId
      && contribution.definition.id === operation.contribution.localId
    ))) return invalid();
  if (operation.exactPurposeBindingSubjectId === undefined && operation.executeBrokeredAction === undefined) {
    const purposes = resolveRegistryConnectedAccountActionPurposeAuthorizations({
      registry: params.contributes,
      qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: operation.contribution.pluginId, localId: params.action.definition.id }),
    });
    // A retained managed invocation may not recapture mutable account defaults.
    // No declared use needs no lease; declared or unresolved use needs exact custody.
    if (!purposes || purposes.length > 0) return invalid();
  }
  return await isAdmittedManagedProviderCustodyCurrent(params) ? null : invalid();
}
