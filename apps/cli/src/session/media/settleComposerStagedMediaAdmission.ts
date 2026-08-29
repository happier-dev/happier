import type { ComposerStagedMediaAdmissionSettlementV1 } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import type { ComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

import { garbageCollectUncommittedSessionMedia } from './garbageCollect';

type LoggerLike = Readonly<{
  debug: (message: string, details?: unknown) => void;
}>;

/**
 * The one post-admission settlement owner for Composer staged media.
 *
 * Every action here is addressed by the exact receipt the finalizer produced for this
 * Message — the stage identities it consumed, the workspace files it created, and the
 * workspace they live in. That is why the settlement no longer consults the tracked Session:
 * a definitive admission failure can land after the Session process is gone, and refusing to
 * act then stranded unreferenced SessionMedia files in the user's workspace with nothing left
 * to name them. Nothing outside this Message's own receipt can be reached from here.
 */
export async function settleComposerStagedMediaAdmissionV1(params: Readonly<{
  outcome: 'accepted' | 'definitiveFailure';
  settlement: ComposerStagedMediaAdmissionSettlementV1;
  stageStore: ComposerMediaStageStore;
  logger?: LoggerLike;
}>): Promise<void> {
  if (params.outcome === 'accepted') {
    // Acceptance keeps the durable Message media and releases only the transfer stages
    // this finalization consumed.
    await Promise.all(params.settlement.releaseIntents.map(
      async (intent) => await params.stageStore.release(intent),
    ));
    return;
  }
  await garbageCollectUncommittedSessionMedia({
    workingDirectory: params.settlement.workingDirectory,
    candidateWorkspaceRelativePaths: params.settlement.createdWorkspaceRelativePaths,
    reason: 'failed_durable_write',
    ...(params.logger ? { logger: params.logger } : {}),
  });
  await Promise.all(params.settlement.releaseIntents.map(
    async (intent) => await params.stageStore.release(intent),
  ));
}
