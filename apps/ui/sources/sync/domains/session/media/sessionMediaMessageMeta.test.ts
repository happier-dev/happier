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
    it('keeps renderable image rows when advisory dimensions are invalid', async () => {
        const { parseSessionMediaMessageMeta } = await import('./sessionMediaMessageMeta');

        const parsed = parseSessionMediaMessageMeta(createSessionMediaEnvelope({
            width: 0,
            height: -20,
        }));

        expect(parsed?.inlineImages).toEqual([{
            id: 'media-1',
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

        expect(parsed?.inlineImages[0]).toMatchObject({
            id: 'media-1',
            path: '.happier/uploads/generated/session-1/message-1/generated.png',
        });
        expect(parsed?.inlineImages[0]?.width).toBeUndefined();
        expect(parsed?.inlineImages[0]?.height).toBeUndefined();
    });

    it('continues to reject unsafe media paths', async () => {
        const { parseSessionMediaMessageMeta } = await import('./sessionMediaMessageMeta');

        expect(parseSessionMediaMessageMeta(createSessionMediaEnvelope({
            path: '../outside.png',
        }))).toBeNull();
    });
});
