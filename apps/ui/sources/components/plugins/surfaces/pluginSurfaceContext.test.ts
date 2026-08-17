import type { PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it } from 'vitest';

import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';

import { createPluginSurfaceContext } from './pluginSurfaceContext';

const targetedContributions: PluginUiTargetedContributionsV1 = {
    target: {
        pluginId: 'acme.preview',
        immutableGenerationId: 'target-generation-a',
    },
    points: [],
};

describe('createPluginSurfaceContext', () => {
    it('projects the host-stamped mount and exact admitted target snapshot', () => {
        const fixture = createPluginSurfaceContextFixture();
        const targeted = createPluginSurfaceContext({
            mount: fixture.mount,
            target: fixture.target,
            accountEncryptionMode: fixture.accountEncryptionMode,
            environment: {
                platform: fixture.platform,
                locale: fixture.locale,
                direction: fixture.direction,
                colorScheme: fixture.colorScheme,
                contrast: fixture.contrast,
                textScale: fixture.textScale,
                reducedMotion: fixture.reducedMotion,
                screenReaderEnabled: fixture.screenReaderEnabled,
                safeAreaInsets: fixture.safeAreaInsets,
                theme: fixture.theme,
            },
            translations: fixture.translations,
            targetedContributions,
        });

        expect(targeted.mount).toBe(fixture.mount);
        expect(targeted.accountEncryptionMode).toBe(fixture.accountEncryptionMode);
        expect(targeted.targetedContributions).toBe(targetedContributions);
    });
});
