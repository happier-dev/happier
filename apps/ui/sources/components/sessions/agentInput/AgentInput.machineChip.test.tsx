import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

const mockEnv = vi.hoisted(() => ({
    windowWidth: 800,
    agentInputChipDensity: 'labels' as 'auto' | 'labels' | 'icons',
    iconsRenderAsText: false,
}));
installAgentInputCommonModuleMocks({
    icons: async () => {
        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        const icons = createExpoVectorIconsMock();
        return {
            ...icons,
            Ionicons: (props: Record<string, unknown>) => mockEnv.iconsRenderAsText
                ? <>{'.'}</> : React.createElement(icons.Ionicons, props),
            Octicons: (props: Record<string, unknown>) => mockEnv.iconsRenderAsText
                ? <>{'.'}</> : React.createElement(icons.Octicons, props),
        };
    },
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => ({ width: mockEnv.windowWidth, height: 600, scale: 1, fontScale: 1 }),
        });
    },
});
const runtime = installSessionPaneRuntimeTestHarness();
let AgentInput: typeof import('./AgentInput')['AgentInput'];
beforeEach(async () => {
    ({ AgentInput } = await import('./AgentInput'));
    mockEnv.windowWidth = 800;
    mockEnv.agentInputChipDensity = 'labels';
    mockEnv.iconsRenderAsText = false;
});

function collectBadRawTextNodes(
    node: ReactTestRendererJSON | readonly ReactTestRendererJSON[] | string | number | null,
    parentType: string | null = null,
    out: Array<{ parent: string | null; value: string }> = [],
): Array<{ parent: string | null; value: string }> {
    if (node === null) return out;
    if (typeof node === 'string' || typeof node === 'number') {
        if (parentType !== 'Text' && String(node).trim()) out.push({ parent: parentType, value: String(node) });
    } else if (Array.isArray(node)) {
        for (const item of node) collectBadRawTextNodes(item, parentType, out);
    } else if ('children' in node) {
        for (const child of node.children ?? []) collectBadRawTextNodes(child, node.type, out);
    }
    return out;
}

async function mount(params: Partial<React.ComponentProps<typeof AgentInput>> = {}) {
    storage.setState({ settings: {
        ...storage.getState().settings,
        agentInputEnterToSend: true,
        agentInputActionBarLayout: 'wrap',
        agentInputChipDensity: mockEnv.agentInputChipDensity,
        sessionPermissionModeApplyTiming: 'immediate',
    } });
    return renderScreen(<AgentInput value="hello" placeholder="placeholder"
        onChangeText={() => {}} onSend={() => {}} autocompleteKinds={[]}
        autocompleteSuggestions={async () => []} {...params}
    />, { wrapper: runtime.Wrapper });
}

describe('AgentInput (machine chip)', () => {
    it('renders a select-machine label when machine is not yet selected', async () => {
        const screen = await mount({ onMachineClick: () => {}, currentPath: '/tmp', onPathClick: () => {} });
        expect(screen.getTextContent()).toContain('newSession.selectMachineTitle');
    });

    it('does not emit raw text nodes under non-Text parents when chip icons render as text', async () => {
        // A native icon adapter may emit text: the chip must still provide a Text ancestor.
        mockEnv.iconsRenderAsText = true;
        const screen = await mount({ onPermissionClick: () => {}, agentType: 'codex', onAgentClick: () => {},
            machineName: 'Machine One', onMachineClick: () => {}, currentPath: '/tmp/project', onPathClick: () => {} });
        expect(collectBadRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });

    it('shows labels on narrow screens when chip density is auto', async () => {
        mockEnv.windowWidth = 390;
        mockEnv.agentInputChipDensity = 'auto';
        const screen = await mount({ onMachineClick: () => {}, currentPath: '/tmp', onPathClick: () => {} });
        expect(screen.getTextContent()).toContain('newSession.selectMachineTitle');
    });

    it('keeps the full exact Machine name in both visible and accessible chip labels', async () => {
        const machineName = 'Mac Studio in the downstairs development rack';
        const onMachineClick = vi.fn();
        const screen = await mount({ machineName, onMachineClick });
        const machineChip = screen.findByTestId('agent-input-machine-chip');
        expect(screen.getTextContent()).toContain(machineName);
        expect(machineChip?.props.accessibilityLabel).toContain(machineName);
        await act(async () => { machineChip?.props.onPress(); });
        expect(onMachineClick).toHaveBeenCalledTimes(1);
    });

    it('shows the folder as loading, never “Add folder”, while the path is not yet resolved (new-session bootstrap)', async () => {
        const screen = await mount({ onMachineClick: () => {}, currentPath: '', onPathClick: () => {} });
        expect(screen.findAllHostsByTestId('agent-input-path-chip')).toHaveLength(1);
        expect(screen.findByTestId('agent-input-path-chip')?.props.accessibilityLabel).toBe('newSession.folder.a11y.loading');
        expect(screen.getTextContent()).not.toContain('newSession.folder.addFolder');
    });

    it('exposes a stable testID for the connection status text (UI e2e locator)', async () => {
        const screen = await mount({ value: '', connectionStatus: {
            text: 'online', color: '#0a0', dotColor: '#0a0', isPulsing: false,
        } });
        const connectionStatus = screen.findByTestId('agent-input-connection-status-text');
        expect(connectionStatus).toBeTruthy();
        expect(screen.getTextContent()).toContain('online');
    });
});
