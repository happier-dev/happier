import { SESSION_WORKSPACE_RETURN_ACTION_IDS_V1, SESSION_WORKSPACE_RETURN_CAPTURE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/sessionWorkspaceReturnActionIdsV1';
import { SessionWorkspaceReturnApplyInputV1Schema, SessionWorkspaceReturnApplyResultV1Schema,
  SessionWorkspaceReturnPrepareInputV1Schema, SessionWorkspaceReturnPreviewV1Schema,
  SessionWorkspaceReturnCaptureInputV1Schema, SessionWorkspaceReturnCaptureResultV1Schema } from '@happier-dev/protocol/actions/specs/session/projectFilesReturn';
import { configuration } from '@/configuration';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { buildActionExecutorContextForRpc } from './_actionDispatchAdapter';
import { readActionPrincipalAccountId } from '@/session/actions/actionPrincipalAccount';
import { readScmAccountScope, runWithScmAccountScope } from '@/scm/accountScope';
import type { MachineWorkspaceSyncRpcService } from '@/api/machine/rpcHandlers.workspaceSync';
import { prepareManagedWorkspaceReturn, applyManagedWorkspaceReturn, projectManagedWorkspaceReturnFailure } from '@/workspaces/sync/managedWorkspaceReturn';

/** Home ingress owns Session authorization; the return owner alone selects the host and guest paths. */
export function registerSessionWorkspaceReturnRpcHandlers(rpc: RpcHandlerRegistrar,
  service?: Pick<MachineWorkspaceSyncRpcService, 'captureSessionWorkspaceReturn'>): void {
  const scopedRpc: RpcHandlerRegistrar = { registerHandler: (method, handler) => {
    rpc.registerHandler(method, (input, ingress) => {
      const context = buildActionExecutorContextForRpc({ ...ingress });
      const accountId = readActionPrincipalAccountId(context) ?? readScmAccountScope();
      return accountId ? runWithScmAccountScope(accountId, () => handler(input, ingress),
        context.externalActionExecutionAuthorization) : handler(input, ingress);
    });
  } };
  scopedRpc.registerHandler(SESSION_WORKSPACE_RETURN_CAPTURE_ACTION_ID_V1, async (raw: unknown, context) => {
    const parsed = SessionWorkspaceReturnCaptureInputV1Schema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
    if (!service?.captureSessionWorkspaceReturn) return { ok: false, errorCode: 'workspace_source_operation_unavailable', error: 'workspace_source_operation_unavailable' };
    try {
      return SessionWorkspaceReturnCaptureResultV1Schema.parse(await service.captureSessionWorkspaceReturn({ sessionId: parsed.data.sessionId }, context));
    } catch (error) {
      return projectManagedWorkspaceReturnFailure(error, 'workspace.return.prepare');
    }
  });
  scopedRpc.registerHandler(SESSION_WORKSPACE_RETURN_ACTION_IDS_V1[0], async (raw: unknown, context) => {
    const parsed = SessionWorkspaceReturnPrepareInputV1Schema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
    try {
      return SessionWorkspaceReturnPreviewV1Schema.parse(await prepareManagedWorkspaceReturn({
        sessionId: parsed.data.sessionId, activeServerDir: configuration.activeServerDir,
        ...(context?.signal ? { signal: context.signal } : {}),
      }));
    } catch (error) {
      return projectManagedWorkspaceReturnFailure(error, 'workspace.return.prepare');
    }
  });
  scopedRpc.registerHandler(SESSION_WORKSPACE_RETURN_ACTION_IDS_V1[1], async (raw: unknown, context) => {
    const parsed = SessionWorkspaceReturnApplyInputV1Schema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
    try {
      return SessionWorkspaceReturnApplyResultV1Schema.parse(await applyManagedWorkspaceReturn({
        sessionId: parsed.data.sessionId, returnId: parsed.data.returnId, paths: parsed.data.paths,
        activeServerDir: configuration.activeServerDir,
        ...(parsed.data.replaceConflictPaths ? { replaceConflictPaths: parsed.data.replaceConflictPaths } : {}),
        ...(context?.signal ? { signal: context.signal } : {}),
      }));
    } catch (error) {
      return projectManagedWorkspaceReturnFailure(error, 'workspace.return.apply');
    }
  });
}
