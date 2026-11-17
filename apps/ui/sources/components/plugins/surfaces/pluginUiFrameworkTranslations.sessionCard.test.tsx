import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createHostApiStub, createSurfaceContext } from '../../../../../../packages/plugin-ui/src/surfaceFixture.testSupport';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));

import { SessionCard } from '@happier-dev/plugin-ui';
import { PluginUiProvider } from '@happier-dev/plugin-ui/advanced';
import { t } from '@/text';
import { resolvePluginUiFrameworkTranslations } from './pluginUiFrameworkTranslations';

describe('hosted Session card read facts', () => {
    it.each(['failed', 'unsupported', 'missing'] as const)('preserves %s through the host translations', async (outcome) => {
        const context = createSurfaceContext({ translations: resolvePluginUiFrameworkTranslations() });
        const base = createHostApiStub(context);
        // The host API is the read boundary; its reader, card and translation owner stay real.
        const hostApi = createHostApiStub(context, {
            version: () => ({ ...base.version(), methods: outcome === 'unsupported' ? [] : ['readSession'] }),
            readSession: async () => {
                if (outcome === 'failed') throw new Error('Host unavailable');
                return null;
            },
        });
        const screen = await renderScreen(<PluginUiProvider context={context} hostApi={hostApi}>
            <SessionCard sessionId="linked" onOpen={() => undefined} />
        </PluginUiProvider>);
        try {
            const expected = outcome === 'missing' ? t('errors.sessionNotFound') : t('common.unavailable');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(expected));
            if (outcome !== 'missing') expect(screen.getTextContent()).not.toContain(t('errors.sessionNotFound'));
        } finally { await screen.unmount(); }
    });
});
