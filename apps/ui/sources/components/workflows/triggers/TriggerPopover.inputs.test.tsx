import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { createDeferred } from '@/dev/testkit';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

const execute = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
vi.mock('@/modal', () => ({ Modal: { alert } }));
let previousProfileScope = getStorage().getState().profileScope;
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
function establishDiagnosticScope() {
    previousProfileScope = getStorage().getState().profileScope;
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    const snapshot = getActiveServerSnapshot();
    publishAppliedActiveServerSnapshot(snapshot);
    publishAppliedActiveServerRuntimeAvailability(true);
    getStorage().setState({ profileScope: { serverId: snapshot.serverId, accountId: 'account-a' } });
}
// The Action transport is a boundary; the library, scope and exact reader stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...actual, createFrontDoorActionExecute: () => execute,
        createFrontDoorUiActionExecutor: () => actual.createFrontDoorUiActionExecutor({ execute }) };
});
afterEach(async () => {
    standardCleanup();
    (await import('../library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    execute.mockReset();
    alert.mockReset();
    getStorage().setState({ profileScope: previousProfileScope });
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot);
    publishAppliedActiveServerRuntimeAvailability(previousRuntimeAvailable);
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// The portal is a platform boundary; keep the trigger form and its typed fields real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 280, placement: 'bottom' });
});

const { TriggerPopover } = await import('./TriggerPopover');
const { WorkflowTriggerSection } = await import('./WorkflowTriggerSection');
const { WorkflowDefinitionV1Schema } = await import('@happier-dev/protocol');
type ExistingTriggerSubmit = Extract<React.ComponentProps<typeof TriggerPopover>, { creatingSession?: false }>['onSubmit'];

describe('Run a workflow trigger inputs', () => {
    it('pushes the event step in the same surface and returns without losing the parent draft', async () => {
        const screen = await renderScreen(<TriggerPopover testID="event-step" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['pluginEvent']} sessionId={null}
            initial={{ when: { kind: 'pluginEvent', value: null }, enabled: true,
                then: { kind: 'notifyMe', title: '', message: 'Keep my draft', channels: [] } }}
            workflowOptions={[]} onSubmit={vi.fn<ExistingTriggerSubmit>(async () => {})} />);
        await act(async () => { screen.findByProps({ accessibilityLabel: 'workflows.triggers.then.message', value: 'Keep my draft' })
            .props.onChangeText('Edited draft'); });
        await act(async () => { screen.findByProps({ accessibilityLabel: 'workflows.triggers.then.message', value: 'Edited draft' })
            .props.onBlur(); });
        await screen.pressByTestIdAsync('event-step-configure-event');
        expect(screen.findByTestId('event-step-then')).toBeNull();
        expect(screen.findByTestId('event-step-submit')).toBeNull();
        expect(screen.findByTestId('automation-plugin-event-done')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('automation-plugin-event-cancel');
        expect(screen.findByTestId('event-step-then')).not.toBeNull();
        expect(screen.findByProps({ accessibilityLabel: 'workflows.triggers.then.message', value: 'Edited draft' })).toBeTruthy();
    });
    it('opens an exact saved Event row for editing its private source instead of leaving it informational', async () => {
        const { WorkflowTriggerSetV1Schema } = await import('@happier-dev/protocol');
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'event-set', revision: 7, enabled: true,
            health: 'available', triggers: [{ id: 'event-row', revision: 3, enabled: true,
                createdAt: 1, updatedAt: 1, kind: 'pluginEvent', eventRef: { pluginId: 'acme.github', localId: 'issue-opened' },
                sourceSelectorId: '11111111-1111-4111-8111-111111111111', sourceContractVersion: 3,
                observation: { kind: 'socket', watcher: null }, sourceStatus: null, sourceCatalogStatus: null,
                triggerDefinitionEnvelope: 'sealed-private' }] });
        const screen = await renderScreen(<WorkflowTriggerSection testIDPrefix="event-workflow" set={set}
            draft={{ adds: [], updates: {}, removes: [] }} onChangeDraft={vi.fn()} status="ready" onRetry={vi.fn()}
            runsOn={null} stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} />);
        await screen.pressByTestIdAsync('event-workflow-trigger:saved:event-row');
        expect(screen.findByTestId('event-workflow-trigger-popover-configure-event')).toBeTruthy();
    });
    it('turns off a newly authored Event row without discarding its configured source', async () => {
        const { AutomationTriggerDefinitionInputSchema } = await import('@happier-dev/protocol/automations/automationTriggerDefinition');
        const trigger = AutomationTriggerDefinitionInputSchema.parse({ kind: 'pluginEvent', enabled: true,
            eventRef: { pluginId: 'acme.github', localId: 'issue-opened' }, sourceInstanceId: 'repository:42',
            sourceContractVersion: 3, sourceConfig: { repository: 'acme/widgets' }, displayLabel: 'acme/widgets',
            filter: null, maximumObservationAgeMs: null, observationTransport: { kind: 'checkpointedPull',
                watcherMaterializationRef: { machineId: 'machine-1', pluginId: 'acme.github', materializationId: 'github-1' } } });
        const change = vi.fn();
        const screen = await renderScreen(<WorkflowTriggerSection testIDPrefix="event-workflow" set={null}
            draft={{ adds: [{ clientId: 'event-draft', trigger }], updates: {}, removes: [] }} onChangeDraft={change}
            status="ready" onRetry={vi.fn()} runsOn={null} stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} />);
        await screen.pressByTestIdAsync('event-workflow-trigger:new:event-draft');
        expect(screen.findByTestId('event-workflow-trigger-popover-toggle')).toBeNull();
        await act(async () => { screen.findByTestId('event-workflow-trigger:new:event-draft-switch')!.props.onValueChange(false); });
        expect(change).toHaveBeenCalledWith({ adds: [{ clientId: 'event-draft', trigger: { ...trigger, enabled: false } }],
            updates: {}, removes: [] });
    });
    it.each([
        ['matched', { action: 'opened' }, 'repository:42', 100, null],
        ['noMatch', { action: 'closed' }, 'repository:42', 100, null],
        ['sourceMismatch', { action: 'opened' }, 'repository:99', 100, null],
        ['sourceMismatch', { action: 'opened' }, 'repository:42', 100, null, 'other-event', 3],
        ['sourceMismatch', { action: 'opened' }, 'repository:42', 100, null, 'issue-opened', 4],
        ['tooOld', { action: 'opened' }, 'repository:42', 200, 50],
    ] as const)('tests a configured trigger against real retained event evidence: %s', async (result, payload, sourceInstanceId, observationReceivedAt, maximumObservationAgeMs, eventLocalId = 'issue-opened', sourceContractVersion = 3) => {
        establishDiagnosticScope();
        const { createActionExecutor } = await import('@happier-dev/protocol');
        const executor = createActionExecutor({});
        execute.mockImplementation((actionId, input, context) => executor.execute(actionId, input, context));
        const { AutomationTriggerDefinitionInputSchema } = await import('@happier-dev/protocol/automations/automationTriggerDefinition');
        const { AutomationRunPluginEventTriggerEvidenceV1Schema } = await import('@happier-dev/protocol/automations/automationRunExecutionRecipeV1');
        const value = AutomationTriggerDefinitionInputSchema.parse({
            kind: 'pluginEvent', enabled: true, eventRef: { pluginId: 'acme.github', localId: 'issue-opened' },
            sourceInstanceId: 'repository:42', sourceContractVersion: 3, sourceConfig: { repository: 'acme/widgets' },
            displayLabel: 'acme/widgets', filter: { v: 1, all: [{ field: '/action', op: 'eq', value: 'opened' }] },
            maximumObservationAgeMs,
            observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
                machineId: 'machine-1', pluginId: 'acme.github', materializationId: 'github-1',
            } },
        });
        if (value.kind !== 'pluginEvent' || !('sourceInstanceId' in value)) throw new Error('expected a configured event');
        const activityEvent = AutomationRunPluginEventTriggerEvidenceV1Schema.parse({
            v: 1, kind: 'pluginEvent', eventRef: { ...value.eventRef, localId: eventLocalId }, sourceSelectorId: '11111111-1111-4111-8111-111111111111',
            occurrenceId: 'github-delivery-1', occurredAt: 100, sourceInstanceId, sourceContractVersion,
            observationReceivedAt, payload, filter: { version: 1, result: 'matched' },
        });
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="event-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['pluginEvent']} sessionId={null} activityEvent={activityEvent}
            initial={{ when: { kind: 'pluginEvent', value }, enabled: true, then: { kind: 'notifyMe', title: '', message: 'Issue opened', channels: [] } }}
            workflowOptions={[]} onSubmit={submit} />);
        await screen.pressByTestIdAsync('event-trigger-test');
        expect(screen.findByTestId('event-trigger-test-result')?.props.children)
            .toBe(`workflows.triggers.activity.${result}`);
        expect(execute).toHaveBeenCalledWith('workflow.trigger.test', {
            trigger: { eventRef: value.eventRef, sourceInstanceId: value.sourceInstanceId,
                sourceContractVersion: value.sourceContractVersion, filter: value.filter, maximumObservationAgeMs },
            observation: { eventRef: activityEvent.eventRef, sourceInstanceId, sourceContractVersion,
                occurredAt: activityEvent.occurredAt, observationReceivedAt, payload },
        }, expect.objectContaining({ surface: 'ui', runtimeAccountId: 'account-a' }));
        expect(submit).not.toHaveBeenCalled();
    });
    it.each(['transportError', 'changedDraft', 'changedAccount'] as const)(
        'does not publish a diagnostic for %s', async (change) => {
            establishDiagnosticScope();
            const { createActionExecutor } = await import('@happier-dev/protocol');
            const { AutomationTriggerDefinitionInputSchema } = await import('@happier-dev/protocol/automations/automationTriggerDefinition');
            const { AutomationRunPluginEventTriggerEvidenceV1Schema } = await import('@happier-dev/protocol/automations/automationRunExecutionRecipeV1');
            const { TriggerPluginEventRows } = await import('./TriggerPluginEventRows');
            const value = AutomationTriggerDefinitionInputSchema.parse({ kind: 'pluginEvent', enabled: true,
                eventRef: { pluginId: 'acme.github', localId: 'issue-opened' }, sourceInstanceId: 'repository:42',
                sourceContractVersion: 3, sourceConfig: {}, displayLabel: 'acme/widgets', filter: null,
                maximumObservationAgeMs: null, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
                    machineId: 'machine-1', pluginId: 'acme.github', materializationId: 'github-1',
                } } });
            if (value.kind !== 'pluginEvent' || !('sourceInstanceId' in value)) throw new Error('expected a configured event');
            const activityEvent = AutomationRunPluginEventTriggerEvidenceV1Schema.parse({
                v: 1, kind: 'pluginEvent', eventRef: value.eventRef, sourceSelectorId: '11111111-1111-4111-8111-111111111111',
                occurrenceId: 'github-delivery-1', occurredAt: 100, sourceInstanceId: value.sourceInstanceId,
                sourceContractVersion: 3, observationReceivedAt: 100, payload: {}, filter: { version: null, result: 'matched' },
            });
            const deferred = createDeferred<void>();
            const executor = createActionExecutor({});
            execute.mockImplementation(async (actionId, input, context) => {
                const result = await executor.execute(actionId, input, context);
                await deferred.promise;
                return result;
            });
            const when = { kind: 'pluginEvent', value } as const;
            const renderRows = (nextWhen = when) => <TriggerPluginEventRows testID="pending-event"
                when={nextWhen} activityEvent={activityEvent} onChange={vi.fn()} machineId={null} serverId={null} />;
            const screen = await renderScreen(renderRows());
            await screen.pressByTestIdAsync('pending-event-test');
            expect(screen.findByTestId('pending-event-test-result')).toBeNull();
            expect(screen.findByTestId('pending-event-test')?.props.disabled).toBe(true);
            await act(async () => {
                if (change === 'changedDraft') screen.update(renderRows({ ...when, value: { ...value, maximumObservationAgeMs: 1 } }));
                if (change === 'changedAccount') {
                    const scope = getStorage().getState().profileScope;
                    if (!scope) throw new Error('expected an Account scope');
                    getStorage().setState({ profileScope: { ...scope, accountId: 'account-b' } });
                }
                if (change === 'transportError') deferred.reject(new Error('transport unavailable'));
                else deferred.resolve(undefined);
            });
            expect(screen.findByTestId('pending-event-test-result')).toBeNull();
            if (change === 'transportError') expect(alert).toHaveBeenCalledWith('common.error', expect.any(String));
            else expect(alert).not.toHaveBeenCalled();
        });
    it('points the trigger form back to its resolved anchor', async () => {
        const screen = await renderScreen(<TriggerPopover testID="anchored-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['turnEnds']} sessionId="session-1" initial={null}
            workflowOptions={[]} onSubmit={vi.fn<ExistingTriggerSubmit>(async () => {})} />);
        expect(screen.findByTestId('floating-overlay-arrow')).toBeTruthy();
    });
    it('authors a session-start trigger before session birth with a session-scoped prompt', async () => {
        const submit = vi.fn<Extract<React.ComponentProps<typeof TriggerPopover>, { creatingSession: true }>['onSubmit']>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="birth-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['sessionStarts', 'turnEnds']} sessionId={null} creatingSession
            initial={{ when: { kind: 'sessionStarts' }, enabled: true, then: { kind: 'sendPrompt', prompt: 'Prepare workspace' } }}
            workflowOptions={[]} onSubmit={submit} />);
        expect(screen.findByTestId('birth-trigger-submit')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('birth-trigger-submit');
        expect(submit.mock.calls[0]?.[1]).toMatchObject({
            trigger: { kind: 'sessionLifecycle', enabled: true, events: ['sessionStarted'], policy: { kind: 'everyMatch' } },
            target: { kind: 'inline', definition: { defaults: { conversation: { kind: 'origin_session' } } } },
        });
        expect(submit.mock.calls[0]?.[1].trigger).not.toHaveProperty('sourceSessionId');
    });
    it('keeps an example inline and validates its declared inputs before attaching the trigger', async () => {
        const { WORKFLOW_STARTER_EXAMPLES_V1 } = await import('@happier-dev/protocol');
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="example-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['turnEnds']} sessionId="session-1" initial={null}
            workflowOptions={[]} onSubmit={submit} />);
        await act(async () => { screen.findAllByType(DropdownMenu).find((menu) => menu.props.testID === 'example-trigger-then')!.props.onSelect('example'); });
        await screen.pressByTestIdAsync('workflow-examples:ask-once:use');
        expect(screen.findByTestId('example-trigger-submit')?.props.disabled).toBe(true);
        await act(async () => { screen.changeTextByTestId('example-trigger-input-request', 'Review the changes'); });
        await screen.pressByTestIdAsync('example-trigger-submit');
        expect(submit.mock.calls[0]?.[1]).toMatchObject({ target: { kind: 'inline',
            definition: WORKFLOW_STARTER_EXAMPLES_V1.find((entry) => entry.key === 'ask-once')!.definition },
            inputs: { request: 'Review the changes' } });
    });
    it('shows defaults, refuses missing or invalid inputs, and submits typed edits', async () => {
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="typed-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['turnEnds']} sessionId="session-1"
            initial={{ when: { kind: 'turnEnds' }, enabled: true,
                then: { kind: 'runWorkflow', ref: 'builtin:review-and-converge', inputs: {} } }}
            workflowOptions={[{ ref: 'builtin:review-and-converge', title: 'Review & converge' }]} onSubmit={submit} />);
        const field = (name: string) => screen.findByTestId(`typed-trigger-input-${name}`);
        expect(field('maxRounds')?.props.value).toBe('3');
        expect(screen.findByTestId('typed-trigger-submit')?.props.disabled).toBe(true);
        await act(async () => {
            screen.findAll((node) => node.props.label === 'engines' && typeof node.props.onChange === 'function')[0]?.props.onChange(['codex']);
        });
        await act(async () => { screen.changeTextByTestId('typed-trigger-input-maxRounds', '3e'); });
        expect(field('maxRounds')?.props.value).toBe('3e');
        expect(screen.findByTestId('typed-trigger-submit')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('typed-trigger-submit');
        expect(submit).not.toHaveBeenCalled();
        await act(async () => { screen.changeTextByTestId('typed-trigger-input-maxRounds', '5'); });
        expect(screen.findByTestId('typed-trigger-submit')?.props.disabled).toBe(false);
        await act(async () => {
            screen.findAll((node) => node.props.label === 'workflows.builtins.reviewAndConverge.apply'
                && typeof node.props.onChange === 'function')[0]?.props.onChange('report');
        });
        await act(async () => { screen.pressByTestId('typed-trigger-submit'); });
        expect(submit.mock.calls[0]?.[1]).toMatchObject({ target: { kind: 'workflow', ref: 'builtin:review-and-converge' },
            inputs: { engines: ['codex'], maxRounds: 5, apply: 'report', useJudge: false } });
    });

    it('keeps JSON drafts distinct from string values and preserves an explicit false input on reopen', async ({ onTestFinished }) => {
        // Plugin definition content is Account-scoped; this fixture must establish its disclosure scope.
        const previousScope = getStorage().getState().profileScope;
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const server = await runtime.upsertAndActivateServer({ serverUrl: 'http://trigger-inputs.test', name: 'Trigger inputs' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        getStorage().setState({ profileScope: { serverId: server.id, accountId: 'account-a' } });
        onTestFinished(async () => { await act(async () => {
            getStorage().setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }); });
        const definition = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, inputs: [
            { name: 'payload', valueType: 'json', required: true },
            { name: 'announce', valueType: 'boolean', required: false, default: true },
        ], blocks: [{ kind: 'step', id: 'first', document: { text: 'Review', references: [], attachments: [] },
            input: [], result: { kind: 'text' } }] });
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const ref = 'plugin:example.workflows/review';
        execute.mockResolvedValue({ ok: true, result: { definitions: [], pluginWorkflows: [
            { workflow: ref, pluginId: 'example.workflows', version: '1.0.0', title: 'Review', definition },
        ] } });
        const screen = await renderScreen(<TriggerPopover testID="json-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['turnEnds']} sessionId="session-1"
            initial={{ when: { kind: 'turnEnds' }, enabled: true,
                then: { kind: 'runWorkflow', ref, inputs: { payload: 'Saved JSON string', announce: false } } }}
            workflowOptions={[{ ref, title: 'Review' }]} onSubmit={submit} />);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(screen.findByTestId('json-trigger-input-payload')?.props.value).toBe('"Saved JSON string"');
        await act(async () => { screen.changeTextByTestId('json-trigger-input-payload', '{"unfinished":'); });
        expect(screen.findByTestId('json-trigger-input-payload')?.props.value).toBe('{"unfinished":');
        await screen.pressByTestIdAsync('json-trigger-submit');
        expect(submit).not.toHaveBeenCalled();
        await act(async () => { screen.changeTextByTestId('json-trigger-input-payload', '{"valid":true}'); });
        await screen.pressByTestIdAsync('json-trigger-submit');
        expect(submit.mock.calls[0]?.[1].inputs).toEqual({ payload: { valid: true }, announce: false });
    });
});

describe('a workflow trigger in its popover (07 S4)', () => {
    it('edits a saved interval as itself: no session copy, its repeat shown, Done writes the same interval', async () => {
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="wf-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule']} sessionId={null} showThen={false}
            initial={{ when: { kind: 'schedule', schedule: null, expression: '', everyMs: 3_600_000, timezone: 'Europe/Zurich' },
                then: { kind: 'runWorkflow', ref: null, inputs: {} }, enabled: true }}
            workflowOptions={[]} onSubmit={submit} onDelete={vi.fn(async () => {})} />);
        // "Continues this session on a schedule" is a session trigger's description, not a workflow's.
        expect(screen.getTextContent()).not.toContain('workflows.triggers.kindDescription.schedule');
        // The interval reads as its own repeat, not as an empty schedule field.
        expect(screen.findByTestId('wf-trigger-repeat:interval')).not.toBeNull();
        expect(screen.findByTestId('wf-trigger-expression')).toBeNull();
        await screen.pressByTestIdAsync('wf-trigger-submit');
        expect(submit.mock.calls[0]?.[1].trigger).toEqual({
            kind: 'schedule', enabled: true,
            schedule: { kind: 'interval', scheduleExpr: null, everyMs: 3_600_000, timezone: 'Europe/Zurich' },
        });
    });
});
