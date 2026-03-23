import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: () => <>{'.'}</>,
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
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
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) =>
                params ? `${key}:${JSON.stringify(params)}` : key,
        });
    },
});

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

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex'],
    DEFAULT_AGENT_ID: 'codex',
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

        const screen = await renderScreen(<CliNotDetectedBanner
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
        />);

        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });

    it('renders the warning inside an ItemGroup and Item', async () => {
        const { CliNotDetectedBanner } = await import('./CliNotDetectedBanner');

        const screen = await renderScreen(<CliNotDetectedBanner
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
        />);

        const groups = screen.findAllByType('ItemGroup' as any);
        const items = screen.findAllByType('Item' as any);

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
