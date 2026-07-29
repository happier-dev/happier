import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    groupped: {
                        sectionTitle: 'title',
                    },
                },
            },
        });
    },
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement('Group', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

describe('MachineTransferExposureSection', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('renders listener class states from daemonState.transfer', async () => {
        const { MachineTransferExposureSection } = await import('./MachineTransferExposureSection');
        const screen = await renderScreen(React.createElement(MachineTransferExposureSection, {
            daemonState: {
                transfer: {
                    supported: { import: true, export: true },
                    listenerClasses: {
                        loopback_http: { enabled: true, configured: true, active: true, available: true },
                        tailscale_serve_https: { enabled: true, configured: true, active: true, available: true },
                    },
                    lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
                },
            },
        }));

        expect(screen.findByTestId('machine.transferExposure.loopbackHttp')?.props.subtitle).toBe('machine.transferExposure.stateActive');
        expect(screen.findByTestId('machine.transferExposure.lanHttp')).toBeNull();
        expect(screen.findByTestId('machine.transferExposure.tailscaleServeHttps')?.props.subtitle).toBe('machine.transferExposure.stateActive');
    });

    it('renders approval-needed for tailscale serve when enabled but not configured', async () => {
        const { MachineTransferExposureSection } = await import('./MachineTransferExposureSection');
        const screen = await renderScreen(React.createElement(MachineTransferExposureSection, {
            daemonState: {
                transfer: {
                    supported: { import: true, export: true },
                    listenerClasses: {
                        loopback_http: { enabled: true, configured: true, active: true, available: true },
                        tailscale_serve_https: { enabled: true, configured: false, active: false, available: true },
                    },
                    lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
                },
            },
        }));

        expect(screen.findByTestId('machine.transferExposure.tailscaleServeHttps')?.props.subtitle).toBe('machine.transferExposure.stateApprovalNeeded');
    });

    it('renders stale for tailscale serve when configured but inactive', async () => {
        const { MachineTransferExposureSection } = await import('./MachineTransferExposureSection');
        const screen = await renderScreen(React.createElement(MachineTransferExposureSection, {
            daemonState: {
                transfer: {
                    supported: { import: true, export: true },
                    listenerClasses: {
                        loopback_http: { enabled: true, configured: true, active: true, available: true },
                        tailscale_serve_https: { enabled: true, configured: true, active: false, available: true },
                    },
                    lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
                },
            },
        }));

        expect(screen.findByTestId('machine.transferExposure.tailscaleServeHttps')?.props.subtitle).toBe('machine.transferExposure.stateStale');
    });

    it('renders unavailable for tailscale serve when it is configured but unavailable', async () => {
        const { MachineTransferExposureSection } = await import('./MachineTransferExposureSection');
        const screen = await renderScreen(React.createElement(MachineTransferExposureSection, {
            daemonState: {
                transfer: {
                    supported: { import: true, export: true },
                    listenerClasses: {
                        loopback_http: { enabled: true, configured: true, active: true, available: true },
                        tailscale_serve_https: { enabled: true, configured: true, active: false, available: false },
                    },
                    lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
                },
            },
        }));

        expect(screen.findByTestId('machine.transferExposure.tailscaleServeHttps')?.props.subtitle).toBe('machine.transferExposure.stateUnavailable');
    });
});
