import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                                React.createElement('View', props, props.children),
                                            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                                React.createElement('Text', props, props.children),
                                            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                                React.createElement('Pressable', props, props.children),
                                            ActivityIndicator: (props: Record<string, unknown>) => React.createElement('ActivityIndicator', props),
                                            Dimensions: {
                                                get: () => ({ width: 1440, height: 900 }),
                                            },
                                            Platform: {
                                            OS: 'web',
                                            select: (value: Record<string, unknown>) => value.web ?? value.default ?? value.ios ?? value.android,
                                        },
                                            Linking: { openURL: vi.fn() },
                                        }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown> & {
        title?: React.ReactNode;
        subtitle?: React.ReactNode;
        icon?: React.ReactNode;
        rightElement?: React.ReactNode;
    }) => {
        const renderNode = (node: React.ReactNode): React.ReactNode => {
            if (node == null || typeof node === 'boolean') return null;
            if (typeof node === 'string' || typeof node === 'number') {
                return React.createElement('Text', null, String(node));
            }
            if (Array.isArray(node)) return node.map(renderNode);
            if (React.isValidElement(node)) {
                if (node.type === React.Fragment) {
                    return React.createElement(
                        React.Fragment,
                        null,
                        React.Children.map((node as React.ReactElement<{ children?: React.ReactNode }>).props.children, renderNode),
                    );
                }
                if (typeof node.type === 'function') {
                    return renderNode((node.type as (props: Record<string, unknown>) => React.ReactNode)(node.props as Record<string, unknown>));
                }
                const hostNode = node as React.ReactElement<{ children?: React.ReactNode }>;
                return React.cloneElement(
                    hostNode,
                    undefined,
                    React.Children.map(hostNode.props.children, renderNode),
                );
            }
            return node;
        };

        return React.createElement(
            'Item',
            props,
            React.createElement('View', null, renderNode(props.icon)),
            React.createElement('View', null, renderNode(props.title), renderNode(props.subtitle)),
            React.createElement('View', null, renderNode(props.rightElement)),
        );
    },
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex'],
    getAgentCore: () => ({
        displayNameKey: 'agents.codex',
        cli: {
            installBanner: {
                installKind: 'guide',
                guideUrl: 'https://example.test/install',
            },
        },
    }),
}));

describe('CliNotDetectedBanner', () => {
    it('does not emit raw text nodes under non-Text parents when icons render as text on web', async () => {
        const { CliNotDetectedBanner } = await import('./CliNotDetectedBanner');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CliNotDetectedBanner
                    agentId={'codex' as any}
                    theme={{
                        colors: {
                            warning: '#d97706',
                            text: '#111827',
                            textSecondary: '#6b7280',
                            textLink: '#2563eb',
                            box: { warning: { background: '#fff8e1', border: '#f5d38f' } },
                        },
                    }}
                    onDismiss={() => {}}
                />)).tree;

        const badNodes: Array<{ parent: string | null; value: string }> = [];
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string') {
                if (parentType !== 'Text' && node.trim().length > 0) badNodes.push({ parent: parentType, value: node });
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

        walk(tree.toJSON(), null);

        expect(badNodes).toEqual([]);
    });

    it('renders the warning inside an ItemGroup and Item', async () => {
        const { CliNotDetectedBanner } = await import('./CliNotDetectedBanner');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CliNotDetectedBanner
                    agentId={'codex' as any}
                    theme={{
                        colors: {
                            warning: '#d97706',
                            text: '#111827',
                            textSecondary: '#6b7280',
                            textLink: '#2563eb',
                            box: { warning: { background: '#fff8e1', border: '#f5d38f' } },
                        },
                    }}
                    onDismiss={() => {}}
                />)).tree;

        const groups = tree.root.findAllByType('ItemGroup' as any);
        const items = tree.root.findAllByType('Item' as any);

        expect(groups).toHaveLength(1);
        expect(items).toHaveLength(1);
        expect(groups[0].props.containerStyle).toEqual(expect.objectContaining({
            backgroundColor: '#fff8e1',
            borderColor: '#f5d38f',
            borderWidth: 1,
        }));
        expect(items[0].props.title).toBe('newSession.cliBanners.cliNotDetectedTitle:{"cli":"agents.codex"}');
        expect(items[0].props.showChevron).toBe(false);
        expect(items[0].props.subtitle).toBeTruthy();
        expect(items[0].props.rightElement).toBeTruthy();
    });
});
