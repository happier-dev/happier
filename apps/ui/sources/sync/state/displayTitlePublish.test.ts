import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import {
    publishDisplayTitleMetadataMutation,
    publishDisplayTitleToMetadata,
} from './displayTitlePublish';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('displayTitlePublish', () => {
    it('publishes display.title through the UI metadata update port', async () => {
        const updates: Metadata[] = [];

        await publishDisplayTitleToMetadata({
            sessionId: 's1',
            title: 'Published title',
            updatedAt: 13,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata()));
                return { version: 4 };
            },
        });

        expect(updates).toEqual([
            expect.objectContaining({
                summary: {
                    text: 'Published title',
                    updatedAt: 13,
                },
            }),
        ]);
    });

    it('drops stale display.title candidates through the shared session-state binding', async () => {
        const updates: Metadata[] = [];

        await publishDisplayTitleToMetadata({
            sessionId: 's1',
            title: 'Stale title',
            updatedAt: 12,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata({
                    summary: {
                        text: 'Fresh title',
                        updatedAt: 13,
                    },
                })));
            },
        });

        expect(updates).toEqual([
            expect.objectContaining({
                summary: {
                    text: 'Fresh title',
                    updatedAt: 13,
                },
            }),
        ]);
    });

    it('maps UI metadata port failures to session-state publish errors', async () => {
        await expect(publishDisplayTitleToMetadata({
            sessionId: 's1',
            title: 'Published title',
            updateSessionMetadataWithRetry: async () => {
                throw Object.assign(new Error('conflict'), { code: 'conflict' });
            },
        })).rejects.toThrow('Session state metadata update failed: conflict');
    });

    it('publishes metadata-derived title mutations through the UI engine', async () => {
        const updates: Metadata[] = [];
        const seenMetadata: Metadata[] = [];

        await publishDisplayTitleMetadataMutation({
            sessionId: 's1',
            title: 'Fallback title',
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata({
                    voiceConversation: { title: 'Voice title' },
                })));
            },
            resolveTitle: (metadata) => {
                seenMetadata.push(metadata);
                return (metadata as Metadata & { voiceConversation?: { title?: string } }).voiceConversation?.title
                    ?? 'Fallback title';
            },
            transformAfterTitle: (metadata) => ({
                ...metadata,
                voiceScope: { kind: 'voice_home' },
            } as Metadata),
        });

        expect(updates).toEqual([
            expect.objectContaining({
                summary: {
                    text: 'Voice title',
                    updatedAt: expect.any(Number),
                },
                voiceScope: { kind: 'voice_home' },
            }),
        ]);
        expect(seenMetadata).toEqual([
            expect.objectContaining({
                voiceConversation: { title: 'Voice title' },
            }),
        ]);
    });
});
