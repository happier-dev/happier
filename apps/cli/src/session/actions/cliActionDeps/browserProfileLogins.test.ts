import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { BrowserPasskeysApplyV1Schema, type BrowserCookieImportRpcV1 } from '@happier-dev/protocol/browser/profile/v1';
import { sealSavedSecretResourceStoredContentV1, type SavedSecretResourceContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { importCliSavedSecretPasskeysForOperation } from './browserProfileLogins';

// Home HTTP and Machine RPC are system boundaries; admission and resource crypto stay real.
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: Object.assign(actual.default.create(), { get: vi.fn() }) };
});
afterEach(() => { vi.mocked(axios.get).mockReset(); vi.unstubAllGlobals(); });

describe('CLI admitted passkey activation', () => {
  it.each(['plain', 'e2ee'] as const)('opens the requester %s resource and transfers its key through native Machine RPC', async mode => {
    const accountId = 'passkey-owner';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const keys = tweetnacl.box.keyPair();
    const credentials = { token, encryption: mode === 'plain' ? null : { type: 'dataKey' as const, publicKey: keys.publicKey, machineKey: keys.secretKey } };
    const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
    let current = true;
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://passkey-home.example',
      snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 0,
        loadedAtMs: 1, scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => current });
    const resourceId = 'credential'; const ref = formatSharedSavedSecretRefV1(resourceId);
    const content: SavedSecretResourceContentV1 = { v: 2, name: 'Example passkey', kind: 'other',
      source: { kind: 'passkey', rpId: 'example.com', credentialId: 'AQID', userHandle: 'BAUG', privateKey: 'BwgJ',
        algorithm: -7, signCount: 0, backupEligibility: true, backupState: true } };
    const resourceDataKey = new Uint8Array(32).fill(17);
    const storedContent = mode === 'plain' ? sealSavedSecretResourceStoredContentV1({ resourceId, mode, content })
      : sealSavedSecretResourceStoredContentV1({ resourceId, mode, content, resourceDataKey, randomBytes: n => new Uint8Array(n).fill(19) });
    let use = true;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }))));
    vi.mocked(axios.get).mockImplementation(async rawUrl => {
      expect(new URL(String(rawUrl)).pathname).toBe('/v1/account/saved-secrets/resources/materials');
      return { status: 200, data: { resources: [{ resourceId, encryptionMode: mode, storedContent,
        recipientEnvelope: mode === 'plain' ? null : { encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceDataKey,
          recipientPublicKey: keys.publicKey, randomBytes: n => new Uint8Array(n).fill(23) })).toString('base64'), recipientContentPublicKeyFingerprint: 'recipient' },
        entry: { ref, source: 'shared_resource', relationship: 'owner', ownerAccountId: accountId, name: content.name, kind: 'other', revision: 3,
          materialStatus: 'ready', capabilities: { use, rename: true, rotate: true, manageAccess: true, delete: true } } }] } };
    });
    const calls: unknown[] = [];
    const params = { input: { kind: 'passkeys' as const, machineId: 'managed-vps', browserSessionId: 'session', viewId: 'view', profileId: 'profile', refs: [ref] },
      expectedScopeKey: scopeKey, operationContext, rpc: async (call: Parameters<BrowserCookieImportRpcV1>[0]) => { calls.push(call);
        return { status: 'completed', records: BrowserPasskeysApplyV1Schema.parse(call.input).credentials.length
          ? [{ name: 'AQID', domain: 'example.com', status: 'imported' }] : [] }; } };
    const nativeRequests: unknown[] = [];
    expect(await importCliSavedSecretPasskeysForOperation({ ...params, rpc: async call => {
      nativeRequests.push(call.input);
      return { status: 'unavailable', code: 'engine_unsupported' };
    } })).toEqual({ status: 'unavailable', code: 'engine_unsupported' });
    expect(vi.mocked(axios.get).mock.calls).toEqual([]);
    expect(nativeRequests).toEqual([{ browserSessionId: 'session', viewId: 'view', profileId: 'profile', credentials: [] }]);
    expect(await importCliSavedSecretPasskeysForOperation(params)).toMatchObject({ status: 'completed', records: [{ status: 'imported' }] });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ machineId: 'managed-vps', input: { credentials: [] } });
    expect(calls[1]).toMatchObject({ machineId: 'managed-vps', input: { credentials: [content.source] } });
    expect(String(vi.mocked(axios.get).mock.calls[0]![0])).toBe('https://passkey-home.example/v1/account/saved-secrets/resources/materials');
    vi.mocked(axios.get).mockClear(); calls.length = 0;
    expect(await importCliSavedSecretPasskeysForOperation({ ...params, input: { ...params.input, refs: [] } }))
      .toEqual({ status: 'completed', records: [] });
    expect(vi.mocked(axios.get).mock.calls).toEqual([]);
    expect(calls).toEqual([]);
    use = false; calls.length = 0;
    expect(await importCliSavedSecretPasskeysForOperation(params)).toMatchObject({ status: 'completed', records: [{ status: 'failed' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: { credentials: [] } });
    current = false; calls.length = 0;
    expect(await importCliSavedSecretPasskeysForOperation(params)).toMatchObject({ status: 'unavailable' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: { credentials: [] } });
  });
});
