import { describe, expect, it, vi } from 'vitest';

import { createCodexAppServerStreamLifecycle } from './createCodexAppServerStreamLifecycle';

describe('createCodexAppServerStreamLifecycle', () => {
    it('commits Codex app-server image generation media through the central session media bridge', async () => {
        const sendAgentSessionMediaCommitted = vi.fn(async () => undefined);
        const lifecycle = createCodexAppServerStreamLifecycle({
            session: {
                sendAgentSessionMediaCommitted,
            } as any,
            readLastObservedMessageSeq: () => 0,
            getPendingTurn: () => null,
        });

        await lifecycle.applyStreamUpdate(
            {
                type: 'session-media',
                itemId: 'img_1',
                media: [{
                    source: { kind: 'base64', data: 'iVBORw0KGgo=', mimeType: 'image/png', fileNameHint: 'img_1.png' },
                    origin: { source: 'provider-generated', generationId: 'img_1', providerEventId: 'img_1' },
                }],
                meta: { codexImageGenerationV1: { revisedPrompt: 'safe prompt' } },
            },
            { sidechainId: null, streamScopeId: 'turn_1' },
        );

        expect(sendAgentSessionMediaCommitted).toHaveBeenCalledWith('codex', {
            localId: 'codex-media-img_1',
            role: 'output',
            category: 'generated',
            media: [{
                source: { kind: 'base64', data: 'iVBORw0KGgo=', mimeType: 'image/png', fileNameHint: 'img_1.png' },
                origin: { source: 'provider-generated', generationId: 'img_1', providerEventId: 'img_1' },
            }],
            meta: { codexImageGenerationV1: { revisedPrompt: 'safe prompt' } },
        });
    });
});
