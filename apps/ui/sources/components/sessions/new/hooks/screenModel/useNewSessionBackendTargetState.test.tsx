import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

import { useNewSessionBackendTargetState } from './useNewSessionBackendTargetState';
import { renderScreen } from '@/dev/testkit';


const applySettingsMock = vi.fn();

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
}));

const entries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
    {
        target: { kind: 'builtInAgent', agentId: 'customAcp' },
        targetKey: 'agent:customAcp',
        family: 'builtInAgent',
        providerAgentId: 'customAcp',
        builtInAgentId: 'customAcp',
        iconAgentId: 'customAcp',
        title: 'Custom ACP',
        subtitle: 'customAcp',
    },
    {
        target: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        targetKey: 'acpBackend:review-bot',
        family: 'configuredAcpBackend',
        providerAgentId: 'customAcp',
        builtInAgentId: null,
        iconAgentId: 'customAcp',
        title: 'Review Bot',
        subtitle: 'review-bot',
    },
];

describe('useNewSessionBackendTargetState', () => {
    beforeEach(() => {
        applySettingsMock.mockReset();
    });

    it('restores the last used configured ACP backend target instead of the provider sentinel', async () => {
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries,
                lastUsedAgent: 'customAcp',
                lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            } as any);
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.backendTarget).toEqual({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
    });

    it('persists the exact configured ACP backend target when selection changes', async () => {
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries,
                lastUsedAgent: 'customAcp',
                lastUsedBackendTarget: null,
            } as any);
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(Probe))).tree;

        applySettingsMock.mockClear();

        act(() => {
            observed?.setBackendTarget({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        });

        act(() => {
            tree?.unmount();
        });
    });
});
