import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

import { PluginSurfaceFallback } from './PluginSurfaceFallback';

describe('PluginSurfaceFallback', () => {
    it('forwards a caller-owned recovery action to the canonical state card', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <PluginSurfaceFallback
                testID="plugin-surface-unavailable"
                action={{ label: 'Manage plugin', onPress }}
            />,
        );

        await act(async () => {
            screen.pressByTestId('plugin-surface-unavailable-action');
        });

        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('owns diagnostic-to-copy presentation without exposing the raw host reason', async () => {
        const props = {
            testID: 'plugin-surface-unavailable',
            reasonCode: 'hosted_web_bridge_timeout',
        } as React.ComponentProps<typeof PluginSurfaceFallback> & Readonly<{
            reasonCode: string;
        }>;
        const screen = await renderScreen(<PluginSurfaceFallback {...props} />);

        expect(screen.getTextContent()).toContain(t('pluginRuntime.hostedWebBridgeTimeout'));
        expect(screen.getTextContent()).not.toContain('hosted_web_bridge_timeout');
        expect(screen.findByTestId(
            'plugin-surface-unavailable-diagnostic-hosted_web_bridge_timeout',
        )).toBeTruthy();
    });
});
