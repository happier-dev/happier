import type { SessionHandoffStartRequest } from '@happier-dev/protocol';

import type { DeferredDirectPeerPreExportedProviderBundle } from './startDeferredDirectPeer';

type SessionHandoffSourceStopState = 'stopped' | 'already_inactive' | 'failed';

export function startDeferredWork(input: Readonly<{
  deferredStartWorkPromise: Promise<void> | null;
  sessionId: string;
  handoffId: string;
  request: SessionHandoffStartRequest;
  metadata: Record<string, unknown>;
  preExportedProviderBundle?: DeferredDirectPeerPreExportedProviderBundle;
  stopSessionForHandoff?: (sessionId: string) => Promise<SessionHandoffSourceStopState>;
  prepareStartedState: (params: Readonly<{
    handoffId: string;
    request: SessionHandoffStartRequest;
    metadata: Record<string, unknown>;
    sourceStopState: Exclude<SessionHandoffSourceStopState, 'failed'>;
    preExportedProviderBundle?: DeferredDirectPeerPreExportedProviderBundle;
  }>) => Promise<unknown>;
  recordDeferredStartFailure: (error: unknown) => void;
}>): void {
  const startWork =
    input.deferredStartWorkPromise
    ?? (async () => {
      const actualSourceStopState =
        input.stopSessionForHandoff
          ? await input.stopSessionForHandoff(input.sessionId)
          : 'already_inactive';
      if (actualSourceStopState === 'failed') {
        throw new Error('Failed to stop the active source session before handoff cutover');
      }
      await input.prepareStartedState({
        handoffId: input.handoffId,
        request: input.request,
        metadata: input.metadata,
        sourceStopState: actualSourceStopState,
        ...(input.preExportedProviderBundle ? { preExportedProviderBundle: input.preExportedProviderBundle } : {}),
      });
    })();

  void startWork.catch(input.recordDeferredStartFailure);
}
