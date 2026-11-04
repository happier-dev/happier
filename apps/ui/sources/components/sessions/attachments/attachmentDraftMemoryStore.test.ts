import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindAttachmentDraftPersistence, flushAttachmentDraftsForKey, moveAttachmentDraftsForKey,
    readAttachmentDraftsForKey, writeAttachmentDraftsForKey, clearAttachmentDraftsForKey } from './attachmentDraftMemoryStore';
import { clearAcceptedNewSessionAttachmentDrafts, clearNewSessionAttachmentDrafts, writeNewSessionAttachmentDrafts } from '../new/attachments/newSessionAttachmentDraftStore';
import type { AttachmentDraft } from './attachmentDraftModel';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('shared attachment source custody', () => {
    it('preserves the immutable environment handle across memory snapshots', () => {
        const source = { kind: 'memory' as const, name: 'chosen.txt', bytes: new Uint8Array([1]) };
        writeAttachmentDraftsForKey('source-custody', [{ id: 'chosen', source, status: 'pending' }]);
        expect(readAttachmentDraftsForKey('source-custody')[0]?.source).toBe(source);
        clearAttachmentDraftsForKey('source-custody');
    });
    it('settles New Session custody without deleting a newer same-id source replacement', () => {
        const selected: AttachmentDraft = { id: 'selected', source: { kind: 'memory', name: 'chosen.txt', bytes: new Uint8Array([1]) }, status: 'pending' };
        const replacement: AttachmentDraft = { ...selected, source: { ...selected.source } };
        writeNewSessionAttachmentDrafts('same-source-flow', [replacement]);
        expect(clearAcceptedNewSessionAttachmentDrafts('same-source-flow', [selected])).toEqual([replacement]);
        clearNewSessionAttachmentDrafts('same-source-flow');
    });
    it('moves cold sources after hydration, preserving intake added while the read is pending', async () => {
        const secure = createDesktopSecureStorageBoundary();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: secure.invoke });
        const scope = { serverId: 'move-home', accountId: 'move-account' };
        const from = 'cold-occurrence';
        const to = 'next-occurrence';
        const source: AttachmentDraft = { id: 'restored', status: 'pending',
            source: { kind: 'memory', name: 'old.txt', bytes: new Uint8Array([1]) } };
        const newer: AttachmentDraft = { id: 'newer', status: 'pending',
            source: { kind: 'memory', name: 'new.txt', bytes: new Uint8Array([2]) } };
        const persistence = await import('./attachmentDraftPersistence');
        await persistence.writeAttachmentDraftRecord(from, scope, [source]);
        const records = await import('@/sync/domains/state/browserRecordStorage');
        const readRecord = records.readBrowserRecord;
        let releaseRead: (() => void) | undefined;
        let startedRead: (() => void) | undefined;
        const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
        const readStarted = new Promise<void>(resolve => { startedRead = resolve; });
        vi.spyOn(records, 'readBrowserRecord').mockImplementation(async key => {
            if (key.endsWith(`:${from}`)) { startedRead?.(); await heldRead; }
            return readRecord(key);
        });
        bindAttachmentDraftPersistence(from, scope);
        bindAttachmentDraftPersistence(to, scope);
        const moving = moveAttachmentDraftsForKey(from, to);
        await readStarted;
        writeAttachmentDraftsForKey(to, [newer]);
        const savedBeforeMove = await records.listBrowserRecords('composer-attachment-sources-v1');
        expect([...savedBeforeMove.keys()].some(key => key.endsWith(`:${from}`))).toBe(true);
        releaseRead?.();
        await moving;
        await Promise.all([flushAttachmentDraftsForKey(from), flushAttachmentDraftsForKey(to)]);
        expect(readAttachmentDraftsForKey(from)).toEqual([]);
        expect(readAttachmentDraftsForKey(to).map(draft => draft.id)).toEqual(['restored', 'newer']);
        expect(await persistence.readAttachmentDraftRecord(from, scope)).toEqual([]);
        expect((await persistence.readAttachmentDraftRecord(to, scope)).map(draft => draft.source)).toEqual([source.source, newer.source]);
    });
});
