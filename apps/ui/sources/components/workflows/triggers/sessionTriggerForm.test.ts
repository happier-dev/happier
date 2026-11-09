import { describe, expect, it } from 'vitest';
import { validateWorkflowDefinition } from '@happier-dev/protocol/workflows/workflowValidationV1';
import { resolveWorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AutomationTriggerDefinitionBindingV1Schema, sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';

import {
    buildTriggerDefinition,
    buildTriggerExecutionTarget,
    buildTriggerTarget,
    projectSessionTriggerWorkflowInputFields,
    buildSessionTriggerWorkflowInputs,
    createDefaultWhen,
    readTriggerThen,
    readTriggerWhen,
    readWorkflowTriggerSetForm,
} from './sessionTriggerForm';

const selection = { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } };

describe('session trigger form', () => {
    it('reopens and preserves the exact Run lifecycle source when editing a managed rule', async () => {
        const { AutomationTriggerDetailSchema} = await import('@happier-dev/protocol/automations/automationTriggerProjectionV1');
        const source = { kind: 'execution_run', machineId: 'source-machine', runId: 'run-exact', sessionId: 'source-session' } as const;
        const trigger = AutomationTriggerDetailSchema.parse({ kind: 'runLifecycle', id: 'run-trigger', revision: 1,
            enabled: true, createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null, source, condition: 'terminal',
            remainingOccurrences: 1, status: { state: 'waiting', runId: null } });
        const when = readTriggerWhen(trigger);
        expect(when).toEqual({ kind: 'runLifecycle', source, condition: 'terminal' });
        if (when === null) throw new Error('Expected the saved Run condition');
        expect(buildTriggerDefinition({ when, enabled: false, sessionId: null })).toEqual({
            kind: 'runLifecycle', source, condition: 'terminal', enabled: false,
        });
        expect(buildTriggerExecutionTarget({ kind: 'doAction', actionId: 'machines.managed.delete', input: {} },
            { kind: 'detached_run' })).toEqual({ kind: 'detached_run' });
    });
    it('retains observation-only Event intent when reopening its saved trigger', () => {
        const binding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1, automationId: 'automation',
            triggerId: '00000000-0000-4000-8000-000000000001', triggerRevision: 1, triggerKind: 'pluginEvent',
            eventRef: { pluginId: 'example.events', localId: 'deployment-review' }, sourceSelectorId: '00000000-0000-4000-8000-000000000002' });
        const envelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
            definition: { v: 1, sourceInstanceId: 'repository:42', sourceConfig: {}, displayLabel: 'Repository',
                filter: null, maximumObservationAgeMs: null } });
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'automation', revision: 1, enabled: true,
            health: 'available', scopeSessionId: null, observationOnly: { kind: 'observationOnly', templateVersion: 1 },
            triggers: [{ kind: 'pluginEvent', id: '00000000-0000-4000-8000-000000000001', revision: 1,
            enabled: true, createdAt: 1, updatedAt: 1, eventRef: { pluginId: 'example.events', localId: 'deployment-review' },
            sourceSelectorId: '00000000-0000-4000-8000-000000000002', sourceContractVersion: 1,
            observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null, sourceCatalogStatus: null,
            triggerDefinitionEnvelope: JSON.stringify(envelope) }] });
        const trigger = set.triggers[0]!;
        if (trigger.kind !== 'pluginEvent') throw new Error('Expected saved Event');
        expect(readTriggerWhen(trigger, { kind: 'observationOnly' })).toEqual({ kind: 'pluginEvent', value: null,
            eventRef: trigger.eventRef, observationOnly: { kind: 'observationOnly' } });
        const form = readWorkflowTriggerSetForm(set, trigger.id);
        expect(form).toEqual({ kind: 'observationOnly', enabled: true, when: { kind: 'pluginEvent', value: null,
            eventRef: trigger.eventRef, observationOnly: { kind: 'observationOnly' } } });
        expect(form).not.toHaveProperty('then');
        expect(readWorkflowTriggerSetForm({ ...set, enabled: false }, trigger.id)).toMatchObject({ enabled: false });
        expect(readWorkflowTriggerSetForm({ ...set, health: 'source_unavailable' }, trigger.id)).toBeNull();
    });
    it.each(['prComment', 'ciFailed'] as const)('binds declared JSON prUpdate from %s occurrence rather than requiring a constant', kind => {
        const inputs = [{ name: 'prUpdate', valueType: 'json' as const, required: true },
            { name: 'request', valueType: 'string' as const, required: true }];
        const when = { kind, pullRequest: { repository: 'acme/widgets', number: 42 } };
        const fields = projectSessionTriggerWorkflowInputFields({ when, inputs, values: { request: 'Analyse this update' } });
        expect(fields.map(field => field.definition.name)).toEqual(['request']);
        expect(fields.some(field => field.blocking)).toBe(false);
        expect(buildSessionTriggerWorkflowInputs({ when, fields, declarations: inputs,
            retainedInputs: { prUpdate: { manualSeed: true }, request: 'Old request' } }))
            .toEqual({ request: 'Analyse this update', prUpdate: { manualSeed: true } });
        expect(buildSessionTriggerWorkflowInputs({ when, fields, declarations: inputs.slice(1),
            retainedInputs: { prUpdate: { undeclared: true } } })).toEqual({ request: 'Analyse this update' });
        expect(inputs).toHaveLength(2);
    });
    it('keeps non-PR required inputs and incompatible prUpdate declarations in the normal repair form', () => {
        const inputs = [{ name: 'prUpdate', valueType: 'json' as const, required: true }];
        const scheduled = projectSessionTriggerWorkflowInputFields({ when: { kind: 'schedule', schedule: null,
            expression: '0 9 * * *', timezone: null }, inputs, values: {} });
        expect(scheduled).toMatchObject([{ definition: inputs[0], blocking: true, errorCode: 'missing_required_input' }]);
        const incompatible = projectSessionTriggerWorkflowInputFields({ when: { kind: 'prComment',
            pullRequest: { repository: 'acme/widgets', number: 42 } }, inputs: [{ ...inputs[0]!, valueType: 'string' }], values: {} });
        expect(incompatible).toMatchObject([{ blocking: true, errorCode: 'missing_required_input' }]);
    });

    it.each(['session', 'account'] as const)('authors the selected Agent on a new %s prompt trigger', (scope) => {
        const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'acme.agents', localId: 'reviewer' } };
        const then = { kind: 'sendPrompt' as const, prompt: 'Review the changes', selection: { agentTarget } };
        const target = buildTriggerTarget(then, scope);
        if (target?.kind !== 'inline') throw new Error('expected an inline target');
        expect(validateWorkflowDefinition(target.definition).valid).toBe(true);
        expect(target.definition.defaults.engine).toMatchObject({ agentTarget });
        expect(readTriggerThen(target)).toMatchObject({ sourceDefinition: { defaults: { engine: { agentTarget } } } });
    });
    it('keeps a new Account prompt incomplete until its contextual Agent is selected', () => {
        expect(buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Review the changes' }, 'account')).toBeNull();
    });
    it('changes a retained step Agent through the canonical engine arm without losing other settings', () => {
        const created = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Review', selection }, 'account');
        if (created?.kind !== 'inline') throw new Error('expected an inline target');
        const target = { ...created, definition: { ...created.definition, blocks: created.definition.blocks.map(block =>
            block.kind === 'step' ? { ...block, execution: { engine: created.definition.defaults.engine,
                permissionMode: 'read-only' as const } } : block) } };
        const original = readTriggerThen(target);
        expect(buildTriggerTarget(original, 'account')).toEqual(target);
        if (original.kind !== 'sendPrompt') throw new Error('expected a prompt form');
        const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        const changed = buildTriggerTarget({ ...original, selection: { agentTarget } }, 'account');
        if (changed?.kind !== 'inline') throw new Error('expected an inline target');
        const step = changed.definition.blocks[0];
        if (step?.kind !== 'step') throw new Error('expected an Agent step');
        expect(resolveWorkflowStepSelectionV1({ defaults: changed.definition.defaults, step: step.execution,
            purpose: 'authoring' }).selection).toMatchObject({ agentTarget, permissionMode: 'read-only' });
        expect(step.execution).not.toHaveProperty('agentTarget');
        expect(validateWorkflowDefinition(changed.definition).valid).toBe(true);
    });
    it('keeps an inputless predecessor Session start intact when reviewing its trigger', () => {
        const target = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'seed', selection }, 'account');
        if (target?.kind !== 'inline') throw new Error('expected an inline target');
        const inputless = { ...target, definition: { ...target.definition,
            blocks: target.definition.blocks.map((block) => block.kind === 'step'
                ? { ...block, inputMode: 'none' as const, document: { ...block.document, text: '' } } : block) } };
        const then = readTriggerThen(inputless);
        expect(then.kind).toBe('kept');
        expect(buildTriggerTarget(then, 'account')).toEqual(inputless);
    });
    it('preserves the exact retained prompt when Save changes only the trigger configuration', () => {
        const target = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'seed', selection }, 'account');
        if (target?.kind !== 'inline') throw new Error('expected an inline target');
        const retained = { ...target, definition: { ...target.definition,
            blocks: target.definition.blocks.map((block) => block.kind === 'step'
                ? { ...block, document: { ...block.document, text: '  retain this prompt\n' } } : block) } };
        const then = readTriggerThen(retained);
        expect(buildTriggerTarget(then, 'account')).toEqual(retained);
    });
    it.each(['defaults', 'step'] as const)('preserves a retained %s destination across editor scopes, but accepts a deliberate change', async (placement) => {
        const { TriggerTargetV1Schema } = await import('@happier-dev/protocol/workflows/triggers/triggerTargetV1');
        const created = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Review', selection }, 'account');
        if (created?.kind !== 'inline') throw new Error('expected an inline target');
        const conversation = { kind: 'existing_session' as const, sessionId: 'destination', machineId: 'machine' };
        const retained = TriggerTargetV1Schema.parse({ ...created, definition: { ...created.definition,
            ...(placement === 'defaults' ? { defaults: { ...created.definition.defaults, conversation } } : {}),
            blocks: created.definition.blocks.map(block => block.kind === 'step' && placement === 'step'
                ? { ...block, execution: { ...block.execution, conversation } } : block),
        } });
        const then = readTriggerThen(retained);
        if (then.kind !== 'sendPrompt') throw new Error('expected a prompt form');
        expect(TriggerTargetV1Schema.parse(buildTriggerTarget(then, 'session'))).toEqual(retained);
        const changed = TriggerTargetV1Schema.parse(buildTriggerTarget({ ...then,
            runsIn: { kind: 'session', sessionId: 'chosen-destination', machineId: 'other-machine' },
        }, 'account'));
        if (changed.kind !== 'inline') throw new Error('expected an inline target');
        const step = changed.definition.blocks[0];
        expect(resolveWorkflowStepSelectionV1({ defaults: changed.definition.defaults,
            step: step?.kind === 'step' ? step.execution : undefined, purpose: 'authoring' }).selection.conversation)
            .toEqual({ kind: 'existing_session', sessionId: 'chosen-destination', machineId: 'other-machine' });
    });
    it('keeps a retained origin-session prompt when edited from the Account surface', () => {
        const target = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Continue here' }, 'session');
        if (!target) throw new Error('expected an inline target');
        expect(buildTriggerTarget(readTriggerThen(target), 'account')).toEqual(target);
    });
    it('writes a configured plugin event through the shared trigger form without requiring a session', async () => {
        const { AutomationTriggerDefinitionInputSchema } = await import('@happier-dev/protocol/automations/automationTriggerDefinition');
        const trigger = AutomationTriggerDefinitionInputSchema.parse({
            kind: 'pluginEvent', enabled: true,
            eventRef: { pluginId: 'acme.github', localId: 'issue-opened' },
            sourceInstanceId: 'repository:42', sourceContractVersion: 3,
            sourceConfig: { repository: 'acme/widgets' }, displayLabel: 'acme/widgets',
            observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
                machineId: 'machine-1',
                pluginId: 'acme.github', materializationId: 'github-1',
            } },
            filter: { v: 1, all: [{ field: '/action', op: 'eq', value: 'opened' }] },
            maximumObservationAgeMs: null,
        });
        if (trigger.kind !== 'pluginEvent' || !('sourceInstanceId' in trigger)) throw new Error('expected a configured event');
        expect(buildTriggerDefinition({ when: { kind: 'pluginEvent', value: trigger }, enabled: false, sessionId: null }))
            .toEqual({ ...trigger, enabled: false });
        expect(buildTriggerDefinition({ when: { kind: 'pluginEvent', value: null }, enabled: true, sessionId: null }))
            .toBeNull();
    });
    it('keeps the original prompt step and execution defaults while editing a legacy prompt', () => {
        const created = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Before', selection }, 'account');
        if (created?.kind !== 'inline') throw new Error('expected an inline target');
        const target = { ...created, definition: { ...created.definition,
            defaults: { ...created.definition.defaults, profileId: 'reviewed-profile', permissionMode: 'read-only' },
            blocks: created.definition.blocks.map((block) => ({ ...block, id: 'retained-step' })),
        } };
        const then = readTriggerThen(target);
        if (then.kind !== 'sendPrompt') throw new Error('expected a prompt form');
        const changed = buildTriggerTarget({ ...then, prompt: 'After' }, 'account');
        expect(changed).toMatchObject({ kind: 'inline', definition: {
            defaults: { profileId: 'reviewed-profile', permissionMode: 'read-only', conversation: { kind: 'fresh' } },
            blocks: [{ id: 'retained-step', document: { text: 'After' } }],
        } });
    });
    it.each(['prComment', 'ciFailed'] as const)('keeps %s and its selected pull request through add and edit', (kind) => {
        expect(createDefaultWhen(kind)).toEqual({ kind, pullRequest: null });
        const when = { kind, pullRequest: { repository: 'happier-dev/happier', number: 42 } };
        const trigger = buildTriggerDefinition({ when, enabled: true, sessionId: 'session-1' });
        expect(trigger).toEqual({ kind, enabled: true, pullRequest: when.pullRequest });
        const saved = { ...trigger, id: 'trigger-1' } as unknown as Parameters<typeof readTriggerWhen>[0];
        expect(readTriggerWhen(saved)).toEqual(when);
        expect(buildTriggerDefinition({ when: createDefaultWhen(kind), enabled: true, sessionId: 'session-1' })).toBeNull();
        expect(buildTriggerDefinition({ when, enabled: true, sessionId: null })).toBeNull();
    });
    it('preselects exactly one link without copying its provider into the strict pull-request selection', () => {
        const link = { provider: 'github' as const, repository: 'happier-dev/happier', number: 42 };
        expect(createDefaultWhen('prComment', [link])).toEqual({ kind: 'prComment',
            pullRequest: { repository: link.repository, number: link.number } });
        expect(createDefaultWhen('ciFailed', [link, { ...link, number: 43 }])).toEqual({ kind: 'ciFailed', pullRequest: null });
    });
    it('writes Notify me as one Notify me step: two Send to channels are both kept, none means your notification settings', () => {
        const two = buildTriggerTarget({ kind: 'notifyMe', message: 'The review converged', title: '', channels: ['discord', 'push'] });
        expect(two?.kind).toBe('inline');
        if (two?.kind !== 'inline') return;
        const [step] = two.definition.blocks;
        expect(step).toMatchObject({
            kind: 'action',
            actionId: 'notifications.notify_me',
            input: { message: { kind: 'literal', value: 'The review converged' }, channels: { kind: 'literal', value: ['discord', 'push'] } },
        });
        expect(readTriggerThen(two)).toEqual({ kind: 'notifyMe', message: 'The review converged', title: '', channels: ['discord', 'push'] });

        const none = buildTriggerTarget({ kind: 'notifyMe', message: 'Done', title: 'Payments', channels: [] });
        if (none?.kind !== 'inline') throw new Error('expected an inline target');
        const [onlyStep] = none.definition.blocks;
        expect(onlyStep?.kind === 'action' ? Object.keys(onlyStep.input).sort() : null).toEqual(['message', 'title']);
    });

    it('writes Send a prompt as one step that continues this session, and reads it back', () => {
        const target = buildTriggerTarget({ kind: 'sendPrompt', prompt: '  Summarize overnight CI  ' });
        if (target?.kind !== 'inline') throw new Error('expected an inline target');
        expect(target.definition.defaults.conversation).toEqual({ kind: 'origin_session' });
        expect(readTriggerThen(target)).toMatchObject({ kind: 'sendPrompt', prompt: 'Summarize overnight CI' });
        // An Account trigger has no session to continue: its prompt starts a new one.
        const account = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Morning digest', selection }, 'account');
        expect(account?.kind === 'inline' ? account.definition.defaults.conversation : null).toEqual({ kind: 'fresh' });
        // An empty prompt is not a target yet.
        expect(buildTriggerTarget({ kind: 'sendPrompt', prompt: '   ' })).toBeNull();
    });

    it('writes Run a workflow as the reference arm', () => {
        expect(buildTriggerTarget({ kind: 'runWorkflow', ref: 'builtin:review-and-converge', inputs: {} }))
            .toEqual({ kind: 'workflow', ref: 'builtin:review-and-converge' });
        expect(buildTriggerTarget({ kind: 'runWorkflow', ref: null, inputs: {} })).toBeNull();
    });

    it('keeps the trigger context inputs when a workflow reference is reopened for editing', () => {
        const inputs = { apply: 'report', maxRounds: 5, engines: ['codex'] };
        const then = readTriggerThen({ kind: 'workflow', ref: 'builtin:review-and-converge' }, undefined, inputs);
        expect(then).toEqual({ kind: 'runWorkflow', ref: 'builtin:review-and-converge', inputs });
        // Constant inputs belong to the Action request, never the strict target arm.
        expect(buildTriggerTarget(then)).toEqual({ kind: 'workflow', ref: 'builtin:review-and-converge' });
    });

    it('keeps constant inputs for an inline target the popover does not author', () => {
        const target = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Review' });
        if (target?.kind !== 'inline') throw new Error('expected an inline target');
        const keptTarget = { ...target, definition: { ...target.definition,
            inputs: [{ name: 'brief', valueType: 'string' as const, required: true }] } };
        expect(readTriggerThen(keptTarget, undefined, { brief: 'Retained' })).toEqual({
            kind: 'kept', target: keptTarget, inputs: { brief: 'Retained' },
        });
    });

    it('writes each session kind as its lifecycle events on this session, and a weekly schedule as its cron', () => {
        expect(buildTriggerDefinition({ when: { kind: 'turnEnds' }, enabled: true, sessionId: 'session-1' })).toEqual({
            kind: 'sessionLifecycle', enabled: true, sourceSessionId: 'session-1',
            events: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'], policy: { kind: 'everyMatch' },
        });
        expect(buildTriggerDefinition({ when: { kind: 'sessionArchived' }, enabled: false, sessionId: 'session-1' }))
            .toMatchObject({ events: ['sessionArchived'], enabled: false });
        const weekly = buildTriggerDefinition({
            when: { kind: 'schedule', schedule: { repeat: 'weekly', hour: 2, minute: 30, day: 3 }, expression: '', timezone: 'Europe/Zurich' },
            enabled: true,
            sessionId: null,
        });
        expect(weekly).toEqual({ kind: 'schedule', enabled: true, schedule: { kind: 'cron', scheduleExpr: '30 2 * * 3', everyMs: null, timezone: 'Europe/Zurich' } });
        // A session kind needs its session.
        expect(buildTriggerDefinition({ when: { kind: 'needsYou' }, enabled: true, sessionId: null })).toBeNull();
    });

    it('reads a saved trigger back as the When it was written with', () => {
        const archived = { kind: 'sessionLifecycle', events: ['sessionArchived'] } as unknown as Parameters<typeof readTriggerWhen>[0];
        expect(readTriggerWhen(archived)).toEqual({ kind: 'sessionArchived' });
        const custom = { kind: 'schedule', schedule: { kind: 'cron', scheduleExpr: '*/15 * * * *', everyMs: null, timezone: null } } as unknown as Parameters<typeof readTriggerWhen>[0];
        // A cron that is not a simple schedule keeps its expression.
        expect(readTriggerWhen(custom)).toEqual({ kind: 'schedule', schedule: null, expression: '*/15 * * * *', timezone: null });
    });

    it.each([null, 'viewed-session'])('keeps a retained lifecycle source independent of the editor context %s', async sessionId => {
        const { WorkflowTriggerSetV1Schema } = await import('@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1');
        const trigger = WorkflowTriggerSetV1Schema.parse({ automationId: 'habit', revision: 1, enabled: true,
            health: 'available', target: { kind: 'workflow', ref: 'builtin:review-and-converge' },
            triggers: [{ id: 'event', revision: 1, kind: 'sessionLifecycle', enabled: true,
                sourceSessionId: 'original-source', events: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'],
                policy: { kind: 'currentTurn', sourceTurnId: 'turn-7' }, createdAt: 1, updatedAt: 1,
                remainingOccurrences: 1, status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: null }] }).triggers[0]!;
        const when = readTriggerWhen(trigger);
        if (!when) throw new Error('Expected editable lifecycle');
        expect(buildTriggerDefinition({ when, enabled: false, sessionId })).toEqual({
            kind: 'sessionLifecycle', enabled: false, sourceSessionId: 'original-source',
            events: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'],
            policy: { kind: 'currentTurn', sourceTurnId: 'turn-7' },
        });
    });

    it('keeps an interval schedule ("Every hour") editable: it reads back and is written back as the same interval', () => {
        const hourly = { kind: 'schedule', schedule: { kind: 'interval', scheduleExpr: null, everyMs: 3_600_000, timezone: 'Europe/Zurich' } } as unknown as Parameters<typeof readTriggerWhen>[0];
        const when = readTriggerWhen(hourly);
        expect(when).toEqual({ kind: 'schedule', schedule: null, expression: '', everyMs: 3_600_000, timezone: 'Europe/Zurich' });
        expect(buildTriggerDefinition({ when: when!, enabled: false, sessionId: null })).toEqual({
            kind: 'schedule',
            enabled: false,
            schedule: { kind: 'interval', scheduleExpr: null, everyMs: 3_600_000, timezone: 'Europe/Zurich' },
        });
    });

    it('writes Do an action as one Action step with literal fields, and reads it back', () => {
        const target = buildTriggerTarget({ kind: 'doAction', actionId: 'session.message.send', input: { message: 'Status?', empty: '' } });
        if (target?.kind !== 'inline') throw new Error('expected an inline target');
        expect(target.definition.blocks[0]).toMatchObject({
            kind: 'action', actionId: 'session.message.send', input: { message: { kind: 'literal', value: 'Status?' } },
        });
        // An empty field is not written as a value.
        expect(target.definition.blocks[0]?.kind === 'action' ? Object.keys(target.definition.blocks[0].input) : null).toEqual(['message']);
        expect(readTriggerThen(target)).toEqual({ kind: 'doAction', actionId: 'session.message.send', input: { message: 'Status?' } });
        expect(buildTriggerTarget({ kind: 'doAction', actionId: null, input: {} })).toBeNull();
    });

    it('sends an Account prompt where Runs in says: a new session, a chosen session, or a background run', () => {
        const existing = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Triage', runsIn: { kind: 'session', sessionId: 's-1', machineId: 'm-1' } }, 'account');
        if (existing?.kind !== 'inline') throw new Error('expected an inline target');
        expect(existing.definition.defaults.conversation).toEqual({ kind: 'existing_session', sessionId: 's-1', machineId: 'm-1' });
        expect(readTriggerThen(existing)).toMatchObject({ runsIn: { kind: 'session', sessionId: 's-1', machineId: 'm-1' } });

        const background = { kind: 'sendPrompt', prompt: 'Triage', runsIn: { kind: 'backgroundRun' }, selection } as const;
        expect(buildTriggerExecutionTarget(background)).toEqual({ kind: 'detached_run' });
        const written = buildTriggerTarget(background, 'account');
        if (written?.kind !== 'inline') throw new Error('expected an inline target');
        expect(readTriggerThen(written, { kind: 'detached_run' })).toMatchObject({ runsIn: { kind: 'backgroundRun' } });
        expect(buildTriggerExecutionTarget({ kind: 'sendPrompt', prompt: 'x' })).toEqual({ kind: 'session' });
    });

    it('binds "When this turn finishes…" to that exact turn, and keeps the binding when read back', () => {
        const bound = buildTriggerDefinition({ when: { kind: 'turnEnds', sourceTurnId: 'turn-7' }, enabled: true, sessionId: 'session-1' });
        expect(bound).toMatchObject({ kind: 'sessionLifecycle', policy: { kind: 'currentTurn', sourceTurnId: 'turn-7' } });
        const saved = { kind: 'sessionLifecycle', events: ['parentTurnCompleted'], policy: { kind: 'currentTurn', sourceTurnId: 'turn-7' } } as unknown as Parameters<typeof readTriggerWhen>[0];
        expect(readTriggerWhen(saved)).toEqual({ kind: 'turnEnds', sourceTurnId: 'turn-7' });
    });
});
