import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionForkPoint } from '@happier-dev/protocol';
import { evaluateAgentSessionCapabilitySupport, inferAgentIdFromSessionMetadata } from '@happier-dev/agents';

export type SessionForkSupportSource = Pick<Session, 'metadata'>;

/**
 * Which fork routes this exact Session + cutoff can offer.
 *
 * `canForkConversation`/`canForkFromMessage` used to collapse these two facts
 * into one boolean with an early `return true`, which was enough while the UI
 * never had to say *how* it was forking. The strategy modal has to name the
 * routes separately — a Native card may not be offered where only Replay is
 * possible — so the two facts are resolved once here and the legacy predicates
 * are expressed in terms of them. There is no second fork-eligibility owner:
 * `native` is still exactly the canonical `evaluateAgentSessionCapabilitySupport`
 * verdict and the UI never chooses between provider-native and ACP-native itself.
 */
export type SessionForkStrategyAvailability = Readonly<{
  /** The Agent can fork this cutoff through its own conversation history. */
  native: boolean;
  /** Happier Replay can seed a child from this cutoff. */
  replay: boolean;
}>;

const UNAVAILABLE: SessionForkStrategyAvailability = { native: false, replay: false };

function isUsableForkPoint(forkPoint: SessionForkPoint): boolean {
  if (forkPoint.type === 'latest') return true;
  return Number.isFinite(forkPoint.upToSeqInclusive) && forkPoint.upToSeqInclusive > 0;
}

export function resolveSessionForkStrategyAvailability(params: Readonly<{
  session: SessionForkSupportSource | null | undefined;
  forkPoint: SessionForkPoint;
  replayEnabled: boolean | null | undefined;
}>): SessionForkStrategyAvailability {
  const session = params.session ?? null;
  if (!session) return UNAVAILABLE;
  if (!isUsableForkPoint(params.forkPoint)) return UNAVAILABLE;

  const metadata = session.metadata;
  const agentId = inferAgentIdFromSessionMetadata(metadata);
  const native = evaluateAgentSessionCapabilitySupport({
    agentId,
    capability: params.forkPoint.type === 'latest' ? 'sessionFork.conversation' : 'sessionFork.fromMessage',
    metadata,
  }) === 'supported';

  return { native, replay: params.replayEnabled === true };
}

export function canForkConversation(params: { session: SessionForkSupportSource | null | undefined; replayEnabled: boolean | null | undefined }): boolean {
  const availability = resolveSessionForkStrategyAvailability({
    session: params.session,
    forkPoint: { type: 'latest' },
    replayEnabled: params.replayEnabled,
  });
  return availability.native || availability.replay;
}

export function canForkFromMessage(params: {
  session: SessionForkSupportSource | null | undefined;
  messageSeq: number | null;
  replayEnabled: boolean | null | undefined;
}): boolean {
  const messageSeq = params.messageSeq;
  if (messageSeq == null) return false;
  const availability = resolveSessionForkStrategyAvailability({
    session: params.session,
    forkPoint: { type: 'seq', upToSeqInclusive: messageSeq },
    replayEnabled: params.replayEnabled,
  });
  return availability.native || availability.replay;
}
