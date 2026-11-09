import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { SETTINGS_PAGE_DECLARATIONS } from '@/components/settings/catalog/settingsPageDeclarations';
import { buildSettingHref } from '@/components/settings/catalog/settingDeclarations';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { settingsDefaults } from '@/sync/domains/settings/settings';

function hrefFor(anchor: string): string | null {
    const declaration = SETTINGS_PAGE_DECLARATIONS.find((page) => Object.values(page.settings).some((setting) => setting.anchor === anchor));
    if (!declaration?.subpage) return null;
    const setting = Object.values(declaration.settings).find((candidate) => candidate.anchor === anchor)!;
    return buildSettingHref(declaration.subpage.route as string, setting);
}

describe('Workflow run settings search', () => {
    it('finds run capacity and retention on the Workflows run settings page', () => {
        expect(hrefFor('settings.workflowRuns.maxActiveRunsPerMachine'))
            .toBe('/workflows/settings?setting=settings.workflowRuns.maxActiveRunsPerMachine');
        expect(hrefFor('settings.workflowRuns.runRetention'))
            .toBe('/workflows/settings?setting=settings.workflowRuns.runRetention');
    });

    it('offers them only while Workflows is on', () => {
        const declaration = SETTINGS_PAGE_DECLARATIONS.find((page) => page.subpage?.id === 'workflowRuns');
        expect(declaration).toBeDefined();
        const features = createRootLayoutFeaturesResponse({ features: {
            workflows: { enabled: false }, automations: { enabled: true },
        } });
        for (const setting of Object.values(declaration!.settings)) {
            if (!setting.featureId) throw new Error(`Run setting ${setting.anchor} must declare its feature`);
            expect(resolveRuntimeFeatureDecisionFromSnapshot({
                featureId: setting.featureId,
                settings: settingsDefaults,
                snapshot: { status: 'ready', features },
            })).toMatchObject({ featureId: 'workflows', state: 'disabled', blockedBy: 'server' });
        }
    });
});
