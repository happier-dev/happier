import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedAccountDeviceForm } from './ConnectedAccountDeviceForm';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installSignedOutAuthForTest } from '@/dev/testkit/fixtures/signedOutAuth';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';

const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));

await import('@/sync/ops/actions/defaultActionExecutor');

describe('ConnectedAccountDeviceForm', () => {
    let restoreAuth: () => void;
    beforeEach(async () => {
        restoreAuth = installSignedOutAuthForTest();
    });
    afterEach(() => restoreAuth());
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

        await vi.waitFor(() => expect(openExternalUrlMock).toHaveBeenCalledWith(
            'https://provider.example/device?code=ABCD',
        ));
        expect(tree.findAll((node) => node.props.testID === 'connected-account-device:poll')).toHaveLength(0);
        expect(tree.findAll((node) => node.props.testID === 'connected-account-device:resume')).toHaveLength(0);
        expect(onPoll).not.toHaveBeenCalled();
        expect(onResume).not.toHaveBeenCalled();
        expect(tree.find((node) => node.props.testID === 'connected-account-device:code').props.children)
            .toBe('ABCD');
    });

    it('reads as one status row: the code, where to enter it and the wait, with Open as the one primary', async () => {
        const screen = await renderScreen(<ConnectedAccountDeviceForm verificationUri="https://chatgpt.com/device" userCode="WDJB-MJHT"
            expiresAtMs={Date.now() + 60_000} serviceTitle="ChatGPT" busy={false} onPoll={vi.fn()} onResume={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.findByTestId('connected-account-device:steps')).toBeNull();
        const status = screen.tree.find((node) => node.props.testID === 'connected-account-device:status');
        const statusIds = status.findAll((node) => typeof node.props.testID === 'string').map((node) => node.props.testID);
        expect(statusIds).toEqual(expect.arrayContaining(['connected-account-device:code', 'connected-account-device:where',
            'connected-account-device:copy']));
        expect(statusIds).not.toContain('connected-account-device:open');
        expect(screen.findByTestId('connected-account-device:open')).not.toBeNull();
    });

    it('offers a new code after the provider expiry, without an inoperable check action', async () => {
        const onResume = vi.fn();
        const screen = await renderScreen(<ConnectedAccountDeviceForm userCode="ABCD" expiresAtMs={Date.now() - 1000}
            busy={false} onPoll={vi.fn()} onResume={onResume} />);
        expect(screen.tree.findAll((node) => node.props.testID === 'connected-account-device:poll')).toHaveLength(0);
        expect(screen.findByTestId('connected-account-device:open')).toBeNull();
        await pressTestInstanceAsync(screen.tree.find((node) => node.props.testID === 'connected-account-device:resume'));
        expect(onResume).toHaveBeenCalledOnce();
    });

    it('retires the countdown at expiry and restarts it for a new code', async () => {
        vi.useFakeTimers();
        const census = installTimerCensus();
        try {
            const now = Date.now();
            const props = { userCode: 'ABCD', busy: false, onPoll: vi.fn(), onResume: vi.fn() };
            const screen = await renderScreen(<ConnectedAccountDeviceForm {...props} expiresAtMs={now + 2000} />);
            await act(async () => { vi.advanceTimersByTime(2000); });
            expect(screen.findByTestId('connected-account-device:resume')).not.toBeNull();
            expect(vi.getTimerCount()).toBe(0);
            const firesAtExpiry = census.readFires();
            await act(async () => { vi.advanceTimersByTime(60_000); });
            expect(vi.getTimerCount()).toBe(0);
            expect(census.readFires()).toEqual(firesAtExpiry);
            expect(props.onPoll).not.toHaveBeenCalled();
            await screen.update(<ConnectedAccountDeviceForm {...props} expiresAtMs={Date.now() + 2000} />);
            expect(screen.findByTestId('connected-account-device:resume')).toBeNull();
            expect(vi.getTimerCount()).toBe(1);
            await screen.unmount();
        } finally { census.stop(); vi.useRealTimers(); }
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
