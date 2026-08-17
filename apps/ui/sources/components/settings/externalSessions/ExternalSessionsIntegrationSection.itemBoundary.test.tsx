import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const accessibilityPlatform = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios' | 'android',
}));
const announceForAccessibilityMock = vi.hoisted(() => vi.fn());

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const base = await createReactNativeWebMock();
        return {
            ...base,
            AccessibilityInfo: {
                ...base.AccessibilityInfo,
                announceForAccessibility: announceForAccessibilityMock,
            },
            Platform: {
                ...base.Platform,
                get OS() {
                    return accessibilityPlatform.os;
                },
            },
        };
    },
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => 'single',
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => ({}),
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => key === 'uiFontScale' ? 1 : 'comfortable',
}));

vi.mock('@/components/ui/icons/SafeIonicons', () => ({
    SafeIonicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: any) => React.createElement('VirtualizedList', props),
}));

vi.mock('@/components/settings/plugins/diagnostics/PluginDiagnosticsSection', () => ({
    PluginDiagnosticsSection: (props: any) => React.createElement('PluginDiagnosticsSection', props),
}));

function findHostNodeByTestID(
    nodes: readonly ReactTestInstance[],
): ReactTestInstance | undefined {
    return nodes.find((node) => typeof node.type === 'string');
}

describe('ExternalSessionsIntegrationSection Item boundary', () => {
    beforeEach(() => {
        standardCleanup();
        accessibilityPlatform.os = 'web';
        announceForAccessibilityMock.mockClear();
    });

    it('renders the retry status as an accessible keyboard-focusable press target', async () => {
        const retryInventory = vi.fn(async () => {});
        const { ExternalSessionsIntegrationSection } = await import(
            './ExternalSessionsIntegrationSection'
        );
        const screen = await renderScreen(
            <ExternalSessionsIntegrationSection
                integrations={[]}
                autoLinkSources={[]}
                machineId="machine-1"
                agent={null}
                inventoryState={{
                    status: 'error',
                    diagnosticCodes: ['operation_failed'],
                }}
                onRetryInventory={retryInventory}
            />,
        );

        const retry = findHostNodeByTestID(
            screen.findAllByTestId('settings-external-sessions-inventory-status'),
        );
        expect(retry?.type).toBe('Pressable');
        expect(retry?.props.role).toBe('button');
        expect(retry?.props.tabIndex).toBe(0);
        expect(retry?.props['aria-label']).toBeTruthy();

        await act(async () => {
            retry?.props.onPress();
            await Promise.resolve();
        });

        expect(retryInventory).toHaveBeenCalledOnce();
    });

    it('uses one polite loading status that becomes one assertive inventory alert', async () => {
        const { ExternalSessionsIntegrationSection } = await import(
            './ExternalSessionsIntegrationSection'
        );
        const screen = await renderScreen(
            <ExternalSessionsIntegrationSection
                integrations={[]}
                autoLinkSources={[]}
                machineId="machine-1"
                agent={null}
                inventoryState={{
                    status: 'loading',
                    diagnosticCodes: [],
                }}
            />,
        );

        const loading = screen.findByTestId('settings-external-sessions-inventory-announcement');
        expect(loading?.props.accessibilityLiveRegion).toBe('polite');
        expect(loading?.props.role).toBe('status');
        expect(loading?.props['aria-live']).toBe('polite');
        expect(screen.tree.root.findAllByProps({ accessibilityLiveRegion: 'polite' })).toHaveLength(1);

        accessibilityPlatform.os = 'ios';
        await act(async () => {
            screen.tree.update(
                <ExternalSessionsIntegrationSection
                    integrations={[]}
                    autoLinkSources={[]}
                    machineId="machine-1"
                    agent={null}
                    inventoryState={{
                        status: 'error',
                        diagnosticCodes: ['operation_failed'],
                    }}
                    onRetryInventory={async () => {}}
                />,
            );
        });

        const error = screen.findByTestId('settings-external-sessions-inventory-announcement');
        expect(error?.props.accessibilityRole).toBe('alert');
        expect(error?.props.accessibilityLiveRegion).toBe('assertive');
        expect(error?.props.role).toBe('alert');
        expect(error?.props['aria-live']).toBe('assertive');
        expect(screen.tree.root.findAllByProps({ accessibilityLiveRegion: 'assertive' })).toHaveLength(1);
        expect(announceForAccessibilityMock).toHaveBeenCalledOnce();
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            'externalSessions.settingsIntegrationInventoryErrorTitle. externalSessions.settingsIntegrationInventoryErrorSubtitle',
        );
        expect(announceForAccessibilityMock).not.toHaveBeenCalledWith(
            expect.stringContaining('operation_failed'),
        );

        await act(async () => {
            screen.tree.update(
                <ExternalSessionsIntegrationSection
                    integrations={[]}
                    autoLinkSources={[]}
                    machineId="machine-1"
                    agent={null}
                    inventoryState={{
                        status: 'ready',
                        diagnosticCodes: [],
                    }}
                />,
            );
        });
        await act(async () => {
            screen.tree.update(
                <ExternalSessionsIntegrationSection
                    integrations={[]}
                    autoLinkSources={[]}
                    machineId="machine-1"
                    agent={null}
                    inventoryState={{
                        status: 'error',
                        diagnosticCodes: ['operation_failed'],
                    }}
                    onRetryInventory={async () => {}}
                />,
            );
        });

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(2);
    });
});
