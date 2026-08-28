import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import {
  deliverConversationAutomationResultForInvocation,
  prepareConversationAutomationResultDelivery,
} from './automationResultDelivery.js';
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
}

const caller = {
  kind: 'automationRun',
  automationId: 'automation-1',
  runId: 'run-1',
  cause: {
    kind: 'conversation',
    occurrenceKey: 'conversation:binding:message-1',
    occurredAt: 1_700_000_000_000,
  },
} as const;

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

describe('Conversation Automation result delivery admission', () => {
  it('creates real outward custody once and rejoins it after a lost accepted response', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority: {
        providerPluginId: 'example.channel.provider',
        providerContributionSelection: {
          contributionId: 'provider-1',
          immutableGenerationId: 'generation-1',
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
    }), { expectedRevision: 'absent' });
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
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
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 'absent' });

    const context = {
      invokedAtMs: 1_700_000_000_000,
      caller,
      signal: new AbortController().signal,
      services: {
        storage: {
          account: {
            collection(name: string) {
              if (name === CHANNEL_STATE_COLLECTION) return state;
              if (name === CHANNEL_DELIVERIES_COLLECTION) return deliveries;
              throw new Error(`Unexpected Collection ${name}`);
            },
          },
        },
      },
    } as unknown as PluginInvocationContext;

    const currentInput = {
      ...input(),
      opaqueContext: { ...input().opaqueContext, bindingRevision: 1 },
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
        content: 'The Automation completed.',
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
        bindingRevision: 9,
        connectionAuthorityEpoch: 4,
        bindingAuthorityEpoch: 7,
        endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
        replyContext: { replyToMessageId: 'message-1' },
        linkPreviewPolicy: 'suppress',
      },
      source,
    });
  });

  it('passes the sealed source through unchanged instead of reconstructing it from route context', () => {
    expect(prepareConversationAutomationResultDelivery({ input: input(), caller })).toMatchObject({
      kind: 'prepared',
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
        opaqueContext: { ...input().opaqueContext, connectionId: 'connection-2', extra: true },
      },
      caller,
    })).toEqual({ kind: 'blocked', code: 'invalidCustodyRequest' });
    expect(prepareConversationAutomationResultDelivery({
      input: {
        ...input(),
        opaqueContext: {
          ...input().opaqueContext,
          automationTarget: {
            automationId: 'automation-1',
            resultDelivery: 'finalResult',
          },
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
