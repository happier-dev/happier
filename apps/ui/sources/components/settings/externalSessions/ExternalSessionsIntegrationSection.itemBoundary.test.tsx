import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

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
});
