import type { CliActionDepsParams } from './cliActionDeps/types';
import { isWorkflowRunExecutorStorageOperationV1 } from '@happier-dev/protocol/workflows/workflowRunStorageV1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createWorkflowRunStorageClient } from '@/daemon/workflows/workflowRunStorageClient';
import type { WorkflowAccountRunActionDeps } from '@happier-dev/protocol';
import type { WorkflowCombinedRunStartV1 } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';


export type CliWorkflowRequestHeaders = (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
export type CliWorkflowCurrentSessionValue = (key: 'path' | 'host' | 'machineId', signal?: AbortSignal) => Promise<string | null>;
export type CliWorkflowRunStorageFactory = (caller?: Readonly<{ actionId: string; context: ActionExecutorContext }>
  | Pick<WorkflowCombinedRunStartV1, 'parent' | 'context'>) => WorkflowAccountRunActionDeps['storage'];
export type CliWorkflowRunStorage = Readonly<{
  workflowRunServerHttpBaseUrl: string;
  createWorkflowRunStorage: CliWorkflowRunStorageFactory;
  workflowRunStorage: WorkflowAccountRunActionDeps['storage'];
}>;
export function createCliWorkflowRunStorage(
  params: Pick<CliActionDepsParams, 'token' | 'serverHttpBaseUrl'>,
  resolveCurrentSessionValue: CliWorkflowCurrentSessionValue,
  resolveServerRequestHeaders: CliWorkflowRequestHeaders,
  normalizeStringValue: (value: unknown) => string | null,
): CliWorkflowRunStorage {

  const workflowRunServerHttpBaseUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const createWorkflowRunStorage: CliWorkflowRunStorageFactory = (caller) => {
    // Private Account custody retains ordinary Run access. HTTP-only callers
    // spend their admitted signed parent rather than the installed Account.
    const combined = caller && 'parent' in caller ? caller : undefined;
    const requester = combined ? readRequesterAccountActionContext(combined.context.externalActionExecutionAuthorization) : null;
    const requesterHttp = requester ? undefined : combined?.context.externalActionExecutionAuthorization?.requesterHttpProjection;
    // The existing Account socket supplies content-free wakes only; every
    // signed request below retains its original requester effect authority.
    const token = requester?.credentials.token ?? params.token;
    const serverHttpBaseUrl = requester?.serverHttpBaseUrl ?? requesterHttp?.serverHttpBaseUrl ?? workflowRunServerHttpBaseUrl;
    // Select the admitted requester here; Home authorizes each storage request.
    // An observation gap cannot revoke the starter's already-admitted Run.
    // Content mode and keys remain the encryption owner's decision.
    const assertCombinedRequester = () => {
      if (combined && (combined.context.externalActionExecutionAuthorization || combined.context.externalActionCredential)
        && !requester && !requesterHttp) {
        throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
      }
    };
    const storage: WorkflowAccountRunActionDeps['storage'] = {
    observeChanges: (runId, onChange, onError) => {
      if (!combined) return createWorkflowRunStorageClient({ token, serverHttpBaseUrl }).observeChanges(runId, onChange, onError);
      let disposed = false;
      let observation: ReturnType<ReturnType<typeof createWorkflowRunStorageClient>['observeChanges']> | undefined;
      const failed = (error: unknown) => {
        if (disposed) return;
        disposed = true;
        void observation?.dispose().catch(onError);
        onError(error);
      };
      const started = (async () => {
        assertCombinedRequester();
        if (disposed) return;
        observation = createWorkflowRunStorageClient({ token, serverHttpBaseUrl }).observeChanges(runId, () => {
          if (!disposed) onChange();
        }, failed);
      })().catch(failed);
      return { dispose: async () => { disposed = true; await started; await observation?.dispose(); } };
    },
    execute: async (operation, options) => {
      assertCombinedRequester();
      let machineId: string | undefined;
      const authorizationMachineId = caller?.context.externalActionExecutionAuthorization?.binding.machineId;
      if (isWorkflowRunExecutorStorageOperationV1(operation.operation) || authorizationMachineId) {
        const publisherMachineId = normalizeStringValue(options?.publisherMachineId);
        const operationMachineId = publisherMachineId ?? (typeof operation.machineId === 'string' && operation.machineId.trim()
          ? operation.machineId.trim()
          : null);
        if (authorizationMachineId && operationMachineId && authorizationMachineId !== operationMachineId) {
          throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable',
            details: { code: 'target_unavailable', reason: 'target_binding_mismatch' } });
        }
        const { readSettings } = await import("@/persistence");
        const settingsMachineId = operationMachineId || authorizationMachineId ? null : normalizeStringValue((await readSettings()).machineId);
        const resolvedMachineId = operationMachineId ?? authorizationMachineId ?? settingsMachineId ?? await resolveCurrentSessionValue('machineId');
        if (!resolvedMachineId) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable',
          details: { code: 'target_unavailable', reason: 'publisher_machine_unavailable' } });
        machineId = resolvedMachineId;
      }
      return await createWorkflowRunStorageClient({
        token,
        ...(machineId ? { machineId } : {}),
        serverHttpBaseUrl,
        ...(caller && 'actionId' in caller ? { resolveAuthorizationHeaders: (request) => resolveServerRequestHeaders(caller.context, caller.actionId, request) }
          : combined && requesterHttp ? { resolveAuthorizationHeaders: (request) => resolveServerRequestHeaders(combined.context, combined.parent.actionId, request) } : {}),
      }).execute(
        operation as Parameters<ReturnType<typeof createWorkflowRunStorageClient>['execute']>[0],
        { ...(options?.signal ? { signal: options.signal } : {}),
          ...(authorizationMachineId ? { publisherMachineId: machineId } : {}) },
      );
    },
    };
    return storage;
  };
  const workflowRunStorage = createWorkflowRunStorage();
  return { workflowRunServerHttpBaseUrl, createWorkflowRunStorage, workflowRunStorage };
}
