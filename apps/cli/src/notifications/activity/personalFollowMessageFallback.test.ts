import axios from 'axios';
import nacl from 'tweetnacl';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { PushNotificationClient } from '@/api/pushNotifications';
import { configuration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { encodeBase64, encrypt } from '@/api/encryption';
import { sealSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createNotificationAccountSnapshotFixture } from '@/testkit/notificationAccountSnapshot';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { capturePersonalFollowMessageFallback } from './personalFollowMessageFallback';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it.each((['plain', 'e2ee'] as const).flatMap(mode =>
  (['current', 'stale-publisher', 'mismatched-turn', 'already-accepted', 'historical', 'status-changed'] as const).map(availability => ({ mode, availability }))))(
  'uses the verified host Turn for ordinary $mode failure fallback without private census or Session effects ($availability)', async ({ mode, availability }) => {
    const server = { serverId: configuration.activeServerId, serverUrl: 'https://ordinary-fallback.test' };
    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = nacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const key = new Uint8Array(32).fill(23);
    const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature',
      encryption: mode === 'plain' ? null : { type: 'dataKey' as const, machineKey, publicKey } };
    const ctx = { encryptionKey: key, encryptionVariant: 'dataKey' as const };
    const sourceSessionId = 'c333333333333333333333333';
    const source = { ...createSessionNotificationContextFixture(sourceSessionId), ownerAccountId: 'account-1',
      encryptionMode: mode, dataEncryptionKey: mode === 'plain' ? null : encodeBase64(sealEncryptedDataKeyEnvelopeV1({
        dataKey: key, recipientPublicKey: publicKey, randomBytes: length => new Uint8Array(length).fill(17) })),
      metadata: mode === 'plain' ? JSON.stringify({ path: '/work', host: 'host', machineId: 'machine' })
        : encodeBase64(encrypt(key, 'dataKey', { path: '/work', host: 'host', machineId: 'machine' })),
      latestTurnId: availability === 'historical' ? 'successor-turn' : 'host-turn',
      latestTurnStatus: availability === 'historical' ? 'completed' as const : 'failed' as const, seq: 7 };
    setActiveAccountSettingsSnapshot(createNotificationAccountSnapshotFixture({
      scopeKey: runWithServerHttpBaseUrl(server.serverUrl, () => resolveAccountSettingsScopeKey(credentials)),
    }));
    const sent: unknown[] = [];
    // These methods are HTTP delivery/read boundaries; all source normalization,
    // personal eligibility and channel selection remain real.
    vi.spyOn(PushNotificationClient.prototype, 'sendToAllDevicesAsync').mockImplementation(async (...args) => { sent.push(args); return true; });
    vi.spyOn(PushNotificationClient.prototype, 'fetchSessionNotificationContext').mockResolvedValue(source);
    vi.spyOn(PushNotificationClient.prototype, 'readAccountSessionDeliveryMutedScopes').mockResolvedValue([]);
    const reads: string[] = [];
    const payload = buildAcpAgentMessageEnvelope({ provider: 'codex',
      body: { type: availability === 'status-changed' ? 'task_complete' : 'turn_failed', id: 'provider-turn' },
      meta: { source: 'runtime', runtimeTurnId: 'host-turn' } });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
      if (path === `/v2/sessions/${sourceSessionId}`) return { status: 200, data: { session: source } };
      if (path.endsWith('/messages')) return { status: 200, data: { messages: [{ id: 'native-row', localId: 'native-failure',
        seq: 7, messageRole: 'agent', sidechainId: null, createdAt: 1, updatedAt: 1,
        content: mode === 'plain' ? sealSessionStoredContent({ mode, ctx: null, payload })
          : sealSessionStoredContent({ mode, ctx, payload }),
      }], hasMore: false } };
      throw new Error(`Unexpected read ${path}`);
    });
    const verifications: unknown[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).pathname).toBe(`/v2/sessions/${sourceSessionId}/follows/occurrence-routes`);
      verifications.push(body);
      return availability === 'current' || availability === 'historical' ? { status: 200, data: { ok: true, v: 1, sourceSessionId, routes: [] } }
        : { status: 403, data: { ok: false, v: 1, error: 'forbidden' } };
    });
    const input = { credentials, server, sessionId: sourceSessionId, sourceMessage: { localId: 'native-failure', seq: 7 },
      sourcePublisher: { machineId: 'machine', publisherGeneration: '9', committedFenceMs: 42 },
      evidence: { v: 1 as const, ownerAccountId: 'account-1', event: { kind: 'failed_or_stopped' as const },
        facts: { serverId: server.serverId, kind: 'session' as const } },
      signal: new AbortController().signal, isCurrent: async () => true };
    const fallback = capturePersonalFollowMessageFallback(input);
    expect(fallback).not.toBeNull();
    await fallback!(availability === 'already-accepted' ? { personalFollow: { accepted: true,
      sourceSessionId, sourceMessage: { ...input.sourceMessage, policies: [{ preset: 'important' }] } } } : undefined);
    expect(verifications).toEqual(availability === 'already-accepted' || availability === 'status-changed' ? []
      : [expect.objectContaining({ sourcePublisher: input.sourcePublisher,
        sourceTurn: { id: 'host-turn', status: 'failed' } })]);
    expect(sent).toHaveLength(availability === 'current' || availability === 'historical' ? 1 : 0);
    expect(reads.some(path => path.includes('session-follow-rules'))).toBe(false);
  },
);
