import type { AgentMessage } from '@/agent/core/AgentMessage';

import {
  createNormalizedRuntimeEventWriter,
  toRuntimeIdentityPublicationAgentMessage,
  type NormalizedRuntimeEventPublicationInput,
  type NormalizedRuntimeIdentityPublicationFact,
  type NormalizedRuntimeIdentityPublicationV1,
} from '@/agent/runtime/events/createNormalizedRuntimeEventWriter';

export type NormalizedRuntimeIdentityPublicationHandler =
  (publication: NormalizedRuntimeIdentityPublicationV1) => void;

export type NormalizedRuntimeEventPublicationHub<TMessage> = Readonly<{
  ensureUpstreamRegistered: () => void;
  publishFallbackIdentity: () => void;
  subscribe: (handler: (message: TMessage) => void) => () => void;
  /**
   * Typed host-private identity publication. Late subscribers are replayed the
   * latest value of every already-published fact, so the publication result —
   * not subscription order — is the contract. Identity observation is passive;
   * the message reader owns upstream activation and consumption.
   */
  subscribeIdentityPublication: (
    handler: NormalizedRuntimeIdentityPublicationHandler,
  ) => () => void;
  dispose: () => void;
}>;

/**
 * Shared lower-layer primitive for host bridges: normalize/publish runtime identity/capability/facet
 * events from an upstream runtime message stream, while routing all messages to subscribers.
 *
 * This intentionally does not know about sessions vs execution runs; it only manages:
 * - upstream subscription lifecycle
 * - message fanout to subscribers
 * - best-effort subscriber isolation
 * - runtime.* event normalization + fallback publication
 */
export function createNormalizedRuntimeEventPublicationHub<TMessage>(params: Readonly<{
  subscribeUpstream: (handler: (message: TMessage) => void) => () => void;
  identity: NormalizedRuntimeEventPublicationInput;
  /**
   * Opt-in compatibility mirror for the legacy host-private `AgentMessage`
   * family, whose generic `EventMessage` member is a real member of that union
   * and whose execution-run consumers already read these facts from the stream.
   * Bridges on the strict canonical Agent Session event union leave it off and
   * consume `subscribeIdentityPublication` instead.
   */
  mirrorIdentityPublicationToMessageStream?: boolean;
}>): NormalizedRuntimeEventPublicationHub<TMessage> {
  const handlers = new Set<(message: TMessage) => void>();
  const identityHandlers = new Set<NormalizedRuntimeIdentityPublicationHandler>();
  const publishedByFact = new Map<
    NormalizedRuntimeIdentityPublicationFact,
    NormalizedRuntimeIdentityPublicationV1
  >();
  let unsubscribeUpstream: (() => void) | null = null;

  const dispatch = (message: AgentMessage): void => {
    for (const handler of handlers) {
      try {
        handler(message as unknown as TMessage);
      } catch {
        // Best effort: publication subscribers must not break runtime routing.
      }
    }
  };

  const notifyIdentityHandler = (
    handler: NormalizedRuntimeIdentityPublicationHandler,
    publication: NormalizedRuntimeIdentityPublicationV1,
  ): void => {
    try {
      handler(publication);
    } catch {
      // Best effort: publication subscribers must not break runtime routing.
    }
  };

  const publishIdentity = (publication: NormalizedRuntimeIdentityPublicationV1): void => {
    publishedByFact.set(publication.fact, publication);
    if (params.mirrorIdentityPublicationToMessageStream) {
      dispatch(toRuntimeIdentityPublicationAgentMessage(publication));
    }
    for (const handler of identityHandlers) {
      notifyIdentityHandler(handler, publication);
    }
  };

  const runtimeEventWriter = createNormalizedRuntimeEventWriter({
    dispatch,
    publishIdentity,
    identity: params.identity,
  });

  const ensureUpstreamRegistered = (): void => {
    if (unsubscribeUpstream) return;
    unsubscribeUpstream = params.subscribeUpstream((message) => {
      runtimeEventWriter.handleMessage(message as unknown as AgentMessage);
    });
  };

  const clearUpstreamSubscription = (): void => {
    unsubscribeUpstream?.();
    unsubscribeUpstream = null;
  };

  const clearUpstreamSubscriptionIfUnused = (): void => {
    if (handlers.size === 0) {
      clearUpstreamSubscription();
    }
  };

  const subscribe = (handler: (message: TMessage) => void): (() => void) => {
    handlers.add(handler);
    ensureUpstreamRegistered();
    return () => {
      handlers.delete(handler);
      clearUpstreamSubscriptionIfUnused();
    };
  };

  const subscribeIdentityPublication = (
    handler: NormalizedRuntimeIdentityPublicationHandler,
  ): (() => void) => {
    identityHandlers.add(handler);
    for (const publication of Array.from(publishedByFact.values())) {
      notifyIdentityHandler(handler, publication);
    }
    return () => {
      identityHandlers.delete(handler);
      clearUpstreamSubscriptionIfUnused();
    };
  };

  const publishFallbackIdentity = (): void => {
    runtimeEventWriter.publishFallbackIdentity();
  };

  const dispose = (): void => {
    handlers.clear();
    identityHandlers.clear();
    clearUpstreamSubscription();
  };

  return Object.freeze({
    ensureUpstreamRegistered,
    publishFallbackIdentity,
    subscribe,
    subscribeIdentityPublication,
    dispose,
  });
}
