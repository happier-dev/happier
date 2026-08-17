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

    it('renders the family fallback instead of the generic notice when one is supplied', async () => {
        const onCrash = vi.fn();
        const { PluginUiBoundary } = await import('./PluginUiBoundary');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const screen = await renderScreen(
                <PluginUiBoundary
                    surfaceId="structured-message_1"
                    onCrash={onCrash}
                    fallback={React.createElement('View', { testID: 'structured-message-summary-fallback' })}
                >
                    <ThrowingSurface />
                </PluginUiBoundary>,
            );

            expect(screen.findByTestId('structured-message-summary-fallback')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(onCrash).toHaveBeenCalledTimes(1);
        } finally {
            consoleError.mockRestore();
        }
    });

    it('renders a hidden family fallback as nothing rather than the generic notice', async () => {
        const { PluginUiBoundary } = await import('./PluginUiBoundary');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const screen = await renderScreen(
                <PluginUiBoundary surfaceId="structured-message_2" fallback={null}>
                    <ThrowingSurface />
                </PluginUiBoundary>,
            );

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
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

    it('isolates a new mount attempt from a sibling attempt that crashed on the same artifact', async () => {
        const { PluginUiBoundary } = await import('./PluginUiBoundary');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const boundaryProps = (mountInstanceKey: string) => ({
            surfaceId: 'surface_1',
            resetKey: 'artifact_1',
            // This is intentionally supplied as a spread object while the
            // public prop is introduced by the GREEN change below. The old
            // boundary accepts the runtime property but ignores it, so this
            // proves the behavior rather than a TypeScript declaration.
            mountInstanceKey,
        });

        try {
            const screen = await renderScreen(
                <PluginUiBoundary {...boundaryProps('instance-a')}>
                    <ThrowingSurface />
                </PluginUiBoundary>,
            );

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();

            await screen.update(
                <PluginUiBoundary {...boundaryProps('instance-b')}>
                    <HealthySurface />
                </PluginUiBoundary>,
            );

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(screen.findByTestId('plugin-rn-ui-healthy')).toBeTruthy();
        } finally {
            consoleError.mockRestore();
        }
    });
});
