import { describe, expect, it } from 'vitest';
import { SessionModelSelectionIntentV1Schema } from '@happier-dev/protocol';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import { writeUiSessionStateField } from './engine';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('writeUiSessionStateField', () => {
    it('routes UI writes through the session-state engine metadata port', async () => {
        const updates: Metadata[] = [];

        const result = await writeUiSessionStateField({
            sessionId: 's1',
            fieldId: 'intent.model',
            value: SessionModelSelectionIntentV1Schema.parse({
                v: 1,
                updatedAt: 12,
                selection: {
                    agentTargetKey: 'backend:gemini',
                    providerConnectionId: null,
                    modelId: 'gemini-2.5-pro',
                },
            }),
            metadataReason: 'ui-model-override',
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata()));
                return { version: 7 };
            },
        });

        expect(result).toEqual({ ok: true, version: 7 });
        expect(updates).toEqual([
            expect.objectContaining({
                modelSelectionIntentV1: {
                    v: 1,
                    updatedAt: 12,
                    selection: {
                        agentTargetKey: 'backend:gemini',
                        providerConnectionId: null,
                        modelId: 'gemini-2.5-pro',
                    },
                },
            }),
        ]);
    });

    it('lets the UI title publisher preserve explicit title timestamps through the engine port', async () => {
        const updates: Metadata[] = [];

        const result = await writeUiSessionStateField({
            sessionId: 's1',
            fieldId: 'display.title',
            value: { title: 'Published title', updatedAt: 13 },
            metadataReason: 'ui-display-title',
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata()));
                return { version: 8 };
            },
            metadataPostprocess: (metadata) => ({
                ...metadata,
                voiceScope: { kind: 'voice_home' },
            }),
        });

        expect(result).toEqual({ ok: true, version: 8 });
        expect(updates).toEqual([
            expect.objectContaining({
                summary: {
                    text: 'Published title',
                    updatedAt: 13,
                },
                voiceScope: { kind: 'voice_home' },
            }),
        ]);
    });

    it('maps UI metadata authorization failures to forbidden', async () => {
        const result = await writeUiSessionStateField({
            sessionId: 's1',
            fieldId: 'display.title',
            value: { title: 'Published title', updatedAt: 13 },
            metadataReason: 'ui-display-title',
            updateSessionMetadataWithRetry: async () => {
                throw new Error('not authenticated');
            },
        });

        expect(result).toEqual({ ok: false, reason: 'forbidden' });
    });

    it('maps canonical forbidden ACK failures to forbidden', async () => {
        const result = await writeUiSessionStateField({
            sessionId: 's1',
            fieldId: 'display.title',
            value: { title: 'Published title', updatedAt: 13 },
            metadataReason: 'ui-display-title',
            updateSessionMetadataWithRetry: async () => {
                throw Object.assign(new Error('Forbidden session metadata update'), {
                    code: 'forbidden' as const,
                });
            },
        });

        expect(result).toEqual({ ok: false, reason: 'forbidden' });
    });

    it('passes maxAttempts through the UI metadata update port', async () => {
        const calls: unknown[] = [];

        const result = await writeUiSessionStateField({
            sessionId: 's1',
            fieldId: 'display.title',
            value: { title: 'Published title', updatedAt: 13 },
            metadataReason: 'ui-display-title',
            maxAttempts: 3,
            updateSessionMetadataWithRetry: async (sessionId, updater, opts) => {
                calls.push({
                    sessionId,
                    opts,
                    metadata: updater(buildMetadata()),
                });
                return { version: 9 };
            },
        });

        expect(result).toEqual({ ok: true, version: 9 });
        expect(calls).toEqual([{
            sessionId: 's1',
            opts: { maxAttempts: 3 },
            metadata: expect.objectContaining({
                summary: { text: 'Published title', updatedAt: 13 },
            }),
        }]);
    });
});
