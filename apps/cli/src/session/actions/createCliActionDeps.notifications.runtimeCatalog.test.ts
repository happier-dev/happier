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
import { normalizeWorkflowActionThrownError } from './workflowActionExecutor';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { commitActiveNotificationChannelCatalog, commitActiveSavedSecretCatalog, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { publishServerHttpRuntimeOrigin, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { bindAutomationWorkflowInputs } from '@/daemon/workflows/input';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { notificationSettingsFixture as accountSettingsParse, notificationCatalogFixture } from '@/notifications/activity/activityNotification.testkit';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { configuration } from '@/configuration';
import * as persistenceBoundary from '@/persistence';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { recordPresentUserApprovalV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import type { ActionExecutorContext, ActionId } from '@happier-dev/protocol';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';

function confirmedAccountInvocation(actionId: ActionId, input: unknown, accountId = 'account', machineId = 'notification-machine', directory?: string): ActionExecutorContext {
  const requestId = crypto.randomUUID();
  const target = { kind: 'machine' as const, machineId, ...(directory ? { project: { machineId, directory } } : {}) };
  const review = recordPresentUserApprovalV1({ actionId, input, requestId, requestSurface: 'ui', decidingAccountId: accountId });
  return { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: accountId,
    serverId: 'notification-home', serverIdentityId: 'notification-home', actionRequestId: requestId, externalActionTarget: target,
    // This fixture starts at the receiving host with the Home's private admission carrier.
    externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted',
      binding: { accountId, custodianAccountId: accountId, authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'plain', serverIdentityId: 'notification-home', actionId, requestId,
        machineId, installationId: 'notification-installation', target, requestEnvelopeDigest: 'a'.repeat(43) } }),
    presentUserConfirmation: { actionId, requestId, accountId, serverId: 'notification-home', target, inputDigest: review.inputDigest },
  };
}

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
      data: new URL(url).pathname.startsWith('/v2/sessions/') ? { session: {
        ...createSessionNotificationContextFixture('session-1'), encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata()),
      } }
        : url.endsWith('/v1/account/encryption/currentness') ? createAccountEncryptionCurrentnessFixture()
        : url.endsWith('/v1/push-tokens')
          ? { tokens: [{ id: 'device-1', token: 'ExponentPushToken[test]', createdAt: 1, updatedAt: 1 }] }
          : { badgeCount: 0 } }));
  });

  it('reports an explicit Notify failure when every attempted delivery fails', async () => {
    boundary.send.mockResolvedValue([{ status: 'error', message: 'PRIVATE_PROVIDER_BODY', details: { error: 'DeviceNotRegistered' } }]);
    const result = await host().notificationsNotifyMe?.({ message: 'PRIVATE_MESSAGE', channels: ['builtin:expo_push'] }, { surface: 'cli' });
    expect(result).toMatchObject({ ok: false, errorCode: 'notification_delivery_unavailable',
      details: { attemptedChannels: 1, deliveredChannels: 0 } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  it('requires private requester custody before a signed notification can use daemon destinations', async () => {
    const params = hostParams();
    const operations = createHostActionOperationRuntime({ machineId: 'notification-machine', resolveAccountId: async () => 'account' });
    const executor = createCliActionExecutorHarness(params, { runActionOperation: operations.runActionOperation }).executor;
    const input = { message: 'Ready', channels: ['builtin:expo_push'] };
    await expect(executor.execute('notifications.notify_me', input, { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'notifications.notify_me' } }))
      .resolves.toMatchObject({ ok: true, result: { deliveredChannels: 1 } });
    boundary.get.mockClear();
    boundary.send.mockClear();
    await expect(executor.execute('notifications.notify_me', { ...input, open: { kind: 'session', sessionId: 'session-1' } },
      confirmedAccountInvocation('notifications.notify_me', { ...input, open: { kind: 'session', sessionId: 'session-1' } })))
      .resolves.toMatchObject({ ok: false, errorCode: 'client_required' });
    expect(boundary.get).not.toHaveBeenCalled();
    expect(boundary.send).not.toHaveBeenCalled();
  });

  it('uses admitted requester custody for channel discovery, Session links and push delivery', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    const params = hostParams();
    const home = 'https://notification-requester.test';
    const credentials = { token: 'requester-notification-token', encryption: null };
    const originalGet = boundary.get.getMockImplementation()!;
    boundary.get.mockImplementation(async (url: string, options: unknown) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'requester' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      return originalGet(url, options);
    });
    const input = { message: 'Ready', channels: ['builtin:expo_push'], open: { kind: 'session' as const, sessionId: 'session-1' } };
    const context = confirmedAccountInvocation('notifications.notify_me', input, 'requester');
    const custody = await admitRequesterAccountActionContext({ authorization: context.externalActionExecutionAuthorization!,
      credentials, serverId: 'notification-home', serverIdentityId: 'notification-home', serverHttpBaseUrl: home,
      isCurrent: async () => true });
    try {
      expect(custody).not.toBeNull();
      const operation = custody!.savedSecretOperationContext;
      expect(await operation.commitNotificationChannelCatalog({ expectedSettingsVersion: 1,
        catalog: notificationCatalogFixture(accountSettingsParse({})).notificationChannelCatalog })).toBe(true);
      boundary.get.mockClear();
      const deps = createCliActionDeps(params);
      const requesterContext = { ...context, externalActionExecutionAuthorization: custody!.authorization };
      await expect(deps.notificationChannelsList?.(requesterContext)).resolves.toMatchObject({ items: [{ value: 'builtin:expo_push' }] });
      await expect(deps.notificationsNotifyMe?.(input, requesterContext))
        .resolves.toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
      const reads = boundary.get.mock.calls.filter(([url]) => String(url).startsWith(home));
      expect(reads.some(([url]) => String(url).includes('/v2/sessions/'))).toBe(true);
      expect(reads.some(([url]) => String(url).endsWith('/v1/push-tokens'))).toBe(true);
      expect(reads.every(([, options]) => options.headers.Authorization === `Bearer ${credentials.token}`)).toBe(true);
      expect(boundary.get.mock.calls.every(([url]) => String(url).startsWith(home))).toBe(true);
      expect(boundary.send).toHaveBeenCalled();
    } finally { await custody?.dispose(); await channel.close(); }
  });

  it.each(['ordinary', 'native-confirmed'] as const)('tests one configured webhook with its real signature, reports refusal, and retries only when invoked again (%s)', async admission => {
    const channel = admission === 'native-confirmed' ? await createRequesterCurrentnessSocketHarness() : null;
    let custody: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
    const observed: { body: Buffer; signature: string | undefined }[] = [];
    const receiver = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const signature = request.headers['x-happier-signature-256'];
      observed.push({ body: Buffer.concat(chunks), signature: typeof signature === 'string' ? signature : undefined });
      response.writeHead(observed.length === 1 ? 503 : 204); response.end();
    });
    receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
    try {
      const address = receiver.address();
      if (!address || typeof address === 'string') throw new Error('Loopback receiver unavailable');
      const settings = accountSettingsParse({});
      hostParams(settings);
      const snapshot = getActiveAccountSettingsSnapshot();
      if (!snapshot?.scopeKey) throw new Error('Missing admitted snapshot');
      const incumbent = { scopeKey: snapshot.scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
      const secret = ' byte-exact webhook test signing\n';
      expect(commitActiveNotificationChannelCatalog({ ...incumbent,
        catalog: { status: 'ready', revision: 8, diagnostics: [], channels: [NotificationChannelRecordV1Schema.parse({
          v: 1, kind: 'webhook', id: 'test-channel', enabled: false, topics: {},
          url: `http://127.0.0.1:${address.port}/test`, signingSecretRef: 'happier:shared-secret:v1:test-signing',
        })] } })).toBe(true);
      expect(commitActiveSavedSecretCatalog({ ...incumbent, state: 'ready', resources: [{ resourceId: 'test-signing', ownerAccountId: 'account',
          displayName: 'Signing', kind: 'other', revision: 1, encryptionMode: 'plain', materialStatus: 'ready',
          storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'test-signing', mode: 'plain',
            content: { v: 1, name: 'Signing', kind: 'other', value: secret } }) }] })).toBe(true);
      const home = resolveServerHttpBaseUrl();
      let signingAvailable = true;
      const materials = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId: 'test-signing',
        encryptionMode: 'plain', recipientEnvelope: null,
        entry: { ref: 'happier:shared-secret:v1:test-signing', source: 'shared_resource', relationship: 'owner',
          ownerAccountId: 'account', name: 'Signing', kind: 'other', revision: 1, materialStatus: 'ready',
          capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'test-signing', mode: 'plain',
          content: { v: 1, name: 'Signing', kind: 'other', value: secret } }) }] });
      // Account material hydration is a real HTTP boundary; the sender still uses the actual loopback socket.
      boundary.get.mockImplementation(async (url: string) => {
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account' } };
        if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        expect(url).toBe(`${home}/v1/account/saved-secrets/resources/materials`);
        return { status: 200, data: { resources: signingAvailable ? materials.resources : [] } };
      });
      const admittedSnapshot = getActiveAccountSettingsSnapshot();
      if (!admittedSnapshot) throw new Error('Missing configured snapshot');
      const operation = createInvocationSavedSecretOperationContextV1({ credentials: { token: 'account-token', encryption: null },
        snapshot: admittedSnapshot, serverHttpBaseUrl: home, isCurrent: async () => true });
      const operations = createHostActionOperationRuntime({ machineId: 'notification-machine', resolveAccountId: async () => 'account' });
      const params = { ...hostParams(settings), savedSecretOperationContext: operation };
      const executor = admission === 'native-confirmed'
        ? createCliActionExecutorHarness(params, { runActionOperation: operations.runActionOperation }).executor
        : createActionExecutor(createCliActionDeps(params));
      const actionId = 'notifications.webhooks.test';
      const context = { surface: 'cli' as const, actionsSettings: normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { [actionId]: ['cli'] } }) };
      const send = async (channelId: string) => {
        if (admission !== 'native-confirmed') return executor.execute(actionId, { channelId }, context);
        await custody?.dispose();
        const confirmed = confirmedAccountInvocation(actionId, { channelId });
        custody = await admitRequesterAccountActionContext({ authorization: confirmed.externalActionExecutionAuthorization!,
          credentials: operation.credentials, serverId: 'notification-home', serverIdentityId: 'notification-home',
          serverHttpBaseUrl: home, isCurrent: async () => true });
        expect(custody).not.toBeNull();
        expect(await custody!.savedSecretOperationContext.commitNotificationChannelCatalog({ expectedSettingsVersion: 1,
          catalog: admittedSnapshot!.notificationChannelCatalog! })).toBe(true);
        return executor.execute(actionId, { channelId }, { ...confirmed, externalActionExecutionAuthorization: custody!.authorization });
      };
      await expect(send('test-channel'))
        .resolves.toEqual({ ok: true, result: { status: 'refused', reason: 'http_rejected', httpStatus: 503 } });
      expect(observed).toHaveLength(1);
      await expect(send('test-channel'))
        .resolves.toEqual({ ok: true, result: { status: 'delivered' } });
      expect(observed).toHaveLength(2);
      for (const request of observed) {
        expect(request.signature).toBe(`sha256=${createHmac('sha256', secret).update(request.body).digest('hex')}`);
        const payload = JSON.parse(request.body.toString());
        expect(payload).toMatchObject({ channelId: 'test-channel', topic: 'notify_me' });
        expect(payload.session).toBeUndefined();
        expect(request.body.toString()).not.toContain(secret);
      }
      await expect(send('missing'))
        .resolves.toEqual({ ok: true, result: { status: 'refused', reason: 'channel_not_found' } });
      expect(observed).toHaveLength(2);
      expect(boundary.send).not.toHaveBeenCalled();
      signingAvailable = false;
      await expect(send('test-channel'))
        .resolves.toEqual({ ok: true, result: { status: 'refused', reason: 'signing_secret_unavailable' } });
      expect(observed).toHaveLength(2);
      signingAvailable = true;
      receiver.close(); await once(receiver, 'close');
      await expect(send('test-channel'))
        .resolves.toEqual({ ok: true, result: { status: 'unreachable', reason: 'ECONNREFUSED' } });
      expect(observed).toHaveLength(2);
    } finally {
      await custody?.dispose();
      await channel?.close();
      if (receiver.listening) { receiver.close(); await once(receiver, 'close'); }
    }
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
    await expect(deps.notificationConfigurationAction?.({ actionId: 'notifications.webhooks.test', input: { channelId: 'daemon-only' },
      context: { surface: 'cli' } })).resolves.toEqual({ status: 'refused', reason: 'catalog_unavailable' });
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
      // A malformed currentness answer is not a retryable Home outage: the Account material is not admitted.
      return { status: 200, data: {} };
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
    const storedCredentials = vi.spyOn(persistenceBoundary, 'readStoredCredentials')
      .mockResolvedValue({ token: 'account-token', encryption: null });
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
      const materials = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId,
        encryptionMode: 'plain', recipientEnvelope: null,
        entry: { ref: `happier:shared-secret:v1:${resourceId}`, source: 'shared_resource', relationship: 'owner',
          ownerAccountId: 'account', name: 'Signing', kind: 'other', revision: 2, materialStatus: 'ready',
          capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
          content: { v: 1, name: 'Signing', kind: 'other', value: signingBytes } }) }] });
      boundary.get.mockImplementation(async (url: string) => {
        expect(url).toBe(`${resolveServerHttpBaseUrl()}/v1/account/saved-secrets/resources/materials`);
        return { status: 200, data: materials };
      });
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
    } finally {
      storedCredentials.mockRestore();
      await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
    }
  });

  it('dispatches through policy and suppresses a replay with the same Action request id', async () => {
    const release = publishServerHttpRuntimeOrigin('http://127.0.0.1:48189', 'iroh');
    try {
    const deps = host();
    await expect(deps.notificationChannelsList?.({ surface: 'cli' })).resolves.toMatchObject({ items: [
      { value: 'builtin:expo_push', disabled: false },
    ] });
    const input = { message: 'Deployment ready', title: 'Deploy', channels: ['builtin:expo_push'] };
    const context = { surface: 'cli' as const, actionRequestId: 'notification-host-replay-1' };
    await expect(deps.notificationsNotifyMe?.(input, context)).resolves.toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    await expect(deps.notificationsNotifyMe?.(input, context)).resolves.toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(boundary.send.mock.calls[0]?.[0]).toMatchObject([{ title: 'Deploy', body: 'Deployment ready' }]);
    expect(boundary.send.mock.calls[0]?.[0]).toMatchObject([{ data: { serverUrl: configuration.serverUrl } }]);
    expect(boundary.send).toHaveBeenCalledTimes(1);
    const tokenReads = boundary.get.mock.calls.filter(([url]) => String(url).endsWith('/v1/push-tokens'));
    expect(tokenReads.length).toBeGreaterThan(0);
    expect(tokenReads.every(([url]) => url === 'http://127.0.0.1:48189/v1/push-tokens')).toBe(true);
    } finally { release(); }
  });

  it('runs authenticated Session notifications through agent policy and refuses non-Account placement', async () => {
    const sessionId = 'c000000000000000000000001';
    const get = boundary.get.getMockImplementation()!;
    boundary.get.mockImplementation(async (url: string) => new URL(url).pathname === `/v2/sessions/${sessionId}`
      ? { status: 200, data: { session: { ...createSessionNotificationContextFixture(sessionId),
        encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata()) } } } : get(url));
    const sessionHome = { serverId: 'home', serverHttpBaseUrl: resolveServerHttpBaseUrl(), token: 'account-token' };
    const execute = createDaemonSessionAccountActionExecutor({ ...sessionHome,
      createExecutor: () => createCliActionExecutor({ ...hostParams(accountSettingsParse({ actionsSettingsV1: {
        v: 1, actions: { 'notifications.notify_me': { disabledSurfaces: ['agent'] } },
      } })), sessionId }) });
    const authority = { sessionId, isCurrent: async () => true };
    const witness = { turnId: 'turn-1', inputId: 'input-1', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
      agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
    await expect(execute({ kind: 'action.execute', requestId: 'session-notify',
      actionId: 'notifications.notify_me', input: { message: 'ready', channels: ['builtin:expo_push'] }, witness }, authority))
      .resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
    await expect(execute({ kind: 'action.execute', requestId: 'foreign-placement',
      actionId: 'session.message.send', input: { sessionId, message: 'hello' }, witness }, authority))
      .resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(boundary.send).not.toHaveBeenCalled();
    const allowed = createDaemonSessionAccountActionExecutor({ ...sessionHome,
      createExecutor: () => createCliActionExecutor({ ...hostParams(), sessionId }) });
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
    const workflowAction: NonNullable<ActionExecutorDeps['workflowAction']> = async (args) => {
      if (args.actionId !== 'workflow.run.get' && args.actionId !== 'workflow.run.start') throw new Error('unexpected_workflow_operation');
      try { return await runOwner.execute(args); }
      catch (error) { return normalizeWorkflowActionThrownError(error); }
    };
    const operations = createHostActionOperationRuntime({ machineId: 'machine-a', resolveAccountId: async () => 'account-1' });
    const startInput = { runId, source: { kind: 'saved' as const, definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } } };
    const { executor: confirmedExecutor } = createCliActionExecutorHarness(hostParams(accountSettingsParse({}), workflowAction),
      { runActionOperation: operations.runActionOperation });
    await expect(confirmedExecutor.execute('workflow.run.start', startInput,
      confirmedAccountInvocation('workflow.run.start', startInput, 'account-1', 'machine-a', '/repo')))
      .resolves.toMatchObject({ ok: true, result: { admission: 'existing', run: { id: runId } } });
    const deps = host(accountSettingsParse({}), workflowAction);
    const executor = createActionExecutor(deps);
    const input = { message: 'Panel finished', title: 'Review', channels: ['builtin:expo_push'],
      open: { kind: 'workflow_run' as const, runId } };
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
    await expect(deps.notificationsNotifyMe?.(input, { surface: 'cli',
      externalActionTarget: { kind: 'machine', machineId: 'another-machine' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
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
        resolveInstallationId: () => 'notification-installation', verifyExecutionAuthorization: async () => false,
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
