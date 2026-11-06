import type { CliActionDepsParams } from './types';
import { MACHINE_RUN_MARKERS_LIST_ACTION_ID } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';
import type { CliMachineActionCall, CliMachineActionServerScopeCurrent } from './machineTransport';
import axios from 'axios';
import { MachineCapabilityInstallInputSchema, MachineCapabilityInstallOutputSchema, MachineReplacementSetInputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';
import type { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { DaemonAgentInstallStartResponseSchema, DaemonAgentInstallReadResponseSchema, DaemonAgentInstallCancelResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { MACHINE_TERMINAL_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineTerminal';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { WorkflowMachineCommandOutputV1Schema } from '@happier-dev/protocol/workflows/stepActionsV1';
import { MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES } from '@happier-dev/protocol/automations/automationStoredContentEnvelopeV1';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { createCliProviderConnectionsStore, createCliProviderConnectionsStoreForOperation } from '@/providers/settings/catalogStore';
import type { refreshActiveProviderConnectionsCatalog } from '@/providers/settings/hydrate';
import { revokeMachineWithProviderCleanup } from '@happier-dev/protocol/machines/account/revokeWithProviderCleanup';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
export function createCliMachineActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'machineActionDirectTargetTransport' | 'serverHttpBaseUrl' | 'isCredentialCurrent' | 'savedSecretOperationContext' | 'token' | 'serverId'>,
  { callMachineAction, isMachineActionServerScopeCurrent }: Readonly<{
    callMachineAction: CliMachineActionCall;
    isMachineActionServerScopeCurrent: CliMachineActionServerScopeCurrent;
  }>,
): Pick<ActionExecutorDeps, 'machineCommandRun' | 'machineWorkSummaryGet' | 'actionOperationAction' | 'machinePageAction' | 'machineTerminalAction' | 'machineAgentInstallStart' | 'machineAgentInstallRead' | 'machineAgentInstallCancel' | 'machineSetupPlan' | 'machineSetupApply' | 'machineSetupRemove' | 'machineSetupUpdatesApply'> {
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
        request: { command: input.command, ...(input.env ? { env: input.env } : {}),
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
      return { ok: false, errorCode: cancelled ? 'command_cancelled' : 'command_failed',
        error: cancelled ? 'Command cancelled' : 'Command failed', details: output.data };
    },
    machineWorkSummaryGet: async ({ input, context, signal }) => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const read = () => callMachineAction({ machineId: input.machineId, serverId: input.serverId,
        method: RPC_METHODS.MACHINES_WORK_SUMMARY_GET, request: input, authority: context.authority,
        context, effectActionId: 'machines.work.summary.get', exactMachine: true, ...(signal ? { signal } : {}) });
      return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read());
    },
    actionOperationAction: async ({ actionId, input, context, signal }) => executeActionOperationActionV1({
      actionId, input, ...(signal ? { signal } : {}),
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
    }),
    machinePageAction: async ({ actionId, input, context }) => {
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
        if (!credentials || !params.savedSecretOperationContext && params.token !== credentials.token
          || context.runtimeAccountId && context.runtimeAccountId !== readAccountIdFromToken(credentials.token)) {
          return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        }
        if (await params.isCredentialCurrent?.() === false) {
          return { ok: false, errorCode: 'credential_scope_changed', error: 'credential_scope_changed' };
        }
        const spec = getActionSpec(actionId);
        const transport = spec.serverTransport!;
        const home = params.savedSecretOperationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
        const request = actionId === 'machines.replacement.set' ? MachineReplacementSetInputSchema.parse(input) : null;
        const body = request ? { replacementMachineId: request.replacementMachineId,
          ...(request.confirmActiveOldMachine === undefined ? {} : { confirmActiveOldMachine: request.confirmActiveOldMachine }) } : undefined;
        const { buildCurrentAccountStoredContentCompatibilityHttpHeaders } = await import("@/api/clientCompatibility/cliClientCompatibility");
        const response = await axios.request<unknown>({ url: `${home.replace(/\/+$/, '')}${transport.path.replace(':machineId', encodeURIComponent(input.machineId))}`,
          method: transport.method, data: body,
          headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${credentials.token}` },
          validateStatus: () => true, ...(context.signal ? { signal: context.signal } : {}),
        });
        if (response.status >= 200 && response.status < 300) return { ok: true };
        const raw = response.data;
        const error = raw && typeof raw === 'object' && 'error' in raw && typeof raw.error === 'string'
          ? raw.error : `http_${response.status}`;
        return { ok: false, status: response.status, error };
      }
      if (actionId === 'machines.remove') {
        const credentials = params.savedSecretOperationContext?.credentials ?? params.credentials;
        if (!credentials || !params.savedSecretOperationContext && params.token !== credentials.token
          || context.runtimeAccountId && context.runtimeAccountId !== readAccountIdFromToken(credentials.token)) {
          return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        }
        if (!await isMachineActionServerScopeCurrent({ serverId: input.serverId ?? context.serverId, machineId: input.machineId, context, signal: context.signal })) {
          return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        }
        const home = params.savedSecretOperationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
        return runWithServerHttpBaseUrl(home, async () => {
          const { createCliProviderConnectionsStoreForOperation, createCliProviderConnectionsStore } = await import("@/providers/settings/catalogStore");
          const store = params.savedSecretOperationContext
            ? createCliProviderConnectionsStoreForOperation({ operationContext: params.savedSecretOperationContext, signal: context.signal })
            : createCliProviderConnectionsStore({ credentials, signal: context.signal,
              isCredentialCurrent: params.isCredentialCurrent });
          const outcome = await revokeMachineWithProviderCleanup(input.machineId, {
            revoke: async () => {
              try {
                await store.verifyCurrent();
                const { buildCurrentAccountStoredContentCompatibilityHttpHeaders } = await import("@/api/clientCompatibility/cliClientCompatibility");
                const response = await axios.post(`${home.replace(/\/+$/, '')}/v1/machines/${encodeURIComponent(input.machineId)}/revoke`, {}, {
                  headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${credentials.token}` },
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
                operationContext: params.savedSecretOperationContext, signal: context.signal,
                isCredentialCurrent: params.isCredentialCurrent }, { afterChange: true });
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
    machineAgentInstallStart: async ({ machineId, signal, serverId, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'install_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return DaemonAgentInstallStartResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_START, request,
        ...(signal ? { signal } : {}),
      }));
    },
    machineAgentInstallRead: async ({ machineId, signal, serverId, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'install_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return DaemonAgentInstallReadResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_READ, request,
        ...(signal ? { signal } : {}),
      }));
    },
    machineAgentInstallCancel: async ({ machineId, signal, serverId, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'install_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return DaemonAgentInstallCancelResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL, request,
        ...(signal ? { signal } : {}),
      }));
    },
    machineSetupPlan: async ({ input, context, signal }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== input.machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
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
