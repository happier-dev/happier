import type { CliActionDepsParams } from './types';
import { MACHINE_CAPABILITIES_DETECT_ACTION_ID, MACHINE_DOCTOR_SNAPSHOT_ACTION_ID, MACHINE_RUN_MARKERS_LIST_ACTION_ID } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';
import type { CliMachineActionCall, CliMachineActionServerScopeCurrent } from './machineTransport';
import axios from '@/api/client/credentialAxios';
import { MachineCapabilityInstallInputSchema, MachineCapabilityInstallOutputSchema, MachineReplacementSetInputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';
import { parseCapabilitiesDetectResponse } from '@happier-dev/protocol/capabilities';
import type { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { DaemonAgentInstallStartResponseSchema, DaemonAgentInstallReadResponseSchema, DaemonAgentInstallCancelResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { MACHINE_TERMINAL_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineTerminal';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { MACHINE_AGENT_INSTALL_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { DaemonAgentInstallListResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { WorkflowMachineCommandOutputV1Schema } from '@happier-dev/protocol/workflows/stepActionsV1';
import { MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES } from '@happier-dev/protocol/automations/automationStoredContentEnvelopeV1';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { createCliProviderConnectionsStore, createCliProviderConnectionsStoreForOperation } from '@/providers/settings/catalogStore';
import type { refreshActiveProviderConnectionsCatalog } from '@/providers/settings/hydrate';
import { revokeMachineWithProviderCleanup } from '@happier-dev/protocol/machines/account/revokeWithProviderCleanup';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import { readRequesterAccountActionContext, resolveRequesterSavedSecretActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { randomUUID } from 'node:crypto';
import { readRequesterOperationRequestV1 } from '@happier-dev/protocol/actions/operations/requesterReadV1';
import { executeOriginalAccountRequesterOperation } from '@/api/externalActionExecutionAuthorization';

export function createCliMachineActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'machineActionDirectTargetTransport' | 'serverHttpBaseUrl' | 'isCredentialCurrent' | 'savedSecretOperationContext' | 'token' | 'serverId' | 'serverIdentityId'>,
  { callMachineAction, isMachineActionServerScopeCurrent, resolveServerRequestHeaders }: Readonly<{
    callMachineAction: CliMachineActionCall;
    isMachineActionServerScopeCurrent: CliMachineActionServerScopeCurrent;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string,
      request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>>;
  }>,
): Pick<ActionExecutorDeps, 'machineCommandRun' | 'machineWorkSummaryGet' | 'actionOperationAction' | 'machinePageAction' | 'machineTerminalAction' | 'machineAgentInstallStart' | 'machineAgentInstallRead' | 'machineAgentInstallList' | 'machineAgentInstallCancel' | 'machineSetupPlan' | 'machineSetupApply' | 'machineSetupRemove' | 'machineSetupUpdatesApply'> {
  return {
    machineCommandRun: async (input, context) => {
      context.signal?.throwIfAborted();
      const target = context.externalActionTarget;
      if (target?.kind !== 'machine' || !target.project || target.project.machineId !== target.machineId) {
        return { ok: false, errorCode: 'command_target_required', error: 'Command machine and workspace are required' };
      }
      if (!await isMachineActionServerScopeCurrent({ serverId: context.serverId, machineId: target.machineId, context, signal: context.signal })) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== target.machineId) {
        return { ok: false, errorCode: 'command_transport_unavailable', error: 'Command machine transport is unavailable' };
      }
      const raw = await callMachineAction({
        machineId: target.machineId,
        serverId: context.serverId ?? undefined,
        authority: context.authority,
        method: RPC_METHODS.BASH,
        context, effectActionId: 'machines.command.run',
        request: { command: input.command, ...(input.env ? { env: input.env } : {}),
          ...(input.stdin === undefined ? {} : { stdin: JSON.stringify(input.stdin) }),
          cwd: target.project.directory, cwdMode: 'explicit', timeout: 0,
          ...(context.actionCaller?.kind === 'workflowRun'
            ? { outputTailMaxBytes: MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES } : {}) },
        timeoutMs: null,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !('success' in raw) || typeof raw.success !== 'boolean') {
        return { ok: false, errorCode: 'action_failed', error: 'Command result is invalid' };
      }
      const response = raw as Record<string, unknown>;
      // Pre-process refusals may omit output; a successful command must carry
      // complete output rather than fabricating an empty result after an effect.
      const output = WorkflowMachineCommandOutputV1Schema.safeParse({
        exitCode: response.exitCode === undefined && !response.success ? -1 : response.exitCode,
        stdout: response.stdout === undefined && !response.success ? '' : response.stdout,
        stderr: response.stderr === undefined && !response.success ? '' : response.stderr,
        ...(response.stdoutTruncated === undefined ? {} : { stdoutTruncated: response.stdoutTruncated }),
        ...(response.stderrTruncated === undefined ? {} : { stderrTruncated: response.stderrTruncated }),
      });
      if (!output.success) return { ok: false, errorCode: 'action_failed', error: 'Command result is invalid' };
      if (response.success) return output.data;
      const cancelled = response.error === 'Command cancelled';
      const refusalCode = typeof response.errorCode === 'string' && response.errorCode.trim() ? response.errorCode : undefined;
      return { ok: false, errorCode: refusalCode ?? (cancelled ? 'command_cancelled' : 'command_failed'),
        error: refusalCode ? typeof response.error === 'string' ? response.error : refusalCode
          : cancelled ? 'Command cancelled' : 'Command failed', details: output.data };
    },
    machineWorkSummaryGet: async ({ input, context, signal }) => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const read = () => callMachineAction({ machineId: input.machineId, serverId: input.serverId,
        method: RPC_METHODS.MACHINES_WORK_SUMMARY_GET, request: input, authority: context.authority,
        context, effectActionId: 'machines.work.summary.get', exactMachine: true, ...(signal ? { signal } : {}) });
      return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read());
    },
    actionOperationAction: async ({ actionId, input, context, signal }) => {
      const credentials = params.credentials;
      const serverIdentityId = context.serverIdentityId ?? params.serverIdentityId;
      const operation = readRequesterOperationRequestV1(actionId, input);
      if (operation && credentials && serverIdentityId
        && !context.externalActionExecutionAuthorization && !context.externalActionCredential
        && (!context.actionCaller || context.actionCaller.kind === 'host')
        && params.machineActionDirectTargetTransport?.machineId !== operation.input.machineId) {
        if (!await isMachineActionServerScopeCurrent({ ...operation.input, context, signal })) {
          return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        }
        const result = await executeOriginalAccountRequesterOperation({ operation, requestId: context.actionRequestId ?? randomUUID(),
          credentials, serverIdentityId,
          serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), authority: context.authority, context,
          isCurrent: params.isCredentialCurrent, ...(signal ? { signal } : {}) });
        if (result) return result.ok ? result.result : result;
      }
      const runOperationAction = () => executeActionOperationActionV1({
        actionId, input, ...(signal ? { signal } : {}),
        context: { surface: context.surface,
          expectedAccountId: params.credentials ? readAccountIdFromToken(params.credentials.token) ?? undefined : context.expectedAccountId },
        transport: async ({ serverId, machineId, method, payload, signal: requestSignal }) => {
          if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
            return { ok: false, errorCode: 'operation_transport_unavailable', error: 'An authenticated machine transport is required.' };
          }
          return await callMachineAction({ serverId, machineId, method, request: payload,
            context, effectActionId: actionId, authority: context.authority, exactMachine: true, ...(requestSignal ? { signal: requestSignal } : {}),
            ...(actionId === 'action.operations.get' && 'waitForTerminal' in input && input.waitForTerminal
              ? { timeoutMs: null } : {}),
          });
        },
      });
      if (actionId === 'projects.execution.output.read' || actionId === 'projects.execution.output.copy') {
        const { withSharedMachineRpcTransport } = await import('@/session/transport/rpc/machineRpc');
        return await withSharedMachineRpcTransport(runOperationAction);
      }
      return await runOperationAction();
    },
    machinePageAction: async ({ actionId, input, context }) => {
      if (actionId === MACHINE_DOCTOR_SNAPSHOT_ACTION_ID) {
        return callMachineAction({ machineId: input.machineId, serverId: input.serverId,
          method: RPC_METHODS.MACHINES_DOCTOR_SNAPSHOT, request: input, context,
          effectActionId: actionId, authority: context.authority, exactMachine: true,
          ...(context.signal ? { signal: context.signal } : {}) });
      }
      if (actionId === MACHINE_CAPABILITIES_DETECT_ACTION_ID) {
        const { machineId, serverId } = input;
        const { buildMachineDetailsCapabilitiesDetectRequest } = await import('@happier-dev/agents');
        const request = buildMachineDetailsCapabilitiesDetectRequest();
        if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
          return { ok: false, errorCode: 'daemon_transport_unavailable', error: 'An authenticated machine transport is required.' };
        }
        try {
          const raw = await callMachineAction({ machineId, serverId, method: RPC_METHODS.CAPABILITIES_DETECT,
            request, context, effectActionId: actionId, authority: context.authority, exactMachine: true,
            timeoutMs: null, ...(context.signal ? { signal: context.signal } : {}),
          });
          const response = parseCapabilitiesDetectResponse(raw);
          return response ? { status: 'completed' } : { status: 'failed', reason: 'error' };
        } catch (error) {
          context.signal?.throwIfAborted();
          if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) return { status: 'failed', reason: 'not-supported' };
          const rpcErrorCode = readRpcErrorCode(error);
          return { status: 'failed', reason: 'error', error: {
            ...(error instanceof Error ? { name: error.name } : {}), ...(rpcErrorCode ? { rpcErrorCode } : {}),
          } };
        }
      }
      if (actionId === MACHINE_RUN_MARKERS_LIST_ACTION_ID) {
        return await callMachineAction({ machineId: input.machineId, serverId: input.serverId,
          method: RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST, request: {}, context,
          effectActionId: actionId, authority: context.authority, exactMachine: true,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      }
      if (actionId === 'machines.capabilities.install') {
        const { machineId, serverId, capabilityId, method } = MachineCapabilityInstallInputSchema.parse(input);
        if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
          return { ok: false, errorCode: 'daemon_transport_unavailable', error: 'An authenticated machine transport is required.' };
        }
        try {
          const raw = await callMachineAction({ machineId, serverId, method: RPC_METHODS.CAPABILITIES_INVOKE,
            request: { id: capabilityId, method }, context, effectActionId: actionId, authority: context.authority,
            exactMachine: true, timeoutMs: 5 * 60_000, ...(context.signal ? { signal: context.signal } : {}),
          });
          const parsed = MachineCapabilityInstallOutputSchema.safeParse({ supported: true, response: raw });
          return parsed.success ? parsed.data : { supported: false, reason: 'error' };
        } catch (error) {
          context.signal?.throwIfAborted();
          if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) return { supported: false, reason: 'not-supported' };
          const requestDisposition = readRpcRequestDisposition(error);
          return { supported: false, reason: 'error', ...(requestDisposition ? { requestDisposition } : {}) };
        }
      }
      if (actionId === 'machines.replacement.set' || actionId === 'machines.replacement.clear') {
        if (!await isMachineActionServerScopeCurrent({ serverId: input.serverId ?? context.serverId, machineId: input.machineId, context, signal: context.signal })) {
          return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        }
        const credentials = params.savedSecretOperationContext?.credentials ?? params.credentials;
        if (!context.externalActionExecutionAuthorization && (!credentials
          || !params.savedSecretOperationContext && params.token !== credentials.token
          || context.runtimeAccountId && context.runtimeAccountId !== readAccountIdFromToken(credentials.token))) {
          return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        }
        if (!context.externalActionExecutionAuthorization && await params.isCredentialCurrent?.() === false) {
          return { ok: false, errorCode: 'credential_scope_changed', error: 'credential_scope_changed' };
        }
        const spec = getActionSpec(actionId);
        const transport = spec.serverTransport!;
        const home = params.savedSecretOperationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
        const request = actionId === 'machines.replacement.set' ? MachineReplacementSetInputSchema.parse(input) : null;
        const body = request ? { replacementMachineId: request.replacementMachineId,
          ...(request.confirmActiveOldMachine === undefined ? {} : { confirmActiveOldMachine: request.confirmActiveOldMachine }) } : undefined;
        const path = transport.path.replace(':machineId', encodeURIComponent(input.machineId));
        const headers = resolveServerRequestHeaders(context, actionId, { method: transport.method, path,
          ...(body === undefined ? {} : { body }) });
        const { buildCurrentAccountStoredContentCompatibilityHttpHeaders } = await import("@/api/clientCompatibility/cliClientCompatibility");
        const response = await axios.request<unknown>({ url: `${home.replace(/\/+$/, '')}${path}`,
          method: transport.method, data: body,
          headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...headers },
          validateStatus: () => true, ...(context.signal ? { signal: context.signal } : {}),
        });
        if (response.status >= 200 && response.status < 300) return { ok: true };
        const raw = response.data;
        const error = raw && typeof raw === 'object' && 'error' in raw && typeof raw.error === 'string'
          ? raw.error : `http_${response.status}`;
        return { ok: false, status: response.status, error };
      }
      if (actionId === 'machines.remove') {
        const authorization = context.externalActionExecutionAuthorization;
        const requester = readRequesterAccountActionContext(authorization);
        const availableCredentials = requester?.credentials ?? params.savedSecretOperationContext?.credentials ?? params.credentials;
        if (!availableCredentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        const { credentials, operation: operationContext } = resolveRequesterSavedSecretActionCustody({ authorization,
          credentials: availableCredentials, operationContext: params.savedSecretOperationContext });
        if (!authorization && (!operationContext && params.token !== credentials.token
          || context.runtimeAccountId && context.runtimeAccountId !== readAccountIdFromToken(credentials.token))) {
          return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        }
        if (!await isMachineActionServerScopeCurrent({ serverId: input.serverId ?? context.serverId, machineId: input.machineId, context, signal: context.signal })) {
          return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        }
        const home = operationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
        const isCredentialCurrent = requester?.isCurrent ?? params.isCredentialCurrent;
        const path = `/v1/machines/${encodeURIComponent(input.machineId)}/revoke`;
        const headers = resolveServerRequestHeaders(context, actionId, { method: 'POST', path, body: {} });
        return runWithServerHttpBaseUrl(home, async () => {
          const { prepareCliProviderConnectionsStore } = await import("@/providers/settings/catalogStore");
          const store = await prepareCliProviderConnectionsStore({ credentials,
            operationContext, signal: context.signal, isCredentialCurrent });
          const outcome = await revokeMachineWithProviderCleanup(input.machineId, {
            revoke: async () => {
              try {
                await store.verifyCurrent();
                const { buildCurrentAccountStoredContentCompatibilityHttpHeaders } = await import("@/api/clientCompatibility/cliClientCompatibility");
                const response = await axios.post(`${home.replace(/\/+$/, '')}${path}`, {}, {
                  headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...headers },
                  validateStatus: () => true, ...(context.signal ? { signal: context.signal } : {}),
                });
                if (response.status >= 200 && response.status < 300) return { ok: true } as const;
                const rawError: unknown = response.data;
                const error = rawError && typeof rawError === 'object' && 'error' in rawError && typeof rawError.error === 'string'
                  ? rawError.error : `http_${response.status}`;
                return { ok: false, status: response.status, error } as const;
              } catch {
                return { ok: false, status: 503, error: 'revoke_outcome_unknown' } as const;
              }
            },
            readCatalog: () => store.readCatalog(),
            writeCatalog: value => store.mutateCatalog(value),
          });
          if (outcome.ok && outcome.providerCleanup === 'complete') {
            try {
              const { refreshActiveProviderConnectionsCatalog } = await import("@/providers/settings/hydrate");
              await refreshActiveProviderConnectionsCatalog({ credentials,
                operationContext, signal: context.signal, isCredentialCurrent }, { afterChange: true });
            } catch { /* Projection failure cannot erase the durable Provider row receipt. */ }
          }
          return outcome;
        });
      }
      if (actionId !== 'machines.daemon.stop') {
        return { ok: false, errorCode: 'unavailable', error: 'noClient' };
      }
      const { machineId, serverId } = input;
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'daemon_transport_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return await callMachineAction({ machineId, serverId, method: RPC_METHODS.STOP_DAEMON,
        request: {}, context, effectActionId: actionId, authority: context.authority, exactMachine: true,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    },
    machineTerminalAction: async ({ actionId, input, context, signal }) => {
      const { machineId, serverId, ...request } = input;
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'terminal_transport_unavailable', error: 'An authenticated machine transport is required.' };
      }
      const spec = getActionSpec(actionId);
      const method = spec.bindings?.rpcMethod;
      if (!method) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      try {
        return MACHINE_TERMINAL_ACTION_OUTPUT_SCHEMAS[actionId].parse(await callMachineAction({
          machineId, serverId, method, request, context, effectActionId: actionId,
          authority: context.authority, exactMachine: true,
          ...(signal ? { signal } : {}),
        }));
      } catch (error) {
        if (actionId === 'machines.terminal.list' && isRpcMethodNotAvailableError(error)) return null;
        throw error;
      }
    },
    machineAgentInstallStart: async ({ machineId, signal, serverId, context, effectActionId, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'install_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return DaemonAgentInstallStartResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_START, request,
        workflowActionInput: { ...request, machineId }, context, effectActionId, authority: context?.authority,
        ...(request.waitForTerminal ? { timeoutMs: null } : {}),
        ...(signal ? { signal } : {}),
      }));
    },
    machineAgentInstallRead: async ({ machineId, signal, serverId, context, effectActionId, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'install_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return DaemonAgentInstallReadResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_READ, request,
        context, effectActionId, authority: context?.authority,
        ...(request.waitForTerminal ? { timeoutMs: null } : {}),
        ...(signal ? { signal } : {}),
      }));
    },
    machineAgentInstallList: async ({ machineId }, context) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'install_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return DaemonAgentInstallListResponseSchema.parse(await callMachineAction({
        machineId, serverId: context.serverId ?? undefined, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST, request: {},
        context, effectActionId: MACHINE_AGENT_INSTALL_LIST_ACTION_ID_V1, authority: context.authority, exactMachine: true,
        ...(context.signal ? { signal: context.signal } : {}),
      }));
    },
    machineAgentInstallCancel: async ({ machineId, signal, serverId, context, effectActionId, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'install_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return DaemonAgentInstallCancelResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL, request,
        context, effectActionId, authority: context?.authority,
        ...(signal ? { signal } : {}),
      }));
    },
    machineSetupPlan: async ({ input, context, signal }) => {
      return await callMachineAction({ machineId: input.machineId, serverId: context.serverId ?? params.serverId,
        method: RPC_METHODS.MACHINE_SETUP_PLAN, request: input, context, effectActionId: 'machines.setup.plan',
        authority: context.authority, exactMachine: true, timeoutMs: null, ...(signal ? { signal } : {}) });
    },
    machineSetupUpdatesApply: async request => {
      const { input, context, signal } = request;
      const direct = params.machineActionDirectTargetTransport;
      if (direct?.machineId === input.machineId && direct.machineSetupUpdatesApply) return direct.machineSetupUpdatesApply(request);
      if (!params.credentials && direct?.machineId !== input.machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await callMachineAction({ machineId: input.machineId, serverId: context.serverId ?? params.serverId,
        method: RPC_METHODS.MACHINE_SETUP_UPDATES_APPLY, request: input, context, effectActionId: 'machines.setup.updates.apply',
        authority: context.authority, exactMachine: true, timeoutMs: null, ...(signal ? { signal } : {}) });
    },
    machineSetupRemove: async request => {
      const { input, context, signal } = request;
      const direct = params.machineActionDirectTargetTransport;
      if (direct?.machineId === input.machineId && direct.machineSetupRemove) return direct.machineSetupRemove(request);
      if (!params.credentials && direct?.machineId !== input.machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await callMachineAction({ machineId: input.machineId, serverId: context.serverId ?? params.serverId,
        method: RPC_METHODS.MACHINE_SETUP_REMOVE, request: input, context, effectActionId: 'machines.setup.remove',
        authority: context.authority, exactMachine: true, timeoutMs: null, ...(signal ? { signal } : {}) });
    },
    machineSetupApply: async request => {
      const { input, context, signal } = request;
      const direct = params.machineActionDirectTargetTransport;
      if (direct?.machineId === input.machineId && direct.machineSetupApply) return direct.machineSetupApply(request);
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== input.machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await callMachineAction({ machineId: input.machineId, serverId: context.serverId ?? params.serverId,
        method: 'machines.setup.apply', request: input, context, effectActionId: 'machines.setup.apply',
        authority: context.authority, exactMachine: true, timeoutMs: null, ...(signal ? { signal } : {}) });
    },
  };
}
