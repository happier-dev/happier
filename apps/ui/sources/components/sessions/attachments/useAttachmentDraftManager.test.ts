import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import { useAttachmentDraftManager } from './useAttachmentDraftManager';
import type { AttachmentDraft } from './attachmentDraftModel';

describe('useAttachmentDraftManager', () => {
    it('keeps the 19 unaffected picture projections when one occurrence is replaced', async () => {
        const initialDrafts: readonly AttachmentDraft[] = Array.from({ length: 20 }, (_, i) => ({
            id: String(i), status: 'pending', source: { kind: 'memory', name: `Picture${i}.png`, mimeType: 'image/png', bytes: new Uint8Array([i]), previewUri: `blob:picture-${i}` },
        }));
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024, initialDrafts }));
        try {
            const previous = hook.getCurrent().agentInputAttachments;
            await act(async () => { hook.getCurrent().replaceDrafts(initialDrafts.map((draft, i) => i === 3
                ? { ...draft, source: { kind: 'memory', name: 'Edited.png', mimeType: 'image/png', bytes: new Uint8Array([99]), previewUri: 'blob:edited' } } : draft)); });
            const next = hook.getCurrent().agentInputAttachments;
            expect(next[3]).not.toBe(previous[3]);
            for (let i = 0; i < 20; i++) if (i !== 3) expect(next[i]).toBe(previous[i]);
        } finally { await hook.unmount(); }
    });
    it('owns one preview URL per current web image and releases replaced, removed and unmounted images', async () => {
        const liveUrls = new Set<string>();
        let created = 0;
        let revoked = 0;
        const originalUrl = globalThis.URL;
        class PreviewUrl extends originalUrl {
            static createObjectURL() {
                const url = `blob:preview-${++created}`;
                liveUrls.add(url);
                return url;
            }
            static revokeObjectURL(url: string) {
                expect(liveUrls.delete(url)).toBe(true);
                revoked += 1;
            }
        }
        vi.stubGlobal('URL', PreviewUrl);
        const image = (index: number): AttachmentDraft => ({
            id: 'picture', status: 'pending',
            source: { kind: 'web', file: new File([String(index)], `picture-${index}.png`, { type: 'image/png' }) },
        });
        const initialDrafts = [image(0)];
        const hook = await renderHook(() => useAttachmentDraftManager({
            enabled: true, maxFileBytes: 1024, initialDrafts,
        }));
        try {
            expect(created).toBe(1);
            for (let index = 1; index <= 20; index += 1) {
                await act(async () => { hook.getCurrent().replaceDrafts([image(index)]); });
                expect(created).toBe(index + 1);
                expect(revoked).toBe(index);
                expect(liveUrls.size).toBe(1);
                expect(hook.getCurrent().agentInputAttachments[0]?.preview?.uri).toBe(`blob:preview-${index + 1}`);
                await act(async () => { hook.getCurrent().applyDraftPatch('picture', { status: 'uploading' }); });
                await act(async () => {
                    const draft = hook.getCurrent().getDraftsSnapshot()[0]!;
                    hook.getCurrent().replaceDrafts([{ ...draft, source: { ...draft.source } }]);
                });
                expect(created).toBe(index + 1);
                expect(revoked).toBe(index);
            }
            await act(async () => { hook.getCurrent().replaceDrafts([{
                id: 'picture', status: 'pending', source: { kind: 'memory', name: 'notes.txt', bytes: new Uint8Array([1]) },
            }]); });
            expect(liveUrls.size).toBe(0);
            expect(hook.getCurrent().agentInputAttachments[0]?.preview).toBeUndefined();
            await act(async () => { hook.getCurrent().replaceDrafts([image(21)]); });
            await act(async () => { hook.getCurrent().removeDraft('picture'); });
            expect(liveUrls.size).toBe(0);
            await act(async () => { hook.getCurrent().replaceDrafts([image(22)]); });
            expect(liveUrls.size).toBe(1);
        } finally {
            await hook.unmount();
            vi.unstubAllGlobals();
        }
        expect(liveUrls.size).toBe(0);
        expect(revoked).toBe(created);
    });

    it('keeps the manager object and its callbacks referentially stable across parent re-renders', async () => {
        // The manager is consumed by memoized composer/transcript surfaces; a fresh object per
        // render cascades into per-commit re-renders of every visible transcript row.
        const hook = await renderHook(() => useAttachmentDraftManager({
            enabled: true,
            maxFileBytes: 1024,
        }));

        const first = hook.getCurrent();
        await hook.rerender();
        const second = hook.getCurrent();

        expect(second).toBe(first);
        expect(second.replaceDrafts).toBe(first.replaceDrafts);
        expect(second.removeDraft).toBe(first.removeDraft);
        expect(second.clearDrafts).toBe(first.clearDrafts);
        expect(second.removeSubmittedDrafts).toBe(first.removeSubmittedDrafts);
        expect(second.addWebFiles).toBe(first.addWebFiles);
        expect(second.addPickedAttachments).toBe(first.addPickedAttachments);
        expect(second.applyDraftPatch).toBe(first.applyDraftPatch);
        expect(second.getDraftsSnapshot).toBe(first.getDraftsSnapshot);
        expect(second.getDraftRevisionSnapshot).toBe(first.getDraftRevisionSnapshot);
    });

    it('returns a new manager identity when drafts change', async () => {
        const hook = await renderHook(() => useAttachmentDraftManager({
            enabled: true,
            maxFileBytes: 1024,
        }));

        const before = hook.getCurrent();
        await act(async () => {
            before.replaceDrafts([{
                id: 'draft-1',
                source: { kind: 'memory', name: 'a.txt', bytes: new Uint8Array([1]) },
                status: 'pending',
            } as never]);
        });

        const after = hook.getCurrent();
        expect(after).not.toBe(before);
        expect(after.drafts).toHaveLength(1);
        expect(after.hasSendableAttachments).toBe(true);
    });

    it('advances the draft revision for an explicit clear even when drafts are already empty', async () => {
        const hook = await renderHook(() => useAttachmentDraftManager({
            enabled: true,
            maxFileBytes: 1024,
        }));

        const before = hook.getCurrent().getDraftRevisionSnapshot();
        await act(async () => {
            hook.getCurrent().clearDrafts();
        });

        expect(hook.getCurrent().drafts).toEqual([]);
        expect(hook.getCurrent().getDraftRevisionSnapshot()).toBe(before + 1);
    });

    it('publishes the current process-local snapshot synchronously with each mutation', async () => {
        const hook = await renderHook(() => useAttachmentDraftManager({
            enabled: true,
            maxFileBytes: 1024,
        }));

        const manager = hook.getCurrent();
        const nextDraft = {
            id: 'draft-immediate',
            source: { kind: 'memory', name: 'instant.txt', bytes: new Uint8Array([1]) },
            status: 'pending',
        } as const;

        await act(async () => {
            manager.replaceDrafts([nextDraft]);
            expect(manager.getDraftsSnapshot()).toEqual([nextDraft]);

            manager.clearDrafts();
            expect(manager.getDraftsSnapshot()).toEqual([]);
        });
    });

    it('removes unchanged submitted sources after upload while preserving new drafts and same-ID source replacements', async () => {
        const replaced: AttachmentDraft = { id: 'replaced', status: 'pending',
            source: { kind: 'memory', name: 'picture.png', bytes: new Uint8Array([1]) } };
        const uploaded: AttachmentDraft = { id: 'uploaded', status: 'pending',
            source: { kind: 'native', name: 'notes.txt', uri: 'file:///notes.txt', sizeBytes: 1 } };
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024,
            initialDrafts: [replaced, uploaded] }));
        const manager = hook.getCurrent();
        const submitted = manager.getDraftsSnapshot();
        const replacement: AttachmentDraft = { ...replaced,
            source: { kind: 'memory', name: 'picture.png', bytes: new Uint8Array([2]) } };
        const additional: AttachmentDraft = { id: 'additional', status: 'pending',
            source: { kind: 'memory', name: 'later.txt', bytes: new Uint8Array([3]) } };
        await act(async () => {
            manager.applyDraftPatch(uploaded.id, { status: 'uploaded', uploadedPath: 'uploaded/notes.txt',
                uploadProgress: { uploadedBytes: 1, totalBytes: 1 } });
            manager.replaceDrafts([replacement, manager.getDraftsSnapshot()[1]!, additional]);
            const revision = manager.getDraftRevisionSnapshot();
            const remaining = manager.removeSubmittedDrafts(submitted);
            expect(remaining).toEqual([replacement, additional]);
            expect(manager.getDraftsSnapshot()).toBe(remaining);
            expect(manager.getDraftRevisionSnapshot()).toBe(revision + 1);
        });
        expect(hook.getCurrent().drafts).toEqual([replacement, additional]);
    });

    it('does not invalidate a newer source snapshot when no submitted draft remains', async () => {
        const captured: AttachmentDraft = { id: 'same-id', status: 'pending',
            source: { kind: 'memory', name: 'a.txt', bytes: new Uint8Array([1]) } };
        const replacement: AttachmentDraft = { ...captured, source: { ...captured.source } };
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024,
            initialDrafts: [replacement] }));
        const manager = hook.getCurrent();
        const before = manager.getDraftsSnapshot();
        const revision = manager.getDraftRevisionSnapshot();
        await act(async () => {
            expect(manager.removeSubmittedDrafts([captured])).toBe(before);
        });
        expect(manager.getDraftRevisionSnapshot()).toBe(revision);
        expect(hook.getCurrent().drafts).toEqual([replacement]);
    });

    it('refuses a late upload checkpoint for a replaced source while retaining explicit two-argument patches', async () => {
        const captured: AttachmentDraft = { id: 'source-choice', status: 'pending',
            source: { kind: 'memory', name: 'a.txt', bytes: new Uint8Array([1]) } };
        const replacement: AttachmentDraft = { ...captured,
            source: { kind: 'memory', name: 'b.txt', bytes: new Uint8Array([2]) } };
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024,
            initialDrafts: [captured] }));
        const manager = hook.getCurrent();
        await act(async () => {
            manager.applyDraftPatch(captured.id, { status: 'uploading' }, captured.source);
            expect(manager.getDraftsSnapshot()[0]?.status).toBe('uploading');
            manager.replaceDrafts([replacement]);
            const revision = manager.getDraftRevisionSnapshot();
            manager.applyDraftPatch(captured.id, { status: 'uploaded', uploadedPath: 'old-source.txt',
                uploadedSizeBytes: 1, sha256: 'old-source-digest' }, captured.source);
            expect(manager.getDraftsSnapshot()).toEqual([replacement]);
            expect(manager.getDraftRevisionSnapshot()).toBe(revision);
            manager.applyDraftPatch(replacement.id, { status: 'error', error: 'explicit edit' });
            expect(manager.getDraftsSnapshot()).toEqual([{ ...replacement, status: 'error', error: 'explicit edit' }]);
        });
    });
});
