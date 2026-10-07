import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

const execute = vi.hoisted(() => vi.fn());
// The Action transport is a boundary; the library, scope and exact reader stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
afterEach(async () => {
    standardCleanup();
    (await import('../library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    execute.mockReset();
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
const { WorkflowDefinitionV1Schema } = await import('@happier-dev/protocol');
type ExistingTriggerSubmit = Extract<React.ComponentProps<typeof TriggerPopover>, { creatingSession?: false }>['onSubmit'];

describe('Run a workflow trigger inputs', () => {
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
            workflowOptions={[]} onSubmit={submit} onToggleEnabled={vi.fn(async () => {})} onDelete={vi.fn(async () => {})} />);
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
