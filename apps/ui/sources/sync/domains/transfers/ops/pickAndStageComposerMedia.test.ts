import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

const documentPicker = vi.hoisted(() => ({
    getDocumentAsync: vi.fn(),
}));
const uploadComposerMediaStageFromReaderSpy = vi.hoisted(() => vi.fn());
const getComposerMediaContentAvailabilitySpy = vi.hoisted(() => vi.fn());

vi.mock('expo-document-picker', () => documentPicker);
vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    getComposerMediaContentAvailability: (params: unknown) => getComposerMediaContentAvailabilitySpy(params),
    uploadComposerMediaStageFromReader: (params: unknown) => uploadComposerMediaStageFromReaderSpy(params),
}));

const executionTarget = { serverId: 'server-1', machineId: 'machine-1' } as const;
const owner = { pluginId: 'acme.issues', localId: 'issue' } as const;

describe('pickAndStageComposerMedia', () => {
    afterEach(() => {
        documentPicker.getDocumentAsync.mockReset();
        uploadComposerMediaStageFromReaderSpy.mockReset();
        getComposerMediaContentAvailabilitySpy.mockReset();
    });

    it('does not open the picker when the target daemon does not negotiate Composer media content', async () => {
        getComposerMediaContentAvailabilitySpy.mockResolvedValueOnce({ available: false });

        const { pickAndStageComposerMedia } = await import('./pickAndStageComposerMedia');

        await expect(pickAndStageComposerMedia({
            executionTarget,
            owner,
            kinds: ['image'],
        })).resolves.toBeNull();

        expect(getComposerMediaContentAvailabilitySpy).toHaveBeenCalledWith({
            executionTarget,
            signal: null,
        });
        expect(documentPicker.getDocumentAsync).not.toHaveBeenCalled();
        expect(uploadComposerMediaStageFromReaderSpy).not.toHaveBeenCalled();
    });

    it('stages exactly one requested image through the transfer carrier with its streamed digest', async () => {
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        const file = new File([bytes], 'hero.png', { type: 'image/png' });
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const handle = {
            v: 1,
            id: 'stage-1',
            executionTarget,
            owner,
            mediaKind: 'image' as const,
            mimeType: 'image/png' as const,
            name: 'hero.png',
            sizeBytes: bytes.byteLength,
            sha256,
        };
        documentPicker.getDocumentAsync.mockResolvedValueOnce({
            canceled: false,
            assets: [{ file, uri: 'blob:hero', name: 'hero.png', mimeType: 'image/png' }],
        });
        getComposerMediaContentAvailabilitySpy.mockResolvedValueOnce({
            available: true,
            capability: 'composer.mediaContent.v1',
        });
        uploadComposerMediaStageFromReaderSpy.mockImplementationOnce(async (params: {
            fileReader: Readonly<{
                sizeBytes: number;
                readBytes: (offset: number, length: number) => Promise<Uint8Array>;
                close: () => Promise<void>;
            }>;
        }) => {
            expect(params.fileReader.sizeBytes).toBe(bytes.byteLength);
            expect(await params.fileReader.readBytes(0, bytes.byteLength)).toEqual(bytes);
            await params.fileReader.close();
            return { success: true, handle };
        });

        const { pickAndStageComposerMedia } = await import('./pickAndStageComposerMedia');

        await expect(pickAndStageComposerMedia({
            executionTarget,
            owner,
            kinds: ['image'],
        })).resolves.toEqual(handle);

        expect(documentPicker.getDocumentAsync).toHaveBeenCalledWith({
            multiple: false,
            type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        });
        expect(uploadComposerMediaStageFromReaderSpy).toHaveBeenCalledWith(expect.objectContaining({
            executionTarget,
            owner,
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'hero.png',
            sha256,
        }));
    });

    it('fails closed when the platform returns a non-media MIME despite the requested filter', async () => {
        const file = new File([new Uint8Array([1, 2, 3])], 'notes.pdf', { type: 'application/pdf' });
        getComposerMediaContentAvailabilitySpy.mockResolvedValueOnce({
            available: true,
            capability: 'composer.mediaContent.v1',
        });
        documentPicker.getDocumentAsync.mockResolvedValueOnce({
            canceled: false,
            assets: [{ file, uri: 'blob:notes', name: 'notes.pdf', mimeType: 'application/pdf' }],
        });

        const { pickAndStageComposerMedia } = await import('./pickAndStageComposerMedia');

        await expect(pickAndStageComposerMedia({
            executionTarget,
            owner,
            kinds: ['image', 'video'],
        })).resolves.toBeNull();
        expect(uploadComposerMediaStageFromReaderSpy).not.toHaveBeenCalled();
    });
});
