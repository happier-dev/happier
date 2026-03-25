import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';


import type { SessionMcpSelectionV1 } from '@happier-dev/protocol';
import { createCapturingComponent, createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import { createUseSettingMock, installPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capturedItems: Array<Record<string, unknown>> = [];
const capturedItemGroups: Array<Record<string, unknown>> = [];

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: createPassThroughComponent('Ionicons'),
    }),
	    reactNative: () => createReactNativeWebMock({
	        View: createPassThroughComponent('View'),
	        Pressable: createPassThroughComponent('Pressable'),
	        ScrollView: createPassThroughComponent('ScrollView'),
            ActivityIndicator: createPassThroughComponent('ActivityIndicator'),
	    }),
	    text: () => createTextModuleMock({
	        // Some MCP strings are param-driven; keep tests stable by returning the key string.
	        translate: (key) => key,
	    }),
	    unistyles: () => createUnistylesMock({
	        theme: {
	            colors: {
	                groupped: { background: '#f5f5f5' },
                surface: '#fff',
                divider: '#ddd',
                textSecondary: '#666',
	            },
	        },
	    }),
	    storage: installPartialStorageModuleMock({
	        useSetting: createUseSettingMock({
	            values: {
	                mcpServersSettingsV1: {
	                    v: 1,
	                    strictMode: false,
	                    servers: [
	                        {
	                            id: 'server-playwright',
	                            name: 'playwright',
	                            title: 'playwright',
	                            transport: 'stdio',
	                            stdio: { command: 'playwright', args: [] },
	                            env: {},
	                            createdAt: 1,
	                            updatedAt: 2,
	                        },
	                    ],
	                    bindings: [
	                        {
	                            id: 'binding-all',
	                            serverId: 'server-playwright',
	                            enabled: true,
	                            target: { t: 'allMachines' },
	                            createdAt: 1,
	                            updatedAt: 2,
	                        },
	                    ],
	                    presets: [],
	                } as any,
	            },
	        }),
	    }),
	});

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
vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
	        getAgentCore: () => ({
	            tools: {
	                delivery: 'full',
	            },
	            displayNameKey: 'agents.mock.displayName',
	        }),
	    };
	});

vi.mock('@/components/settings/mcpServers/mcpServerUi', () => ({
    resolveAgentToolsDeliveryDescription: () => 'Tool delivery description',
    resolveAgentToolsDeliveryLabel: () => 'Tool delivery label',
    resolveAuthBadgeLabel: () => 'Auth',
    resolveManagedServerAuthMode: () => 'Auth',
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
    it('shows a loading indicator in the refresh action while preview data is being refreshed', async () => {
        capturedItems.length = 0;
        capturedItemGroups.length = 0;

        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        await renderScreen(<NewSessionMcpSelectionContent
                    machineId="machine-1"
                    machineName="Builder"
                    directory="/repo"
                    agentType="claude"
                    hasContext={true}
                    preview={{
                        ok: true,
                        builtIn: [],
                        managed: [],
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
                    loading={true}
                    error={null}
                    onSelectionChange={() => {}}
                    onRefresh={() => {}}
                    onOpenSettings={() => {}}
                    onClose={() => {}}
                    maxHeight={520}
                />);

        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.loading')).toBe(false);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.error')).toBe(false);

        const detectedGroup = capturedItemGroups
            .filter((group) => React.isValidElement(group.title))
            .find((group) => {
                const titleEl = group.title as React.ReactElement<any>;
                return (titleEl.props as any)?.title === 'newSession.mcpDetectedSectionTitleForAgent';
            }) as any;

        expect(detectedGroup).toBeTruthy();

        const titleEl = detectedGroup.title as React.ReactElement<any>;
        const actions = (titleEl.props as any)?.actions as React.ReactNode;
        expect(React.isValidElement(actions)).toBe(true);
        expect((actions as React.ReactElement<any>).props.testID).toBe('new-session.mcp.detected.refresh');
        expect((actions as React.ReactElement<any>).props.loading).toBe(true);
    });

    it('does not render preview rows when session context is unavailable', async () => {
        capturedItems.length = 0;
        capturedItemGroups.length = 0;

        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        await renderScreen(<NewSessionMcpSelectionContent
                    machineId={null}
                    machineName={null}
                    directory=""
                    agentType="claude"
                    hasContext={false}
                    preview={{
                        ok: true,
                        builtIn: [],
                        managed: [],
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

        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.empty')).toBe(true);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.detected.sequential-thinking')).toBe(false);
    });

    it('omits the non-actionable built-in delivery group while keeping managed and detected rows', async () => {
        capturedItems.length = 0;
        capturedItemGroups.length = 0;

        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        await renderScreen(<NewSessionMcpSelectionContent
                    machineId="machine-1"
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
	        expect(capturedItems.filter((item) => item.testID === 'new-session.mcp.row.server-playwright')).toHaveLength(1);
	        const managed = capturedItems.find((item) => item.testID === 'new-session.mcp.row.server-playwright');
	        expect(managed?.selected).toBe(false);
	        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.detected.sequential-thinking')).toBe(true);
	        expect(capturedItemGroups.some((group) => group.title === 'settings.mcpServersSourceBuiltIn')).toBe(false);

	        const detected = capturedItems.find((item) => item.testID === 'new-session.mcp.detected.sequential-thinking');
	        expect(detected?.subtitle).toBe('Scope · Auth');
	    });

    it('does not render an extra empty-state row when Happier servers exist but preview resolves empty', async () => {
        capturedItems.length = 0;
        capturedItemGroups.length = 0;

        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        await renderScreen(<NewSessionMcpSelectionContent
                    machineId="machine-1"
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
        expect(emptyItem).toBeFalsy();
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.loading')).toBe(false);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.error')).toBe(false);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.row.server-playwright')).toBe(true);
    });

    it('collapses provider+Happier empty states into a single actionable row when no MCP servers exist anywhere', async () => {
        capturedItems.length = 0;
        capturedItemGroups.length = 0;

        vi.resetModules();

        vi.doMock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemListStatic']));
        vi.doMock('@/components/ui/lists/ItemGroup', () => ({
            ItemGroup: createCapturingComponent('ItemGroup', (props) => {
                capturedItemGroups.push(props);
            }),
        }));
        vi.doMock('@/components/ui/lists/Item', () => ({
            Item: createCapturingComponent('Item', (props) => {
                capturedItems.push(props);
            }),
        }));
        vi.doMock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
        vi.doMock('@/components/ui/rendering/normalizeNodeForView', () => ({
            normalizeNodeForView: (node: React.ReactNode) => node,
        }));
        vi.doMock('@/components/settings/mcpServers/mcpServerUi', () => ({
            resolveAuthBadgeLabel: () => 'Auth',
            resolveManagedServerAuthMode: () => 'Auth',
            resolveDetectedAvailabilityLabel: () => 'Detected',
            resolvePreviewScopeLabel: () => 'Scope',
        }));
        vi.doMock('@/components/sessions/new/modules/sessionMcpSelectionState', () => ({
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

        vi.doMock('@/agents/catalog/catalog', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
            return {
                ...actual,
                getAgentCore: () => ({
                    tools: { delivery: 'full' },
                    displayNameKey: 'agents.mock.displayName',
                }),
            };
        });

        vi.doMock('react-native', async () => createReactNativeWebMock({
            View: createPassThroughComponent('View'),
            Pressable: createPassThroughComponent('Pressable'),
            ScrollView: createPassThroughComponent('ScrollView'),
        }));
        vi.doMock('@expo/vector-icons', () => ({
            Ionicons: createPassThroughComponent('Ionicons'),
        }));
        vi.doMock('react-native-unistyles', async () => createUnistylesMock({
            theme: {
                colors: {
                    groupped: { background: '#f5f5f5' },
                    surface: '#fff',
                    divider: '#ddd',
                    textSecondary: '#666',
                },
            },
        }));
        vi.doMock('@/text', async () => createTextModuleMock({
            translate: (key) => key,
        }));

        vi.doMock('@/sync/domains/state/storage', () => ({
            useSetting: createUseSettingMock({
                values: {
                    mcpServersSettingsV1: {
                        v: 1,
                        strictMode: false,
                        servers: [],
                        bindings: [],
                        presets: [],
                    } as any,
                },
            }),
        }));
        vi.doMock('@/sync/domains/settings/mcpServers/normalizeMcpServersSettingsV1', () => ({
            normalizeMcpServersSettingsV1: (value: any) => value,
        }));

        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        const screen = await renderScreen(<NewSessionMcpSelectionContent
            machineId="machine-1"
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

        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.happier-empty')).toBe(true);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.empty')).toBe(false);

        const happierEmpty = capturedItems.find((item) => item.testID === 'new-session.mcp.happier-empty') as any;
        const rightElement = happierEmpty?.rightElement as React.ReactNode;
        expect(rightElement).toBeTruthy();

        const foundTestIds: string[] = [];
        const walk = (node: React.ReactNode) => {
            if (!node) return;
            if (Array.isArray(node)) {
                node.forEach(walk);
                return;
            }
            if (React.isValidElement(node)) {
                const testID = (node.props as any)?.testID;
                if (typeof testID === 'string') {
                    foundTestIds.push(testID);
                }
                const children = (node.props as any)?.children;
                if (children) {
                    walk(children);
                }
            }
        };
        walk(rightElement);

        expect(foundTestIds).toEqual(expect.arrayContaining([
            'new-session.mcp.happier.empty.refresh',
            'new-session.mcp.happier.empty.open-settings',
        ]));
    });
});
