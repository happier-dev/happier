import { describe, expect, it } from 'vitest';

function createSessionMediaEnvelope(overrides: Record<string, unknown> = {}) {
    return {
        kind: 'session_media.v1',
        payload: {
            media: [{
                id: 'media-1',
                role: 'output',
                category: 'generated',
                mediaKind: 'image',
                mimeType: 'image/png',
                name: 'generated.png',
                path: '.happier/uploads/generated/session-1/message-1/generated.png',
                sizeBytes: 42,
                width: 1600,
                height: 900,
                origin: { source: 'provider-generated' },
                ...overrides,
            }],
        },
    };
}

describe('parseSessionMediaMessageMeta', () => {
    it('keeps MP4 metadata playable without projecting it as an agent image', async () => {
        const { parseSessionMediaMessageMeta } = await import('./sessionMediaMessageMeta');
        const item = { id: 'movie', role: 'input', category: 'attachment', mediaKind: 'video', mimeType: 'video/mp4',
            name: 'recording.mp4', path: '.happier/uploads/attachments/session-1/message-1/recording.mp4', sizeBytes: 24,
            origin: { source: 'user-upload' } };
        const parsed = parseSessionMediaMessageMeta({ kind: 'session_media.v1', payload: { media: [item] } });
        expect(parsed?.inlineImages).toEqual([]);
        expect(parsed?.inlineMedia).toEqual([expect.objectContaining({ mediaKind: 'video', mimeType: 'video/mp4', name: 'recording.mp4' })]);
    });
    it('reads retained media while dropping unknown source payload fields before security guards', async () => {
        const { parseSessionMediaMessageMeta } = await import('./sessionMediaMessageMeta');
        const raw = createSessionMediaEnvelope({
            data: 'retired-inline-data',
            retired: { sourcePath: '/private/retired.png' },
            origin: { source: 'provider-generated', retired: { url: 'https://retired.example/image.png' } },
        });
        const parsed = parseSessionMediaMessageMeta({
            ...raw,
            payload: { ...raw.payload, failures: [{
                index: 1, code: 'invalid_source_file', role: 'output', category: 'generated', mediaKind: 'image',
                name: 'unavailable.png', origin: { source: 'provider-generated', retired: true }, retired: { data: 'old' },
            }] },
        });

        expect(parsed?.inlineImages).toEqual([
            { id: 'media-1', status: 'available', name: 'generated.png',
                path: '.happier/uploads/generated/session-1/message-1/generated.png', mimeType: 'image/png',
                sizeBytes: 42, width: 1600, height: 900, category: 'generated', role: 'output' },
            { id: 'failure-1', status: 'unavailable', name: 'unavailable.png', category: 'generated', role: 'output',
                failureCode: 'invalid_source_file' },
        ]);
        expect(raw.payload.media[0]).toHaveProperty('data', 'retired-inline-data');
        expect(parseSessionMediaMessageMeta(createSessionMediaEnvelope({ name: '/private/image.png' }))).toBeNull();
        expect(parseSessionMediaMessageMeta(createSessionMediaEnvelope({ mimeType: 'text/plain' }))).toBeNull();
    });
    it('keeps failure-only image rows renderable as unavailable media', async () => {
        const { parseSessionMediaMessageMeta } = await import('./sessionMediaMessageMeta');

        const parsed = parseSessionMediaMessageMeta({
            kind: 'session_media.v1',
            payload: {
                media: [],
                failures: [{
                    index: 0,
                    code: 'invalid_source_file',
                    role: 'output',
                    category: 'generated',
                    mediaKind: 'image',
                    name: 'generated.png',
                    mimeType: 'image/png',
                    origin: { source: 'provider-generated' },
                }],
            },
        });

        expect(parsed?.inlineImages).toEqual([{
            id: 'failure-0',
            status: 'unavailable',
            name: 'generated.png',
            mimeType: 'image/png',
            category: 'generated',
            role: 'output',
            failureCode: 'invalid_source_file',
        }]);
    });

    it('keeps renderable image rows when advisory dimensions are invalid', async () => {
        const { parseSessionMediaMessageMeta } = await import('./sessionMediaMessageMeta');

        const parsed = parseSessionMediaMessageMeta(createSessionMediaEnvelope({
            width: 0,
            height: -20,
        }));

        expect(parsed?.inlineImages).toEqual([{
            id: 'media-1',
            status: 'available',
            name: 'generated.png',
            path: '.happier/uploads/generated/session-1/message-1/generated.png',
            mimeType: 'image/png',
            sizeBytes: 42,
            category: 'generated',
            role: 'output',
        }]);
    });

    it('ignores partial advisory dimensions without dropping the image row', async () => {
        const { parseSessionMediaMessageMeta } = await import('./sessionMediaMessageMeta');

        const parsed = parseSessionMediaMessageMeta(createSessionMediaEnvelope({
            width: 1600,
            height: undefined,
        }));

        const image = parsed?.inlineImages[0];
        expect(image).toMatchObject({
            id: 'media-1',
            status: 'available',
            path: '.happier/uploads/generated/session-1/message-1/generated.png',
        });
        if (!image || image.status === 'unavailable') {
            throw new Error('Expected an available image row');
        }
        expect(image.width).toBeUndefined();
        expect(image.height).toBeUndefined();
    });

    it('continues to reject unsafe media paths', async () => {
        const { parseSessionMediaMessageMeta } = await import('./sessionMediaMessageMeta');

        expect(parseSessionMediaMessageMeta(createSessionMediaEnvelope({
            path: '../outside.png',
        }))).toBeNull();
    });

    it('keeps video media entries as inline media references without treating them as images', async () => {
        const { parseSessionMediaMessageMeta } = await import('./sessionMediaMessageMeta');

        const parsed = parseSessionMediaMessageMeta({
            kind: 'session_media.v1',
            payload: {
                media: [
                    {
                        id: 'recording-1',
                        role: 'output',
                        category: 'tool-artifact',
                        mediaKind: 'video',
                        mimeType: 'video/webm',
                        name: 'recording.webm',
                        path: '.happier/uploads/artifacts/session-1/message-1/recording.webm',
                        sizeBytes: 2048,
                        origin: { source: 'tool-output' },
                    },
                    {
                        id: 'image-1',
                        role: 'output',
                        category: 'generated',
                        mediaKind: 'image',
                        mimeType: 'image/png',
                        name: 'generated.png',
                        path: '.happier/uploads/generated/session-1/message-1/generated.png',
                        sizeBytes: 42,
                        origin: { source: 'provider-generated' },
                    },
                ],
            },
        });

        expect(parsed?.inlineMedia).toEqual([
            {
                id: 'recording-1',
                mediaKind: 'video',
                status: 'available',
                name: 'recording.webm',
                path: '.happier/uploads/artifacts/session-1/message-1/recording.webm',
                mimeType: 'video/webm',
                sizeBytes: 2048,
                category: 'tool-artifact',
                role: 'output',
            },
            {
                id: 'image-1',
                mediaKind: 'image',
                status: 'available',
                name: 'generated.png',
                path: '.happier/uploads/generated/session-1/message-1/generated.png',
                mimeType: 'image/png',
                sizeBytes: 42,
                category: 'generated',
                role: 'output',
            },
        ]);
    });
});
