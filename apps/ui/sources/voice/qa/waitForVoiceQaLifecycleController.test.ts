import { describe, expect, it, vi } from 'vitest';

import { waitForVoiceQaLifecycleController } from './waitForVoiceQaLifecycleController';

describe('waitForVoiceQaLifecycleController', () => {
    it('waits for the production lifecycle owner instead of treating startup order as an idle session', async () => {
        const controller = { toggle: vi.fn(async () => {}) };
        const getController = vi
            .fn<() => typeof controller | null>()
            .mockReturnValueOnce(null)
            .mockReturnValue(controller);

        const resolved = await waitForVoiceQaLifecycleController({
            getController,
            timeoutMs: 100,
            wait: async () => {},
        });

        expect(resolved).toBe(controller);
        expect(getController).toHaveBeenCalledTimes(2);
    });

    it('waits until the production owner has consumed the configured provider', async () => {
        const controller = { configuredProviderId: null as string | null };
        let waits = 0;

        const resolved = await waitForVoiceQaLifecycleController({
            getController: () => controller,
            isReady: (candidate) => candidate.configuredProviderId === 'local_conversation',
            timeoutMs: 100,
            wait: async () => {
                waits += 1;
                controller.configuredProviderId = 'local_conversation';
            },
        });

        expect(resolved).toBe(controller);
        expect(waits).toBe(1);
    });

    it('fails explicitly when the production lifecycle owner never becomes ready', async () => {
        let now = 0;

        await expect(waitForVoiceQaLifecycleController({
            getController: () => null,
            now: () => now,
            timeoutMs: 100,
            wait: async () => {
                now += 50;
            },
        })).rejects.toThrow('voice_qa_media_lifecycle_unavailable');
    });
});
