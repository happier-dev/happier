import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol';

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
const modalShowSpy = vi.hoisted(() => vi.fn((_config: unknown) => 'modal-id'));
const modalUpdateSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    View: 'View',
    useWindowDimensions: () => ({ width: 900, height: 800 }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => {
        if (key === 'newSession.mcpChipLabel') return 'MCP';
        return key;
    },
}));

vi.mock('@/modal', () => ({
    Modal: {
        show: (config: unknown) => modalShowSpy(config),
        update: (id: string, props: unknown) => modalUpdateSpy(id, props),
    },
}));

vi.mock('@/components/sessions/new/components/NewSessionMcpSelectionModal', () => ({
    NewSessionMcpSelectionModal: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'mcp.servers',
}));

vi.mock('@/sync/ops/machineMcpServers', () => ({
    machineMcpServersPreview: (...args: [string, unknown, unknown?]) => previewSpy(...args),
}));

vi.mock('@/components/sessions/new/components/NewSessionMcpSelectionModal', () => ({
    NewSessionMcpSelectionModal: 'NewSessionMcpSelectionModal',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

describe('useNewSessionMcpSelection', () => {
    beforeEach(() => {
        previewSpy.mockClear();
        modalShowSpy.mockClear();
        modalUpdateSpy.mockClear();
    });

    it('renders an MCP chip with the effective selected count and opens the picker modal', async () => {
        const { useNewSessionMcpSelection } = await import('./useNewSessionMcpSelection');

        let chip: any = null;
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
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

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
        let chipTree: renderer.ReactTestRenderer | null = null;
        act(() => {
            chipTree = renderer.create(chip.render({
                chipStyle: () => null,
                iconColor: '#000',
                showLabel: true,
                textStyle: null,
                countTextStyle: null,
                popoverAnchorRef: { current: null },
            }));
        });
        expect(chipTree!.root.findByType('Pressable')).toBeTruthy();
        expect(chipTree!.root.findAllByType('Text').map((node: any) => node.props.children).flat().join('')).toContain('MCP');
        expect(chipTree!.root.findAllByType('Text').map((node: any) => node.props.children).flat().join('')).toContain('(3)');

        await act(async () => {
            chipTree!.root.findByType('Pressable').props.onPress();
        });

        expect(modalShowSpy).toHaveBeenCalledWith(expect.objectContaining({
            component: 'NewSessionMcpSelectionModal',
            props: expect.objectContaining({
                preview: expect.objectContaining({ managed: expect.any(Array), detected: expect.any(Array) }),
                selection: expect.objectContaining({ managedServersEnabled: true }),
                machineName: 'Machine One',
                directory: '/workspace',
            }),
        }));

        const modalConfig = modalShowSpy.mock.calls[0]?.[0] as { props: { onSelectionChange: (selection: any) => void } };
        await act(async () => {
            modalConfig.props.onSelectionChange({
                v: 1,
                managedServersEnabled: true,
                forceIncludeServerIds: [],
                forceExcludeServerIds: ['server-playwright'],
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(modalUpdateSpy).toHaveBeenCalledWith(
            'modal-id',
            expect.objectContaining({
                selection: expect.objectContaining({
                    forceExcludeServerIds: ['server-playwright'],
                }),
            }),
        );
    });
});
