import type {
  JsonValue,
  PluginAutomationRunCause,
  PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import {
  deliverConversationAutomationResultForInvocation,
  prepareConversationAutomationResultDelivery,
} from './automationResultDelivery.js';
import { settleConversationOutwardDeliveriesForConnectionDeletion } from './outwardDelivery.js';
import { conversationRetryDelayMs } from './retryBackoff.js';
import { CHANNEL_DELIVERIES_COLLECTION, CHANNEL_STATE_COLLECTION } from './collections.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';

class MemoryAccountCollection {
  readonly rows = new Map<string, Readonly<{
    rowId: string;
    revision: number;
    value: Record<string, JsonValue>;
  }>>();

  async get(rowId: string) {
    return this.rows.get(rowId) ?? null;
  }

  async put(value: Record<string, JsonValue>, input: Readonly<{
    expectedRevision: number | 'absent';
  }>) {
    const rowId = value.id;
    if (typeof rowId !== 'string') throw new Error('row id is required');
    const current = this.rows.get(rowId);
    if ((input.expectedRevision === 'absent' && current !== undefined)
      || (typeof input.expectedRevision === 'number'
        && (current === undefined || current.revision !== input.expectedRevision))) {
      throw Object.assign(new Error('conflict'), { code: 'plugin_collection_conflict' });
    }
    const row = { rowId, revision: (current?.revision ?? 0) + 1, value };
    this.rows.set(rowId, row);
    return row;
  }

  async query() {
    return { rows: [...this.rows.values()], changeCursor: 1 };
  }

  async delete(rowId: string, input: Readonly<{ expectedRevision: number }>) {
    const current = this.rows.get(rowId);
    if (current === undefined || current.revision !== input.expectedRevision) {
      throw Object.assign(new Error('conflict'), { code: 'plugin_collection_conflict' });
    }
    this.rows.delete(rowId);
    return { rowId, revision: current.revision + 1, deleted: true as const };
  }
}

type ConversationAutomationRunCause = Extract<
  PluginAutomationRunCause,
  Readonly<{ kind: 'conversation' }>
>;

const caller = {
  kind: 'automationRun',
  automationId: 'automation-1',
  runId: 'run-1',
  cause: {
    kind: 'conversation',
    occurrenceKey: 'a'.repeat(43) as ConversationAutomationRunCause['occurrenceKey'],
    occurredAt: 1_700_000_000_000,
  },
} as const satisfies NonNullable<PluginInvocationContext['caller']>;

const source = {
  kind: 'automationResult',
  automationRunId: 'run-1',
  resultId: 'handoff-1',
  automationId: 'automation-1',
  resultDelivery: 'finalResult',
} as const;

function input() {
  return {
    v: 1,
    handoffId: 'handoff-1',
    runId: 'run-1',
    automationId: 'automation-1',
    source,
    result: { v: 1, kind: 'text', text: 'The Automation completed.' },
    opaqueContext: {
      v: 1,
      kind: 'conversationAutomationResultDelivery',
      connectionId: 'connection-1',
      bindingId: 'binding-1',
      bindingRevision: 9,
      connectionAuthorityEpoch: 4,
      bindingAuthorityEpoch: 7,
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
      reply: { providerMessageId: 'message-1' },
      linkPreviewPolicy: 'suppress',
    },
  } as const;
}

function currentConnectionFixture(): Record<string, JsonValue> {
  return createCurrentConversationConnectionFixture({
    connectionId: 'connection-1',
    authority: {
      providerPluginId: 'example.channel.provider',
      providerContributionSelection: {
        contributionId: 'provider-1',
      },
      providerSetupInput: { source: 'test' },
      credentialRef: null,
      transportOrigin: {
        serverIdentityId: 'srv_account_one',
        materializationRef: {
          pluginId: 'example.channel.provider',
          machineId: 'machine-1',
          materializationId: 'provider-materialization-1',
        },
      },
      providerConnectionKey: 'provider-connection-1',
      providerConfig: { account: 'account-1' },
      routingIdentityKey: 'a'.repeat(43),
      integrationPrincipal: { id: 'provider:principal-1' },
      authorityEpoch: 4,
    },
    transport: { kind: 'checkpointedPull' },
    overlapSafety: 'safe',
    replayContinuity: 'checkpointed',
    outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
  }) as Record<string, JsonValue>;
}

function currentBindingFixture(): Record<string, JsonValue> {
  return {
    id: 'binding-1',
    'record-kind': 'binding',
    v: 1,
    'connection-id': 'connection-1',
    'binding-id': 'binding-1',
    'created-at': 1_700_000_000_000,
    'updated-at': 1_700_000_000_000,
    payload: {
      authorityEpoch: 7,
      enabled: true,
      deletionState: 'none',
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
      target: {
        kind: 'automation',
        automationId: 'automation-1',
        policy: { resultDelivery: 'finalResult' },
      },
      allowedPrincipalIds: ['principal-1'],
      allowBotSenders: false,
      inputMode: 'allAllowedMessages',
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress',
      senderFeedback: 'off',
    },
  };
}

function invocationContext(collections: Readonly<{
  state: MemoryAccountCollection;
  deliveries: MemoryAccountCollection;
}>): PluginInvocationContext {
  return {
    invokedAtMs: 1_700_000_000_000,
    caller,
    signal: new AbortController().signal,
    services: {
      storage: {
        account: {
          collection(definition: Readonly<{ id: string }>) {
            if (definition.id === CHANNEL_STATE_COLLECTION.id) return collections.state;
            if (definition.id === CHANNEL_DELIVERIES_COLLECTION.id) return collections.deliveries;
            throw new Error(`Unexpected Collection ${definition.id}`);
          },
        },
      },
    },
  } as unknown as PluginInvocationContext;
}

describe('Conversation Automation result delivery admission', () => {
  it('reads retained route fields while ignoring retired root, endpoint and reply fields', () => {
    const retained = input();
    const prepared = prepareConversationAutomationResultDelivery({
      caller,
      input: {
        ...retained,
        opaqueContext: {
          ...retained.opaqueContext,
          retiredRoute: 'old',
          automationTarget: { automationId: 'other-automation', resultDelivery: 'finalResult' },
          endpoint: { ...retained.opaqueContext.endpoint, retiredEndpoint: 'old' },
          reply: { ...retained.opaqueContext.reply, retiredReply: 'old' },
        },
      },
    });
    expect(prepared).toMatchObject({ kind: 'prepared', route: {
      endpoint: retained.opaqueContext.endpoint,
      replyContext: { replyToMessageId: 'message-1' },
    } });
    if (prepared.kind === 'prepared') expect(prepared.route.endpoint).not.toHaveProperty('retiredEndpoint');
    expect(prepareConversationAutomationResultDelivery({
      caller, input: { ...retained, retiredRequestField: true },
    })).toEqual({ kind: 'blocked', code: 'invalidCustodyRequest' });
    expect(prepareConversationAutomationResultDelivery({
      caller, input: { ...retained, opaqueContext: { ...retained.opaqueContext, bindingAuthorityEpoch: 0 } },
    })).toEqual({ kind: 'blocked', code: 'invalidCustodyRequest' });
  });

  it.each([false, true])('creates outward custody once with the original reply route (parent binding: %s)', async parentBound => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(currentConnectionFixture(), { expectedRevision: 'absent' });
    await state.put(currentBindingFixture(), { expectedRevision: 'absent' });

    const context = invocationContext({ state, deliveries });

    const replyEndpoint = parentBound
      ? { kind: 'thread', audience: 'direct', id: 'thread-1', parentId: 'chat-1' }
      : input().opaqueContext.endpoint;
    const currentInput = {
      ...input(),
      opaqueContext: { ...input().opaqueContext, bindingRevision: 1, endpoint: replyEndpoint },
    };
    const first = await deliverConversationAutomationResultForInvocation(currentInput, context);
    const replay = await deliverConversationAutomationResultForInvocation(currentInput, context);

    expect(first).toMatchObject({ kind: 'accepted' });
    expect(replay).toEqual(first);
    expect(deliveries.rows.size).toBe(1);
    const custody = [...deliveries.rows.values()][0];
    expect(custody?.value).toMatchObject({
      'record-kind': 'outward-delivery',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        source: {
          kind: 'automationResult',
          automationRunId: 'run-1',
          resultId: 'handoff-1',
        },
        endpoint: replyEndpoint, replyContext: { replyToMessageId: 'message-1' },
        content: { text: 'The Automation completed.' },
        state: 'ready',
      },
    });
  });

  it.each([
    ['an in-place binding edit', (payload: Record<string, JsonValue>) => ({
      ...payload,
      inboundDebounceMs: 250,
    })],
    ['a binding disable', (payload: Record<string, JsonValue>) => ({
      ...payload,
      enabled: false,
    })],
    ['a binding delete', (payload: Record<string, JsonValue>) => ({
      ...payload,
      deletionState: 'finalizingDelete',
    })],
  ] as const)(
    'rejoins the exact accepted result custody after a lost response followed by %s',
    async (_description, mutateBindingPayload) => {
      const state = new MemoryAccountCollection();
      const deliveries = new MemoryAccountCollection();
      await state.put(currentConnectionFixture(), { expectedRevision: 'absent' });
      await state.put(currentBindingFixture(), { expectedRevision: 'absent' });

      const context = invocationContext({ state, deliveries });
      const currentInput = {
        ...input(),
        opaqueContext: { ...input().opaqueContext, bindingRevision: 1 },
      };

      const accepted = await deliverConversationAutomationResultForInvocation(currentInput, context);
      expect(accepted).toMatchObject({ kind: 'accepted' });
      expect(deliveries.rows.size).toBe(1);
      const custodyAfterAcceptance = [...deliveries.rows.values()][0];

      const binding = await state.get('binding-1');
      if (binding === null) throw new Error('Expected the admitted binding fixture.');
      await state.put({
        ...binding.value,
        payload: mutateBindingPayload(binding.value.payload as Record<string, JsonValue>),
      }, { expectedRevision: binding.revision });

      const replay = await deliverConversationAutomationResultForInvocation(currentInput, context);

      expect(replay).toEqual(accepted);
      expect(deliveries.rows.size).toBe(1);
      expect([...deliveries.rows.values()][0]).toEqual(custodyAfterAcceptance);
    },
  );

  it('rejoins the exact accepted result custody after a lost response followed by connection deletion', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(currentConnectionFixture(), { expectedRevision: 'absent' });
    await state.put(currentBindingFixture(), { expectedRevision: 'absent' });

    const context = invocationContext({ state, deliveries });
    const currentInput = {
      ...input(),
      opaqueContext: { ...input().opaqueContext, bindingRevision: 1 },
    };

    // The first admission commits custody, but its accepted response never
    // reaches the Run caller.
    const accepted = await deliverConversationAutomationResultForInvocation(currentInput, context);
    expect(accepted).toMatchObject({ kind: 'accepted' });
    expect(deliveries.rows.size).toBe(1);
    const custodyAfterAcceptance = [...deliveries.rows.values()][0];

    // Connection deletion runs its real custody settlement to terminal
    // `connectionDeleted` — compacting the body to the keyed fingerprint —
    // and then physically removes the connection row, destroying the routing
    // identity key that both the deterministic custody id and that
    // fingerprint were derived from.
    const signal = new AbortController().signal;
    await expect(settleConversationOutwardDeliveriesForConnectionDeletion({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      connectionId: 'connection-1',
      signal,
      now: () => 1_700_000_000_000,
    })).resolves.toEqual({ kind: 'pending' });
    // A separate wake re-reads all custody after the CASes before cleanup.
    await expect(settleConversationOutwardDeliveriesForConnectionDeletion({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      connectionId: 'connection-1',
      signal,
      now: () => 1_700_000_000_000,
    })).resolves.toEqual({ kind: 'settled' });
    const settledCustody = await deliveries.get(custodyAfterAcceptance!.rowId);
    expect(settledCustody?.value).toMatchObject({ payload: { state: 'notSent', reason: 'connectionDeleted' } });
    const connectionRow = await state.get('connection-1');
    if (connectionRow === null) throw new Error('Expected the live connection fixture.');
    await state.delete('connection-1', { expectedRevision: connectionRow.revision });

    // The exact rejoin replay must resolve the retained custody identity
    // without a live connection and without creating a second row.
    await expect(deliverConversationAutomationResultForInvocation(currentInput, context))
      .resolves.toEqual(accepted);
    expect(deliveries.rows.size).toBe(1);
    await expect(deliveries.get(custodyAfterAcceptance!.rowId)).resolves.toEqual(settledCustody);
  });

  it('still refuses to create an absent result delivery after the connection was deleted', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(currentConnectionFixture(), { expectedRevision: 'absent' });
    await state.put(currentBindingFixture(), { expectedRevision: 'absent' });
    const connectionRow = await state.get('connection-1');
    if (connectionRow === null) throw new Error('Expected the live connection fixture.');
    await state.delete('connection-1', { expectedRevision: connectionRow.revision });

    const context = invocationContext({ state, deliveries });
    const currentInput = {
      ...input(),
      opaqueContext: { ...input().opaqueContext, bindingRevision: 1 },
    };

    // With no existing custody to rejoin, creation still requires the live
    // connection, so the producer's existing suppression answer stands and
    // no custody row is minted.
    await expect(deliverConversationAutomationResultForInvocation(currentInput, context))
      .resolves.toEqual({ kind: 'suppressed', reason: 'bindingDeleted' });
    expect(deliveries.rows.size).toBe(0);
  });

  it('creates separate custody for an authorized further delivery and preserves the ambiguous one', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(currentConnectionFixture(), { expectedRevision: 'absent' });
    await state.put(currentBindingFixture(), { expectedRevision: 'absent' });

    const context = invocationContext({ state, deliveries });
    const currentInput = {
      ...input(),
      opaqueContext: { ...input().opaqueContext, bindingRevision: 1 },
    };

    const first = await deliverConversationAutomationResultForInvocation(currentInput, context);
    expect(first).toMatchObject({ kind: 'accepted' });
    const ambiguous = [...deliveries.rows.values()][0];
    if (ambiguous === undefined) throw new Error('Expected the first accepted custody row.');
    await deliveries.put({
      ...ambiguous.value,
      payload: {
        ...(ambiguous.value.payload as Record<string, JsonValue>),
        state: 'outcomeUnknown',
        attemptCount: 1,
        providerMessageIds: ['provider-message-1'],
      },
    }, { expectedRevision: ambiguous.revision });
    const ambiguousCustody = await deliveries.get(ambiguous.rowId);

    // The Automation owner mints the Run's next delivery identity when a
    // present user consciously asks for another delivery. Channels must treat
    // it as its own obligation instead of rejoining the unresolved one.
    const authorized = await deliverConversationAutomationResultForInvocation({
      ...currentInput,
      handoffId: 'handoff-1#2',
      source: { ...source, resultId: 'handoff-1#2' },
    }, context);

    expect(authorized).toMatchObject({ kind: 'accepted' });
    expect(authorized).not.toEqual(first);
    expect(deliveries.rows.size).toBe(2);
    await expect(deliveries.get(ambiguous.rowId)).resolves.toEqual(ambiguousCustody);
    const authorizedRow = [...deliveries.rows.values()].find((row) => row.rowId !== ambiguous.rowId);
    expect(authorizedRow?.value).toMatchObject({
      payload: {
        source: { kind: 'automationResult', resultId: 'handoff-1#2' },
        content: { text: 'The Automation completed.' },
        state: 'ready',
      },
    });
  });

  it('uses the canonical positive backoff when Account custody is temporarily unavailable', async () => {
    const context = {
      invokedAtMs: 1_700_000_000_000,
      caller,
      signal: new AbortController().signal,
      services: {
        storage: {
          account: {
            collection() {
              return {
                async get() {
                  throw new Error('Account storage is temporarily unavailable');
                },
              };
            },
          },
        },
      },
    } as unknown as PluginInvocationContext;

    await expect(deliverConversationAutomationResultForInvocation(input(), context)).resolves.toEqual({
      kind: 'retry',
      retryAfterMs: conversationRetryDelayMs(1),
      code: 'temporarilyUnavailable',
    });
  });

  it('accepts only the host-stamped exact Run correspondence and retains the immutable reply route', () => {
    expect(prepareConversationAutomationResultDelivery({
      input: input(),
      caller,
    })).toEqual({
      kind: 'prepared',
      input: input(),
      route: {
        connectionId: 'connection-1',
        bindingId: 'binding-1',
        endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
        replyContext: { replyToMessageId: 'message-1' },
        linkPreviewPolicy: 'suppress',
      },
      source,
    });
  });

  it('replies to the observed inbound message, never the message that inbound itself replied to', () => {
    expect(prepareConversationAutomationResultDelivery({
      input: {
        ...input(),
        opaqueContext: {
          ...input().opaqueContext,
          reply: {
            providerMessageId: 'message-1',
            providerReplyToMessageId: 'earlier-message-1',
          },
        },
      },
      caller,
    })).toMatchObject({
      kind: 'prepared',
      route: { replyContext: { replyToMessageId: 'message-1' } },
    });
  });

  it.each([
    ['no caller', undefined],
    ['a plugin caller', {
      kind: 'plugin',
      pluginId: 'happier.channels',
      contribution: {
        id: 'automation/result-deliver-v1',
        qualifiedId: 'happier.channels/actions/automation/result-deliver-v1',
      },
      occurrenceId: 'channels-automation-result-fixture-occurrence',
      sourceCustody: { kind: 'development', registeredRootId: 'channels-automation-result-fixture-root' },
      materialization: {
        pluginId: 'happier.channels',
        machineId: 'machine-1',
        materializationId: 'channels-1',
      },
    }],
    ['a non-Conversation Run', {
      ...caller,
      cause: { kind: 'manual', invokedAt: 1_700_000_000_000 },
    }],
    ['a different Run', { ...caller, runId: 'run-2' }],
    ['a different Automation', { ...caller, automationId: 'automation-2' }],
  ] as const)('blocks %s without accepting a custody route', (_description, invalidCaller) => {
    expect(prepareConversationAutomationResultDelivery({
      input: input(),
      caller: invalidCaller,
    })).toEqual({ kind: 'blocked', code: 'unauthorizedCaller' });
  });

  it.each([
    ['source run does not equal outer run', { automationRunId: 'run-2' }],
    ['source result does not equal outer handoff', { resultId: 'handoff-2' }],
    ['source Automation does not equal outer Automation', { automationId: 'automation-2' }],
  ] as const)('rejects %s before a custody route exists', (_description, sourceOverride) => {
    expect(prepareConversationAutomationResultDelivery({
      input: { ...input(), source: { ...source, ...sourceOverride } },
      caller,
    })).toEqual({ kind: 'blocked', code: 'invalidCustodyRequest' });
  });

  it('blocks malformed or unrouteable Channel context instead of selecting a fallback destination', () => {
    expect(prepareConversationAutomationResultDelivery({
      input: {
        ...input(),
        opaqueContext: { ...input().opaqueContext, connectionId: '', extra: true },
      },
      caller,
    })).toEqual({ kind: 'blocked', code: 'invalidCustodyRequest' });
    expect(prepareConversationAutomationResultDelivery({
      input: {
        ...input(),
        opaqueContext: {
          ...input().opaqueContext,
          reply: { providerMessageId: '' },
        },
      },
      caller,
    })).toEqual({ kind: 'blocked', code: 'invalidCustodyRequest' });
    expect(prepareConversationAutomationResultDelivery({
      input: { ...input(), result: { v: 1, kind: 'text', text: '' } },
      caller,
    })).toEqual({ kind: 'blocked', code: 'invalidCustodyRequest' });
  });

});
