import { expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionForDefinition } from '@happier-dev/plugin-sdk/collections';
import { CHANNEL_STATE_COLLECTION } from './collections.js';
import { withChannelStateSessionIdentity } from './collectionMigrations.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import { createConversationDiscussionInputLocalId } from './discussionInputIdentity.js';
import { readConversationDiscussionReplyDestination, type ConversationDiscussionReplyAncestor } from './discussionReplyDestination.js';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import type { PluginServices, TargetedContributionsService, TargetedContributionSnapshot } from '@happier-dev/plugin-sdk';
import type { TargetedContributionPointRef } from '@happier-dev/plugin-sdk/contributions';
import { CHANNELS_PLUGIN, CHANNELS_PROVIDER_POINT_REF, type ChannelsProviderContributionV1 } from './manifest.js';
import { activate as activateAccount } from './accountRuntime.js';
import { DISCUSSION_REPLY_DESTINATION_ACTION_ID_V1 } from '@happier-dev/channels-protocol/v1';
const conversationName = 'Release planning · European maintainers · Friday morning';

async function destinationFixture() {
  const state = new MemoryCollection<Record<string, JsonValue>>();
  const connection = createCurrentConversationConnectionFixture({ connectionId: 'connection-id', authority: {
    providerPluginId: 'happier.channel.example', providerContributionSelection: { contributionId: 'example' },
    providerSetupInput: {}, credentialRef: null,
    transportOrigin: { serverIdentityId: 'srv_plugin_testkit', machineId: 'machine' },
    providerConnectionKey: 'provider:connection', providerConfig: {}, routingIdentityKey: 'f'.repeat(43),
    integrationPrincipal: { id: 'bot-id', label: 'Team mailbox' }, authorityEpoch: 1,
  } });
  await state.put(connection, { expectedRevision: 'absent' });
  const target = { kind: 'discussion', discussionId: 'discussion-id', policy: { deliveryMode: 'repliesOnly' } };
  await state.put(withChannelStateSessionIdentity({ id: 'binding-id', 'record-kind': 'binding', v: 1,
    'connection-id': connection.id, 'binding-id': 'binding-id', 'created-at': 1, 'updated-at': 1,
    payload: { endpoint: { kind: 'direct', audience: 'direct', id: 'external-id', label: conversationName },
      target, allowedPrincipalIds: ['person'], allowBotSenders: false,
      inputMode: 'allAllowedMessages', inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off',
      authorityEpoch: 1, enabled: true, deletionState: 'none' } }, target), { expectedRevision: 'absent' });
  const messages = new Map<string, ConversationDiscussionReplyAncestor>([
    ['followup', { localId: 'ordinary-reply', replyTarget: { kind: 'message', messageId: 'original' } }],
    ['original', { localId: createConversationDiscussionInputLocalId('binding-id', 'o'.repeat(43)) }],
  ]);
  const collection = state as unknown as Pick<PluginAccountCollectionForDefinition<typeof CHANNEL_STATE_COLLECTION>, 'get'>;
  return { state, collection, messages };
}

it('names a nested reply destination from its original binding and current connection, without scanning unrelated bindings', async () => {
  const { collection, messages } = await destinationFixture();
  const readMessage = async (id: string) => {
    const message = messages.get(id);
    return message ? { ...message, content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Question' }] }, accountActor: null } : undefined;
  };
  expect(await readConversationDiscussionReplyDestination({ discussionId: 'discussion-id', messageId: 'followup',
    readMessage, collection })).toEqual({ kind: 'channel',
    connectionName: 'Team mailbox', conversationName });
  expect(await readConversationDiscussionReplyDestination({ discussionId: 'another-discussion', messageId: 'original',
    readMessage, collection })).toEqual({ kind: 'none' });
  expect(await readConversationDiscussionReplyDestination({ discussionId: 'discussion-id', messageId: 'ordinary',
    readMessage: async () => ({ localId: 'ordinary', content: { v: 1, parts: [{ t: 'text', text: 'Ordinary' }] }, accountActor: null }),
    collection })).toEqual({ kind: 'none' });
});

it('exposes destination names through the registered portable Account Action and refuses incomplete ancestry', async () => {
  expect(CHANNELS_PLUGIN.manifest.contributes.actions?.find(action => action.id === DISCUSSION_REPLY_DESTINATION_ACTION_ID_V1)
    ?.placementBindings).toEqual([]);
  const { state, messages } = await destinationFixture();
  let incomplete = false;
  let contentUnavailable = false;
  let foreign = false;
  let ownerNamed = true;
  let providerAvailable = false;
  // The host's admitted contribution snapshot is the public provider metadata boundary.
  const targetedContributions: TargetedContributionsService = {
    observeForSelf<TContribution>(_point: TargetedContributionPointRef<TContribution>) {
      return { dispose() {}, async readCurrent(): Promise<TargetedContributionSnapshot<TContribution>> {
        if (!providerAvailable) throw new Error('Provider presentation unavailable');
        const custody = { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'fixture' } } as const;
        const contribution = { contributor: { pluginId: 'happier.channel.example', contributionId: 'example',
          occurrenceId: 'example:1', sourceCustody: custody }, protocol: CHANNELS_PROVIDER_POINT_REF.protocol,
          descriptor: { v: 1, displayName: 'Email' }, operations: {} } as unknown as ChannelsProviderContributionV1;
        return { occurrenceId: 'channels:1', sourceCustody: custody, contributions: [contribution] as unknown as readonly TContribution[] };
      } };
    },
  };
  // The host Action transport and Account database are genuine plugin boundaries.
  const actions = { execute: async (id: string, input: { messageId?: string }) => {
    if (id !== 'discussion.read') throw new Error('Unexpected host Action');
    const idToRead = input.messageId ?? '';
    const message = messages.get(idToRead);
    return { v: 1, serverId: 'srv_plugin_testkit', discussionId: 'discussion-id', messageSeq: 2,
      incomplete, hasMoreOlder: false, messages: message ? [{ ...message, localId: foreign ? null : message.localId,
        id: idToRead, discussionId: 'discussion-id', seq: 1,
        authorAccountId: 'person', accountActor: ownerNamed ? { v: 1, accountId: 'person', profile: {
          name: 'Channel owner', firstName: 'Channel owner', lastName: null, username: 'owner', avatarUrl: null,
        } } : null, producerV1: null, mentionedAccountIds: [], createdAt: 1,
        messageRef: { kind: 'discussion', discussion: { serverId: 'srv_plugin_testkit', discussionId: 'discussion-id' }, messageId: idToRead },
        content: contentUnavailable ? null : { v: 1, parts: [{ t: 'text', text: 'Question' }],
          ...(idToRead === 'original' ? { externalSource: { kind: 'channel',
            providerPluginId: 'happier.channel.example', conversationDisplayName: conversationName, senderDisplayName: 'Sender' } } : {}) } }] : [] };
  } } as unknown as ActionsService;
  const core = await createPluginTestkit({ manifest: CHANNELS_PLUGIN.manifest,
    module: { activate: CHANNELS_PLUGIN.activate, activateAccount }, resolveCurrentPluginMaterializationRef: () => null,
    services: { actions, targetedContributions, storage: { account: { collection: () => foreign ? {
      get: async () => { throw new Error('A shared destination must not read private binding records'); },
    } : state } } as unknown as PluginServices['storage'] } });
  try {
    expect(await core.invokeAction(DISCUSSION_REPLY_DESTINATION_ACTION_ID_V1, {
      discussionId: 'discussion-id', messageId: 'followup',
    }, { surface: 'ui' })).toEqual({ kind: 'channel', connectionName: 'Team mailbox', conversationName });
    // Owner ruling 2026-11-10: posting participants may outward-reply; display uses readable provenance, never foreign local IDs.
    foreign = true;
    for (const messageId of ['original', 'followup']) {
      expect(await core.invokeAction(DISCUSSION_REPLY_DESTINATION_ACTION_ID_V1, {
        discussionId: 'discussion-id', messageId,
      }, { surface: 'ui' })).toEqual({ kind: 'channel', connectionName: 'Channel owner', conversationName });
    }
    providerAvailable = true;
    expect(await core.invokeAction(DISCUSSION_REPLY_DESTINATION_ACTION_ID_V1, {
      discussionId: 'discussion-id', messageId: 'followup',
    }, { surface: 'ui' })).toEqual({ kind: 'channel', connectionName: 'Channel owner · Email', conversationName });
    ownerNamed = false;
    expect(await core.invokeAction(DISCUSSION_REPLY_DESTINATION_ACTION_ID_V1, {
      discussionId: 'discussion-id', messageId: 'original',
    }, { surface: 'ui' })).toEqual({ kind: 'channel', connectionName: 'Email', conversationName });
    providerAvailable = false;
    expect(await core.invokeAction(DISCUSSION_REPLY_DESTINATION_ACTION_ID_V1, {
      discussionId: 'discussion-id', messageId: 'original',
    }, { surface: 'ui' })).toEqual({ kind: 'channel', connectionName: null, conversationName });
    incomplete = true;
    await expect(core.invokeAction(DISCUSSION_REPLY_DESTINATION_ACTION_ID_V1, {
      discussionId: 'discussion-id', messageId: 'followup',
    }, { surface: 'ui' })).rejects.toMatchObject({ code: 'discussion_content_unavailable' });
    incomplete = false;
    contentUnavailable = true;
    await expect(core.invokeAction(DISCUSSION_REPLY_DESTINATION_ACTION_ID_V1, {
      discussionId: 'discussion-id', messageId: 'followup',
    }, { surface: 'ui' })).rejects.toMatchObject({ code: 'discussion_content_unavailable' });
  } finally { await core.dispose(); }
});
