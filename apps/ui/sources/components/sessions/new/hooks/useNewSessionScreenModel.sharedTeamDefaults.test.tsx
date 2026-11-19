import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, createPlainProjectAccountRowListFixture, renderHook, standardCleanup, teamSummaryFixture, teamPolicyFixture, teamCapabilitiesFixture } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createAccountSettingsHttpBoundary } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/selection/v1';
import type { SessionAccessEditorProps } from '@/components/sessions/access/sessionAccessEditorTypes';
import type { NewSessionMachineSelectionContentProps } from '../components/NewSessionMachineSelectionContent';

// This model never renders Markdown; only the external rendering dependency is replaced.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
const viewport = vi.hoisted(() => ({ width: 1440 }));
installNewSessionScreenModelCommonModuleMocks({
    routerConfig: { pathname: '/', params: {} },
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        useWindowDimensions: () => ({ width: viewport.width, height: 900, scale: 1, fontScale: 1 }),
    }),
});
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

beforeEach(async () => { viewport.width = 1440; network.resetRequests(); storage.setState(storage.getInitialState(), true); resetTeamsSnapshotsForTests(); await prepareSessionDraftPersistenceStorage(); });
afterEach(async () => { standardCleanup(); resetTeamsDirectoryEngineForTests(); resetTeamsSnapshotsForTests(); await disconnectActiveServerConnection(); });
afterAll(() => network.dispose());

describe('shared Team defaults through New Session', () => {
    it('inherits Codex defaults on the New Session route from a saved Project origin', async () => {
        const home = await network.addHome('https://project-team-defaults.test', 'member');
        const scope = { serverId: home.id, accountId: 'member' };
        const settings = { ...settingsDefaults, useEnhancedSessionWizard: false };
        const accountSettings = createAccountSettingsHttpBoundary({ serverUrl: home.serverUrl,
            initialAccounts: [{ accountId: scope.accountId, snapshot: { content: { t: 'plain', v: settings }, version: 1 } }] });
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const modelId = 'gpt-5.1-codex';
        const team = teamSummaryFixture({ viewerRole: 'member', policy: teamPolicyFixture({ managedDefaultsStatus: 'available',
            managedDefaults: { groups: {}, team: {
                permissionModeByAgentTargetKey: { [agentTargetKey]: 'read-only' },
                modelByAgentTargetKey: { [agentTargetKey]: SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 1,
                    ref: { agentTargetKey, providerConnectionId: null, modelId } }) },
            } },
        }) });
        const source = { id: 'shared-source', name: 'Shared project', revision: 1,
            owner: { kind: 'team', teamId: team.id }, audience: [], createdByAccountId: 'owner' };
        const checkout = { id: 'project-checkout', projectKey: 'project-anchor', serverId: home.id, machineId: 'machine-1',
            rootPath: '/repo', createdAtMs: 1, source: { sourceId: source.id, revision: source.revision } };
        const projectRows = createPlainProjectAccountRowListFixture({ workspaceRefs: [checkout] });
        const sourceArrival = createDeferred<void>();
        let sourceRequested = false;
        network.setHttpResponder(async (input, init) => {
            const response = accountSettings.handle(input, init);
            if (response) return response;
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: { teams: { enabled: true } } }));
            if (path === '/v1/teams/list') return Response.json({ items: [team], nextCursor: null });
            if (path === '/v1/teams/get') return Response.json(team);
            if (path === `/v1/projects/sources/${source.id}`) {
                sourceRequested = true;
                await sourceArrival.promise;
                return Response.json({ ok: true, source, canManage: false });
            }
            if (path === '/v1/account/project-rows/list') return Response.json(projectRows);
            if (path === '/v1/account/project-rows/read') return Response.json({ status: 'absent' });
            return null;
        });
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        await vi.waitFor(() => expect(storage.getState().profileScope).toEqual(scope));
        storage.getState().applySettingsLocal(settings);
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', active: true, storageMode: 'plain' })], false,
            { sourceServerId: home.id });
        await vi.waitFor(() => expect(storage.getState().projectAccountRows?.workspaceRefs).toContainEqual(expect.objectContaining({ id: checkout.id })));
        const { buildProjectNewSessionOrigin, admitProjectAuthoringOrigin } = await import('@/components/projects/detail/projectRouteState');
        const { workspaceAddressFromRefV1 } = await import('@happier-dev/protocol/workspaces/workspaceRefResolutionV1');
        const { seedAndOpenNewSession } = await import('../newSessionSeedComposer');
        const origin = buildProjectNewSessionOrigin({ scope, workspace: workspaceAddressFromRefV1(checkout), page: 'defaults', routeParams: {} });
        if (!origin) throw new Error('Expected a Project origin');
        const opened = seedAndOpenNewSession({ scope, isCurrent: () => true,
            admitOrigin: candidate => admitProjectAuthoringOrigin(candidate, scope),
            seed: { origin, placement: { kind: 'exactTarget', serverId: checkout.serverId, machineId: checkout.machineId, directory: checkout.rootPath } },
            navigateToNewSession: ({ draftId }) => router.setParams({ draftId }),
        });
        if (opened.kind !== 'opened') throw new Error(`Expected a seeded Project draft, got ${opened.kind}`);
        const draft = readNewSessionDraftFromRepository({ scope, draftId: opened.draftId });
        expect(draft).toMatchObject({ authoringOrigin: origin });
        expect(draft).not.toHaveProperty('modelSelection');
        const model = await renderHook(() => useNewSessionScreenModel({ draftId: opened.draftId }));
        const simple = () => {
            const current = model.getCurrent();
            if (current.variant !== 'simple') throw new Error('Expected simple composer');
            return current.simpleProps;
        };
        try {
            await act(async () => {
                const codex = simple().agentPickerOptions?.find(option => option.id.includes('codex'));
                if (!codex || !simple().onAgentPickerSelect) throw new Error('Expected Codex in the Agent picker');
                simple().onAgentPickerSelect?.(codex.id);
            });
            expect(simple().permissionMode).toBe('default');
            await vi.waitFor(() => expect(sourceRequested).toBe(true));
            await act(async () => sourceArrival.resolve());
            await vi.waitFor(() => expect({ permissionMode: simple().permissionMode, modelMode: simple().modelMode })
                .toEqual({ permissionMode: 'read-only', modelMode: modelId }));
        } finally {
            sourceArrival.resolve();
            await model.unmount();
        }
    });

    it.each([false, true])('captures effective Machine approval defaults with inherited placement=%s without rereading settings', async inherited => {
        const home = await network.addHome('https://machine-approval-capture.test', 'member');
        const targetMachineId = inherited ? 'machine-2' : 'machine-1';
        const profileId = inherited ? 'approval-inherited-machine' : 'approval-machine';
        const team = teamSummaryFixture({ policy: teamPolicyFixture({ managedDefaults: { team: {
            placement: { kind: 'machine', target: { serverId: home.id, machineId: 'machine-2' } },
        }, groups: {} }, managedDefaultsStatus: 'available' }) });
        const settings = { ...settingsDefaults, useEnhancedSessionWizard: false,
            actionsSettingsV1: { ...settingsDefaults.actionsSettingsV1,
                machineApprovalProfiles: { 'machine-1': 'approval-machine', 'machine-2': 'approval-inherited-machine' } } };
        const accountSettings = createAccountSettingsHttpBoundary({ serverUrl: home.serverUrl,
            initialAccounts: [{ accountId: 'member', snapshot: { content: { t: 'plain', v: settings }, version: 1 } }] });
        network.setHttpResponder(async (input, init) => {
            const settingsResponse = accountSettings.handle(input, init);
            if (settingsResponse) return settingsResponse;
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: { teams: { enabled: true } } }));
            if (path === '/v1/teams/list') return Response.json({ items: [team], nextCursor: null });
            if (path === '/v1/teams/get') return Response.json(team);
            return null;
        });
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        const scope = { serverId: home.id, accountId: 'member' };
        await vi.waitFor(() => expect(storage.getState().settingsScope).toEqual(scope));
        // Publish through Settings' persistence owner so scoped subscribers
        // observe the same preference as the admitted Home HTTP baseline.
        storage.getState().applySettingsLocal(settings);
        storage.getState().applyMachines(['machine-1', 'machine-2'].map(id => createMachineFixture({ id, active: true, storageMode: 'plain' })), false,
            { sourceServerId: home.id });
        storage.getState().applyAuthoringMemory({ recentMachinePaths: [{ machineId: 'machine-1', path: '/repo' }] });
        const model = await renderHook(() => useNewSessionScreenModel({ draftId: 'machine-approval-capture' }));
        try {
            const simple = () => {
                const current = model.getCurrent();
                if (current.variant !== 'simple') throw new Error('Expected Home composer');
                return current.simpleProps;
            };
            if (inherited) {
                applyTeamProjection({ scope, address: { serverId: home.id, teamId: team.id }, observedAt: 1, team });
                await act(async () => { await vi.waitFor(() => expect(simple().agentInputExtraActionChips
                    ?.some(chip => chip.key === 'session-access')).toBe(true)); });
                const render = simple().agentInputExtraActionChips?.find(chip => chip.key === 'session-access')?.collapsedContentPopover?.renderContent;
                if (typeof render !== 'function') throw new Error('Expected access editor');
                const editor = render({ requestClose: () => {}, maxHeight: 600 });
                if (!React.isValidElement<SessionAccessEditorProps>(editor)) throw new Error('Expected access editor element');
                await act(async () => editor.props.actions.addPrincipal({ kind: 'team', teamId: team.id }));
            }
            await act(async () => { await vi.waitFor(() => {
                expect(simple().selectedMachineId).toBe(targetMachineId);
                expect(model.getCurrent().managedDefaults?.approvalProfileId.value).toBe(profileId);
            }); });
            const captured = model.getCurrent().managedDefaults;
            if (!captured) throw new Error('Expected captured creation defaults');
            const { createUiPrepareSessionSpawnNewInput } = await import('@/sync/ops/actions/prepareSessionSpawnNewInput');
            const { resolveManagedSessionDefaults } = await import('@happier-dev/protocol/teams/managedDefaults');
            // These ports are the settings/network boundary: the admitted UI
            // capture must serve preparation without another context read.
            const unexpectedRead = async (): Promise<never> => { throw new Error('captured defaults must not reread'); };
            const prepare = createUiPrepareSessionSpawnNewInput({ readSettings: unexpectedRead,
                createLoader: () => ({ readPersonalDefaults: unexpectedRead, readSource: unexpectedRead,
                    readTeam: unexpectedRead, readHome: unexpectedRead }), resolveDefaultAgentTarget: unexpectedRead });
            const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } as const;
            const executionTarget = { serverId: home.id, machineId: targetMachineId };
            const prepared = await prepare({ executionTarget, agentTarget, directory: { kind: 'path', path: '/repo' } }, {
                surface: 'ui', sessionCreationDefaults: { context: captured.context,
                    authoredChoices: { executionTarget, agentTarget } },
            });
            expect(resolveManagedSessionDefaults({ ...prepared.defaults.context, agentTargetKey: '' }).approvalProfileId)
                .toMatchObject({ value: profileId, source: 'machine' });
            expect(prepared.input.approvalProfileId).toBeUndefined();
        } finally { await model.unmount(); }
    });
    it.each<{ late: boolean; override: boolean; blank?: boolean }>([{ late: false, override: true }, { late: true, override: true },
        { late: false, override: false }, { late: true, override: false },
        { late: false, override: false, blank: true }])('restores explicit placement=$override and Team label with late snapshot=$late blank=$blank', async ({ late, override, blank }) => {
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
        let model = await renderHook(() => useNewSessionScreenModel({ draftId: `shared-team-${late}-${override}-${blank ?? false}` }));
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
        if (!blank) await act(async () => simple().promptStore.setPrompt('Continue the Team task'));
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
            const { handlePermissionModeChange, setModelMode } = simple();
            if (!handlePermissionModeChange || !setModelMode) throw new Error('Expected the simple launcher controls');
            handlePermissionModeChange('default');
            setModelMode('default');
        });
        expect(simple().permissionMode).toBe(override ? 'default' : 'read-only');
        expect(simple().modelMode).toBe(override ? 'default' : 'sonnet');
        if (override) expect(simple().selectedMachineId).toBe('machine-1');
        // Resize at the RN window boundary, then restore the same draft as a
        // responsive host remount does. Sharing is authored even before typing.
        viewport.width = 390;
        await model.rerender();
        expect(simple().permissionMode).toBe(override ? 'default' : 'read-only');
        expect(simple().agentInputExtraActionChips?.find(chip => chip.key === 'session-access')?.collapsedContentPopover?.label).toBe(team.name);
        viewport.width = 1440;
        await model.rerender();
        expect(simple().permissionMode).toBe(override ? 'default' : 'read-only');
        await model.unmount();
        const saved = readNewSessionDraftFromRepository({ scope, draftId: `shared-team-${late}-${override}-${blank ?? false}` });
        expect(saved?.input).toBe(blank ? '' : 'Continue the Team task');
        expect(saved?.permissionModeExplicit).toBe(override ? true : undefined);
        expect(saved?.permissionMode).toBe('default');
        expect(saved?.modelSelection).toBe(override ? null : undefined);
        expect(saved?.access?.grants[0]?.subject).toEqual({ kind: 'team', teamId: 'team-1' });
        if (late) { teamArrival = createDeferred<void>(); resetTeamsSnapshotsForTests(); }
        // Returning from another page opens the draft without the old picker route handoff.
        router.setParams({ machineId: undefined, spawnServerId: undefined, machinePoolId: undefined });
        model = await renderHook(() => useNewSessionScreenModel({ draftId: `shared-team-${late}-${override}-${blank ?? false}` }));
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
