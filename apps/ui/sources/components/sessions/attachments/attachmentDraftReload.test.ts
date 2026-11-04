import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDraft } from './attachmentDraftModel';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const scope = { serverId: 'home', accountId: 'person', sessionId: 'session', occurrenceId: 'session' };
const capture: AttachmentDraft = { id: 'capture', status: 'pending', source: {
    kind: 'memory', name: 'Capture.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]),
    ...{ savedFile: { kind: 'capture' as const, captureRef: 'saved-capture', content: 'prepared' as const } },
} };
const pasted: AttachmentDraft = { id: 'paste', status: 'pending', source: {
    kind: 'memory', name: 'Pasted.png', mimeType: 'image/png', bytes: new Uint8Array([4, 5, 6]),
} };

afterEach(async () => {
    const { clearBrowserRecords } = await import('@/sync/domains/state/browserRecordStorage');
    await clearBrowserRecords();
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('shared attachment reload custody', () => {
    it.each([
        { missing: false, content: 'prepared' as const }, { missing: true, content: 'prepared' as const },
        { missing: false, content: 'source' as const }, { missing: true, content: 'source' as const },
    ])('restores capture and pasted bytes after reload: $content, missing=$missing', async ({ missing, content }) => {
        const secure = createDesktopSecureStorageBoundary();
        const files = new Map([['saved-capture', [1, 2, 3]]]);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command.startsWith('desktop_secure_storage_')) return secure.invoke(command, args);
            if (command === 'desktop_capture_read_prepared_png' || command === 'desktop_capture_read_source_png') {
                const file = files.get('saved-capture');
                if (!file) throw { code: 'source_missing' };
                return file;
            }
            throw new Error(`Unexpected native boundary: ${command}`);
        } });
        const first = await import('./sessionAttachmentDraftStore');
        const captureDraft: AttachmentDraft = { ...capture, source: { kind: 'memory', name: content === 'prepared' ? 'Capture.png' : 'Recording.mp4',
            mimeType: content === 'prepared' ? 'image/png' : 'video/mp4', bytes: new Uint8Array([1, 2, 3]),
            savedFile: { kind: 'capture', captureRef: 'saved-capture', content } } };
        first.writeSessionAttachmentDrafts(scope, [captureDraft, pasted]);
        const firstOwner = await import('./attachmentDraftMemoryStore');
        await firstOwner.flushAttachmentDraftsForKey(first.sessionAttachmentDraftKey(scope));
        const records = await import('@/sync/domains/state/browserRecordStorage');
        const { serverAccountScopedStorageKey } = await import('@/sync/domains/scope/serverAccountScope');
        const storageKey = `${serverAccountScopedStorageKey('composer-attachment-sources-v1', scope)}:${first.sessionAttachmentDraftKey(scope)}`;
        const sealed = (await records.readBrowserRecord(storageKey))!;
        expect(sealed).not.toContain('saved-capture');
        expect(sealed).not.toContain('Pasted.png');
        const { resolveDeviceLocalSettingsSecretsKey } = await import('@/auth/storage/deviceLocalSecretKey');
        const { decryptSecretString, EncryptedStringSchema } = await import('@/sync/encryption/secretSettings');
        const key = await resolveDeviceLocalSettingsSecretsKey(scope);
        expect(key).not.toBeNull();
        const saved = JSON.parse(decryptSecretString(EncryptedStringSchema.parse(JSON.parse(sealed)), key!)!);
        expect(saved).toMatchObject({ v: 2, drafts: [{ id: 'capture' }, { id: 'paste' }] });
        expect(saved.drafts[0]).not.toHaveProperty('source');
        const sourceEnvelope = (await records.readBrowserRecord(`${storageKey}:source:capture`))!;
        expect(sourceEnvelope).not.toContain('saved-capture');
        const savedSource = JSON.parse(decryptSecretString(EncryptedStringSchema.parse(JSON.parse(sourceEnvelope)), key!)!);
        expect(savedSource.source).toEqual({ kind: 'capture', name: content === 'prepared' ? 'Capture.png' : 'Recording.mp4',
            mimeType: content === 'prepared' ? 'image/png' : 'video/mp4', captureRef: 'saved-capture', content });
        if (missing) files.delete('saved-capture');
        vi.resetModules();
        const reloaded = await import('./sessionAttachmentDraftStore');
        const reloadedOwner = await import('./attachmentDraftMemoryStore');
        await reloadedOwner.flushAttachmentDraftsForKey(reloaded.sessionAttachmentDraftKey(scope));
        expect(reloaded.readSessionAttachmentDrafts(scope)).toHaveLength(2);
        const restored = reloaded.readSessionAttachmentDrafts(scope);
        expect(restored[1]?.source).toMatchObject({ kind: 'memory', bytes: new Uint8Array([4, 5, 6]) });
        if (missing) {
            expect(restored[0]).toMatchObject({ id: 'capture', status: 'error', errorCode: 'attachment_source_missing' });
            const { projectAttachmentDraftToAgentInputAttachment } = await import('./attachmentDraftPresentation');
            expect(projectAttachmentDraftToAgentInputAttachment(restored[0]!).error).toContain('re-attach');
        }
        else expect(restored[0]?.source).toMatchObject({ kind: 'memory', bytes: new Uint8Array([1, 2, 3]) });
        expect(reloaded.readSessionAttachmentDrafts({ ...scope, accountId: 'another-person' })).toEqual([]);
        reloaded.clearSessionAttachmentDrafts(scope);
        await reloadedOwner.flushAttachmentDraftsForKey(reloaded.sessionAttachmentDraftKey(scope));
        vi.resetModules();
        const cleared = await import('./sessionAttachmentDraftStore');
        const clearedOwner = await import('./attachmentDraftMemoryStore');
        await clearedOwner.flushAttachmentDraftsForKey(cleared.sessionAttachmentDraftKey(scope));
        expect(cleared.readSessionAttachmentDrafts(scope)).toEqual([]);
    });

    it('refuses a recovery record copied to another Account and preserves its ciphertext', async () => {
        const secure = createDesktopSecureStorageBoundary();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: secure.invoke });
        const owner = await import('./sessionAttachmentDraftStore');
        const memory = await import('./attachmentDraftMemoryStore');
        owner.writeSessionAttachmentDrafts(scope, [pasted]);
        await memory.flushAttachmentDraftsForKey(owner.sessionAttachmentDraftKey(scope));
        const records = await import('@/sync/domains/state/browserRecordStorage');
        const { serverAccountScopedStorageKey } = await import('@/sync/domains/scope/serverAccountScope');
        const originalKey = `${serverAccountScopedStorageKey('composer-attachment-sources-v1', scope)}:${owner.sessionAttachmentDraftKey(scope)}`;
        const sealed = (await records.readBrowserRecord(originalKey))!;
        const another = { ...scope, accountId: 'another-person' };
        const key = owner.sessionAttachmentDraftKey(another);
        const storageKey = `${serverAccountScopedStorageKey('composer-attachment-sources-v1', another)}:${key}`;
        await records.writeBrowserRecord(storageKey, sealed);
        await expect(memory.flushAttachmentDraftsForKey(key)).rejects.toThrow();
        expect(owner.readSessionAttachmentDrafts(another)).toEqual([]);
        expect(await records.readBrowserRecord(storageKey)).toBe(sealed);
    });
});
