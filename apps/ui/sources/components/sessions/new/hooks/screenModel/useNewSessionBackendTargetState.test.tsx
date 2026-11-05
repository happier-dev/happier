import { useNewSessionAgentAuthoringOptionsState } from './useNewSessionAgentAuthoringOptionsState';
import { readBackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/selection/v1';
import { flushSessionDraft, prepareLocalSessionDraftScope, resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { buildNewSessionAuthoringDraftFromPersistedDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import * as React from 'react';
import 'fake-indexeddb/auto';
import renderer, { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';

installNewSessionScreenModelCommonModuleMocks();
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { createResolvedAgentCatalogEntryFixture } = await import('@/dev/testkit/fixtures/agentCatalogFixtures');
const { getPermissionModeOptionsForAgentType } = await import('@/sync/domains/permissions/permissionModeOptions');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults, settingsParse } = await import('@/sync/domains/settings/settings');
const { useNewSessionBackendTargetState } = await import('./useNewSessionBackendTargetState');
let initialSettings = settingsDefaults;

function seedPreferences(preferences: Readonly<{ lastUsedAgent?: unknown; lastUsedBackendTarget?: unknown }>) {
    initialSettings = settingsParse({ ...storage.getState().settings, ...preferences });
    storage.setState({ settings: initialSettings });
}

beforeEach(() => {
    network.resetRequests();
    storage.setState(storage.getInitialState(), true);
    seedPreferences({ lastUsedAgent: 'codex', lastUsedBackendTarget: null });
});
afterEach(() => standardCleanup());
afterAll(() => network.dispose());

function resolvedEntryFixture(
    entry: Omit<ResolvedBackendCatalogEntry, 'agentCatalogEntry' | 'cliAuthBackgroundCheckSafe'>,
): ResolvedBackendCatalogEntry {
    return {
        agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: entry.agentId }),
        cliAuthBackgroundCheckSafe: false,
        ...entry,
    };
}

const entries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
    resolvedEntryFixture({
        backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
        backendTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot',
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
        backendTargetKey: 'agent:happier.agent.codex/codex',
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
        backendTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot',
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
    it.each(['warm', 'delayed'] as const)('reopens the owned draft Agent, model and account after %s hydration', async (hydration) => {
        const scope = { serverId: 'draft-home', accountId: 'draft-owner' };
        const draftId = '00000000-0000-4000-8000-000000001104';
        await prepareLocalSessionDraftScope(scope);
        const codexTarget = { kind: 'agent' as const,
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        const claudeEntry = resolvedEntryFixture({ ...configuredPreferredEntries[0]!,
            backendTarget: { kind: 'backend', backendId: 'claude' },
            backendTargetKey: 'agent:happier.agent.claude/claude', backendId: 'claude', agentId: 'claude',
            catalogAgentId: 'claude', builtInAgentId: 'claude', iconAgentId: 'claude', title: 'Claude', subtitle: 'claude' });
        const candidates = [claudeEntry, configuredPreferredEntries[0]!];
        seedPreferences({ lastUsedAgent: 'claude', lastUsedBackendTarget: null });
        let retained: Readonly<NewSessionDraft> | null = null;
        const restoredCommits: string[] = [];
        function useDraftSelection() {
            const agent = useNewSessionBackendTargetState({ entries: candidates, projectionPhase: 'ready',
                persistedBackendTarget: retained?.agentTarget });
            const targetKey = resolveBackendTargetKeyV2(agent.backendTarget);
            const engine = useNewSessionAgentAuthoringOptionsState({
                agentType: agent.selectedUiAgentType, backendTargetKey: targetKey,
                hydratedTempAuthoringDraft: null,
                hydratedPersistedAuthoringDraft: retained ? buildNewSessionAuthoringDraftFromPersistedDraft(retained) : null,
            });
            const account = parseConnectedServicesBindingsByServiceIdFromAgentOptionState({
                agentOptionState: readBackendNewSessionOptionStateByTargetKey(retained)?.[targetKey],
            });
            React.useLayoutEffect(() => {
                if (retained) restoredCommits.push(targetKey);
            });
            return { agent, engine, account };
        }
        const initial = await renderHook(useDraftSelection);
        await act(async () => initial.getCurrent().agent.setBackendTarget(codexTarget));
        const modelSelection = SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 123, ref: {
            agentTargetKey: resolveBackendTargetKeyV2(codexTarget), providerConnectionId: 'pc_draft', modelId: 'openrouter/free',
        } });
        await act(async () => initial.getCurrent().engine.setModelSelection(modelSelection));
        const serviceId = 'happier.agent.codex/codex-subscription';
        const account = { source: 'connected' as const, profileId: 'chosen-draft-account' };
        const draft: NewSessionDraft = {
            input: 'Keep my explicit engine', selectedMachineId: null, selectedPath: null,
            selectedProfileId: null, selectedSecretId: null, agentType: 'codex',
            agentTarget: codexTarget, permissionMode: 'default', acpSessionModeId: null,
            modelSelection: initial.getCurrent().engine.modelSelection,
            backendNewSessionOptionStateByTargetKey: { [modelSelection.ref.agentTargetKey]: {
                connectedServicesBindingsByServiceId: { [serviceId]: account },
            } }, updatedAt: 123,
        };
        writeNewSessionDraftToRepository({ scope, draftId, draft });
        await flushSessionDraft({ scope, address: { kind: 'newSession', draftId } });
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.agentTarget).toEqual(codexTarget);
        await initial.unmount();
        resetSessionDraftRepositoryForTests();
        // A different composer can change the device's last-used choice before reopen.
        seedPreferences({ lastUsedAgent: 'claude', lastUsedBackendTarget: null });
        if (hydration === 'warm') retained = readNewSessionDraftFromRepository({ scope, draftId });
        if (hydration === 'warm') expect(retained?.agentTarget).toEqual(codexTarget);
        const reopened = await renderHook(useDraftSelection);
        try {
            if (hydration === 'delayed') {
                retained = readNewSessionDraftFromRepository({ scope, draftId });
                expect(retained?.agentTarget).toEqual(codexTarget);
                await reopened.rerender();
            }
            expect(reopened.getCurrent().agent.backendTarget).toEqual(codexTarget);
            expect(reopened.getCurrent().engine.modelSelection).toEqual(modelSelection);
            expect(reopened.getCurrent().account[serviceId]).toEqual(account);
            expect(restoredCommits.length).toBeGreaterThan(0);
            expect(restoredCommits.every(key => key === modelSelection.ref.agentTargetKey)).toBe(true);
        } finally {
            await reopened.unmount();
            resetSessionDraftRepositoryForTests();
        }
    });
    it('retains an explicit route while a remembered configured Agent and the catalog hydrate', async () => {
        seedPreferences({ lastUsedBackendTarget: entries[0]!.backendTarget });
        const routeBackendTarget = { kind: 'agent' as const,
            identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;
        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries, configuredCatalogReady: true, routeBackendTarget,
                projectionPhase: 'loading',
            });
            return null;
        }
        const screen = await renderScreen(React.createElement(Probe));
        const readObserved = () => observed;
        expect(readObserved()?.backendTarget).toEqual(routeBackendTarget);
        await screen.unmount();
    });
    it.each(['route', 'picker'] as const)('retains an explicit %s choice when late catalog hydration exposes a configured default', async (source) => {
        const claudeTarget = { kind: 'agent' as const,
            identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
        const claudeEntry = resolvedEntryFixture({
            ...configuredPreferredEntries[0]!,
            backendTarget: claudeTarget,
            backendTargetKey: resolveBackendTargetKeyV2(claudeTarget),
            backendId: 'claude', agentId: 'claude', catalogAgentId: 'claude',
            builtInAgentId: 'claude', iconAgentId: 'claude', title: 'Claude', subtitle: 'claude',
        });
        let currentEntries = [claudeEntry];
        let persistedBackendTarget: unknown = null;
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;
        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries: currentEntries, configuredCatalogReady: true,
                persistedBackendTarget,
                routeBackendTarget: source === 'route' ? claudeTarget : null,
                projectionPhase: 'ready',
            });
            return null;
        }
        const screen = await renderScreen(React.createElement(Probe));
        const readObserved = () => {
            if (!observed) throw new Error('Selection owner did not render');
            return observed;
        };
        if (source === 'picker') {
            await act(async () => readObserved().setBackendTarget(claudeTarget));
        }
        persistedBackendTarget = configuredPreferredEntries[1]!.backendTarget;
        currentEntries = [configuredPreferredEntries[1]!];
        await screen.update(React.createElement(Probe));
        expect(readObserved().backendTarget).toEqual(claudeTarget);
        currentEntries = [claudeEntry, configuredPreferredEntries[1]!];
        await screen.update(React.createElement(Probe));
        expect(readObserved().backendTarget).toEqual(claudeTarget);
        await act(async () => screen.tree.unmount());
    });
    it('retains definition-qualified intent through loading and deletion without a bundled fallback', async () => {
        const target = { kind: 'agent' as const,
            identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-a' };
        let currentEntries = [configuredPreferredEntries[0]!];
        let configuredCatalogReady = false;
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;
        function Probe() {
            observed = useNewSessionBackendTargetState({ entries: currentEntries, configuredCatalogReady,
                persistedBackendTarget: target, projectionPhase: 'ready' });
            return null;
        }
        const screen = await renderScreen(React.createElement(Probe));
        const readObserved = () => observed;
        expect(readObserved()?.backendTarget).toEqual(target);
        expect(readObserved()?.selectedRuntimeCarrierAgentId).toBeNull();
        configuredCatalogReady = true;
        currentEntries = [...currentEntries];
        await screen.update(React.createElement(Probe));
        expect(readObserved()?.backendTarget).toEqual(target);
        expect(readObserved()?.selectedRuntimeCarrierAgentId).toBeNull();
        expect(storage.getState().settings).toBe(initialSettings);
        await act(async () => screen.tree.unmount());
    });
    it('retains the same selected target when equivalent catalog inputs are recreated', async () => {
        let currentEntries: readonly ResolvedBackendCatalogEntry[] = [];
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;
        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries: currentEntries,
                projectionPhase: 'ready',
            });
            return null;
        }
        const screen = await renderScreen(React.createElement(Probe));
        const readSelectedTarget = () => {
            if (!observed) throw new Error('Selection owner did not render');
            return observed.backendTarget;
        };
        const selectedTarget = readSelectedTarget();
        currentEntries = [];
        await screen.update(React.createElement(Probe));
        // The selection is unchanged; catalog identity churn must not replace
        // it or turn automatic reconciliation into an explicit user selection.
        expect(storage.getState().settings).toBe(initialSettings);
        expect(readSelectedTarget()).toBe(selectedTarget);
        await act(async () => screen.tree.unmount());
    });

    it('preserves the selected target and remembered settings while the Account catalog is unavailable', async () => {
        const lastUsedBackendTarget = { kind: 'backend' as const, backendId: 'codex' };
        seedPreferences({ lastUsedBackendTarget });
        const unavailableEntries: readonly ResolvedBackendCatalogEntry[] = [];
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;
        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries: unavailableEntries, configuredCatalogReady: false,
                projectionPhase: 'ready',
            });
            return null;
        }
        const screen = await renderScreen(React.createElement(Probe));
        const readObserved = () => observed;
        expect(resolveBackendTargetKeyV2(readObserved()!.backendTarget)).toBe(resolveBackendTargetKeyV2(lastUsedBackendTarget));
        expect(storage.getState().settings).toBe(initialSettings);
        await act(async () => screen.tree.unmount());
    });

    it('restores the last used configured ACP backend target instead of the provider sentinel', async () => {
        seedPreferences({ lastUsedAgent: 'customAcp', lastUsedBackendTarget: {
            kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured',
        } });
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries,
            });
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(observed).not.toBeNull();
        expect(resolveBackendTargetKeyV2(observed!.backendTarget)).toBe('agent:happier.agent.custom-acp/custom-acp:definition:review-bot');
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedCatalogAgentId).toBeNull();
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedUiAgentType).toBe('review-bot');
    });

    it('persists the definition-qualified target without rewriting the last-used bundled Agent', async () => {
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries,
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(Probe))).tree;

        await act(async () => {
            observed?.setBackendTarget({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' });
        });

        expect(storage.getState().settings.lastUsedBackendTarget).toEqual({
            kind: 'agent',
            identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
            definitionId: 'review-bot',
        });
        expect(storage.getState().settings.lastUsedAgent).toBe('codex');

        act(() => {
            tree?.unmount();
        });
    });

    it('falls back to an available last-used built-in target when temp agent params point to an unavailable built-in agent', async () => {
        const fallbackEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
            resolvedEntryFixture({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                backendTargetKey: 'agent:happier.agent.codex/codex',
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
            });
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(observed).not.toBeNull();
        expect(resolveBackendTargetKeyV2(observed!.backendTarget)).toBe('agent:happier.agent.codex/codex');
    });

    it('prefers an available configured backend target over built-in defaults when no explicit target is stored', async () => {
        let observed: ReturnType<typeof useNewSessionBackendTargetState> | null = null;

        function Probe() {
            observed = useNewSessionBackendTargetState({
                entries: configuredPreferredEntries,
            });
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(observed).not.toBeNull();
        expect(resolveBackendTargetKeyV2(observed!.backendTarget)).toBe('agent:happier.agent.custom-acp/custom-acp:definition:review-bot');
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedCatalogAgentId).toBeNull();
    });

    it('keeps an unbacked plugin Agent separate from bundled static policy', async () => {
        seedPreferences({ lastUsedBackendTarget: { kind: 'backend', backendId: 'acme.review.backend' } });
        const pluginEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
            resolvedEntryFixture({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                backendTargetKey: 'agent:happier.agent.codex/codex',
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
            });
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
                backendTargetKey: 'agent:happier.agent.codex/codex',
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
                projectionPhase: 'loading',
            });
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(observed).not.toBeNull();
        expect(resolveBackendTargetKeyV2(observed!.backendTarget)).toBe('backend:acme.review.backend');
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedRuntimeCarrierAgentId).toBeNull();
    });

    it('keeps the projected external Agent id as the plugin backend runtime selection', async () => {
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
                projectionPhase: 'ready',
            });
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedCatalogAgentId).toBe('claude');
        expect((observed as ReturnType<typeof useNewSessionBackendTargetState> | null)?.selectedRuntimeCarrierAgentId).toBe('plugin:acme.review');
    });

    it('persists plugin backend selection without writing lastUsedAgent (V1 compatibility only)', async () => {
        seedPreferences({ lastUsedAgent: 'claude' });
        const pluginEntries: ReadonlyArray<ResolvedBackendCatalogEntry> = [
            resolvedEntryFixture({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                backendTargetKey: 'agent:happier.agent.codex/codex',
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
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(Probe))).tree;

        await act(async () => {
            observed?.setBackendTarget({ kind: 'backend', backendId: 'acme.review.backend' });
        });

        expect(storage.getState().settings.lastUsedBackendTarget).toEqual({ kind: 'backend', backendId: 'acme.review.backend' });
        expect(storage.getState().settings.lastUsedAgent).toBe('claude');

        act(() => {
            tree?.unmount();
        });
    });

    it('persists Oh My Pi selection as structured identity and clears the flat compatibility field', async () => {
        seedPreferences({ lastUsedAgent: 'claude' });
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
            });
            return null;
        }

        const { tree } = await renderScreen(React.createElement(Probe));
        await act(async () => {
            observed?.setBackendTarget({ kind: 'backend', backendId: 'ohMyPi' });
        });

        expect(storage.getState().settings.lastUsedAgent).toBeNull();
        expect(storage.getState().settings.lastUsedBackendTarget).toEqual({
            kind: 'agent',
            identity: {
                pluginId: 'happier.agent.ohmypi',
                localId: 'ohmypi',
            },
        });

        act(() => {
            tree.unmount();
        });
    });
});
