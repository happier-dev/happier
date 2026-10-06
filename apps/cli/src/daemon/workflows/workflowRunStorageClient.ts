import axios from 'axios';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { isWorkflowRunExecutorStorageOperationV1 } from '@happier-dev/protocol/workflows/workflowRunStorageV1';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { observeAccountChanges } from '@/api/observeAccountChanges';
import {
  createDefaultPluginInstallationPublisherHeader,
  type CreatePluginInstallationPublisherHeader,
} from '@/plugins/installations/publisherProof';

export const WORKFLOW_RUN_STORAGE_HTTP_PATH = '/v3/automations/runs/workflow-storage';

export type WorkflowRunStorageOperation = Readonly<Record<string, unknown> & {
  operation:
    | 'admit' | 'accepted-snapshot.resolve' | 'initialize' | 'get' | 'wait' | 'pause' | 'resume' | 'cancel' | 'list' | 'summaries' | 'recovery.list'
    | 'invocations.list' | 'invocations.admit' | 'invocations.get' | 'invocations.current' | 'invocations.fact'
    | 'invocations.publish_draft' | 'invocations.complete_review'
    | 'transition' | 'invocations.recover' | 'delete' | 'delivery.pull' | 'delivery.ack' | 'origin-input.withdrawn'
    | 'run-key.census' | 'run-key.commit';
}>;

/** Thin transport to the server's opaque workflow Run storage owner. */
export function createWorkflowRunStorageClient(params: Readonly<{
  token: string;
  machineId?: string;
  serverHttpBaseUrl?: string;
  createPublisherHeader?: CreatePluginInstallationPublisherHeader;
}>) {
  const baseUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const createPublisherHeader = params.createPublisherHeader ?? createDefaultPluginInstallationPublisherHeader;
  return {
    observeChanges: (runId: string, onChange: () => void, onError: (error: unknown) => void) =>
      observeAccountChanges({ token: params.token, serverUrl: baseUrl, entityId: `workflow-run:${runId}` }, { onChange, onError }),
    execute: async (operation: WorkflowRunStorageOperation, options: Readonly<{ signal?: AbortSignal }> = {}): Promise<unknown> => {
      const executorOperation = isWorkflowRunExecutorStorageOperationV1(operation.operation);
      if (executorOperation && !params.machineId) {
        throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
      }
      const body = { ...operation, ...(executorOperation ? { publisherMachineId: params.machineId } : {}) };
      const publisherHeader = executorOperation
        ? await createPublisherHeader({ method: 'POST', path: WORKFLOW_RUN_STORAGE_HTTP_PATH, body })
        : null;
      const request = () => axios.post<unknown>(`${baseUrl}${WORKFLOW_RUN_STORAGE_HTTP_PATH}`, body, {
        headers: {
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          Authorization: `Bearer ${params.token}`,
          'Content-Type': 'application/json',
          ...(publisherHeader ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader } : {}),
        },
        // The wait owner carries the authored observation deadline and abort.
        // Its exact snapshot read must not impose a competing fixed cutoff.
        timeout: operation.operation === 'wait' ? 0 : 30_000,
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
      return response.data;
    },
  };
}
