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

    it('does not persist a mount-resolved target before the user selects one', async () => {
        function Probe() {
            useNewSessionBackendTargetState({
                entries,
                lastUsedAgent: 'claude',
                lastUsedBackendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                routeBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            } as any);
            return null;
        }

        await renderScreen(React.createElement(Probe));

        // Opening the screen is not "using" a backend: the launch path persists the last-used
        // target when a session is actually created.
        expect(applySettingsMock).not.toHaveBeenCalled();
    });

    it('prefers an explicit route configured ACP backend target over last-used built-in defaults', async () => {
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries,
                lastUsedAgent: 'claude',
                lastUsedBackendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                routeBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            } as any);
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.backendTarget).toEqual({
            kind: 'configuredAcpBackend',
            backendId: 'review-bot',
        });
    });
});
const claudeEntry: ResolvedBackendCatalogEntry = {
    target: { kind: 'builtInAgent', agentId: 'claude' },
    targetKey: 'agent:claude',
    family: 'builtInAgent',
    providerAgentId: 'claude',
    builtInAgentId: 'claude',
    iconAgentId: 'claude',
    title: 'Claude',
    subtitle: 'claude',
};

const codexEntry: ResolvedBackendCatalogEntry = {
    target: { kind: 'builtInAgent', agentId: 'codex' },
    targetKey: 'agent:codex',
    family: 'builtInAgent',
    providerAgentId: 'codex',
    builtInAgentId: 'codex',
    iconAgentId: 'codex',
    title: 'Codex',
    subtitle: 'codex',
};

describe('useNewSessionBackendTargetState authored targets', () => {
    beforeEach(() => applySettingsMock.mockReset());

    it.each(['routeBackendTarget', 'tempBackendTarget', 'persistedBackendTarget', 'tempAgentType'] as const)('restores %s before remembered preferences', async (source) => {
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | undefined;
        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries: [claudeEntry, codexEntry], lastUsedAgent: 'codex',
                [source]: source === 'tempAgentType' ? 'claude' : claudeEntry.target,
            });
            return null;
        }
        await renderScreen(React.createElement(Probe));
        expect(observed?.backendTarget).toEqual(claudeEntry.target);
        expect(applySettingsMock).not.toHaveBeenCalled();
    });

    it('keeps automatic corrections out of last-used settings after a manual choice', async () => {
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | undefined;
        function Probe() {
            observed = useNewSessionBackendTargetState({ entries: [claudeEntry, codexEntry], lastUsedAgent: 'claude' });
            return null;
        }
        await renderScreen(React.createElement(Probe));
        act(() => observed?.setBackendTarget(codexEntry.target));
        expect(applySettingsMock).toHaveBeenCalledWith({ lastUsedAgent: 'codex', lastUsedBackendTarget: codexEntry.target });
        applySettingsMock.mockClear();
        act(() => observed?.setBackendTargetAutomatically(claudeEntry.target));
        expect(observed?.backendTarget).toEqual(claudeEntry.target);
        expect(applySettingsMock).not.toHaveBeenCalled();
    });
});
