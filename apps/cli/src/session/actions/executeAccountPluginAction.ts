import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionId } from '@happier-dev/protocol';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { normalizeServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountExecutionRuntime, type AccountExecutionRuntime, type AccountExecutionRuntimeInput, type RetainedAccountExecutionRuntime } from '@/plugins/runtime/accountExecutionRuntime';
import { readPluginActionExecutionReference, type CurrentProcessPluginActionExecutionAttempt } from './createDaemonPluginActionExecutor';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker,
  createCommittedContributedActionSchemaReader, createRegistryInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCredentialedTargetActionCurrentIntent } from './approvals/credentialedTargetActionCurrentIntent';
import { ensureCliActionPolicySettings } from './ensureCliActionPolicySettings';
import type { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import axios from '@/api/client/credentialAxios';
import { readCurrentMountedAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/merged';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';

/** Selects Account custody for the incumbent runtime and invocation owners. */
export async function executeAccountPluginAction(params: Readonly<{
  host: Pick<Parameters<typeof createCliActionExecutorHarness>[0], 'credentials' | 'serverHttpBaseUrl'
    | 'savedSecretOperationContext' | 'isCredentialCurrent' | 'happyHomeDir' | 'resolveServerFeaturesSnapshot'
    | 'runtimeActionMachineId' | 'serverId' | 'serverIdentityId' | 'onApprovalRequested'
    | 'externalActionMachineRequestPrivateKey' | 'externalActionMachineInstallationId'>
      & Pick<AccountExecutionRuntimeInput, 'executeTeamCredentialBrokerAction'>;
  deps: ActionExecutorDeps;
  actionId: string;
  input: unknown;
  context?: ActionExecutorContext;
  accountRuntime?: RetainedAccountExecutionRuntime;
  inheritedInvocation?: NonNullable<Parameters<typeof createCommittedContributedActionInvoker>[0]>['inheritedInvocation'];
}>): Promise<CurrentProcessPluginActionExecutionAttempt> {
  const credentials = params.host.credentials;
  if (!credentials || !params.host.serverHttpBaseUrl) return { matched: false };
  const identity = readPluginActionExecutionReference(params.actionId, params.input);
  const pluginId = identity?.pluginId;
  const localId = identity?.localId;
  // Discovery and invocation use the incumbent catalog; Account custody never
  // permits evaluating a Machine handler from these bytes.
  const search = params.actionId === 'action.spec.search';
  if (!pluginId && !search) return { matched: false };
  if (params.accountRuntime) {
    return await executeInAccountRuntime(params, await params.accountRuntime.read(), true);
  }
  if (params.host.isCredentialCurrent && !await params.host.isCredentialCurrent()) return { matched: true,
    result: { ok: false, errorCode: 'plugin_action_generation_retired', error: 'plugin_action_generation_retired' } };
  const unavailableSource = (error: unknown): null => {
    params.context?.signal?.throwIfAborted();
    // Source transport failure grants nothing. The existing dispatcher must
    // independently prove current Machine placement before it can proceed.
    if (axios.isAxiosError(error) && (!error.response || error.response.status === 404 || error.response.status === 501)) return null;
    throw error;
  };
  return await runWithServerHttpBaseUrl(params.host.serverHttpBaseUrl, async () => {
    const requester = readRequesterAccountActionContext(params.context?.externalActionExecutionAuthorization);
    const capturedOperation = requester?.savedSecretOperationContext ?? params.host.savedSecretOperationContext;
    // A received invocation retains its admitted Account holder. Ordinary
    // local ingress establishes its own explicit credential's policy first.
    if (!capturedOperation) await ensureCliActionPolicySettings(credentials, params.host.serverHttpBaseUrl);
    params.context?.signal?.throwIfAborted();
    const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    const isCurrent = () => !params.context?.signal?.aborted && (capturedOperation
      ? capturedOperation.readSnapshot() !== null : lifetime === getActiveAccountSettingsSnapshotLifetimeToken());
    if (!search && pluginId) {
      // Discovery's Account custody owns bundled declarations too. A Machine
      // development source must not replace the Account catalog's declaration.
      const selection = await readCurrentMountedAccountPluginExecutionSelection({ pluginId,
        runtime: { credentials, serverHttpBaseUrl: params.host.serverHttpBaseUrl!, isCurrent: async () => isCurrent() },
        ...(params.context?.signal ? { signal: params.context.signal } : {}) })
        .catch(unavailableSource);
      if (!isCurrent()) return { matched: true, result: { ok: false,
        errorCode: 'plugin_action_generation_retired', error: 'plugin_action_generation_retired' } };
      if (!selection) {
        const resolvedAction = identity
          ? readResolvedActionContribution(await resolveMergedContributionRegistry(), identity)
          : null;
        const execution = resolvedAction?.admittedTarget?.declaration?.execution;
        return { matched: false, accountSelectionUnavailable: true,
          ...(execution?.target === 'daemon' ? { executionPlacement: 'machine' as const }
            : execution?.target === 'client' ? { executionPlacement: 'client' as const } : {}) };
      }
      if (selection.kind === 'unavailable' && selection.code !== 'plugin_account_execution_unavailable') return {
        matched: true, result: { ok: false, errorCode: selection.code, error: selection.code } };
      // Only a positive Machine/client declaration supplies non-Account placement
      // for reviewed child routing. It never selects Account execution custody.
      const resolvedAction = selection.kind !== 'available' && identity
        ? readResolvedActionContribution(await resolveMergedContributionRegistry({
          ...(params.host.happyHomeDir ? { happyHomeDir: params.host.happyHomeDir } : {}),
        }), identity) : null;
      const declaration = selection.kind === 'available'
        ? selection.manifest.contributes.actions.find(action => action.id === localId)
        : resolvedAction?.admittedTarget?.declaration;
      const execution = declaration?.execution;
      if (selection.kind !== 'available' || typeof execution !== 'object' || execution === null || !('target' in execution)
        || execution.target !== 'account') return { matched: false, accountSelectionUnavailable: true,
          ...(typeof execution === 'object' && execution !== null && 'target' in execution
            && (execution.target === 'daemon' || execution.target === 'client')
            ? { executionPlacement: execution.target === 'daemon' ? 'machine' as const : 'client' as const } : {}) };
    }
    const snapshot = getActiveAccountSettingsSnapshot();
    // The existing invocation-context producer can capture only this local
    // credential's just-admitted snapshot; shared ingress never borrows it.
    const operationContext = capturedOperation ?? (!params.context?.externalActionExecutionAuthorization
      && !params.context?.externalActionCredential && !params.context?.rpcSessionAuthorization
      && snapshot?.scopeKey === resolveAccountSettingsScopeKeyForToken(credentials.token)
      ? createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl: params.host.serverHttpBaseUrl!,
        isCurrent: async () => isCurrent() && (!params.host.isCredentialCurrent || await params.host.isCredentialCurrent()) }) : undefined);
    if (operationContext && (operationContext.credentials.token !== credentials.token
      || normalizeServerHttpBaseUrl(operationContext.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(params.host.serverHttpBaseUrl!))) {
      return { matched: true, result: { ok: false, errorCode: 'authorityChanged', error: 'authorityChanged' } };
    }
    const isCredentialCurrent = async () => isCurrent()
      && (!operationContext || await operationContext.isCurrent(params.context?.signal))
      && (!params.host.isCredentialCurrent || await params.host.isCredentialCurrent());
    const explicitMachineId = params.host.runtimeActionMachineId
      ?? (params.context?.externalActionTarget?.kind === 'machine' ? params.context.externalActionTarget.machineId : undefined)
      ?? params.context?.executionRunTargetMachineId;
    const machineId = explicitMachineId ?? params.context?.defaultSessionMachineId;
    const runtime = await resolveAccountExecutionRuntime({
      executeTeamCredentialBrokerAction: params.host.executeTeamCredentialBrokerAction,
      externalActionHomeBinding: {
        ...(params.host.serverId ? { serverId: params.host.serverId } : {}),
        ...(params.host.serverIdentityId ? { serverIdentityId: params.host.serverIdentityId } : {}),
        ...(params.host.externalActionMachineRequestPrivateKey
          ? { externalActionMachineRequestPrivateKey: params.host.externalActionMachineRequestPrivateKey } : {}),
        ...(params.host.externalActionMachineInstallationId
          ? { externalActionMachineInstallationId: params.host.externalActionMachineInstallationId } : {}),
      },
      ...(params.host.happyHomeDir ? { happyHomeDir: params.host.happyHomeDir } : {}),
      ...(params.context?.signal ? { signal: params.context.signal } : {}),
      ...(params.host.resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot: params.host.resolveServerFeaturesSnapshot } : {}),
      accountExecution: { credentials, serverUrl: params.host.serverHttpBaseUrl!, isCurrent, isCredentialCurrent,
        ...(operationContext ? { savedSecretOperationContext: operationContext } : {}),
        ...(params.host.serverId ? { serverId: params.host.serverId } : {}),
        ...(params.context?.serverIdentityId ? { serverIdentityId: params.context.serverIdentityId } : {}),
        ...(machineId ? { machineId } : {}),
        ...(explicitMachineId ? { explicitMachineId } : {}) },
    }).catch(unavailableSource);
    // A non-search call reaches runtime construction only after its exact
    // current declaration selected Account execution. Losing that source does
    // not turn the invocation into an independently admitted Machine Action.
    const accountHandlerUnavailable = { matched: true as const, result: { ok: false as const,
      errorCode: 'plugin_action_handler_missing', error: 'plugin_action_handler_missing' } };
    if (!runtime) return search ? { matched: false } : accountHandlerUnavailable;
    try { return await executeInAccountRuntime(params, runtime); }
    finally { await runtime.registry.dispose(); }
  });
}

/** Retained and one-shot hosts share the canonical contributed Action admission. */
async function executeInAccountRuntime(params: Parameters<typeof executeAccountPluginAction>[0],
  { registry, purposeRuntime }: AccountExecutionRuntime, allowUnmatched = false): Promise<CurrentProcessPluginActionExecutionAttempt> {
  const credentials = params.host.credentials!;
  const identity = readPluginActionExecutionReference(params.actionId, params.input);
  const pluginId = identity?.pluginId;
  const search = params.actionId === 'action.spec.search';
  const selection = pluginId ? registry.readAccountExecutionSelection?.(pluginId) : null;
  if (selection?.kind === 'unavailable' && selection.code !== 'plugin_account_execution_unavailable') return { matched: true,
    result: { ok: false, errorCode: selection.code, error: selection.code } };
  const selectedAction = identity ? readResolvedActionContribution(registry.contributes, identity) : null;
  if (!search && !(typeof selectedAction?.definition.execution === 'object'
    && selectedAction.definition.execution !== null && 'target' in selectedAction.definition.execution
    && selectedAction.definition.execution.target === 'account')) return allowUnmatched ? { matched: false } : { matched: true, result: { ok: false,
    errorCode: 'plugin_action_handler_missing', error: 'plugin_action_handler_missing' } };
  // Nested schema and invocation reads borrow the containing runtime. Its
  // Session or one-shot owner disposes it after its own lifetime.
  const lease = { registry, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
  const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
  const executor = createActionExecutor({ ...params.deps,
    ...createRegistryInputTypeDeps(registry),
    listContributedActionDefinitions: list,
    readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
    invokeContributedAction: createCommittedContributedActionInvoker({
      ...(params.inheritedInvocation ? { inheritedInvocation: params.inheritedInvocation } : {}),
      acquireRuntimeRegistryLease: async () => lease,
      ...(purposeRuntime ? { managedProviderOperationAuthority: createManagedProviderOperationAuthority({
        purposeBindingOwner: purposeRuntime.purposes,
      }) } : {}),
      requestCurrentIntent: createCredentialedTargetActionCurrentIntent(credentials, {
        onApprovalRequested: params.host.onApprovalRequested,
      }),
    }),
  });
  // Generic Action tools pass qualified plugin ids; the shared executor
  // admits contributed calls through its canonical action.invoke wrapper.
  const action = parseQualifiedPluginActionId(params.actionId);
  return { matched: true, result: await executor.execute(action ? 'action.invoke' : params.actionId as ActionId,
    action ? { action, input: params.input } : params.input, params.context) };
}
