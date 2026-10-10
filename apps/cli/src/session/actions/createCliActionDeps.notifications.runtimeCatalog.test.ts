import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import {
  createActionExecutor, createWorkflowAccountRunActionOwner,
  normalizeActionsSettingsV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1, validateWorkflowDefinition,
  type ActionExecutorDeps,
} from '@happier-dev/protocol';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineRpcHandlers } from '@/api/machine/rpcHandlers';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';

const boundary = vi.hoisted(() => ({ send: vi.fn(), get: vi.fn() }));
// Expo and HTTP are genuine outward boundaries; the notification policy and
// Action host composition stay real.
vi.mock('expo-server-sdk', () => ({ Expo: class {
  chunkPushNotifications(messages: unknown[]) { return [messages]; }
  sendPushNotificationsAsync(messages: unknown[]) { return boundary.send(messages); }
  static isExpoPushToken() { return true; }
} }));
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: boundary.get } };
});

import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { bindAutomationWorkflowInputs } from '@/daemon/workflows/input';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { notificationSettingsFixture as accountSettingsParse, notificationCatalogFixture } from '@/notifications/activity/activityNotification.testkit';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';

function hostParams(settings = accountSettingsParse({}), workflowAction?: ActionExecutorDeps['workflowAction']) {
  if (getActiveAccountSettingsSnapshot()?.settings !== settings) {
    // This suite begins with an admitted Account row, not a Settings root
    // manufacturing membership at dispatch time.
    setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey({ token: 'account-token', encryption: null }),
      notificationChannelCatalog: notificationCatalogFixture(settings).notificationChannelCatalog });
  }
  return {
    token: 'account-token', credentials: { token: 'account-token', encryption: null },
    sessionId: 'session-1', mode: 'plain' as const, ctx: null,
    actionsSettingsProvider: { getAccountSettings: () => settings,
      getActionsSettings: () => normalizeActionsSettingsV1(settings.actionsSettingsV1) },
    ...(workflowAction ? { workflowAction } : {}),
  };
}

function host(settings = accountSettingsParse({}), workflowAction?: ActionExecutorDeps['workflowAction']) {
  return createCliActionDeps(hostParams(settings, workflowAction));
}

describe('CLI Notify me host composition', () => {
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    vi.clearAllMocks();
    boundary.send.mockResolvedValue([{ status: 'ok', id: 'push-ticket' }]);
    boundary.get.mockImplementation(async (url: string) => ({ status: 200,
      data: new URL(url).pathname.startsWith('/v2/sessions/') ? { session: createSessionNotificationContextFixture('session-1') }
        : url.endsWith('/v1/push-tokens')
          ? { tokens: [{ id: 'device-1', token: 'ExponentPushToken[test]', createdAt: 1, updatedAt: 1 }] }
          : { badgeCount: 0 } }));
  });

  it('refuses unavailable channel discovery and Notify me without substituting registered push', async () => {
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {}, settingsVersion: 4,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey({ token: 'account-token', encryption: null }),
      notificationChannelCatalog: { status: 'unavailable', reason: 'invalid-stored-content' } });
    const deps = host(settings);
    await expect(deps.notificationChannelsList?.({ surface: 'cli' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'notification_channel_catalog_unavailable' });
    await expect(deps.notificationsNotifyMe?.({ message: 'ready', channels: ['builtin:expo_push'] }, { surface: 'cli' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'notification_channel_catalog_unavailable' });
    await expect(createActionExecutor(deps).execute('action.options.resolve', {
      actionId: 'notifications.notify_me', fieldPath: 'channels',
    }, { surface: 'cli' })).resolves.toMatchObject({ ok: false, errorCode: 'notification_channel_catalog_unavailable',
      details: { reason: 'invalid-stored-content' } });
    expect(boundary.send).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()?.notificationChannelCatalog).toMatchObject({ status: 'unavailable' });
  });

  it('never borrows daemon notification channels for an unavailable finite requester catalog', async () => {
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {}, settingsVersion: 4,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey({ token: 'daemon-token', encryption: null }),
      notificationChannelCatalog: { status: 'ready', revision: 9, diagnostics: [], channels: [
        NotificationChannelRecordV1Schema.parse({ v: 1, id: 'builtin:expo_push', kind: 'expo_push', topics: {} }),
      ] } });
    const credentials = { token: 'account-token', encryption: null };
    const requesterHome = 'https://requester-home.example';
    const operationContext = runWithServerHttpBaseUrl(requesterHome, () => createInvocationSavedSecretOperationContextV1({ credentials,
      snapshot: { settings, source: 'network', rawSettings: {}, settingsVersion: 2, loadedAtMs: 1,
        settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
        notificationChannelCatalog: { status: 'unavailable', reason: 'forbidden' } },
      serverHttpBaseUrl: requesterHome, isCurrent: async () => true }));
    const deps = createCliActionDeps({ ...hostParams(settings), savedSecretOperationContext: operationContext });
    await expect(deps.notificationChannelsList?.({ surface: 'cli' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'notification_channel_catalog_unavailable', details: { reason: 'forbidden' } });
    await expect(deps.notificationsNotifyMe?.({ message: 'ready', channels: ['builtin:expo_push'] }, { surface: 'cli' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'notification_channel_catalog_unavailable', details: { reason: 'forbidden' } });
    expect(boundary.send).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()?.notificationChannelCatalog).toMatchObject({ status: 'ready', revision: 9 });
    expect(operationContext.readSnapshot()?.notificationChannelCatalog).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
  });

  it('returns the canonical Action failure when a loading finite catalog cannot admit Account material', async () => {
    const settings = accountSettingsParse({});
    const credentials = { token: 'account-token', encryption: null };
    const requesterHome = 'https://requester-material-home.example';
    const operationContext = runWithServerHttpBaseUrl(requesterHome, () => createInvocationSavedSecretOperationContextV1({ credentials,
      snapshot: { settings, source: 'network', rawSettings: {}, settingsVersion: 2, loadedAtMs: 1,
        settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
        notificationChannelCatalog: { status: 'loading' } },
      serverHttpBaseUrl: requesterHome, isCurrent: async () => true }));
    boundary.get.mockImplementation(async (url: string) => {
      expect(url).toBe(`${requesterHome}/v1/account/encryption/currentness`);
      return { status: 503, data: {} };
    });
    const deps = createCliActionDeps({ ...hostParams(settings), savedSecretOperationContext: operationContext });
    await expect(createActionExecutor(deps).execute('action.options.resolve', {
      actionId: 'notifications.notify_me', fieldPath: 'channels',
    }, { surface: 'cli' })).resolves.toMatchObject({ ok: false, errorCode: 'notification_channel_catalog_unavailable',
      details: { reason: 'encryption-material-unavailable' } });
    expect(boundary.send).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()?.notificationChannelCatalog).toMatchObject({ status: 'ready' });
  });

  it('refuses an uncaptured finite Home without publishing it as the global Account', async () => {
    const settings = accountSettingsParse({});
    const deps = createCliActionDeps({ token: 'account-token', credentials: { token: 'account-token', encryption: null },
      sessionId: 'session-1', mode: 'plain', ctx: null,
      serverHttpBaseUrl: 'https://uncaptured-requester-home.example', serverId: 'uncaptured-home',
      actionsSettingsProvider: { getAccountSettings: () => settings,
        getActionsSettings: () => normalizeActionsSettingsV1(settings.actionsSettingsV1) } });
    const result = await deps.notificationChannelsList?.({ surface: 'cli' }).catch((error: unknown) => error);
    // Admission precedes Settings transport; the response schema is irrelevant
    // when no captured Account exists for the requested Home.
    expect(boundary.get).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, errorCode: 'notification_channel_catalog_unavailable', details: { reason: 'scope-retired' } });
    expect(boundary.send).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()).toBeNull();
  });

  it('delivers a retained Workflow channel identity to the destination webhook after settings root removal', async () => {
    const observed: { body: Buffer; signature: string | undefined }[] = [];
    const receiver = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const signature = request.headers['x-happier-signature-256'];
      observed.push({ body: Buffer.concat(chunks), signature: typeof signature === 'string' ? signature : undefined });
      response.writeHead(202); response.end();
    });
    receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
    try {
      const address = receiver.address();
      if (!address || typeof address === 'string') throw new Error('Loopback receiver unavailable');
      const channelId = 'webhook:retained-workflow';
      const resourceId = 'retained-workflow-signing';
      const signingBytes = ' retained-signing-bytes\n';
      const definition = validateWorkflowDefinition({ version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
        inputs: [{ name: 'notificationChannels', valueType: 'json', required: false, default: [channelId] }], blocks: ['work'],
      }).normalizedDefinition;
      if (!definition) throw new Error('Workflow fixture invalid');
      // JSON persistence and the incumbent input binder retain the author-selected id.
      const reopened = validateWorkflowDefinition(JSON.parse(JSON.stringify(definition))).normalizedDefinition;
      if (!reopened) throw new Error('Retained Workflow cannot reopen');
      const channels = bindAutomationWorkflowInputs({ definition: reopened, evidence: {} }).notificationChannels;
      if (!Array.isArray(channels) || !channels.every((id): id is string => typeof id === 'string')) throw new Error('Invalid channel selection');
      const settings = accountSettingsParse({ attentionDeliveryPolicyV1: { v: 1, channels: { webhook: { enabled: true } },
        privacy: { defaultPreviewBehavior: 'status_only' } } });
      setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, settingsVersion: 4, loadedAtMs: 1,
        settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey({ token: 'account-token', encryption: null }),
        notificationChannelCatalog: { status: 'ready', revision: 8, diagnostics: [], channels: [NotificationChannelRecordV1Schema.parse({
          v: 1, kind: 'webhook', id: channelId, topics: {}, url: `http://127.0.0.1:${address.port}/notifications`,
          signingSecretRef: `happier:shared-secret:v1:${resourceId}`,
        })] }, savedSecretCatalogState: 'ready', savedSecretResources: [{ resourceId, ownerAccountId: 'account',
          displayName: 'Signing', kind: 'other', revision: 2, encryptionMode: 'plain', materialStatus: 'ready',
          storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
            content: { v: 1, name: 'Signing', kind: 'other', value: signingBytes } }) }] });
      const deps = host(settings);
      await expect(deps.notificationChannelsList?.({ surface: 'cli' }))
        .resolves.toEqual({ items: [{ value: channelId, label: channelId, disabled: false }] });
      await expect(deps.notificationsNotifyMe?.({ message: 'Private Workflow content', channels }, { surface: 'cli' }))
        .resolves.toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
      expect(observed).toHaveLength(1);
      expect(JSON.parse(observed[0]!.body.toString('utf8'))).toMatchObject({ channelId, topic: 'notify_me', content: { body: '' } });
      expect(observed[0]!.signature).toBe(`sha256=${createHmac('sha256', signingBytes).update(observed[0]!.body).digest('hex')}`);
      expect(observed[0]!.body.toString('utf8')).not.toContain('Private Workflow content');
      expect(boundary.send).not.toHaveBeenCalled();
    } finally { await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve())); }
  });

  it('dispatches through policy and suppresses a replay with the same Action request id', async () => {
    const deps = host();
    const input = { message: 'Deployment ready', title: 'Deploy', channels: ['builtin:expo_push'] };
    const context = { surface: 'cli' as const, actionRequestId: 'notification-host-replay-1' };
    await expect(deps.notificationsNotifyMe?.(input, context)).resolves.toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    await expect(deps.notificationsNotifyMe?.(input, context)).resolves.toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(boundary.send.mock.calls[0]?.[0]).toMatchObject([{ title: 'Deploy', body: 'Deployment ready' }]);
    expect(boundary.send).toHaveBeenCalledTimes(1);
  });

  it('runs authenticated Session notifications through agent policy and refuses non-Account placement', async () => {
    const sessionHome = { serverId: 'home', serverHttpBaseUrl: resolveServerHttpBaseUrl(), token: 'account-token' };
    const execute = createDaemonSessionAccountActionExecutor({ ...sessionHome,
      createExecutor: () => createCliActionExecutor(hostParams(accountSettingsParse({ actionsSettingsV1: {
        v: 1, actions: { 'notifications.notify_me': { disabledSurfaces: ['agent'] } },
      } }))) });
    const authority = { sessionId: 'session-1', isCurrent: async () => true };
    const witness = { turnId: 'turn-1', inputId: 'input-1', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
      agentStartCaller: { kind: 'session' as const, sessionId: 'session-1', starterDepth: 0, turnDepth: 0 } };
    await expect(execute({ kind: 'action.execute', requestId: 'session-notify',
      actionId: 'notifications.notify_me', input: { message: 'ready', channels: ['builtin:expo_push'] }, witness }, authority))
      .resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
    await expect(execute({ kind: 'action.execute', requestId: 'foreign-placement',
      actionId: 'session.message.send', input: { text: 'hello' }, witness }, authority))
      .resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(boundary.send).not.toHaveBeenCalled();
    const allowed = createDaemonSessionAccountActionExecutor({ ...sessionHome,
      createExecutor: () => createCliActionExecutor(hostParams()) });
    await expect(allowed({ kind: 'action.execute', requestId: 'session-notify-allowed',
      actionId: 'notifications.notify_me', input: { message: 'ready', channels: ['builtin:expo_push'] }, witness }, authority))
      .resolves.toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
    await expect(allowed({ kind: 'action.execute', requestId: 'missing-depth',
      actionId: 'workflow.trigger.add', input: {}, witness: { turnId: 'turn-1', inputId: 'input-1', userMessageSeq: 1, userMessageSeqs: [1] } }, authority))
      .resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    await expect(allowed({ kind: 'action.execute', requestId: 'stale-session',
      actionId: 'notifications.notify_me', input: { message: 'ready' }, witness },
      { ...authority, isCurrent: async () => false }))
      .resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(boundary.send).toHaveBeenCalledTimes(1);
  });

  it('composes a workflow leaf default link and deduplicates its replay through the real Run owner', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const definition = validateWorkflowDefinition({ version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
      blocks: ['work'],
    }).normalizedDefinition!;
    const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine-a', origin: { kind: 'direct' },
      acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
        acceptedSnapshot: { definition, startedBy: 'user', authoredDefinition: definition,
          materializedLeaves: [], frozenChildren: {}, metadata: null, workDepth: 0,
          source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: null },
          inputs: {}, machineId: 'machine-a', executionTarget: { kind: 'session' },
          workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
          origin: { kind: 'direct', originSessionId: 'origin-1' },
          authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
        },
      })),
    });
    const runOwner = createWorkflowAccountRunActionOwner({
      resolveAccountId: async () => 'account-1', storage,
      // Artifact storage is an unused boundary for a retained Run read.
      definitions: { get: async () => { throw new Error('must_not_read_mutable_definition'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: (directory) => directory.startsWith('/') ? directory : null,
      randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
    });
    const executor = createActionExecutor(host(accountSettingsParse({}), async (args) => {
      if (args.actionId !== 'workflow.run.get') throw new Error('unexpected_workflow_operation');
      return await runOwner.execute(args);
    }));
    const input = { message: 'Panel finished', title: 'Review', channels: ['builtin:expo_push'] };
    const context = { surface: 'agent' as const, actionRequestId: 'notification-workflow-replay-1',
      actionCaller: { kind: 'workflowRun' as const, runId, authorization: {
        principal: { kind: 'host' as const }, admittedPermissionCeiling: 'read-only' as const,
      } } };
    await expect(executor.execute('notifications.notify_me', input, context))
      .resolves.toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
    await expect(executor.execute('notifications.notify_me', input, context))
      .resolves.toEqual({ ok: true, result: { attemptedChannels: 0, deliveredChannels: 0 } });
    expect(boundary.send.mock.calls[0]?.[0]).toMatchObject([{ title: 'Review', body: 'Panel finished', data: { runId } }]);
    expect(boundary.send).toHaveBeenCalledTimes(1);
  });

  it('lists configured channels and ignores a channel removed since authoring', async () => {
    const deps = host(accountSettingsParse({ attentionDeliveryPolicyV1: {
      v: 1, channels: { expo_push: { enabled: false }, webhook: { enabled: true } },
    }, notificationChannelsV1: [
      { kind: 'webhook', id: 'webhook:deploy', url: 'https://example.test/notify' },
    ] }));
    await expect(deps.notificationChannelsList?.({ surface: 'cli' })).resolves.toEqual({ items: [
      // Row membership cannot override the explicit finite push policy.
      { value: 'builtin:expo_push', label: 'Push notifications', disabled: true },
      { value: 'webhook:deploy', label: 'webhook:deploy', disabled: false },
    ] });
    await expect(deps.notificationsNotifyMe?.({ message: 'ready', channels: ['removed'] }, { surface: 'cli' })).resolves.toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(boundary.send).not.toHaveBeenCalled();
  });

  it('refuses an inaccessible session link before sending any notification', async () => {
    boundary.get.mockResolvedValue({ status: 404, data: { error: 'session_not_found' } });
    await expect(host().notificationsNotifyMe?.({ message: 'ready', open: { kind: 'session', sessionId: 'invisible-session' } },
      { surface: 'cli' })).resolves.toMatchObject({ ok: false, errorCode: 'session_not_found' });
    expect(boundary.send).not.toHaveBeenCalled();
  });

  it('reaches delivery and channel options through the canonical machine RPC registrar', async () => {
    const manager = new RpcHandlerManager({ scopePrefix: 'notification-machine', encryptionMode: 'plain' });
    registerMachineRpcHandlers({ rpcHandlerManager: manager,
      handlers: { spawnSession: async () => ({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'unused' }),
        stopSession: async () => true, requestShutdown: () => {} },
      deps: { currentMachineId: 'notification-machine', externalAction: {
        machineId: 'notification-machine', currentServerId: 'notification-home',
        resolveAccountId: async () => 'notification-account',
        resolveTarget: async () => ({ kind: 'machine', machineId: 'notification-machine' }),
        executor: createActionExecutor(host()),
      } },
    });
    await expect(manager.invokeLocal('notifications.notify_me', { message: 'RPC ready', title: 'Ready', channels: ['builtin:expo_push'] }))
      .resolves.toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    await expect(manager.invokeLocal('action.options.resolve', { actionId: 'notifications.notify_me', fieldPath: 'channels' }))
      .resolves.toMatchObject({ options: [{ value: 'builtin:expo_push', label: 'Push notifications' }] });
    expect(boundary.send.mock.calls[0]?.[0]).toMatchObject([{ title: 'Ready', body: 'RPC ready' }]);
  });
});
