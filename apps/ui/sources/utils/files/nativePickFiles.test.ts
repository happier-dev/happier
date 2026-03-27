import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-document-picker', () => ({
    getDocumentAsync: vi.fn(async () => ({ canceled: true })),
}));

describe('nativePickFiles', () => {
    it('returns web File sources when expo-document-picker provides `asset.file`', async () => {
        const DocumentPicker = await import('expo-document-picker');
        const file = new File([new Uint8Array([1, 2, 3])], 'note.txt', { type: 'text/plain' });

        (DocumentPicker.getDocumentAsync as any).mockResolvedValueOnce({
            canceled: false,
            assets: [
                {
                    uri: 'blob://fake',
                    name: 'note.txt',
                    size: file.size,
                    mimeType: 'text/plain',
                    file,
                },
            ],
        });

        const { nativePickFiles } = await import('./nativePickFiles');
        const picked = await nativePickFiles({ multiple: false });

        expect(picked).toEqual([{ kind: 'web', file }]);
    });
});
