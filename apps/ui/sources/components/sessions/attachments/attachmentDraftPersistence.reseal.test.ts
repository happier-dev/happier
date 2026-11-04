import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDraft } from './attachmentDraftModel';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

afterEach(async () => {
    vi.restoreAllMocks();
    await (await import('@/sync/domains/state/browserRecordStorage')).clearBrowserRecords();
    vi.unstubAllGlobals();
    vi.resetModules();
});

const scope = { serverId: 'seal-home', accountId: 'seal-account' };
const image = (id: string): AttachmentDraft => ({ id, status: 'pending', source: {
    kind: 'memory', name: `${id}.png`, mimeType: 'image/png', bytes: new Uint8Array([id.charCodeAt(0)]),
} });

describe('attachment source sealing cost', () => {
    it('seals and encodes each source exactly once across sequential adds, updates, removal and reload', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: createDesktopSecureStorageBoundary().invoke });
        const crypto = await import('@/sync/encryption/secretSettings');
        const base64 = await import('@/encryption/base64');
        // Call-through instrumentation: crypto and encoding remain real.
        const seals = vi.spyOn(crypto, 'encryptSecretString');
        const encodes = vi.spyOn(base64, 'encodeBase64');
        const owner = await import('./attachmentDraftPersistence');
        const drafts = ['a', 'b', 'c', 'd'].map(image);
        for (let count = 1; count <= drafts.length; count++) {
            await owner.writeAttachmentDraftRecord('sequential', scope, drafts.slice(0, count));
        }
        const sourceSeals = () => drafts.map(draft => seals.mock.calls.filter(([value]) => value.includes(`"name":"${draft.id}.png"`)).length);
        const sourceEncodes = () => encodes.mock.calls.filter(([bytes]) => drafts.some(draft => draft.source.kind === 'memory' && bytes === draft.source.bytes)).length;
        expect(sourceEncodes()).toBe(4);
        expect(sourceSeals()).toEqual([1, 1, 1, 1]);
        await owner.writeAttachmentDraftRecord('sequential', scope, drafts.map(draft => ({ ...draft, status: 'uploading' })));
        const records = await import('@/sync/domains/state/browserRecordStorage');
        const beforeRemoval = await records.listBrowserRecords('');
        await owner.writeAttachmentDraftRecord('sequential', scope, drafts.slice(1));
        const afterRemoval = await records.listBrowserRecords('');
        expect(afterRemoval.size).toBe(beforeRemoval.size - 1);
        expect([...afterRemoval.values()].filter(value => [...beforeRemoval.values()].includes(value))).toHaveLength(3);
        expect(sourceSeals()).toEqual([1, 1, 1, 1]);
        expect(sourceEncodes()).toBe(4);
        vi.restoreAllMocks();
        vi.resetModules();
        const reloadedCrypto = await import('@/sync/encryption/secretSettings');
        const reloadedBase64 = await import('@/encryption/base64');
        const reloadedSeals = vi.spyOn(reloadedCrypto, 'encryptSecretString');
        const reloadedEncodes = vi.spyOn(reloadedBase64, 'encodeBase64');
        const reloaded = await import('./attachmentDraftPersistence');
        const restored = await reloaded.readAttachmentDraftRecord('sequential', scope);
        expect(restored.map(draft => draft.id)).toEqual(['b', 'c', 'd']);
        expect(restored.map(draft => draft.source)).toMatchObject(drafts.slice(1).map(draft => draft.source));
        reloadedEncodes.mockClear(); // Restoring image preview URIs is separate from persistence encoding.
        await reloaded.writeAttachmentDraftRecord('sequential', scope, restored);
        expect(reloadedSeals.mock.calls.filter(([value]) => value.includes('"source":'))).toHaveLength(0);
        expect(reloadedEncodes.mock.calls.filter(([, encoding]) => encoding !== 'base64url')).toHaveLength(0);
        const replacement = image('b');
        if (replacement.source.kind === 'memory') replacement.source.bytes[0] = 99;
        await reloaded.writeAttachmentDraftRecord('sequential', scope, [replacement, ...restored.slice(1)]);
        expect(reloadedSeals.mock.calls.filter(([value]) => value.includes('"source":'))).toHaveLength(1);
        expect(reloadedEncodes.mock.calls.filter(([bytes]) => replacement.source.kind === 'memory' && bytes === replacement.source.bytes)).toHaveLength(1);
        expect((await reloaded.readAttachmentDraftRecord('sequential', scope))[0]?.source).toMatchObject({ bytes: new Uint8Array([99]) });
        await reloaded.writeAttachmentDraftRecord('sequential', scope, []);
        expect((await records.listBrowserRecords('')).size).toBe(0);
    });

    it('reads a single-envelope dev record and writes only per-source envelopes thereafter', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: createDesktopSecureStorageBoundary().invoke });
        const records = await import('@/sync/domains/state/browserRecordStorage');
        const { readAttachmentDraftRecord, writeAttachmentDraftRecord } = await import('./attachmentDraftPersistence');
        const { resolveDeviceLocalSettingsSecretsKey } = await import('@/auth/storage/deviceLocalSecretKey');
        const crypto = await import('@/sync/encryption/secretSettings');
        const scoped = await import('@/sync/domains/scope/serverAccountScope');
        const secret = await resolveDeviceLocalSettingsSecretsKey(scope);
        // Exact DELIVERY-FIX writer shape, observed live by P03 on 2026-11-03 before this amendment.
        const v1 = { v: 1, key: 'dev-record', drafts: [{ id: 'old', source: { kind: 'memory', name: 'old.txt', mimeType: 'text/plain', base64: 'AQI=' } }] };
        const storageKey = `${scoped.serverAccountScopedStorageKey('composer-attachment-sources-v1', scope)}:dev-record`;
        await records.writeBrowserRecord(storageKey, JSON.stringify(crypto.encryptSecretString(JSON.stringify(v1), secret!)));
        const restored = await readAttachmentDraftRecord('dev-record', scope);
        expect(restored[0]?.source).toMatchObject({ bytes: new Uint8Array([1, 2]) });
        await writeAttachmentDraftRecord('dev-record', scope, restored);
        const index = JSON.parse(crypto.decryptSecretString(crypto.EncryptedStringSchema.parse(JSON.parse((await records.readBrowserRecord(storageKey))!)), secret!)!);
        expect(index).toEqual({ v: 2, key: 'dev-record', drafts: [{ id: 'old' }] });
        expect((await readAttachmentDraftRecord('dev-record', scope))[0]?.source).toMatchObject({ bytes: new Uint8Array([1, 2]) });
    });

    it.each(['corrupt', 'copied'] as const)('refuses a %s source envelope without changing storage', async fault => {
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: createDesktopSecureStorageBoundary().invoke });
        const owner = await import('./attachmentDraftPersistence');
        const records = await import('@/sync/domains/state/browserRecordStorage');
        const { serverAccountScopedStorageKey } = await import('@/sync/domains/scope/serverAccountScope');
        await owner.writeAttachmentDraftRecord('one', scope, [image('a')]);
        await owner.writeAttachmentDraftRecord('two', scope, [image('a')]);
        const prefix = serverAccountScopedStorageKey('composer-attachment-sources-v1', scope);
        const sourceKey = `${prefix}:two:source:a`;
        await records.writeBrowserRecord(sourceKey, fault === 'corrupt' ? '{' : (await records.readBrowserRecord(`${prefix}:one:source:a`))!);
        const before = await records.listBrowserRecords('');
        await expect(owner.readAttachmentDraftRecord('two', scope)).rejects.toThrow();
        expect(await records.listBrowserRecords('')).toEqual(before);
    });
});
