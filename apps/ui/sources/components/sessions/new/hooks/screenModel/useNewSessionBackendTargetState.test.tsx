import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

import { useNewSessionBackendTargetState } from './useNewSessionBackendTargetState';
import { renderScreen } from '@/dev/testkit';


const applySettingsMock = vi.fn();

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
}));

const entries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
    {
        backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
        backendTargetKey: 'backend:review-bot:configured:review-bot',
        kind: 'configuredBackend',
        backendId: 'review-bot',
        providerId: 'review-bot',
        providerAgentId: null,
        builtInAgentId: null,
        iconAgentId: null,
        title: 'Review Bot',
        subtitle: 'review-bot',
    },
];

const configuredPreferredEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
    {
        backendTarget: { kind: 'backend', backendId: 'codex' },
        backendTargetKey: 'backend:codex',
        kind: 'builtInAgent',
        backendId: 'codex',
        providerId: 'codex',
        providerAgentId: 'codex',
        builtInAgentId: 'codex',
        iconAgentId: 'codex',
        title: 'Codex',
        subtitle: 'codex',
    },
    {
        backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
        backendTargetKey: 'backend:review-bot:configured:review-bot',
        kind: 'configuredBackend',
        backendId: 'review-bot',
        providerId: 'review-bot',
        providerAgentId: null,
        builtInAgentId: null,
        iconAgentId: null,
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
                lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
            } as any);
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(observed).not.toBeNull();
        expect(resolveBackendTargetKeyV2(observed!.backendTarget)).toBe('backend:review-bot:configured:review-bot');
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedProviderAgentId).toBe(DEFAULT_AGENT_ID);
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedUiAgentType).toBe(DEFAULT_AGENT_ID);
    });

    it('persists the canonical ACP provider sentinel while keeping the configured ACP backend target', async () => {
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries,
                lastUsedAgent: 'codex',
                lastUsedBackendTarget: null,
            } as any);
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(Probe))).tree;

        applySettingsMock.mockClear();

        act(() => {
            observed?.setBackendTarget({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' });
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
        });

        act(() => {
            tree?.unmount();
        });
    });

    it('falls back to an available last-used built-in target when temp agent params point to an unavailable built-in agent', async () => {
        const fallbackEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
            {
                backendTarget: { kind: 'backend', backendId: 'codex' },
                backendTargetKey: 'backend:codex',
                kind: 'builtInAgent',
                backendId: 'codex',
                providerId: 'codex',
                providerAgentId: 'codex',
                builtInAgentId: 'codex',
                iconAgentId: 'codex',
                title: 'Codex',
                subtitle: 'codex',
            },
        ];
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries: fallbackEntries,
                tempAgentType: 'claude',
                lastUsedAgent: 'codex',
                lastUsedBackendTarget: null,
            } as any);
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(observed).not.toBeNull();
        expect(resolveBackendTargetKeyV2(observed!.backendTarget)).toBe('backend:codex');
    });

    it('prefers an available configured backend target over built-in defaults when no explicit target is stored', async () => {
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries: configuredPreferredEntries,
                lastUsedAgent: 'codex',
                lastUsedBackendTarget: null,
            } as any);
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(observed).not.toBeNull();
        expect(resolveBackendTargetKeyV2(observed!.backendTarget)).toBe('backend:review-bot:configured:review-bot');
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedProviderAgentId).toBe('codex');
    });

    it('does not collapse plugin backend targets into the custom ACP sentinel for agentType state', async () => {
        const pluginEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
            {
                backendTarget: { kind: 'backend', backendId: 'codex' },
                backendTargetKey: 'backend:codex',
                kind: 'builtInAgent',
                backendId: 'codex',
                providerId: 'codex',
                providerAgentId: 'codex',
                builtInAgentId: 'codex',
                iconAgentId: 'codex',
                title: 'Codex',
                subtitle: 'codex',
            },
            {
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                backendTargetKey: 'backend:acme.review.backend',
                kind: 'pluginBackend',
                backendId: 'acme.review.backend',
                providerId: 'plugin:acme.review',
                providerAgentId: null,
                builtInAgentId: null,
                iconAgentId: null,
                title: 'Acme Review Backend',
                subtitle: 'acme.review.backend',
            },
        ];

        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries: pluginEntries,
                lastUsedAgent: 'codex',
                lastUsedBackendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
            } as any);
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(observed).not.toBeNull();
        expect(resolveBackendTargetKeyV2(observed!.backendTarget)).toBe('backend:acme.review.backend');
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedProviderAgentId).toBe('codex');
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedUiAgentType).toBe('codex');
    });

    it('preserves an unresolved plugin backend target while daemon projection metadata is still loading', async () => {
        const pluginEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
            {
                backendTarget: { kind: 'backend', backendId: 'codex' },
                backendTargetKey: 'backend:codex',
                kind: 'builtInAgent',
                backendId: 'codex',
                providerId: 'codex',
                providerAgentId: 'codex',
                builtInAgentId: 'codex',
                iconAgentId: 'codex',
                title: 'Codex',
                subtitle: 'codex',
            },
        ];

        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries: pluginEntries,
                tempBackendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                lastUsedAgent: 'codex',
                lastUsedBackendTarget: null,
                projectionPhase: 'loading',
            } as any);
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(observed).not.toBeNull();
        expect(resolveBackendTargetKeyV2(observed!.backendTarget)).toBe('backend:acme.review.backend');
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedRuntimeCarrierAgentId).toBeNull();
    });

    it('uses projected provider carrier metadata for plugin backend runtime selection', async () => {
        const pluginEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
            {
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                backendTargetKey: 'backend:acme.review.backend',
                kind: 'pluginBackend',
                backendId: 'acme.review.backend',
                providerId: 'plugin:acme.review',
                providerAgentId: 'claude',
                builtInAgentId: null,
                iconAgentId: 'claude',
                title: 'Acme Review Backend',
                subtitle: 'acme.review.backend',
            },
        ];

        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries: pluginEntries,
                tempBackendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                lastUsedAgent: 'codex',
                lastUsedBackendTarget: null,
                projectionPhase: 'ready',
            } as any);
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedProviderAgentId).toBe('claude');
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedRuntimeCarrierAgentId).toBe('claude');
    });

    it('persists plugin backend selection without writing lastUsedAgent (V1 compatibility only)', async () => {
        const pluginEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
            {
                backendTarget: { kind: 'backend', backendId: 'codex' },
                backendTargetKey: 'backend:codex',
                kind: 'builtInAgent',
                backendId: 'codex',
                providerId: 'codex',
                providerAgentId: 'codex',
                builtInAgentId: 'codex',
                iconAgentId: 'codex',
                title: 'Codex',
                subtitle: 'codex',
            },
            {
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                backendTargetKey: 'backend:acme.review.backend',
                kind: 'pluginBackend',
                backendId: 'acme.review.backend',
                providerId: 'plugin:acme.review',
                providerAgentId: null,
                builtInAgentId: null,
                iconAgentId: null,
                title: 'Acme Review Backend',
                subtitle: 'acme.review.backend',
            },
        ];

        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries: pluginEntries,
                lastUsedAgent: 'claude',
                lastUsedBackendTarget: null,
            } as any);
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(Probe))).tree;

        applySettingsMock.mockClear();

        act(() => {
            observed?.setBackendTarget({ kind: 'backend', backendId: 'acme.review.backend' });
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            lastUsedBackendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
        });
        expect(applySettingsMock).not.toHaveBeenCalledWith(expect.objectContaining({
            lastUsedAgent: expect.any(String),
        }));

        act(() => {
            tree?.unmount();
        });
    });
});
