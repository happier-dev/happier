import { describe, expect, it } from 'vitest';

describe('featureDecisionRuntime (feat.voice.daemonInference)', () => {
    it('disables voice.daemonInference when voice.agent is locally disabled', async () => {
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: {
                voice: true,
                'execution.runs': true,
                'voice.agent': false,
                'voice.daemonInference': true,
            },
        });

        const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('./featureDecisionRuntime');

        const decision = resolveRuntimeFeatureDecisionFromSnapshot({
            featureId: 'voice.daemonInference',
            settings: getStorage().getState().settings,
            snapshot: { status: 'loading' },
            scope: { scopeKind: 'runtime' },
        });

        expect(decision).not.toBeNull();
        expect(decision?.state).toBe('disabled');
        expect(decision?.blockedBy).toBe('dependency');
        expect(decision?.blockerCode).toBe('dependency_disabled');
    });
});
