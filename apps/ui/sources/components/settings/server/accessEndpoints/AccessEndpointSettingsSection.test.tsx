import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { AccessEndpointRemediationAction } from '@/sync/domains/accessEndpoints/model';
import type { AccessChannel } from '@/sync/domains/accessEndpoints/channels/model';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options?.web ?? options?.default,
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: { children?: React.ReactNode; title?: React.ReactNode; footer?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

function channel(overrides: Partial<AccessChannel>): AccessChannel {
    return {
        id: 'access-channel:relay-access:tailscaleServe',
        label: 'Tailscale Serve',
        direction: 'make-current-server-reachable',
        kind: 'relay-access-provider',
        endpointIds: ['relay-access:tailscaleServe'],
        recommendedUse: 'multi-device',
        limitations: [],
        remediationActionIds: [],
        ...overrides,
    };
}

function remediationAction(overrides: Partial<AccessEndpointRemediationAction>): AccessEndpointRemediationAction {
    return {
        id: 'sshTunnel.authenticate',
        label: 'sshTunnel.authenticate',
        ownerSurface: 'sshTunnel.authenticate',
        payload: { leaseId: 'lease-a' },
        ...overrides,
    };
}

describe('AccessEndpointSettingsSection', () => {
    it('groups access channels by direction and keeps SSH tunnel tradeoffs visible during refresh', async () => {
        const { AccessEndpointSettingsSection } = await import('./AccessEndpointSettingsSection');

        const screen = await renderScreen(React.createElement(AccessEndpointSettingsSection, {
            isRefreshing: true,
            channels: [
                channel({ id: 'access-channel:relay-access:tailscaleServe' }),
                channel({
                    id: 'access-channel:ssh-tunnel-native:lease-a',
                    label: 'Phone SSH tunnel',
                    direction: 'reach-remote-server-from-this-device',
                    kind: 'ssh-tunnel-native',
                    endpointIds: ['ssh-tunnel-native:lease-a'],
                    recommendedUse: 'native-this-device',
                    limitations: [
                        { id: 'lease-a:this-device-only', severity: 'info', reason: 'this-device-only' },
                        { id: 'lease-a:not-hosted-web-compatible', severity: 'info', reason: 'not-hosted-web-compatible' },
                        { id: 'lease-a:not-public-share-url', severity: 'info', reason: 'not-public-share-url' },
                        { id: 'lease-a:session-scoped', severity: 'info', reason: 'session-scoped' },
                        { id: 'lease-a:foreground-only', severity: 'info', reason: 'foreground-only' },
                    ],
                }),
            ],
        }));

        expect(screen.findByTestId('settings.server.accessEndpoints.group.make-current-server-reachable')?.props.accessibilityLabel).toBe(
            'settings.accessEndpoints.direction.makeCurrentServerReachable',
        );
        expect(screen.findByTestId('settings.server.accessEndpoints.group.reach-remote-server-from-this-device')?.props.accessibilityLabel).toBe(
            'settings.accessEndpoints.direction.reachRemoteServerFromThisDevice',
        );
        expect(screen.findByTestId('settings.server.accessEndpoints.refreshing')).toBeTruthy();
        expect(screen.findByTestId('settings.server.accessEndpoints.channel:access-channel:ssh-tunnel-native:lease-a')).toBeTruthy();
        expect(screen.findByTestId('settings.server.accessEndpoints.channel:access-channel:ssh-tunnel-native:lease-a.recommendedUse')?.props.title).toBe(
            'settings.accessEndpoints.recommendedUse.native-this-device',
        );
        expect(screen.findByTestId('settings.server.accessEndpoints.channel:access-channel:ssh-tunnel-native:lease-a.limitation.this-device-only')).toBeTruthy();
        expect(screen.findByTestId('settings.server.accessEndpoints.channel:access-channel:ssh-tunnel-native:lease-a.limitation.not-hosted-web-compatible')).toBeTruthy();
        expect(screen.findByTestId('settings.server.accessEndpoints.channel:access-channel:ssh-tunnel-native:lease-a.limitation.not-public-share-url')).toBeTruthy();
        expect(screen.findByTestId('settings.server.accessEndpoints.channel:access-channel:ssh-tunnel-native:lease-a.limitation.session-scoped')).toBeTruthy();
        expect(screen.findByTestId('settings.server.accessEndpoints.channel:access-channel:ssh-tunnel-native:lease-a.limitation.foreground-only')).toBeTruthy();
    });

    it('invokes remediation only from explicit card actions with channel context', async () => {
        const onRemediationActionPress = vi.fn();
        const { AccessEndpointSettingsSection } = await import('./AccessEndpointSettingsSection');
        const action = remediationAction({});
        const nativeChannel = channel({
            id: 'access-channel:ssh-tunnel-native:lease-a',
            direction: 'reach-remote-server-from-this-device',
            kind: 'ssh-tunnel-native',
            endpointIds: ['ssh-tunnel-native:lease-a'],
            recommendedUse: 'native-this-device',
            remediationActionIds: [action.id],
        });

        const screen = await renderScreen(React.createElement(AccessEndpointSettingsSection, {
            channels: [nativeChannel],
            remediationActions: [action],
            onRemediationActionPress,
        }));

        expect(onRemediationActionPress).not.toHaveBeenCalled();

        screen.pressByTestId('settings.server.accessEndpoints.channel:access-channel:ssh-tunnel-native:lease-a.action:sshTunnel.authenticate');

        expect(onRemediationActionPress).toHaveBeenCalledWith({
            action,
            channel: nativeChannel,
        });
    });
});
