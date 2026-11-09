import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { ConversationBindingV1Schema } from '@happier-dev/channels-protocol/v1';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { CHANNEL_STATE_COLLECTION } from './collections.js';
import { withChannelStateSessionIdentity } from './collectionMigrations.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import { TRANSCRIPT_ACTIVITIES_RESOURCE_RUNTIME } from './transcriptActivitiesResource.js';
import { SESSION_CONVERSATIONS_RESOURCE_RUNTIME } from './sessionConversationsResource.js';
import { createConversationOutwardDeliveryCollectionStore } from './outwardDelivery.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import { observeConversationSessionCollections } from './sessionCollectionObservation.js';
import { sessionPullRequestBindingFixture } from './testkit/sessionPullRequestBindingFixture.js';
const stateSchema = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);

function bindingValue(id: string, sessionId: string) {
  const { connectionId, createdAt, updatedAt, v, ...payloadWithId } = ConversationBindingV1Schema.parse({
    v: 1, id, connectionId: 'connection-1', createdAt: 1, updatedAt: 1,
    endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
    target: { kind: 'session', sessionId, policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
      approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
    allowedPrincipalIds: ['person-1'], allowBotSenders: false, inputMode: 'allAllowedMessages',
    inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1,
    enabled: true, deletionState: 'none',
  });
  const { id: _id, ...payload } = payloadWithId;
  const value = withChannelStateSessionIdentity({ id, v, 'record-kind': 'binding', 'connection-id': connectionId,
    'binding-id': id, 'created-at': createdAt, 'updated-at': updatedAt, payload }, payload.target);
  expect(isValidPluginJsonSchemaValue(stateSchema, value)).toBe(true);
  return value;
}

describe('selected Session Collection observation', () => {
  it.each(['outward', 'conversations', 'pullRequestWatch'] as const)(
    'retires %s membership reads on update_required rather than retrying on row hints', async scope => {
      const state = new MemoryCollection();
      const deliveries = new MemoryCollection();
      const reads = vi.spyOn(state, 'query').mockRejectedValue(new PluginError({
        code: 'collection_update_required', retryable: false,
      }));
      const invalidate = vi.fn();
      const controller = new AbortController();
      const observation = await observeConversationSessionCollections(invalidate, {
        accountStorage: { collection: (definition: { id: string }) => definition.id === CHANNEL_STATE_COLLECTION.id
          ? state : deliveries } as unknown as PluginAccountStorageScope,
        sessionId: 'session-a', signal: controller.signal, scope,
      });
      try {
        await vi.waitFor(() => expect(invalidate).toHaveBeenCalledOnce());
        for (let pass = 0; pass < 100; pass += 1) {
          state.resetObservation();
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        expect(reads).toHaveBeenCalledOnce();
        expect(invalidate).toHaveBeenCalledOnce();
        reads.mockRestore();
        const freshReads = vi.spyOn(state, 'query');
        const fresh = await observeConversationSessionCollections(invalidate, {
          accountStorage: { collection: (definition: { id: string }) => definition.id === CHANNEL_STATE_COLLECTION.id
            ? state : deliveries } as unknown as PluginAccountStorageScope,
          sessionId: 'session-a', signal: controller.signal, scope,
        });
        await vi.waitFor(() => expect(freshReads).toHaveBeenCalledOnce());
        fresh.dispose();
      } finally { observation.dispose(); controller.abort(); }
    },
  );

  it('reads only PR bodies and observes only PR membership among a thousand same-Session chats', async () => {
    const state = new MemoryCollection();
    const value = sessionPullRequestBindingFixture('selected-pr', 'session-a', 12);
    await state.put(withChannelStateSessionIdentity(value, value.payload.target), { expectedRevision: 'absent' });
    for (let index = 0; index < 1_000; index += 1) {
      await state.put(bindingValue(`unrelated-chat-${index}`, 'session-a'), { expectedRevision: 'absent' });
    }
    const storage = { collection: (definition: { id: string }) => {
      if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('PR Watch does not read deliveries');
      return state;
    } } as unknown as PluginAccountStorageScope;
    const watch = vi.spyOn(state, 'watch');
    const reads = vi.spyOn(state, 'query');
    const invalidate = vi.fn();
    const controller = new AbortController();
    const observation = await observeConversationSessionCollections(invalidate, {
      accountStorage: storage, sessionId: 'session-a', signal: controller.signal, scope: 'pullRequestWatch',
    });
    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith({ index: 'by-connection-binding-v2',
      prefix: ['connection-1', null, 'connection'], order: 'asc' }, expect.any(Function)));
    const bodies = (await Promise.all(reads.mock.results.map(result => {
      if (result.type !== 'return') throw new Error('Expected a completed Collection read');
      return result.value;
    })))
      .flatMap(page => page.rows);
    expect(bodies.filter(row => row.rowId.startsWith('unrelated-chat-'))).toHaveLength(0);
    expect(bodies.map(row => row.rowId)).toEqual(['selected-pr']);
    expect(invalidate).not.toHaveBeenCalled();
    reads.mockClear();
    await state.put(bindingValue('unrelated-chat-0', 'session-a'), { expectedRevision: 1 });
    expect(invalidate).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    await state.put({ id: 'other-connection', 'record-kind': 'connection', 'connection-id': 'other-connection' }, { expectedRevision: 'absent' });
    expect(invalidate).not.toHaveBeenCalled();
    await state.put({ id: 'connection-1', 'record-kind': 'connection', 'connection-id': 'connection-1' }, { expectedRevision: 'absent' });
    expect(invalidate).toHaveBeenCalledOnce();
    observation.dispose();
  });
  it.each([TRANSCRIPT_ACTIVITIES_RESOURCE_RUNTIME, SESSION_CONVERSATIONS_RESOURCE_RUNTIME])('ignores unrelated binding changes and retires exact dependencies on retarget and disposal (%#)', async runtime => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(createCurrentConversationConnectionFixture({ connectionId: 'connection-1',
      authority: { providerPluginId: 'happier.channel.example', providerContributionSelection: { contributionId: 'provider' },
        providerSetupInput: {}, credentialRef: null, transportOrigin: { serverIdentityId: 'srv_example', machineId: 'machine-1' },
        providerConnectionKey: 'provider-connection-1', providerConfig: {}, routingIdentityKey: 'a'.repeat(43),
        integrationPrincipal: { id: 'person-1' }, authorityEpoch: 1 },
      transport: { kind: 'checkpointedPull' }, overlapSafety: 'safe', replayContinuity: 'checkpointed',
    }), { expectedRevision: 'absent' });
    await state.put(bindingValue('selected', 'session-a'), { expectedRevision: 'absent' });
    const storage = { collection: (definition: { id: string }) => definition.id === CHANNEL_STATE_COLLECTION.id ? state : deliveries } as unknown as PluginAccountStorageScope;
    const watch = vi.spyOn(deliveries, 'watch');
    const reads = vi.spyOn(state, 'query');
    const invalidate = vi.fn();
    const controller = new AbortController();
    const observation = await runtime.observe(invalidate, createTestResourceInvocationContext({
      accountStorage: storage, context: { kind: 'session', sessionId: 'session-a' }, signal: controller.signal,
    }));
    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith({ index: 'by-owner-attention',
      prefix: ['connection-1', 'selected'], order: 'asc' }, expect.any(Function)));
    invalidate.mockClear();
    reads.mockClear();
    for (let index = 0; index < 1_000; index += 1) {
      await state.put(bindingValue(`foreign-${index}`, `foreign-session-${index}`), { expectedRevision: 'absent' });
    }
    expect(invalidate).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    const custody = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never, deliveriesCollection: deliveries as never, signal: controller.signal, now: () => 100,
    });
    const created = await custody.ensure({ connectionId: 'connection-1', bindingId: 'selected',
      routeAuthority: { connectionAuthorityEpoch: 1, bindingRevision: 1, bindingAuthorityEpoch: 1 },
      source: { kind: 'controlResponse', controlId: 'control-1', controlKind: 'newSession' },
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' }, content: { text: 'Delivery content' },
      deliveryKey: 'delivery-1',  linkPreviewPolicy: 'suppress',
    });
    if (created.kind !== 'created') throw new Error('Expected canonical retained delivery custody');
    expect(invalidate).toHaveBeenCalledOnce();
    await state.put(bindingValue('selected', 'session-b'), { expectedRevision: 1 });
    await vi.waitFor(() => expect(reads).toHaveBeenCalledOnce());
    // Wait for membership acquisition to finish, then old binding custody must be silent.
    await Promise.resolve();
    const beforeRetiredDelivery = invalidate.mock.calls.length;
    await custody.compareAndSwap({ custodyId: created.record.custodyId, expectedRevision: created.record.revision,
      custody: { state: 'retryDue', attemptCount: 1, retryNotBefore: 200, providerMessageIds: [] },
    });
    expect(invalidate).toHaveBeenCalledTimes(beforeRetiredDelivery);
    const beforeReset = invalidate.mock.calls.length;
    state.resetObservation();
    await vi.waitFor(() => expect(invalidate.mock.calls.length).toBeGreaterThan(beforeReset));
    await observation.dispose();
    controller.abort();
    const afterDispose = invalidate.mock.calls.length;
    await state.put(bindingValue('selected', 'session-a'), { expectedRevision: 2 });
    state.resetObservation();
    expect(invalidate).toHaveBeenCalledTimes(afterDispose);
  });
});
