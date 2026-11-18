import type { ActionExecuteResult } from '@happier-dev/protocol/actions/executor/types';
import { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { fetchJson } from './http';

/** Observe the ordinary Workflow's public child reference through invocation history.
 * Callers keep their existing wait; refusals and invalid content must fail it fast. */
export async function readWorkflowChildSession(params: Readonly<{
  execute: (actionId: 'workflow.run.invocations.list', input: Readonly<{
    runId: string; includeContent?: boolean;
  }>) => Promise<ActionExecuteResult>;
  serverBaseUrl: string;
  token: string;
  runId: string;
  blockId: string;
}>) {
  const listed = await params.execute('workflow.run.invocations.list', { runId: params.runId, includeContent: true });
  if (!listed.ok) throw new Error(`Workflow child read refused (${listed.errorCode})`);
  const execution = WorkflowInvocationListResultV1Schema.parse(listed.result).invocationDetails
    ?.find(row => row.progress.invocationPath.blockId === params.blockId)?.progress.execution;
  if (execution?.kind !== 'session' && execution?.kind !== 'session_ready') return null;
  const response = await fetchJson<unknown>(`${params.serverBaseUrl}/v2/sessions/${encodeURIComponent(execution.sessionId)}`, {
    headers: { Authorization: `Bearer ${params.token}`,
      ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
  });
  if (response.status !== 200) throw new Error(`Workflow child Session read refused (${response.status})`);
  const session = V2SessionByIdResponseSchema.parse(response.data).session;
  if (session.origin?.kind !== 'run_step' || session.origin.runId !== params.runId) {
    throw new Error(`Workflow child Session has an unexpected Run origin (${execution.sessionId})`);
  }
  return session;
}
