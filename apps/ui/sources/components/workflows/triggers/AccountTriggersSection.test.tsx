import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable,
    publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { Modal } from '@/modal';
import { TriggerRunsOnRow } from './TriggerRunsOnRow';

// The Account Action transport and portal are system boundaries. Keep the store, form and writers real.
const transport = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const routeState = vi.hoisted(() => ({ params: {} as Record<string, string> }));
const confirm = vi.hoisted(() => vi.fn(async () => false));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>(),
    createFrontDoorActionExecute: () => transport,
}));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { confirm } }).module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
    .createExpoRouterMock({ params: () => routeState.params, router: { push: routerPush } }).module);
vi.mock('@/components/ui/popover', () => ({
    Popover: ({ children }: { children: (size: { maxHeight: number }) => React.ReactNode }) => children({ maxHeight: 640 }),
}));

const { AccountTriggersSection } = await import('./AccountTriggersSection');
const project = { machineId: 'm1', directory: '/repo' };
function trigger(id: string, hour = 9) {
    return { id, revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'schedule',
        triggerDefinitionEnvelope: null, nextRunAt: null,
        schedule: { kind: 'cron', scheduleExpr: `0 ${hour} * * *`, everyMs: null, timezone: null } };
}
function fixture(legacy = false, triggers = [trigger('t1')]) {
    return WorkflowTriggerSetV1Schema.parse({ automationId: 'digest', revision: 1, enabled: true,
        health: 'available', project, ...(legacy ? { legacy: { editable: false, reason: 'created_in_0_2' } } : {}),
        target: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'step', id: 'first',
            document: { text: 'Morning digest', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
        triggers });
}
let previous = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
beforeEach(() => {
    previous = storage.getState();
    previousSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' },
        workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {} });
    publishAppliedActiveServerSnapshot({ ...previousSnapshot, serverId: 'server-a', serverUrl: 'https://account-trigger.test' });
    transport.mockReset();
    routerPush.mockReset();
    routeState.params = {};
    confirm.mockReset().mockResolvedValue(false);
    vi.mocked(Modal.alert).mockClear();
});
afterEach(() => {
    standardCleanup();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.setState(previous);
    publishAppliedActiveServerSnapshot(previousSnapshot, previousRuntimeAvailable);
});
function serve(set: ReturnType<typeof fixture>) {
    transport.mockImplementation(async (action: string) => action === 'workflow.trigger.list'
        ? { ok: true, result: { sets: [set] } }
        : action === 'workflow.definition.list'
            ? { ok: true, result: { definitions: [], nextCursor: null } }
            : { ok: true, result: { set: { ...set, revision: 2 } } });
}
function writes() { return transport.mock.calls.filter(([id]) => id === 'workflow.trigger.update').map(([, input]) => input); }

describe('Account trigger editing', () => {
    it('leaves the trigger count unknown until the first read succeeds', async () => {
        const read = createDeferred<unknown>();
        transport.mockImplementation(async (action: string) => action === 'workflow.trigger.list' ? read.promise
            : { ok: true, result: { definitions: [], nextCursor: null } });
        const screen = await renderScreen(<AccountTriggersSection />);
        const headingText = () => screen.findByTestId('workflows-column:group:triggers')!
            .findAll(node => typeof node.type === 'string')
            .flatMap(node => node.children.filter(child => typeof child === 'string' || typeof child === 'number').map(String));
        expect(screen.findByTestId('account-triggers-read')).not.toBeNull();
        expect(headingText()).not.toContain('0');
        await act(async () => read.resolve({ ok: true, result: { sets: [fixture()] } }));
        expect(headingText()).toContain('1');
        expect(screen.findByTestId('account-triggers-read')).toBeNull();
    });
    it.each([true, false])('keeps a retained encrypted trigger paused until its device review is explicitly saved (trigger enabled: %s)', async (triggerEnabled) => {
        const retained = fixture(true, [{ ...trigger('t1'), enabled: triggerEnabled }]);
        const paused = WorkflowTriggerSetV1Schema.parse({ ...retained, enabled: false,
            health: 'source_unavailable', target: undefined,
            legacy: { editable: false, reason: 'created_in_0_2', lockedReason: 'review_required' } });
        const target = fixture().target;
        const reviewed = WorkflowTriggerSetV1Schema.parse({ ...retained, enabled: false,
            legacy: paused.legacy, placements: [project, { machineId: 'm2', directory: '/repo' }],
            context: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
                inlineDefinition: target?.kind === 'inline' ? target.definition : undefined } });
        transport.mockImplementation(async (action: string, input: Record<string, unknown>) => action === 'workflow.trigger.list'
            ? { ok: true, result: { sets: [input.review === true ? reviewed : paused] } }
            : action === 'workflow.definition.list' ? { ok: true, result: { definitions: [], nextCursor: null } }
                : { ok: true, result: { set: { ...fixture(), revision: 2 } } });
        const screen = await renderScreen(<AccountTriggersSection />);
        const toggle = screen.findByTestId('workflows-column:trigger:digest-switch');
        expect(toggle?.props.value).toBe(false);
        expect(toggle?.props.disabled).toBe(true);
        expect(transport.mock.calls.filter(([, input]) => input?.review === true)).toHaveLength(0);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        expect(transport.mock.calls.filter(([, input]) => input?.review === true).map(([, input]) => input))
            .toEqual([{ automationId: 'digest', review: true }]);
        expect(writes()).toHaveLength(0);
        expect(storage.getState().workflowTriggerSetsById['digest']).toMatchObject({
            enabled: false, health: 'source_unavailable', legacy: { lockedReason: 'review_required' },
        });
        expect(storage.getState().workflowTriggerSetsById['digest']?.target).toBeUndefined();
        expect(screen.findByTestId('workflows-column-trigger-popover-toggle')).toBeNull();
        expect(screen.findByTestId('workflows-column-trigger-popover-run-now')).toBeNull();
        await act(async () => screen.changeTextByTestId('workflows-column-trigger-popover-prompt', 'Reviewed prompt'));
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        expect(writes()).toMatchObject([{ automationId: 'digest', expectedRevision: 1, confirmLegacyConversion: true,
            patch: { enabled: triggerEnabled, target: { kind: 'inline', definition: { blocks: [{ document: { text: 'Reviewed prompt' } }] } } } }]);
    });
    it('keeps a failed retained-template review locked and performs no workflow write', async () => {
        const paused = WorkflowTriggerSetV1Schema.parse({ ...fixture(true), enabled: false,
            health: 'source_unavailable', target: undefined,
            legacy: { editable: false, reason: 'created_in_0_2', lockedReason: 'review_required' } });
        transport.mockImplementation(async (action: string, input: Record<string, unknown>) => action === 'workflow.trigger.list'
            ? input.review === true ? { ok: false, errorCode: 'content_unavailable', error: 'Locked' }
                : { ok: true, result: { sets: [paused] } }
            : action === 'workflow.trigger.remove' ? { ok: true, result: { set: { ...paused, revision: 2, triggers: [] } } }
                : { ok: true, result: { definitions: [], nextCursor: null } });
        const screen = await renderScreen(<AccountTriggersSection />);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        expect(writes()).toHaveLength(0);
        expect(screen.findByTestId('workflows-column-trigger-popover')).toBeNull();
        expect(screen.findByTestId('workflows-column:trigger:digest')).not.toBeNull();
        expect(vi.mocked(Modal.alert)).toHaveBeenCalled();
        const remove = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]?.find((button) => button.style === 'destructive');
        expect(remove).toBeDefined();
        await act(async () => remove?.onPress?.());
        expect(transport.mock.calls.filter(([id]) => id === 'workflow.trigger.remove').map(([, input]) => input))
            .toEqual([{ automationId: 'digest', triggerId: 't1' }]);
        expect(storage.getState().workflowTriggerSetsById.digest?.triggers).toEqual([]);
        expect(writes()).toHaveLength(0);
    });
    it('reserves no blank status slot around retained rows, and states a failed refresh under them', async () => {
        const set = fixture();
        storage.getState().upsertWorkflowTriggerSet({ queryKey: 'account_inline', set });
        const read = createDeferred<unknown>();
        transport.mockImplementation(async (action: string) => action === 'workflow.trigger.list' ? read.promise
            : { ok: true, result: { definitions: [], nextCursor: null } });
        const screen = await renderScreen(<AccountTriggersSection />);
        // Refreshing retained rows says nothing: no reserved line, no status above the rows.
        expect(screen.findByTestId('account-triggers-read-slot')).toBeNull();
        expect(screen.findByTestId('account-triggers-read')).toBeNull();
        expect(screen.findByTestId('workflows-column:trigger:digest')).not.toBeNull();
        await act(async () => read.resolve({ ok: false, errorCode: 'unavailable', error: 'Down' }));
        expect(screen.findByTestId('workflows-column:trigger:digest')).not.toBeNull();
        const text = screen.getTextContent();
        expect(text.indexOf('workflows.triggers.section.accountLoadFailed')).toBeGreaterThan(text.indexOf('Morning digest'));
    });
    it('reads a column trigger as "{when}" over what it runs, led by its event glyph', async () => {
        serve(fixture());
        const screen = await renderScreen(<AccountTriggersSection />);
        const text = screen.getTextContent();
        // The person's display locale owns the clock format, not the editor's 24-hour input.
        const whenAt = text.indexOf('workflows.triggers.summary.everyDayAt(');
        expect(whenAt).toBeGreaterThanOrEqual(0);
        expect(whenAt).toBeLessThan(text.indexOf('Morning digest'));
        expect(screen.findAll((node) => node.props.name === 'clock').length).toBeGreaterThan(0);
    });
    it('enables an off set through one selected-trigger Action instead of first enabling every schedule', async () => {
        const set = { ...fixture(false, [trigger('t1'), trigger('t2', 19)]), enabled: false }; serve(set);
        const screen = await renderScreen(<AccountTriggersSection />);
        await act(async () => screen.findByTestId('workflows-column:trigger:digest:t2-switch')?.props.onValueChange(true));
        expect(writes()).toEqual([{ automationId: 'digest', triggerId: 't2', expectedRevision: 1, patch: { enabled: true } }]);
    });
    it('removes only the reviewed locked schedule without converting its legacy template', async () => {
        const set = WorkflowTriggerSetV1Schema.parse({ ...fixture(true, [trigger('t1'), trigger('t2', 19)]),
            health: 'source_unavailable', target: undefined,
            legacy: { editable: false, reason: 'created_in_0_2', lockedReason: 'session_key_required' } });
        serve(set);
        const screen = await renderScreen(<AccountTriggersSection />);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest:t2');
        expect(writes()).toHaveLength(0);
        const remove = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]?.find((button) => button.style === 'destructive');
        expect(remove).toBeDefined();
        await act(async () => remove?.onPress?.());
        expect(transport.mock.calls.filter(([id]) => id === 'workflow.trigger.remove').map(([, input]) => input))
            .toEqual([{ automationId: 'digest', triggerId: 't2' }]);
        expect(writes()).toHaveLength(0);
    });
    it('reviews legacy toggles before converting and keeps a cancelled change untouched', async () => {
        const set = fixture(true); serve(set);
        const screen = await renderScreen(<AccountTriggersSection />);
        const toggle = screen.findByTestId('workflows-column:trigger:digest-switch');
        await act(async () => toggle?.props.onValueChange(false));
        expect(writes()).toHaveLength(0);
        expect(confirm).toHaveBeenCalledWith('workflows.triggers.legacy.editNotice', 'workflows.triggers.legacy.conversionBoundary', {
            confirmText: 'workflows.triggers.popover.turnOff',
        });
        confirm.mockResolvedValueOnce(true);
        await act(async () => toggle?.props.onValueChange(false));
        expect(writes()).toEqual([{ automationId: 'digest', triggerId: 't1', expectedRevision: 1, patch: { enabled: false } }]);
    });
    it('toggles the trigger through its Action and edits Runs on through the same writer', async () => {
        const set = fixture(); serve(set);
        const screen = await renderScreen(<AccountTriggersSection />);
        const toggle = screen.findByTestId('workflows-column:trigger:digest-switch');
        expect(toggle).not.toBeNull();
        await act(async () => toggle?.props.onValueChange(false));
        expect(writes()).toContainEqual({ automationId: 'digest', triggerId: 't1', expectedRevision: 1, patch: { enabled: false } });
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        const runsOn = screen.findAllByType(TriggerRunsOnRow)[0];
        expect(runsOn).toBeDefined();
        await act(async () => runsOn?.props.onChange({ machineId: 'm2', directory: '/elsewhere' }));
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        expect(writes().at(-1)).toMatchObject({ patch: { project: { machineId: 'm2', directory: '/elsewhere' } } });
    });

    it('edits the selected schedule of a multi-trigger legacy set with conversion disclosed and refusal preserving the draft', async () => {
        const set = fixture(true, [trigger('t1'), trigger('t2', 19)]); serve(set);
        const screen = await renderScreen(<AccountTriggersSection />);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest:t2');
        expect(writes()).toEqual([]);
        expect(screen.getTextContent()).toContain('workflows.triggers.legacy.editNotice');
        expect(screen.getTextContent()).toContain('workflows.triggers.legacy.conversionBoundary');
        expect(screen.findAll((node) => node.props.accessibilityLabel === 'workflows.triggers.popover.at'
            && node.props.value === '19:00').length).toBeGreaterThan(0);
        await act(async () => screen.changeTextByTestId('workflows-column-trigger-popover-prompt', 'Changed prompt'));
        transport.mockImplementation(async (action: string) => action === 'workflow.trigger.update'
            ? { ok: false, errorCode: 'legacy_conversion_unsupported', error: 'Refused', details: { reason: 'channel_reply_handoff' } }
            : { ok: true, result: { sets: [set] } });
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        expect(writes()).toMatchObject([{ triggerId: 't2', expectedRevision: 1,
            patch: { trigger: { kind: 'schedule', schedule: { scheduleExpr: '0 19 * * *' } },
                target: { definition: { blocks: [{ document: { text: 'Changed prompt' } }] } } } }]);
        expect(screen.findByTestId('workflows-column-trigger-popover-prompt')?.props.value).toBe('Changed prompt');
        expect(screen.getTextContent()).toContain('workflows.triggers.legacy.channelReplyRefusal');
        expect(storage.getState().workflowTriggerSetsById.digest?.revision).toBe(1);
    });

    it('keeps a manual legacy row manual when its prompt is edited', async () => {
        const set = fixture(true, []); serve(set);
        const screen = await renderScreen(<AccountTriggersSection />);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        expect(screen.findByTestId('workflows-column-trigger-popover-run-now')).not.toBeNull();
        await act(async () => screen.changeTextByTestId('workflows-column-trigger-popover-prompt', 'Manual edit'));
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        expect(writes()).toHaveLength(1);
        expect(writes()[0]).not.toHaveProperty('triggerId');
        expect(writes()[0].patch).not.toHaveProperty('trigger');
    });
    it('opens a legacy deep link without writing and retains an opened draft across refreshes', async () => {
        const set = fixture(true); serve(set);
        routeState.params = { trigger: 'digest' };
        const screen = await renderScreen(<AccountTriggersSection />);
        expect(screen.findByTestId('workflows-column-trigger-popover-prompt')).not.toBeNull();
        expect(writes()).toHaveLength(0);
        await act(async () => screen.changeTextByTestId('workflows-column-trigger-popover-prompt', 'My draft'));
        await act(async () => storage.getState().upsertWorkflowTriggerSet({ queryKey: 'account_inline', set: { ...set, revision: 3 } }));
        transport.mockImplementation(async (action: string) => action === 'workflow.trigger.update'
            ? { ok: false, errorCode: 'currentness_conflict', error: 'Changed', details: { revision: 3 } }
            : { ok: true, result: { sets: [set] } });
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        expect(writes()[0]).toMatchObject({ expectedRevision: 1, patch: { target: { definition: { blocks: [{ document: { text: 'My draft' } }] } } } });
        expect(screen.findByTestId('workflows-column-trigger-popover-prompt')?.props.value).toBe('My draft');
    });
    it('saves a manual Automation as a workflow without fabricating a trigger identity', async () => {
        const set = fixture(true, []); serve(set);
        const screen = await renderScreen(<AccountTriggersSection />);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-save-as-workflow');
        expect(writes()).toHaveLength(0);
        const { readTriggerWorkflowSeed, retargetTriggerToWorkflow } = await import('./triggerWorkflowSeed');
        const seedId = routerPush.mock.calls[0]?.[0]?.params.triggerWorkflowSeedId;
        const seed = readTriggerWorkflowSeed(seedId);
        expect(seed?.retarget).not.toHaveProperty('triggerId');
        if (!seed) throw new Error('expected a reviewed draft seed');
        await act(async () => { await retargetTriggerToWorkflow(seed.retarget, '11111111-1111-4111-8111-111111111111'); });
        expect(writes()[0]).toEqual({ automationId: 'digest', expectedRevision: 1, patch: {
            target: { kind: 'workflow', ref: '11111111-1111-4111-8111-111111111111' },
        } });
    });
});
