import { describe, expect, it, vi } from 'vitest';
import type { ConversationBindingTargetMutationV1 } from '@happier-dev/channels-protocol/v1';

import { classifyConversationCommand } from './commands.js';
import {
  createConversationPairingManager,
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
} satisfies ConversationBindingTargetMutationV1;

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
    materialization,
    destinationLabel: 'Telegram bot',
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
      materialization,
      destinationLabel: 'Telegram bot',
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
      materialization,
      destinationLabel: 'Telegram bot',
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
      materialization,
      destinationLabel: 'Telegram bot',
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

  it('charges only syntactically valid misses to the immutable requester and locks the sixth attempt', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      materialization,
      destinationLabel: 'Telegram bot',
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

  it('scopes a requester failure budget to its authenticated connection', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      materialization,
      destinationLabel: 'Telegram bot',
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
      materialization,
      destinationLabel: 'Telegram bot',
      target: sessionTarget,
    });

    for (const rejected of [
      { endpoint: { ...directEndpoint, audience: 'shared' as const }, actor: { principalId: 'person-1', kind: 'human' as const, isIntegrationSelf: false }, contentProvenance: 'original' as const },
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

  it('types expiry and restart for the authenticated owner while external callers stay non-oracular', () => {
    const now = { value: 1_000 };
    const manager = createManager(now);
    const challenge = manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
      materialization,
      destinationLabel: 'Telegram bot',
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
      materialization,
      destinationLabel: 'Telegram bot',
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
      materialization,
      destinationLabel: 'Telegram bot',
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
      materialization,
      destinationLabel: 'Telegram bot',
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
      materialization,
      destinationLabel: 'Telegram bot',
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
        materialization,
        destinationLabel: 'Telegram bot',
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
});
