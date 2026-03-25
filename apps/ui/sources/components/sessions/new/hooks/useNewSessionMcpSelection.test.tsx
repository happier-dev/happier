import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { renderScreen } from '@/dev/testkit';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const previewSpy = vi.hoisted(() => vi.fn(async (_machineId: string, _request: unknown, _options?: unknown) => ({
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
        key: 'detected:codex:sequential-thinking',
        name: 'sequential-thinking',
        transport: 'stdio',
        authMode: 'unknown',
        selected: true,
        selectable: false,
        availability: 'readOnly',
        sourceKind: 'detected',
        scopeKind: 'providerUser',
        provider: 'codex',
        enabled: true,
        envKeyCount: 0,
        headerKeyCount: 0,
        sourcePath: '/Users/test/.codex/config.toml',
    }],
})));
installNewSessionScreenModelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: 'Pressable',
            ScrollView: 'ScrollView',
            View: 'View',
            Dimensions: {
                get: () => ({ width: 900, height: 800 }),
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
            useWindowDimensions: () => ({ width: 900, height: 800 }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => {
                if (key === 'newSession.mcpChipLabel') return 'MCP';
                return key;
            },
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useSetting: createUseSettingMock({
                values: {
                    mcpServersSettingsV1: {
                        v: 1,
                        strictMode: false,
                        servers: [
                            {
                                id: 'server-playwright',
                                name: 'playwright',
                                title: 'Playwright',
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
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'mcp.servers',
}));

vi.mock('@/sync/ops/machineMcpServers', () => ({
    machineMcpServersPreview: (...args: [string, unknown, unknown?]) => previewSpy(...args),
}));

vi.mock('@/components/sessions/new/components/NewSessionMcpSelectionContent', () => ({
    NewSessionMcpSelectionContent: (props: Record<string, unknown>) => React.createElement('NewSessionMcpSelectionContent', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

describe('useNewSessionMcpSelection', () => {
    beforeEach(() => {
        previewSpy.mockClear();
    });

    it('renders an MCP chip with the effective selected count and routes visible-chip presses through the shared collapsed popover path', async () => {
        const { useNewSessionMcpSelection } = await import('./useNewSessionMcpSelection');

        let chip: any = null;
        const toggleCollapsedPopover = vi.fn();

        function Probe() {
            const [selection, setSelection] = React.useState(() => SessionMcpSelectionV1Schema.parse({}));
            const result = useNewSessionMcpSelection({
                selectedMachineId: 'machine-1',
                selectedPath: '/workspace',
                selectedMachineName: 'Machine One',
                agentType: 'codex',
                targetServerId: 'server-a',
                mcpSelection: selection,
                setMcpSelection: setSelection,
                onOpenSettings: vi.fn(),
            });
            chip = result.mcpChip;
            return result.mcpChip?.render({
                chipStyle: () => null,
                iconColor: '#000',
                showLabel: true,
                textStyle: null,
                countTextStyle: null,
                chipAnchorRef: { current: null },
                popoverAnchorRef: { current: null },
                toggleCollapsedPopover,
            }) ?? null;
        }

        await renderScreen(React.createElement(Probe));
        await flushHookEffects();

        expect(previewSpy).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                agentId: 'codex',
                directory: '/workspace',
                selection: expect.objectContaining({ managedServersEnabled: true }),
            }),
            { serverId: 'server-a' },
        );

        expect(chip?.key).toBe('new-session-mcp');
        expect(chip?.controlId).toBe('mcp');
        expect(chip?.collapsedContentPopover).toEqual(expect.objectContaining({
            title: 'MCP',
            maxHeightCap: 760,
            maxWidthCap: 620,
            renderContent: expect.any(Function),
        }));

        const renderedChip = chip!.render({
            chipStyle: () => null,
            iconColor: '#000',
            showLabel: true,
            textStyle: null,
            countTextStyle: null,
            chipAnchorRef: { current: null },
            popoverAnchorRef: { current: null },
            toggleCollapsedPopover,
        }) as React.ReactElement<{
            onPress?: () => void;
            testID?: string;
            children?: React.ReactNode;
        }>;

        expect(renderedChip.props.testID).toBe('new-session-mcp-chip');
        expect(React.isValidElement(renderedChip.props.children)).toBe(false);

        const renderedChipChildren = React.Children.toArray(renderedChip.props.children);
        const labelNode = renderedChipChildren[1];
        expect(React.isValidElement(labelNode)).toBe(true);
        expect((labelNode as React.ReactElement<{ label: string; count: number }>).props.label).toBe('MCP');
        expect((labelNode as React.ReactElement<{ label: string; count: number }>).props.count).toBe(2);

        await act(async () => {
            renderedChip.props.onPress?.();
        });

        expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-mcp');

        const renderedContent = chip!.collapsedContentPopover.renderContent({
            requestClose: () => {},
            maxHeight: 420,
        });
        expect(React.isValidElement(renderedContent)).toBe(true);
        const contentNode = renderedContent as React.ReactElement<{
            onSelectionChange: (selection: unknown) => void;
        }>;

        await act(async () => {
            contentNode.props.onSelectionChange({
                v: 1,
                managedServersEnabled: true,
                forceIncludeServerIds: [],
                forceExcludeServerIds: ['server-playwright'],
            });
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        const updatedContent = chip!.collapsedContentPopover.renderContent({
            requestClose: () => {},
            maxHeight: 420,
        });
        expect(React.isValidElement(updatedContent)).toBe(true);
        const updatedContentNode = updatedContent as React.ReactElement<{
            preview: unknown;
            selection: unknown;
        }>;

        expect(updatedContentNode.props.preview).toEqual(expect.objectContaining({
            managed: expect.any(Array),
            detected: expect.any(Array),
        }));
        expect(updatedContentNode.props.selection).toEqual(expect.objectContaining({
            forceExcludeServerIds: ['server-playwright'],
        }));
    });

    it('treats RPC method-not-available preview errors as unsupported instead of surfacing them as a blocking error', async () => {
        previewSpy.mockRejectedValueOnce(new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE));

        const { useNewSessionMcpSelection } = await import('./useNewSessionMcpSelection');

        let chip: any = null;

        function Probe() {
            const [selection, setSelection] = React.useState(() => SessionMcpSelectionV1Schema.parse({}));
            const result = useNewSessionMcpSelection({
                selectedMachineId: 'machine-1',
                selectedPath: '/workspace',
                selectedMachineName: 'Machine One',
                agentType: 'codex',
                mcpSelection: selection,
                setMcpSelection: setSelection,
                onOpenSettings: vi.fn(),
            });
            chip = result.mcpChip;
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(chip).toBeTruthy();
        const renderedContent = chip!.collapsedContentPopover.renderContent({
            requestClose: () => {},
            maxHeight: 420,
        });
        expect(React.isValidElement(renderedContent)).toBe(true);

        const contentNode = renderedContent as React.ReactElement<{
            preview: unknown;
            error: unknown;
            previewUnsupported?: boolean;
        }>;

        expect(contentNode.props.preview).toBeNull();
        expect(contentNode.props.error).toBeNull();
        expect(contentNode.props.previewUnsupported).toBe(true);
    });
});
