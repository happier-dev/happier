import type { StoredCredentials } from '@/persistence';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { readOwnSessionMachineWorkspace } from '@/session/machineControlLocality';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readRequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionContext';
import { isOriginalOwnAccountActionCustody } from '../sessionEncryption/requesterAccountActionProjection';
import { createDaemonSessionMutationCustody, type DaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';

/** Admitted host custody, kept private for the lifetime of one recording. */
export type RecordingOperationContext = Pick<RpcActionExecutorContext,
  'externalActionExecutionAuthorization' | 'requesterSessionBootstrap' | 'defaultSessionId'>;

/** Browser and Computer media use the Account/Home that admitted capture. */
export function createRecordingSessionMediaHost(input: Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  machineId: string;
  currentMachineHost: string;
  currentMachineHomeDir: string;
  signal?: AbortSignal;
  mutationCustody: DaemonSessionMutationCustody;
  title: string;
}>) {
  function custody(context?: RecordingOperationContext) {
    const requester = readRequesterAccountActionContext(context?.externalActionExecutionAuthorization)
      ?? context?.requesterSessionBootstrap;
    if (requester) return requester;
    const authorization = context?.externalActionExecutionAuthorization;
    if (authorization && !isOriginalOwnAccountActionCustody(authorization.binding)) {
      throw new Error('Recording requester Account custody is unavailable.');
    }
    return null;
  }
  return {
    async resolveWorkingDirectory({ sessionId }: Readonly<{ sessionId: string }>, context?: RecordingOperationContext) {
      const requester = custody(context);
      const workspace = await readOwnSessionMachineWorkspace({
        credentials: requester?.credentials ?? input.credentials,
        serverHttpBaseUrl: requester?.serverHttpBaseUrl ?? input.serverHttpBaseUrl,
        sessionId, machineId: input.machineId,
        currentMachineHost: input.currentMachineHost, currentMachineHomeDir: input.currentMachineHomeDir,
        signal: input.signal,
      });
      if (!workspace) throw new Error('Recording Session working directory is unavailable.');
      return workspace.rootPath;
    },
    async commitAttachment(attachment: Readonly<{ sessionId: string; localId: string; meta: Record<string, unknown> }>, context?: RecordingOperationContext) {
      const requester = custody(context);
      const mutation = { sessionId: attachment.sessionId, localId: attachment.localId, messageRole: 'user' as const,
        payload: { role: 'user', content: { type: 'text', text: input.title }, meta: attachment.meta } };
      if (!requester) {
        await input.mutationCustody.stageTranscriptMessage(mutation);
        return;
      }
      await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, async () => {
        const owner = createDaemonSessionMutationCustody({ credentials: requester.credentials });
        try { await owner.stageTranscriptMessage(mutation); }
        finally { await owner.close(); }
      });
    },
  };
}
