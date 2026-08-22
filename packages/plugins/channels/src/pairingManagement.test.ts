import type {
  JsonValue,
  PluginInvocationContext,
  PluginServices,
  TargetedContributionPointRef,
  TargetedContributionSnapshot,
  TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import { ConversationPairingCreateResultV1Schema } from '@happier-dev/channels-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { classifyConversationCommand } from './commands.js';
import {
  deriveConversationCheckpointRowId,
  runConversationCheckpointedPollForInvocation,
} from './ingress.js';
import * as management from './management.js';
import { createConversationPairingManager } from './pairing.js';
import {
  createCurrentConversationConnectionFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';

type StateValue = Readonly<Record<string, unknown>>
  & Readonly<{ id: string; payload: Readonly<Record<string, unknown>> }>;
type StateRow = Readonly<{ rowId: string; revision: number; value: StateValue }>;
type StateMutation =
  | Readonly<{ kind: 'assert'; rowId: string; expectedRevision: number }>
  | Readonly<{ kind: 'put'; value: StateValue; expectedRevision: number | 'absent' }>;

const materialization = {
  machineId: 'machine-1',
  materializationId: 'materialization-1',
  pluginId: 'happier.channel.test',
} as const;

const checkpointedPollAction = Object.freeze({
  identity: Object.freeze({
    target: Object.freeze({ pluginId: 'happier.channels' }),
    point: Object.freeze({
      pointId: 'providers',
      protocol: Object.freeze({ id: 'happier.channels/providers', version: 1 }),
    }),
    contributor: Object.freeze({
      pluginId: materialization.pluginId,
      contributionId: 'checkpointed-poll-test-provider',
      immutableGenerationId: 'checkpointed-poll-test-generation',
    }),
    role: 'observationsPoll',
  }),
});

const pairingConnectionAuthority = {
  providerPluginId: materialization.pluginId,
  providerContributionSelection: {
    contributionId: 'pairing-test-provider',
    immutableGenerationId: 'pairing-test-generation',
  },
  providerSetupInput: { source: 'pairing-test' },
  credentialRef: null,
  transportOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
  providerConnectionKey: 'connection-key-1',
  providerConfig: {},
  routingIdentityKey: 'r'.repeat(43),
  integrationPrincipal: { id: 'bot-1', label: 'Test bot' },
  authorityEpoch: 1,
} as const satisfies ConversationConnectionFixtureAuthority;

const checkpointedPollConnectionAuthority = {
  ...pairingConnectionAuthority,
  providerContributionSelection: {
    contributionId: 'checkpointed-poll-test-provider',
    immutableGenerationId: 'checkpointed-poll-test-generation',
  },
} as const satisfies ConversationConnectionFixtureAuthority;

/** The generic host has already admitted this provider contribution. */
function targetedCheckpointedPollContribution(): TargetedContributionsService {
  return Object.freeze({
    observeForSelf<TContribution>(
      _point: TargetedContributionPointRef<TContribution>,
      _options: Readonly<{ onInvalidated: () => void }>,
    ) {
      return Object.freeze({
        dispose() {},
        async readCurrent(): Promise<TargetedContributionSnapshot<TContribution>> {
          return {
            generation: 'channels-test-generation',
            contributions: [{
              contributor: {
                pluginId: materialization.pluginId,
                contributionId: 'checkpointed-poll-test-provider',
                immutableGenerationId: 'checkpointed-poll-test-generation',
              },
              protocol: { id: 'happier.channels/providers', version: 1 },
              operations: { observationsPoll: checkpointedPollAction },
            }] as unknown as readonly TContribution[],
          };
        },
      });
    },
  });
}

const target = {
  kind: 'session',
  sessionId: 'session-1',
  policy: {
    deliveryMode: 'repliesOnly',
    permissionCeiling: 'read-only',
    approvals: { kind: 'off' },
    newSession: { kind: 'off' },
  },
} as const;

const approvalEnabledTarget = {
  ...target,
  policy: {
    ...target.policy,
    approvals: { kind: 'enabled', maximumScope: 'request' },
  },
} as const;

const newSessionPrincipalOutsidePairingAllowlistTarget = {
  ...target,
  policy: {
    ...target.policy,
    newSession: {
      kind: 'enabled',
      principalIds: ['person-2'],
      recipe: { agentId: 'agent-1' },
    },
  },
} as const;

const automationTarget = {
  kind: 'automation',
  automationId: 'automation-1',
  expectedTemplateVersion: 3,
  policy: { resultDelivery: 'none' },
} as const;

const finalResultAutomationTarget = {
  ...automationTarget,
  policy: { resultDelivery: 'finalResult' },
} as const;

let nextTestCensusId = 0;

function completePreBindingMessage(
  manager: ReturnType<typeof createConversationPairingManager>,
  input: Omit<Parameters<ReturnType<typeof createConversationPairingManager>['preparePreBindingMessage']>[0], 'censusId'>,
) {
  const prepared = manager.preparePreBindingMessage({
    ...input,
    censusId: `pairing-management-census-${++nextTestCensusId}`,
  });
  return prepared.kind === 'reserved'
    ? manager.commitPreBindingMessage(prepared)
    : prepared;
}

/**
 * The one mounted invocation context these pairing-management cases execute
 * against. Building it here keeps every case on the complete
 * `PluginInvocationContext` the host actually supplies, rather than a
 * per-case partial literal no compiler ever checked.
 */
function pairingManagementContext(input: Readonly<{
  collection: ReturnType<typeof createCollection>;
  actions?: Readonly<Record<string, unknown>>;
  targetedContributions?: TargetedContributionsService;
}>): PluginInvocationContext {
  return {
    plugin: { id: 'happier.channels', version: '0.0.0' },
    contribution: {
      id: 'pairing-management',
      qualifiedId: 'happier.channels/actions/pairing-management',
    },
    surface: 'plugin',
    signal: new AbortController().signal,
    // This fixture crosses only the Account-storage, Action-execution, and
    // targeted-contribution host boundaries.
    services: {
      actions: input.actions ?? {},
      storage: { account: { collection: () => input.collection } },
      ...(input.targetedContributions === undefined
        ? {}
        : { targetedContributions: input.targetedContributions }),
    } as unknown as PluginServices,
  };
}

function createCollection(initial: readonly StateRow[]) {
  const rows = new Map(initial.map((row) => [row.rowId, row]));
  const batches: StateMutation[][] = [];
  let loseNextUpdatedBatchResponse = false;
  return {
    rows,
    batches,
    loseNextUpdatedBatchResponse() {
      loseNextUpdatedBatchResponse = true;
    },
    async get(rowId: string) {
      return rows.get(rowId) ?? null;
    },
    async query(request: Readonly<{
      index: string;
      prefix?: readonly unknown[];
      limit?: number;
    }>) {
      if (request.index !== 'by-connection-binding-v2') {
        throw new Error(`Unexpected Collection query index '${request.index}'.`);
      }
      const [connectionId, bindingId, recordKind, attention] = request.prefix ?? [];
      return {
        rows: [...rows.values()].filter((row) => (
          row.value['connection-id'] === connectionId
            && (row.value['binding-id'] ?? null) === bindingId
            && row.value['record-kind'] === recordKind
            && row.value.attention === attention
        )).slice(0, request.limit ?? 50),
        changeCursor: 1,
      };
    },
    async batch(operations: readonly StateMutation[]) {
      batches.push([...operations]);
      for (const operation of operations) {
        const rowId = operation.kind === 'put' ? operation.value.id : operation.rowId;
        const current = rows.get(rowId);
        const matches = operation.expectedRevision === 'absent'
          ? current === undefined
          : current?.revision === operation.expectedRevision;
        if (!matches) return { status: 'conflict' as const, results: [] };
      }
      const results = operations.flatMap((operation) => {
        if (operation.kind !== 'put') return [];
        const revision = (rows.get(operation.value.id)?.revision ?? 0) + 1;
        rows.set(operation.value.id, { rowId: operation.value.id, revision, value: operation.value });
        return [{ rowId: operation.value.id, revision, deleted: false as const }];
      });
      if (loseNextUpdatedBatchResponse) {
        loseNextUpdatedBatchResponse = false;
        throw new Error('simulated response loss after commit');
      }
      return { status: 'updated' as const, results };
    },
  };
}

function connectionRow(): StateRow {
  const connection = createCurrentConversationConnectionFixture({
    connectionId: 'connection-1',
    authority: pairingConnectionAuthority,
    createdAt: 1_000,
    updatedAt: 1_000,
    transport: { kind: 'socket' },
    overlapSafety: 'safe',
    replayContinuity: 'none',
    outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
    pairingDeepLinkTemplate: 'https://example.test/pair?token={{token}}',
  });
  return {
    rowId: 'connection-1',
    revision: 4,
    value: connection,
  };
}

function checkpointedPullConnectionRow(): StateRow {
  const connection = createCurrentConversationConnectionFixture({
    connectionId: 'connection-1',
    authority: checkpointedPollConnectionAuthority,
    createdAt: 1_000,
    updatedAt: 1_000,
    transport: { kind: 'checkpointedPull' },
    overlapSafety: 'safe',
    replayContinuity: 'checkpointed',
    outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
    pairingDeepLinkTemplate: 'https://example.test/pair?token={{token}}',
  });
  return {
    rowId: 'connection-1',
    revision: 4,
    value: connection,
  };
}

describe('Channels pairing management writer', () => {
  it('returns the strict created handoff from the public pairing create Action', async () => {
    const createHandlers = Reflect.get(management, 'createConversationPairingManagementHandlers');
    expect(createHandlers).toEqual(expect.any(Function));
    if (typeof createHandlers !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const context = pairingManagementContext({
      collection,
      actions: { execute: vi.fn(async () => ({ kind: 'verified' as const, templateVersion: 3 })) },
    });
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const handlers = createHandlers(manager);

    const result = await handlers.create({
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      target,
    }, context);

    expect(ConversationPairingCreateResultV1Schema.parse(result)).toEqual({
      kind: 'created',
      generationId: 'generation-1',
      challengeId: 'challenge-1',
      expiresAt: 601_000,
      attemptsRemaining: 5,
      destinationLabel: 'Test bot',
      manualToken: '00000001',
      deepLinkUrl: 'https://example.test/pair?token=00000001',
    });
  });

  it('persists final-result delivery after pairing revalidates the Automation target', async () => {
    const createHandlers = Reflect.get(management, 'createConversationPairingManagementHandlers');
    expect(createHandlers).toEqual(expect.any(Function));
    if (typeof createHandlers !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const execute = vi.fn(async () => ({ kind: 'verified' as const, templateVersion: 3 }));
    const context = pairingManagementContext({ collection, actions: { execute } });
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const handlers = createHandlers(manager);
    const challenge = await handlers.create({
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      target: finalResultAutomationTarget,
    }, context);
    if (!('manualToken' in challenge)) throw new Error('Expected a verified pairing challenge.');
    const proposal = completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1', label: 'Alice' },
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
    });
    if (proposal.kind !== 'matched') throw new Error('Expected a pairing proposal.');

    await expect(handlers.finalize({
      generationId: challenge.generationId,
      proposalId: proposal.proposalId,
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      finalizeIdempotencyKey: 'finalize-1',
    }, context)).resolves.toMatchObject({
      kind: 'created',
      binding: {
        target: {
          kind: 'automation',
          automationId: 'automation-1',
          templateVersion: 3,
          policy: { resultDelivery: 'finalResult' },
        },
      },
    });

    expect(execute).toHaveBeenNthCalledWith(
      1,
      'automation.conversation.target.verify',
      {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
        // Early pairing feedback runs before the proposal mints a binding id.
        resultDelivery: 'finalResult',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      'automation.conversation.target.verify',
      {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
        resultDelivery: 'finalResult',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(collection.batches).toHaveLength(1);
    expect(collection.rows.get('binding-1')?.value).toMatchObject({
      payload: {
        target: {
          kind: 'automation',
          automationId: 'automation-1',
          templateVersion: 3,
          policy: { resultDelivery: 'finalResult' },
        },
      },
    });
  });

  it('clears only the exact blocked poll failure and recovers a lost write response by rereading the connection', async () => {
    const retry = Reflect.get(management, 'retryConversationConnectionPollForInvocation');
    expect(retry).toEqual(expect.any(Function));
    if (typeof retry !== 'function') return;

    const initial = connectionRow();
    const collection = createCollection([{
      ...initial,
      value: {
        ...initial.value,
        payload: {
          ...initial.value.payload,
          pollFailure: {
            phase: 'blocked',
            attemptCount: 2,
            retryNotBeforeMs: null,
            evidence: { kind: 'provider', reason: 'credentialInvalid' },
          },
        },
      },
    }]);
    const context = pairingManagementContext({ collection });
    collection.loseNextUpdatedBatchResponse();

    await expect(retry({
      connectionId: 'connection-1',
      expectedRevision: 4,
      authorityEpoch: 1,
    }, context)).resolves.toEqual({
      kind: 'retryScheduled',
      connectionId: 'connection-1',
      revision: 5,
      authorityEpoch: 1,
    });

    expect(collection.batches).toHaveLength(1);
    expect(collection.rows.get('connection-1')).toMatchObject({
      revision: 5,
      value: { payload: { pollFailure: null } },
    });
    await expect(retry({
      connectionId: 'connection-1',
      expectedRevision: 4,
      authorityEpoch: 1,
    }, context)).rejects.toMatchObject({ code: 'channels_connection_poll_retry_conflict', retryable: true });
  });

  it('refuses a poll retry when its otherwise-current authority epoch is stale', async () => {
    const retry = Reflect.get(management, 'retryConversationConnectionPollForInvocation');
    expect(retry).toEqual(expect.any(Function));
    if (typeof retry !== 'function') return;

    const initial = connectionRow();
    const collection = createCollection([{
      ...initial,
      value: {
        ...initial.value,
        payload: {
          ...initial.value.payload,
          pollFailure: {
            phase: 'blocked',
            attemptCount: 1,
            retryNotBeforeMs: null,
            evidence: { kind: 'provider', reason: 'permissionMissing' },
          },
        },
      },
    }]);
    const context = pairingManagementContext({ collection });

    await expect(retry({
      connectionId: 'connection-1',
      expectedRevision: 4,
      authorityEpoch: 2,
    }, context)).rejects.toMatchObject({ code: 'channels_connection_poll_retry_conflict', retryable: true });

    expect(collection.batches).toHaveLength(0);
    expect(collection.rows.get('connection-1')?.value.payload.pollFailure).toEqual({
      phase: 'blocked',
      attemptCount: 1,
      retryNotBeforeMs: null,
      evidence: { kind: 'provider', reason: 'permissionMissing' },
    });
  });

  it('rejects a pairing target whose /new principal is outside the pairing binding allowlist without consuming its proposal', async () => {
    const createHandlers = Reflect.get(management, 'createConversationPairingManagementHandlers');
    expect(createHandlers).toEqual(expect.any(Function));
    if (typeof createHandlers !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const execute = vi.fn(async () => ({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-1',
      scannedThroughSeq: 12,
      nextCursor: 'cursor-12',
      hasMore: false,
      items: [],
    }));
    const context = pairingManagementContext({ collection, actions: { execute } });
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const handlers = createHandlers(manager);
    const challenge = await handlers.create({
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      target: newSessionPrincipalOutsidePairingAllowlistTarget,
    }, context);
    if (challenge.kind !== 'created') throw new Error('Expected a created pairing challenge.');
    const proposal = completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1', label: 'Alice' },
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
    });
    if (proposal.kind !== 'matched') throw new Error('Expected a pairing proposal.');

    await expect(handlers.finalize({
      generationId: challenge.generationId,
      proposalId: proposal.proposalId,
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      finalizeIdempotencyKey: 'finalize-1',
    }, context)).rejects.toMatchObject({ code: 'channels_binding_create_corrupt' });

    expect(execute).not.toHaveBeenCalled();
    expect(collection.batches).toHaveLength(0);
    expect(collection.rows.has('binding-1')).toBe(false);
    await expect(handlers.cancel({
      generationId: challenge.generationId,
      proposalId: proposal.proposalId,
    }, context)).resolves.toEqual({ kind: 'cancelled' });
  });

  it('fails closed before pairing finalization persists an enabled approval policy without its producer', async () => {
    const createHandlers = Reflect.get(management, 'createConversationPairingManagementHandlers');
    expect(createHandlers).toEqual(expect.any(Function));
    if (typeof createHandlers !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const execute = vi.fn(async () => ({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-1',
      scannedThroughSeq: 12,
      nextCursor: 'cursor-12',
      hasMore: false,
      items: [],
    }));
    const context = pairingManagementContext({ collection, actions: { execute } });
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const handlers = createHandlers(manager);
    const challenge = await handlers.create({
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      target: approvalEnabledTarget,
    }, context);
    if (challenge.kind !== 'created') throw new Error('Expected a created pairing challenge.');
    const proposal = completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1', label: 'Alice' },
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
    });
    if (proposal.kind !== 'matched') throw new Error('Expected a pairing proposal.');

    await expect(handlers.finalize({
      generationId: challenge.generationId,
      proposalId: proposal.proposalId,
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      finalizeIdempotencyKey: 'finalize-1',
    }, context)).rejects.toMatchObject({ code: 'plugin_action_unavailable' });

    expect(execute).not.toHaveBeenCalled();
    expect(collection.batches).toHaveLength(0);
    expect(collection.rows.has('binding-1')).toBe(false);
    await expect(handlers.cancel({
      generationId: challenge.generationId,
      proposalId: proposal.proposalId,
    }, context)).resolves.toEqual({ kind: 'cancelled' });
  });

  it('withholds a checkpointed-pull pairing challenge until the core commits its first no-history poll token', async () => {
    const createHandlers = Reflect.get(management, 'createConversationPairingManagementHandlers');
    expect(createHandlers).toEqual(expect.any(Function));
    if (typeof createHandlers !== 'function') return;

    const connection = checkpointedPullConnectionRow();
    const collection = createCollection([connection]);
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      _operation: unknown,
      _input: JsonValue,
      _executionOptions: Readonly<{ signal: AbortSignal }>,
    ) => ({
      result: { kind: 'checkpointOnly', checkpointAfterBatch: { offset: '43' } },
      executionOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
    }));
    const context = pairingManagementContext({
      collection,
      actions: { execute: vi.fn(), executeAdmittedTargetedOperationWithExecutionOrigin },
      targetedContributions: targetedCheckpointedPollContribution(),
    });
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const handlers = createHandlers(manager);
    const createInput = {
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      target,
    } as const;

    await expect(handlers.create(createInput, context)).rejects.toMatchObject({
      code: 'channels_pairing_connection_baseline_pending',
      retryable: true,
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, context)).resolves.toMatchObject({
      kind: 'committed',
      connectionId: 'connection-1',
      authorityEpoch: 1,
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin.mock.calls[0]?.[1]).toMatchObject({ checkpoint: null });

    const checkpointId = await deriveConversationCheckpointRowId({
      connectionId: 'connection-1',
      routingIdentityKey: 'r'.repeat(43),
    });
    expect(collection.rows.get(checkpointId)?.value).toMatchObject({
      payload: { opaqueToken: { offset: '43' } },
    });

    await expect(handlers.create(createInput, context)).resolves.toMatchObject({
      generationId: 'generation-1',
      challengeId: 'challenge-1',
      manualToken: '00000001',
    });
  });

  it('creates one paused Session binding from the authenticated proposal facts', async () => {
    const createHandlers = Reflect.get(management, 'createConversationPairingManagementHandlers');
    expect(createHandlers).toEqual(expect.any(Function));
    if (typeof createHandlers !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const execute = vi.fn(async () => ({
      ok: true,
      projection: 'externalShareableV1' as const,
      sessionId: 'session-1',
      scannedThroughSeq: 12,
      nextCursor: 'cursor-12',
      hasMore: false,
      items: [],
    }));
    const context = pairingManagementContext({ collection, actions: { execute } });
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const handlers = createHandlers(manager);
    const challenge = await handlers.create({
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      target,
    }, context);
    if (challenge.kind !== 'created') throw new Error('Expected a created pairing challenge.');
    const proposal = completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1', label: 'Alice' },
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
    });
    if (proposal.kind !== 'matched') throw new Error('Expected a pairing proposal.');

    await expect(handlers.finalize({
      generationId: challenge.generationId,
      proposalId: proposal.proposalId,
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      finalizeIdempotencyKey: 'finalize-1',
    }, context)).resolves.toEqual({
      kind: 'created',
      binding: {
        v: 1,
        id: 'binding-1',
        connectionId: 'connection-1',
        endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1', label: 'Alice' },
        target,
        allowedPrincipalIds: ['person-1'],
        allowBotSenders: false,
        inputMode: 'allAllowedMessages',
        inboundDebounceMs: 750,
        linkPreviewPolicy: 'suppress',
        senderFeedback: 'off',
        authorityEpoch: 1,
        enabled: false,
        deletionState: 'none',
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    });
    expect(collection.rows.get('binding-1')?.value).toMatchObject({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: { target, enabled: false, deletionState: 'none' },
    });
    expect(execute).toHaveBeenCalledWith(
      'session.transcript.get',
      {
        sessionId: 'session-1',
        projection: 'externalShareableV1',
        cursor: null,
        limit: 100,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(collection.rows.get('projection-frontier:binding-1')?.value).toMatchObject({
      'record-kind': 'projection-frontier',
      'binding-id': 'binding-1',
      payload: {
        targetSessionId: 'session-1',
        transcriptCursor: 'cursor-12',
        lastScannedSeq: 12,
        revision: 1,
      },
    });
  });

  it('treats early Automation verification as feedback only and rechecks before pairing persistence', async () => {
    const createHandlers = Reflect.get(management, 'createConversationPairingManagementHandlers');
    expect(createHandlers).toEqual(expect.any(Function));
    if (typeof createHandlers !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const execute = vi.fn()
      .mockResolvedValueOnce({ kind: 'verified', templateVersion: 3 })
      .mockResolvedValueOnce({ kind: 'notVerified', reason: 'templateVersionMismatch' });
    const context = pairingManagementContext({ collection, actions: { execute } });
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const handlers = createHandlers(manager);
    const challenge = await handlers.create({
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      target: automationTarget,
    }, context);
    if (!('manualToken' in challenge)) throw new Error('Expected a verified pairing challenge.');
    const proposal = completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1', label: 'Alice' },
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
    });
    if (proposal.kind !== 'matched') throw new Error('Expected a pairing proposal.');

    await expect(handlers.finalize({
      generationId: challenge.generationId,
      proposalId: proposal.proposalId,
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      finalizeIdempotencyKey: 'finalize-1',
    }, context)).resolves.toEqual({ kind: 'notVerified', reason: 'templateVersionMismatch' });

    expect(execute).toHaveBeenNthCalledWith(
      1,
      'automation.conversation.target.verify',
      {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
        // Early pairing feedback runs before the proposal mints a binding id.
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      'automation.conversation.target.verify',
      {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(collection.batches).toHaveLength(0);
    expect(collection.rows.has('binding-1')).toBe(false);
  });

  it('rejoins a committed Automation pairing after response loss even when current verification later fails', async () => {
    const createHandlers = Reflect.get(management, 'createConversationPairingManagementHandlers');
    expect(createHandlers).toEqual(expect.any(Function));
    if (typeof createHandlers !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const execute = vi.fn()
      .mockResolvedValueOnce({ kind: 'verified', templateVersion: 3 })
      .mockResolvedValueOnce({ kind: 'verified', templateVersion: 3 })
      .mockResolvedValueOnce({ kind: 'notVerified', reason: 'templateVersionMismatch' });
    const context = pairingManagementContext({ collection, actions: { execute } });
    const manager = createConversationPairingManager({
      generationId: 'generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const handlers = createHandlers(manager);
    const challenge = await handlers.create({
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      target: automationTarget,
    }, context);
    if (!('manualToken' in challenge)) throw new Error('Expected a verified pairing challenge.');
    const proposal = completePreBindingMessage(manager, {
      connectionId: 'connection-1',
      materialization,
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1', label: 'Alice' },
      actor: { principalId: 'person-1', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${challenge.manualToken}`),
    });
    if (proposal.kind !== 'matched') throw new Error('Expected a pairing proposal.');
    const finalizeInput = {
      generationId: challenge.generationId,
      proposalId: proposal.proposalId,
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      finalizeIdempotencyKey: 'finalize-1',
    } as const;
    collection.loseNextUpdatedBatchResponse();

    await expect(handlers.finalize(finalizeInput, context)).resolves.toEqual({ kind: 'retryableFailure' });
    await expect(handlers.finalize(finalizeInput, context)).resolves.toMatchObject({
      kind: 'rejoined',
      binding: {
        id: 'binding-1',
        target: { kind: 'automation', automationId: 'automation-1', templateVersion: 3 },
      },
    });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(collection.rows.get('binding-1')?.value).toMatchObject({
      payload: {
        target: { kind: 'automation', automationId: 'automation-1', templateVersion: 3 },
      },
    });
  });
});
