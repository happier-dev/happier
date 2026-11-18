import type { ChatFooterExternalControlState } from './ChatFooter';

type ExternalControlState = NonNullable<ChatFooterExternalControlState>;

export type ChatFooterExternalControlActions = Readonly<{
  switchingToDirect: boolean;
  switchingToPersisted: boolean;
  preflightInFlight: boolean;
  /** Take over (or Re-check while the outside Agent runs) holds the primary seat. */
  showTakeoverAction: boolean;
  continueInNewSession: ExternalControlState['continueInNewSession'] | null;
  materialize: ExternalControlState['materialize'];
  importIsPrimary: boolean;
  /** The reader's own takeover, check or import request is running. */
  operationInFlight: boolean;
}>;

/**
 * The external control row's actions, decided once: the row renders them, and the footer resolver keeps the
 * row (and the not-resumable notice yields to it) only while they offer a way forward.
 */
export function resolveChatFooterExternalControlActions(
  state: ExternalControlState,
): ChatFooterExternalControlActions {
  const switchingToDirect = state.takeoverInFlight === 'direct';
  const switchingToPersisted = state.takeoverInFlight === 'persisted';
  const preflightInFlight = state.takeoverPreflightInFlight;
  const showTakeoverAction =
    !switchingToDirect &&
    !switchingToPersisted &&
    (!state.statusKnown ||
      state.runnerActive ||
      state.canTakeOverDirect ||
      state.canTakeOverPersist) &&
    typeof state.onRequestTakeoverPreflight === 'function';
  const materialize = state.materialize ?? null;
  const continueInNewSession = showTakeoverAction
    ? null
    : (state.continueInNewSession ?? null);
  return {
    switchingToDirect,
    switchingToPersisted,
    preflightInFlight,
    showTakeoverAction,
    continueInNewSession,
    materialize,
    importIsPrimary:
      materialize !== null &&
      !showTakeoverAction &&
      continueInNewSession === null,
    operationInFlight:
      switchingToDirect ||
      switchingToPersisted ||
      preflightInFlight ||
      materialize?.inFlight === true ||
      continueInNewSession?.inFlight === true,
  };
}

/** The row has something to say beyond where the Session runs, which the header already shows. */
export function chatFooterExternalControlOffersWayForward(
  actions: ChatFooterExternalControlActions,
): boolean {
  return (
    actions.operationInFlight ||
    actions.showTakeoverAction ||
    actions.continueInNewSession !== null ||
    actions.materialize !== null
  );
}
