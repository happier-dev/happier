import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionForkPoint } from '@happier-dev/protocol';
import {
  isProviderBoundSessionMetadata,
  resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
  supportsAgentLifecycleCapability,
  type CurrentProjectedAgentCapabilities,
} from '@/agents/backendCatalog/currentAgentCapabilities';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export type SessionForkSupportSource = Pick<
  Session,
  'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView' | 'serverId'
>;

/**
 * Why the Native route is closed for this exact Session + cutoff.
 *
 * A closed set, not free text and not a per-Agent copy catalog: the strategy
 * modal renders the Native card disabled with one of these explanations rather
 * than omitting it, so the reader learns why the route they expected is not
 * available instead of watching the whole affordance disappear.
 */
export type SessionForkNativeUnavailableReason =
  /** This Agent declares no fork capability for this cutoff at all. */
  | 'agent_unsupported'
  /** This Agent forks the whole conversation but not from an earlier message. */
  | 'agent_conversation_only'
  /** A Provider-bound Session; the fork lifecycle owner refuses every non-replay strategy. */
  | 'provider_bound';

/**
 * Which fork routes this exact Session + cutoff can offer.
 *
 * `canForkConversation`/`canForkFromMessage` used to collapse these facts into
 * one boolean with an `||`, which was enough while the UI never had to say *how*
 * it was forking. The strategy modal has to name the routes separately — a
 * Native card may be shown disabled where only Replay is possible — so they are
 * resolved once here and the legacy predicates are expressed in terms of them.
 * There is no second fork-eligibility owner: `native` is exactly the canonical
 * `supportsAgentLifecycleCapability` verdict for every Agent, bundled or
 * externally installed, and the UI never chooses between provider-native and
 * ACP-native itself.
 *
 * `configure` lives here rather than a layer up for the same reason: the entry
 * points' "is there anything to open a modal for?" question and the modal's
 * "which cards are live?" question have to be the same question, or an entry
 * point deletes itself while the modal it would have opened still had a route.
 */
export type SessionForkStrategyAvailability = Readonly<{
  /** The Agent can fork this cutoff through its own conversation history. */
  native: boolean;
  /**
   * Happier Replay can seed a child from this cutoff. Its only closable cause
   * is the `sessionReplayEnabled` setting, so the disabled card needs no reason
   * field of its own.
   */
  replay: boolean;
  /** Source-context continuation to New Session, gated by `sessions.agentSwitching`. */
  configure: boolean;
  /** Set exactly when `native` is false and this Session/cutoff is real. */
  nativeUnavailableReason: SessionForkNativeUnavailableReason | null;
}>;

const UNAVAILABLE: SessionForkStrategyAvailability = {
  native: false,
  replay: false,
  configure: false,
  nativeUnavailableReason: null,
};

function isUsableForkPoint(forkPoint: SessionForkPoint): boolean {
  if (forkPoint.type === 'latest') return true;
  return Number.isFinite(forkPoint.upToSeqInclusive) && forkPoint.upToSeqInclusive > 0;
}

export function resolveSessionForkStrategyAvailability(params: Readonly<{
    session: SessionForkSupportSource | null | undefined;
    forkPoint: SessionForkPoint;
    replayEnabled: boolean | null | undefined;
    /**
     * The caller's already-resolved `sessions.agentSwitching` decision for THIS
     * Session's server. Required, not optional: the gate is `fail_closed`, so an
     * omitted decision would advertise a route the modal cannot offer.
     */
    agentSwitchingEnabled: boolean;
    /** Exact V2 declaration for an external Agent; absent/stale data closes that path. */
    currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
}>): SessionForkStrategyAvailability {
  const session = params.session ?? null;
  if (!session) return UNAVAILABLE;
  if (!isUsableForkPoint(params.forkPoint)) return UNAVAILABLE;

  const metadata = readSessionOwnerMetadataView(session);
  const agentId = resolveAgentIdFromSessionMetadata(metadata);
  const supportsNative = (capability: 'sessionFork.conversation' | 'sessionFork.fromMessage'): boolean => (
    supportsAgentLifecycleCapability({
      agentId,
      capability,
      metadata,
      currentAgentCapabilities: params.currentAgentCapabilities,
    })
  );

  const cutoffCapability = params.forkPoint.type === 'latest'
    ? 'sessionFork.conversation' as const
    : 'sessionFork.fromMessage' as const;
  const agentCanFork = supportsNative(cutoffCapability);
  // A Provider-bound Session cannot fork natively however capable its Agent is:
  // the fork lifecycle owner refuses every non-replay strategy so Provider
  // authorization completes before any vendor fork side effect. Both gates read
  // the one shared `isProviderBoundSessionMetadata` fact, so this is not a
  // second fork policy — and it is only worth naming when the Agent could
  // otherwise have done it.
  const providerBound = isProviderBoundSessionMetadata(metadata);
  const native = agentCanFork && !providerBound;

  return {
    native,
    replay: params.replayEnabled === true,
    configure: params.agentSwitchingEnabled === true,
    nativeUnavailableReason: native
      ? null
      : !agentCanFork
        ? (cutoffCapability === 'sessionFork.fromMessage' && supportsNative('sessionFork.conversation')
          ? 'agent_conversation_only'
          : 'agent_unsupported')
        : 'provider_bound',
  };
}

function offersAnyRoute(availability: SessionForkStrategyAvailability): boolean {
  return availability.native || availability.replay || availability.configure;
}

export function canForkConversation(params: {
  session: SessionForkSupportSource | null | undefined;
  replayEnabled: boolean | null | undefined;
  agentSwitchingEnabled: boolean;
  currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
}): boolean {
  return offersAnyRoute(resolveSessionForkStrategyAvailability({
    session: params.session,
    forkPoint: { type: 'latest' },
    replayEnabled: params.replayEnabled,
    agentSwitchingEnabled: params.agentSwitchingEnabled,
    currentAgentCapabilities: params.currentAgentCapabilities,
  }));
}

export function canForkFromMessage(params: {
  session: SessionForkSupportSource | null | undefined;
  messageSeq: number | null;
  replayEnabled: boolean | null | undefined;
  agentSwitchingEnabled: boolean;
  currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
}): boolean {
  const messageSeq = params.messageSeq;
  if (messageSeq == null) return false;
  return offersAnyRoute(resolveSessionForkStrategyAvailability({
    session: params.session,
    forkPoint: { type: 'seq', upToSeqInclusive: messageSeq },
    replayEnabled: params.replayEnabled,
    agentSwitchingEnabled: params.agentSwitchingEnabled,
    currentAgentCapabilities: params.currentAgentCapabilities,
  }));
}
