import axios from '@/api/client/credentialAxios';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { isWorkflowRunExecutorStorageOperationV1 } from '@happier-dev/protocol/workflows/workflowRunStorageV1';
import type { WorkflowRunStorageOperation } from '@happier-dev/protocol/workflows/workflowRunStorageV1';
export type { WorkflowRunStorageOperation } from '@happier-dev/protocol/workflows/workflowRunStorageV1';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { resolveWorkflowRunFollowEventV1 } from '@happier-dev/protocol/workflows/composeWorkflowRunWorkerUpdateV1';
import { projectActionFailureCauseV1, readActionErrorCodeV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readAxiosResponseErrorCode } from '@/api/client/readAxiosResponseErrorCode';
import { classifyDaemonServerWorkError } from '@/daemon/serverWork/classifyDaemonServerWorkError';
import type { notifyDaemonSessionActivityChanged } from '@/daemon/controlClient';
import type { logger } from '@/ui/logger';

import type { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { captureServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { observeAccountChanges } from '@/api/observeAccountChanges';
import {
  createDefaultPluginInstallationPublisherHeader,
  type CreatePluginInstallationPublisherHeader,
} from '@/plugins/installations/publisherProof';

export const WORKFLOW_RUN_STORAGE_HTTP_PATH = '/v3/automations/runs/workflow-storage';

/** Keep the first storage boundary's safe cause when the coordinator parks a Run. */
export function readWorkflowRunStorageFailure(error: unknown): Readonly<{ failureCause: ActionFailureCauseV1; message: string }> | null {
  if (typeof error !== 'object' || error === null || !('workflowStorageOperation' in error)
    || classifyDaemonServerWorkError(error).kind !== 'server_error') return null;
  const metadata = error.workflowStorageOperation;
  const operation = typeof metadata === 'object' && metadata !== null && 'operation' in metadata
    && typeof metadata.operation === 'string' ? metadata.operation : null;
  const transportCause = projectActionFailureCauseV1(error,
    operation === null ? 'workflow.storage' : `workflow.storage.${operation.replaceAll('-', '_')}`);
  const failureCause: ActionFailureCauseV1 = { phase: transportCause.phase, errorClass: transportCause.errorClass,
    errorCode: readActionErrorCodeV1({ code: readAxiosResponseErrorCode(error) }) ?? transportCause.errorCode,
    httpStatus: transportCause.httpStatus };
  return { failureCause,
    message: `Workflow storage is temporarily unavailable (${failureCause.errorCode ?? 'storage_unavailable'}). Previously saved work is preserved; review the run before continuing.` };
}

/** Thin transport to the server's opaque workflow Run storage owner. */
export function createWorkflowRunStorageClient(params: Readonly<{
  token: string;
  machineId?: string;
  serverHttpBaseUrl?: string;
  createPublisherHeader?: CreatePluginInstallationPublisherHeader;
  resolveAuthorizationHeaders?: (request: Readonly<{ method: 'POST'; path: string; body: unknown }>) => Readonly<Record<string, string>> | null;
}>) {
  const explicitBaseUrl = params.serverHttpBaseUrl;
  const readBaseUrl = explicitBaseUrl === undefined
    ? captureServerHttpBaseUrl() : () => explicitBaseUrl;
  const createPublisherHeader = params.createPublisherHeader ?? createDefaultPluginInstallationPublisherHeader;
  const client = {
    observeChanges: (runId: string, onChange: () => void, onError: (error: unknown) => void) =>
      observeAccountChanges({ token: params.token, serverUrl: readBaseUrl(), entityId: `workflow-run:${runId}` }, { onChange, onError }),
    execute: async (operation: WorkflowRunStorageOperation, options: Readonly<{ signal?: AbortSignal; publisherMachineId?: string }> = {}): Promise<unknown> => {
      const baseUrl = readBaseUrl();
      const startedAtMs = Date.now();
      try {
        const executorOperation = isWorkflowRunExecutorStorageOperationV1(operation.operation);
        const publisherMachineId = options.publisherMachineId ?? (executorOperation ? params.machineId : undefined);
        if (executorOperation && !publisherMachineId) {
          throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        }
        const body = { ...operation, ...(publisherMachineId ? { publisherMachineId } : {}) };
        const publisherHeader = publisherMachineId
          ? await createPublisherHeader({ method: 'POST', path: WORKFLOW_RUN_STORAGE_HTTP_PATH, body })
          : null;
        const authorizationHeaders = params.resolveAuthorizationHeaders
          ? params.resolveAuthorizationHeaders({ method: 'POST', path: WORKFLOW_RUN_STORAGE_HTTP_PATH, body })
          : { Authorization: `Bearer ${params.token}` };
        if (!authorizationHeaders) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
        const { buildCurrentAccountStoredContentCompatibilityHttpHeaders } = await import("@/api/clientCompatibility/cliClientCompatibility");
        const request = () => axios.post<unknown>(`${baseUrl}${WORKFLOW_RUN_STORAGE_HTTP_PATH}`, body, {
          headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            ...authorizationHeaders,
            'Content-Type': 'application/json',
            ...(publisherHeader ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader } : {}),
          },
          // The containing Action, worker or recovery lifetime owns cancellation;
          // storage does not impose a shorter competing deadline.
          timeout: 0,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const response = await request().catch(async (error: unknown) => {
          const ambiguous = typeof error !== 'object' || error === null
            || (!(error as { response?: unknown }).response && (error as { code?: unknown }).code !== 'ERR_CANCELED');
          if (![
            'admit', 'accepted-snapshot.resolve', 'initialize', 'invocations.admit',
            'invocations.recover',
          ].includes(operation.operation) || !ambiguous) throw error;
          // Direct Run admission, Automation accepted-snapshot attachment,
          // initialization, and caller-bound row admission/recovery all have an exact
          // lost-response rejoin contract. Reuse caller ids and sealed bytes
          // verbatim; never resolve a mutable source again here.
          return await request();
        });
        if (operation.operation === 'transition') {
          const run = WorkflowRunSummaryV1Schema.safeParse(response.data);
          const event = run.success ? resolveWorkflowRunFollowEventV1(run.data) : null;
          if (run.success && run.data.revision > 0 && run.data.workflowCustodyState !== null && event) {
            const [{ notifyDaemonSessionActivityChanged }, { logger }] = await Promise.all([import("@/daemon/controlClient"), import("@/ui/logger")]);
            void notifyDaemonSessionActivityChanged(run.data.origin.originSessionId ?? null, {
              original: { source: { kind: 'workflow_run', runId: run.data.id }, revision: run.data.revision },
              event,
            }).catch(error => logger.debug('[workflowRunStorage] Follow occurrence remains in Run custody', error));
          }
        }
        return response.data;
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error('workflow_storage_operation_failed', { cause: error }), {
          workflowStorageOperation: { operation: operation.operation, durationMs: Date.now() - startedAtMs },
        });
      }
    },
  };
  return client;
}
