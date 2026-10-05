import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { Switch } from '@/components/ui/forms/Switch';
import { WalkthroughSavedSettings } from './WalkthroughSavedSettings';

// Native rendering adapters only; the settings store and credential binding remain real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@expo/vector-icons/Ionicons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    const icons = createExpoVectorIconsMock();
    return { default: icons.Ionicons, Ionicons: icons.Ionicons };
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

describe('Prepare walkthrough preference', () => {
    it('allows opting out with an unavailable model but refuses opting in', async () => {
        function Controlled() {
            const [enabled, setEnabled] = React.useState(true);
            return <WalkthroughSavedSettings machineId={null} serverId={null} machineName=""
                prepareAfterTurn={enabled} onPrepareAfterTurn={setEnabled} modelAvailable={false} />;
        }
        const screen = await renderSettingsView(<Controlled />);
        const toggle = () => screen.findAll(node => node.type === Switch)[0];
        expect(toggle().props.value).toBe(true);
        expect(toggle().props.disabled).toBe(false);
        await act(async () => { toggle().props.onValueChange(false); });
        expect(toggle().props.value).toBe(false);
        expect(toggle().props.disabled).toBe(true);
        await act(async () => { toggle().props.onValueChange(true); });
        expect(toggle().props.value).toBe(false);
        await screen.unmount();
    });
});
