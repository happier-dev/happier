import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

function ThrowingSurface(): React.ReactElement {
    throw new Error('plugin render failure');
}

function HealthySurface(): React.ReactElement {
    return React.createElement('View', { testID: 'plugin-rn-ui-healthy' });
}

describe('PluginUiBoundary', () => {
    it('contains render crashes and reports the failed surface once', async () => {
        const onCrash = vi.fn();
        const { PluginUiBoundary } = await import('./PluginUiBoundary');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const screen = await renderScreen(
                <PluginUiBoundary surfaceId="surface_1" onCrash={onCrash}>
                    <ThrowingSurface />
                </PluginUiBoundary>,
            );

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
            expect(onCrash).toHaveBeenCalledTimes(1);
            expect(onCrash).toHaveBeenCalledWith('surface_1', expect.any(Error));
        } finally {
            consoleError.mockRestore();
        }
    });

    it('recovers a crashed surface only after its immutable artifact identity changes', async () => {
        const onCrash = vi.fn();
        const { PluginUiBoundary } = await import('./PluginUiBoundary');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const screen = await renderScreen(
                <PluginUiBoundary surfaceId="surface_1" resetKey="artifact_1" onCrash={onCrash}>
                    <ThrowingSurface />
                </PluginUiBoundary>,
            );

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();

            await screen.update(
                <PluginUiBoundary surfaceId="surface_1" resetKey="artifact_1" onCrash={onCrash}>
                    <HealthySurface />
                </PluginUiBoundary>,
            );
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-healthy')).toBeNull();

            await screen.update(
                <PluginUiBoundary surfaceId="surface_1" resetKey="artifact_2" onCrash={onCrash}>
                    <HealthySurface />
                </PluginUiBoundary>,
            );
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(screen.findByTestId('plugin-rn-ui-healthy')).toBeTruthy();
            expect(onCrash).toHaveBeenCalledTimes(1);
        } finally {
            consoleError.mockRestore();
        }
    });
});
