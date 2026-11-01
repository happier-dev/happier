import { describe, expect, it } from 'vitest';

import { parseSessionMediaMessageMeta } from './sessionMediaMessageMeta';

function buildSessionMediaMeta(path: string): unknown {
    return {
        happier: {
            kind: 'session_media.v1',
            payload: {
                media: [
                    {
                        id: 'media-1',
                        role: 'output',
                        category: 'generated',
                        mediaKind: 'image',
                        name: 'generated.png',
                        path,
                        mimeType: 'image/png',
                        sizeBytes: 10,
                        origin: { source: 'provider-generated' },
                    },
                ],
            },
        },
    };
}

describe('parseSessionMediaMessageMeta', () => {
    it('treats absent media envelopes as an empty projection', () => {
        for (const meta of [undefined, null, {}, { happier: null }, { happierMedia: null }]) {
            expect(parseSessionMediaMessageMeta(meta)).toEqual({
                inlineImages: [], unavailableMedia: [], legacyAttachments: null,
            });
        }
    });

    it('preserves a bounded generated description for generic presentation', () => {
        const meta = buildSessionMediaMeta('.happier/uploads/generated/message-1/generated.png') as {
            happier: { payload: { media: Array<Record<string, unknown>> } };
        };
        meta.happier.payload.media[0]!.description = 'Architecture diagram';

        expect(parseSessionMediaMessageMeta(meta).inlineImages[0]).toMatchObject({
            description: 'Architecture diagram',
        });
    });

    it('preserves optional image dimensions for transcript layout', () => {
        const parsed = parseSessionMediaMessageMeta({
            happier: {
                kind: 'session_media.v1',
                payload: {
                    media: [
                        {
                            id: 'media-1',
                            role: 'output',
                            category: 'generated',
                            mediaKind: 'image',
                            name: 'wide.png',
                            path: '.happier/uploads/generated/message-1/wide.png',
                            mimeType: 'image/png',
                            sizeBytes: 10,
                            width: 1600,
                            height: 900,
                            origin: { source: 'provider-generated' },
                        },
                    ],
                },
            },
        });

        expect(parsed.inlineImages[0]).toMatchObject({
            width: 1600,
            height: 900,
        });
    });

    it('ignores public URL and embedded-data media paths', () => {
        for (const path of [
            'https://example.test/generated.png',
            'http://example.test/generated.png',
            'blob:https://example.test/generated',
            'data:image/png;base64,AAAA',
        ]) {
            expect(parseSessionMediaMessageMeta(buildSessionMediaMeta(path)).inlineImages).toEqual([]);
        }
    });

    it('uses the canonical session-media schema for paths, MIME, size, and identifier bounds', () => {
        const validPath = '.happier/uploads/generated/message-1/generated.png';
        const mutations: Array<(item: Record<string, unknown>) => void> = [
            (item) => { item.path = '.happier\\uploads\\generated\\message-1\\generated.png'; },
            (item) => { item.path = '.happier/uploads//generated.png'; },
            (item) => { item.path = '.happier/uploads/./generated.png'; },
            (item) => { item.mimeType = 'image/html'; },
            (item) => { item.sizeBytes = 0; },
            (item) => { item.id = 'x'.repeat(513); },
            (item) => { item.origin = { source: 'provider-generated', toolCallId: 'x'.repeat(16_385) }; },
        ];

        for (const mutate of mutations) {
            const meta = buildSessionMediaMeta(validPath) as {
                happier: { payload: { media: Array<Record<string, unknown>> } };
            };
            mutate(meta.happier.payload.media[0]!);
            expect(parseSessionMediaMessageMeta(meta).inlineImages).toEqual([]);
        }
    });

    it('rejects an oversized durable media envelope before iterating render items', () => {
        const meta = buildSessionMediaMeta('.happier/uploads/generated/message-1/generated.png') as {
            happier: { payload: { media: Array<Record<string, unknown>> } };
        };
        const item = meta.happier.payload.media[0]!;
        meta.happier.payload.media = Array.from({ length: 257 }, (_, index) => ({
            ...item,
            id: `media-${index}`,
        }));

        expect(parseSessionMediaMessageMeta(meta).inlineImages).toEqual([]);
    });

    it('returns a path-free unavailable render state from the canonical envelope', () => {
        const unavailable = {
            id: 'b'.repeat(64),
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            code: 'provider_file_unavailable',
            origin: {
                source: 'provider-generated',
                agentId: 'cursor',
                toolCallIdHash: 'c'.repeat(64),
            },
        } as const;

        const parsed = parseSessionMediaMessageMeta({
            happier: {
                kind: 'session_media.v1',
                payload: { media: [], unavailable: [unavailable] },
            },
        });

        expect(parsed.inlineImages).toEqual([]);
        expect(parsed.unavailableMedia).toEqual([{
            id: unavailable.id,
            category: 'generated',
            code: 'provider_file_unavailable',
        }]);
        expect(JSON.stringify(parsed.unavailableMedia)).not.toContain('cursor');
        expect(JSON.stringify(parsed.unavailableMedia)).not.toContain('toolCallId');
    });
});
