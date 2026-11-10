import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup, teamSummaryFixture, teamPolicyFixture, teamCapabilitiesFixture } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { SessionAccessEditorProps } from '@/components/sessions/access/sessionAccessEditorTypes';
import type { NewSessionMachineSelectionContentProps } from '../components/NewSessionMachineSelectionContent';

// This model never renders Markdown; only the external rendering dependency is replaced.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
installNewSessionScreenModelCommonModuleMocks({ routerConfig: { pathname: '/', params: {} } });
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { useNewSessionScreenModel } = await import('./useNewSessionScreenModel');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { applyTeamProjection, resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');

beforeEach(async () => { network.resetRequests(); storage.setState(storage.getInitialState(), true); resetTeamsSnapshotsForTests(); await prepareSessionDraftPersistenceStorage(); });
afterEach(async () => { standardCleanup(); resetTeamsDirectoryEngineForTests(); resetTeamsSnapshotsForTests(); await disconnectActiveServerConnection(); });
afterAll(() => network.dispose());

describe('shared Team defaults through New Session', () => {
    it.each([false, true])('preselects the member preset with a late snapshot=%s', async late => {
        const home = await network.addHome('https://shared-team-defaults.test', 'admin-a');
        const placement = { kind: 'preset', homeId: home.id, presetId: '0459116f-1a83-483a-b734-fdcfe8c7f2bf' } as const;
        const policy = teamPolicyFixture({ managedDefaults: { team: { placement }, groups: {} }, managedDefaultsStatus: 'available' });
        // A's projection cannot satisfy B's qualified read, even on the same Home.
        applyTeamProjection({ scope: { serverId: home.id, accountId: 'admin-a' }, address: { serverId: home.id, teamId: 'team-1' }, observedAt: 1,
            team: teamSummaryFixture({ policy, capabilities: teamCapabilitiesFixture({ manageSettings: true }) }) });
        const member = await network.addHome(home.serverUrl, 'member-b');
        const team = teamSummaryFixture({ policy, viewerRole: 'member', capabilities: teamCapabilitiesFixture({}) });
        network.setHttpResponder(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: { teams: { enabled: true } } }));
            if (path === '/v1/teams/list') return Response.json({ items: [team], nextCursor: null });
            // Snapshot arrival is driven explicitly below, through the production push store.
            if (path === '/v1/teams/get') return new Response(null, { status: 503 });
            return null;
        });
        await upsertAndActivateServer({ serverUrl: member.serverUrl });
        await restoreConnectionToActiveServer({ token: member.token });
        const scope = { serverId: member.id, accountId: 'member-b' };
        await vi.waitFor(() => expect(storage.getState().settingsScope).toEqual(scope));
        storage.setState({ profileScope: scope, settingsScope: scope, settings: { ...settingsDefaults, useEnhancedSessionWizard: false } });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', active: true, storageMode: 'plain' })], false, { sourceServerId: member.id });
        storage.getState().applyAuthoringMemory({ recentMachinePaths: [{ machineId: 'machine-1', path: '/repo' }] });
        const publish = () => applyTeamProjection({ scope, address: { serverId: member.id, teamId: 'team-1' }, observedAt: 2, team });
        if (!late) publish();
        const model = await renderHook(() => useNewSessionScreenModel({ draftId: `shared-team-${late}` }));
        const simple = () => {
            const current = model.getCurrent();
            if (current.variant !== 'simple') throw new Error('Expected Home composer');
            return current.simpleProps;
        };
        await act(async () => { await vi.waitFor(() => expect(simple().agentInputExtraActionChips?.some(chip => chip.key === 'session-access')).toBe(true)); });
        const chip = simple().agentInputExtraActionChips?.find(chip => chip.key === 'session-access');
        const render = chip?.collapsedContentPopover?.renderContent;
        if (typeof render !== 'function') throw new Error('Expected access editor');
        const editor = render({ requestClose: () => {}, maxHeight: 600 });
        if (!React.isValidElement<SessionAccessEditorProps>(editor)) throw new Error('Expected access editor element');
        await act(async () => editor.props.actions.addPrincipal({ kind: 'team', teamId: 'team-1' }));
        if (late) {
            expect(simple().selectedMachineId).toBe('machine-1');
            await act(async () => { publish(); });
        }
        const machineContent = simple().machinePopover?.renderContent;
        if (typeof machineContent !== 'function') throw new Error('Expected Machine picker');
        const picker = machineContent({ requestClose: () => {}, maxHeight: 600 });
        if (!React.isValidElement<NewSessionMachineSelectionContentProps>(picker)) throw new Error('Expected Machine picker element');
        expect(picker.props.managedPlacementPreset).toEqual(placement);
        expect(simple().selectedMachineId).not.toBe('machine-1');
        await model.unmount();
    });
});
