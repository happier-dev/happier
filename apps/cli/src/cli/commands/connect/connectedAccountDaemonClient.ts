import type {
  ConnectedAccountDaemonControlCommand,
  ConnectedAccountDaemonControlResponse,
  ConnectedAccountDaemonCommand,
  ConnectedAccountAttemptResponse,
} from '@/daemon/connectedServices/ConnectedAccountDaemonRuntime';
import {
  CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
  ConnectedAccountAuthenticationCommandResponseSchema,
  ConnectedAccountControlCommandRequestSchema,
  ConnectedAccountDaemonControlResponseSchema,
  ConnectedAccountDaemonCommandSchema,
} from '@/api/machine/rpcHandlers.connectedAccounts';
import type { StoredCredentials } from '@/persistence';
import { randomUUID } from 'node:crypto';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { resolveAccountExecutionRuntime } from '@/plugins/runtime/accountExecutionRuntime';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION,
  CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import type { CliApprovalRequestedHandler } from '@/session/actions/approvals/deferredResult';
import {
  callMachineRpc as callMachineRpcRuntime,
} from '@/session/transport/rpc/machineRpc';

export type ConnectedAccountCliControlResponse = Exclude<ConnectedAccountDaemonControlResponse, { status: 'configurationCommitted' }>
  | (Readonly<{ status: 'configuration' }> & ReturnType<(typeof CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1)['connectedServices.configuration.get']['parse']>)
  | Readonly<{ status: 'configurationCommitted'; configuration: Readonly<{ revision: string }> }>;

function readDiagnosticResponse(response: ConnectedAccountDaemonControlResponse) {
  if (response.status === 'configurationCommitted') throw new Error('Unexpected configuration mutation receipt for a diagnostic read');
  return response;
}

export type ConnectedAccountDaemonClient = Readonly<{
  authenticate(
    command: ConnectedAccountDaemonCommand,
  ): Promise<ConnectedAccountAttemptResponse>;
  control(
    command: ConnectedAccountDaemonControlCommand,
  ): Promise<ConnectedAccountCliControlResponse>;
  readContributions(): Promise<Pick<ResolvedContributionRegistry, 'connectedAccountDescriptors'>>;
  dispose(): Promise<void>;
}>;

export function createConnectedAccountDaemonClient(params: Readonly<{
  credentials: StoredCredentials;
  machineId?: string;
  callMachineRpc?: typeof callMachineRpcRuntime;
  actionExecutor?: Pick<ReturnType<typeof createCliActionExecutorFromCredentials>, 'execute'>;
  signal?: AbortSignal;
  onApprovalRequested?: CliApprovalRequestedHandler;
}>): ConnectedAccountDaemonClient {
  const machineId = params.machineId?.trim();
  if (params.machineId !== undefined && !machineId) {
    throw new Error('Connected-account daemon client requires a machine id');
  }
  const callMachineRpc = params.callMachineRpc ?? callMachineRpcRuntime;
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  const lifetime = new AbortController();
  let savedSecretOperationContext: SavedSecretOperationContextV1 | undefined;
  let registry: Promise<Awaited<ReturnType<typeof resolveAccountExecutionRuntime>>['registry']> | undefined;
  const readRegistry = () => {
    lifetime.signal.throwIfAborted();
    registry ??= runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
      await ensureCliActionPolicySettings(params.credentials, serverHttpBaseUrl);
      const snapshot = getActiveAccountSettingsSnapshot();
      if (!snapshot) throw new Error('saved_secret_account_snapshot_unavailable');
      const snapshotLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
      savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials: params.credentials,
        snapshot, serverHttpBaseUrl, isCurrent: async () => !lifetime.signal.aborted
          && getActiveAccountSettingsSnapshotLifetimeToken() === snapshotLifetime
          && getActiveAccountSettingsSnapshot()?.scopeKey === snapshot.scopeKey });
      return (await resolveAccountExecutionRuntime({ signal: lifetime.signal,
        accountExecution: { credentials: params.credentials, serverUrl: serverHttpBaseUrl,
          savedSecretOperationContext,
          isCurrent: () => !lifetime.signal.aborted } })).registry;
    });
    return registry;
  };
  let executor = params.actionExecutor;
  const executeAction = async (actionId: ActionId, input: unknown, signal = params.signal): Promise<ActionExecuteResult> => {
    lifetime.signal.throwIfAborted();
    if (!executor) {
      const owner = await readRegistry();
      const host = owner.connectedAccountAuthenticationHost;
      if (!host) throw Object.assign(new Error('connected_account_service_unavailable'), { code: 'connected_account_service_unavailable' });
      const executorOptions = { credentials: params.credentials, savedSecretOperationContext,
        ...(params.onApprovalRequested ? { onApprovalRequested: params.onApprovalRequested } : {}),
        ...(machineId ? { machineId } : {}) };
      const nativeExecutor = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createCliActionExecutorFromCredentials({
        ...executorOptions, connectedAccountAuthenticationHost: host }));
      executor = { execute: async (id, operands, context) => {
        const routed = await host.executeAction(id, operands, context, (selectedId, selectedInput, selectedContext, selectedHost) => {
          const invocationSignal = selectedContext?.signal ?? lifetime.signal;
          // The selected Account producer owns this live result and its attempt.
          // Native dispatch has no local host lifetime and keeps deferred replay.
          const hostActionApprovalLifetime = getActionSpec(selectedId).approvalResultCustody === 'live_only'
            ? { actionId: selectedId, signal: invocationSignal, surface: 'cli' as const } : undefined;
          return createCliActionExecutorFromCredentials({ ...executorOptions, connectedAccountAuthenticationHost: selectedHost,
            ...(hostActionApprovalLifetime ? { hostActionApprovalLifetime } : {}),
            pluginActionExecutionOwner: 'current_process' }).execute(selectedId, selectedInput,
              { ...selectedContext, signal: invocationSignal });
        });
        return routed.matched ? routed.result : nativeExecutor.execute(id, operands, context);
      } };
    }
    return await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => executor!.execute(actionId, input, { surface: 'cli', actionCaller: { kind: 'host' }, actionRequestId: randomUUID(),
      ...(signal && actionId !== CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION.cancel ? { signal } : {}) }));
  };
  const execute = async (actionId: ActionId, input: unknown) => {
    const result = await executeAction(actionId, input);
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode, details: result.details });
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) throw Object.assign(new Error('Approval requested'), { code: 'approval_required', details: approval.data });
    return result.result;
  };

  return Object.freeze({
    async readContributions() { return (await readRegistry()).contributes; },
    async dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      if (registry) await registry.then(owner => owner.dispose(), () => undefined);
    },
    async authenticate(command) {
      const normalizedCommand =
        ConnectedAccountDaemonCommandSchema.parse(command);
      const { operation, ...operands } = normalizedCommand;
      const machineOperand = (operation === 'beginConnect' || operation === 'beginReconnect') && machineId
        ? { machineId } : {};
      const result = await execute(CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION[operation], { ...machineOperand, ...operands });
      return ConnectedAccountAuthenticationCommandResponseSchema.parse(result);
    },
    async control(command) {
      const normalized = ConnectedAccountControlCommandRequestSchema.shape.command.parse(command);
      if (normalized.operation === 'revokeAccount') {
        const { operation: _operation, ...operands } = normalized;
        return CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.revoke']
          .parse(await execute('connectedServices.accounts.revoke', { machineId, ...operands }));
      }
      if (normalized.operation === 'replaceConfiguration') {
        const { target, expectedRevision, values, secretValues } = normalized;
        const operand = target.kind === 'service' ? { service: target.service, modeId: target.modeId }
          : { ...(target.kind === 'account' && machineId ? { machineId } : {}), target };
        const result = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.replace']
          .parse(await execute('connectedServices.configuration.replace', { ...operand, expectedRevision, values, secretValues }));
        return { status: 'configurationCommitted', configuration: { revision: result.revision } };
      }
      if (normalized.operation === 'readConfiguration') {
        const target = normalized.target;
        const operand = target.kind === 'service' ? { service: target.service, modeId: target.modeId }
          : { ...(target.kind === 'account' && machineId ? { machineId } : {}), target };
        const result = await execute('connectedServices.configuration.get', operand);
        return { status: 'configuration',
          ...CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.get'].parse(result) };
      }
      if (normalized.operation === 'listPendingAttempts') return readDiagnosticResponse(ConnectedAccountDaemonControlResponseSchema.parse(
        await execute('connectedServices.authentication.pending.list', { service: normalized.service, ...(machineId ? { machineId } : {}) })));
      const native = async (target: string, nativeCommand: ConnectedAccountDaemonControlCommand) => readDiagnosticResponse(ConnectedAccountDaemonControlResponseSchema.parse(await callMachineRpc({
        credentials: params.credentials, machineId: target, method: CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
        request: ConnectedAccountControlCommandRequestSchema.parse({ v: 1, machineId: target, command: nativeCommand }),
        ...(params.signal ? { signal: params.signal } : {}),
      })));
      if (!params.actionExecutor) {
        const host = (await readRegistry()).connectedAccountAuthenticationHost;
        if (!host) throw Object.assign(new Error('connected_account_service_unavailable'), { code: 'connected_account_service_unavailable' });
        return readDiagnosticResponse(await host.controlCommand(machineId, normalized, { signal: params.signal, native }));
      }
      const request = ConnectedAccountControlCommandRequestSchema.parse({ v: 1, machineId, command: normalized });
      // These diagnostic reads cannot acquire credentials, advance an attempt or write configuration.
      if (request.command.operation !== 'describeService' && request.command.operation !== 'readConfiguration'
        && request.command.operation !== 'listPendingAttempts') throw new Error('Unsupported connected-account command');
      return native(request.machineId, request.command);
    },
  });
}
