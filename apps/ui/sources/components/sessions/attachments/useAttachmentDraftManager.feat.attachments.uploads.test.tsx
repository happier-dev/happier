import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/modal', () => ({
    Modal: {
        alert: () => { },
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'draft-1',
}));

describe('useAttachmentDraftManager (attachments.uploads)', () => {
    it('keeps onRemove defined while uploading so UI can disable it (not hide it)', async () => {
        (globalThis as any).URL ??= {};
        (globalThis as any).URL.createObjectURL ??= () => 'blob:test';
        (globalThis as any).URL.revokeObjectURL ??= () => { };

        const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');

        let manager: ReturnType<typeof useAttachmentDraftManager> | null = null;
        function Harness() {
            manager = useAttachmentDraftManager({ enabled: true, maxFileBytes: 25 * 1024 * 1024 });
            return null;
        }

        act(() => {
            renderer.create(React.createElement(Harness));
        });

        const file = typeof File === 'function'
            ? new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
            : ({ name: 'image.png', size: 3, type: 'image/png', slice: () => new Blob([new Uint8Array([1, 2, 3])]) } as any);

        act(() => {
            manager!.addWebFiles([file as any]);
        });

        expect(manager!.drafts).toHaveLength(1);
        expect(manager!.drafts[0]!.id).toBe('draft-1');

        act(() => {
            manager!.applyDraftPatch('draft-1', { status: 'uploading' });
        });

        expect(manager!.agentInputAttachments).toHaveLength(1);
        expect(manager!.agentInputAttachments[0]!.status).toBe('uploading');
        expect(manager!.agentInputAttachments[0]!.onRemove).toEqual(expect.any(Function));
    });
});

