import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { isHostAdmittedReviewedChildPolicyV1, readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import type { ActionId } from '@happier-dev/protocol';
import { ActionInvokeInputSchema } from '@happier-dev/protocol/actions/actionInvokeInput';
import { evaluateInputPredicate } from '@happier-dev/protocol/inputs/inputPredicates';
import { UiContributedActionExecuteRequestV1Schema } from '@happier-dev/protocol/plugins/actions/clientInvocationV1';
import { readActionPrincipalAccountId } from './actionPrincipalAccount';
import { retainAdmittedClientActionParent } from './admittedClientActionChildren';
import { randomUUID } from 'node:crypto';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { parseQualifiedPluginActionId, type QualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import type { ActionDefinitionV1 } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { normalizeServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountExecutionRuntime, type AccountExecutionRuntime, type AccountExecutionRuntimeInput, type RetainedAccountExecutionRuntime } from '@/plugins/runtime/accountExecutionRuntime';
import { readPluginActionExecutionReference, type CurrentProcessPluginActionExecutionAttempt } from './createDaemonPluginActionExecutor';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker,
  createCommittedContributedActionSchemaReader, createRegistryInputTypeDeps,
  listRuntimeContributedActionDefinitions, projectDaemonContributedActionDefinition } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { WorkflowActionApprovalContext } from '@/daemon/workflows/actionApproval';
import { createCredentialedTargetActionCurrentIntent } from './approvals/credentialedTargetActionCurrentIntent';
import { ensureCliActionPolicySettings } from './ensureCliActionPolicySettings';
import type { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import type { CliActionExactHomeTarget } from './createCliActionDeps';
import axios from '@/api/client/credentialAxios';
import { readCurrentMountedAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/merged';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';

type AccountPluginActionRuntimeRequest = Readonly<{
  host: Pick<Parameters<typeof createCliActionExecutorHarness>[0], 'credentials'
    | 'savedSecretOperationContext' | 'isCredentialCurrent' | 'happyHomeDir' | 'resolveServerFeaturesSnapshot'
    | 'runtimeActionMachineId' | 'serverIdentityId' | 'onApprovalRequested'
    | 'externalActionMachineRequestPrivateKey' | 'externalActionMachineInstallationId'>
      & Readonly<{ executeInvokingUiAction?: import('@/plugins/runtime/invocation/actions/executeContributedAction').ClientContributedActionExecutor }>
      & Pick<AccountExecutionRuntimeInput, 'executeTeamCredentialBrokerAction'> & CliActionExactHomeTarget;
  actionId: string;
  input: unknown;
  context?: ActionExecutorContext;
  accountRuntime?: RetainedAccountExecutionRuntime;
  inheritedInvocation?: NonNullable<Parameters<typeof createCommittedContributedActionInvoker>[0]>['inheritedInvocation'];
}>;

type AccountPluginActionRequest = AccountPluginActionRuntimeRequest & Readonly<{
  deps: ActionExecutorDeps;
  resolveContext?: ReturnType<typeof createCliActionExecutorHarness>['resolveContext'];
}>;

export function executeAccountPluginAction(params: AccountPluginActionRequest): Promise<CurrentProcessPluginActionExecutionAttempt> {
  return withAccountPluginActionRuntime(params,
    (runtime, allowUnmatched) => executeInAccountRuntime(params, runtime, allowUnmatched));
}

/** Private declaration read for trigger admission. The public Action spec omits the subject schema. */
export async function readAccountPluginActionDefinition(host: AccountPluginActionRuntimeRequest['host'],
  id: QualifiedPluginActionId, context?: ActionExecutorContext): Promise<ActionDefinitionV1 | null> {
  const resolved = await withAccountPluginActionRuntime({ host, actionId: 'action.spec.get', input: { id }, ...(context ? { context } : {}) },
    ({ registry }) => ({ definition: listRuntimeContributedActionDefinitions(registry, { id })[0] ?? null }),
    (manifest, declaration) => ({ definition: projectDaemonContributedActionDefinition(manifest, declaration) }));
  return 'definition' in resolved ? resolved.definition : null;
}

/** Selects Account custody for both invocation and host-private declaration reads. */
async function withAccountPluginActionRuntime<T extends CurrentProcessPluginActionExecutionAttempt | { definition: ActionDefinitionV1 | null }>(
  params: AccountPluginActionRuntimeRequest,
  useRuntime: (runtime: AccountExecutionRuntime, allowUnmatched?: boolean) => T | Promise<T>,
  readDaemonDeclaration?: (manifest: PluginPortableReleaseManifestV1,
    declaration: PluginPortableReleaseManifestV1['contributes']['actions'][number]) => T,
): Promise<T | CurrentProcessPluginActionExecutionAttempt> {
  const credentials = params.host.credentials;
  if (!credentials || !params.host.serverHttpBaseUrl) return { matched: false };
  const serverId = params.host.serverId;
  const identity = readPluginActionExecutionReference(params.actionId, params.input);
  const pluginId = identity?.pluginId;
  const localId = identity?.localId;
  // Discovery and invocation use the incumbent catalog; Account custody never
  // permits evaluating a Machine handler from these bytes.
  const search = params.actionId === 'action.spec.search';
  if (!pluginId && !search) return { matched: false };
  if (params.context?.signal?.aborted) return { matched: true,
    result: { ok: false, errorCode: 'cancelled', error: 'cancelled' } };
  if (params.accountRuntime) {
    return await useRuntime(await params.accountRuntime.read(), true);
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
      // The selected release owns trigger metadata. A daemon handler still
      // executes only through Machine admission.
      if (readDaemonDeclaration && selection.kind === 'available' && declaration?.execution.target === 'daemon') {
        return readDaemonDeclaration(selection.manifest, declaration);
      }
      const execution = declaration?.execution;
      if (selection.kind !== 'available' || typeof execution !== 'object' || execution === null || !('target' in execution)
        || execution.target !== 'account') return { matched: false, accountSelectionUnavailable: true,
          ...(typeof execution === 'object' && execution !== null && 'target' in execution
            && (execution.target === 'daemon' || execution.target === 'client')
            ? { executionPlacement: execution.target === 'daemon' ? 'machine' as const : 'client' as const } : {}) };
    }
    const snapshot = getActiveAccountSettingsSnapshot();
    // Retain the admitted Account lifetime. Home remains responsible for
    // accepting the captured credential on each request after local rotation.
    // Shared ingress can only use its own captured operation.
    const operationContext = capturedOperation ?? (!params.context?.externalActionExecutionAuthorization
      && !params.context?.externalActionCredential && !params.context?.rpcSessionAuthorization
      && snapshot?.scopeKey === resolveAccountSettingsScopeKeyForToken(credentials.token)
      ? createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl: params.host.serverHttpBaseUrl!,
        isCurrent: async () => isCurrent() }) : undefined);
    if (operationContext && (operationContext.credentials.token !== credentials.token
      || normalizeServerHttpBaseUrl(operationContext.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(params.host.serverHttpBaseUrl!))) {
      return { matched: true, result: { ok: false, errorCode: 'authorityChanged', error: 'authorityChanged' } };
    }
    const isCredentialCurrent = async () => isCurrent()
      && (!operationContext || await operationContext.isCurrent(params.context?.signal));
    const explicitMachineId = params.host.runtimeActionMachineId
      ?? (params.context?.externalActionTarget?.kind === 'machine' ? params.context.externalActionTarget.machineId : undefined)
      ?? params.context?.executionRunTargetMachineId;
    const machineId = explicitMachineId ?? params.context?.defaultSessionMachineId;
    const serverIdentityId = params.context?.serverIdentityId ?? params.host.serverIdentityId;
    const acquireRuntime = () => resolveAccountExecutionRuntime({
      executeTeamCredentialBrokerAction: params.host.executeTeamCredentialBrokerAction,
      externalActionHomeBinding: {
        serverId,
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
        serverId,
        ...(serverIdentityId ? { serverIdentityId } : {}),
        ...(machineId ? { machineId } : {}),
        ...(explicitMachineId ? { explicitMachineId } : {}) },
    }).catch(unavailableSource);
    // A non-search call reaches runtime construction only after its exact
    // current declaration selected Account execution. Losing that source does
    // not turn the invocation into an independently admitted Machine Action.
    const accountHandlerUnavailable = { matched: true as const, result: { ok: false as const,
      errorCode: 'plugin_action_handler_missing', error: 'plugin_action_handler_missing' } };
    const runtime = await acquireRuntime();
    if (!runtime) return search ? { matched: false } : accountHandlerUnavailable;
    let retired: { attempt: CurrentProcessPluginActionExecutionAttempt; pluginId: string; custodyId: string };
    try {
      const attempt = await useRuntime(runtime);
      if ('definition' in attempt || !attempt.matched || attempt.result.ok || attempt.result.errorCode !== 'plugin_action_generation_retired'
        || attempt.result.effectAttempted !== false || !pluginId || params.actionId !== 'action.invoke'
        || params.inheritedInvocation || params.context?.expectedContributedActionOccurrenceId !== undefined
        || (params.input && typeof params.input === 'object' && 'expectedContributorOccurrenceId' in params.input)) return attempt;
      const reviewed = readHostReviewedChildOperationV1(params.context, params.actionId, params.input);
      if (!isHostAdmittedReviewedChildPolicyV1(reviewed, params.actionId, params.input)) return attempt;
      const selection = runtime.registry.readAccountExecutionSelection?.(pluginId);
      if (selection?.kind !== 'available') return attempt;
      retired = { attempt, pluginId, custodyId: selection.custodyId };
    } finally { await runtime.registry.dispose(); }

    // The first child never entered its handler. Reopen custody under the same
    // parent and operands and let normal Action admission decide the child again.
    if (!await isCredentialCurrent()) return retired.attempt;
    const replacement = await acquireRuntime();
    try {
      const selection = replacement?.registry.readAccountExecutionSelection?.(retired.pluginId);
      if (!replacement || selection?.kind !== 'available') {
        const code = selection?.kind === 'unavailable' ? selection.code : 'plugin_account_execution_unavailable';
        return { matched: true, result: { ok: false, errorCode: code, error: code, effectAttempted: false } };
      }
      if (selection.custodyId === retired.custodyId) return retired.attempt;
      return await useRuntime(replacement);
    } finally { await replacement?.registry.dispose(); }
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
  // This is an execution placement transfer. The answering App owns ordinary
  // Action admission, so a matching Agent request never executes here first.
  const execution = selectedAction?.definition.execution;
  const origin: WorkflowActionApprovalContext | undefined = params.context;
  const caller = origin?.actionCaller;
  const workflowInvocation = caller?.kind === 'workflowRun'
    && (params.actionId === ACTION_INVOKE_ACTION_ID_V1 || parseQualifiedPluginActionId(params.actionId) !== null);
  const sessionHandoff = caller?.kind === 'session' && !origin?.bypassApprovals && !origin?.expectedContributedActionOccurrenceId
    && !origin?.externalActionExecutionAuthorization && !origin?.externalActionCredential
    && !origin?.hostReviewedChild && !params.inheritedInvocation;
  if (execution?.target === 'account' && execution.invokingUi && execution.agentInvokingUi
    && origin?.surface === 'agent' && origin.authority === 'account_automation'
    && (workflowInvocation || sessionHandoff) && identity) {
    const invocation = params.actionId === 'action.invoke' ? ActionInvokeInputSchema.safeParse(params.input) : undefined;
    const actionInput = invocation?.success ? invocation.data.input : params.input;
    if ((invocation === undefined || invocation.success) && evaluateInputPredicate(execution.agentInvokingUi.when, actionInput)) {
      const principalAccountId = readActionPrincipalAccountId(origin);
      const execute = params.host.executeInvokingUiAction;
      if (caller?.kind !== 'session' || !principalAccountId || !execute || selection?.kind !== 'available') {
        const code = 'plugin_action_client_target_unavailable';
        return { matched: true, result: { ok: false, errorCode: code, error: code, effectAttempted: false } };
      }
      const request = UiContributedActionExecuteRequestV1Schema.safeParse({
        v: 1, action: identity, input: actionInput, surface: 'agent',
        actionRequestId: origin.actionRequestId,
        expectedContributorOccurrenceId: selection.custodyId,
        invokingAccountAction: { accountId: principalAccountId, caller, callerPermissionMode: origin.callerPermissionMode,
          causalPermissionAuthority: origin.causalPermissionAuthority },
      });
      const expectedOccurrence = invocation?.data?.expectedContributorOccurrenceId;
      if (expectedOccurrence !== undefined && expectedOccurrence !== selection.custodyId) {
        const code = 'plugin_action_generation_retired';
        return { matched: true, result: { ok: false, errorCode: code, error: code, effectAttempted: false } };
      }
      if (!request.success || invocation?.data?.messageActionReference) {
        const code = 'plugin_action_input_invalid';
        return { matched: true, result: { ok: false, errorCode: code, error: code, effectAttempted: false } };
      }
      const executeChild = origin.executeOrdinaryChildAction;
      const preparation = execution.agentInvokingUi.preparation;
      const release = preparation && origin.actionRequestId && executeChild
        ? retainAdmittedClientActionParent(origin.actionRequestId, {
          accountId: principalAccountId, sessionId: caller.sessionId,
          executeChildAtMachine: async (actionId, input, targetMachineId) => {
            const child = ActionInvokeInputSchema.safeParse(input);
            if (actionId !== ACTION_INVOKE_ACTION_ID_V1 || !child.success || !child.data.expectedContributorOccurrenceId) {
              const code = 'invalid_action_input';
              return { ok: false, errorCode: code, error: code, effectAttempted: false };
            }
            const snapshot = await registry.readAccountMachineTargetedContributions?.({
              targetPluginId: identity.pluginId, ...preparation.point,
              machineId: targetMachineId, signal: origin.signal,
            });
            const action = child.data.action;
            const declared = snapshot?.contributions.some(contribution => contribution.operations.some(operation =>
              !operation.unavailable && operation.role === preparation.role
              && operation.action.pluginId === action.pluginId && operation.action.localId === action.localId
              && operation.contributor.occurrenceId === child.data.expectedContributorOccurrenceId));
            if (!declared) {
              const code = 'admission_unavailable';
              return { ok: false, errorCode: code, error: code, effectAttempted: false };
            }
            return executeChild(actionId, child.data, { actionRequestId: randomUUID(),
              externalActionTarget: { kind: 'machine', machineId: targetMachineId } });
          },
        }) : undefined;
      try {
        return { matched: true, result: await execute(request.data, {
          ...(origin.signal ? { signal: origin.signal } : {}),
          ...(invocation?.data?.clientId ? { clientId: invocation.data.clientId } : {}),
          principalAccountId,
        }) };
      } finally { release?.(); }
    }
  }
  // Nested schema and invocation reads borrow the containing runtime. Its
  // Session or one-shot owner disposes it after its own lifetime.
  const lease = { registry, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
  const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
  const requestCurrentIntent = createCredentialedTargetActionCurrentIntent(credentials, {
    onApprovalRequested: params.host.onApprovalRequested,
  });
  const approvalHold = origin?.workflowActionApprovalHold;
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
      requestCurrentIntent: workflowInvocation && approvalHold && approvalHold.actionRequestId === origin?.actionRequestId
        ? request => requestCurrentIntent({ ...request, onLiveApprovalRequested: async artifactId => {
          await approvalHold.onRequested(artifactId);
          await request.onLiveApprovalRequested?.(artifactId);
        } })
        : requestCurrentIntent,
    }),
  });
  // Generic Action tools pass qualified plugin ids; the shared executor
  // admits contributed calls through its canonical action.invoke wrapper.
  const action = parseQualifiedPluginActionId(params.actionId);
  const context = params.resolveContext ? params.resolveContext(params.context, params.actionId) : params.context;
  return { matched: true, result: await executor.execute(action ? 'action.invoke' : params.actionId as ActionId,
    action ? { action, input: params.input } : params.input, context) };
}
