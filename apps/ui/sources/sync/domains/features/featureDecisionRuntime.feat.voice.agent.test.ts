import { describe, expect, it } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';

describe('featureDecisionRuntime (feat.voice.agent)', () => {
    it.each(['execution.runs', 'voice.agent', 'voice.daemonInference'] as const)('enables %s by default with Experiments off', async featureId => {
        const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('./featureDecisionRuntime');
        const decision = resolveRuntimeFeatureDecisionFromSnapshot({
            featureId,
            settings: accountSettingsParse({ experiments: false }),
            snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: { voice: { enabled: true } } }) },
            scope: { scopeKind: 'runtime' },
        });
        expect(decision?.state).toBe('enabled');
    });

    it.each([undefined, false])('keeps Voice Agent and Machine speech closed for server Voice bit %s', async enabled => {
        const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('./featureDecisionRuntime');
        for (const featureId of ['voice.agent', 'voice.daemonInference'] as const) {
            const decision = resolveRuntimeFeatureDecisionFromSnapshot({
                featureId,
                settings: accountSettingsParse({ experiments: false }),
                snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: enabled === undefined ? {} : { voice: { enabled } } }) },
                scope: { scopeKind: 'runtime' },
            });
            expect(decision?.state).toBe('disabled');
            expect(decision?.blockedBy).toBe('dependency');
        }
    });

    it('disables a feature when a dependency is locally disabled', async () => {
        const settings = accountSettingsParse({
            experiments: true,
            featureToggles: { 'voice.agent': true, 'execution.runs': false },
        });
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
