import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectedAccountDeviceForm } from './ConnectedAccountDeviceForm';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));

describe('ConnectedAccountDeviceForm', () => {
    it('opens the daemon-provided verification URL while automatic approval checks wait without duplicate recovery controls', async () => {
        const onPoll = vi.fn(async () => {});
        const onResume = vi.fn(async () => {});
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

        expect(openExternalUrlMock).toHaveBeenCalledWith(
            'https://provider.example/device?code=ABCD',
        );
        expect(tree.findAll((node) => node.props.testID === 'connected-account-device:poll')).toHaveLength(0);
        expect(tree.findAll((node) => node.props.testID === 'connected-account-device:resume')).toHaveLength(0);
        expect(onPoll).not.toHaveBeenCalled();
        expect(onResume).not.toHaveBeenCalled();
        expect(tree.find((node) => node.props.testID === 'connected-account-device:code').props.children)
            .toBe('ABCD');
    });

    it('offers a new code after the provider expiry, without an inoperable check action', async () => {
        const onResume = vi.fn();
        const screen = await renderScreen(<ConnectedAccountDeviceForm userCode="ABCD" expiresAtMs={Date.now() - 1000}
            busy={false} onPoll={vi.fn()} onResume={onResume} />);
        expect(screen.tree.findAll((node) => node.props.testID === 'connected-account-device:poll')).toHaveLength(0);
        await pressTestInstanceAsync(screen.tree.find((node) => node.props.testID === 'connected-account-device:resume'));
        expect(onResume).toHaveBeenCalledOnce();
    });
    it('lets the owner cancel an active device sign-in before its code expires', async () => {
        const onCancel = vi.fn();
        const screen = await renderScreen(<ConnectedAccountDeviceForm userCode="ABCD"
            busy={false} onPoll={vi.fn()} onResume={vi.fn()} onCancel={onCancel} />);

        await pressTestInstanceAsync(screen.tree.find((node) => node.props.testID === 'connected-account-setup:cancel'));

        expect(onCancel).toHaveBeenCalledOnce();
        expect(screen.tree.findAll((node) => node.props.testID === 'connected-account-device:resume')).toHaveLength(0);
    });
});
