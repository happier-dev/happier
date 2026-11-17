import { describe, expect, it, vi } from 'vitest';

// The projection reaches Session authoring's native style boundary; use the
// complete canonical theme fixture rather than the historical global stub.
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import {
    AutomationRunExecutionTargetV1Schema,
} from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import {
    SessionServerStartSpawnDraftV1Schema} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

import {
    projectLegacyAutomationRecipeToEditorDraft,
} from './automationRecipeWorkflowDraft';
import { validateWorkflowEditorDraft } from './workflowAuthoring';

const AGENT_TARGET = {
    kind: 'agent' as const,
    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
};

function spawnTarget(overrides?: Record<string, unknown>) {
    const target = AutomationRunExecutionTargetV1Schema.parse({
        kind: 'newSession',
        spawn: SessionServerStartSpawnDraftV1Schema.parse({
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/repo' },
            agentTarget: AGENT_TARGET,
            permissionMode: 'default',
            configuration: {
                mode: { value: null, updatedAtMs: 10 },
                model: { value: null, updatedAtMs: 10 },
                permissionIntent: { value: 'default', updatedAtMs: 10 },
                options: {},
            },
            capabilitySelection: { mcp: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['review-tools'],
                forceExcludeServerIds: [],
            } },
            checkoutCreationDraft: null,
            ...overrides,
        }),
    });
    if (target.kind !== 'newSession') throw new Error('Expected a new Session target fixture');
    return target;
}

function legacyDraft(target: Parameters<typeof projectLegacyAutomationRecipeToEditorDraft>[0]['target'], machineId: string | null = 'machine-1') {
    return projectLegacyAutomationRecipeToEditorDraft({
        draftId: 'draft-1',
        name: 'Nightly check',
        program: { v: 1, prompt: 'Review the release' },
        target,
        machineId,
    });
}

describe('legacy Automation recipe → shared Workflow draft', () => {
    it('retains explicit Project files placement when opening a Session recipe in workflows', () => {
        const sessionPlacement = { kind: 'machine' as const, target: { serverId: 'server-1', machineId: 'machine-1' },
            projectFiles: { kind: 'sync' as const, mode: 'keep_synced' as const } };
        expect(legacyDraft(spawnTarget({ sessionPlacement })).project)
            .toMatchObject({ machineId: 'machine-1', directory: '/repo', sessionPlacement });
    });
    it('retains a managed directory without fabricating a project path', () => {
        expect(legacyDraft(spawnTarget({ directory: { kind: 'managed' } })).project)
            .toEqual({ machineId: 'machine-1', directory: { kind: 'managed' } });
    });
    it('adapts a one-shot new-Session recipe into one valid canonical step', () => {
        const projection = legacyDraft(spawnTarget());

        expect(projection.draft.blocks).toHaveLength(1);
        const block = projection.draft.blocks[0]!;
        expect(block.kind).toBe('step');
        expect(block.kind === 'step' ? block.document.text : null).toBe('Review the release');
        expect(projection.origin.kind).toBe('legacy');
        expect(projection.project).toEqual({ machineId: 'machine-1', directory: '/repo' });

        // The adapted draft must be a definition the canonical validator
        // accepts, not an editor-only shape.
        const validation = validateWorkflowEditorDraft(projection.draft);
        expect(validation.valid).toBe(true);
    });

    it('shows the recipe settings through the same authoring selection, not a second vocabulary', () => {
        const projection = legacyDraft(spawnTarget());

        expect(projection.draft.defaults.agentTarget).toEqual(AGENT_TARGET);
        expect(projection.draft.defaults.permissionMode).toBe('default');
        expect(projection.draft.defaults.capabilitySelection).toEqual({ mcp: {
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['review-tools'],
            forceExcludeServerIds: [],
        } });
        expect(projection.draft.defaults.conversation).toEqual({ kind: 'fresh' });
    });

    it('keeps an existing-Session recipe bound to its exact Session and machine', () => {
        const projection = legacyDraft({ kind: 'existingSession', sessionId: 'session-7' });

        expect(projection.draft.defaults.conversation).toEqual({
            kind: 'existing_session',
            sessionId: 'session-7',
            machineId: 'machine-1',
        });
    });

    it('states no conversation when no assignment resolves the existing Session machine', () => {
        const projection = legacyDraft({ kind: 'existingSession', sessionId: 'session-7' }, null);

        expect(projection.draft.defaults.conversation).toBeUndefined();
        expect(projection.project).toBeNull();
    });
});

describe('detached legacy Automation editing', () => {
    it('projects a bundled runtime target through the canonical Agent identity owner', () => {
        const target = AutomationRunExecutionTargetV1Schema.parse({ kind: 'executionRun', request: {
            intent: 'task', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
        } });
        if (target.kind !== 'executionRun') throw new Error('Expected an execution Run target fixture');
        expect(legacyDraft(target).draft.defaults.agentTarget).toEqual(AGENT_TARGET);
    });
    it('preserves detached settings through the shared read projection', () => {
        const target = AutomationRunExecutionTargetV1Schema.parse({
            kind: 'executionRun',
            request: {
                intent: 'task', backendTarget: AGENT_TARGET, permissionMode: 'read_only',
                retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
                cwd: '/detached-repo', modelId: 'review-model',
                sessionConfigOptionOverrides: { v: 1, updatedAt: 10, overrides: { reasoning_effort: { value: 'high', updatedAt: 10 } } },
            },
        });
        if (target.kind !== 'executionRun') throw new Error('Expected an execution Run target fixture');
        const projection = legacyDraft(target);
        expect(projection.project).toEqual({ machineId: 'machine-1', directory: '/detached-repo' });
        expect(projection.draft.defaults).toMatchObject({
            agentTarget: AGENT_TARGET, permissionMode: 'read-only', conversation: { kind: 'fresh' },
            modelSelection: { ref: { modelId: 'review-model', providerConnectionId: null } },
            sessionConfigOptionOverrides: { v: 1, updatedAt: 10, overrides: { reasoning_effort: { value: 'high', updatedAt: 10 } } },
        });
    });
});
