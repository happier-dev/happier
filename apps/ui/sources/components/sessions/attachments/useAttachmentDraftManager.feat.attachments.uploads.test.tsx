import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: () => { },
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'draft-1',
}));

describe('useAttachmentDraftManager (attachments.uploads)', () => {
    it('keeps onRemove defined while uploading so UI can disable it (not hide it)', async () => {
        (globalThis as any).URL ??= {};
        (globalThis as any).URL.createObjectURL ??= () => 'blob:test';
        (globalThis as any).URL.revokeObjectURL ??= () => { };

        const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 25 * 1024 * 1024 }));
        const manager = () => hook.getCurrent();

        const file = typeof File === 'function'
            ? new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
            : ({ name: 'image.png', size: 3, type: 'image/png', slice: () => new Blob([new Uint8Array([1, 2, 3])]) } as any);

        act(() => {
            manager().addWebFiles([file as any]);
        });

        expect(manager().drafts).toHaveLength(1);
        expect(manager().drafts[0]!.id).toBe('draft-1');

        act(() => {
            manager().applyDraftPatch('draft-1', { status: 'uploading' });
        });

        expect(manager().agentInputAttachments).toHaveLength(1);
        expect(manager().agentInputAttachments[0]!.status).toBe('uploading');
        expect(manager().agentInputAttachments[0]!.onRemove).toEqual(expect.any(Function));
    });

    it('skips web previews safely when URL globals are unavailable', async () => {
        const originalUrl = globalThis.URL;
        // @ts-expect-error test deletes URL to simulate missing browser global
        delete globalThis.URL;

        try {
            const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
            const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 25 * 1024 * 1024 }));
            const manager = () => hook.getCurrent();

            const file = typeof File === 'function'
                ? new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
                : ({ name: 'image.png', size: 3, type: 'image/png', slice: () => new Blob([new Uint8Array([1, 2, 3])]) } as File);

            expect(() => {
                act(() => {
                    manager().addWebFiles([file]);
                });
            }).not.toThrow();
            expect(manager().agentInputAttachments[0]?.preview).toBeUndefined();
        } finally {
            Object.defineProperty(globalThis, 'URL', {
                configurable: true,
                value: originalUrl,
            });
        }
    });
});
