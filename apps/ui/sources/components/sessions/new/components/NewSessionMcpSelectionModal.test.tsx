import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    View: 'View',
    useWindowDimensions: () => ({ width: 900, height: 800 }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                text: '#fff',
                textSecondary: '#999',
                groupped: { background: '#111' },
                divider: '#333',
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#fff',
                textSecondary: '#999',
                groupped: { background: '#111' },
                divider: '#333',
            },
        },
    }),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/settings/mcpServers/mcpServerUi', () => ({
    resolveAuthBadgeLabel: () => 'auth',
    resolveDetectedAvailabilityLabel: () => 'detected',
    resolvePreviewScopeLabel: () => 'scope',
    resolveAgentToolsDeliveryLabel: (delivery: string) => `delivery:${delivery}`,
    resolveAgentToolsDeliveryDescription: (delivery: string) => `delivery-description:${delivery}`,
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemListStatic: (props: any) => React.createElement('ItemListStatic', props, props.children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

describe('NewSessionMcpSelectionModal', () => {
    it('renders only the error state when preview loading fails for a valid machine and directory', async () => {
        const { NewSessionMcpSelectionModal } = await import('./NewSessionMcpSelectionModal');

        let tree: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <NewSessionMcpSelectionModal
                onClose={vi.fn()}
                machineName="Machine One"
                directory="/workspace"
                agentType="gemini"
                hasContext
                preview={null}
                selection={{ v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] }}
                loading={false}
                    error="RPC method not available"
                    onSelectionChange={vi.fn()}
                    onRefresh={vi.fn()}
                    onOpenSettings={vi.fn()}
                />,
            );
        });

        const items = tree!.root.findAllByType('Item');
        expect(items.some((item) => item.props.testID === 'new-session.mcp.error')).toBe(true);
        expect(items.some((item) => item.props.testID === 'new-session.mcp.empty')).toBe(false);
    });

    it('renders a preview-empty state instead of the no-context state when machine and directory are already selected', async () => {
        const { NewSessionMcpSelectionModal } = await import('./NewSessionMcpSelectionModal');

        let tree: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <NewSessionMcpSelectionModal
                onClose={vi.fn()}
                machineName="Machine One"
                directory="/workspace"
                agentType="gemini"
                hasContext
                preview={null}
                selection={{ v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] }}
                loading={false}
                    error={null}
                    onSelectionChange={vi.fn()}
                    onRefresh={vi.fn()}
                    onOpenSettings={vi.fn()}
                />,
            );
        });

        const items = tree!.root.findAllByType('Item');
        expect(items.some((item) => item.props.title === 'settings.mcpServersPreviewEmptyTitle')).toBe(true);
        expect(items.some((item) => item.props.title === 'newSession.mcpUnavailableNoContextTitle')).toBe(false);
    });

    it('shows the selected backend delivery mode for shell-bridge agents', async () => {
        const { NewSessionMcpSelectionModal } = await import('./NewSessionMcpSelectionModal');

        let tree: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <NewSessionMcpSelectionModal
                    onClose={vi.fn()}
                    machineName="Machine One"
                    directory="/workspace"
                    agentType="gemini"
                    hasContext
                    preview={null}
                    selection={{ v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] }}
                    loading={false}
                    error={null}
                    onSelectionChange={vi.fn()}
                    onRefresh={vi.fn()}
                    onOpenSettings={vi.fn()}
                />,
            );
        });

        const deliveryItem = tree!.root.findAll((item) => item.props?.testID === 'new-session.mcp.delivery')[0];
        expect(deliveryItem).toBeTruthy();
        expect(deliveryItem.props.detail).toBe('delivery:shell_bridge');
        expect(deliveryItem.props.subtitle).toBe('delivery-description:shell_bridge');
    });

    it('does not emit raw text nodes under non-Text parents when icons render as text on web', async () => {
        const { NewSessionMcpSelectionModal } = await import('./NewSessionMcpSelectionModal');

        let tree: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <NewSessionMcpSelectionModal
                    onClose={vi.fn()}
                    machineName="Machine One"
                    directory="/workspace"
                    agentType="gemini"
                    hasContext
                    preview={null}
                    selection={{ v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] }}
                    loading={false}
                    error={null}
                    onSelectionChange={vi.fn()}
                    onRefresh={vi.fn()}
                    onOpenSettings={vi.fn()}
                />,
            );
        });

        const badNodes: Array<{ parent: string | null; value: string }> = [];
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string' || typeof node === 'number') {
                const value = String(node);
                if (parentType !== 'Text' && value.trim().length > 0) badNodes.push({ parent: parentType, value });
                return;
            }
            if (Array.isArray(node)) {
                for (const child of node) walk(child, parentType);
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : parentType;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(tree!.toJSON(), null);
        expect(badNodes).toEqual([]);
    });
});
