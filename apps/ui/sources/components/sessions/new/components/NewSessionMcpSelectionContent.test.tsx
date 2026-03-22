import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';


import type { SessionMcpSelectionV1 } from '@happier-dev/protocol';
import { createCapturingComponent, createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capturedItems: Array<Record<string, unknown>> = [];
const capturedItemGroups: Array<Record<string, unknown>> = [];

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    View: createPassThroughComponent('View'),
                                    Pressable: createPassThroughComponent('Pressable'),
                                    ScrollView: createPassThroughComponent('ScrollView'),
                                }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: createPassThroughComponent('Ionicons'),
}));

vi.mock('react-native-unistyles', async () => await createUnistylesMock({
    theme: {
        colors: {
            groupped: { background: '#f5f5f5' },
            surface: '#fff',
            divider: '#ddd',
            textSecondary: '#666',
        },
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemListStatic']));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createCapturingComponent('ItemGroup', (props) => {
        capturedItemGroups.push(props);
    }),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: createCapturingComponent('Item', (props) => {
        capturedItems.push(props);
    }),
}));
vi.mock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));
vi.mock('@/text', () => createTextModuleMock());

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        getAgentCore: () => ({
            tools: {
                delivery: 'full',
            },
        }),
    };
});

vi.mock('@/components/settings/mcpServers/mcpServerUi', () => ({
    resolveAgentToolsDeliveryDescription: () => 'Tool delivery description',
    resolveAgentToolsDeliveryLabel: () => 'Tool delivery label',
    resolveAuthBadgeLabel: () => 'Auth',
    resolveDetectedAvailabilityLabel: () => 'Detected',
    resolvePreviewScopeLabel: () => 'Scope',
}));

vi.mock('@/components/sessions/new/modules/sessionMcpSelectionState', () => ({
    setManagedSessionMcpServersEnabled: vi.fn((selection: SessionMcpSelectionV1, enabled: boolean) => ({
        ...selection,
        managedServersEnabled: enabled,
    })),
    toggleManagedSessionMcpSelection: vi.fn((selection: SessionMcpSelectionV1, entry: { serverId: string; selected?: boolean }) => ({
        ...selection,
        forceIncludeServerIds: entry.selected ? [] : [entry.serverId],
        forceExcludeServerIds: entry.selected ? [entry.serverId] : [],
    })),
}));

describe('NewSessionMcpSelectionContent', () => {
    it('renders a visible loading row while preview data is being fetched', async () => {
        capturedItems.length = 0;
        capturedItemGroups.length = 0;

        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        await renderScreen(<NewSessionMcpSelectionContent
                    machineName="Builder"
                    directory="/repo"
                    agentType="claude"
                    hasContext={true}
                    preview={null}
                    selection={{
                        v: 1,
                        managedServersEnabled: true,
                        forceIncludeServerIds: [],
                        forceExcludeServerIds: [],
                    }}
                    loading={true}
                    error={null}
                    onSelectionChange={() => {}}
                    onRefresh={() => {}}
                    onOpenSettings={() => {}}
                    onClose={() => {}}
                    maxHeight={520}
                />);

        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.loading')).toBe(true);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.empty')).toBe(false);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.error')).toBe(false);
    });

    it('omits the non-actionable built-in delivery group while keeping managed and detected rows', async () => {
        capturedItems.length = 0;
        capturedItemGroups.length = 0;

        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        await renderScreen(<NewSessionMcpSelectionContent
                    machineName="Builder"
                    directory="/repo"
                    agentType="claude"
                    hasContext={true}
                    preview={{
                        ok: true,
                        builtIn: [{
                            key: 'built-in:happier',
                            name: 'happier',
                            title: 'Happier',
                            transport: 'stdio',
                            authMode: 'none',
                            selected: true,
                            selectable: false,
                            availability: 'active',
                            sourceKind: 'builtIn',
                            scopeKind: 'builtIn',
                        }],
                        managed: [{
                            key: 'managed:playwright',
                            serverId: 'server-playwright',
                            name: 'playwright',
                            title: 'Playwright',
                            transport: 'stdio',
                            authMode: 'none',
                            selected: true,
                            selectable: true,
                            availability: 'active',
                            sourceKind: 'managed',
                            scopeKind: 'allMachines',
                            reasonCode: 'active_by_default',
                            portability: 'portable',
                            defaultSelected: true,
                        }],
                        detected: [{
                            key: 'detected:claude:sequential-thinking',
                            name: 'sequential-thinking',
                            transport: 'stdio',
                            authMode: 'unknown',
                            selected: true,
                            selectable: false,
                            availability: 'readOnly',
                            sourceKind: 'detected',
                            scopeKind: 'providerUser',
                            provider: 'claude',
                            enabled: true,
                            envKeyCount: 0,
                            headerKeyCount: 0,
                            sourcePath: '/Users/test/.claude/config.json',
                        }],
                    }}
                    selection={{
                        v: 1,
                        managedServersEnabled: true,
                        forceIncludeServerIds: [],
                        forceExcludeServerIds: [],
                    }}
                    loading={false}
                    error={null}
                    onSelectionChange={() => {}}
                    onRefresh={() => {}}
                    onOpenSettings={() => {}}
                    onClose={() => {}}
                    maxHeight={520}
                />);

        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.built-in.happier')).toBe(false);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.managed-enabled')).toBe(true);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.row.server-playwright')).toBe(true);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.detected.sequential-thinking')).toBe(true);
        expect(capturedItemGroups.some((group) => group.title === 'settings.mcpServersSourceBuiltIn')).toBe(false);
    });

    it('renders an explicit empty-state row when preview data resolves without any managed or detected servers', async () => {
        capturedItems.length = 0;
        capturedItemGroups.length = 0;

        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        await renderScreen(<NewSessionMcpSelectionContent
                    machineName="Builder"
                    directory="/repo"
                    agentType="claude"
                    hasContext={true}
                    preview={{
                        ok: true,
                        builtIn: [],
                        managed: [],
                        detected: [],
                    }}
                    selection={{
                        v: 1,
                        managedServersEnabled: true,
                        forceIncludeServerIds: [],
                        forceExcludeServerIds: [],
                    }}
                    loading={false}
                    error={null}
                    onSelectionChange={() => {}}
                    onRefresh={() => {}}
                    onOpenSettings={() => {}}
                    onClose={() => {}}
                    maxHeight={520}
                />);

        const emptyItem = capturedItems.find((item) => item.testID === 'new-session.mcp.empty');
        expect(emptyItem).toBeTruthy();
        expect(emptyItem?.title).toBe('settings.mcpServersEmptyTitle');
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.loading')).toBe(false);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.error')).toBe(false);
        expect(capturedItemGroups.some((group) => group.title == null)).toBe(true);
    });
});
