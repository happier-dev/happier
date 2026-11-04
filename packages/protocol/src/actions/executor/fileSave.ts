import { DeploymentLogsReadSuccessV1Schema } from '../../deployments/deploymentReadsV1.js';
import type { ManagedServiceNativeLogCursorV1 } from '../../local/services/nativeLogsV1.js';
import type { FileSaveInput } from '../fileSaveActionFamily.js';
import type { ActionExecutorContext, ActionExecutorDeps, ActionExecuteResult } from './types.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';
import { executeDeploymentAction } from './deploymentAction.js';

/** One admitted file handoff. Deployment bytes come only from the existing masked reader. */
export async function executeFileSave(input: FileSaveInput, context: ActionExecutorContext, deps: ActionExecutorDeps): Promise<ActionExecuteResult> {
  if (!deps.saveClientFile) return { ok: false, errorCode: 'client_required', error: 'client_required' };
  let text: string;
  if (input.source.kind === 'text') text = input.source.text;
  else {
    text = '';
    let cursor: ManagedServiceNativeLogCursorV1 | null = null;
    let revision: string | null = null;
    do {
      context.signal?.throwIfAborted();
      const result = await executeDeploymentAction('deployments.logs.read', {
        ...input.source.reference, ...(cursor ? { cursor } : {}),
      }, context, deps);
      if (!result.ok) return result;
      const read = DeploymentLogsReadSuccessV1Schema.safeParse(result.result);
      if (!read.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
      const logs = read.data.logs;
      if (logs.kind === 'unavailable') return { ok: false, errorCode: logs.reason, error: logs.reason };
      if (logs.kind === 'source-changed' || revision !== null && logs.page.sourceRevision !== revision)
        return { ok: false, errorCode: 'source_changed', error: 'source_changed' };
      revision = logs.page.sourceRevision;
      text += logs.page.text;
      cursor = logs.page.nextCursor;
    } while (cursor !== null);
  }
  context.signal?.throwIfAborted();
  const result = await deps.saveClientFile({ bytes: new TextEncoder().encode(text), fileName: input.fileName,
    ...(context.signal ? { signal: context.signal } : {}) });
  return readActionFailureEnvelope(result) ?? { ok: true, result };
}
