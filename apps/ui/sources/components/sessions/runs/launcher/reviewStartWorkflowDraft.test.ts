import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { actionSpecToActionDefinitionV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { resolveWorkflowContextInputsV1 } from '@happier-dev/protocol/workflows/workflowStartPreparationV1';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { validateWorkflowEditorDraft } from '@/sync/domains/workflows/workflowAuthoring';
import { buildReviewStartWorkflowDraftSeed } from './reviewStartWorkflowDraft';

describe('prestart Review workflow authoring', () => {
    it('admits a saved launcher Review against its detached workspace and binds each triggering Session independently', async () => {
        const sourceSession = { serverId: 'home', sessionId: 'launcher-session' };
        const seed = buildReviewStartWorkflowDraftSeed({
            input: { sessionId: sourceSession.sessionId, scope: 'repository',
                reviewers: [{ kind: 'engine', engineId: 'codex', includeSessionTranscript: true }] },
            instructions: 'Inspect the project and source transcript', sourceSession, name: 'Review habit',
            project: { machineId: 'machine-1', directory: '/repo' }, executionTarget: 'session',
        });
        if (!seed.draft) throw new Error('Expected an editable draft');
        const validation = validateWorkflowEditorDraft(seed.draft);
        expect(validation.valid, JSON.stringify(validation.issues)).toBe(true);
        const definition = validation.normalizedDefinition;
        if (!definition) throw new Error('Expected a normalized saved definition');
        const contract = actionSpecToActionDefinitionV1(getActionSpec('review.start'));
        const executor = createActionExecutor({});
        for (const session of [sourceSession, { ...sourceSession, sessionId: 'later-trigger-session' }]) {
            // Authenticated Session lookup and admission are the process boundary.
            const resolveSessionTarget = async (value: unknown) => value === session.sessionId || sameStrictJsonValue(value, session)
                ? { address: session, machineId: 'machine-1' } : null;
            const inputs = await resolveWorkflowContextInputsV1({ definition,
                inputs: session === sourceSession ? seed.inputValues : {},
                originSessionId: session === sourceSession ? undefined : session.sessionId, resolveSessionTarget });
            const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
                context: { source: { kind: 'inline' }, inputs, machineId: 'machine-1', executionTarget: { kind: 'session' },
                    workspaceTarget: { project: { ...seed.project!, checkoutRootPath: '/repo' } }, origin: { kind: 'direct',
                        ...(session === sourceSession ? {} : { originSessionId: session.sessionId }) },
                    authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
                effects: { resolveTargetAvailability: async () => true, resolveSessionTarget,
                    admitSessionAuthority: async target => sameStrictJsonValue(target.address, session),
                    readActionContract: async () => ({ inputSchema: projectNativeJsonValueForTransport(contract.inputSchema),
                        outputSchema: projectNativeJsonValueForTransport(contract.outputSchema ?? {}) }) } });
            expect(accepted, JSON.stringify(accepted.ok ? { ok: true } : accepted.error)).toMatchObject({ ok: true });
            if (!accepted.ok) throw new Error(accepted.error.code);
            const leaf = accepted.snapshot.materializedLeaves[0];
            expect(leaf?.actionInput).toMatchObject({ target: { kind: 'detached' }, sourceSession: session });
            expect(leaf?.actionInput).not.toHaveProperty('sessionId');
            expect(leaf?.sessionAuthorityBindings).toEqual([
                { inputName: 'sourceSession', targets: [{ address: session, machineId: 'machine-1' }] },
                { targets: [{ address: session, machineId: 'machine-1' }] },
            ]);
            const prepared = await executor.prepare('review.start', leaf!.actionInput, { surface: 'agent', serverId: 'home',
                actionCaller: { kind: 'workflowRun', runId: 'workflow-1', authorization: {
                    principal: { kind: 'host' }, admittedPermissionCeiling: 'read-only' } },
                agentStartContext: { caller: { kind: 'originless', runId: 'workflow-1', runDepth: 0 },
                    baseline: { machineId: 'machine-1', directory: '/repo' }, ledSubtreeSessionIds: [],
                    workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'read-only' },
                executionRunTargetMachineId: 'machine-1', externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: seed.project! } });
            expect(prepared).toMatchObject({ kind: 'ready' });
        }
        expect(seed).toMatchObject({ inputValues: { sourceSession } });
        expect(definition.inputs).toEqual([{ name: 'sourceSession', valueType: 'json', required: true,
            inputType: { hostType: 'session' }, defaultFrom: 'origin_session' }]);
    });

    it('keeps an ordinary detached Review as an editable Action without inventing a Session or admitted round', () => {
        const seed = buildReviewStartWorkflowDraftSeed({
            input: { target: { kind: 'detached' }, cwd: '/chosen/project',
                reviewers: [{ kind: 'engine', engineId: 'claude', options: { nested: { retained: true } } }],
                then: 'report' },
            instructions: 'Inspect this project', sourceSession: null, name: 'Project Review',
            project: { machineId: 'chosen-machine', directory: '/chosen/project' }, executionTarget: 'detached_run',
        });
        expect(seed).toMatchObject({ project: { machineId: 'chosen-machine', directory: '/chosen/project' }, executionTarget: 'detached_run' });
        if (!seed.draft) throw new Error('Expected the ordinary editable draft');
        const validation = validateWorkflowEditorDraft(seed.draft);
        expect(validation.valid, JSON.stringify(validation.issues)).toBe(true);
        const block = validation.normalizedDefinition?.blocks[0];
        if (block?.kind !== 'action') throw new Error('Expected a Review Action');
        expect(block).toMatchObject({ actionId: 'review.start', input: {
            target: { kind: 'literal', value: { kind: 'detached' } },
            cwd: { kind: 'literal', value: '/chosen/project' },
            instructions: { kind: 'literal', value: 'Inspect this project' },
            reviewers: { kind: 'literal', value: [{ kind: 'engine', engineId: 'claude', options: { nested: { retained: true } } }] },
        } });
        expect(block.input).not.toHaveProperty('sessionId');
        expect(block.input).not.toHaveProperty('sourceSession');
        expect(block.input).not.toHaveProperty('reviewRound');
    });
});
