import { describe, expect, it } from 'vitest';

import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { createMachineFixture, renderHook } from '@/dev/testkit';
import { DEFAULT_NEW_SESSION_AUTOMATION_DRAFT } from '@/sync/domains/automations/automationDraft';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { createNewSessionPromptStore } from './newSessionPromptStore';
import { useNewSessionAuthoringState } from './useNewSessionAuthoringState';
import { buildSessionSpawnNewInputV2FromAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { sessionModelSelectionV2TeamBindingIntent } from '@happier-dev/protocol/providers/selection/v2';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

describe('useNewSessionAuthoringState', () => {
    it('persists underlying model and placement intent while launch keeps managed defaults', async () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const liveModel = { v: 1 as const, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: null, modelId: 'managed' } };
        const liveTeam = { v: 2 as const, updatedAt: 1, ref: { source: 'team_resource' as const,
            teamId: 'team-a', resourceId: 'managed-resource', expectedResourceRevision: 2,
            deliveryMode: 'brokered' as const, agentTargetKey, modelId: 'managed' } };
        const serviceBinding = { v: 1 as const, slot: { kind: 'connected_service_purpose' as const,
            purpose: { consumer: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex, purpose: 'primary' } }, resourceId: null };
        let params: Parameters<typeof useNewSessionAuthoringState>[0] = {
            automationDraft: DEFAULT_NEW_SESSION_AUTOMATION_DRAFT, automationFeatureEnabled: false,
            selectedMachineId: null, selectedMachine: null, targetServerId: 'home-a',
            selectedPath: '/workspace', directoryKind: 'path',
            executionTarget: { kind: 'machine', target: { serverId: 'home-a', machineId: 'machine-a' } },
            organizationPlacement: { folderId: null, tagIds: [] }, checkoutCreationDraft: null,
            promptStore: createNewSessionPromptStore('Reply ready'), staticAgentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            agentTarget: { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex }, transcriptStorage: 'persisted',
            useProfiles: false, selectedProfileId: null, selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: {}, getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => ({}),
            resumeSessionId: '', permissionMode: 'default', modelSelection: liveModel, capabilitySelection: null,
            modelSelectionForPersistence: { value: undefined },
            teamCredentialBindings: [sessionModelSelectionV2TeamBindingIntent(liveTeam), serviceBinding],
            agentNewSessionOptions: null, settings: settingsParse({}), effectiveWindowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionLaunchModeOverride: null, acpSessionModeId: null, sessionConfigOptionOverrides: null,
            automationRequestedByRoute: false, backendNewSessionOptionStateByTargetKey: {},
        };
        const hook = await renderHook(() => useNewSessionAuthoringState(params));
        try {
            expect(hook.getCurrent().buildCurrentPersistedDraft().modelSelection).toBeUndefined();
            expect(hook.getCurrent().buildCurrentPersistedDraft().teamCredentialBindings).toEqual([serviceBinding]);
            const personal = { ...liveModel, ref: { ...liveModel.ref, providerConnectionId: ProviderConnectionIdSchema.parse('personal'), modelId: 'chosen' } };
            params = { ...params, modelSelectionForPersistence: { value: personal } };
            await hook.rerender();
            expect(hook.getCurrent().buildCurrentPersistedDraft().modelSelection).toEqual(personal);
            expect(hook.getCurrent().buildCurrentPersistedDraft().teamCredentialBindings).toEqual([serviceBinding]);
            const rawTeam = { ...liveTeam, ref: { ...liveTeam.ref, resourceId: 'chosen-resource', modelId: 'chosen' } };
            params = { ...params, modelSelectionForPersistence: { value: rawTeam } };
            await hook.rerender();
            expect(hook.getCurrent().buildCurrentPersistedDraft()).toMatchObject({ modelSelection: rawTeam,
                teamCredentialBindings: [serviceBinding, sessionModelSelectionV2TeamBindingIntent(rawTeam)] });
            expect(hook.getCurrent().currentAuthoringDraft.modelSelection).toEqual(liveModel);
            expect(hook.getCurrent().currentAuthoringDraft.teamCredentialBindings)
                .toEqual([sessionModelSelectionV2TeamBindingIntent(liveTeam), serviceBinding]);
            params = { ...params, modelSelectionForPersistence: { value: null } };
            await hook.rerender();
            expect(hook.getCurrent().buildCurrentPersistedDraft()).toMatchObject({ modelSelection: null, teamCredentialBindings: [serviceBinding] });
            params = { ...params, selectedMachineId: 'machine-a', placementForPersistence: {
                executionTarget: undefined, selectedMachineId: null, managedMachineSelection: null, selectedPath: '',
            } };
            await hook.rerender();
            expect(hook.getCurrent().buildCurrentPersistedDraft()).toMatchObject({
                selectedMachineId: null, selectedPath: '', managedMachineSelection: null,
            });
            expect(hook.getCurrent().buildCurrentPersistedDraft().executionTarget).toBeUndefined();
            const rawTarget = { kind: 'machine' as const, target: { serverId: 'home-a', machineId: 'chosen-machine' } };
            params = { ...params, placementForPersistence: {
                executionTarget: rawTarget, selectedMachineId: 'chosen-machine', managedMachineSelection: null, selectedPath: '/chosen',
            } };
            await hook.rerender();
            expect(hook.getCurrent().buildCurrentPersistedDraft()).toMatchObject({
                executionTarget: rawTarget, selectedMachineId: 'chosen-machine', selectedPath: '/chosen',
            });
            expect(hook.getCurrent().currentAuthoringDraft).toMatchObject({
                executionTarget: params.executionTarget, directory: '/workspace',
            });
        } finally { await hook.unmount(); }
    });

    it('submits the current Team source when only the credential binding changes, including its explicit clear', async () => {
        const agentTarget = { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex };
        const modelSelection = { v: 1 as const, updatedAt: 123, ref: {
            agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5.6-luna',
        } };
        let params: Parameters<typeof useNewSessionAuthoringState>[0] = {
            automationDraft: DEFAULT_NEW_SESSION_AUTOMATION_DRAFT, automationFeatureEnabled: false,
            selectedMachineId: null, selectedMachine: null, targetServerId: 'home-a',
            selectedPath: '/workspace', directoryKind: 'path',
            executionTarget: { kind: 'machine', target: { serverId: 'home-a', machineId: 'machine-a' } },
            organizationPlacement: { folderId: null, tagIds: [] }, checkoutCreationDraft: null,
            promptStore: createNewSessionPromptStore('Reply ready'), staticAgentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' }, agentTarget, transcriptStorage: 'persisted',
            useProfiles: false, selectedProfileId: null, selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: {}, getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => ({}),
            resumeSessionId: '', permissionMode: 'default', modelSelection, capabilitySelection: null,
            agentNewSessionOptions: null, settings: settingsParse({}), effectiveWindowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionLaunchModeOverride: null, acpSessionModeId: null, sessionConfigOptionOverrides: null,
            automationRequestedByRoute: false, backendNewSessionOptionStateByTargetKey: {},
        };
        const hook = await renderHook(() => useNewSessionAuthoringState(params));
        const spawn = () => buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft: hook.getCurrent().currentAuthoringDraft, creationKey: 'dg16-team-source',
            permissionMode: 'default', configurationUpdatedAtMs: 123,
        });
        try {
            expect(spawn()).not.toHaveProperty('teamCredentialBindings');
            const binding = sessionModelSelectionV2TeamBindingIntent({ v: 2, updatedAt: 123, ref: {
                source: 'team_resource', teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 0,
                deliveryMode: 'brokered', agentTargetKey: modelSelection.ref.agentTargetKey, modelId: modelSelection.ref.modelId,
            } });
            params = { ...params, teamCredentialBindings: [binding] };
            await hook.rerender();
            expect(spawn().teamCredentialBindings).toEqual([binding]);
            expect(hook.getCurrent().buildCurrentPersistedDraft().teamCredentialBindings).toEqual([binding]);
            params = { ...params, teamCredentialBindings: [sessionModelSelectionV2TeamBindingIntent({
                v: 2, updatedAt: 124, ref: { source: 'native', agentTargetKey: modelSelection.ref.agentTargetKey,
                    modelId: modelSelection.ref.modelId },
            })] };
            await hook.rerender();
            expect(spawn().teamCredentialBindings).toEqual([{ v: 1, slot: { kind: 'provider_model' }, resourceId: null }]);
        } finally { await hook.unmount(); }
    });

    it('applies the Windows window-name preference only to its Windows destination and retains it when returning there', async () => {
        const settings = settingsParse({ sessionWindowsTerminalWindowName: 'Existing Windows name',
            sessionWindowsRemoteSessionLaunchMode: 'windows_terminal' });
        const windowsMachine = createMachineFixture({ id: 'windows-machine',
            metadata: { ...createMachineFixture().metadata!, platform: 'win32' } });
        const params: Parameters<typeof useNewSessionAuthoringState>[0] = {
            automationDraft: DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
            automationFeatureEnabled: false,
            selectedMachineId: null,
            selectedMachine: null,
            targetServerId: 'home-a',
            selectedPath: '',
            directoryKind: 'path',
            executionTarget: { kind: 'temporary_computer', serverId: 'home-a', artifactTarget: 'linux-x64',
                workspace: { kind: 'choose_on_endpoint' } },
            organizationPlacement: { folderId: null, tagIds: [] },
            checkoutCreationDraft: null,
            promptStore: createNewSessionPromptStore('Create on the chosen destination'),
            staticAgentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            agentTarget: { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex },
            transcriptStorage: 'persisted',
            useProfiles: false,
            selectedProfileId: null,
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: {},
            getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => ({}),
            resumeSessionId: '',
            permissionMode: 'default',
            modelSelection: null,
            capabilitySelection: null,
            agentNewSessionOptions: null,
            settings,
            effectiveWindowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionLaunchModeOverride: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automationRequestedByRoute: false,
            backendNewSessionOptionStateByTargetKey: {},
        };
        let destination = params;
        const hook = await renderHook(() => useNewSessionAuthoringState(destination));
        try {
            expect(hook.getCurrent().currentAuthoringDraft.windowsTerminalWindowName).toBeNull();
            destination = { ...params, selectedMachine: windowsMachine, selectedMachineId: windowsMachine.id,
                selectedPath: 'C:\\repo', executionTarget: { kind: 'machine',
                    target: { serverId: 'home-a', machineId: windowsMachine.id } },
                effectiveWindowsRemoteSessionLaunchMode: resolveEffectiveWindowsRemoteSessionLaunchMode({
                    machineMetadata: windowsMachine.metadata, settings,
                }).mode ?? null };
            await hook.rerender();
            expect(hook.getCurrent().currentAuthoringDraft).toMatchObject({
                windowsRemoteSessionLaunchMode: 'windows_terminal', windowsTerminalWindowName: 'Existing Windows name',
            });
            destination = params;
            await hook.rerender();
            expect(hook.getCurrent().currentAuthoringDraft.windowsTerminalWindowName).toBeNull();
            expect(settings.sessionWindowsTerminalWindowName).toBe('Existing Windows name');
        } finally { await hook.unmount(); }
    });
});
