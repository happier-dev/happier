import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { readAccountNoticeArtifactV1, readAccountNoticeArtifactHeaderV1, AccountNoticeArtifactHeaderV1Schema, AccountNoticeArtifactBodyV1Schema,
  UsageNoticeArtifactHeaderV1Schema, UsageNoticeArtifactBodyV1Schema, type UsageNoticeArtifactHeaderV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { AccountNoticePushDataV1Schema, PluginSessionPushDataV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { ArtifactAccessRecipientCensusResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { decodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { decodeBase64, decryptWithDataKey, encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createStablePluginNotificationsService, type StablePluginNotificationsHost } from './notifications';
import { createPluginNativeNotificationDelivery } from '@/notifications/activity/pluginNativeNotificationDelivery';
import { notificationSettingsFixture, notificationCatalogFixture } from '@/notifications/activity/activityNotification.testkit';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { publishTriageAttentionV1 } from '@happier-dev/triage-sources/runtime';
import { buildTriageEntryRouteSegmentV1 } from '@happier-dev/triage-protocol/v1';

const nativePush = vi.hoisted(() => ({ messages: [] as Readonly<Record<string, unknown>>[] }));
// Expo is the actual outward network boundary; the host push client and its
// authenticated token/badge reads remain real beneath this test.
vi.mock('expo-server-sdk', () => ({ Expo: class {
  static isExpoPushToken() { return true; }
  chunkPushNotifications(messages: Readonly<Record<string, unknown>>[]) { return [messages]; }
  async sendPushNotificationsAsync(messages: Readonly<Record<string, unknown>>[]) {
    nativePush.messages.push(...messages);
    return messages.map(() => ({ status: 'ok' as const }));
  }
} }));

afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); nativePush.messages.length = 0; });

describe('plugin notification Account Artifact custody', () => {
  it.each(['plain', 'e2ee'] as const)('persists and updates one %s private item with badges disabled, preserving dismissal, resolution, and plugin isolation', async mode => {
    // Real service + mode-aware Artifact codec + HTTP transport. This server is
    // the persistent-service boundary, including the real revision contract.
    type Row = { id: string; kind?: string; header: string; body: string; dataEncryptionKey: string; headerVersion: number; bodyVersion: number };
    const rows = new Map<string, Row>();
    let pushTokenReads = 0;
    let sessionReads = 0;
    let accountMode = mode;
    const secret = randomBytes(32);
    const decodeHeader = (row: Row) => {
      if (accountMode === 'plain') return decodePlainArtifactStoredContent(row.header);
      const key = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(row.dataEncryptionKey), recipientSecretKeyOrSeed: secret });
      if (!key) throw new Error('Missing test Artifact key');
      return decryptWithDataKey(decodeBase64(row.header), key);
    };
    const encodeHeader = (row: Row, header: unknown) => {
      if (accountMode === 'plain') return encodePlainArtifactStoredContent(header);
      const key = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(row.dataEncryptionKey), recipientSecretKeyOrSeed: secret });
      if (!key) throw new Error('Missing test Artifact key');
      return encodeBase64(encryptWithDataKey(header, key));
    };
    let dismissDuringUpdate = false;
    const wireRow = (row: Row) => {
      const kind = decodeArtifactKindV1(row.kind);
      return { ...row, kind: kind.kind, ...(kind.classified ? { kindHint: kind.kindHint } : {}),
        ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: accountMode,
        seq: 1, createdAt: 1, updatedAt: 2 };
    };
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const id = decodeURIComponent(url.pathname.slice('/v1/artifacts/'.length));
      const existing = rows.get(id);
      const reply = (status: number, value: unknown) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
      if (request.method === 'GET' && url.pathname === '/v1/push-tokens') {
        pushTokenReads += 1;
        request.resume();
        return reply(200, { tokens: [{ id: 'device', token: 'ExponentPushToken[ak1]', clientServerUrl: 'https://home.example.test' }] });
      }
      if (request.method === 'GET' && url.pathname === '/v1/account/activity/badge-snapshot') {
        request.resume(); return reply(200, { badgeCount: rows.size });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v2/sessions/')) {
        sessionReads += 1;
        request.resume(); return reply(200, { session: createSessionNotificationContextFixture('session-bound') });
      }
      if (request.method === 'GET' && url.pathname.endsWith('/access/recipients')) {
        request.resume();
        const row = rows.get(decodeURIComponent(url.pathname.split('/')[3]!));
        return row ? reply(200, ArtifactAccessRecipientCensusResponseV1Schema.parse({ artifactId: row.id,
          ownerAccountId: 'owner', encryptionMode: accountMode, access: 'owner',
          dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey, recipients: [] })) : reply(404, {});
      }
      if (request.method === 'GET' && url.pathname === '/v1/artifacts') {
        request.resume();
        const kinds: unknown = url.searchParams.has('kinds') ? JSON.parse(url.searchParams.get('kinds')!) : undefined;
        const coarse = url.searchParams.get('kind');
        const unclassified = url.searchParams.get('unclassified');
        const selected = [...rows.values()].filter(row => unclassified ? unclassified === 'coarse' ? row.kind == null : !decodeArtifactKindV1(row.kind).classified
          : Array.isArray(kinds) ? kinds.includes(decodeArtifactKindV1(row.kind).kindHint) : !coarse || decodeArtifactKindV1(row.kind).kind === coarse);
        const cursor = url.searchParams.get('cursor');
        const after = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id: string } : null;
        const start = after ? selected.findIndex(row => row.id === after.id) + 1 : 0;
        const items = selected.slice(start, start + Number(url.searchParams.get('limit') ?? 500)).map(row => {
          const { body, ...header } = wireRow(row);
          return { ...header, ...(url.searchParams.get('includeBody') ? { body } : {}) };
        });
        return reply(200, kinds !== undefined || coarse || unclassified ? { items,
          hasUnclassified: [...rows.values()].some(row => kinds !== undefined || unclassified === 'true' ? !decodeArtifactKindV1(row.kind).classified : row.kind == null) } : items);
      }
      if (request.method === 'GET') {
        request.resume();
        return existing ? reply(200, wireRow(existing)) : reply(404, {});
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (url.pathname === '/v1/artifacts') {
        if (rows.has(input.id)) return reply(409, { error: 'conflict' });
        const row: Row = { ...input, headerVersion: 1, bodyVersion: 1 };
        rows.set(row.id, row);
        return reply(200, row);
      }
      if (!existing) return reply(404, {});
      if (input.kind !== undefined && input.header === undefined && input.body === undefined) {
        if (input.expectedHeaderVersion !== existing.headerVersion) return reply(409, { success: false, error: 'version-mismatch' });
        existing.kind = input.kind;
        return reply(200, { success: true });
      }
      if (dismissDuringUpdate) {
        dismissDuringUpdate = false;
        existing.header = encodeHeader(existing, { ...decodeHeader(existing) as object, status: 'dismissed', readAt: 100 });
        existing.headerVersion += 1;
      }
      if (input.expectedHeaderVersion !== existing.headerVersion || input.expectedBodyVersion !== existing.bodyVersion) {
        return reply(200, { success: false, error: 'version-mismatch' });
      }
      existing.header = input.header;
      existing.body = input.body;
      existing.kind = input.kind;
      existing.headerVersion += 1;
      existing.bodyVersion += 1;
      return reply(200, { success: true, headerVersion: existing.headerVersion, bodyVersion: existing.bodyVersion });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test HTTP address');
    try {
      await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials = { token, encryption: mode === 'plain' ? null : {
          type: 'dataKey' as const, publicKey: x25519.getPublicKey(secret), machineKey: secret,
        } };
        const store = createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => accountMode });
        let activeStore = store;
        const migrateAccountMode = () => {
          const targetMode = accountMode === 'plain' ? 'e2ee' : 'plain';
          for (const row of rows.values()) {
            const header = decodeHeader(row);
            const key = accountMode === 'plain' ? null : openEncryptedDataKeyEnvelopeV1({
              envelope: decodeBase64(row.dataEncryptionKey), recipientSecretKeyOrSeed: secret });
            const body = accountMode === 'plain' ? decodePlainArtifactStoredContent(row.body)
              : decryptWithDataKey(decodeBase64(row.body), key!);
            const targetKey = randomBytes(32);
            row.dataEncryptionKey = targetMode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
              : encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: targetKey, recipientPublicKey: x25519.getPublicKey(secret), randomBytes }));
            row.header = targetMode === 'plain' ? encodePlainArtifactStoredContent(header) : encodeBase64(encryptWithDataKey(header, targetKey));
            row.body = targetMode === 'plain' ? encodePlainArtifactStoredContent(body) : encodeBase64(encryptWithDataKey(body, targetKey));
          }
          accountMode = targetMode;
          activeStore = createAccountArtifactStore({ credentials: { token, encryption: accountMode === 'plain' ? null : {
            type: 'dataKey', publicKey: x25519.getPublicKey(secret), machineKey: secret } }, getAccountEncryptionMode: async () => accountMode });
        };
        const seed = { plugin: { id: 'acme.tasks', version: '1.0.0' }, contribution: { id: 'run', qualifiedId: 'acme.tasks/actions/run' },
          occurrenceId: 'one', correlationId: 'one', surface: 'cli' as const, signal: new AbortController().signal, isOccurrenceCurrent: () => true };
        const host = { categories: [{ pluginId: 'acme.tasks',
          definition: { id: 'updates', kind: 'plugin' as const, title: 'Updates', eventIds: [] } }], channels: [],
          readAttentionPolicy: () => ({ channels: { badge: { enabled: false } } }),
          async activateChannel() {}, readChannel: () => null,
          resolveNoticeArtifacts: async () => ({ accountId: 'owner', store: activeStore }) } satisfies StablePluginNotificationsHost;
        const service = createStablePluginNotificationsService(seed, host);
        const nativeRequests: unknown[] = [];
        const settings = notificationSettingsFixture({});
        const catalog = notificationCatalogFixture(settings);
        setActiveAccountSettingsSnapshot({ source: 'network', settings, scopeKey: resolveAccountSettingsScopeKey(credentials),
          settingsVersion: 1, settingsSecretsReadKeys: [], loadedAtMs: Date.now(), notificationChannelCatalog: catalog.notificationChannelCatalog });
        let routable = true;
        let current = true;
        const sendNative = createPluginNativeNotificationDelivery({ credentials, readCredentials: async () => current ? credentials : null,
          serverUrl: 'https://home.example.test', serverHttpBaseUrl: `http://127.0.0.1:${address.port}`, serverId: 'srv_bound_home',
          isCurrent: () => current, resolveServerFeaturesSnapshot: () => routable ? { status: 'ready',
            features: FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_bound_home' } } }) } : undefined });
        const native = createStablePluginNotificationsService(seed, { ...host,
            categories: [{ ...host.categories[0]!, definition: { ...host.categories[0]!.definition,
              buttons: [{ id: 'Open review', label: 'Review', effect: { kind: 'open' } },
                { id: 'Ship 🚀', label: 'Ship', effect: { kind: 'action', invocation: {
                  action: { pluginId: 'acme.tasks', localId: 'release' }, input: { repository: 'default' } } } }],
            } }],
            readAttentionPolicy: () => getActiveAccountSettingsSnapshot()?.settings.attentionDeliveryPolicyV1,
            sendNative: async (caller, input, signal) => {
              nativeRequests.push(input);
              return sendNative(caller, input, signal);
            },
        });
        const review = { clientRequestId: 'native-review', categoryId: 'updates', title: 'Review deployment',
          itemId: 'deployment/one', type: 'decision' as const, page: { pageId: 'deployment-review', subPath: 'repo/one' } };
        for (const page of [
          { kind: 'host', page: 'machine_service', machine: { serverId: 'home', machineId: 'machine' },
            service: { kind: 'deployment', machineId: 'machine', environmentId: 'environment',
              environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } },
          { kind: 'host', page: 'environment', environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' },
            targetLinkId: 'target' },
        ]) {
          // The plugin transport is untyped at runtime; host destinations are not authorable plugin pages.
          // @ts-expect-error A plugin cannot author a host page through the public notification API.
          await expect(native.send({ ...review, page })).rejects.toMatchObject({ code: 'plugin_notification_invalid_request' });
          expect(rows.size).toBe(0);
          expect(nativeRequests).toEqual([]);
        }
        await expect(native.send(review)).resolves.toMatchObject({ deliveries: [{ status: 'accepted' }] });
        expect(nativeRequests).toEqual([expect.objectContaining({ notice: { artifactId: [...rows.keys()][0], itemId: review.itemId, page: review.page } })]);
        await native.send(review);
        expect(nativeRequests).toHaveLength(1);
        await native.send({ ...review, clientRequestId: 'same-open-notice' });
        await native.send({ ...review, clientRequestId: 'updated-open-notice', title: 'Updated deployment review' });
        expect(nativeRequests).toHaveLength(1);
        expect(readAccountNoticeArtifactV1((await activeStore.read([...rows.keys()][0]!))!))
          .toMatchObject({ title: 'Updated deployment review', resolved: false });
        await expect(native.send({ ...review, channelIds: [] })).rejects.toMatchObject({ code: 'plugin_notification_request_conflict' });
        await native.send({ ...review, clientRequestId: 'native-resolved', resolved: true });
        expect(nativeRequests).toHaveLength(1);
        expect(nativePush.messages).toEqual([expect.objectContaining({ categoryId: 'happier.pluginNotification.v1/acme.tasks/updates',
          data: expect.objectContaining({ topic: 'account_notice', accountId: 'owner', page: review.page,
            serverUrl: 'https://home.example.test', source: { kind: 'plugin', pluginId: 'acme.tasks', itemId: review.itemId } }) })]);
        expect(AccountNoticePushDataV1Schema.safeParse(nativePush.messages[0]!.data).success).toBe(true);
        expect(nativePush.messages[0]!.data).toMatchObject({ pluginNotification: {
          pluginId: 'acme.tasks', categoryId: 'updates', occurrenceId: 'one', clientRequestId: 'native-review' } });
        await native.send({ ...review, clientRequestId: 'reopened-review' });
        expect(nativeRequests).toHaveLength(2);
        // A restarted/second Machine owner has no request-id history; the retained Inbox still owns opening.
        const restarted = createStablePluginNotificationsService({ ...seed, occurrenceId: 'restarted' }, { ...host,
          sendNative: async (_caller, input) => {
            nativeRequests.push(input);
            return { attemptedChannels: 1, deliveredChannels: 1 };
          } });
        await restarted.send({ ...review, clientRequestId: 'restart-replay' });
        expect(nativeRequests).toHaveLength(2);
        const pendingDeployment = { ...review, itemId: 'deployment/pending', type: 'update' as const,
          clientRequestId: 'deployment-not-yet-eligible' };
        await native.send(pendingDeployment);
        await native.send({ ...pendingDeployment, clientRequestId: 'deployment-still-ineligible' });
        expect(nativeRequests).toHaveLength(2);
        const eligibleDeployment = { ...pendingDeployment, type: 'approval' as const, clientRequestId: 'deployment-now-eligible' };
        await expect(native.send(eligibleDeployment)).resolves.toMatchObject({ notice: { changed: true, opened: false } });
        expect(nativeRequests).toHaveLength(3);
        await native.send({ ...eligibleDeployment, clientRequestId: 'deployment-still-eligible' });
        expect(nativeRequests).toHaveLength(3);
        rows.clear();
        nativePush.messages.length = 0;
        // Triage's real shared publisher reaches the real C1 store in both Account modes.
        const attentionService = createStablePluginNotificationsService({ ...seed, plugin: { id: 'happier.triage', version: '0.0.0' } }, {
          ...host, categories: [{ pluginId: 'happier.triage', definition: { id: 'source-attention', kind: 'plugin', title: 'Attention', eventIds: [] } }],
        });
        const attentionContext = { signal: seed.signal, services: { notifications: attentionService } };
        const entryRef = { source: { pluginId: 'happier.sentry', localId: 'sentry-issues' }, kindId: 'error-issue', collisionScope: 'deployment-and-organization', entryId: '1284' };
        const attentionInput = { entryRef, reason: 'assignment', notice: { clientRequestId: 'attention-first', categoryId: 'source-attention',
          title: 'Assigned issue', type: 'update' as const, resolved: false,
          page: { pageId: 'triage', subPath: buildTriageEntryRouteSegmentV1(entryRef) } } };
        const attentionResult = await publishTriageAttentionV1(attentionContext, attentionInput);
        expect(attentionResult.notice?.opened).toBe(true);
        await publishTriageAttentionV1(attentionContext, { ...attentionInput, notice: { ...attentionInput.notice, clientRequestId: 'attention-second', title: 'Updated issue' } });
        expect(rows.size).toBe(1);
        const attentionArtifactId = [...rows.keys()][0]!;
        expect(readAccountNoticeArtifactV1((await activeStore.read(attentionArtifactId, { includeSharedAudience: false }))!)).toMatchObject({
          source: { kind: 'plugin', pluginId: 'happier.triage' }, type: 'update', resolved: false, page: attentionInput.notice.page,
        });
        await publishTriageAttentionV1(attentionContext, { ...attentionInput, notice: { ...attentionInput.notice, clientRequestId: 'attention-resolved', resolved: true } });
        expect(rows.size).toBe(1);
        expect(readAccountNoticeArtifactV1((await activeStore.read(attentionArtifactId, { includeSharedAudience: false }))!)).toMatchObject({ resolved: true });
        rows.clear();
        const pushOnly = { clientRequestId: 'push-only', categoryId: 'updates', title: 'PR needs attention', type: 'blocked' as const,
          buttonInputs: { 'Ship 🚀': { repository: 'selected' } },
          data: { sessionId: 'session-bound', serverId: 'forged-home', serverUrl: 'https://forged.example.test', requestId: 'never-answer' } };
        await native.send(pushOnly);
        expect(rows.size).toBe(0);
        expect(nativePush.messages).toEqual([expect.objectContaining({ categoryId: 'happier.pluginNotification.v1/acme.tasks/updates',
          data: expect.objectContaining({ v: 1, topic: 'plugin_session', sessionId: 'session-bound', serverId: 'srv_bound_home', serverUrl: 'https://home.example.test', accountId: 'owner',
            pluginNotification: { pluginId: 'acme.tasks', categoryId: 'updates', occurrenceId: 'one', clientRequestId: 'push-only',
              buttonInputs: { 'Ship 🚀': { repository: 'selected' } } } }) })]);
        expect(PluginSessionPushDataV1Schema.safeParse(nativePush.messages[0]!.data).success).toBe(true);
        await native.send(pushOnly);
        expect(nativePush.messages).toHaveLength(1);
        await expect(native.send({ ...pushOnly, buttonInputs: { 'Ship 🚀': { repository: 'changed' } } }))
          .rejects.toMatchObject({ code: 'plugin_notification_request_conflict' });
        await expect(native.send({ ...pushOnly, clientRequestId: 'unknown-button', buttonInputs: { 'foreign-button': {} } }))
          .rejects.toMatchObject({ code: 'plugin_notification_invalid_request' });
        await expect(native.send({ ...pushOnly, clientRequestId: 'open-button-operands', buttonInputs: { 'Open review': {} } }))
          .rejects.toMatchObject({ code: 'plugin_notification_invalid_request' });
        expect(nativePush.messages).toHaveLength(1);
        const reads = { pushTokenReads, sessionReads };
        for (let i = 0; i < 1000; i += 1) await native.send({ ...pushOnly, clientRequestId: `quiet-update-${i}`, type: 'update' });
        expect(nativePush.messages).toHaveLength(1);
        expect({ pushTokenReads, sessionReads }).toEqual(reads);
        routable = false;
        await native.send({ ...pushOnly, clientRequestId: 'unavailable-home' });
        expect({ pushTokenReads, sessionReads }).toEqual(reads);
        routable = true;
        const snapshot = getActiveAccountSettingsSnapshot()!;
        setActiveAccountSettingsSnapshot({ ...snapshot, settings: notificationSettingsFixture({ attentionDeliveryPolicyV1: {
          quietHours: { enabled: true, timezone: 'UTC', windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }] },
        } }), settingsVersion: 2 });
        await native.send({ ...pushOnly, clientRequestId: 'quiet-hours' });
        expect({ pushTokenReads, sessionReads }).toEqual(reads);
        current = false;
        await native.send({ ...pushOnly, clientRequestId: 'retired-account' });
        expect(nativePush.messages).toHaveLength(1);
        expect(rows.size).toBe(0);
        nativePush.messages.length = 0;
        // A live Resource already owns the Inbox row. Typed channel attention
        // must not materialize a second private notice in either Account mode.
        await service.send({ clientRequestId: 'live-update', categoryId: 'updates', title: 'Live update', type: 'update' });
        await service.send({ clientRequestId: 'live-blocked', categoryId: 'updates', title: 'Live blocked', type: 'blocked' });
        expect(rows.size).toBe(0);
        const input = { clientRequestId: 'first', categoryId: 'updates', title: 'First', itemId: 'task-1', type: 'update' as const };
        await service.send(input);
        expect(rows.size).toBe(1);
        expect(readAccountNoticeArtifactV1((await store.read([...rows.keys()][0]!, { includeSharedAudience: false }))!))
          .toMatchObject({ title: 'First', source: { kind: 'plugin', pluginId: 'acme.tasks', itemId: 'task-1' } });
        dismissDuringUpdate = true;
        await service.send({ ...input, clientRequestId: 'second', title: 'Changed' });
        expect(rows.size).toBe(1);
        const artifactId = [...rows.keys()][0]!;
        const opened = await store.read(artifactId);
        expect(readAccountNoticeArtifactV1(opened!)).toMatchObject({ title: 'Changed', status: 'dismissed', readAt: 100,
          source: { kind: 'plugin', pluginId: 'acme.tasks', itemId: 'task-1' }, resolved: false });
        await expect(service.send({ ...input, title: 'Changed under same request' })).rejects.toMatchObject({ code: 'plugin_notification_request_conflict' });
        await service.send({ ...input, clientRequestId: 'third', resolved: true });
        expect(readAccountNoticeArtifactV1((await store.read(artifactId))!)).toMatchObject({ resolved: true, status: 'dismissed' });
        // Account migration rewrites envelopes at their existing IDs. Its real
        // server owner uses row.id for every head/history update; this boundary
        // conversion preserves that contract in both mode directions.
        migrateAccountMode();
        await service.send({ ...input, clientRequestId: 'migrated-update', title: 'After mode change' });
        expect(rows.size).toBe(1);
        expect(readAccountNoticeArtifactV1((await activeStore.read(artifactId))!)).toMatchObject({ title: 'After mode change', status: 'dismissed', readAt: 100 });
        await service.send({ ...input, clientRequestId: 'migrated-resolve', resolved: true });
        expect(readAccountNoticeArtifactV1((await activeStore.read(artifactId))!)).toMatchObject({ resolved: true, status: 'dismissed' });
        for (const legacy of [false, true]) {
          const notices: UsageNoticeArtifactHeaderV1['notice'][] = [{ topic: 'resource_limit', kind: 'memory_pressure', phase: 'started',
            machineId: legacy ? 'legacy-machine' : 'current-machine', at: 100, since: 0, guardEnabled: false,
            evidence: { level: 'elevated', sustainMs: 100 } }, {
            topic: 'connected_service_usage', kind: 'credit_expiry', serviceId: 'service', profileId: 'profile',
            issueFingerprint: legacy ? 'legacy-issue' : 'current-issue', evidence: { recordId: 'paug_v1_12345678',
              creditId: 'credit', expiresAtMs: 1000, observedAtMs: 100, previousObservedAtMs: 0 },
          }];
          for (const notice of notices) {
          const content = AccountNoticeArtifactBodyV1Schema.parse({ v: 1, source: { kind: 'host', topic: notice.topic },
            type: 'update', resolved: false, notice });
          const header = AccountNoticeArtifactHeaderV1Schema.parse({ ...content, kind: 'account_notice.v1', title: 'Host alert', status: 'open' });
          const createHost = (event: UsageNoticeArtifactHeaderV1['notice']) => activeStore.create({ noticeAccountId: 'owner',
            header: { ...header, notice: event }, body: JSON.stringify({ ...content, notice: event }) });
          const created = await createHost(notice);
          const retained = rows.get(created.artifactId)!;
          retained.kind = legacy ? undefined : 'other';
          retained.header = encodeHeader(retained, legacy
            ? UsageNoticeArtifactHeaderV1Schema.parse({ v: 1, kind: 'usage_notice.v1', title: 'Host alert', status: 'dismissed', notice })
            : { ...header, status: 'dismissed', readAt: 100 });
          if (legacy) {
            const body = { body: JSON.stringify(UsageNoticeArtifactBodyV1Schema.parse({ v: 1, notice })) };
            retained.body = accountMode === 'plain' ? encodePlainArtifactStoredContent(body)
              : encodeHeader(retained, body);
          }
          const count = rows.size;
          migrateAccountMode();
          await expect(createHost(notice.topic === 'resource_limit' ? { ...notice, machineName: 'Updated display' }
            : { ...notice, evidence: { ...notice.evidence, observedAtMs: 101 } })).rejects.toMatchObject({ code: 'conflict' });
          expect(rows.size).toBe(count);
          expect(decodeHeader(retained)).toMatchObject({ status: 'dismissed' });
          await createHost(notice.topic === 'resource_limit' ? { ...notice, at: 101 }
            : { ...notice, issueFingerprint: `${notice.issueFingerprint}-next` });
          expect(rows.size).toBe(count + 1);
          }
        }
        const beforeOther = rows.size;
        const otherSeed = { ...seed, plugin: { ...seed.plugin, id: 'other.tasks' } };
        const other = createStablePluginNotificationsService(otherSeed, { ...host, categories: [{ ...host.categories[0]!, pluginId: 'other.tasks' }] });
        await other.send(input);
        expect(rows.size).toBe(beforeOther + 1);
        expect(readAccountNoticeArtifactV1((await activeStore.read(artifactId))!)?.source).toEqual({ kind: 'plugin', pluginId: 'acme.tasks', itemId: 'task-1' });
        await expect(service.send({ ...input, clientRequestId: 'spoof', source: { pluginId: 'other.tasks' } } as typeof input))
          .rejects.toMatchObject({ code: 'plugin_notification_invalid_request' });
        const otherArtifactId = [...rows.values()].find(row => {
          const source = readAccountNoticeArtifactHeaderV1(decodeHeader(row))?.source;
          return source?.kind === 'plugin' && source.pluginId === 'other.tasks';
        })!.id;
        const victim = rows.get(otherArtifactId)!;
        victim.header = encodeHeader(victim, { ...decodeHeader(victim) as object,
          source: { kind: 'plugin', pluginId: 'acme.tasks', itemId: 'task-1' } });
        await expect(other.send({ ...input, clientRequestId: 'corrupt-ownership' })).rejects.toMatchObject({ code: 'notice_owner_mismatch' });
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
