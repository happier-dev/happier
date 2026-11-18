import { describe, expect, it } from 'vitest';
import { z as mini } from 'zod/mini';
import {
    SessionModelSelectionV1Schema,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol/providers/selection/v1';
import {
    SessionInitialTriggerV1Schema} from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import {
    SessionServerStartSpawnDraftV1Schema} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { buildConfiguredAcpAgentSelectionV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildAcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import {
    buildAutomationTemplateFromSessionAuthoringDraft,
    buildExistingSessionAuthoringDraftFromSessionSnapshot,
    buildNewSessionAuthoringDraft as buildCanonicalNewSessionAuthoringDraft,
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildNewSessionAuthoringDraftFromPersistedDraft,
    buildNewSessionAuthoringDraftFromTempData,
    buildSessionAuthoringDraftFromServerStartSpawnDraftV1,
    buildSessionServerStartSpawnDraftV1FromAuthoringDraft,
    applySessionServerStartSpawnDraftEdits,
    buildPersistedNewSessionDraftFromAuthoringDraft,
    applyWorkflowSelectionToServerStartSpawnDraftV1,
    buildSessionSpawnNewInputV2FromAuthoringDraft,
    buildExecutableModelParticipantSelectionFromAuthoringDraft,
    buildManagedAcquireAgentStartV1FromAuthoringDraft,
    buildNewSessionTempDataFromAuthoringDraft,
    hydrateSessionAuthoringDraftFromAutomationTemplate,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { decodeAutomationTemplate } from '@/sync/domains/automations/automationTemplateCodec';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { PluginUiJsonObjectV1Schema } from '@happier-dev/protocol/plugins/ui';
import type { SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';

function modelSelection(
    agentTargetKey: string,
    modelId = 'gpt-5',
    updatedAt = 456,
    providerConnectionId: string | null = null,
): SessionModelSelectionV1 {
    return SessionModelSelectionV1Schema.parse({
        v: 1 as const,
        updatedAt,
        ref: {
            agentTargetKey,
            providerConnectionId,
            modelId,
        },
    });
}

function buildNewSessionAuthoringDraft(
    input: Omit<Parameters<typeof buildCanonicalNewSessionAuthoringDraft>[0], 'executionTarget' | 'organizationPlacement' | 'agentTarget'> & Readonly<{
        executionTarget?: SessionAuthoringDraft['executionTarget'];
        organizationPlacement?: SessionAuthoringDraft['organizationPlacement'];
        agentTarget: SessionAuthoringDraft['agentTarget'];
    }>,
): SessionAuthoringDraft {
    return buildCanonicalNewSessionAuthoringDraft({
        ...input,
        executionTarget: input.executionTarget ?? { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
        organizationPlacement: input.organizationPlacement ?? { folderId: null, tagIds: [] },
    });
}

function intervalAutomationDraft(params: Readonly<{
    name: string;
    description?: string;
    cadenceMinutes: number;
    timezone?: string | null;
}>): NewSessionAutomationDraft {
    return {
        pendingAutomationId: 'automation-test',
        enabled: true,
        name: params.name,
        description: params.description ?? '',
        triggers: [{
            clientId: 'trigger-test',
            definition: {
                kind: 'schedule',
                enabled: true,
                schedule: {
                    kind: 'interval',
                    everyMs: params.cadenceMinutes * 60_000,
                    scheduleExpr: null,
                    timezone: params.timezone ?? null,
                },
            },
        }],
    };
}

describe('sessionAuthoringDraftAdapters', () => {
    it.each(['resolved', 'temp', 'persisted'] as const)('reconciles Claude to OpenCode before %s draft materialization and reload', source => {
        const claude: AgentExecutionTargetV1 = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
        const opencode: AgentExecutionTargetV1 = { kind: 'agent', identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' } };
        const native = modelSelection('agent:happier.agent.claude/claude', 'sonnet');
        const team: SessionModelSelection = { v: 2, updatedAt: 1, ref: {
            source: 'team_resource', teamId: 'team-a', resourceId: 'muse-share-r1117c', expectedResourceRevision: 0,
            deliveryMode: 'brokered', agentTargetKey: native.ref.agentTargetKey, modelId: 'muse-spark-1.3-contributor',
        } };
        const build = (agentTarget: AgentExecutionTargetV1, selection: SessionModelSelection) => {
            if (source === 'resolved') return buildNewSessionAuthoringDraftFromResolvedInputs({
                agentTarget, modelSelection: selection, directory: '/repo', prompt: 'Review', connectedServices: null,
            });
            if (source === 'temp') return buildNewSessionAuthoringDraftFromTempData({ agentTarget, modelSelection: selection, directory: '/repo' });
            return buildNewSessionAuthoringDraftFromPersistedDraft({ agentTarget, modelSelection: selection,
                input: 'Review', selectedMachineId: 'machine', selectedPath: '/repo', selectedProfileId: null,
                selectedSecretId: null, agentType: 'claude', permissionMode: 'default', acpSessionModeId: null, updatedAt: 1 });
        };
        // A native control and the valid Team choice survive before the actual Agent switch.
        expect(build(claude, native).modelSelection).toEqual(native);
        expect(build(claude, team).modelSelection).toEqual(team);
        const switched = build(opencode, team);
        expect(switched.agentTarget).toEqual(opencode);
        expect(switched.modelSelection).toBeNull();
        const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({ draft: switched, machineId: 'machine',
            selectedSecretId: null, selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null, backendNewSessionOptionStateByTargetKey: null, updatedAt: 2 });
        expect(buildNewSessionAuthoringDraftFromPersistedDraft(persisted).modelSelection).toBeNull();
        const valid: SessionModelSelection = { ...team, ref: { ...team.ref, agentTargetKey: 'agent:happier.agent.opencode/opencode' } };
        expect(build(opencode, valid).modelSelection).toEqual(valid);
    });
    it('reconciles an automation template model with its current Agent before draft hydration', () => {
        const claude: AgentExecutionTargetV1 = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
        const opencode: AgentExecutionTargetV1 = { kind: 'agent', identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' } };
        const selection = modelSelection('agent:happier.agent.claude/claude', 'sonnet');
        const hydrate = (agentTarget: AgentExecutionTargetV1) => hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'new_session', template: { directory: '/repo', agentTarget, modelSelection: selection },
        });
        expect(hydrate(claude).modelSelection).toEqual(selection);
        expect(hydrate(opencode).modelSelection).toBeNull();
    });
    it.each([undefined, '', '/', '/Users/coder/project', 'C:\\Users\\coder\\project'])('preserves directory intent %s without inventing a root during hydration', directory => {
        const temporary = buildNewSessionAuthoringDraftFromTempData({ directory });
        const persisted = buildNewSessionAuthoringDraftFromPersistedDraft({
            input: '', selectedMachineId: 'guest', selectedPath: directory ?? null,
            selectedProfileId: null, selectedSecretId: null, agentType: DEFAULT_AGENT_ID,
            permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        });
        expect(temporary.directory).toBe(directory ?? '');
        expect(persisted.directory).toBe(directory ?? '');
    });

    it.each(['mirrored', 'binding-only'] as const)('previews an executable %s Team model without prompt or creation identity', (form) => {
        const teamCredentialBindings = [{ v: 1, slot: { kind: 'provider_model' },
            resourceId: 'review-team-credential', expectedResourceRevision: 7, deliveryMode: 'brokered', teamId: 'team-a',
            providerModelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'review-model' },
        }] satisfies NonNullable<SessionAuthoringDraft['teamCredentialBindings']>;
        const draft = { ...buildNewSessionAuthoringDraftFromTempData({
            prompt: 'This stays an unsent authoring draft', directory: '/workspace',
            executionTarget: { kind: 'machine', target: { serverId: 'home-a', machineId: 'machine-a' } },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            permissionMode: 'read-only',
            primaryTeamId: 'team-a',
        }), teamCredentialBindings, modelSelection: form === 'mirrored'
            ? modelSelection('agent:happier.agent.codex/codex', 'review-model', 456) : null };
        const params = { draft, permissionMode: 'read-only', configurationUpdatedAtMs: 123 } as const;
        const choice = buildExecutableModelParticipantSelectionFromAuthoringDraft(params);
        expect(choice).toMatchObject({ kind: 'model', launch: {
            executionTarget: { serverId: 'home-a', machineId: 'machine-a' },
            directory: { kind: 'path', path: '/workspace' }, agentTarget: draft.agentTarget,
            permissionMode: 'read-only', configuration: { permissionIntent: { value: 'read-only', updatedAtMs: 123 },
                model: { value: 'review-model' } },
            ...(draft.modelSelection ? { modelSelection: draft.modelSelection } : {}),
            primaryTeamId: 'team-a', teamCredentialBindings,
        } });
        expect(choice).not.toHaveProperty('launch.initialInput');
        expect(choice).not.toHaveProperty('launch.creationKey');
        expect(choice).not.toHaveProperty('launch.discussionParticipant');
        expect(draft.prompt).toBe('This stays an unsent authoring draft');
    });

    it('round-trips the selected Team context and its explicit clear through persisted drafts', () => {
        for (const primaryTeamId of ['team-review', null, undefined]) {
            const draft = buildNewSessionAuthoringDraftFromTempData({
                prompt: 'Review this project',
                directory: '/workspace',
                executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                primaryTeamId,
            });
            expect(draft.primaryTeamId).toBe(primaryTeamId);

            const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({
                draft, machineId: 'machine-1', selectedSecretId: null,
                selectedSecretIdByProfileIdByEnvVarName: null,
                sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
                backendNewSessionOptionStateByTargetKey: null,
                updatedAt: 1,
            });

            if (primaryTeamId === undefined) expect(persisted).not.toHaveProperty('primaryTeamId');
            else expect(persisted).toHaveProperty('primaryTeamId', primaryTeamId);
            expect(buildNewSessionAuthoringDraftFromPersistedDraft(persisted).primaryTeamId).toBe(primaryTeamId);
        }
    });

    it('creates configuration only for deliberate option edits and preserves native resume custody', () => {
        const seed = SessionServerStartSpawnDraftV1Schema.parse({
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/repo' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            permissionMode: 'read-only', agentModeId: 'plan',
            modelSelection: modelSelection('agent:happier.agent.claude/claude', 'sonnet'),
        });
        expect(applySessionServerStartSpawnDraftEdits({ draft: seed, edits: {}, configurationUpdatedAtMs: 99 }))
            .toEqual(seed);
        const overrides = buildAcpConfigOptionOverridesV1({ updatedAt: 12, overrides: { reasoning: { value: 'high', updatedAt: 12 } } });
        const edited = applySessionServerStartSpawnDraftEdits({ draft: seed,
            edits: { sessionConfigOptionOverrides: overrides }, configurationUpdatedAtMs: 99 });
        expect(edited.configuration).toEqual({
            mode: { value: 'plan', updatedAtMs: 99 },
            model: { value: 'sonnet', updatedAtMs: 456 },
            permissionIntent: { value: 'read-only', updatedAtMs: 99 },
            options: { reasoning: { value: 'high', updatedAtMs: 12 } },
        });
        const resumed = { ...edited, configuration: { ...edited.configuration!,
            providerSessionResume: { kind: 'provider_session.v1' as const, providerSessionId: 'native' } } };
        expect(applySessionServerStartSpawnDraftEdits({ draft: resumed,
            edits: { sessionConfigOptionOverrides: null }, configurationUpdatedAtMs: 100 }).configuration)
            .toEqual({ ...resumed.configuration, options: {} });
    });
    it('preserves every unedited strict recipe field while authoring Agent, directory and tool or folder edits', () => {
        const seed = SessionServerStartSpawnDraftV1Schema.parse({
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/before' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            modelSelection: modelSelection('agent:happier.agent.claude/claude', 'sonnet'),
            profileId: 'profile', roleId: 'intake', title: 'Intake', memoryEnabled: false,
            allowedTools: ['mcp__wilson-intake__*'], unlistedTools: 'deny',
            organizationPlacement: { folderId: 'intake', tagIds: ['mail'] },
            permissionMode: 'read-only', agentModeId: 'plan',
            configuration: { mode: { value: 'plan', updatedAtMs: 7 }, model: { value: 'sonnet', updatedAtMs: 8 },
                permissionIntent: { value: 'read-only', updatedAtMs: 9 },
                options: { reasoning: { value: 'high', updatedAtMs: 10 } },
                providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'native-session' } },
            capabilitySelection: { mcp: { v: 1, managedServersEnabled: false,
                forceIncludeServerIds: ['wilson-intake'], forceExcludeServerIds: [] } },
            connectedServices: { v: 2, bindingsByServiceId: {
                'happier.service.github/github': { source: 'connected', selection: 'profile', profileId: 'github' } } },
            terminal: { mode: 'tmux', tmux: { sessionName: 'intake' } },
            transcriptStorage: 'direct', primaryTeamId: 'team',
        });
        const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'review' } };
        const edited = applySessionServerStartSpawnDraftEdits({
            draft: seed, edits: { agentTarget, directory: { kind: 'path', path: '/after' } }, configurationUpdatedAtMs: 99,
        });
        expect(SessionServerStartSpawnDraftV1Schema.parse(edited)).toEqual({
            ...seed, agentTarget, directory: { kind: 'path', path: '/after' },
            modelSelection: { ...seed.modelSelection, ref: { ...seed.modelSelection?.ref, agentTargetKey: 'agent:acme.agent/review' } },
        });
        const restricted = applySessionServerStartSpawnDraftEdits({
            draft: edited, edits: { allowedTools: [], unlistedTools: 'ask',
                organizationPlacement: { folderId: null, tagIds: ['mail'] }, permissionMode: 'default' },
            configurationUpdatedAtMs: 100,
        });
        expect(restricted).toEqual({ ...edited, allowedTools: [], unlistedTools: 'ask',
            organizationPlacement: { folderId: null, tagIds: ['mail'] }, permissionMode: 'default',
            configuration: { ...edited.configuration, permissionIntent: { value: 'default', updatedAtMs: 100 } } });
        const cleared = applySessionServerStartSpawnDraftEdits({
            draft: restricted,
            edits: { profileId: undefined, modelSelection: undefined, agentModeId: undefined,
                capabilitySelection: undefined, connectedServices: undefined, allowedTools: undefined, unlistedTools: undefined },
            configurationUpdatedAtMs: 101,
        });
        expect(PluginUiJsonObjectV1Schema.safeParse(cleared).success).toBe(true);
        for (const field of ['profileId', 'modelSelection', 'agentModeId', 'capabilitySelection', 'connectedServices', 'allowedTools', 'unlistedTools']) {
            expect(cleared).not.toHaveProperty(field);
        }
        expect(cleared.configuration).toMatchObject({ mode: { value: null }, model: { value: null } });
    });

    it('preserves MCP and skill session overrides through persisted drafts and temporary handoffs', () => {
        const capabilitySelection = {
            mcp: { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: ['server-a'], forceExcludeServerIds: [] },
            skills: { v: 1 as const, forceIncludeSkillIds: ['skill-a'], forceExcludeSkillIds: ['skill-b'], excludeNativeSkillNames: ['native-a'] },
        };
        const seed = {
            prompt: 'Review this project',
            machineId: 'machine-1',
            directory: '/workspace',
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            capabilitySelection,
        };
        const draft = buildNewSessionAuthoringDraftFromTempData(seed);
        expect(draft).toMatchObject({ capabilitySelection });
        const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft, machineId: 'machine-1', selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            updatedAt: 1,
        });
        expect(persisted).toMatchObject({ capabilitySelection });
        expect(buildNewSessionAuthoringDraftFromPersistedDraft(persisted)).toMatchObject({ capabilitySelection });
        expect(buildNewSessionTempDataFromAuthoringDraft({ draft, machineId: 'machine-1' })).toMatchObject({ capabilitySelection });
    });

    it('projects the same authored Session into pre-acquire admission without inventing an execution target', () => {
        const draft = buildNewSessionAuthoringDraftFromResolvedInputs({
            directory: '/workspace/project', prompt: 'Submitted work', sessionName: 'Submitted Session',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            permissionMode: 'read-only', acpSessionModeId: 'plan', profileId: 'profile',
            sessionConfigOptionOverrides: buildAcpConfigOptionOverridesV1({
                updatedAt: 23, overrides: { reasoning_effort: { value: 'high', updatedAt: 23 } },
            }),
            environmentVariables: { PRIVATE_TOKEN: 'guest-process-only' },
            connectedServices: null,
        });
        const params = { draft, creationKey: 'managed-send', permissionMode: 'read-only',
            configurationUpdatedAtMs: 23, initialMessage: 'Submitted work' };
        const continuation = buildManagedAcquireAgentStartV1FromAuthoringDraft(params);
        expect(continuation).toMatchObject({ title: 'Submitted Session', profileId: 'profile', agentModeId: 'plan',
            permissionMode: 'read-only', initialInput: { text: 'Submitted work' },
            configuration: { options: { reasoning_effort: { value: 'high', updatedAtMs: 23 } } } });
        expect(continuation).not.toHaveProperty('executionTarget');
        expect(continuation).not.toHaveProperty('environmentVariables');
        const { executionTarget, ...spawnAuthoring } = buildSessionSpawnNewInputV2FromAuthoringDraft({ ...params,
            draft: { ...draft, executionTarget: { kind: 'machine', target: { serverId: 'home', machineId: 'enrolled' } } } });
        expect(executionTarget.machineId).toBe('enrolled');
        expect(continuation).toEqual(spawnAuthoring);
    });
    it('retains qualified Project context through reopen and both Session admission paths', () => {
        const projectContext = { projectRef: { serverId: 'server-1', projectKey: 'project-key' }, sourceRef: { serverId: 'server-1', sourceId: 'source-id' } };
        const draft = buildNewSessionAuthoringDraftFromTempData({ prompt: 'Start here', directory: '/workspace/project',
            executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, projectContext });
        expect(buildNewSessionAuthoringDraftFromTempData(buildNewSessionTempDataFromAuthoringDraft({ draft, machineId: 'machine-1' }))).toMatchObject({ projectContext });
        const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({ draft, machineId: 'machine-1', updatedAt: 1,
            selectedSecretId: null, selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueEncByProfileIdByEnvVarName: {}, backendNewSessionOptionStateByTargetKey: {} });
        const reopened = buildNewSessionAuthoringDraftFromPersistedDraft(persisted);
        expect(reopened).toMatchObject({ projectContext });
        const params = { draft: reopened, creationKey: 'project-context-creation', permissionMode: 'default', configurationUpdatedAtMs: 1 };
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft(params)).toMatchObject({ projectContext });
        expect(buildManagedAcquireAgentStartV1FromAuthoringDraft(params)).toMatchObject({ projectContext });
        const nativeSpawn = buildSessionServerStartSpawnDraftV1FromAuthoringDraft(params);
        expect(applyWorkflowSelectionToServerStartSpawnDraftV1({ spawn: nativeSpawn, selection: {},
            configurationUpdatedAtMs: 2 })).toMatchObject({ kind: 'available', spawn: { projectContext } });
    });
    it('preserves a qualified Team model through draft storage and both launch carriers', () => {
        const modelSelection = { v: 2 as const, updatedAt: 1, ref: { source: 'team_resource' as const,
            teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 7,
            deliveryMode: 'brokered' as const, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'team-model' } };
        const draft = buildNewSessionAuthoringDraftFromTempData({ prompt: 'Start here', directory: '/workspace/project',
            agentType: 'codex', executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } }, modelSelection });
        const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({ draft, machineId: 'machine-1', updatedAt: 1,
            selectedSecretId: null, selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueEncByProfileIdByEnvVarName: {}, backendNewSessionOptionStateByTargetKey: {} });
        const reopened = buildNewSessionAuthoringDraftFromPersistedDraft(persisted);
        expect(reopened.modelSelection).toEqual(modelSelection);
        expect(buildNewSessionTempDataFromAuthoringDraft({ draft: reopened, machineId: 'machine-1' }).modelSelection).toEqual(modelSelection);
        const params = { draft: reopened, creationKey: 'team-model-creation', permissionMode: 'default', configurationUpdatedAtMs: 1 };
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft(params).modelSelection).toEqual(modelSelection);
        expect(buildManagedAcquireAgentStartV1FromAuthoringDraft(params).modelSelection).toEqual(modelSelection);
    });
    it('keeps an inherited Agent omitted at Action admission and through draft hydration', () => {
        const projectContext = { projectRef: { serverId: 'server-1', projectKey: 'project-key' } };
        const draft = buildNewSessionAuthoringDraftFromTempData({ prompt: 'Start here', directory: '/workspace/project',
            executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
            agentTarget: null, projectContext });
        const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({ draft, machineId: 'machine-1', updatedAt: 1,
            selectedSecretId: null, selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueEncByProfileIdByEnvVarName: {}, backendNewSessionOptionStateByTargetKey: {} });
        expect(buildNewSessionAuthoringDraftFromPersistedDraft(persisted).agentTarget).toBeNull();
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({ draft, creationKey: 'inherited-agent-creation',
            permissionMode: 'default', configurationUpdatedAtMs: 1 })).not.toHaveProperty('agentTarget');
        expect(buildManagedAcquireAgentStartV1FromAuthoringDraft({ draft, creationKey: 'inherited-agent-creation',
            permissionMode: 'default', configurationUpdatedAtMs: 1 })).not.toHaveProperty('agentTarget');
        expect(() => buildSessionServerStartSpawnDraftV1FromAuthoringDraft({ draft,
            permissionMode: 'default', configurationUpdatedAtMs: 1 })).toThrow();
    });
    it('retains Project files with its placement through reopen and both Session admission paths', () => {
        const sessionPlacement = { kind: 'machine' as const,
            target: { serverId: 'server-1', machineId: 'machine-1' },
            projectFiles: { kind: 'sync' as const, mode: 'keep_both_in_sync' as const } };
        const draft = buildNewSessionAuthoringDraftFromTempData({ prompt: 'Start here', directory: '/workspace/project',
            executionTarget: { kind: 'machine', target: sessionPlacement.target },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            ...{ sessionPlacement } });
        const temp = buildNewSessionTempDataFromAuthoringDraft({ draft, machineId: 'machine-1' });
        expect(buildNewSessionAuthoringDraftFromTempData(temp)).toMatchObject({ sessionPlacement });
        const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({ draft, machineId: 'machine-1', updatedAt: 1,
            selectedSecretId: null, selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueEncByProfileIdByEnvVarName: {}, backendNewSessionOptionStateByTargetKey: {} });
        const reopened = buildNewSessionAuthoringDraftFromPersistedDraft(persisted);
        const params = { draft: reopened, creationKey: 'project-files-creation', permissionMode: 'default', configurationUpdatedAtMs: 1 };
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft(params)).toMatchObject({ sessionPlacement });
        expect(buildManagedAcquireAgentStartV1FromAuthoringDraft(params)).toMatchObject({ sessionPlacement });
    });
    it('retains a one-Session Directly override through draft reopen and submits it only to ordinary Session admission', () => {
        const draft = buildNewSessionAuthoringDraftFromTempData({ prompt: 'Start here', directory: '/workspace/project',
            executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            ...{ isolationOverride: 'directly' as const } });
        const temp = buildNewSessionTempDataFromAuthoringDraft({ draft, machineId: 'machine-1' });
        expect(buildNewSessionAuthoringDraftFromTempData(temp)).toMatchObject({ isolationOverride: 'directly' });
        const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({ draft, machineId: 'machine-1', updatedAt: 1,
            selectedSecretId: null, selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueEncByProfileIdByEnvVarName: {}, backendNewSessionOptionStateByTargetKey: {} });
        const reopened = buildNewSessionAuthoringDraftFromPersistedDraft(persisted);
        const params = { draft: reopened, creationKey: 'directly-creation', permissionMode: 'default', configurationUpdatedAtMs: 1 };
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft(params)).toMatchObject({ isolationOverride: 'directly' });
        expect(buildManagedAcquireAgentStartV1FromAuthoringDraft(params)).not.toHaveProperty('isolationOverride');
    });
    it('round-trips initial triggers with the draft and includes them in the atomic spawn input', () => {
        const initialTriggers = mini.array(SessionInitialTriggerV1Schema).parse([{
            trigger: { kind: 'sessionLifecycle', enabled: true, events: ['sessionStarted'], policy: { kind: 'everyMatch' } },
            target: { kind: 'workflow', ref: 'builtin:review-and-converge' },
            executionTarget: { kind: 'session' },
            inputs: { maxRounds: 3 },
        }]);
        const draft = buildNewSessionAuthoringDraftFromTempData({
            prompt: 'Start here', directory: '/workspace/project',
            executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            initialTriggers,
        });
        expect(draft.initialTriggers).toEqual(initialTriggers);
        const temp = buildNewSessionTempDataFromAuthoringDraft({ draft, machineId: 'machine-1' });
        expect(buildNewSessionAuthoringDraftFromTempData(temp).initialTriggers).toEqual(initialTriggers);
        const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft, machineId: 'machine-1', updatedAt: 1,
            selectedSecretId: null, selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueEncByProfileIdByEnvVarName: {}, backendNewSessionOptionStateByTargetKey: {},
        });
        expect(buildNewSessionAuthoringDraftFromPersistedDraft(persisted).initialTriggers).toEqual(initialTriggers);
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft, creationKey: 'initial-trigger-creation', permissionMode: 'default', configurationUpdatedAtMs: 1,
            initialMessage: 'Start here',
        })).toMatchObject({ initialInput: { text: 'Start here' }, initialTriggers });
        const preview = buildExecutableModelParticipantSelectionFromAuthoringDraft({
            draft, permissionMode: 'default', configurationUpdatedAtMs: 1,
        });
        expect(preview.launch).not.toHaveProperty('initialTriggers');
        expect(preview.launch).not.toHaveProperty('initialInput');
    });
    it('keeps execution, organization, and Agent selection in the canonical authoring draft', () => {
        const draft = buildNewSessionAuthoringDraft({
            executionTarget: { kind: 'machine', target: { serverId: ' server-1 ', machineId: ' machine-1 ' } },
            organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1', 'tag-1', 'tag-2'] },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review this',
            displayText: 'Review this',
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'default',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        expect(draft).toMatchObject({
            executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
            organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1', 'tag-2'] },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
        });
        expect(draft).not.toHaveProperty('agentId');
        expect(draft).not.toHaveProperty('backendTarget');
    });

    it('requires interactive consent before projecting a Temporary computer draft into executable Machine payloads', () => {
        const draft = buildNewSessionAuthoringDraftFromTempData({
            executionTarget: {
                kind: 'temporary_computer',
                serverId: 'server-1',
                artifactTarget: 'darwin-arm64',
                workspace: { kind: 'endpoint_home' },
            },
            directory: '/retained-directory',
            agentType: 'codex',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            prompt: 'Keep this request',
        });
        expect(() => buildSessionServerStartSpawnDraftV1FromAuthoringDraft({
            draft,
            permissionMode: 'default',
            configurationUpdatedAtMs: 1,
        })).toThrowError(expect.objectContaining({ code: 'interactive_consent_required' }));
        expect(() => buildAutomationTemplateFromSessionAuthoringDraft(draft))
            .toThrowError(expect.objectContaining({ code: 'interactive_consent_required' }));
        expect(draft.executionTarget).toMatchObject({ kind: 'temporary_computer', serverId: 'server-1' });
    });

    it('hydrates every representable strict server-start field through an exact catalog Agent target', () => {
        const placementOrigin = { kind: 'machine_pool' as const, poolId: '3a948f0c-bc30-491c-b764-37f0e6744d1f' };
        const spawn = SessionServerStartSpawnDraftV1Schema.parse({
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            placementOrigin,
            directory: { kind: 'path', path: '/workspace/project' },
            organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1'] },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'acme.review-agent', localId: 'review-agent' },
            },
            modelSelection: modelSelection('agent:acme.review-agent/review-agent', 'review-model', 30, 'provider-1'),
            profileId: 'profile-1',
            permissionMode: 'plan',
            agentModeId: 'plan',
            configuration: {
                mode: { value: 'plan', updatedAtMs: 10 },
                model: { value: 'review-model', updatedAtMs: 30 },
                permissionIntent: { value: 'plan', updatedAtMs: 20 },
                options: {
                    reasoning: { value: 'high', updatedAtMs: 40 },
                    safe: { value: true, updatedAtMs: 41 },
                },
                providerSessionResume: {
                    kind: 'provider_session.v1',
                    providerSessionId: 'provider-session-1',
                },
            },
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    'happier.service.github/github': { source: 'connected', selection: 'profile', profileId: 'github-1' },
                },
            },
            capabilitySelection: { mcp: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['review'],
                forceExcludeServerIds: ['legacy'],
            } },
            transcriptStorage: 'direct',
            terminal: {
                mode: 'tmux',
                tmux: { sessionName: 'review-automation' },
                windows: { launchMode: 'windows_terminal', console: 'visible', windowName: 'review' },
            },
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'Review branch',
                baseRef: 'main',
            },
        });

        const result = buildSessionAuthoringDraftFromServerStartSpawnDraftV1({
            spawn,
            prompt: 'Review the changed files',
            agentTargetCatalog: [{
                agentTarget: spawn.agentTarget,
                agentId: 'reviewAgent',
                backendTarget: { kind: 'backend', backendId: 'review-agent' },
            }],
        });

        expect(result).toEqual({
            kind: 'available',
            draft: expect.objectContaining({
                targetType: 'new_session',
                executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' }, selectionOrigin: placementOrigin },
                directory: '/workspace/project',
                organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1'] },
                prompt: 'Review the changed files',
                displayText: 'Review the changed files',
                agentTarget: spawn.agentTarget,
                modelSelection: modelSelection('agent:acme.review-agent/review-agent', 'review-model', 30, 'provider-1'),
                profileId: 'profile-1',
                permissionMode: 'plan',
                permissionModeUpdatedAt: 20,
                acpSessionModeId: 'plan',
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 41,
                    overrides: {
                        reasoning: { value: 'high', updatedAt: 40 },
                        safe: { value: true, updatedAt: 41 },
                    },
                },
                resumeSessionId: 'provider-session-1',
                connectedServices: {
                    v: 2,
                    bindingsByServiceId: {
                        'happier.service.github/github': { source: 'connected', selection: 'profile', profileId: 'github-1' },
                    },
                },
                capabilitySelection: { mcp: {
                    v: 1,
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['review'],
                    forceExcludeServerIds: ['legacy'],
                } },
                transcriptStorage: 'direct',
                terminal: {
                    mode: 'tmux',
                    tmux: { sessionName: 'review-automation' },
                    windows: { launchMode: 'windows_terminal', console: 'visible', windowName: 'review' },
                },
                windowsRemoteSessionLaunchMode: 'windows_terminal',
                windowsRemoteSessionConsole: 'visible',
                windowsTerminalWindowName: 'review',
                checkoutCreationDraft: {
                    kind: 'git_worktree',
                    displayName: 'Review branch',
                    baseRef: 'main',
                },
            }),
        });
        if (result.kind !== 'available') throw new Error('Expected representable server-start draft');
        if (!spawn.permissionMode) throw new Error('Expected the authored permission mode');
        expect(buildSessionServerStartSpawnDraftV1FromAuthoringDraft({
            draft: result.draft,
            permissionMode: spawn.permissionMode,
            configurationUpdatedAtMs: 41,
        })).toMatchObject({ executionTarget: spawn.executionTarget, placementOrigin });
    });

    it('fails closed instead of selecting a fallback Agent when the strict target is absent from the current catalog', () => {
        const spawn = SessionServerStartSpawnDraftV1Schema.parse({
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/workspace/project' },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'acme.review-agent', localId: 'review-agent' },
            },
            permissionMode: 'default',
            configuration: {
                mode: { value: null, updatedAtMs: 10 },
                model: { value: null, updatedAtMs: 10 },
                permissionIntent: { value: 'default', updatedAtMs: 10 },
                options: {},
            },
        });

        expect(buildSessionAuthoringDraftFromServerStartSpawnDraftV1({
            spawn,
            prompt: 'Review the changed files',
            agentTargetCatalog: [{
                agentTarget: {
                    kind: 'agent',
                    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                },
                agentId: 'codex',
                backendTarget: { kind: 'backend', backendId: 'codex' },
            }],
        })).toEqual({
            kind: 'unavailable',
            reason: 'agent_target_unavailable',
        });
    });

    it('matches the exact configured definition and refuses a missing definition without a fallback', () => {
        const identity = { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' };
        const spawn = SessionServerStartSpawnDraftV1Schema.parse({
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/workspace/project' },
            agentTarget: { kind: 'agent', identity, definitionId: 'review-a' },
            permissionMode: 'default',
            configuration: {
                mode: { value: null, updatedAtMs: 10 },
                model: { value: null, updatedAtMs: 10 },
                permissionIntent: { value: 'default', updatedAtMs: 10 },
                options: {},
            },
        });
        const catalog = ['review-a', 'review-b'].map((definitionId) => ({
            agentTarget: { kind: 'agent' as const, identity, definitionId },
            agentId: 'custom-acp',
            backendTarget: { kind: 'backend' as const, backendId: definitionId, configuredBackendId: definitionId },
        }));
        const available = buildSessionAuthoringDraftFromServerStartSpawnDraftV1({
            spawn, prompt: 'Review', agentTargetCatalog: catalog,
        });
        expect(available).toMatchObject({ kind: 'available', draft: { agentTarget: spawn.agentTarget } });
        expect(buildSessionAuthoringDraftFromServerStartSpawnDraftV1({
            spawn, prompt: 'Review', agentTargetCatalog: [catalog[1]!],
        })).toEqual({ kind: 'unavailable', reason: 'agent_target_unavailable' });
        expect(spawn.agentTarget.definitionId).toBe('review-a');
    });

    it('rejects a server-start configuration that cannot be represented without changing its target-bound model', () => {
        const spawn = SessionServerStartSpawnDraftV1Schema.parse({
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/workspace/project' },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'acme.review-agent', localId: 'review-agent' },
            },
            modelSelection: modelSelection('agent:acme.review-agent/review-agent', 'review-model', 30),
            permissionMode: 'default',
            configuration: {
                mode: { value: null, updatedAtMs: 10 },
                model: { value: 'other-model', updatedAtMs: 30 },
                permissionIntent: { value: 'default', updatedAtMs: 10 },
                options: {},
            },
        });

        expect(buildSessionAuthoringDraftFromServerStartSpawnDraftV1({
            spawn,
            prompt: 'Review the changed files',
            agentTargetCatalog: [{
                agentTarget: spawn.agentTarget,
                agentId: 'reviewAgent',
                backendTarget: { kind: 'backend', backendId: 'review-agent' },
            }],
        })).toEqual({
            kind: 'unavailable',
            reason: 'configuration_model_mismatch',
        });
    });

    it('builds the reserved server-start draft without caller-selected creation or initial-input facts', () => {
        const draft = buildNewSessionAuthoringDraft({
            executionTarget: {
                kind: 'machine',
                target: { serverId: 'server-1', machineId: 'machine-1' },
                selectionOrigin: {
                    kind: 'machine_pool',
                    poolId: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                },
            },
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            organizationPlacement: { folderId: null, tagIds: [] },
            prompt: 'Review this',
            displayText: 'Review this',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: 'vendor-session-1',
            permissionMode: 'default',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: null,
            connectedServices: null,
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const spawn = buildSessionServerStartSpawnDraftV1FromAuthoringDraft({
            draft,
            permissionMode: 'default',
            configurationUpdatedAtMs: 999,
        });

        expect(spawn).toMatchObject({
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            placementOrigin: {
                kind: 'machine_pool',
                poolId: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
            },
            configuration: {
                providerSessionResume: {
                    kind: 'provider_session.v1',
                    providerSessionId: 'vendor-session-1',
                },
            },
            terminal: { mode: 'integrated' },
        });
        expect('creationKey' in spawn).toBe(false);
        expect('initialMessage' in spawn).toBe(false);
    });

    it('carries an externally installed Agent model choice onto the strict spawn input', () => {
        // C1 parity: an Agent contributed by an external plugin ships no bundled
        // catalog core, so the authored selection is the only model fact the
        // spawn owner has. It must reach both the canonical selection seam and
        // the derived strict configuration, exactly as a bundled Agent's does.
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review this',
            displayText: 'Review this',
            agentTarget: { kind: 'agent', identity: { pluginId: 'com.acme.mercury', localId: 'mercury' } },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'default',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:com.acme.mercury/mercury', 'mercury-pro', 789),
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft: { ...draft, access: { grants: [{ subject: { kind: 'account', accountId: 'recipient-a' }, accessLevel: 'view', canApprovePermissions: false }] } },
            creationKey: 'attempt-external-1',
            permissionMode: 'default',
            configurationUpdatedAtMs: 999,
            initialMessage: 'Review this',
            initialStructuredInput: { v: 1, mentions: [{ kind: 'partner.reference', ref: 'partner:issue-42', token: '@issue' }] },
        })).toMatchObject({
            initialAccess: { grants: [{ subject: { kind: 'account', accountId: 'recipient-a' }, accessLevel: 'view', canApprovePermissions: false }] },
            initialInput: {
                text: 'Review this',
                structuredInput: { v: 1, mentions: [{ kind: 'partner.reference', ref: 'partner:issue-42', token: '@issue' }] },
            },
            modelSelection: modelSelection('agent:com.acme.mercury/mercury', 'mercury-pro', 789),
            configuration: {
                model: { value: 'mercury-pro', updatedAtMs: 789 },
            },
        });
        const semanticAttachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft,
            creationKey: 'attempt-semantic-attachment',
            permissionMode: 'default',
            configurationUpdatedAtMs: 999,
            initialMessage: null,
            initialStructuredInput: { v: 1, composerAttachments: [semanticAttachment] },
        }).initialInput).toEqual({ structuredInput: { v: 1, composerAttachments: [semanticAttachment] } });
        const reviewComments = {
            displayText: 'Review comments (1)',
            comments: [{
                id: 'review-1', filePath: 'src/a.ts', source: 'file' as const,
                anchor: { kind: 'fileLine' as const, startLine: 1 },
                snapshot: { selectedLines: ['code'], beforeContext: [], afterContext: [] },
                body: 'Check this', createdAt: 1,
            }],
        };
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft,
            creationKey: 'attempt-review-comment',
            permissionMode: 'default',
            configurationUpdatedAtMs: 999,
            initialMessage: 'Review comments:\n\n1) src/a.ts',
            initialReviewComments: reviewComments,
        }).initialInput).toEqual({ text: 'Review comments:\n\n1) src/a.ts', reviewComments });
    });

    it('carries the exact revision-bound Team credential intent onto the strict spawn input', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project', checkoutCreationDraft: null, prompt: '', displayText: '',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: 'persisted', profileId: null, environmentVariables: null, resumeSessionId: null,
            permissionMode: 'default', permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: null, connectedServices: null, terminal: null, windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null, windowsTerminalWindowName: null, runtimeDescriptorV1: null,
            acpSessionModeId: null, sessionConfigOptionOverrides: null, automation: null,
            teamCredentialBindings: [{
                v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 7,
                deliveryMode: 'brokered',
            }],
        });

        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft, creationKey: 'attempt-team-resource', permissionMode: 'default', configurationUpdatedAtMs: 999,
        }).teamCredentialBindings).toEqual([{
            v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 7,
            deliveryMode: 'brokered',
        }]);

        for (const teamCredentialBindings of [draft.teamCredentialBindings, [], undefined]) {
            const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({
                draft: { ...draft, teamCredentialBindings },
                machineId: 'machine-1', selectedSecretId: null,
                selectedSecretIdByProfileIdByEnvVarName: null,
                sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
                backendNewSessionOptionStateByTargetKey: null,
                updatedAt: 1,
            });
            if (teamCredentialBindings === undefined) expect(persisted).not.toHaveProperty('teamCredentialBindings');
            else expect(persisted).toHaveProperty('teamCredentialBindings', teamCredentialBindings);
            expect(buildNewSessionAuthoringDraftFromPersistedDraft(persisted).teamCredentialBindings).toEqual(teamCredentialBindings);
        }
    });

    it('maps authored resume and Windows launch intent through the strict V2 nested owners', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review this',
            displayText: 'Review this',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: 'vendor-session-1',
            permissionMode: 'default',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: null,
            connectedServices: null,
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'windows_terminal',
            windowsRemoteSessionConsole: 'visible',
            windowsTerminalWindowName: 'happier-qa',
            runtimeDescriptorV1: null,
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft,
            creationKey: 'attempt-1',
            permissionMode: 'default',
            configurationUpdatedAtMs: 999,
        })).toMatchObject({
            configuration: {
                providerSessionResume: {
                    kind: 'provider_session.v1',
                    providerSessionId: 'vendor-session-1',
                },
            },
            terminal: {
                mode: 'integrated',
                windows: {
                    launchMode: 'windows_terminal',
                    console: 'visible',
                    windowName: 'happier-qa',
                },
            },
        });
    });

    it('carries a source-context continuation recipe onto the strict spawn input, and omits it otherwise', () => {
        const draft = buildNewSessionAuthoringDraftFromTempData({
            machineId: 'machine-1',
            executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
            directory: '/repo',
            organizationPlacement: { folderId: null, tagIds: [] },
            agentType: 'codex',
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
        } as any);
        const base = {
            draft,
            creationKey: 'attempt-1',
            permissionMode: 'default' as const,
            configurationUpdatedAtMs: 999,
        };

        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            ...base,
            sourceContext: {
                v: 1,
                kind: 'session_replay',
                sourceSessionId: 'parent_1',
                forkPoint: { type: 'seq', upToSeqInclusive: 12 },
            },
        }).sourceContext).toEqual({
            v: 1,
            kind: 'session_replay',
            sourceSessionId: 'parent_1',
            forkPoint: { type: 'seq', upToSeqInclusive: 12 },
        });

        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({ ...base, sourceContext: null }).sourceContext)
            .toBeUndefined();
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft(base).sourceContext).toBeUndefined();
    });

    it('preserves an absent draft model selection so migrated profile intent can fill it on read', () => {
        const draft = buildNewSessionAuthoringDraftFromTempData({
            prompt: 'Review this',
            directory: '/tmp/project',
            agentType: 'claude',
            backendTarget: { kind: 'backend', backendId: 'claude' },
            selectedProfileId: 'deepseek',
        });

        expect(Object.prototype.hasOwnProperty.call(draft, 'modelSelection')).toBe(false);
    });

    it('hydrates an existing-session automation template into a shared authoring draft', () => {
        const template = decodeAutomationTemplate(JSON.stringify({
            directory: '/tmp/project',
            prompt: 'Summarize the latest changes',
            displayText: 'Summarize the latest changes',
            agent: 'codex',
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { OPENAI_API_KEY: 'secret' },
            resume: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: { mcp: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            } },
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'hidden',
            windowsTerminalWindowName: 'happier-qa',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            agentModeId: 'plan',
            existingSessionId: 'session-1',
            sessionEncryptionMode: 'plain',
            sessionEncryptionKeyBase64: 'dek',
            sessionEncryptionVariant: 'dataKey',
        }));
        expect(template).not.toBeNull();
        if (!template) return;

        const draft = hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'existing_session',
            template,
        });

        expect(draft).toEqual(expect.objectContaining({
            targetType: 'existing_session',
            executionTarget: null,
            organizationPlacement: { folderId: null, tagIds: [] },
            directory: '/tmp/project',
            prompt: 'Summarize the latest changes',
            displayText: 'Summarize the latest changes',
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { OPENAI_API_KEY: 'secret' },
            resumeSessionId: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: { mcp: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            } },
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'hidden',
            windowsTerminalWindowName: 'happier-qa',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: null,
            existingSessionId: 'session-1',
            sessionEncryptionMode: 'plain',
            sessionEncryptionKeyBase64: 'dek',
            sessionEncryptionVariant: 'dataKey',
            automation: null,
        }));
    });

    it('builds a new-session automation template from the shared draft without leaking existing-session-only fields', () => {
        const template = buildAutomationTemplateFromSessionAuthoringDraft({
            targetType: 'new_session',
            executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Open the repository and run checks',
            displayText: 'Open the repository and run checks',
            organizationPlacement: { folderId: null, tagIds: [] },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            transcriptStorage: 'persisted',
            profileId: 'profile-1',
            environmentVariables: { FOO: 'bar' },
            resumeSessionId: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: null,
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'visible',
            windowsTerminalWindowName: 'happier-qa',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'acp' },
            },
            acpSessionModeId: 'plan',
            existingSessionId: 'session-1',
            sessionEncryptionMode: 'plain',
            sessionEncryptionKeyBase64: 'dek',
            sessionEncryptionVariant: 'dataKey',
        } satisfies SessionAuthoringDraft);

        expect(template).toEqual(expect.objectContaining({
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Open the repository and run checks',
            displayText: 'Open the repository and run checks',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            transcriptStorage: 'persisted',
            profileId: 'profile-1',
            environmentVariables: { FOO: 'bar' },
            resume: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'visible',
            windowsTerminalWindowName: 'happier-qa',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'acp' },
            },
            agentModeId: 'plan',
        }));
        expect(template).not.toHaveProperty('experimentalCodexAcp');
        expect(template.sessionConfigOptionOverrides).toBeUndefined();
        expect(template.existingSessionId).toBeUndefined();
        expect(template.sessionEncryptionKeyBase64).toBeUndefined();
        expect(template.sessionEncryptionVariant).toBeUndefined();
    });

    it('preserves an authored existing-branch checkout choice in the automation template', () => {
        const template = buildAutomationTemplateFromSessionAuthoringDraft({
            targetType: 'new_session',
            executionTarget: null,
            organizationPlacement: { folderId: null, tagIds: [] },
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
                branchMode: 'existing',
            },
            prompt: 'Open the repository and run checks',
            displayText: '',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: null,
            permissionModeUpdatedAt: null,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            existingSessionId: null,
            sessionEncryptionMode: null,
            sessionEncryptionKeyBase64: null,
            sessionEncryptionVariant: null,
        } satisfies SessionAuthoringDraft);

        expect(template.checkoutCreationDraft).toEqual({
            kind: 'git_worktree',
            displayName: 'feature/auth',
            baseRef: 'main',
            branchMode: 'existing',
        });
    });

    it('builds a new-session authoring draft through the shared adapter layer', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Run the nightly maintenance checklist',
            displayText: 'Run the nightly maintenance checklist',
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { FOO: 'bar' },
            resumeSessionId: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: { mcp: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            } },
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'visible',
            windowsTerminalWindowName: 'happier-qa',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    speed: { updatedAt: 789, value: 'fast' },
                },
            },
        });

        expect(draft).toEqual(expect.objectContaining({
            targetType: 'new_session',
            executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
            directory: '/tmp/project',
            organizationPlacement: { folderId: null, tagIds: [] },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            profileId: 'profile-1',
            permissionMode: 'acceptEdits',
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            transcriptStorage: 'direct',
            acpSessionModeId: 'plan',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    speed: { updatedAt: 789, value: 'fast' },
                },
            },
        }));

    });

    it('round-trips an existing-session authoring draft through the shared automation template adapter', () => {
        const initialDraft = {
            targetType: 'existing_session',
            executionTarget: null,
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            organizationPlacement: { folderId: null, tagIds: [] },
            prompt: 'Send the daily reminder',
            displayText: 'Send the daily reminder',
            agentTarget: {
                kind: 'agent' as const,
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            transcriptStorage: 'direct',
            profileId: null,
            environmentVariables: { FOO: 'bar' },
            resumeSessionId: null,
            permissionMode: 'readOnly',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: { mcp: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: [],
            } },
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: null,
            existingSessionId: 'session-1',
            sessionEncryptionMode: 'plain',
            sessionEncryptionKeyBase64: 'dek',
            sessionEncryptionVariant: 'dataKey',
            automation: null,
        } satisfies SessionAuthoringDraft;

        const template = buildAutomationTemplateFromSessionAuthoringDraft(initialDraft);
        const hydrated = hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'existing_session',
            template,
        });

        expect(hydrated).toEqual(initialDraft);
    });

    it('preserves a provider-bound model literally named default across authoring boundaries', () => {
        const explicitDefault = modelSelection('agent:happier.agent.codex/codex', 'default', 456, 'pc_openrouter');
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Run the review',
            displayText: 'Run the review',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: null,
            permissionModeUpdatedAt: null,
            modelSelection: explicitDefault,
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const template = buildAutomationTemplateFromSessionAuthoringDraft(draft);
        const hydrated = hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'new_session',
            template,
        });
        const spawnInput = buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft: hydrated,
            creationKey: 'attempt-default-model',
            permissionMode: 'default',
            configurationUpdatedAtMs: 987,
        });
        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft: hydrated,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            updatedAt: 987,
        });

        expect(template.modelSelection).toEqual(explicitDefault);
        expect(template).not.toHaveProperty('modelId');
        expect(hydrated.modelSelection).toEqual(explicitDefault);
        expect(spawnInput.modelSelection).toEqual(explicitDefault);
        expect(spawnInput).not.toHaveProperty('modelId');
        expect(persistedDraft.modelSelection).toEqual(explicitDefault);
        expect(persistedDraft).not.toHaveProperty('modelMode');
    });

    it('hydrates an existing-session authoring draft from a live session snapshot', () => {
        const configuredAgent = buildConfiguredAcpAgentSelectionV1('review-bot');
        const draft = buildExistingSessionAuthoringDraftFromSessionSnapshot({
            session: {
                id: 'session-1',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/project',
                    host: 'qa-host',
                    homeDir: '/tmp',
                    profileId: 'profile-1',
                    flavor: configuredAgent.agentId,
                    runtimeDescriptorV1: configuredAgent.runtimeDescriptorV1,
                    permissionMode: 'read-only',
                    permissionModeUpdatedAt: 10,
                    acpConfiguredBackendV1: {
                        v: 1,
                        updatedAt: 20,
                        backendId: 'review-bot',
                        title: 'Review Bot',
                    },
                    terminal: {
                        mode: 'tmux',
                        tmux: { target: 'happy-dev' },
                    },
                },
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 123,
                modelMode: 'gpt-5',
                modelModeUpdatedAt: 456,
            },
            message: 'Send the daily summary',
            sessionDekBase64: 'dek-base64',
        });

        expect(draft).toEqual(expect.objectContaining({
            targetType: 'existing_session',
            executionTarget: null,
            organizationPlacement: { folderId: null, tagIds: [] },
            directory: '/tmp/project',
            prompt: 'Send the daily summary',
            displayText: 'Send the daily summary',
            agentTarget: configuredAgent.agentTarget,
            profileId: 'profile-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.custom-acp/custom-acp:definition:review-bot'),
            terminal: { mode: 'tmux', tmux: { sessionName: 'happy-dev' } },
            runtimeDescriptorV1: configuredAgent.runtimeDescriptorV1,
            existingSessionId: 'session-1',
            sessionEncryptionMode: 'e2ee',
            sessionEncryptionKeyBase64: 'dek-base64',
            sessionEncryptionVariant: 'dataKey',
        }));
    });

    it('keeps codex backend mode canonical when hydrating a legacy automation template', () => {
        const template = decodeAutomationTemplate(JSON.stringify({
            directory: '/tmp/project',
            prompt: 'Review the repo',
            displayText: 'Review the repo',
            agent: 'codex',
            experimentalCodexAcp: true,
        }));
        expect(template).not.toBeNull();
        if (!template) return;

        const draft = hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'new_session',
            template,
        });
        const tempData = buildNewSessionTempDataFromAuthoringDraft({
            draft: {
                ...draft,
                automation: intervalAutomationDraft({
                    name: 'Nightly',
                    cadenceMinutes: 15,
                }),
            },
            machineId: 'machine-1',
        });

        expect(draft.runtimeDescriptorV1).toMatchObject({
            agentId: 'codex',
            agent: { backendMode: 'acp' },
        });
        expect(tempData.runtimeDescriptorV1).toMatchObject({
            agentId: 'codex',
            agent: { backendMode: 'acp' },
        });
        expect(tempData.backendNewSessionOptionStateByTargetKey).toBeUndefined();
        expect(tempData.automationDraft).toEqual(intervalAutomationDraft({
            name: 'Nightly',
            cadenceMinutes: 15,
        }));
    });

    it('round-trips new-session worktree intent through the shared automation template adapter into temp data', () => {
        const draft = {
            targetType: 'new_session',
            executionTarget: { kind: 'machine' as const, target: { serverId: 'server-1', machineId: 'machine-1' } },
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree' as const,
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            organizationPlacement: { folderId: null, tagIds: [] },
            prompt: 'Open the feature branch worktree',
            displayText: 'Open the feature branch worktree',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: 'persisted',
            profileId: 'profile-1',
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: 'happier-qa',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: null,
            existingSessionId: null,
            sessionEncryptionMode: null,
            sessionEncryptionKeyBase64: null,
            sessionEncryptionVariant: null,
            automation: intervalAutomationDraft({
                name: 'Nightly',
                cadenceMinutes: 15,
            }),
        } satisfies SessionAuthoringDraft;

        const template = buildAutomationTemplateFromSessionAuthoringDraft(draft);
        const hydrated = hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'new_session',
            template,
        });
        const tempData = buildNewSessionTempDataFromAuthoringDraft({
            draft: {
                ...hydrated,
                automation: draft.automation,
            },
            machineId: 'machine-1',
        });

        expect(hydrated).toEqual({
            ...draft,
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
                branchMode: 'new',
            },
            automation: null,
        });
        expect(tempData).toEqual(expect.objectContaining({
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
                branchMode: 'new',
            },
            automationDraft: draft.automation,
        }));
    });

    it('preserves ACP session mode when building temp new-session data from the shared draft', () => {
        const tempData = buildNewSessionTempDataFromAuthoringDraft({
            draft: {
                targetType: 'new_session',
                executionTarget: null,
                organizationPlacement: { folderId: null, tagIds: [] },
                directory: '/tmp/project',
                checkoutCreationDraft: null,
                prompt: 'Run the review',
                displayText: 'Run the review',
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                transcriptStorage: 'persisted',
                profileId: null,
                environmentVariables: null,
                resumeSessionId: null,
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 123,
                modelSelection: modelSelection('agent:happier.agent.codex/codex'),
                capabilitySelection: null,
                connectedServices: null,
                terminal: null,
                windowsRemoteSessionLaunchMode: null,
                windowsRemoteSessionConsole: null,
                windowsTerminalWindowName: null,
                runtimeDescriptorV1: null,
                acpSessionModeId: 'plan',
                existingSessionId: null,
                sessionEncryptionMode: null,
                sessionEncryptionKeyBase64: null,
                sessionEncryptionVariant: null,
                automation: intervalAutomationDraft({
                    name: 'Nightly',
                    cadenceMinutes: 15,
                }),
            },
            machineId: 'machine-1',
        });

        expect(tempData.acpSessionModeId).toBe('plan');
        expect(tempData.automationDraft).toEqual(intervalAutomationDraft({
            name: 'Nightly',
            cadenceMinutes: 15,
        }));
    });

    it('builds a new-session authoring draft from resolved inputs', () => {
        const draft = buildNewSessionAuthoringDraftFromResolvedInputs({
            executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Review the queued invoices',
            organizationPlacement: { folderId: null, tagIds: [] },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { OPENAI_API_KEY: 'secret' },
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: { mcp: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            } },
            connectedServices: { v: 1, bindingsByServiceId: { 'happier.service.github/github': { source: 'connected' } } },
            terminal: { mode: 'tmux', tmux: { sessionName: 'nightly' } },
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    reasoning: { updatedAt: 789, value: 'high' },
                },
            },
            automation: intervalAutomationDraft({
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                cadenceMinutes: 120,
                timezone: 'Europe/Zurich',
            }),
        });

        expect(draft).toEqual(expect.objectContaining({
            targetType: 'new_session',
            executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            organizationPlacement: { folderId: null, tagIds: [] },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { OPENAI_API_KEY: 'secret' },
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: { mcp: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            } },
            connectedServices: { v: 1, bindingsByServiceId: { 'happier.service.github/github': { source: 'connected' } } },
            terminal: { mode: 'tmux', tmux: { sessionName: 'nightly' } },
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    reasoning: { updatedAt: 789, value: 'high' },
                },
            },
            automation: intervalAutomationDraft({
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                cadenceMinutes: 120,
                timezone: 'Europe/Zurich',
            }),
        }));
    });

    it('builds a persisted new-session draft from the shared authoring draft', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: null,
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: { mcp: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            } },
            connectedServices: { v: 1, bindingsByServiceId: { 'happier.service.github/github': { source: 'connected' } } },
            terminal: { mode: 'tmux', tmux: { sessionName: 'nightly' } },
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            acpSessionModeId: 'plan',
            automation: intervalAutomationDraft({
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                cadenceMinutes: 120,
                timezone: 'Europe/Zurich',
            }),
        });

        const composerAttachments = [{
            v: 1 as const,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: {
                label: 'Issue #42',
                typeLabel: 'Issue',
            },
        }];
        const persistedDraftInput = {
            draft,
            machineId: 'machine-1',
            selectedSecretId: 'secret-1',
            selectedSecretIdByProfileIdByEnvVarName: {
                'profile-1': {
                    OPENAI_API_KEY: 'secret-1',
                },
            },
            sessionOnlySecretValueEncByProfileIdByEnvVarName: {
                'profile-1': {
                    GITHUB_TOKEN: { _isSecretValue: true as const, value: 'enc::token' },
                },
            },
            backendNewSessionOptionStateByTargetKey: {
                codex: {
                    experimentalCodexAcp: true,
                },
            },
            composerAttachments,
            updatedAt: 987,
        };
        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft(persistedDraftInput);

        expect(persistedDraft).toEqual({
            input: 'Review the queued invoices',
            targetServerId: 'server-1',
            selectedMachineId: 'machine-1',
            executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
            selectedPath: '/tmp/project',
            organizationPlacement: { folderId: null, tagIds: [] },
            composerAttachments,
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            selectedProfileId: 'profile-1',
            selectedSecretId: 'secret-1',
            selectedSecretIdByProfileIdByEnvVarName: {
                'profile-1': {
                    OPENAI_API_KEY: 'secret-1',
                },
            },
            sessionOnlySecretValueEncByProfileIdByEnvVarName: {
                'profile-1': {
                    GITHUB_TOKEN: { _isSecretValue: true, value: 'enc::token' },
                },
            },
            agentType: 'codex',
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            transcriptStorage: 'direct',
            permissionMode: 'safe-yolo',
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            acpSessionModeId: 'plan',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            capabilitySelection: { mcp: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            } },
            resumeSessionId: 'resume-1',
            backendNewSessionOptionStateByTargetKey: {
                'agent:happier.agent.codex/codex': {
                    experimentalCodexAcp: true,
                },
            },
            automationDraft: intervalAutomationDraft({
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                cadenceMinutes: 120,
                timezone: 'Europe/Zurich',
            }),
            updatedAt: 987,
        });
    });

    it('preserves the canonical target Home over a stale routing value while retaining the Windows launch override', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Open the workspace',
            displayText: 'Open the workspace',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'default',
            permissionModeUpdatedAt: null,
            modelId: null,
            modelUpdatedAt: null,
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            targetServerId: '  server-b  ',
            windowsRemoteSessionLaunchModeOverride: {
                machineId: 'machine-1',
                mode: 'console',
            },
            updatedAt: 987,
        });

        expect(persistedDraft).toEqual(expect.objectContaining({
            targetServerId: 'server-1',
            windowsRemoteSessionLaunchModeOverride: {
                machineId: 'machine-1',
                mode: 'console',
            },
        }));
    });

    it('retains the canonical target Home when routing is blank and omits a blank Windows override', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Open the workspace',
            displayText: 'Open the workspace',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'default',
            permissionModeUpdatedAt: null,
            modelId: null,
            modelUpdatedAt: null,
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            targetServerId: '   ',
            windowsRemoteSessionLaunchModeOverride: {
                machineId: '   ',
                mode: 'console',
            },
            updatedAt: 987,
        });

        expect(persistedDraft.targetServerId).toBe('server-1');
        expect(persistedDraft).not.toEqual(expect.objectContaining({
            windowsRemoteSessionLaunchModeOverride: expect.anything(),
        }));
    });

    it('hydrates temp new-session data into the shared authoring draft including automation and connected services', () => {
        const sourceDraft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: null,
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: null,
            connectedServices: { v: 2, bindingsByServiceId: { 'happier.service.github/github': { source: 'connected', profileId: 'github-profile' } } },
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    speed: { updatedAt: 789, value: 'fast' },
                },
            },
            automation: intervalAutomationDraft({
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                cadenceMinutes: 120,
                timezone: 'Europe/Zurich',
            }),
        });

        const tempData = buildNewSessionTempDataFromAuthoringDraft({
            draft: sourceDraft,
            machineId: 'machine-1',
        });

        expect(tempData.directory).toBe('/tmp/project');
        expect(tempData.path).toBeUndefined();
        expect(buildNewSessionAuthoringDraftFromTempData(tempData)).toEqual(expect.objectContaining({
            directory: '/tmp/project',
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    speed: { updatedAt: 789, value: 'fast' },
                },
            },
            connectedServices: { v: 2, bindingsByServiceId: { 'happier.service.github/github': { source: 'connected', profileId: 'github-profile' } } },
            automation: intervalAutomationDraft({
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                cadenceMinutes: 120,
                timezone: 'Europe/Zurich',
            }),
        }));
    });

    it('hydrates a persisted new-session draft into the shared authoring draft including automation and connected services', () => {
        const sourceDraft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: null,
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            capabilitySelection: null,
            connectedServices: { v: 2, bindingsByServiceId: { 'happier.service.github/github': { source: 'connected', profileId: 'github-profile' } } },
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    speed: { updatedAt: 789, value: 'fast' },
                },
            },
            automation: intervalAutomationDraft({
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                cadenceMinutes: 120,
                timezone: 'Europe/Zurich',
            }),
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft: sourceDraft,
            machineId: 'machine-1',
            selectedSecretId: 'secret-1',
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: {
                ['agent:happier.agent.codex/codex']: {
                    connectedServices: { v: 2, bindingsByServiceId: { 'happier.service.github/github': { source: 'connected', profileId: 'github-profile' } } },
                },
            },
            updatedAt: 987,
        });

        expect(buildNewSessionAuthoringDraftFromPersistedDraft(persistedDraft)).toEqual(expect.objectContaining({
            directory: '/tmp/project',
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            modelSelection: modelSelection('agent:happier.agent.codex/codex'),
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    speed: { updatedAt: 789, value: 'fast' },
                },
            },
            connectedServices: { v: 2, bindingsByServiceId: { 'happier.service.github/github': { source: 'connected', profileId: 'github-profile' } } },
            automation: intervalAutomationDraft({
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                cadenceMinutes: 120,
                timezone: 'Europe/Zurich',
            }),
        }));
    });

    it('preserves an unselected Agent while retaining the compatibility display default', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            agentTarget: null,
            transcriptStorage: 'direct',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: null,
            modelUpdatedAt: null,
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            preferredPersistedAgentId: 'codex',
            updatedAt: 987,
        });

        expect(persistedDraft).toEqual(expect.objectContaining({
            agentType: 'codex',
            agentTarget: null,
        }));
        expect(buildNewSessionAuthoringDraftFromPersistedDraft(persistedDraft)).toEqual(expect.objectContaining({
            agentTarget: null,
        }));
    });

    it('ignores a legacy customAcp display default without authoring a fallback Agent', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            agentTarget: null,
            transcriptStorage: 'direct',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: null,
            modelUpdatedAt: null,
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            preferredPersistedAgentId: 'customAcp',
            updatedAt: 987,
        });

        expect(persistedDraft).toEqual(expect.objectContaining({
            agentType: DEFAULT_AGENT_ID,
            agentTarget: null,
        }));
        expect(persistedDraft).not.toHaveProperty('backendTarget');
    });

    it('keeps an unselected Agent in temp data without the legacy customAcp sentinel', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            agentTarget: null,
            transcriptStorage: 'direct',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: null,
            modelUpdatedAt: null,
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const tempData = buildNewSessionTempDataFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
        });

        expect(tempData).toEqual(expect.objectContaining({
            agentTarget: null,
        }));
        expect(tempData).not.toHaveProperty('backendTarget');
        expect(tempData.agentType).not.toBe('customAcp');
    });

    it('does not collapse plugin backend targets into the custom ACP sentinel when persisting drafts', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Run the plugin backend',
            displayText: 'Run the plugin backend',
            agentTarget: { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'review' } },
            transcriptStorage: 'direct',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelId: null,
            modelUpdatedAt: null,
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            preferredPersistedAgentId: 'claude',
            updatedAt: 987,
        });

        expect(persistedDraft).toEqual(expect.objectContaining({
            agentType: 'claude',
            agentTarget: { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'review' } },
        }));
        expect(persistedDraft).not.toHaveProperty('backendTarget');

        expect(buildNewSessionAuthoringDraftFromPersistedDraft(persistedDraft)).toEqual(expect.objectContaining({
            agentTarget: { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'review' } },
        }));
    });

    it('defaults plugin backend drafts to the global default agent type when no preferred agent id is available', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Run the plugin backend',
            displayText: 'Run the plugin backend',
            agentTarget: { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'review' } },
            transcriptStorage: 'direct',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelId: null,
            modelUpdatedAt: null,
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            preferredPersistedAgentId: null,
            updatedAt: 987,
        });

        expect(persistedDraft.agentType).toBe(DEFAULT_AGENT_ID);
        expect(persistedDraft.agentType).not.toBe('customAcp');
        expect(persistedDraft).not.toHaveProperty('backendTarget');
    });

    it('round-trips configured ACP backend targets and session config overrides through the shared new-session authoring draft', () => {
        const draft = {
            targetType: 'new_session',
            executionTarget: { kind: 'machine' as const, target: { serverId: 'server-1', machineId: 'machine-1' } },
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            organizationPlacement: { folderId: null, tagIds: [] },
            prompt: 'Review the repo state',
            displayText: 'Review the repo state',
            agentTarget: {
                kind: 'agent' as const,
                identity: { pluginId: 'acme.review', localId: 'review' },
            },
            transcriptStorage: 'persisted' as const,
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelId: null,
            modelUpdatedAt: null,
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    reasoning: { updatedAt: 789, value: 'high' },
                },
            },
            existingSessionId: null,
            sessionEncryptionMode: null,
            sessionEncryptionKeyBase64: null,
            sessionEncryptionVariant: null,
            automation: intervalAutomationDraft({
                name: 'Backend review',
                cadenceMinutes: 30,
            }),
        } satisfies SessionAuthoringDraft;

        const template = buildAutomationTemplateFromSessionAuthoringDraft(draft);
        const hydrated = hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'new_session',
            template,
        });
        const tempData = buildNewSessionTempDataFromAuthoringDraft({
            draft: hydrated,
            machineId: 'machine-1',
        });

        expect(template).toEqual(expect.objectContaining({
            agentTarget: draft.agentTarget,
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    reasoning: { updatedAt: 789, value: 'high' },
                },
            },
        }));
        expect(hydrated).toEqual(expect.objectContaining({
            agentTarget: draft.agentTarget,
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    reasoning: { updatedAt: 789, value: 'high' },
                },
            },
            automation: null,
        }));
        expect(tempData).toEqual(expect.objectContaining({
            agentTarget: draft.agentTarget,
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    reasoning: { updatedAt: 789, value: 'high' },
                },
            },
        }));
        expect(tempData.automationDraft).toBeUndefined();
    });
});

/**
 * An Agent-issued resume id is opaque. Every authoring projection hands the id
 * back to the Agent that minted it, so whitespace, newlines and encoding bytes
 * are part of the identity rather than formatting Happier may canonicalize.
 */
describe('opaque Agent resume id preservation', () => {
    const OPAQUE_RESUME_ID = ' provider\nsession ';

    function opaqueResumeDraft(): SessionAuthoringDraft {
        return buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Continue',
            displayText: 'Continue',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: OPAQUE_RESUME_ID,
            permissionMode: 'default',
            permissionModeUpdatedAt: 123,
            modelSelection: null,
            capabilitySelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });
    }

    it('preserves the exact bytes through the new-session authoring draft', () => {
        expect(opaqueResumeDraft().resumeSessionId).toBe(OPAQUE_RESUME_ID);
    });

    it('preserves the exact bytes through the automation template round trip', () => {
        const template = buildAutomationTemplateFromSessionAuthoringDraft(opaqueResumeDraft());
        expect(template.resume).toBe(OPAQUE_RESUME_ID);

        const decoded = decodeAutomationTemplate(JSON.stringify(template));
        expect(decoded).not.toBeNull();
        if (!decoded) return;
        expect(hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'new_session',
            template: decoded,
        }).resumeSessionId).toBe(OPAQUE_RESUME_ID);
    });

    it('preserves the exact bytes through the shared strict V2 spawn projection', () => {
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft: opaqueResumeDraft(),
            creationKey: 'attempt-opaque-resume',
            permissionMode: 'default',
            configurationUpdatedAtMs: 999,
        }).configuration?.providerSessionResume).toEqual({
            kind: 'provider_session.v1',
            providerSessionId: OPAQUE_RESUME_ID,
        });
    });

    it('preserves the exact bytes through the persisted new-session draft projection', () => {
        expect(buildPersistedNewSessionDraftFromAuthoringDraft({
            draft: opaqueResumeDraft(),
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            updatedAt: 987,
        }).resumeSessionId).toBe(OPAQUE_RESUME_ID);
    });

    it('still treats a blank-only resume id as absent in every projection', () => {
        const blank = { ...opaqueResumeDraft(), resumeSessionId: '   ' };

        expect(buildAutomationTemplateFromSessionAuthoringDraft(blank)).not.toHaveProperty('resume');
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft: blank,
            creationKey: 'attempt-blank-resume',
            permissionMode: 'default',
            configurationUpdatedAtMs: 999,
        }).configuration?.providerSessionResume).toBeUndefined();
        expect(buildPersistedNewSessionDraftFromAuthoringDraft({
            draft: blank,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            updatedAt: 987,
        })).not.toHaveProperty('resumeSessionId');
    });
});
