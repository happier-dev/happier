import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import type { McpServersSettingsV1 } from '@happier-dev/protocol';
import { createCapturingComponent, createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen as renderScreenBase, standardCleanup } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { refreshMcpServerCatalog, resetMcpServerCatalogEngineForTests } from '@/sync/engine/settings/mcpServerCatalogEngine';
import { resetMcpServerCatalogSnapshotsForTests } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

type CapturedItemProps = Readonly<{
    testID?: string;
    rightElement?: unknown;
    selected?: boolean;
    subtitle?: unknown;
} & Record<string, unknown>>;
type CapturedItemGroupProps = Readonly<{ title?: React.ReactNode } & Record<string, unknown>>;
const capturedItems: CapturedItemProps[] = [];
const capturedItemGroups: CapturedItemGroupProps[] = [];

const mcpServersSettingsFixture: McpServersSettingsV1 = {
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
};
const emptyMcpServersSettingsFixture: McpServersSettingsV1 = {
    v: 1,
    strictMode: false,
    servers: [],
    bindings: [],
};
let targetServerId: string;
let accountScope: { serverId: string; accountId: string };
let catalogFixture = mcpServersSettingsFixture;

beforeEach(async () => {
    catalogFixture = mcpServersSettingsFixture;
    const home = await upsertServerProfileOnly({ serverUrl: 'https://mcp-selection.test', name: 'Selection' });
    targetServerId = home.id;
    accountScope = { serverId: home.id, accountId: 'selection-account' };
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
        token: `e30.${Buffer.from(JSON.stringify({ sub: accountScope.accountId })).toString('base64url')}.signature`,
    });
    // Network is the replaced boundary; selected-Home scope, row opening and projection stay real.
    setRuntimeFetch(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
        if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
        if (path === '/v1/account/entity-rows/mcp') return Response.json({ status: 'present', revision: 3,
            content: { t: 'plain', v: { v: 1, servers: catalogFixture.servers, bindings: catalogFixture.bindings } } });
        return Response.json({ error: 'not_found' }, { status: 404 });
    });
});
afterEach(async () => {
    await standardCleanup();
    resetMcpServerCatalogEngineForTests();
    resetMcpServerCatalogSnapshotsForTests();
    resetRuntimeFetch();
});
async function renderScreen(element: React.ReactElement) {
    const screen = await renderScreenBase(element);
    await act(async () => { await refreshMcpServerCatalog(accountScope); });
    return screen;
}

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: createPassThroughComponent('Ionicons'),
    }),
    reactNative: () => createReactNativeWebMock({
        Platform: { OS: 'ios' },
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
    storage: importOriginal => importOriginal(),
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


describe('NewSessionMcpSelectionContent', () => {
    it('keeps native MCP content-sized under the computed popover height cap', async () => {
        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        const screen = await renderScreen(<NewSessionMcpSelectionContent
            targetServerId={targetServerId}
            machineId="machine-1"
            machineName="Builder"
            directory="/repo"
            agentType="claude"
            hasContext={true}
            preview={{ ok: true, builtIn: [], managed: [], detected: [] }}
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
            maxHeight={520}
        />);

        expect(screen.findAllByType('View').some((view) => {
            const style = Array.isArray(view.props.style)
                ? Object.assign({}, ...view.props.style)
                : view.props.style as Record<string, unknown> | undefined;
            return style?.maxHeight === 520 && style?.height === undefined;
        })).toBe(true);
    });

    it('shows a loading indicator in the refresh action while preview data is being refreshed', async () => {
        capturedItems.length = 0;
        capturedItemGroups.length = 0;

        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        await renderScreen(<NewSessionMcpSelectionContent
            targetServerId={targetServerId}
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
                    maxHeight={520}
                />);

        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.loading')).toBe(false);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.error')).toBe(false);

        const detectedGroup = capturedItemGroups.find((group) => {
            const titleProps = (group.title as { props?: { actions?: unknown } } | undefined)?.props;
            const actionProps = (titleProps?.actions as { props?: { testID?: string } } | undefined)?.props;
            return actionProps?.testID === 'new-session.mcp.detected.refresh';
        });

        expect(detectedGroup).toBeTruthy();

        const titleEl = detectedGroup!.title as React.ReactElement<{ actions?: React.ReactNode }>;
        const actions = titleEl.props.actions;
        expect(React.isValidElement(actions)).toBe(true);
        const actionProps = (actions as React.ReactElement<{ testID?: string; loading?: boolean; accessibilityLabel?: string }>).props;
        expect(actionProps.testID).toBe('new-session.mcp.detected.refresh');
        expect(actionProps.loading).toBe(true);
        expect(actionProps.accessibilityLabel).toBe('common.refresh');
    });

    it('does not render preview rows when session context is unavailable', async () => {
        capturedItems.length = 0;
        capturedItemGroups.length = 0;

        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        await renderScreen(<NewSessionMcpSelectionContent
            targetServerId={targetServerId}
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
                    maxHeight={520}
                />);

        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.empty')).toBe(true);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.detected.sequential-thinking')).toBe(false);
    });

    it('omits the non-actionable built-in delivery group while keeping managed and detected rows', async () => {
        capturedItems.length = 0;
        capturedItemGroups.length = 0;

        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        const screen = await renderScreen(<NewSessionMcpSelectionContent
            targetServerId={targetServerId}
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
                    maxHeight={520}
                />);

        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.built-in.happier')).toBe(false);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.managed-enabled')).toBe(true);
        expect(screen.findAllByType('Item').filter(item => item.props.testID === 'new-session.mcp.row.server-playwright')).toHaveLength(1);
        const managed = screen.findByTestId('new-session.mcp.row.server-playwright').props;
        expect(managed?.selected).toBe(false);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.detected.sequential-thinking')).toBe(true);
        expect(capturedItemGroups.some((group) => group.title === 'settings.mcpServersSourceBuiltIn')).toBe(false);

        const detected = capturedItems.find((item) => item.testID === 'new-session.mcp.detected.sequential-thinking');
        expect(detected?.subtitle).toBe('Scope · Auth');
        expect(detected?.detail).toBeUndefined();
        expect(React.isValidElement(detected?.rightElement)).toBe(true);
        expect(detected?.rightElement).toEqual(expect.objectContaining({
            props: expect.objectContaining({
                testID: 'new-session.mcp.detected.sequential-thinking.status',
            }),
        }));
    });

    it('does not render an extra empty-state row when Happier servers exist but preview resolves empty', async () => {
        capturedItems.length = 0;
        capturedItemGroups.length = 0;

        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        await renderScreen(<NewSessionMcpSelectionContent
            targetServerId={targetServerId}
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

        catalogFixture = emptyMcpServersSettingsFixture;

        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

        const screen = await renderScreen(<NewSessionMcpSelectionContent
            targetServerId={targetServerId}
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
            maxHeight={520}
        />);

        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.happier-empty')).toBe(true);
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.empty')).toBe(false);
        // Avoid rendering a second empty-state row for the detected/provider section.
        expect(capturedItems.some((item) => item.testID === 'new-session.mcp.detected-empty')).toBe(false);

        const happierEmpty = capturedItems.find((item) => item.testID === 'new-session.mcp.happier-empty');
        expect(happierEmpty?.rightElement).toBeFalsy();

        const happierGroup = capturedItemGroups
            .filter((group) => React.isValidElement(group.title))
            .find((group) => {
                const titleEl = group.title as React.ReactElement<{ title: string }>;
                return titleEl.props.title === 'newSession.mcpHappierSectionTitle';
            });

        expect(happierGroup).toBeTruthy();

        const titleEl = happierGroup!.title as React.ReactElement<{ actions?: React.ReactNode }>;
        const actions = titleEl.props.actions;
        const foundTestIds: string[] = [];
        const walk = (node: React.ReactNode) => {
            if (!node) return;
            if (Array.isArray(node)) {
                node.forEach(walk);
                return;
            }
            if (React.isValidElement(node)) {
                const props = node.props as { testID?: unknown; children?: React.ReactNode };
                const testID = props.testID;
                if (typeof testID === 'string') {
                    foundTestIds.push(testID);
                }
                const children = props.children;
                if (children) {
                    walk(children);
                }
            }
        };
        walk(actions);

        expect(foundTestIds).toEqual(expect.arrayContaining([
            'new-session.mcp.happier.refresh',
            'new-session.mcp.happier.open-settings',
        ]));
    });
});
