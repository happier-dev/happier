import type { CliActionDepsParams } from './types';
import type { CliMachineActionCall, CliMachineActionServerScopeCurrent } from './machineTransport';
import { DaemonLspApplyResponseSchema, DaemonLspQueryResponseSchema, DaemonLspRestartResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { DaemonWorkspaceFileSearchResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { DaemonWorkspaceFileReplacePreviewResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { WorkspaceFilesReplaceActionOutputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { resolveFilesystemTransferCustodyFailure } from '../filesystemTransferCustody';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { classifyWorkspaceFileRpcUnavailable } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
export function createCliFilesystemActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'machineActionDirectTargetTransport' | 'serverHttpBaseUrl'>,
  { callMachineAction, isMachineActionServerScopeCurrent, readRecord }: Readonly<{
    callMachineAction: CliMachineActionCall;
    isMachineActionServerScopeCurrent: CliMachineActionServerScopeCurrent;
    readRecord: (value: unknown) => Record<string, unknown>;
  }>,
): Pick<ActionExecutorDeps, 'filesystemActionExecute' | 'workspaceFilesReplacePreview' | 'workspaceFilesReplace' | 'languageIntelligenceQuery' | 'languageIntelligenceApply' | 'languageIntelligenceRestart' | 'workspaceFilesSearch'> {
  return {
    filesystemActionExecute: async ({ actionId, input, context }) => {
      const { resolveFilesystemTransferCustodyFailure } = await import("../filesystemTransferCustody");
      const custodyFailure = resolveFilesystemTransferCustodyFailure(actionId, context);
      if (custodyFailure) return custodyFailure;
      const target = context.externalActionTarget;
      const machineId = target === undefined
        ? context.defaultSessionMachineId?.trim()
        : target.kind === 'machine'
          ? target.machineId.trim()
          : '';
      if (!machineId) {
        return { ok: false, errorCode: 'machine_not_selected', error: 'machine_not_selected' };
      }
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      if (!await isMachineActionServerScopeCurrent({ serverId: context.serverId, machineId, context, signal: context.signal })) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      const method = getActionSpec(actionId).bindings?.rpcMethod;
      if (!method) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      // Semantic RPCs re-enter the daemon's canonical Action admission owner.
      // Preserve signed requester provenance and the exact captured target/root.
      const preparedCopy = actionId === 'daemon.filesystem.copy'
        && readRecord(input).kind === 'prepared_transfer';
      const execute = () => callMachineAction({
        machineId, serverId: context.serverId ?? undefined, method, request: input, authority: context.authority,
        context, effectActionId: actionId, exactMachine: true,
        ...(actionId === 'daemon.filesystem.upload' || actionId === 'daemon.filesystem.download' || preparedCopy
          ? { timeoutMs: null } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, execute) : execute());
    },
    workspaceFilesReplacePreview: async ({ machineId, ...request }, context) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const invoke = async () => DaemonWorkspaceFileReplacePreviewResponseSchema.parse(await callMachineAction({
        machineId, serverId: context.serverId ?? undefined, method: RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW,
        request, context, authority: context.authority, effectActionId: 'workspace.files.replace.preview',
        ...(context.signal ? { signal: context.signal } : {}),
      }));
      return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, invoke) : invoke());
    },
    workspaceFilesReplace: async ({ machineId, ...request }, context) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const invoke = async () => WorkspaceFilesReplaceActionOutputSchema.parse(await callMachineAction({
        machineId, serverId: context.serverId ?? undefined, method: RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY,
        request: { machineId, ...request }, context, authority: context.authority, effectActionId: 'workspace.files.replace',
        waitForResultOnCancel: true,
        ...(context.signal ? { signal: context.signal } : {}),
      }));
      return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, invoke) : invoke());
    },
    languageIntelligenceQuery: async ({ machineId, request }, context) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      try {
        const invoke = async () => DaemonLspQueryResponseSchema.safeParse(await callMachineAction({
          machineId, serverId: context.serverId ?? undefined, method: RPC_METHODS.DAEMON_LSP_QUERY, request, timeoutMs: null, context,
          authority: context.authority,
          ...(context.signal ? { signal: context.signal } : {}),
        }));
        const result = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, invoke) : invoke());
        return result.success ? result.data : { status: 'unavailable', reason: 'invalid_response' };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        const reason = classifyWorkspaceFileRpcUnavailable(readRpcErrorCode(error));
        if (reason) return { status: 'unavailable', reason };
        throw error;
      }
    },
    languageIntelligenceApply: async ({ machineId, request, actionId }, context) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const method = actionId === 'code.rename.apply' ? RPC_METHODS.DAEMON_LSP_RENAME_APPLY
        : actionId === 'code.file.rename.apply' ? RPC_METHODS.DAEMON_LSP_FILE_RENAME_APPLY
          : actionId === 'code.format.apply' ? RPC_METHODS.DAEMON_LSP_FORMAT_APPLY
            : actionId === 'code.imports.organize' ? RPC_METHODS.DAEMON_LSP_IMPORTS_ORGANIZE_APPLY : RPC_METHODS.DAEMON_LSP_CODE_ACTION_APPLY;
      const invoke = async () => DaemonLspApplyResponseSchema.parse(await callMachineAction({
        machineId, serverId: context.serverId ?? undefined, method, request, timeoutMs: null,
        context, authority: context.authority, effectActionId: actionId, exactMachine: true, waitForResultOnCancel: true,
        ...(context.signal ? { signal: context.signal } : {}),
      }));
      return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, invoke) : invoke());
    },
    languageIntelligenceRestart: async ({ machineId, request }, context) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      try {
        const invoke = async () => DaemonLspRestartResponseSchema.safeParse(await callMachineAction({
          machineId, serverId: context.serverId ?? undefined, method: RPC_METHODS.DAEMON_LSP_RESTART, request, timeoutMs: null,
          context, authority: context.authority, effectActionId: 'code.restart', exactMachine: true,
          ...(context.signal ? { signal: context.signal } : {}),
        }));
        const result = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, invoke) : invoke());
        return result.success ? result.data : { status: 'unavailable', reason: 'invalid_response' };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        const reason = classifyWorkspaceFileRpcUnavailable(readRpcErrorCode(error));
        if (reason) return { status: 'unavailable', reason };
        throw error;
      }
    },
    workspaceFilesSearch: async ({ machineId, ...request }, context) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'workspace_file_search_unavailable', error: 'An authenticated machine transport is required.' };
      }
      try {
        const search = async () => DaemonWorkspaceFileSearchResponseSchema.parse(await callMachineAction({
          machineId, serverId: context.serverId ?? undefined, method: RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH, request,
          context, authority: context.authority, effectActionId: 'workspace.files.search', exactMachine: true,
          ...(context.signal ? { signal: context.signal } : {}),
        }));
        return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, search) : search());
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'server_scope_mismatch') {
          return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        }
        throw error;
      }
    },
  };
}
