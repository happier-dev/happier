import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginWebSocketConnection } from '@happier-dev/plugin-sdk/http';
import { ConversationProviderSetupResultV1Schema, createConversationAttachmentIdV1 } from '@happier-dev/channels-protocol/v1';
import { assertConversationProviderContributionV1 } from '@happier-dev/channels-protocol/testing/v1';
import { PLUGIN_MANIFEST, activate } from './manifest.js';
import { setupSlackChannels, testSlackConnection, resolveSlackEndpoint, resolveSlackPrincipal, deliverSlackMessage, fetchSlackAttachments } from './slackActions.js';
import * as slackActions from './slackActions.js';

const credentialRef = { service: { pluginId: 'happier.channel.slack', localId: 'slack-bot' }, accountId: 'slack-test' };
const identity = { teamId: 'T1', appId: 'A1', botUserId: 'U1', botId: 'B1', label: 'Happier' };
const connection = { v: 1, connectionId: 'connection-1', providerConnectionKey: 'slack:team:T1:app:A1', providerConfigVersion: 1, providerConfig: identity, credentialRef };
function boundary(options: { foreignApp?: boolean; foreignUser?: boolean; direct?: boolean; foreignChannel?: boolean } = {}) {
  const effects: unknown[] = [];
  let closed = false;
  const materialize = vi.fn(async () => ({ kind: 'environment', env: { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' } }));
  const request = vi.fn(async (input: { url: string; body?: Uint8Array }) => {
    const method = new URL(input.url).pathname.split('/').at(-1);
    const body = method === 'auth.test' ? { ok: true, team_id: 'T1', user_id: 'U1', bot_id: 'B1' }
      : method === 'bots.info' ? { ok: true, bot: { id: 'B1', user_id: 'U1', app_id: 'A1', name: 'Happier' } }
      : method === 'apps.connections.open' ? { ok: true, url: 'wss://wss.slack.com/link?ticket=fixture' }
      : method === 'chat.getPermalink' ? { ok: true, channel: 'C1', permalink: 'https://fixture.slack.com/archives/C1/p1700000000000001' }
      : method === 'conversations.info' ? { ok: true, channel: { id: options.foreignChannel ? 'C2' : options.direct ? 'D1' : 'C1', is_im: options.direct ?? false,
        is_mpim: false, is_private: options.direct ?? false, is_archived: false, name: 'deploys' } }
      : method === 'users.info' ? { ok: true, user: { id: 'U2', team_id: options.foreignUser ? 'T2' : 'T1', is_bot: false, deleted: false, profile: { display_name: 'Alice' } } }
      : method === 'chat.postMessage' || method === 'chat.update' ? { ok: true, channel: 'C1', ts: '1700000000.000002' } : undefined;
    if (!body) throw new Error(`Unexpected Slack request ${method}`);
    if (method === 'chat.postMessage' || method === 'chat.update') effects.push(JSON.parse(new TextDecoder().decode(input.body)));
    return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
  });
  const socket: PluginWebSocketConnection = { url: 'wss://wss.slack.com/link', protocol: '', closed: new Promise(() => {}),
    async receive() { return { kind: 'text', text: JSON.stringify({ type: 'hello', connection_info: { app_id: options.foreignApp ? 'A2' : 'A1' } }) }; },
    async send() {}, close() { closed = true; }, dispose() { closed = true; } };
  const context = {
    plugin: { id: 'happier.channel.slack', version: '0.0.0' }, surface: 'plugin',
    contribution: { id: 'fixture', qualifiedId: 'happier.channel.slack/actions/fixture' }, invokedAtMs: 1,
    caller: { kind: 'plugin', pluginId: 'happier.channels', occurrenceId: 'core-1',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'core-1', installSource: 'npm' },
      contribution: { id: 'fixture', qualifiedId: 'happier.channels/actions/fixture' },
      materialization: { pluginId: 'happier.channels', machineId: 'm1', materializationId: 'core-1' } },
    signal: new AbortController().signal,
    // Only selected credentials and Slack network are replaced at their host boundaries.
    services: { connectedAccounts: { materialize }, http: { request, openWebSocket: async () => socket } } as unknown as PluginInvocationContext['services'],
  } satisfies PluginInvocationContext;
  return { context, materialize, request, effects, isClosed: () => closed };
}

describe('Slack provider Actions', () => {
  it('delivers a registered host notification through the selected current connection without a Channels Action caller', async () => {
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const sender = kit.registration('notificationChannels', 'alerts');
      expect(sender, 'the shipped Slack plugin must register its host sender').toBeTypeOf('function');
      const b = boundary();
      const execute = vi.fn(async () => ({ [connection.connectionId]: { ...connection,
        authorityEpoch: 1, enabled: true, deletionState: 'none', requiresFullSharedMessageContent: false } }));
      const context = { ...b.context, caller: undefined,
        services: { ...b.context.services, actions: { execute } } as unknown as PluginInvocationContext['services'] };
      const request = { clientRequestId: 'health-test', deliveryId: 'health-test', channelId: 'happier.channel.slack/alerts',
        title: 'App needs attention', body: 'A saved health check failed.', destination: {
          connectionId: connection.connectionId, endpoint: { kind: 'shared', audience: 'shared', id: 'slack:T1:channel:C1' },
        } };
      const setup = kit.registration('actions', 'notifications/setup');
      expect(setup, 'destination setup must use the real provider resolver').toBeTypeOf('function');
      expect(await setup!({ connectionId: connection.connectionId, query: 'C1' }, context)).toMatchObject({
        kind: 'resolved', destinations: [request.destination],
      });
      expect(b.effects).toHaveLength(0);
      const preparedCredentials = b.materialize.mock.calls.length;
      const preparedRequests = b.request.mock.calls.length;
      expect(await setup!({ destination: request.destination }, context)).toMatchObject({ kind: 'ready' });
      expect(b.materialize.mock.calls.length).toBe(preparedCredentials);
      expect(b.request.mock.calls.length).toBe(preparedRequests);
      expect(await sender!(request, context)).toMatchObject({ status: 'accepted' });
      expect(b.effects).toMatchObject([{ channel: 'C1', text: 'App needs attention\nA saved health check failed.' }]);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ pluginId: 'happier.channels' }),
        { connectionId: connection.connectionId }, expect.objectContaining({ signal: context.signal }));
      execute.mockResolvedValueOnce({});
      const before = b.materialize.mock.calls.length;
      expect(await sender!(request, context)).toMatchObject({ status: 'failed', code: 'notification_connection_unavailable' });
      expect(b.materialize.mock.calls.length).toBe(before);
      expect(b.effects).toHaveLength(1);
    } finally { await kit.dispose(); }
  });
  it('posts one content-free Session status and edits that same message for subsequent states', async () => {
    expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions?.[0]?.operations).toHaveProperty('sessionStatus');
    const b = boundary();
    const endpoint = { kind: 'thread', audience: 'shared', id: 'slack:T1:channel:C1:thread:1700000000.000001', parentId: 'slack:T1:channel:C1' };
    const result = await slackActions.updateSlackSessionStatus({ ...connection, endpoint, status: 'received' }, b.context);
    expect(result).toEqual({ kind: 'delivered', providerMessageIds: ['1700000000.000002'] });
    for (const status of ['working', 'waitingForApproval', 'idle']) {
      expect(await slackActions.updateSlackSessionStatus({ ...connection, endpoint, status,
        providerMessageId: '1700000000.000002' }, b.context)).toEqual(result);
    }
    expect(b.effects).toMatchObject([
      { channel: 'C1', thread_ts: '1700000000.000001', text: 'Received.' },
      { channel: 'C1', ts: '1700000000.000002', text: 'Received. Working…', as_user: true },
      { channel: 'C1', ts: '1700000000.000002', text: 'Waiting for approval.' },
      { channel: 'C1', ts: '1700000000.000002', text: 'Finished.' },
    ]);
    expect(b.request.mock.calls.map(([request]) => new URL(request.url).pathname))
      .toEqual(['/api/conversations.info', '/api/chat.postMessage', '/api/conversations.info', '/api/chat.update',
        '/api/conversations.info', '/api/chat.update', '/api/conversations.info', '/api/chat.update']);
  });

  it('rejects arbitrary status content and foreign or contradictory destinations before a Slack write', async () => {
    const endpoint = { kind: 'shared', audience: 'shared', id: 'slack:T1:channel:C1' };
    const b = boundary();
    await expect(slackActions.updateSlackSessionStatus({ ...connection, endpoint, status: 'working', text: 'private Session text' }, b.context)).rejects.toThrow();
    expect(b.request).not.toHaveBeenCalled();
    for (const target of [{ ...endpoint, id: 'slack:T2:channel:C1' }, { ...endpoint, kind: 'direct', audience: 'direct' }]) {
      expect(await slackActions.updateSlackSessionStatus({ ...connection, endpoint: target, status: 'working' }, b.context))
        .toMatchObject({ kind: 'notDelivered', retry: 'never' });
    }
    expect(await slackActions.updateSlackSessionStatus({ ...connection, endpoint, status: 'working', providerMessageId: 'not-a-slack-ts' }, b.context))
      .toMatchObject({ kind: 'notDelivered', retry: 'never' });
    expect(b.effects).toEqual([]);
  });

  it('uses admitted connection identity for ordinary Actions and verifies identity on an explicit connection test', async () => {
    const b = boundary();
    const endpoint = { kind: 'shared', audience: 'shared', id: 'slack:T1:channel:C1' } as const;
    await expect(resolveSlackEndpoint({ ...connection, query: 'C1' }, b.context))
      .resolves.toMatchObject({ kind: 'resolved', candidates: [endpoint] });
    await expect(resolveSlackPrincipal({ ...connection, endpoint, query: 'U2' }, b.context))
      .resolves.toMatchObject({ kind: 'resolved', candidates: [{ id: 'slack:T1:user:U2' }] });
    await expect(deliverSlackMessage({ ...connection, endpoint, content: { text: 'hello' },
      deliveryKey: 'ordinary-identity-read', linkPreviewPolicy: 'suppress' }, b.context))
      .resolves.toEqual({ kind: 'delivered', providerMessageIds: ['1700000000.000002'] });
    const identityReads = () => b.request.mock.calls.filter(([request]) => /\/(auth\.test|bots\.info)$/.test(new URL(request.url).pathname)).length;
    expect(identityReads()).toBe(0);
    expect(await testSlackConnection({ ...connection, selectedTransport: 'socket' }, b.context)).toMatchObject({ kind: 'ready' });
    expect(identityReads()).toBe(2);
  });

  it('declares its provider name through the public Channels contribution contract', () => {
    assertConversationProviderContributionV1(PLUGIN_MANIFEST);
    expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions).toContainEqual(expect.objectContaining({
      target: { pluginId: 'happier.channels', pointId: 'providers' },
      descriptor: { v: 1, displayName: 'Slack' },
    }));
    expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions?.[0]?.operations).not.toHaveProperty('connectionStop');
    expect(PLUGIN_MANIFEST.contributes.actions?.some(action => action.id === 'slack/halt-socket')).toBe(false);
  });
  it('verifies both tokens through the shared hello proof and returns secret-free connection facts', async () => {
    const b = boundary();
    const result = ConversationProviderSetupResultV1Schema.parse(await setupSlackChannels({ credentialRef }, b.context));
    expect(result).toMatchObject({ credentialRef, providerConnectionKey: connection.providerConnectionKey,
      integrationPrincipal: { id: 'slack:T1:user:U1' }, supportedTransports: ['socket'], replayContinuity: 'sessionBound', providerConfig: identity });
    expect(JSON.stringify(result)).not.toContain('xapp-');
    expect(result.setupGuidance?.steps).toEqual([
      { title: expect.any(String), externalUrl: 'https://api.slack.com/apps' },
      { title: expect.any(String), externalUrl: expect.any(String) },
      { title: expect.any(String), externalUrl: expect.any(String), copyableValues: [{ label: expect.any(String), value: 'connections:write' }] },
      { title: expect.any(String), externalUrl: expect.any(String), copyableValues: [
        { label: expect.any(String), value: 'chat:write, files:read, users:read, channels:read, channels:history, groups:read, groups:history, im:read, im:history, mpim:read, mpim:history' },
        { label: expect.any(String), value: 'message.channels, message.groups, message.im, message.mpim' },
      ] },
      { title: expect.any(String) },
    ]);
    expect(b.materialize).toHaveBeenCalledWith('slack-credentials', { kind: 'environment', keys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] },
      { signal: b.context.signal, expectedAccount: credentialRef });
    expect(b.isClosed()).toBe(true);
  });
  it('rejects bot/app disagreement and foreign credential references before setup persists', async () => {
    await expect(setupSlackChannels({ credentialRef }, boundary({ foreignApp: true }).context)).rejects.toMatchObject({ code: 'slack_socket_invalidConfiguration' });
    const b = boundary();
    await expect(setupSlackChannels({ credentialRef: { ...credentialRef, service: { pluginId: 'other.plugin', localId: 'slack-bot' } } }, b.context))
      .rejects.toMatchObject({ code: 'slack_setup_credential_invalid' });
    expect(b.materialize).not.toHaveBeenCalled();
  });
  it('fails changed connection identity and unsupported transport without claiming readiness', async () => {
    expect(await testSlackConnection({ ...connection, selectedTransport: 'socket', providerConfig: { ...identity, appId: 'A2' } }, boundary().context))
      .toMatchObject({ kind: 'notReady', reason: 'invalidConfiguration' });
    const b = boundary();
    expect(await testSlackConnection({ ...connection, selectedTransport: 'checkpointedPull' }, b.context)).toMatchObject({ kind: 'notReady', reason: 'unsupported' });
    expect(b.materialize).not.toHaveBeenCalled();
  });
  it('resolves workspace-qualified shared, direct and thread topology', async () => {
    expect(await resolveSlackEndpoint({ ...connection, query: 'C1' }, boundary().context)).toMatchObject({ kind: 'resolved', candidates: [
      { kind: 'shared', audience: 'shared', id: 'slack:T1:channel:C1' }] });
    expect(await resolveSlackEndpoint({ ...connection, query: 'D1' }, boundary({ direct: true }).context)).toMatchObject({ kind: 'resolved', candidates: [
      { kind: 'direct', audience: 'direct', id: 'slack:T1:channel:D1' }] });
    expect(await resolveSlackEndpoint({ ...connection, query: 'slack:T1:channel:C1:thread:1700000000.000001' }, boundary().context)).toMatchObject({ kind: 'resolved', candidates: [
      { kind: 'thread', audience: 'shared', id: 'slack:T1:channel:C1:thread:1700000000.000001', parentId: 'slack:T1:channel:C1', label: 'deploys' }] });
  });
  it('resolves only exact authenticated same-workspace users, never display names or foreign IDs', async () => {
    const endpoint = { kind: 'shared', audience: 'shared', id: 'slack:T1:channel:C1' };
    expect(await resolveSlackPrincipal({ ...connection, endpoint, query: 'U2' }, boundary().context)).toMatchObject({ kind: 'resolved', candidates: [{ id: 'slack:T1:user:U2', label: 'Alice' }] });
    expect(await resolveSlackPrincipal({ ...connection, endpoint, query: 'U2' }, boundary({ foreignUser: true }).context)).toMatchObject({ kind: 'resolved', candidates: [] });
    expect(await resolveSlackPrincipal({ ...connection, endpoint, query: 'Alice' }, boundary().context)).toMatchObject({ kind: 'resolved', candidates: [] });
    expect(await resolveSlackPrincipal({ ...connection, endpoint: { ...endpoint, id: 'slack:T2:channel:C1' }, query: 'U2' }, boundary().context))
      .toMatchObject({ kind: 'notReady', reason: 'invalidConfiguration' });
  });
  it('revalidates destination topology and refuses contradictory thread routes before any post', async () => {
    const input = { ...connection, endpoint: { kind: 'thread', audience: 'shared', id: 'slack:T1:channel:C1:thread:1700000000.000001', parentId: 'slack:T1:channel:C1' },
      content: { text: 'hello' }, deliveryKey: 'delivery-1',  linkPreviewPolicy: 'suppress' };
    const good = boundary();
    expect(await deliverSlackMessage(input, good.context)).toEqual({ kind: 'delivered', providerMessageIds: ['1700000000.000002'] });
    expect(good.effects).toMatchObject([{ channel: 'C1', thread_ts: '1700000000.000001', text: 'hello' }]);
    for (const [request, b] of [[input, boundary({ foreignChannel: true })], [{ ...input, replyContext: { threadId: '1700000000.999999' } }, boundary()]] as const) {
      expect(await deliverSlackMessage(request, b.context)).toMatchObject({ kind: 'notDelivered', retry: 'never' });
      expect(b.effects).toEqual([]);
    }
  });
});

it.each([
  ['T2', 'C1', '1700000000.000001', 'F1'],
  ['T1', 'C1', 'different-message', 'F1'],
])('refuses an attachment reference outside its admitted workspace/message: %j', async (...parts) => {
  const b = boundary();
  const result = await fetchSlackAttachments({ ...connection, messageId: '1700000000.000001',
    attachmentIds: [createConversationAttachmentIdV1('slack', parts)] }, b.context);
  expect(result).toMatchObject({ kind: 'notReady', reason: 'unsupported' });
  expect(b.request).not.toHaveBeenCalled();
});
