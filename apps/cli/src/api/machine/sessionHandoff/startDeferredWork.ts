import type { SessionHandoffStartRequest } from '@happier-dev/protocol';
import type {
  ExternalSessionOperationClaimMaintenance,
} from '@/session/external/operationExclusion';

import type { DeferredDirectPeerPreExportedAgentBundle } from './startDeferredDirectPeer';

type SessionHandoffSourceStopState = 'stopped' | 'already_inactive' | 'failed';

export function startDeferredWork(input: Readonly<{
  deferredStartWorkPromise: Promise<void> | null;
  sessionId: string;
  handoffId: string;
  request: SessionHandoffStartRequest;
  metadata: Record<string, unknown>;
  preExportedAgentBundle?: DeferredDirectPeerPreExportedAgentBundle;
  onProgress?: (progress: Readonly<{ currentBytes: number; totalBytes: number }>) => void;
  stopSessionForHandoff?: (sessionId: string) => Promise<SessionHandoffSourceStopState>;
  prepareStartedState: (params: Readonly<{
    handoffId: string;
    request: SessionHandoffStartRequest;
    metadata: Record<string, unknown>;
    sourceStopState: Exclude<SessionHandoffSourceStopState, 'failed'>;
    preExportedAgentBundle?: DeferredDirectPeerPreExportedAgentBundle;
    onProgress?: (progress: Readonly<{ currentBytes: number; totalBytes: number }>) => void;
  }>) => Promise<unknown>;
  recordDeferredStartFailure: (error: unknown) => void;
  claimMaintenance: ExternalSessionOperationClaimMaintenance;
}>): void {
  const startWork =
    input.deferredStartWorkPromise
    ?? (async () => {
      input.claimMaintenance.throwIfLost();
      const actualSourceStopState =
        input.stopSessionForHandoff
          ? await input.claimMaintenance.race(() => input.stopSessionForHandoff!(input.sessionId))
          : 'already_inactive';
      if (actualSourceStopState === 'failed') {
        throw new Error('Failed to stop the active source session before handoff cutover');
      }
      input.claimMaintenance.throwIfLost();
      await input.claimMaintenance.race(() => input.prepareStartedState({
        handoffId: input.handoffId,
        request: input.request,
        metadata: input.metadata,
        sourceStopState: actualSourceStopState,
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        ...(input.preExportedAgentBundle ? { preExportedAgentBundle: input.preExportedAgentBundle } : {}),
      }));
    })();

  void input.claimMaintenance.race(() => startWork).catch(input.recordDeferredStartFailure);
}
