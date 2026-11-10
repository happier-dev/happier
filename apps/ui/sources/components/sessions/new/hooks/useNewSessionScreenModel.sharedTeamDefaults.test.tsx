import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, renderHook, standardCleanup, teamSummaryFixture, teamPolicyFixture, teamCapabilitiesFixture } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/selection/v1';
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
const { router } = await import('expo-router');
const { useSessionAccessTeamNames } = await import('@/components/sessions/access/useSessionAccessTeamNames');
const { useTeamBinding } = await import('@/hooks/teams/useTeamBinding');
const { useNewSessionScreenModel } = await import('./useNewSessionScreenModel');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { applyTeamProjection, resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');

beforeEach(async () => { network.resetRequests(); storage.setState(storage.getInitialState(), true); resetTeamsSnapshotsForTests(); await prepareSessionDraftPersistenceStorage(); });
afterEach(async () => { standardCleanup(); resetTeamsDirectoryEngineForTests(); resetTeamsSnapshotsForTests(); await disconnectActiveServerConnection(); });
afterAll(() => network.dispose());

describe('shared Team defaults through New Session', () => {
    it.each([{ late: false, override: true }, { late: true, override: true },
        { late: false, override: false }, { late: true, override: false }])('restores explicit placement=$override and Team label with late snapshot=$late', async ({ late, override }) => {
        const home = await network.addHome('https://shared-team-defaults.test', 'admin-a');
        const placement = { kind: 'preset', homeId: home.id, presetId: '0459116f-1a83-483a-b734-fdcfe8c7f2bf' } as const;
        const agentTargetKey = 'agent:happier.agent.claude/claude';
        const policy = teamPolicyFixture({ managedDefaults: { team: { placement,
            permissionModeByAgentTargetKey: { [agentTargetKey]: 'read-only' },
            modelByAgentTargetKey: { [agentTargetKey]: SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 1,
                ref: { agentTargetKey, providerConnectionId: null, modelId: 'sonnet' } }) },
        }, groups: {} }, managedDefaultsStatus: 'available' });
        // A's projection cannot satisfy B's qualified read, even on the same Home.
        applyTeamProjection({ scope: { serverId: home.id, accountId: 'admin-a' }, address: { serverId: home.id, teamId: 'team-1' }, observedAt: 1,
            team: teamSummaryFixture({ policy, capabilities: teamCapabilitiesFixture({ manageSettings: true }) }) });
        const member = await network.addHome(home.serverUrl, 'member-b');
        const team = teamSummaryFixture({ policy, viewerRole: 'member', capabilities: teamCapabilitiesFixture({}) });
        let teamArrival = createDeferred<void>();
        network.setHttpResponder(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: { teams: { enabled: true } } }));
            if (path === '/v1/teams/list') return Response.json({ items: [team], nextCursor: null });
            if (path === '/v1/teams/get') { await teamArrival.promise; return Response.json(team); }
            return null;
        });
        await upsertAndActivateServer({ serverUrl: member.serverUrl });
        await restoreConnectionToActiveServer({ token: member.token });
        const scope = { serverId: member.id, accountId: 'member-b' };
        await vi.waitFor(() => expect(storage.getState().settingsScope).toEqual(scope));
        storage.setState({ profileScope: scope, settingsScope: scope, settings: { ...settingsDefaults, useEnhancedSessionWizard: false } });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', active: true, storageMode: 'plain' })], false, { sourceServerId: member.id });
        storage.getState().applyAuthoringMemory({ recentMachinePaths: [{ machineId: 'machine-1', path: '/repo' }] });
        const publish = () => { teamArrival.resolve(); applyTeamProjection({ scope, address: { serverId: member.id, teamId: 'team-1' }, observedAt: 2, team }); };
        if (!late) publish();
        let model = await renderHook(() => useNewSessionScreenModel({ draftId: `shared-team-${late}-${override}` }));
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
        await act(async () => simple().promptStore.setPrompt('Continue the Team task'));
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
        // Pick through the real New Session Machine picker, leave, then restore
        // the same draft through its repository reader (not a hand-built seed).
        if (override) await act(async () => picker.props.onSelectMachine(createMachineFixture({ id: 'machine-1', active: true, storageMode: 'plain' })));
        expect(simple().permissionMode).toBe('read-only');
        expect(simple().modelMode).toBe('sonnet');
        if (override) await act(async () => {
            simple().handlePermissionModeChange('default');
            simple().setModelMode('default');
        });
        expect(simple().permissionMode).toBe(override ? 'default' : 'read-only');
        expect(simple().modelMode).toBe(override ? 'default' : 'sonnet');
        if (override) expect(simple().selectedMachineId).toBe('machine-1');
        await model.unmount();
        const saved = readNewSessionDraftFromRepository({ scope, draftId: `shared-team-${late}-${override}` });
        expect(saved?.input).toBe('Continue the Team task');
        expect(saved?.permissionModeExplicit).toBe(override ? true : undefined);
        expect(saved?.permissionMode).toBe('default');
        expect(saved?.modelSelection).toBe(override ? null : undefined);
        expect(saved?.access?.grants[0]?.subject).toEqual({ kind: 'team', teamId: 'team-1' });
        if (late) { teamArrival = createDeferred<void>(); resetTeamsSnapshotsForTests(); }
        // Returning from another page opens the draft without the old picker route handoff.
        router.setParams({ machineId: undefined, spawnServerId: undefined, machinePoolId: undefined });
        model = await renderHook(() => useNewSessionScreenModel({ draftId: `shared-team-${late}-${override}` }));
        if (late) await act(async () => { publish(); });
        // Wait for the same qualified binding that supplies restored defaults.
        const binding = await renderHook(() => useTeamBinding(member.id, 'team-1'));
        await act(async () => { await vi.waitFor(() => {
            const current = binding.getCurrent();
            expect(current.kind === 'bound' ? current.state.kind : null).toBe('ready');
        }); });
        await binding.unmount();
        expect(simple().permissionMode).toBe(override ? 'default' : 'read-only');
        expect(simple().modelMode).toBe(override ? 'default' : 'sonnet');
        if (override) expect(simple().selectedMachineId).toBe('machine-1');
        const restoredChip = simple().agentInputExtraActionChips?.find(chip => chip.key === 'session-access');
        expect(restoredChip?.collapsedContentPopover?.label).toBe(team.name);
        if (!late && !override) {
            let renders = 0;
            const labels = await renderHook(() => {
                renders += 1;
                return useSessionAccessTeamNames(scope, [{ kind: 'team', teamId: 'team-1' }]);
            });
            const previous = labels.getCurrent();
            renders = 0;
            await act(async () => {
                for (let index = 0; index < 1000; index += 1) applyTeamProjection({ scope,
                    address: { serverId: member.id, teamId: `unrelated-${index}` }, observedAt: 3,
                    team: teamSummaryFixture({ id: `unrelated-${index}` }) });
            });
            expect(renders).toBe(0);
            expect(labels.getCurrent()).toBe(previous);
            await act(async () => { applyTeamProjection({ scope,
                address: { serverId: member.id, teamId: 'team-1' }, observedAt: 4,
                team: { ...team, name: 'Renamed Team' } }); });
            expect(labels.getCurrent().get('team-1')).toBe('Renamed Team');
            expect(renders).toBeGreaterThan(0);
            await labels.unmount();
        }
        await model.unmount();
    });
});
