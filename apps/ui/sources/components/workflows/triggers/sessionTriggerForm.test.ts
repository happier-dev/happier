import { describe, expect, it } from 'vitest';

import {
    buildTriggerDefinition,
    buildTriggerExecutionTarget,
    buildTriggerTarget,
    createDefaultWhen,
    readTriggerThen,
    readTriggerWhen,
} from './sessionTriggerForm';

describe('session trigger form', () => {
    it('keeps an inputless predecessor Session start intact when reviewing its trigger', () => {
        const target = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'seed' }, 'account');
        if (target?.kind !== 'inline') throw new Error('expected an inline target');
        const inputless = { ...target, definition: { ...target.definition,
            blocks: target.definition.blocks.map((block) => block.kind === 'step'
                ? { ...block, inputMode: 'none' as const, document: { ...block.document, text: '' } } : block) } };
        const then = readTriggerThen(inputless);
        expect(then.kind).toBe('kept');
        expect(buildTriggerTarget(then, 'account')).toEqual(inputless);
    });
    it('preserves the exact retained prompt when Save changes only the trigger configuration', () => {
        const target = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'seed' }, 'account');
        if (target?.kind !== 'inline') throw new Error('expected an inline target');
        const retained = { ...target, definition: { ...target.definition,
            blocks: target.definition.blocks.map((block) => block.kind === 'step'
                ? { ...block, document: { ...block.document, text: '  retain this prompt\n' } } : block) } };
        const then = readTriggerThen(retained);
        expect(buildTriggerTarget(then, 'account')).toEqual(retained);
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
        const created = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Before' }, 'account');
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
        const account = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Morning digest' }, 'account');
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

        const background = { kind: 'sendPrompt', prompt: 'Triage', runsIn: { kind: 'backgroundRun' } } as const;
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
