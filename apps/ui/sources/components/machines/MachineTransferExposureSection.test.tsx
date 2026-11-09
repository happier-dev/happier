import * as React from 'react';
import { Item } from '@/components/ui/lists/Item';
import { describe, expect, it } from 'vitest';
import { t } from '@/text';

import { renderScreen, findTestInstanceByTypeWithProps } from '@/dev/testkit';
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

describe('MachineTransferExposureSection', () => {
    it.each([
        { enabled: true, configured: false },
        { enabled: false, configured: true },
    ])('presents the typed operator refusal instead of generic listener unavailability (enabled=$enabled)', async ({ enabled, configured }) => {
        const { MachineTransferExposureSection } = await import('./MachineTransferExposureSection');
        const { MachinePublishedTransferRuntimeV1Schema } = await import('@happier-dev/protocol/machines/machinePublishedContentV1');
        const screen = await renderScreen(React.createElement(MachineTransferExposureSection, {
            daemonState: {
                transfer: MachinePublishedTransferRuntimeV1Schema.parse({
                    supported: { import: true, export: true },
                    listenerClasses: {
                        loopback_http: { enabled: true, configured: true, active: true },
                        tailscale_serve_https: { enabled, configured, active: false, available: false,
                            diagnostic: { code: 'tailscale_operator_authorization_refused', retryable: false } },
                    },
                    lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
                }),
            },
        }));
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine.transferExposure.tailscaleServeHttps' })?.props.subtitle)
            .toBe(t('settings.relayAccess.tailscaleOperatorAuthorizationRefused'));
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

        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine.transferExposure.loopbackHttp' })?.props.subtitle).toBe('machine.transferExposure.stateActive');
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine.transferExposure.lanHttp' })).toBeUndefined();
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine.transferExposure.tailscaleServeHttps' })?.props.subtitle).toBe('machine.transferExposure.stateActive');
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

        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine.transferExposure.tailscaleServeHttps' })?.props.subtitle).toBe('machine.transferExposure.stateApprovalNeeded');
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

        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine.transferExposure.tailscaleServeHttps' })?.props.subtitle).toBe('machine.transferExposure.stateStale');
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

        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine.transferExposure.tailscaleServeHttps' })?.props.subtitle).toBe('machine.transferExposure.stateUnavailable');
    });
});
