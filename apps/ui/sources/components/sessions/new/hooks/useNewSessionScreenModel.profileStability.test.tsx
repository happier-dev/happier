import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';

// The hook does not render Markdown; this patched native package is an external rendering boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));
const explicitTargetKey = 'agent:happier.agent.claude/claude';
installNewSessionScreenModelCommonModuleMocks({ routerConfig: { pathname: '/', params: { machineId: 'studio', backendTargetKey: explicitTargetKey } } });
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { applyAcpCatalogSnapshot } = await import('@/sync/store/settings/acpCatalogSnapshot');
const { useDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/useDaemonMergedProjectionInputs');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { NewSessionEmbeddedHostProvider } = await import('../navigation/newSessionHost');
const { useNewSessionScreenModel } = await import('./useNewSessionScreenModel');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');

beforeEach(async () => { network.resetRequests(); storage.setState(storage.getInitialState(), true); await prepareSessionDraftPersistenceStorage(); });
afterEach(async () => { standardCleanup(); clearDaemonMergedProjectionCacheForTests(); await disconnectActiveServerConnection(); });
afterAll(() => network.dispose());

describe('remembered launch profile through real New Session state', () => {
    it.each(['route', 'cold-home'] as const)('settles a deleted remembered profile on %s', async surface => {
        const savedHome = await network.addHome(`https://profile-stability-${surface}.test`, 'owner');
        network.setHttpResponder(async input => new URL(String(input)).pathname === '/v1/account/encryption'
            ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
        network.setRpcResponder(async request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {} } } : {});
        await upsertAndActivateServer({ serverUrl: savedHome.serverUrl });
        await restoreConnectionToActiveServer({ token: savedHome.token });
        const scope = { serverId: savedHome.id, accountId: 'owner' };
        await vi.waitFor(() => {
            expect(storage.getState().isDataReady).toBe(true);
            expect(storage.getState().settingsScope).toEqual(scope);
        });
        const machine = createMachineFixture({ id: 'studio', active: true, activeAt: Date.now(), storageMode: 'plain' });
        storage.setState({ profileScope: scope, settingsScope: scope,
            settings: { ...settingsDefaults, useProfiles: true, useEnhancedSessionWizard: false } });
        storage.getState().applyMachines([machine], false, { sourceServerId: savedHome.id });
        observeMachinePresenceForTest(scope, ['studio']);
        storage.getState().applyAuthoringMemory({ lastUsedProfile: 'deleted-profile' });
        // A cold Home can reuse this current projection without demanding any new Machine work.
        const projection = await renderHook(() => useDaemonMergedProjectionInputs({ machineId: 'studio', serverId: savedHome.id }));
        await act(async () => { await vi.waitFor(() => expect(projection.getCurrent().phase, projection.getCurrent().failureReason).toBe('ready')); });
        const host = { params: { machineId: 'studio', backendTargetKey: explicitTargetKey }, targetServerId: savedHome.id,
            setParams: () => {}, openDraft: () => {}, onHandedOff: () => {}, demanded: false };
        const wrapper = surface === 'cold-home' ? ({ children }: React.PropsWithChildren) =>
            <NewSessionEmbeddedHostProvider host={host}>{children}</NewSessionEmbeddedHostProvider> : undefined;
        let renders = 0;
        const model = await renderHook(() => {
            if (++renders > 64) throw new Error('Remembered profile restoration does not settle');
            return useNewSessionScreenModel({ draftId: `profile-stability-${surface}` });
        }, { wrapper });
        const selectedProfileId = () => {
            const current = model.getCurrent();
            expect(current.variant).toBe('simple');
            if (current.variant !== 'simple') throw new Error('Expected simple New Session surface');
            return current.simpleProps.selectedProfileId;
        };
        // Pending catalogs cannot establish that the remembered profile has disappeared.
        expect(selectedProfileId()).toBe('deleted-profile');
        await model.rerender();
        expect(selectedProfileId()).toBe('deleted-profile');
        // The canonical catalog becoming current is the point where the model can reject a missing profile.
        await act(async () => applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1,
            record: { v: 1, definitions: [] } }, true));
        await model.rerender();
        expect(selectedProfileId()).toBeNull();
        expect(storage.getState().authoringMemory.lastUsedProfile).toBe('deleted-profile');
        await act(async () => { await Promise.resolve(); });
        const settledRenders = renders;
        const previousThinkingDisplay = storage.getState().settings.sessionThinkingDisplayMode;
        await act(async () => {
            storage.getState().applySettingsLocal({ sessionThinkingDisplayMode: previousThinkingDisplay === 'inline' ? 'hidden' : 'inline' });
        });
        expect(storage.getState().settings.sessionThinkingDisplayMode).not.toBe(previousThinkingDisplay);
        expect(renders - settledRenders).toBe(0);
        await act(async () => {
            storage.getState().applySettingsLocal({ newSessionWizardColumnsEnabled: true });
        });
        expect(renders - settledRenders).toBe(0);
        await act(async () => {
            storage.getState().applySettingsLocal({ newSessionWizardSectionPresentationV1: { machines: 'dropdown' } });
        });
        expect(renders - settledRenders).toBe(0);
        for (const backendId of ['codex', 'claude', 'codex']) {
            await act(async () => storage.getState().applySettingsLocal({
                lastUsedBackendTarget: { kind: 'backend', backendId },
                lastNewSessionAgentPickerViewV1: { kind: 'backend', backendTargetKey: `agent:happier.agent.${backendId}/${backendId}` },
            }));
        }
        expect(renders - settledRenders).toBe(0);
        // Locality must not freeze real New Session inputs at mount.
        await act(async () => {
            storage.getState().applySettingsLocal({ useEnhancedSessionWizard: true });
        });
        expect(model.getCurrent().variant).toBe(surface === 'route' ? 'wizard' : 'simple');
        if (surface === 'cold-home') expect(renders - settledRenders).toBe(0);
        if (surface === 'route') {
            expect(renders).toBeGreaterThan(settledRenders);
            const wizard = model.getCurrent();
            expect(wizard.variant === 'wizard' && wizard.wizardProps.useColumnLayout).toBe(true);
            expect(wizard.variant === 'wizard' && wizard.wizardProps.sectionPresentation?.machines).toBe('dropdown');
            const beforeLayoutChange = renders;
            await act(async () => storage.getState().applySettingsLocal({
                newSessionWizardColumnsEnabled: false,
                newSessionWizardSectionPresentationV1: { machines: 'list' },
            }));
            const updated = model.getCurrent();
            expect(updated.variant === 'wizard' && updated.wizardProps.useColumnLayout).toBe(false);
            expect(updated.variant === 'wizard' && updated.wizardProps.sectionPresentation?.machines).toBe('list');
            expect(renders).toBeGreaterThan(beforeLayoutChange);
        }
        await model.unmount();
        await projection.unmount();
    });
});
