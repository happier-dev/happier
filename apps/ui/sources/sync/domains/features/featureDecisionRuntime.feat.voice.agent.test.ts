import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

describe('featureDecisionRuntime (feat.voice.agent)', () => {
    it('disables a feature when a dependency is locally disabled', async () => {
        vi.resetModules();

        const { getStorage } = await import('@/sync/domains/state/storage');
        const storage = getStorage();
        storage.getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'execution.runs': false },
        });

        const settings = storage.getState().settings;
        const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('./featureDecisionRuntime');

        const decision = resolveRuntimeFeatureDecisionFromSnapshot({
            featureId: 'voice.agent',
            settings,
            snapshot: {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: { voice: { enabled: true } },
                    capabilities: { voice: { configured: true, provider: 'elevenlabs' } },
                }),
            },
            scope: { scopeKind: 'runtime' },
        });

        expect(decision).not.toBeNull();
        expect(decision?.state).toBe('disabled');
        expect(decision?.blockedBy).toBe('dependency');
    });
});

