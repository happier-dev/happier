import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { rememberLastUsedBackendSelection, readLastUsedBackendSelection } from '@/sync/domains/state/newSessionTargetUiState';
import { clearPersistenceStorage } from '@/sync/domains/state/persistenceStorage';

installNewSessionScreenModelCommonModuleMocks();
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { createResolvedAgentCatalogEntryFixture } = await import('@/dev/testkit/fixtures/agentCatalogFixtures');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults, settingsParse } = await import('@/sync/domains/settings/settings');
const { useNewSessionBackendTargetState } = await import('./useNewSessionBackendTargetState');

const codexTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
const claudeTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
const entries: ReadonlyArray<ResolvedBackendCatalogEntry> = (['codex', 'claude'] as const).map(agentId => ({
    backendTarget: agentId === 'codex' ? codexTarget : claudeTarget,
    backendTargetKey: `agent:happier.agent.${agentId}/${agentId}`,
    kind: 'builtInAgent', backendId: agentId, agentId,
    catalogAgentId: agentId, builtInAgentId: agentId, iconAgentId: agentId,
    title: agentId, subtitle: agentId, cliAuthBackgroundCheckSafe: false,
    agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId }),
}));

beforeEach(() => {
    network.resetRequests();
    clearPersistenceStorage();
    storage.setState(storage.getInitialState(), true);
    rememberLastUsedBackendSelection(null, { lastUsedAgent: 'codex', lastUsedBackendTarget: codexTarget });
    storage.setState({ settings: settingsParse({ ...settingsDefaults, lastUsedAgent: 'codex', lastUsedBackendTarget: codexTarget,
        actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }) });
});
afterEach(() => standardCleanup());
afterAll(() => network.dispose());

describe('New Session last-used target memory with Settings writes Off', () => {
    it('observes current remembered defaults until the user authors a selection', async () => {
        const subject = await renderHook(() => {
            return useNewSessionBackendTargetState({ entries: [], projectionPhase: 'ready' });
        });
        expect(subject.getCurrent().backendTarget).toEqual(codexTarget);
        await act(async () => rememberLastUsedBackendSelection(null, { lastUsedAgent: 'claude', lastUsedBackendTarget: claudeTarget }));
        expect(subject.getCurrent().backendTarget).toEqual(claudeTarget);
        await subject.unmount();
    });

    it.each(['value', 'updater'] as const)('persists %s picker intent once and ignores preference echoes and another Session while keeping catalog current', async selectionKind => {
        let renders = 0;
        let currentEntries = entries;
        const subject = await renderHook(() => {
            renders++;
            return useNewSessionBackendTargetState({ entries: currentEntries, projectionPhase: 'ready' });
        });
        await act(async () => subject.getCurrent().setBackendTarget(selectionKind === 'updater' ? () => claudeTarget : claudeTarget));
        expect(readLastUsedBackendSelection(null).lastUsedBackendTarget).toEqual(claudeTarget);
        const settledRenders = renders;
        await act(async () => rememberLastUsedBackendSelection(null, { lastUsedBackendTarget: { ...claudeTarget } }));
        expect(renders).toBe(settledRenders);
        await act(async () => rememberLastUsedBackendSelection(null, { lastUsedAgent: 'codex', lastUsedBackendTarget: codexTarget }));
        expect(readLastUsedBackendSelection(null).lastUsedBackendTarget).toEqual(codexTarget);
        expect(subject.getCurrent().backendTarget).toEqual(claudeTarget);
        expect(renders).toBe(settledRenders);
        // A fresh picker intent can remember this target again after another
        // Session changed the default, even though its logical key is unchanged.
        await act(async () => subject.getCurrent().setBackendTarget(selectionKind === 'updater' ? () => claudeTarget : claudeTarget));
        expect(readLastUsedBackendSelection(null).lastUsedBackendTarget).toEqual(claudeTarget);
        currentEntries = entries.map(entry => entry.agentId === 'claude' ? { ...entry, agentId: 'claude-current' } : entry);
        await subject.rerender();
        expect(subject.getCurrent().backendTarget).toEqual(claudeTarget);
        expect(subject.getCurrent().selectedUiAgentType).toBe('claude-current');
        expect(renders).toBeGreaterThan(settledRenders);
        await subject.unmount();
    });
});
