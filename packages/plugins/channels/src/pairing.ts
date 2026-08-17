import {
  MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
  MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
  type ConversationBindingTargetMutationV1,
  type ConversationBindingV1,
  type ConversationPairingResourceV1,
  type ConversationResolvedEndpointV1,
} from '@happier-dev/channels-protocol/v1';
import { PluginError, type PluginMachineMaterializationRefV1 } from '@happier-dev/plugin-sdk';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

import type { ConversationCommandClassification } from './commands.js';
import { renderConversationPairingDeepLink } from './pairingLink.js';

export const CONVERSATION_PAIRING_EXPIRY_MS = 10 * 60 * 1_000;
export const MAX_CONVERSATION_PAIRING_FAILED_ATTEMPTS_PER_REQUESTER = 5;
export const MAX_CONVERSATION_PAIRING_TRACKED_REQUESTERS = 128;
const MAX_CONVERSATION_PAIRING_TOMBSTONES = MAX_CONVERSATION_BINDINGS_PER_ACCOUNT * 2;

type PairingIdKind = 'challenge' | 'proposal' | 'binding';
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
  target: ConversationBindingTargetMutationV1;
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
  materialization: PluginMachineMaterializationRefV1;
  destinationLabel: string;
  expiresAt: number;
  target: ConversationBindingTargetMutationV1;
  deepLinkUrl: string | null;
}>;

type Proposal = Readonly<{
  censusId: string;
  challengeId: string;
  proposalId: string;
  bindingId: string;
  connectionId: string;
  materialization: PluginMachineMaterializationRefV1;
  endpoint: ConversationResolvedEndpointV1;
  principalId: string;
  target: ConversationBindingTargetMutationV1;
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

function sameMaterialization(
  left: PluginMachineMaterializationRefV1,
  right: PluginMachineMaterializationRefV1,
): boolean {
  return left.machineId === right.machineId
    && left.materializationId === right.materializationId
    && left.pluginId === right.pluginId;
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
  const expiredChallengeIds = new Set<string>();
  const consumedChallengeIds = new Set<string>();
  const expiredProposalIds = new Set<string>();
  const consumedTokens = new Map<string, number>();
  const proposals = new Map<string, Proposal>();
  const failedAttemptsByRequester = new Map<string, number>();
  const proposalByFinalizeKey = new Map<string, string>();
  const proposalByCensusId = new Map<string, string>();
  const listeners = new Set<() => void>();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function addBoundedTombstone(target: Set<string>, id: string): void {
    target.add(id);
    if (target.size <= MAX_CONVERSATION_PAIRING_TOMBSTONES) return;
    const oldest = target.values().next().value;
    if (oldest !== undefined) target.delete(oldest);
  }

  function expireChallenge(challenge: Challenge): void {
    challengesById.delete(challenge.challengeId);
    challengeIdsByToken.delete(challenge.token);
    if (challengeIdByConnection.get(challenge.connectionId) === challenge.challengeId) {
      challengeIdByConnection.delete(challenge.connectionId);
    }
    addBoundedTombstone(expiredChallengeIds, challenge.challengeId);
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
    if (challengesById.size === 0) failedAttemptsByRequester.clear();
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
    createChallenge(input: Readonly<{
      connectionId: string;
      expectedConnectionRevision: number;
      materialization: PluginMachineMaterializationRefV1;
      destinationLabel: string;
      pairingDeepLinkTemplate?: string;
      target: ConversationBindingTargetMutationV1;
    }>) {
      if (!Number.isSafeInteger(input.expectedConnectionRevision) || input.expectedConnectionRevision < 1) {
        throw new Error('Pairing challenge must freeze a valid connection revision.');
      }
      const now = dependencies.now();
      pruneExpiredAndPublish(now);
      const previousChallengeId = challengeIdByConnection.get(input.connectionId);
      if (previousChallengeId !== undefined) {
        const previousChallenge = challengesById.get(previousChallengeId);
        if (previousChallenge !== undefined) {
          expireChallenge(previousChallenge);
          expiredChallengeIds.delete(previousChallenge.challengeId);
          addBoundedTombstone(consumedChallengeIds, previousChallenge.challengeId);
          consumedTokens.set(previousChallenge.token, previousChallenge.expiresAt);
        }
      }
      if (challengesById.size >= MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT) {
        throw new Error('The active pairing challenge limit has been reached.');
      }
      const token = createUniqueToken();
      const challengeId = dependencies.createId('challenge');
      if (challengesById.has(challengeId)) throw new Error('Pairing challenge IDs must be unique.');
      const challenge: Challenge = {
        challengeId,
        token,
        connectionId: input.connectionId,
        expectedConnectionRevision: input.expectedConnectionRevision,
        materialization: input.materialization,
        destinationLabel: input.destinationLabel,
        expiresAt: now + CONVERSATION_PAIRING_EXPIRY_MS,
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
      return expiredChallengeIds.has(input.challengeId)
        ? { kind: 'expired' } as const
        : consumedChallengeIds.has(input.challengeId)
          ? { kind: 'consumed' } as const
          : { kind: 'unavailable' } as const;
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

      const requesterKey = JSON.stringify([input.connectionId, input.actor.principalId]);
      const requesterAttempts = failedAttemptsByRequester.get(requesterKey) ?? 0;
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
        || !sameMaterialization(challenge.materialization, input.materialization)) {
        if (requesterAttempts === 0
          && failedAttemptsByRequester.size >= MAX_CONVERSATION_PAIRING_TRACKED_REQUESTERS) {
          return {
            kind: 'silent',
            ownerReason: 'attemptCapacityReached',
            attemptsRemaining: 0,
          } as const;
        }
        const attempts = requesterAttempts + 1;
        failedAttemptsByRequester.set(requesterKey, attempts);
        return {
          kind: 'silent',
          ownerReason: consumedTokens.has(input.command.token) ? 'challengeConsumed' : 'tokenMismatch',
          attemptsRemaining: MAX_CONVERSATION_PAIRING_FAILED_ATTEMPTS_PER_REQUESTER - attempts,
        } as const;
      }

      if (proposals.size >= MAX_CONVERSATION_BINDINGS_PER_ACCOUNT) {
        return { kind: 'silent', ownerReason: 'proposalCapacityReached' } as const;
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
        || !sameMaterialization(challenge.materialization, reservation.materialization)
      ) {
        return { kind: 'silent', ownerReason: 'reservationUnavailable' } as const;
      }
      if (proposals.size >= MAX_CONVERSATION_BINDINGS_PER_ACCOUNT) {
        return { kind: 'silent', ownerReason: 'proposalCapacityReached' } as const;
      }

      challengesById.delete(challenge.challengeId);
      challengeIdsByToken.delete(challenge.token);
      if (challengeIdByConnection.get(challenge.connectionId) === challenge.challengeId) {
        challengeIdByConnection.delete(challenge.connectionId);
      }
      addBoundedTombstone(consumedChallengeIds, challenge.challengeId);
      consumedTokens.set(challenge.token, challenge.expiresAt);
      const proposalId = dependencies.createId('proposal');
      const proposal: Proposal = {
        censusId: reservation.censusId,
        challengeId: challenge.challengeId,
        proposalId,
        bindingId: dependencies.createId('binding'),
        connectionId: challenge.connectionId,
        materialization: challenge.materialization,
        endpoint: reservation.endpoint,
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

    cancelChallenge(input: Readonly<{ generationId: string; challengeId: string }>): ConversationPairingCancelResult {
      if (input.generationId !== dependencies.generationId) return { kind: 'notCancelled', reason: 'restarted' } as const;
      pruneExpiredAndPublish(dependencies.now());
      const challenge = challengesById.get(input.challengeId);
      if (!challenge) return { kind: 'notCancelled', reason: 'unavailable' } as const;
      challengesById.delete(challenge.challengeId);
      challengeIdsByToken.delete(challenge.token);
      if (challengeIdByConnection.get(challenge.connectionId) === challenge.challengeId) {
        challengeIdByConnection.delete(challenge.connectionId);
      }
      consumedTokens.set(challenge.token, challenge.expiresAt);
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
          if (cause instanceof PluginError && (
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
    readManagementProjection(): ConversationPairingResourceV1 {
      const observedAt = dependencies.now();
      pruneExpiredAndPublish(observedAt);
      return {
        generationId: dependencies.generationId,
        observedAt,
        challenges: [...challengesById.values()].map((challenge) => ({
          challengeId: challenge.challengeId,
          connectionId: challenge.connectionId,
          expectedConnectionRevision: challenge.expectedConnectionRevision,
          expiresAt: challenge.expiresAt,
          attemptsRemaining: MAX_CONVERSATION_PAIRING_FAILED_ATTEMPTS_PER_REQUESTER,
          destinationLabel: challenge.destinationLabel,
          manualToken: challenge.token,
          deepLinkUrl: challenge.deepLinkUrl,
        })),
        proposals: [...proposals.values()].map((proposal) => ({
          challengeId: proposal.challengeId,
          proposalId: proposal.proposalId,
          connectionId: proposal.connectionId,
          expectedConnectionRevision: proposal.expectedConnectionRevision,
          expiresAt: proposal.expiresAt,
          endpointLabel: proposal.endpoint.label ?? null,
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
