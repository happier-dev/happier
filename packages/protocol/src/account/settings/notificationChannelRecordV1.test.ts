import { describe, expect, it } from 'vitest';
import { readLegacyNotificationChannelInventoryV1, NotificationChannelCatalogRecordV1Schema,
  NotificationChannelCatalogMutationV1Schema, NotificationChannelCatalogMutationResponseV1Schema,
  NotificationChannelCatalogReadResponseV1Schema,
  openNotificationChannelCatalogContentV1, sealNotificationChannelCatalogContentV1,
  type NotificationChannelCatalogReadResponseV1 } from './notificationChannelRecordV1.js';
import { prepareLegacyNotificationChannelCatalogV1, loadNotificationChannelCatalogV1 } from './notificationChannelCatalogV1.js';
import { formatSharedSavedSecretRefV1 } from './savedSecretReferenceV1.js';

describe('notification channel catalog', () => {
  it('admits paired finite Settings only for a captured destination revision and acknowledges its version', () => {
    const settingsMutation = { expectedSettingsVersion: 7, content: { t: 'plain', v: {
      notificationChannelsV1: [{ kind: 'future-channel', signingSecret: { value: 'retained source bytes' } }],
    } } };
    const mutation = { expectedRevision: 3, content: { t: 'plain', v: { v: 1, channels: [] } }, settingsMutation };
    const parsed = NotificationChannelCatalogMutationV1Schema.safeParse(mutation);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({ ...mutation, savedSecretRevisions: [] });
    expect(NotificationChannelCatalogMutationV1Schema.safeParse({ ...mutation,
      expectedRevision: 'absent', sourceSettingsVersion: 7 }).success).toBe(false);
    expect(NotificationChannelCatalogMutationResponseV1Schema.safeParse({ status: 'updated', revision: 4,
      cursor: 9, settingsVersion: 8 }).success).toBe(true);
  });
  it.each(['channel reference', 'envelope reference', 'channel material', 'envelope material'] as const)(
    'does not certify hidden credential carriers through actual row transport (%s)', placement => {
    const channel = { v: 1, id: 'safe-hook', kind: 'webhook', url: 'https://example.test/hook', topics: {},
      signingSecretRef: formatSharedSavedSecretRefV1('known-resource') };
    const hidden = { signingSecretRef: formatSharedSavedSecretRefV1('hidden-resource') };
    const cases = {
      'channel reference': { content: { t: 'plain', v: { v: 1, channels: [{ ...channel, future: hidden }] } }, expected: { status: 'partial' } },
      'envelope reference': { content: { t: 'plain', v: { v: 1, channels: [channel] }, future: hidden },
        expected: { status: 'unavailable', reason: 'invalid-stored-content' } },
      'channel material': { content: { t: 'plain', v: { v: 1, channels: [{ ...channel, signingSecret: { _isSecretValue: true, value: 'unrepresented signing material' } }] } },
        expected: { status: 'partial' } },
      'envelope material': { content: { t: 'plain', v: { v: 1, channels: [channel] }, future: { _isSecretValue: true, value: 'unrepresented signing material' } },
        expected: { status: 'unavailable', reason: 'invalid-stored-content' } },
    };
    const { content, expected } = cases[placement];
    expect(openNotificationChannelCatalogContentV1({ mode: 'plain', material: null, content })).toMatchObject(expected);
    const response = NotificationChannelCatalogReadResponseV1Schema.parse({ status: 'present', revision: 3, content });
    if (response.status !== 'present') throw new Error('Expected present stored catalog');
    expect(openNotificationChannelCatalogContentV1({ mode: 'plain', material: null, content: response.content })).toMatchObject(expected);
    if (placement === 'channel reference') {
      expect(openNotificationChannelCatalogContentV1({ mode: 'plain', material: null,
        content: { t: 'plain', v: { v: 1, channels: [{ ...channel, future: { color: 'blue' } }] }, future: { color: 'green' } } }).status).toBe('opened');
      expect(readLegacyNotificationChannelInventoryV1({ notificationChannelsV1: [{ id: 'legacy-hook', kind: 'webhook',
        url: 'https://example.test/hook', future: hidden }] }).status).toBe('partial');
    }
  });
  it('admits signing references only from the canonical SavedSecret Resource namespace', () => {
    const channel = { v: 1, id: 'signed-hook', kind: 'webhook', url: 'https://example.test/hook', topics: {} };
    for (const signingSecretRef of ['saved-secret:resource-1', 'personal-secret', 'happier:shared-secret:v1:']) {
      expect(NotificationChannelCatalogRecordV1Schema.safeParse({ v: 1, channels: [{ ...channel, signingSecretRef }] }).success).toBe(false);
      expect(openNotificationChannelCatalogContentV1({ mode: 'plain', material: null,
        content: { t: 'plain', v: { v: 1, channels: [{ ...channel, signingSecretRef }] } } }).status).not.toBe('opened');
    }
    expect(NotificationChannelCatalogRecordV1Schema.safeParse({ v: 1,
      channels: [{ ...channel, signingSecretRef: formatSharedSavedSecretRefV1('resource-1') }] }).success).toBe(true);
  });
  it('does not let an opaque envelope field alias an admitted reference carrier path', () => {
    const channel = { v: 1, id: 'safe-hook', kind: 'webhook', url: 'https://example.test/hook', topics: {},
      signingSecretRef: formatSharedSavedSecretRefV1('known-resource') };
    const content = { t: 'plain', v: { v: 1, channels: [channel] },
      'v.channels[0].signingSecretRef': formatSharedSavedSecretRefV1('hidden-resource') };
    const response = NotificationChannelCatalogReadResponseV1Schema.parse({ status: 'present', revision: 3, content });
    if (response.status !== 'present') throw new Error('Expected present stored catalog');
    expect(openNotificationChannelCatalogContentV1({ mode: 'plain', material: null, content: response.content }))
      .toMatchObject({ status: 'unavailable', reason: 'invalid-stored-content' });
  });
  it('retains explicit empty and derives the absent predecessor root exactly at the source boundary', () => {
    expect(readLegacyNotificationChannelInventoryV1({ notificationChannelsV1: [] })).toEqual({ status: 'ready', channels: [] });
    expect(readLegacyNotificationChannelInventoryV1({ notificationsSettingsV1: { pushEnabled: false } })).toMatchObject({
      status: 'ready', channels: [{ id: 'builtin:expo_push', enabled: false }],
    });
  });
  it('refuses malformed or unknown-version predecessor catalogs instead of deriving push', () => {
    expect(readLegacyNotificationChannelInventoryV1({ notificationChannelsV1: [{ v: 2, id: 'future', kind: 'expo_push' }] }))
      .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    expect(readLegacyNotificationChannelInventoryV1({ notificationChannelsV1: [{ id: 'broken', kind: 'webhook', url: 'invalid' }] }))
      .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    expect(readLegacyNotificationChannelInventoryV1({ notificationChannelsV1: [{ id: 'bad-topic', kind: 'expo_push', topics: { ready: 'no' } }] }))
      .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
  });
  it('preserves the predecessor blocked=false recovered omission and rejects duplicate identities', () => {
    expect(readLegacyNotificationChannelInventoryV1({ notificationChannelsV1: [{ id: 'quota', kind: 'expo_push', topics: { connectedServiceQuotaBlocked: false } }] }))
      .toMatchObject({ status: 'ready', channels: [{ topics: { connectedServiceQuotaRecovered: false } }] });
    expect(readLegacyNotificationChannelInventoryV1({ notificationChannelsV1: [{ id: 'same', kind: 'expo_push' }, { id: 'same', kind: 'expo_push' }] }))
      .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
  });
  it('retains valid predecessor neighbors but refuses activation of an incomplete inventory', () => {
    expect(readLegacyNotificationChannelInventoryV1({ notificationChannelsV1: [
      { id: 'retained', kind: 'webhook', url: 'https://example.test/hook', topics: { ready: false }, extra: true },
      { v: 2, id: 'future', kind: 'expo_push' },
    ] })).toMatchObject({ status: 'partial', channels: [{ id: 'retained', topics: { ready: false } }],
      diagnostics: [{ channelId: 'future', reason: 'invalid-stored-content' }] });
  });
  it('opens Plain keylessly while canonical writes reject inline material and stored extras are dropped', () => {
    const channel = { v: 1, id: 'saved-hook', kind: 'webhook', enabled: true, url: 'https://example.test/hook',
      topics: { ready: true, permissionRequest: true, userActionRequest: true, connectedServiceAccountSwitch: true,
        connectedServiceQuotaBlocked: false, connectedServiceQuotaRecovered: false },
      readyIncludeMessageText: false, requestIncludeMessageText: true, signingSecretRef: formatSharedSavedSecretRefV1('resource-1') };
    const record = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [channel] });
    const content = sealNotificationChannelCatalogContentV1({ mode: 'plain', material: null, record });
    expect(openNotificationChannelCatalogContentV1({ mode: 'plain', material: null, content: {
      ...content, extra: true, v: { ...record, channels: [{ ...channel, extra: 'retained-extension' }] },
    } })).toEqual({ status: 'opened', record });
    expect(NotificationChannelCatalogRecordV1Schema.safeParse({ v: 1, channels: [{ ...channel, signingSecret: { value: 'secret' } }] }).success).toBe(false);
    expect(openNotificationChannelCatalogContentV1({ mode: 'e2ee', material: null, content })).toEqual({ status: 'unavailable', reason: 'account-mode-mismatch' });
  });
  it('keeps safe neighbors visible with incomplete diagnostics but cannot admit them as a complete catalog', () => {
    const content = { t: 'plain', v: { v: 1, channels: [
      { v: 1, id: 'safe', kind: 'expo_push', enabled: true, topics: {}, readyIncludeMessageText: false, requestIncludeMessageText: false },
      { v: 1, id: 'broken', kind: 'webhook', url: 'invalid', signingSecretRef: null, topics: {} },
    ] } };
    expect(openNotificationChannelCatalogContentV1({ mode: 'plain', material: null, content })).toMatchObject({
      status: 'partial', record: { channels: [{ id: 'safe' }] }, diagnostics: [{ channelId: 'broken', reason: 'invalid-stored-content' }],
    });
    expect(openNotificationChannelCatalogContentV1({ mode: 'e2ee', material: null, content })).toEqual({ status: 'unavailable', reason: 'account-mode-mismatch' });
  });
  it('prepares exact predecessor signing bytes under the stable Resource identity and refuses unreadable material', () => {
    const secret = '  exact signing bytes\n';
    const raw = { notificationChannelsV1: [{ id: 'workflow-hook', kind: 'webhook', url: 'https://example.test/hook',
      signingSecret: { _isSecretValue: true, value: secret } }] };
    const prepared = prepareLegacyNotificationChannelCatalogV1({ accountId: 'owner', raw, settingsSecretsReadKeys: [] });
    expect(prepared).toMatchObject({ status: 'ready', signingSecrets: [{ value: secret }],
      record: { channels: [{ id: 'workflow-hook', signingSecretRef: expect.stringMatching(/^happier:shared-secret:v1:/) }] } });
    if (prepared.status !== 'ready') throw new Error('Expected complete preparation');
    expect(prepared.record.channels[0]).not.toHaveProperty('signingSecret');
    expect(prepareLegacyNotificationChannelCatalogV1({ accountId: 'owner', settingsSecretsReadKeys: [], raw: {
      notificationChannelsV1: [{ ...raw.notificationChannelsV1[0], signingSecret: { _isSecretValue: true,
        encryptedValue: { t: 'enc-v1', c: 'unreadable' } } }],
    } })).toMatchObject({ status: 'partial', diagnostics: [{ channelId: 'workflow-hook', reason: 'secret-unavailable' }] });
  });
  it('admits the actual destination after a lost initialization receipt and never reseeds its tombstone', async () => {
    let row: NotificationChannelCatalogReadResponseV1 = { status: 'absent' };
    const raw = { notificationChannelsV1: [] };
    const input = { mode: 'plain' as const, material: null, readRow: async () => row,
      transfer: { accountId: 'owner', readSourceSnapshot: async () => ({ raw, version: 7 }),
        initializeRecord: async (prepared: Parameters<NonNullable<Parameters<typeof loadNotificationChannelCatalogV1>[0]['transfer']>['initializeRecord']>[0]) => {
          expect(prepared.sourceSettingsVersion).toBe(7);
          expect(prepared.record.channels).toEqual([]);
          row = { status: 'present', revision: 3, content: { t: 'plain', v: prepared.record } };
          throw new Error('Lost transport acknowledgement');
        } } };
    expect(await loadNotificationChannelCatalogV1(input)).toMatchObject({ status: 'ready', revision: 3, channels: [] });
    row = { status: 'deleted', revision: 4 };
    expect(await loadNotificationChannelCatalogV1(input)).toMatchObject({ status: 'ready', revision: 4, channels: [] });
    expect(row).toEqual({ status: 'deleted', revision: 4 });
  });
  it('keeps a typed transport refusal distinct from a retryable unreachable catalog', async () => {
    const refused = Object.assign(new Error('Authentication refused'), { code: 'unauthorized' });
    expect(await loadNotificationChannelCatalogV1({ mode: 'plain', material: null,
      readRow: async () => { throw refused; } })).toEqual({ status: 'unavailable', reason: 'unauthorized' });
  });
});
