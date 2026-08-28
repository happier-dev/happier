import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';

import { useNewSessionBackendTargetState } from './useNewSessionBackendTargetState';
import { createResolvedAgentCatalogEntryFixture, renderScreen } from '@/dev/testkit';


const applySettingsMock = vi.fn();

function resolvedEntryFixture(
    entry: Omit<ResolvedBackendCatalogEntry, 'agentCatalogEntry' | 'cliAuthBackgroundCheckSafe'>,
): ResolvedBackendCatalogEntry {
    return {
        agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: entry.agentId }),
        cliAuthBackgroundCheckSafe: false,
        ...entry,
    };
}

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
}));

const entries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
    resolvedEntryFixture({
        backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
        backendTargetKey: 'backend:review-bot:configured:review-bot',
        kind: 'configuredBackend',
        backendId: 'review-bot',
        agentId: 'review-bot',
        catalogAgentId: null,
        builtInAgentId: null,
        iconAgentId: null,
        title: 'Review Bot',
        subtitle: 'review-bot',
    }),
];

const configuredPreferredEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
    resolvedEntryFixture({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        backendTargetKey: 'backend:codex',
        kind: 'builtInAgent',
        backendId: 'codex',
        agentId: 'codex',
        catalogAgentId: 'codex',
        builtInAgentId: 'codex',
        iconAgentId: 'codex',
        title: 'Codex',
        subtitle: 'codex',
    }),
    resolvedEntryFixture({
        backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
        backendTargetKey: 'backend:review-bot:configured:review-bot',
        kind: 'configuredBackend',
        backendId: 'review-bot',
        agentId: 'review-bot',
        catalogAgentId: null,
        builtInAgentId: null,
        iconAgentId: null,
        title: 'Review Bot',
        subtitle: 'review-bot',
    }),
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
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedCatalogAgentId).toBeNull();
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedUiAgentType).toBe('review-bot');
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
            resolvedEntryFixture({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                backendTargetKey: 'backend:codex',
                kind: 'builtInAgent',
                backendId: 'codex',
                agentId: 'codex',
                catalogAgentId: 'codex',
                builtInAgentId: 'codex',
                iconAgentId: 'codex',
                title: 'Codex',
                subtitle: 'codex',
            }),
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
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedCatalogAgentId).toBeNull();
    });

    it('keeps an unbacked plugin Agent separate from bundled static policy', async () => {
        const pluginEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
            resolvedEntryFixture({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                backendTargetKey: 'backend:codex',
                kind: 'builtInAgent',
                backendId: 'codex',
                agentId: 'codex',
                catalogAgentId: 'codex',
                builtInAgentId: 'codex',
                iconAgentId: 'codex',
                title: 'Codex',
                subtitle: 'codex',
            }),
            resolvedEntryFixture({
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                backendTargetKey: 'backend:acme.review.backend',
                kind: 'pluginBackend',
                backendId: 'acme.review.backend',
                agentId: 'acme.review.backend',
                catalogAgentId: null,
                builtInAgentId: null,
                iconAgentId: null,
                title: 'Acme Review Backend',
                subtitle: 'acme.review.backend',
            }),
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
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedCatalogAgentId).toBeNull();
        // The projected Agent id is the operational runtime identity and must
        // survive: discarding it is what silently removes model/mode/config
        // probing for an installed Agent. It is still not bundled static policy.
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedRuntimeCarrierAgentId)
            .toBe('acme.review.backend');
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedUiAgentType).toBe('acme.review.backend');
        expect(getPermissionModeOptionsForAgentType(observed!.selectedUiAgentType)).toEqual([]);
    });

    it('preserves an unresolved plugin backend target while daemon projection metadata is still loading', async () => {
        const pluginEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
            resolvedEntryFixture({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                backendTargetKey: 'backend:codex',
                kind: 'builtInAgent',
                backendId: 'codex',
                agentId: 'codex',
                catalogAgentId: 'codex',
                builtInAgentId: 'codex',
                iconAgentId: 'codex',
                title: 'Codex',
                subtitle: 'codex',
            }),
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
            resolvedEntryFixture({
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                backendTargetKey: 'backend:acme.review.backend',
                kind: 'pluginBackend',
                backendId: 'acme.review.backend',
                agentId: 'plugin:acme.review',
                catalogAgentId: 'claude',
                builtInAgentId: null,
                iconAgentId: 'claude',
                title: 'Acme Review Backend',
                subtitle: 'acme.review.backend',
            }),
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

        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedCatalogAgentId).toBe('claude');
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedRuntimeCarrierAgentId).toBe('claude');
    });

    it('persists plugin backend selection without writing lastUsedAgent (V1 compatibility only)', async () => {
        const pluginEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
            resolvedEntryFixture({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                backendTargetKey: 'backend:codex',
                kind: 'builtInAgent',
                backendId: 'codex',
                agentId: 'codex',
                catalogAgentId: 'codex',
                builtInAgentId: 'codex',
                iconAgentId: 'codex',
                title: 'Codex',
                subtitle: 'codex',
            }),
            resolvedEntryFixture({
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                backendTargetKey: 'backend:acme.review.backend',
                kind: 'pluginBackend',
                backendId: 'acme.review.backend',
                agentId: 'plugin:acme.review',
                catalogAgentId: null,
                builtInAgentId: null,
                iconAgentId: null,
                title: 'Acme Review Backend',
                subtitle: 'acme.review.backend',
            }),
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

    it('persists Oh My Pi selection as structured identity and clears the flat compatibility field', async () => {
        const ohMyPiEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [resolvedEntryFixture({
            backendTarget: { kind: 'backend', backendId: 'ohMyPi' },
            backendTargetKey: 'agent:happier.agent.ohmypi/ohmypi',
            kind: 'builtInAgent',
            backendId: 'ohMyPi',
            agentId: 'ohMyPi',
            catalogAgentId: 'ohMyPi',
            builtInAgentId: 'ohMyPi',
            iconAgentId: 'ohMyPi',
            title: 'Oh My Pi',
            subtitle: 'ohMyPi',
        })];
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries: ohMyPiEntries,
                lastUsedAgent: 'claude',
                lastUsedBackendTarget: null,
            } as any);
            return null;
        }

        const { tree } = await renderScreen(React.createElement(Probe));
        applySettingsMock.mockClear();

        act(() => {
            observed?.setBackendTarget({ kind: 'backend', backendId: 'ohMyPi' });
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            lastUsedAgent: null,
            lastUsedBackendTarget: {
                kind: 'agent',
                identity: {
                    pluginId: 'happier.agent.ohmypi',
                    localId: 'ohmypi',
                },
            },
        });
        expect(JSON.stringify(applySettingsMock.mock.calls)).not.toContain('\"ohMyPi\"');

        act(() => {
            tree.unmount();
        });
    });
});
