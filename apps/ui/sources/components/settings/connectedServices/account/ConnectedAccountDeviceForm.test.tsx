import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { colors: { text: { secondary: 'secondary' } } },
    }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

describe('ConnectedAccountDeviceForm', () => {
    it('opens the daemon-provided verification URL and exposes poll and resume commands', async () => {
        const onPoll = vi.fn(async () => {});
        const onResume = vi.fn(async () => {});
        const { ConnectedAccountDeviceForm } = await import('./ConnectedAccountDeviceForm');
        const tree = (await renderScreen(
            <ConnectedAccountDeviceForm
                verificationUri="https://provider.example/device"
                verificationUriComplete="https://provider.example/device?code=ABCD"
                userCode="ABCD"
                busy={false}
                onPoll={onPoll}
                onResume={onResume}
            />,
        )).tree;

        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-device:open'),
        );
        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-device:poll'),
        );
        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-device:resume'),
        );

        expect(openExternalUrlMock).toHaveBeenCalledWith(
            'https://provider.example/device?code=ABCD',
        );
        expect(onPoll).toHaveBeenCalledOnce();
        expect(onResume).toHaveBeenCalledOnce();
        expect(tree.find((node) => node.props.testID === 'connected-account-device:code').props.children)
            .toBe('ABCD');
    });
});
