import {
  areConversationEndpointIdentitiesEqual,
  MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
  type ConversationBindingTargetV1,
  type ConversationBindingV1,
  type ConversationPairingResourceV1,
  type ConversationResolvedEndpointV1,
} from '@happier-dev/channels-protocol/v1';
import {
  arePluginMachineMaterializationRefsEqual,
  isPluginError,
  PluginError,
  type PluginMachineMaterializationRefV1,
} from '@happier-dev/plugin-sdk';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

import type { ConversationCommandClassification } from './commands.js';
import { renderConversationPairingDeepLink } from './pairingLink.js';

export const CONVERSATION_PAIRING_EXPIRY_MS = 10 * 60 * 1_000;
export const MAX_CONVERSATION_PAIRING_FAILED_ATTEMPTS_PER_REQUESTER = 5;
/**
 * Incumbent memory-safety bound, scoped to the one live connection challenge
 * it protects so one Account's traffic cannot exhaust another Account's
 * pairing state.
 */
export const MAX_CONVERSATION_PAIRING_TRACKED_REQUESTERS = 128;
export const MAX_CONVERSATION_PAIRING_TOMBSTONES = MAX_CONVERSATION_BINDINGS_PER_ACCOUNT * 2;

type PairingIdKind = 'challenge' | 'proposal' | 'binding';

/**
 * The single eviction rule for every bounded terminal-pairing record, whether
 * it is a bare tombstone set or a tombstone carrying its own expiry. Insertion
 * order is arrival order, so the oldest entry is the one that leaves once the
 * one declared budget is exceeded.
 */
function evictOldestBeyondTombstoneBudget(target: Readonly<{
  size: number;
  keys(): IterableIterator<string>;
  delete(key: string): boolean;
}>): void {
  if (target.size <= MAX_CONVERSATION_PAIRING_TOMBSTONES) return;
  const oldest = target.keys().next().value;
  if (oldest !== undefined) target.delete(oldest);
}

/**
 * Whether a repeated create matches the frozen content of the challenge its
 * request key created: revision, materialization, destination label, selected
 * endpoint, target, and the deep link rendered for this exact challenge
 * token. Callers reach this comparison only after the request keys matched.
 */
function isSameChallengeRequest(
  challenge: Challenge,
  input: Readonly<{
    expectedConnectionRevision: number;
    materialization: PluginMachineMaterializationRefV1;
    destinationLabel: string;
    endpoint: ConversationResolvedEndpointV1;
    target: ConversationBindingTargetV1;
  }>,
  requestedDeepLinkUrl: string | null,
): boolean {
  return challenge.expectedConnectionRevision === input.expectedConnectionRevision
    && arePluginMachineMaterializationRefsEqual(challenge.materialization, input.materialization)
    && challenge.destinationLabel === input.destinationLabel
    && areConversationEndpointIdentitiesEqual(challenge.endpoint, input.endpoint)
    && challenge.endpoint.label === input.endpoint.label
    && challenge.deepLinkUrl === requestedDeepLinkUrl
    && pluginJsonValuesEqual(challenge.target, input.target);
}

export type ConversationPairingBinding = ConversationBindingV1;
/** Exact bounded feedback from the Automation-owned target verifier. */
export type ConversationAutomationTargetNotVerifiedResult = Extract<
  PluginActionResultById['automation.conversation.target.verify'],
  Readonly<{ kind: 'notVerified' }>
>;

export type ConversationPairingBindingWriteInput = Readonly<{
  bindingId: string;
  connectionId: string;
  materialization: PluginMachineMaterializationRefV1;
  endpoint: ConversationResolvedEndpointV1;
  principalId: string;
  target: ConversationBindingTargetV1;
  enabled: false;
  expectedConnectionRevision: number;
  finalizeIdempotencyKey: string;
}>;

export type ConversationPairingBindingWriteResult =
  | Readonly<{ kind: 'created' | 'rejoined'; binding: ConversationPairingBinding }>
  | ConversationAutomationTargetNotVerifiedResult
  | Readonly<{
    kind: 'wrongMaterialization' | 'staleConnectionRevision' | 'alreadyConsumed' | 'conflict';
  }>;

/** Account Collection persistence is the genuine boundary below pairing memory state. */
export type ConversationPairingBindingWriter = (
  input: ConversationPairingBindingWriteInput,
) => Promise<ConversationPairingBindingWriteResult>;

type Challenge = Readonly<{
  challengeId: string;
  token: string;
  connectionId: string;
  expectedConnectionRevision: number;
  /** The client-generated opaque create-request key this challenge answers. */
  pairingRequestId: string;
  materialization: PluginMachineMaterializationRefV1;
  destinationLabel: string;
  expiresAt: number;
  /**
   * The conversation the owner chose to bind, resolved from the exact current
   * provider candidates before this challenge existed. It is deliberately not
   * the endpoint the proof arrives on: the token must travel privately, while
   * the destination may be a group nobody can prove identity in.
   */
  endpoint: ConversationResolvedEndpointV1;
  target: ConversationBindingTargetV1;
  deepLinkUrl: string | null;
}>;

type Proposal = Readonly<{
  censusId: string;
  challengeId: string;
  proposalId: string;
  bindingId: string;
  connectionId: string;
  materialization: PluginMachineMaterializationRefV1;
  /** The owner-selected destination frozen by the challenge. */
  endpoint: ConversationResolvedEndpointV1;
  /** The private conversation the `/pair` proof actually arrived on. */
  proofEndpoint: ConversationResolvedEndpointV1;
  principalId: string;
  target: ConversationBindingTargetV1;
  expectedConnectionRevision: number;
  expiresAt: number;
}> & {
  state: 'proposed' | 'finalizing' | 'finalized';
  finalizeIdempotencyKey?: string;
  finalizePromise?: Promise<ConversationPairingFinalizeResult>;
};

/**
 * This is deliberately in-memory only. The durable census is the replay
 * owner; a reservation cannot survive manager restart or mint a second
 * durable pairing ledger.
 */
type ConversationPreBindingPairingReservation =
  | Readonly<{
    kind: 'reserved';
    censusId: string;
    proposalId: string;
  }>
  | Readonly<{
    kind: 'reserved';
    censusId: string;
    challengeId: string;
    challengeToken: string;
    connectionId: string;
    materialization: PluginMachineMaterializationRefV1;
    endpoint: ConversationResolvedEndpointV1;
    principalId: string;
  }>;

export type ConversationPairingFinalizeResult =
  | Readonly<{ kind: 'created' | 'rejoined'; binding: ConversationPairingBinding }>
  | ConversationAutomationTargetNotVerifiedResult
  | Readonly<{
    kind: 'expired'
      | 'restarted'
      | 'wrongConnection'
      | 'wrongMaterialization'
      | 'alreadyConsumed'
      | 'staleConnectionRevision'
      | 'conflict'
      | 'retryableFailure';
  }>;

/** Exact JSON-safe result published by the present-user pairing cancellation Action. */
export type ConversationPairingCancelResult =
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{
    kind: 'notCancelled';
    reason: 'restarted' | 'unavailable' | 'finalizeInProgress' | 'bindingCreated';
  }>;

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodePairingToken(bytes: Uint8Array): string {
  if (bytes.length !== 5) throw new Error('Pairing randomness must contain exactly 5 bytes.');
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let token = '';
  for (let index = 0; index < 8; index += 1) {
    token = CROCKFORD_ALPHABET[Number(value & 31n)] + token;
    value >>= 5n;
  }
  return token;
}

export function createConversationPairingManager(dependencies: Readonly<{
  generationId: string;
  now: () => number;
  randomBytes: (length: number) => Uint8Array;
  createId: (kind: PairingIdKind) => string;
}>) {
  const challengesById = new Map<string, Challenge>();
  const challengeIdsByToken = new Map<string, string>();
  const challengeIdByConnection = new Map<string, string>();
  /**
   * One terminal-challenge record, not two mutually exclusive sets. A
   * challenge becomes terminal exactly once, and a superseded challenge is
   * consumed rather than expired; keeping two sets meant a manual cross-set
   * delete on every supersession and two independent eviction budgets, so the
   * effective tombstone bound was silently twice the declared one.
   */
  const terminalChallengeReasonById = new Map<string, 'expired' | 'consumed'>();
  const expiredProposalIds = new Set<string>();
  const consumedTokens = new Map<string, number>();
  const proposals = new Map<string, Proposal>();
  /**
   * Failed-requester budgets and charged-census replay keys scoped to exactly
   * one connection's live challenge. Guesses are only matchable while that
   * challenge lives, so this state is created with it and dropped whenever it
   * expires, is superseded, is consumed by a proof, or is cancelled — never
   * shared across connections and never left to outlive its challenge.
   */
  const failureStateByConnection = new Map<string, {
    failedAttemptsByRequester: Map<string, number>;
    chargedFailureCensusIds: Set<string>;
  }>();
  const proposalByFinalizeKey = new Map<string, string>();
  const proposalByCensusId = new Map<string, string>();
  const listeners = new Set<() => void>();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function addBoundedTombstone(target: Set<string>, id: string): void {
    target.add(id);
    evictOldestBeyondTombstoneBudget(target);
  }

  /**
   * Records the one terminal reason for a challenge under the single bounded
   * tombstone budget. A later reason replaces an earlier one in place, so a
   * superseded (consumed) challenge can never still read as expired.
   */
  function recordTerminalChallenge(challengeId: string, reason: 'expired' | 'consumed'): void {
    terminalChallengeReasonById.set(challengeId, reason);
    evictOldestBeyondTombstoneBudget(terminalChallengeReasonById);
  }

  /**
   * A consumed token is a terminal-challenge tombstone like any other: it only
   * has to outlive its own challenge window so a replayed `/pair` reads
   * `challengeConsumed` instead of `tokenMismatch`. Lazy expiry alone left it
   * bounded by pairing-operation rate rather than by a contract, so an owner
   * create/cancel loop grew daemon memory without limit inside one window.
   * It therefore shares the single tombstone budget rather than owning a
   * second eviction rule.
   */
  function recordConsumedToken(token: string, expiresAt: number): void {
    consumedTokens.set(token, expiresAt);
    evictOldestBeyondTombstoneBudget(consumedTokens);
  }

  /**
   * Removes one challenge from every live index and drops its challenge-scoped
   * failure accounting with it: failed-requester budgets and charged-census
   * replay keys bound guesses against this connection's live challenge only.
   * Every terminal transition (expiry, supersession, proof consumption,
   * cancellation) funnels through here so no transition can strand the state.
   */
  function detachChallenge(challenge: Challenge): void {
    challengesById.delete(challenge.challengeId);
    challengeIdsByToken.delete(challenge.token);
    if (challengeIdByConnection.get(challenge.connectionId) === challenge.challengeId) {
      challengeIdByConnection.delete(challenge.connectionId);
    }
    failureStateByConnection.delete(challenge.connectionId);
  }

  function expireChallenge(challenge: Challenge): void {
    detachChallenge(challenge);
    recordTerminalChallenge(challenge.challengeId, 'expired');
  }

  function pruneExpired(now: number): boolean {
    let changed = false;
    for (const challenge of challengesById.values()) {
      if (now >= challenge.expiresAt) {
        expireChallenge(challenge);
        changed = true;
      }
    }
    for (const [token, expiresAt] of consumedTokens) {
      if (now >= expiresAt) consumedTokens.delete(token);
    }
    for (const [proposalId, proposal] of proposals) {
      if (now >= proposal.expiresAt && proposal.state !== 'finalizing') {
        proposals.delete(proposalId);
        proposalByCensusId.delete(proposal.censusId);
        changed = true;
        if (proposal.state === 'proposed') addBoundedTombstone(expiredProposalIds, proposalId);
        if (proposal.finalizeIdempotencyKey !== undefined) {
          proposalByFinalizeKey.delete(proposal.finalizeIdempotencyKey);
        }
      }
    }
    return changed;
  }

  function nextExpiryAt(): number | undefined {
    let next: number | undefined;
    for (const challenge of challengesById.values()) {
      next = next === undefined ? challenge.expiresAt : Math.min(next, challenge.expiresAt);
    }
    for (const proposal of proposals.values()) {
      if (proposal.state === 'finalizing') continue;
      next = next === undefined ? proposal.expiresAt : Math.min(next, proposal.expiresAt);
    }
    return next;
  }

  function scheduleExpiryNotification(): void {
    if (expiryTimer !== undefined) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    if (disposed || listeners.size === 0) return;
    const expiresAt = nextExpiryAt();
    if (expiresAt === undefined) return;
    const delay = Math.max(0, expiresAt - dependencies.now());
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      if (pruneExpired(dependencies.now())) publishChange();
      else scheduleExpiryNotification();
    }, delay);
  }

  function publishChange(): void {
    if (disposed) return;
    for (const listener of listeners) listener();
    scheduleExpiryNotification();
  }

  function pruneExpiredAndPublish(now: number): void {
    if (pruneExpired(now)) publishChange();
  }

  function createUniqueToken(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const token = encodePairingToken(dependencies.randomBytes(5));
      if (!challengeIdsByToken.has(token) && !consumedTokens.has(token)) return token;
    }
    throw new Error('Unable to allocate a unique pairing token.');
  }

  return {
    /**
     * Creates — or exactly rejoins — the one live pairing challenge for a
     * connection. The caller supplies its own opaque `pairingRequestId`:
     * repeating that key with a semantically identical request rejoins the
     * active challenge and returns its unchanged handoff (the response-loss
     * retry path); a different key intentionally supersedes the previous
     * challenge by consuming its token. Repeating a key with different
     * content is refused without superseding, because one request id must
     * never come to represent two requests. There is deliberately no
     * process-global challenge count here: one active challenge per
     * connection, the ten-minute expiry, and the durable per-Account
     * connection quota already bound this state, so an Account-named limit
     * must never gate another Account's pairing.
     */
    createChallenge(input: Readonly<{
      connectionId: string;
      expectedConnectionRevision: number;
      pairingRequestId: string;
      materialization: PluginMachineMaterializationRefV1;
      destinationLabel: string;
      pairingDeepLinkTemplate?: string;
      endpoint: ConversationResolvedEndpointV1;
      target: ConversationBindingTargetV1;
    }>) {
      if (!Number.isSafeInteger(input.expectedConnectionRevision) || input.expectedConnectionRevision < 1) {
        throw new Error('Pairing challenge must freeze a valid connection revision.');
      }
      const now = dependencies.now();
      pruneExpiredAndPublish(now);
      const previousChallengeId = challengeIdByConnection.get(input.connectionId);
      const previousChallenge = previousChallengeId === undefined
        ? undefined
        : challengesById.get(previousChallengeId);
      if (previousChallenge !== undefined) {
        const requestedDeepLinkUrl = input.pairingDeepLinkTemplate === undefined
          ? null
          : renderConversationPairingDeepLink({
            template: input.pairingDeepLinkTemplate,
            normalizedToken: previousChallenge.token,
          });
        if (previousChallenge.pairingRequestId === input.pairingRequestId) {
          if (!isSameChallengeRequest(previousChallenge, input, requestedDeepLinkUrl)) {
            // One request id represents exactly one request. Repeating it
            // with different content is a caller bug: refuse without
            // rejoining, superseding, or disturbing the live challenge.
            throw new Error('A pairing request id must not be reused for a different pairing request.');
          }
          // Response-loss retry of this exact request: rejoin the live
          // challenge without minting a token, churning state, or letting a
          // second device's superseding challenge be adopted.
          return {
            kind: 'created',
            generationId: dependencies.generationId,
            challengeId: previousChallenge.challengeId,
            expiresAt: previousChallenge.expiresAt,
            attemptsRemaining: MAX_CONVERSATION_PAIRING_FAILED_ATTEMPTS_PER_REQUESTER,
            destinationLabel: previousChallenge.destinationLabel,
            manualToken: previousChallenge.token,
            deepLinkUrl: previousChallenge.deepLinkUrl,
          } as const;
        }
        // A different request intentionally supersedes the live challenge.
        detachChallenge(previousChallenge);
        recordTerminalChallenge(previousChallenge.challengeId, 'consumed');
        recordConsumedToken(previousChallenge.token, previousChallenge.expiresAt);
      }
      const token = createUniqueToken();
      const challengeId = dependencies.createId('challenge');
      if (challengesById.has(challengeId)) throw new Error('Pairing challenge IDs must be unique.');
      const challenge: Challenge = {
        challengeId,
        token,
        connectionId: input.connectionId,
        expectedConnectionRevision: input.expectedConnectionRevision,
        pairingRequestId: input.pairingRequestId,
        materialization: input.materialization,
        destinationLabel: input.destinationLabel,
        expiresAt: now + CONVERSATION_PAIRING_EXPIRY_MS,
        endpoint: input.endpoint,
        target: input.target,
        deepLinkUrl: input.pairingDeepLinkTemplate === undefined
          ? null
          : renderConversationPairingDeepLink({
            template: input.pairingDeepLinkTemplate,
            normalizedToken: token,
          }),
      };
      challengesById.set(challengeId, challenge);
      challengeIdsByToken.set(token, challengeId);
      challengeIdByConnection.set(input.connectionId, challengeId);
      failureStateByConnection.set(input.connectionId, {
        failedAttemptsByRequester: new Map(),
        chargedFailureCensusIds: new Set(),
      });
      publishChange();
      return {
        kind: 'created',
        generationId: dependencies.generationId,
        challengeId,
        expiresAt: challenge.expiresAt,
        attemptsRemaining: MAX_CONVERSATION_PAIRING_FAILED_ATTEMPTS_PER_REQUESTER,
        destinationLabel: challenge.destinationLabel,
        manualToken: token,
        deepLinkUrl: challenge.deepLinkUrl,
      } as const;
    },

    readChallenge(input: Readonly<{ generationId: string; challengeId: string }>) {
      if (input.generationId !== dependencies.generationId) return { kind: 'restarted' } as const;
      pruneExpiredAndPublish(dependencies.now());
      const challenge = challengesById.get(input.challengeId);
      if (challenge) {
        return {
          kind: 'active',
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt,
          attemptsRemaining: MAX_CONVERSATION_PAIRING_FAILED_ATTEMPTS_PER_REQUESTER,
          destinationLabel: challenge.destinationLabel,
          manualToken: challenge.token,
          deepLinkUrl: challenge.deepLinkUrl,
        } as const;
      }
      const terminalReason = terminalChallengeReasonById.get(input.challengeId);
      if (terminalReason === 'expired') return { kind: 'expired' } as const;
      if (terminalReason === 'consumed') return { kind: 'consumed' } as const;
      return { kind: 'unavailable' } as const;
    },

    /**
     * Validates a pairing command against this manager generation without
     * consuming its challenge. The ingress owner calls `commit` only after
     * the exact occurrence census has won its durable absent-CAS.
     */
    preparePreBindingMessage(input: Readonly<{
      censusId: string;
      connectionId: string;
      materialization: PluginMachineMaterializationRefV1;
      endpoint: ConversationResolvedEndpointV1;
      actor: Readonly<{
        principalId: string | null;
        kind: 'human' | 'integration' | 'bot' | 'unknown';
        isIntegrationSelf: boolean;
      }>;
      contentProvenance: 'original' | 'forwarded' | 'viaBot';
      command: ConversationCommandClassification;
    }>) {
      if (input.endpoint.audience !== 'direct'
        || input.actor.kind !== 'human'
        || input.actor.principalId === null
        || input.actor.isIntegrationSelf
        || input.contentProvenance !== 'original') {
        return { kind: 'silent', ownerReason: 'ineligibleCaller' } as const;
      }
      if (input.command.kind !== 'pair') {
        return { kind: 'silent', ownerReason: 'notPairingCommand' } as const;
      }

      const now = dependencies.now();
      pruneExpiredAndPublish(now);
      const existingProposalId = proposalByCensusId.get(input.censusId);
      if (existingProposalId !== undefined && proposals.has(existingProposalId)) {
        return {
          kind: 'reserved',
          censusId: input.censusId,
          proposalId: existingProposalId,
        } as const satisfies ConversationPreBindingPairingReservation;
      }

      /**
       * A failed `/pair` is charged to its requester once per provider
       * occurrence, never once per delivery, against the budget of the live
       * challenge on the connection where the attempt arrived. A checkpointed
       * pull re-presents its whole page until the checkpoint advances, so
       * charging per call let one unsettled batch silently burn a requester's
       * whole budget on a single mistyped token; the census ID is that
       * occurrence's immutable identity, and the challenge-scoped state dies
       * with the challenge it protects.
       */
      const failureState = failureStateByConnection.get(input.connectionId);
      const requesterAttempts = failureState?.failedAttemptsByRequester.get(input.actor.principalId) ?? 0;
      if (requesterAttempts >= MAX_CONVERSATION_PAIRING_FAILED_ATTEMPTS_PER_REQUESTER) {
        return {
          kind: 'silent',
          ownerReason: 'attemptLimitReached',
          attemptsRemaining: 0,
        } as const;
      }

      const challengeId = challengeIdsByToken.get(input.command.token);
      const challenge = challengeId === undefined ? undefined : challengesById.get(challengeId);
      if (challenge === undefined
        || challenge.connectionId !== input.connectionId
        || !arePluginMachineMaterializationRefsEqual(challenge.materialization, input.materialization)) {
        const ownerReason = consumedTokens.has(input.command.token) ? 'challengeConsumed' : 'tokenMismatch';
        if (failureState === undefined) {
          // No live challenge on this connection: nothing is matchable here,
          // so there is no budget to charge and none to report.
          return {
            kind: 'silent',
            ownerReason,
            attemptsRemaining: MAX_CONVERSATION_PAIRING_FAILED_ATTEMPTS_PER_REQUESTER,
          } as const;
        }
        if (failureState.chargedFailureCensusIds.has(input.censusId)) {
          return {
            kind: 'silent',
            ownerReason,
            attemptsRemaining: MAX_CONVERSATION_PAIRING_FAILED_ATTEMPTS_PER_REQUESTER - requesterAttempts,
          } as const;
        }
        if (
          requesterAttempts === 0
          && !failureState.failedAttemptsByRequester.has(input.actor.principalId)
          && failureState.failedAttemptsByRequester.size
            >= MAX_CONVERSATION_PAIRING_TRACKED_REQUESTERS
        ) {
          return {
            kind: 'silent',
            ownerReason: 'attemptCapacityReached',
            attemptsRemaining: 0,
          } as const;
        }
        const attempts = requesterAttempts + 1;
        failureState.failedAttemptsByRequester.set(input.actor.principalId, attempts);
        failureState.chargedFailureCensusIds.add(input.censusId);
        return {
          kind: 'silent',
          ownerReason,
          attemptsRemaining: MAX_CONVERSATION_PAIRING_FAILED_ATTEMPTS_PER_REQUESTER - attempts,
        } as const;
      }

      return {
        kind: 'reserved',
        censusId: input.censusId,
        challengeId: challenge.challengeId,
        challengeToken: challenge.token,
        connectionId: challenge.connectionId,
        materialization: challenge.materialization,
        endpoint: input.endpoint,
        principalId: input.actor.principalId,
      } as const satisfies ConversationPreBindingPairingReservation;
    },

    /** Commits only a reservation whose occurrence census has already persisted. */
    commitPreBindingMessage(reservation: ConversationPreBindingPairingReservation) {
      const existingProposalId = proposalByCensusId.get(reservation.censusId)
        ?? ('proposalId' in reservation ? reservation.proposalId : undefined);
      if (existingProposalId !== undefined) {
        const existing = proposals.get(existingProposalId);
        if (existing !== undefined && existing.censusId === reservation.censusId) {
          return { kind: 'matched', proposalId: existing.proposalId, expiresAt: existing.expiresAt } as const;
        }
      }
      if ('proposalId' in reservation) {
        return { kind: 'silent', ownerReason: 'reservationUnavailable' } as const;
      }

      const now = dependencies.now();
      pruneExpiredAndPublish(now);
      const challenge = challengesById.get(reservation.challengeId);
      if (
        challenge === undefined
        || challenge.token !== reservation.challengeToken
        || challenge.connectionId !== reservation.connectionId
        || !arePluginMachineMaterializationRefsEqual(challenge.materialization, reservation.materialization)
      ) {
        return { kind: 'silent', ownerReason: 'reservationUnavailable' } as const;
      }

      /**
       * The durable per-Account binding quota is enforced by the binding
       * writer at finalize, so the in-memory proposal count must never gate
       * one Account's proof because another Account holds proposals.
       */
      detachChallenge(challenge);
      recordTerminalChallenge(challenge.challengeId, 'consumed');
      recordConsumedToken(challenge.token, challenge.expiresAt);
      const proposalId = dependencies.createId('proposal');
      const proposal: Proposal = {
        censusId: reservation.censusId,
        challengeId: challenge.challengeId,
        proposalId,
        bindingId: dependencies.createId('binding'),
        connectionId: challenge.connectionId,
        materialization: challenge.materialization,
        endpoint: challenge.endpoint,
        proofEndpoint: reservation.endpoint,
        principalId: reservation.principalId,
        target: challenge.target,
        expectedConnectionRevision: challenge.expectedConnectionRevision,
        expiresAt: challenge.expiresAt,
        state: 'proposed',
      };
      proposals.set(proposalId, proposal);
      proposalByCensusId.set(reservation.censusId, proposalId);
      publishChange();
      return { kind: 'matched', proposalId, expiresAt: proposal.expiresAt } as const;
    },

    /**
     * The connection an unfinished pairing item is attached to, so the caller
     * that holds the current Account's storage can prove Account ownership
     * before asking for a mutation. Every other pairing entry already
     * establishes that correspondence for free — create and finalize read the
     * connection row under the current Account, and ingress arrives with a
     * connection the current Account resolved — but cancellation carried only
     * an opaque item ID, so possession of a retired Account's identifier was
     * sufficient authority over its in-memory state.
     *
     * A pairing item's connection never changes, so the caller may authorize
     * against this answer and then call cancel: the only transitions the gap
     * admits are the finalize/expiry ones cancellation already refuses.
     */
    readPendingConnectionId(input: Readonly<{
      generationId: string;
      challengeId?: string;
      proposalId?: string;
    }>):
      | Readonly<{ kind: 'pending'; connectionId: string }>
      | Readonly<{ kind: 'restarted' }>
      | Readonly<{ kind: 'unavailable' }> {
      if (input.generationId !== dependencies.generationId) return { kind: 'restarted' } as const;
      pruneExpiredAndPublish(dependencies.now());
      const pending = input.challengeId === undefined
        ? (input.proposalId === undefined ? undefined : proposals.get(input.proposalId))
        : challengesById.get(input.challengeId);
      return pending === undefined
        ? { kind: 'unavailable' } as const
        : { kind: 'pending', connectionId: pending.connectionId } as const;
    },

    cancelChallenge(input: Readonly<{ generationId: string; challengeId: string }>): ConversationPairingCancelResult {
      if (input.generationId !== dependencies.generationId) return { kind: 'notCancelled', reason: 'restarted' } as const;
      pruneExpiredAndPublish(dependencies.now());
      const challenge = challengesById.get(input.challengeId);
      if (!challenge) return { kind: 'notCancelled', reason: 'unavailable' } as const;
      detachChallenge(challenge);
      recordConsumedToken(challenge.token, challenge.expiresAt);
      publishChange();
      return { kind: 'cancelled' } as const;
    },

    cancelProposal(input: Readonly<{ generationId: string; proposalId: string }>): ConversationPairingCancelResult {
      if (input.generationId !== dependencies.generationId) return { kind: 'notCancelled', reason: 'restarted' } as const;
      pruneExpiredAndPublish(dependencies.now());
      const proposal = proposals.get(input.proposalId);
      if (!proposal) return { kind: 'notCancelled', reason: 'unavailable' } as const;
      if (proposal.state === 'finalizing') return { kind: 'notCancelled', reason: 'finalizeInProgress' } as const;
      if (proposal.state === 'finalized') return { kind: 'notCancelled', reason: 'bindingCreated' } as const;
      proposals.delete(input.proposalId);
      proposalByCensusId.delete(proposal.censusId);
      if (proposal.finalizeIdempotencyKey !== undefined) {
        proposalByFinalizeKey.delete(proposal.finalizeIdempotencyKey);
      }
      publishChange();
      return { kind: 'cancelled' } as const;
    },

    async finalize(
      input: Readonly<{
        generationId: string;
        proposalId: string;
        connectionId: string;
        expectedConnectionRevision: number;
        finalizeIdempotencyKey: string;
      }>,
      writeBinding: ConversationPairingBindingWriter,
    ): Promise<ConversationPairingFinalizeResult> {
      if (input.generationId !== dependencies.generationId) return { kind: 'restarted' };
      const proposal = proposals.get(input.proposalId);
      if (!proposal) {
        return expiredProposalIds.has(input.proposalId)
          ? { kind: 'expired' }
          : { kind: 'alreadyConsumed' };
      }
      if (dependencies.now() >= proposal.expiresAt && proposal.state === 'proposed') {
        proposals.delete(proposal.proposalId);
        proposalByCensusId.delete(proposal.censusId);
        addBoundedTombstone(expiredProposalIds, proposal.proposalId);
        publishChange();
        return { kind: 'expired' };
      }
      if (proposal.connectionId !== input.connectionId) return { kind: 'wrongConnection' };
      if (proposal.expectedConnectionRevision !== input.expectedConnectionRevision) {
        return { kind: 'staleConnectionRevision' };
      }

      const existingProposalId = proposalByFinalizeKey.get(input.finalizeIdempotencyKey);
      if (existingProposalId !== undefined && existingProposalId !== proposal.proposalId) {
        return { kind: 'alreadyConsumed' };
      }
      if (proposal.finalizeIdempotencyKey !== undefined
        && proposal.finalizeIdempotencyKey !== input.finalizeIdempotencyKey) {
        return { kind: 'alreadyConsumed' };
      }
      if (proposal.finalizePromise !== undefined) return proposal.finalizePromise;

      proposal.state = 'finalizing';
      proposal.finalizeIdempotencyKey = input.finalizeIdempotencyKey;
      proposalByFinalizeKey.set(input.finalizeIdempotencyKey, proposal.proposalId);
      publishChange();
      const operation = (async (): Promise<ConversationPairingFinalizeResult> => {
        try {
          const result = await writeBinding({
            bindingId: proposal.bindingId,
            connectionId: proposal.connectionId,
            materialization: proposal.materialization,
            endpoint: proposal.endpoint,
            principalId: proposal.principalId,
            target: proposal.target,
            enabled: false,
            expectedConnectionRevision: proposal.expectedConnectionRevision,
            finalizeIdempotencyKey: input.finalizeIdempotencyKey,
          });
          if (result.kind === 'created' || result.kind === 'rejoined') {
            proposal.state = 'finalized';
            return result;
          }
          proposal.state = 'proposed';
          return result;
        } catch (cause) {
          proposal.state = 'proposed';
          if (isPluginError(cause) && (
            cause.code === 'plugin_action_unavailable'
            || cause.code === 'channels_binding_create_corrupt'
          )) {
            throw cause;
          }
          // The write may have committed before response loss. Preserve the
          // binding ID and key so only an identical retry can rejoin it.
          return { kind: 'retryableFailure' };
        } finally {
          proposal.finalizePromise = undefined;
          publishChange();
        }
      })();
      proposal.finalizePromise = operation;
      return operation;
    },
    /**
     * The reader supplies the current Account's connection index and receives
     * only that Account's partition of the manager's state. Filtering used to
     * happen in the Resource after the manager had already answered with every
     * Account's rows, which made the consumer a second decision-maker over a
     * partition the producer is the only one able to enforce on mutation.
     *
     * An absent partition is a whole-state read for a caller that has no
     * Account scope at all — the manager's own tests and direct owners.
     */
    readManagementProjection(
      accountConnectionIds?: ReadonlySet<string>,
    ): ConversationPairingResourceV1 {
      const observedAt = dependencies.now();
      pruneExpiredAndPublish(observedAt);
      const inPartition = (connectionId: string): boolean => (
        accountConnectionIds === undefined || accountConnectionIds.has(connectionId)
      );
      return {
        generationId: dependencies.generationId,
        observedAt,
        challenges: [...challengesById.values()].filter((challenge) => (
          inPartition(challenge.connectionId)
        )).map((challenge) => ({
          challengeId: challenge.challengeId,
          connectionId: challenge.connectionId,
          expectedConnectionRevision: challenge.expectedConnectionRevision,
          pairingRequestId: challenge.pairingRequestId,
          expiresAt: challenge.expiresAt,
          attemptsRemaining: MAX_CONVERSATION_PAIRING_FAILED_ATTEMPTS_PER_REQUESTER,
          destinationLabel: challenge.destinationLabel,
          manualToken: challenge.token,
          deepLinkUrl: challenge.deepLinkUrl,
        })),
        proposals: [...proposals.values()].filter((proposal) => (
          inPartition(proposal.connectionId)
        )).map((proposal) => ({
          challengeId: proposal.challengeId,
          proposalId: proposal.proposalId,
          connectionId: proposal.connectionId,
          expectedConnectionRevision: proposal.expectedConnectionRevision,
          expiresAt: proposal.expiresAt,
          // The owner already chose the destination; the new fact this
          // projection carries is which private conversation proved the human.
          endpointLabel: proposal.proofEndpoint.label ?? null,
          state: proposal.state,
        })),
      };
    },
    subscribe(listener: () => void) {
      if (disposed) return { dispose() {} };
      listeners.add(listener);
      scheduleExpiryNotification();
      return {
        dispose() {
          listeners.delete(listener);
          scheduleExpiryNotification();
        },
      };
    },
    dispose(): void {
      disposed = true;
      listeners.clear();
      if (expiryTimer !== undefined) clearTimeout(expiryTimer);
      expiryTimer = undefined;
    },
  };
}

export type ConversationPairingManager = ReturnType<typeof createConversationPairingManager>;
