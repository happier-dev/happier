import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
  MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
  type ConversationBindingTargetV1,
} from '@happier-dev/channels-protocol/v1';

import { classifyConversationCommand } from './commands.js';
import {
  createConversationPairingManager,
  MAX_CONVERSATION_PAIRING_TRACKED_REQUESTERS,
  MAX_CONVERSATION_PAIRING_TOMBSTONES,
  type ConversationPairingBinding,
  type ConversationPairingBindingWriter,
} from './pairing.js';

const materialization = {
  machineId: 'machine-1',
  materializationId: 'materialization-1',
  pluginId: 'channel.telegram',
} as const;

const directEndpoint = {
  kind: 'direct',
  audience: 'direct',
  id: 'chat-1',
  label: 'Alice',
} as const;

const sessionTarget = {
  kind: 'session',
  sessionId: 'session-1',
  policy: {
    deliveryMode: 'repliesOnly',
    permissionCeiling: 'read-only',
    approvals: { kind: 'off' },
    newSession: { kind: 'off' },
  },
} satisfies ConversationBindingTargetV1;

function pairingBinding(id: string): ConversationPairingBinding {
  return {
    v: 1,
    id,
    connectionId: 'connection-1',
    endpoint: directEndpoint,
    target: sessionTarget,
    allowedPrincipalIds: ['person-1'],
    allowBotSenders: false,
    inputMode: 'allAllowedMessages',
    inboundDebounceMs: 750,
    linkPreviewPolicy: 'suppress',
    senderFeedback: 'off',
    authorityEpoch: 1,
    enabled: false,
    deletionState: 'none',
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function sequenceIds(): (kind: 'challenge' | 'proposal' | 'binding') => string {
  const counts = { challenge: 0, proposal: 0, binding: 0 };
  return (kind) => `${kind}-${++counts[kind]}`;
}

function createManager(now: { value: number }, bytes = [0, 0, 0, 0, 1]) {
  return createConversationPairingManager({
    generationId: 'generation-1',
    now: () => now.value,
    randomBytes: (length) => {
      expect(length).toBe(5);
      return Uint8Array.from(bytes);
    },
    createId: sequenceIds(),
  });
}

let nextTestCensusId = 0;

function completePreBindingMessage(
  manager: ReturnType<typeof createConversationPairingManager>,
  input: Omit<Parameters<ReturnType<typeof createConversationPairingManager>['preparePreBindingMessage']>[0], 'censusId'>,
  censusId = `test-census-${++nextTestCensusId}`,
) {
  const prepared = manager.preparePreBindingMessage({ ...input, censusId });
  return prepared.kind === 'reserved'
    ? manager.commitPreBindingMessage(prepared)
    : prepared;
}

function createMatchedProposal(manager: ReturnType<typeof createConversationPairingManager>) {
  const challenge = manager.createChallenge({
    connectionId: 'connection-1',
    expectedConnectionRevision: 1,
    pairingRequestId: 'pairing-request-1',
    materialization,
    destinationLabel: 'Telegram bot',
    endpoint: directEndpoint,
    target: sessionTarget,
  });
  const proposal = completePreBindingMessage(manager, {
    connectionId: 'connection-1',
    materialization,
    endpoint: directEndpoint,
    actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
    contentProvenance: 'original',
    command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
  });
  if (proposal.kind !== 'matched') throw new Error('Expected pairing proposal.');
  return {
    challenge,
    proposal,
    finalizeInput: {
      generationId: challenge.generationId,
      proposalId: proposal.proposalId,
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
    },
  } as const;
}

describe('Channels pre-binding pairing', () => {
  it('keeps a valid pairing challenge intact until its exact census is durable, then rejoins that census', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    const challenge = manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });
    const input = {
      censusId: 'census-1',
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'person-1', kind: 'human' as const, isIntegrationSelf: false },
      contentProvenance: 'original' as const,
      command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
    };

    const prepared = manager.preparePreBindingMessage(input);
    expect(prepared).toMatchObject({ kind: 'reserved', censusId: 'census-1' });
    expect(manager.readChallenge({
      generationId: challenge.generationId,
      challengeId: challenge.challengeId,
    })).toMatchObject({ kind: 'active' });
    expect(manager.readManagementProjection().proposals).toEqual([]);

    if (prepared.kind !== 'reserved') throw new Error('Expected the exact pairing reservation.');
    const committed = manager.commitPreBindingMessage(prepared);
    expect(committed).toEqual({ kind: 'matched', proposalId: 'proposal-1', expiresAt: 601_000 });
    const replayReservation = manager.preparePreBindingMessage(input);
    if (replayReservation.kind !== 'reserved') throw new Error('Expected the census replay reservation.');
    expect(manager.commitPreBindingMessage(replayReservation)).toEqual(committed);
    expect(manager.readManagementProjection().proposals).toHaveLength(1);
  });

  it('publishes the one in-memory challenge or authenticated proposal projection to management readers', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    const invalidate = vi.fn();
    const observation = manager.subscribe(invalidate);

    const challenge = manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      pairingDeepLinkTemplate: 'https://t.me/happier_bot?start={{token}}',
      target: sessionTarget,
    });

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(manager.readManagementProjection()).toEqual({
      generationId: 'generation-1',
      observedAt: 1_000,
      challenges: [{
        challengeId: 'challenge-1',
        connectionId: 'connection-1',
        expectedConnectionRevision: 1,
        pairingRequestId: 'pairing-request-1',
        expiresAt: 601_000,
        attemptsRemaining: 5,
        destinationLabel: 'Telegram bot',
        manualToken: '00000001',
        deepLinkUrl: 'https://t.me/happier_bot?start=00000001',
      }],
      proposals: [],
    });

    const proposal = completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
    });
    if (proposal.kind !== 'matched') throw new Error('Expected pairing proposal.');

    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(manager.readManagementProjection()).toEqual({
      generationId: 'generation-1',
      observedAt: 1_000,
      challenges: [],
      proposals: [{
        challengeId: 'challenge-1',
        proposalId: 'proposal-1',
        connectionId: 'connection-1',
        expectedConnectionRevision: 1,
        expiresAt: 601_000,
        endpointLabel: 'Alice',
        state: 'proposed',
      }],
    });
    observation.dispose();
  });

  it('creates an exact 40-bit challenge and normalizes Crockford aliases before one-time matching', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    const challenge = manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      pairingDeepLinkTemplate: 'https://t.me/happier_bot?start={{token}}',
      target: sessionTarget,
    });

    expect(challenge).toEqual({
      kind: 'created',
      generationId: 'generation-1',
      challengeId: 'challenge-1',
      expiresAt: 601_000,
      attemptsRemaining: 5,
      destinationLabel: 'Telegram bot',
      manualToken: '00000001',
      deepLinkUrl: 'https://t.me/happier_bot?start=00000001',
    });

    expect(completePreBindingMessage(manager, {
      connectionId: 'connection-2',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'person-on-wrong-connection', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand('/pair 00000001'),
    })).toMatchObject({ kind: 'silent', ownerReason: 'tokenMismatch' });

    const matched = completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand('/start OOOOOOOI'),
    });
    expect(matched).toEqual({
      kind: 'matched',
      proposalId: 'proposal-1',
      expiresAt: 601_000,
    });

    expect(completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand('/pair 00000001'),
    })).toMatchObject({ kind: 'silent', ownerReason: 'challengeConsumed' });
    expect(manager.readChallenge({
      generationId: challenge.generationId,
      challengeId: challenge.challengeId,
    })).toEqual({ kind: 'consumed' });
  });

  it('evicts the oldest consumed pairing token once the single tombstone budget is exceeded', () => {
    const now = { value: 1_000 };
    // Distinct randomness per challenge: supersession retires the previous
    // token and a repeated one would exhaust the unique-token allocator.
    let nextTokenSeed = 0;
    // Supersession requires a different request key per create below.
    let terminalChallengeReasonProbe = 0;
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => now.value,
      randomBytes: () => {
        nextTokenSeed += 1;
        return Uint8Array.from([
          (nextTokenSeed >>> 32) & 0xff,
          (nextTokenSeed >>> 24) & 0xff,
          (nextTokenSeed >>> 16) & 0xff,
          (nextTokenSeed >>> 8) & 0xff,
          nextTokenSeed & 0xff,
        ]);
      },
      createId: sequenceIds(),
    });
    const supersede = () => manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: `pairing-request-${terminalChallengeReasonProbe += 1}`,
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });

    const evicted = supersede();
    const retained = supersede();
    // One more supersession than the declared budget, all inside the single
    // ten-minute window, so nothing can be reclaimed by lazy expiry.
    for (let index = 0; index < MAX_CONVERSATION_PAIRING_TOMBSTONES; index += 1) supersede();

    const probe = (token: string, principalId: string) => completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId, kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${token}`),
    });

    expect(probe(evicted.manualToken, 'person-1')).toMatchObject({
      kind: 'silent',
      ownerReason: 'tokenMismatch',
    });
    // The budget evicts in arrival order only: the next-oldest consumed token
    // is still a tombstone, so this is an eviction bound and not a wipe.
    expect(probe(retained.manualToken, 'person-2')).toMatchObject({
      kind: 'silent',
      ownerReason: 'challengeConsumed',
    });
  });

  it('charges only syntactically valid misses to the immutable requester and locks the sixth attempt', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });

    const attempt = (principalId: string, text: string) => completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId, kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(text),
    });

    expect(attempt('stranger-1', '/pair invalid')).toEqual({
      kind: 'silent',
      ownerReason: 'notPairingCommand',
    });
    for (let index = 0; index < 5; index += 1) {
      expect(attempt('stranger-1', `/pair 0000000${index + 2}`)).toEqual({
        kind: 'silent',
        ownerReason: 'tokenMismatch',
        attemptsRemaining: 4 - index,
      });
    }
    expect(attempt('stranger-1', '/pair 00000001')).toEqual({
      kind: 'silent',
      ownerReason: 'attemptLimitReached',
      attemptsRemaining: 0,
    });
    expect(attempt('person-2', '/pair 00000001')).toMatchObject({ kind: 'matched' });
  });

  it('charges one redelivered occurrence to the requester budget exactly once', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });
    const typo = {
      censusId: 'census-redelivered-1',
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'person-1', kind: 'human' as const, isIntegrationSelf: false },
      contentProvenance: 'original' as const,
      command: classifyConversationCommand('/pair 00000002'),
    };

    const first = manager.preparePreBindingMessage(typo);
    expect(first).toEqual({ kind: 'silent', ownerReason: 'tokenMismatch', attemptsRemaining: 4 });
    for (let redelivery = 0; redelivery < 8; redelivery += 1) {
      expect(manager.preparePreBindingMessage(typo)).toEqual(first);
    }

    expect(manager.preparePreBindingMessage({ ...typo, censusId: 'census-redelivered-2' })).toEqual({
      kind: 'silent',
      ownerReason: 'tokenMismatch',
      attemptsRemaining: 3,
    });
  });

  it('scopes a requester failure budget to its authenticated connection', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });

    for (let index = 0; index < 5; index += 1) {
      expect(completePreBindingMessage(manager, {
        connectionId: 'connection-2',
        materialization,
        endpoint: directEndpoint,
        actor: { principalId: 'provider-local-person-1', kind: 'human', isIntegrationSelf: false },
        contentProvenance: 'original',
        command: classifyConversationCommand(`/pair 0000000${index + 2}`),
      })).toMatchObject({ kind: 'silent', ownerReason: 'tokenMismatch' });
    }

    expect(completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'provider-local-person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand('/pair 00000001'),
    })).toMatchObject({ kind: 'matched' });
  });

  it('rejects wrong pre-binding provenance without looking up or charging the token', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });

    for (const rejected of [
      { endpoint: { ...directEndpoint, kind: 'shared' as const, audience: 'shared' as const }, actor: { principalId: 'person-1', kind: 'human' as const, isIntegrationSelf: false }, contentProvenance: 'original' as const },
      { endpoint: directEndpoint, actor: { principalId: 'bot-1', kind: 'bot' as const, isIntegrationSelf: false }, contentProvenance: 'original' as const },
      { endpoint: directEndpoint, actor: { principalId: 'person-1', kind: 'human' as const, isIntegrationSelf: false }, contentProvenance: 'forwarded' as const },
      { endpoint: directEndpoint, actor: { principalId: 'self', kind: 'integration' as const, isIntegrationSelf: true }, contentProvenance: 'original' as const },
    ]) {
      expect(completePreBindingMessage(manager, {
        connectionId: 'connection-1',
        materialization,
        command: classifyConversationCommand('/pair 00000001'),
        ...rejected,
      })).toEqual({ kind: 'silent', ownerReason: 'ineligibleCaller' });
    }

    expect(completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand('/pair 00000001'),
    })).toMatchObject({ kind: 'matched' });
  });

  it('refuses a valid token redeemed from any materialization the challenge did not name', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    const challenge = manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });
    // Each field is varied independently below, so the parameter is the
    // structural ref rather than the exact literal fixture.
    const redeem = (
      from: Readonly<{ machineId: string; materializationId: string; pluginId: string }>,
    ) => completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization: from,
      endpoint: directEndpoint,
      actor: { principalId: 'person-1', kind: 'human' as const, isIntegrationSelf: false },
      contentProvenance: 'original' as const,
      command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
    });

    // Each field of the ref is load-bearing on its own.
    for (const wrong of [
      { ...materialization, materializationId: 'materialization-2' },
      { ...materialization, machineId: 'machine-2' },
      { ...materialization, pluginId: 'channel.discord' },
    ]) {
      expect(redeem(wrong)).toMatchObject({ kind: 'silent', ownerReason: 'tokenMismatch' });
    }
    expect(manager.readChallenge({
      generationId: challenge.generationId,
      challengeId: challenge.challengeId,
    })).toMatchObject({ kind: 'active' });

    expect(redeem(materialization)).toMatchObject({ kind: 'matched' });
  });

  it('types expiry and restart for the authenticated owner while external callers stay non-oracular', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    const challenge = manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });
    now.value = challenge.expiresAt;

    expect(manager.readChallenge({
      generationId: challenge.generationId,
      challengeId: challenge.challengeId,
    })).toEqual({ kind: 'expired' });
    expect(manager.readChallenge({
      generationId: 'retired-generation',
      challengeId: challenge.challengeId,
    })).toEqual({ kind: 'restarted' });
    expect(completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand('/pair 00000001'),
    })).toMatchObject({ kind: 'silent' });
  });

  it('passes the frozen target mutation to its binding writer instead of an opaque completion bag', async () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    const target = sessionTarget;
    const challenge = manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target,
    });
    const match = completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
    });
    if (match.kind !== 'matched') throw new Error('Expected pairing proposal.');

    let written: Parameters<ConversationPairingBindingWriter>[0] | undefined;
    const writer: ConversationPairingBindingWriter = async (input) => {
      written = input;
      return { kind: 'created', binding: pairingBinding(input.bindingId) };
    };
    await expect(manager.finalize({
      generationId: challenge.generationId,
      proposalId: match.proposalId,
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      finalizeIdempotencyKey: 'finalize-1',
    }, writer)).resolves.toMatchObject({ kind: 'created' });
    expect(written).toHaveProperty('target', target);
    expect(written).not.toHaveProperty('completion');
  });

  it('creates or rejoins one paused binding with a stable finalize key after response loss', async () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    const challenge = manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });
    const match = completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
    });
    if (match.kind !== 'matched') throw new Error('Expected pairing proposal.');

    const persisted = new Map<string, ConversationPairingBinding>();
    let calls = 0;
    const writer: ConversationPairingBindingWriter = async (input) => {
      calls += 1;
      const existing = persisted.get(input.finalizeIdempotencyKey);
      if (existing) return { kind: 'rejoined', binding: existing };
      const binding = pairingBinding(input.bindingId);
      persisted.set(input.finalizeIdempotencyKey, binding);
      if (calls === 1) throw new Error('response lost after commit');
      return { kind: 'created', binding };
    };

    const finalizeInput = {
      generationId: challenge.generationId,
      proposalId: match.proposalId,
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      finalizeIdempotencyKey: 'finalize-1',
    } as const;
    await expect(manager.finalize(finalizeInput, writer)).resolves.toEqual({ kind: 'retryableFailure' });
    await expect(manager.finalize(finalizeInput, writer)).resolves.toEqual({
      kind: 'rejoined',
      binding: pairingBinding('binding-1'),
    });
    expect(calls).toBe(2);
    expect(persisted.size).toBe(1);
  });

  it('restores a response-loss proposal so the owner can cancel it after the write settles', async () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    const { challenge, proposal, finalizeInput } = createMatchedProposal(manager);
    const writeBinding: ConversationPairingBindingWriter = async () => {
      throw new Error('response lost after an unknown write outcome');
    };

    await expect(manager.finalize({
      ...finalizeInput,
      finalizeIdempotencyKey: 'finalize-1',
    }, writeBinding)).resolves.toEqual({ kind: 'retryableFailure' });

    expect(manager.cancelProposal({
      generationId: challenge.generationId,
      proposalId: proposal.proposalId,
    })).toEqual({ kind: 'cancelled' });
  });

  it('expires a response-loss proposal once its frozen lifetime ends', async () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    const { challenge, finalizeInput } = createMatchedProposal(manager);
    const writeBinding: ConversationPairingBindingWriter = async () => {
      throw new Error('response lost after an unknown write outcome');
    };

    const input = { ...finalizeInput, finalizeIdempotencyKey: 'finalize-1' } as const;
    await expect(manager.finalize(input, writeBinding)).resolves.toEqual({ kind: 'retryableFailure' });
    now.value = challenge.expiresAt;

    await expect(manager.finalize(input, writeBinding)).resolves.toEqual({ kind: 'expired' });
  });

  it('does not cancel a challenge after its expiry has become current', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    const challenge = manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });
    now.value = challenge.expiresAt;

    expect(manager.cancelChallenge({
      generationId: challenge.generationId,
      challengeId: challenge.challengeId,
    })).toEqual({ kind: 'notCancelled', reason: 'unavailable' });
    expect(manager.readChallenge({
      generationId: challenge.generationId,
      challengeId: challenge.challengeId,
    })).toEqual({ kind: 'expired' });
  });

  it('does not cancel a proposal after its expiry has become current', async () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    const { challenge, proposal, finalizeInput } = createMatchedProposal(manager);
    now.value = challenge.expiresAt;

    expect(manager.cancelProposal({
      generationId: challenge.generationId,
      proposalId: proposal.proposalId,
    })).toEqual({ kind: 'notCancelled', reason: 'unavailable' });
    await expect(manager.finalize({
      ...finalizeInput,
      finalizeIdempotencyKey: 'finalize-1',
    }, async () => ({ kind: 'conflict' }))).resolves.toEqual({ kind: 'expired' });
  });

  it('serializes finalize/cancel so cancellation cannot remove a binding in flight', async () => {
    const now = { value: 1_000 };
    const manager = createManager(now, [0, 0, 0, 0, 2]);
    const challenge = manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });
    const match = completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
    });
    if (match.kind !== 'matched') throw new Error('Expected pairing proposal.');

    let release: (() => void) | undefined;
    const writeBinding: ConversationPairingBindingWriter = async ({ bindingId }) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { kind: 'created', binding: pairingBinding(bindingId) };
    };
    const pending = manager.finalize({
      generationId: challenge.generationId,
      proposalId: match.proposalId,
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      finalizeIdempotencyKey: 'finalize-1',
    }, writeBinding);
    expect(manager.cancelProposal({
      generationId: challenge.generationId,
      proposalId: match.proposalId,
    })).toEqual({ kind: 'notCancelled', reason: 'finalizeInProgress' });
    release?.();
    await expect(pending).resolves.toMatchObject({ kind: 'created' });
    expect(manager.cancelProposal({
      generationId: challenge.generationId,
      proposalId: match.proposalId,
    })).toEqual({ kind: 'notCancelled', reason: 'bindingCreated' });
  });

  it('freezes the connection revision and retains finalize-key ownership across a stale retry', async () => {
    const now = { value: 1_000 };
    let token = 3;
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => now.value,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, token++]),
      createId: sequenceIds(),
    });
    const createProposal = (expectedConnectionRevision: number) => {
      const challenge = manager.createChallenge({
        connectionId: 'connection-1',
        expectedConnectionRevision,
        pairingRequestId: `pairing-request-r${expectedConnectionRevision}`,
        materialization,
        destinationLabel: 'Telegram bot',
        endpoint: directEndpoint,
        target: sessionTarget,
      });
      const match = completePreBindingMessage(manager, {
        connectionId: 'connection-1',
        materialization,
        endpoint: directEndpoint,
        actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
        contentProvenance: 'original',
        command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
      });
      if (match.kind !== 'matched') throw new Error('Expected pairing proposal.');
      return { challenge, match };
    };

    const first = createProposal(1);
    let writes = 0;
    const writeBinding: ConversationPairingBindingWriter = async (input) => {
      writes += 1;
      return input.expectedConnectionRevision === 1
        ? { kind: 'staleConnectionRevision' }
        : { kind: 'created', binding: pairingBinding(input.bindingId) };
    };
    const base = {
      generationId: first.challenge.generationId,
      proposalId: first.match.proposalId,
      connectionId: 'connection-1',
      finalizeIdempotencyKey: 'finalize-1',
    } as const;
    await expect(manager.finalize({ ...base, expectedConnectionRevision: 1 }, writeBinding)).resolves.toEqual({
      kind: 'staleConnectionRevision',
    });
    await expect(manager.finalize({
      ...base,
      expectedConnectionRevision: 2,
      finalizeIdempotencyKey: 'different-finalize-key',
    }, writeBinding)).resolves.toEqual({ kind: 'staleConnectionRevision' });
    expect(writes).toBe(1);

    const second = createProposal(2);
    await expect(manager.finalize({
      generationId: second.challenge.generationId,
      proposalId: second.match.proposalId,
      connectionId: 'connection-1',
      expectedConnectionRevision: 2,
      finalizeIdempotencyKey: 'finalize-1',
    }, writeBinding)).resolves.toEqual({ kind: 'alreadyConsumed' });
    await expect(manager.finalize({
      generationId: second.challenge.generationId,
      proposalId: second.match.proposalId,
      connectionId: 'connection-1',
      expectedConnectionRevision: 2,
      finalizeIdempotencyKey: 'finalize-2',
    }, writeBinding)).resolves.toMatchObject({ kind: 'created', binding: { enabled: false } });
  });

  it('rejoins the exact same pairingRequestId create after a lost response', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    const create = () => manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });
    const first = create();
    const retry = create();

    // The retry rejoins the identical challenge: same id, token, and expiry,
    // no supersession, no second live challenge.
    expect(retry).toEqual(first);
    expect(manager.readChallenge({
      generationId: first.generationId,
      challengeId: first.challengeId,
    })).toMatchObject({ kind: 'active', manualToken: first.manualToken });
    expect(manager.readManagementProjection().challenges).toHaveLength(1);
  });

  it('never lets a lost-response retry adopt another device’s superseding challenge', () => {
    const now = { value: 1_000 };
    let tokenSeed = 1;
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => now.value,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, tokenSeed++ & 0xff]),
      createId: sequenceIds(),
    });
    const deviceRequest = (pairingRequestId: string) => manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId,
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });

    // Device A's create response is lost; device B intentionally supersedes
    // with its own request on the same connection.
    const deviceAFirst = deviceRequest('device-a-request');
    const deviceB = deviceRequest('device-b-request');
    expect(deviceB.challengeId).not.toBe(deviceAFirst.challengeId);
    expect(manager.readChallenge({
      generationId: deviceAFirst.generationId,
      challengeId: deviceAFirst.challengeId,
    })).toEqual({ kind: 'consumed' });

    // Device A retries its own exact request: it must never receive device
    // B's challenge — a fresh superseding challenge answers it instead.
    const deviceARetry = deviceRequest('device-a-request');
    expect(deviceARetry.challengeId).not.toBe(deviceB.challengeId);
    expect(deviceARetry.manualToken).not.toBe(deviceB.manualToken);
    expect(manager.readChallenge({
      generationId: deviceB.generationId,
      challengeId: deviceB.challengeId,
    })).toEqual({ kind: 'consumed' });
    expect(manager.readChallenge({
      generationId: deviceARetry.generationId,
      challengeId: deviceARetry.challengeId,
    })).toMatchObject({ kind: 'active', manualToken: deviceARetry.manualToken });
  });

  it('supersedes on a different request and refuses changed content under the same key', () => {
    const now = { value: 1_000 };
    let tokenSeed = 1;
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => now.value,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, tokenSeed++ & 0xff]),
      createId: sequenceIds(),
    });
    const automationTarget = {
      kind: 'automation',
      automationId: 'automation-1',
      policy: { resultDelivery: 'none' },
    } satisfies ConversationBindingTargetV1;
    const create = (pairingRequestId: string, target: ConversationBindingTargetV1 = sessionTarget) =>
      manager.createChallenge({
        connectionId: 'connection-1',
        expectedConnectionRevision: 1,
        pairingRequestId,
        materialization,
        destinationLabel: 'Telegram bot',
        endpoint: directEndpoint,
        target,
      });

    const first = create('request-1');
    const superseding = create('request-2');
    expect(superseding.challengeId).not.toBe(first.challengeId);
    expect(superseding.manualToken).not.toBe(first.manualToken);
    expect(manager.readChallenge({
      generationId: first.generationId,
      challengeId: first.challengeId,
    })).toEqual({ kind: 'consumed' });

    // The same key with changed content never comes to represent a second
    // request: the create is refused without rejoining or superseding, and
    // the live challenge the key created stays intact.
    expect(() => create('request-2', automationTarget)).toThrow(
      'A pairing request id must not be reused for a different pairing request.',
    );
    expect(manager.readChallenge({
      generationId: superseding.generationId,
      challengeId: superseding.challengeId,
    })).toMatchObject({ kind: 'active', manualToken: superseding.manualToken });
    expect(manager.readManagementProjection().challenges).toHaveLength(1);
  });

  it('never lets one Account’s pairing activity exhaust or block another Account’s pairing', () => {
    const now = { value: 1_000 };
    let nextTokenSeed = 0;
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => now.value,
      randomBytes: () => {
        nextTokenSeed += 1;
        return Uint8Array.from([
          (nextTokenSeed >>> 32) & 0xff,
          (nextTokenSeed >>> 24) & 0xff,
          (nextTokenSeed >>> 16) & 0xff,
          (nextTokenSeed >>> 8) & 0xff,
          nextTokenSeed & 0xff,
        ]);
      },
      createId: sequenceIds(),
    });
    const accountAConnection = (index: number) => `account-a-connection-${index}`;
    const createAccountAChallenge = (index: number) => manager.createChallenge({
      connectionId: accountAConnection(index),
      expectedConnectionRevision: 1,
      pairingRequestId: `pairing-request-a-${index}`,
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });

    // Account A reaches its real durable connection ceiling without blocking
    // a separately scoped Account B challenge in the same daemon process.
    for (let index = 0; index < MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT; index += 1) {
      createAccountAChallenge(index);
    }
    const accountBChallenge = manager.createChallenge({
      connectionId: 'account-b-connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'pairing-request-b-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });

    // Account A reaches its real durable binding ceiling, cycling across its
    // valid connection set, without process-global proposal state blocking B.
    for (let index = 0; index < MAX_CONVERSATION_BINDINGS_PER_ACCOUNT; index += 1) {
      const connectionIndex = index % MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT;
      const challenge = manager.createChallenge({
        connectionId: accountAConnection(connectionIndex),
        expectedConnectionRevision: 1,
        pairingRequestId: `pairing-request-a-proposal-${index}`,
        materialization,
        destinationLabel: 'Telegram bot',
        endpoint: directEndpoint,
        target: sessionTarget,
      });
      expect(completePreBindingMessage(manager, {
        connectionId: accountAConnection(connectionIndex),
        materialization,
        endpoint: directEndpoint,
        actor: { principalId: 'person-a', kind: 'human', isIntegrationSelf: false },
        contentProvenance: 'original',
        command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
      })).toMatchObject({ kind: 'matched' });
    }

    // Account B's valid proof still commits: proposals are bounded by expiry
    // and the durable binding quota at finalize, never by another Account's
    // in-memory challenge or proposal count.
    expect(completePreBindingMessage(manager, {
      connectionId: 'account-b-connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'person-b', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${accountBChallenge.manualToken}`),
    })).toMatchObject({ kind: 'matched' });
  });

  it('starts a fresh challenge-scoped requester budget when a challenge is superseded or expires', () => {
    const now = { value: 1_000 };
    let tokenSeed = 2;
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => now.value,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, tokenSeed++ & 0xff]),
      createId: sequenceIds(),
    });
    let nextGuessCensus = 0;
    const wrongGuess = (principalId: string, censusId = `guess-census-${++nextGuessCensus}`) =>
      manager.preparePreBindingMessage({
        censusId,
        connectionId: 'connection-1',
        materialization,
        endpoint: directEndpoint,
        actor: { principalId, kind: 'human', isIntegrationSelf: false },
        contentProvenance: 'original',
        command: classifyConversationCommand('/pair ZZZZZZZ9'),
      });
    const createConnectionChallenge = (pairingRequestId: string) => manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId,
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });

    createConnectionChallenge('request-1');
    for (let attemptsRemaining = 4; attemptsRemaining >= 0; attemptsRemaining -= 1) {
      expect(wrongGuess('stranger-1')).toEqual({
        kind: 'silent',
        ownerReason: 'tokenMismatch',
        attemptsRemaining,
      });
    }
    expect(wrongGuess('stranger-1')).toEqual({
      kind: 'silent',
      ownerReason: 'attemptLimitReached',
      attemptsRemaining: 0,
    });

    // The charged-census replay key is challenge-scoped too: one redelivered
    // occurrence charges its requester's remaining budget exactly once.
    expect(wrongGuess('stranger-2', 'census-redelivery')).toEqual({
      kind: 'silent',
      ownerReason: 'tokenMismatch',
      attemptsRemaining: 4,
    });
    expect(wrongGuess('stranger-2')).toEqual({
      kind: 'silent',
      ownerReason: 'tokenMismatch',
      attemptsRemaining: 3,
    });
    expect(wrongGuess('stranger-2', 'census-redelivery')).toEqual({
      kind: 'silent',
      ownerReason: 'tokenMismatch',
      attemptsRemaining: 3,
    });

    // A different request intentionally supersedes the challenge, and its
    // challenge-scoped requester and charged-census state go with it.
    const second = createConnectionChallenge('request-2');
    expect(wrongGuess('stranger-1')).toEqual({
      kind: 'silent',
      ownerReason: 'tokenMismatch',
      attemptsRemaining: 4,
    });
    expect(wrongGuess('stranger-2', 'census-redelivery')).toEqual({
      kind: 'silent',
      ownerReason: 'tokenMismatch',
      attemptsRemaining: 4,
    });

    // Expiry clears the scoped state exactly like supersession.
    now.value = second.expiresAt;
    const third = createConnectionChallenge('request-3');
    expect(wrongGuess('stranger-1')).toEqual({
      kind: 'silent',
      ownerReason: 'tokenMismatch',
      attemptsRemaining: 4,
    });

    // Budget bookkeeping never touches matching.
    expect(completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${third.manualToken}`),
    })).toMatchObject({ kind: 'matched' });
  });

  it('bounds failed-requester replay accounting inside each live challenge', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      pairingRequestId: 'request-1',
      materialization,
      destinationLabel: 'Telegram bot',
      endpoint: directEndpoint,
      target: sessionTarget,
    });

    for (let index = 0; index < MAX_CONVERSATION_PAIRING_TRACKED_REQUESTERS; index += 1) {
      expect(manager.preparePreBindingMessage({
        censusId: `census-${index}`,
        connectionId: 'connection-1',
        materialization,
        endpoint: directEndpoint,
        actor: { principalId: `stranger-${index}`, kind: 'human', isIntegrationSelf: false },
        contentProvenance: 'original',
        command: classifyConversationCommand('/pair ZZZZZZZ9'),
      })).toMatchObject({ kind: 'silent', ownerReason: 'tokenMismatch' });
    }

    expect(manager.preparePreBindingMessage({
      censusId: 'census-over-capacity',
      connectionId: 'connection-1',
      materialization,
      endpoint: directEndpoint,
      actor: { principalId: 'stranger-over-capacity', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand('/pair ZZZZZZZ9'),
    })).toEqual({
      kind: 'silent',
      ownerReason: 'attemptCapacityReached',
      attemptsRemaining: 0,
    });
  });
});
