import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { reportCollectionLayout } from '@/dev/testkit/harness/collectionLayoutHarness';
import { act } from 'react-test-renderer';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineActivityForTest } from '@/dev/testkit/harness/machinePresence';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';

const machineRpc = vi.fn<(request: SocketRpcRequestPayload) => unknown>();
// Home and machine transports enter through static imports; hoist the genuine
// Socket.IO SDK boundary before those owners, then configure its replies below.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// Trigger inputs never stream Markdown; retain only the genuine vendor SDK leaf.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in trigger-input test'); },
}));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// Radix is the DOM SDK boundary; the modal provider, manager and alert remain real.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installSessionActionRpcBoundary(request => machineRpc(request));
await import('@/sync/syncEngine');
const { ModalProvider } = await import('@/modal');
const { WebAlertModal } = await import('@/modal/components/WebAlertModal');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { matchesHappierMenuQuery } = await import('@happier-dev/plugin-ui/presentation');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
let disposeLoader: (() => void) | undefined;
let serverId: string;
let previousState = getStorage().getState();
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
    previousState = getStorage().getState();
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    disposeLoader = await installRealActionExecutorModuleLoader();
    serverId = await home.addHome({ name: 'Trigger inputs', serverUrl: `https://trigger-inputs-${crypto.randomUUID()}.test`, accountId: 'account-a' });
    // The real scoped RPC pool proves reachability through runtimeFetch before
    // connecting Socket.IO; it must use this same Home's HTTP boundary too.
    home.answer(serverId, '/v1/auth/ping', { body: { ok: true } });
    setRuntimeFetch(home.request);
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const snapshot = getActiveServerSnapshot();
    publishAppliedActiveServerSnapshot(snapshot);
    publishAppliedActiveServerRuntimeAvailability(true);
    getStorage().setState({ profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' } });
});
afterEach(async () => {
    setScreenSharingPrivacyActive(false);
    await standardCleanup();
    await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
    (await import('../library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    (await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs')).clearDaemonMergedProjectionCacheForTests();
    machineRpc.mockReset();
    resetRuntimeFetch();
    await home.reset();
    disposeLoader?.();
    disposeLoader = undefined;
    getStorage().setState(previousState);
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

const { TriggerPopover, FieldSelect } = await import('./TriggerPopover');
const { WorkflowTriggerSection } = await import('./WorkflowTriggerSection');
const { WorkflowDefinitionV1Schema} = await import('@happier-dev/protocol/workflows/workflowV1');
type ExistingTriggerSubmit = Extract<React.ComponentProps<typeof TriggerPopover>, { creatingSession?: false }>['onSubmit'];
type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;
/** The trigger's on/off switch, as a person flips it. */
async function toggleTrigger(screen: RenderedScreen, testID: string) {
    const toggle = screen.findAll(node => node.props.testID === `${testID}-toggle` && typeof node.props.onValueChange === 'function')[0]!;
    await act(async () => { toggle.props.onValueChange(!toggle.props.value); });
}
type MenuItems = readonly { id: string; title: string; testID?: string }[];
/** "…" → Remove, through the block's menu (its rows live in a portal outside the test tree). */
async function removeTrigger(screen: RenderedScreen, testID: string) {
    const menu = screen.findAllByType(DropdownMenu).find(node => (node.props.items as MenuItems)
        .some(item => item.testID === `${testID}-more-remove`))!;
    await act(async () => { menu.props.onSelect('remove'); });
}
const addMenu = (screen: RenderedScreen, prefix: string) =>
    screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${prefix}-triggers-add-menu`)!;
/** Add a trigger → a start from the menu. */
async function addTrigger(screen: RenderedScreen, prefix: string, startId: string) {
    await act(async () => { addMenu(screen, prefix).props.onOpenChange(true); });
    await act(async () => { addMenu(screen, prefix).props.onSelect(startId); });
}
const DAILY_TRIGGER = { kind: 'schedule' as const, enabled: true,
    schedule: { kind: 'cron' as const, scheduleExpr: '0 9 * * *', everyMs: null, timezone: 'Europe/Zurich' } };

describe('Run a workflow trigger inputs', () => {
    it('saves one local date/time or a relative delay as one absolute occurrence and reopens it unchanged', async () => {
        const { LocalDateTimeEditor } = await import('@/components/ui/dateTime/LocalDateTimeEditor');
        const { FieldValueItem } = await import('@/components/ui/forms/FieldValueItem');
        const { readScheduleWhen } = await import('./sessionTriggerForm');
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="once-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule']} sessionId={null} showThen={false}
            initial={{ when: { kind: 'schedule', schedule: { repeat: 'daily', hour: 9, minute: 0, day: 1 },
                expression: '0 9 * * *', timezone: 'Pacific/Honolulu' }, enabled: true,
                then: { kind: 'runWorkflow', ref: null, inputs: {} } }} workflowOptions={[]} onSubmit={submit} />);
        await screen.pressByTestIdAsync('once-trigger-repeat:once');
        const picked = new Date(2030, 10, 11, 9, 15);
        await act(async () => { screen.findByType(LocalDateTimeEditor).props.onChange({ date: '2030-11-11', time: '09:15' }); });
        await screen.pressByTestIdAsync('once-trigger-submit');
        expect(submit.mock.calls[0]?.[1].trigger).toEqual({ kind: 'schedule', enabled: true,
            schedule: { kind: 'once', scheduledAt: picked.getTime() } });
        expect(submit.mock.calls[0]?.[0].when).toMatchObject({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        await act(async () => {
            const relative = screen.findAllByType(FieldValueItem).find(row => row.props.testID === 'once-trigger-relative')!;
            relative.props.onCommit('in 20 min');
        });
        submit.mockRejectedValueOnce(new Error('Save unavailable'));
        const beforeSave = Date.now();
        await screen.pressByTestIdAsync('once-trigger-submit');
        const definition = submit.mock.calls[1]?.[1].trigger;
        expect(definition?.kind).toBe('schedule');
        if (definition?.kind !== 'schedule' || definition.schedule.kind !== 'once') throw new Error('Expected one-time schedule');
        expect(definition.schedule.scheduledAt).toBeGreaterThanOrEqual(beforeSave + 20 * 60_000);
        expect(definition.schedule.scheduledAt).toBeLessThanOrEqual(Date.now() + 20 * 60_000);
        const clock = vi.spyOn(Date, 'now').mockReturnValue(beforeSave + 60_000);
        await screen.pressByTestIdAsync('once-trigger-submit');
        expect(submit.mock.calls[2]?.[1].trigger).toEqual(definition);
        clock.mockRestore();
        await screen.unmount();
        const reopened = await renderScreen(<TriggerPopover testID="saved-once" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule']} sessionId={null} showThen={false}
            initial={{ when: readScheduleWhen(definition.schedule), enabled: true,
                then: { kind: 'runWorkflow', ref: null, inputs: {} } }} workflowOptions={[]} onSubmit={submit} />);
        await reopened.pressByTestIdAsync('saved-once-submit');
        expect(submit.mock.calls[3]?.[1].trigger).toEqual(definition);
    });
    it('edits and submits the same schedule through mounted agent commands and UI, retaining it after a failed save', async () => {
        const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
        const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { ACTION_ID_FAMILIES_V1 } = await import('@happier-dev/protocol/actions/actionIds');
        const { FieldValueItem } = await import('@/components/ui/forms/FieldValueItem');
        const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
        const submit = vi.fn<ExistingTriggerSubmit>().mockRejectedValueOnce(new Error('Save unavailable')).mockResolvedValue(undefined);
        const close = vi.fn();
        const screen = await renderMountedCurrentUiContext(<TriggerPopover testID="coach-trigger" currentUiContextCommandScope="coach-trigger" anchorRef={React.createRef()}
            onRequestClose={close} whenKinds={['schedule']} sessionId={null} showThen={false} initial={null}
            workflowOptions={[]} onSubmit={submit} />);
        const executor = createDefaultActionExecutor();
        const commands = () => readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands;
        const invoke = async (suffix: string, input?: import('@happier-dev/protocol/plugins/ui').PluginUiJsonValueV1) => {
            const command = commands().find(row => row.description?.includes(`coach-trigger.${suffix}`));
            expect(command).toBeDefined();
            await act(async () => {
                expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: command!.id,
                    ...(input === undefined ? {} : { input }) }, { surface: 'agent' })).toMatchObject({ ok: true });
            });
        };
        await invoke('schedule.repeat', { value: 'weekly' });
        const day = commands().find(row => row.description?.includes('coach-trigger-day.select'));
        expect(day).toBeDefined();
        await act(async () => {
            expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
                { commandId: day!.id, input: { id: '5' } }, { surface: 'agent' })).toMatchObject({ ok: true });
        });
        await invoke('schedule.at', { value: '18:35' });
        const clock = commands().find(row => row.description?.includes('coach-trigger.schedule.at'))!;
        await act(async () => {
            expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
                { commandId: clock.id, input: { value: '25:99' } }, { surface: 'agent' })).toMatchObject({ ok: false });
        });
        expect(screen.findAllByType(FieldValueItem).find(row => row.props.testID === 'coach-trigger-at')?.props.value).toBe('18:35');
        await act(async () => screen.findAllByType(SegmentedChoiceItem).find(row => row.props.testIDPrefix === 'coach-trigger-repeat')!
            .props.onChange('weekdays'));
        await invoke('submit');
        expect(submit.mock.calls[0]?.[1].trigger).toMatchObject({ kind: 'schedule', schedule: { scheduleExpr: '35 18 * * 1-5' } });
        expect(submit.mock.calls[0]?.[2]).toMatchObject({ surface: 'agent' });
        expect(close).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('coach-trigger-submit');
        expect(submit.mock.calls[1]?.[1].trigger).toEqual(submit.mock.calls[0]?.[1].trigger);
        expect(submit.mock.calls[1]?.[2]).toMatchObject({ surface: 'ui' });
        expect(close).toHaveBeenCalledOnce();
    });
    it.each(['expression', 'interval'] as const)('edits a retained %s schedule through its mounted control', async kind => {
        const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
        const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { ACTION_ID_FAMILIES_V1 } = await import('@happier-dev/protocol/actions/actionIds');
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderMountedCurrentUiContext(<TriggerPopover testID="retained-schedule" currentUiContextCommandScope="retained-schedule" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule']} sessionId={null} showThen={false}
            initial={{ enabled: true, then: { kind: 'sendPrompt', prompt: '' }, when: { kind: 'schedule', schedule: null,
                expression: kind === 'expression' ? '0 8 1 * *' : '', timezone: 'UTC', ...(kind === 'interval' ? { everyMs: 3600000 } : {}) } }}
            workflowOptions={[]} onSubmit={submit} />);
        const command = readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands
            .find(row => row.description?.includes(`retained-schedule.schedule.${kind === 'expression' ? 'expression' : 'repeat'}`));
        expect(command).toBeDefined();
        await act(async () => {
            expect(await createDefaultActionExecutor().execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], {
                commandId: command!.id, input: { value: kind === 'expression' ? '15 8 1 * *' : 'weekdays' },
            }, { surface: 'agent' })).toMatchObject({ ok: true });
        });
        await screen.pressByTestIdAsync('retained-schedule-submit');
        expect(submit.mock.calls[0]?.[1].trigger).toMatchObject({ kind: 'schedule', schedule: {
            scheduleExpr: kind === 'expression' ? '15 8 1 * *' : '0 9 * * 1-5', everyMs: null,
        } });
    });
    it.each(['add', 'edit'] as const)('discloses retained requester sign-in before shared trigger %s', async (operation) => {
        const { createDefaultWhen } = await import('./sessionTriggerForm');
        const access = { custodian: { accountId: 'machine-owner', displayName: 'Machine owner' },
            role: 'use' as const, resourceMode: 'plain' as const, accessState: 'ready' as const };
        const machine = createMachineFixture({ access });
        getStorage().setState({ machines: { [machine.id]: machine } });
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="shared-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule']} sessionId={null} machineId={machine.id} serverId={serverId}
            showThen={false} initial={operation === 'add' ? null : {
                when: createDefaultWhen('schedule'), enabled: true, then: { kind: 'runWorkflow', ref: 'workflow-1', inputs: {} },
            }} workflowOptions={[]} onSubmit={submit} />);
        expect(screen.getTextContent()).toContain('machineRequester.fullSignIn(machine=tester.local,retention=trigger)');
        expect(screen.getTextContent()).toContain('machineRequester.osVisibility(owner=Machine owner,machine=tester.local)');
        expect(submit).not.toHaveBeenCalled();
    });
    it.each(['account', 'session', 'workflow'] as const)('keeps observation-only source setup scoped to %s enrollment', async (host) => {
        const { AutomationTriggerDefinitionInputSchema } = await import('@happier-dev/protocol/automations/automationTriggerDefinition');
        const value = AutomationTriggerDefinitionInputSchema.parse({ kind: 'pluginEvent', enabled: true,
            eventRef: { pluginId: 'acme.monitor', localId: 'issue-transition' }, sourceInstanceId: 'project:42',
            sourceContractVersion: 1, sourceConfig: {}, displayLabel: 'Production issues', filter: null,
            maximumObservationAgeMs: null, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
                machineId: 'observer-machine', pluginId: 'acme.monitor', materializationId: 'monitor-1',
            } } });
        if (value.kind !== 'pluginEvent' || !('sourceInstanceId' in value)) throw new Error('Expected configured source');
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="observe-source" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['pluginEvent']} sessionId={host === 'session' ? 'session-1' : null}
            showThen={host !== 'workflow'} hostComplete={false}
            initialWhen={{ kind: 'pluginEvent', value, observationOnly: { kind: 'observationOnly' } }} initial={null}
            workflowOptions={[]} onSubmit={submit} />);
        expect(screen.findByTestId('observe-source-then') === null).toBe(host !== 'session');
        expect(screen.findByTestId('observe-source-submit')?.props.disabled).toBe(host !== 'account');
        if (host !== 'account') return;
        await screen.pressByTestIdAsync('observe-source-submit');
        expect(submit.mock.calls[0]?.[1]).toEqual({ trigger: value, target: null, inputs: {},
            observationOnly: { kind: 'observationOnly' } });
    });

    it('submits a new Account prompt with its selected Agent through the shared form', async () => {
        const { validateWorkflowDefinition } = await import('@happier-dev/protocol/workflows/workflowValidationV1');
        const { createDefaultWhen } = await import('./sessionTriggerForm');
        const { resolveWorkflowStepSelectionV1 } = await import('@happier-dev/protocol/workflows/workflowStepSelectionV1');
        const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'acme.agents', localId: 'reviewer' } };
        const connectedServices = { v: 2 as const, bindingsByServiceId: {
            'acme.accounts/reviewer': { source: 'connected' as const, selection: 'profile' as const, profileId: 'reviewer-account' },
        } };
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="account-prompt" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule']} sessionId={null}
            initial={{ when: createDefaultWhen('schedule'), enabled: true,
                then: { kind: 'sendPrompt', prompt: 'Review overnight changes', selection: { agentTarget, connectedServices } } }}
            workflowOptions={[]} onSubmit={submit} />);
        // The shared form explains the unresolved Agent once (owner 2026-11-06),
        // while retaining the draft's Agent and Connected Account selections.
        expect(screen.findByTestId('account-prompt-agent-requires-agent')).toBeTruthy();
        expect(screen.findByTestId('account-prompt-submit')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('account-prompt-submit');
        const target = submit.mock.calls[0]?.[1].target;
        if (target?.kind !== 'inline') throw new Error('expected an inline target');
        expect(validateWorkflowDefinition(target.definition).valid).toBe(true);
        expect(resolveWorkflowStepSelectionV1({ defaults: target.definition.defaults, purpose: 'authoring' }).selection.agentTarget)
            .toEqual(agentTarget);
        expect(resolveWorkflowStepSelectionV1({ defaults: target.definition.defaults, purpose: 'authoring' }).selection.connectedServices)
            .toEqual(connectedServices);
    });
    it('shows two When choices side by side and switches with one press', async () => {
        const screen = await renderScreen(<TriggerPopover testID="when-choice" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule', 'pluginEvent']} sessionId={null}
            initial={null} workflowOptions={[]} onSubmit={vi.fn<ExistingTriggerSubmit>(async () => {})} />);
        // Both choices are on screen before anything is opened (no two-option dropdown).
        expect(screen.findByTestId('when-choice-when:schedule')).not.toBeNull();
        await screen.pressByTestIdAsync('when-choice-when:pluginEvent');
        expect(screen.findByTestId('when-choice-configure-event')).not.toBeNull();
    });

    it('edits an hourly schedule as Every hour at a minute, never as its cron, and writes the minute back', async () => {
        const onSubmit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="hourly" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule', 'pluginEvent']} sessionId={null}
            initial={{ when: { kind: 'schedule', expression: '54 * * * *', timezone: null,
                schedule: { repeat: 'hourly', hour: 9, minute: 54, day: 1 } }, enabled: true,
                then: { kind: 'notifyMe', title: '', message: 'Hourly check', channels: [] } }}
            workflowOptions={[]} onSubmit={onSubmit} />);
        expect(screen.findAllByType(FieldSelect).find(row => row.props.testID === 'hourly-repeat')?.props.selectedId).toBe('hourly');
        expect(screen.findByTestId('hourly-expression')).toBeNull();
        await act(async () => screen.findByProps({ accessibilityLabel: 'workflows.triggers.popover.at', value: ':54' }).props.onChangeText(':15'));
        await act(async () => screen.findByProps({ accessibilityLabel: 'workflows.triggers.popover.at', value: ':15' }).props.onBlur());
        await screen.pressByTestIdAsync('hourly-submit');
        expect(onSubmit.mock.calls[0]?.[1].trigger).toMatchObject({ schedule: { kind: 'cron', scheduleExpr: '15 * * * *' } });
    });

    it('stops promising the saved occurrence when the schedule draft changes', async () => {
        const screen = await renderScreen(<TriggerPopover testID="schedule-preview" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule', 'pluginEvent']} sessionId={null}
            initial={{ when: { kind: 'schedule', expression: '0 9 * * *', timezone: null,
                schedule: { repeat: 'daily', hour: 9, minute: 0, day: 1 } }, enabled: true,
                then: { kind: 'notifyMe', title: '', message: 'Release reminder', channels: [] } }}
            {...{ savedNextRunAt: Date.now() + 3_600_000 }}
            workflowOptions={[]} onSubmit={vi.fn<ExistingTriggerSubmit>(async () => {})} />);
        expect(screen.getTextContent()).toContain('workflows.triggers.popover.nextOccurrence');
        await act(async () => screen.findByProps({ accessibilityLabel: 'workflows.triggers.popover.at', value: '09:00' }).props.onChangeText('10:00'));
        await act(async () => screen.findByProps({ accessibilityLabel: 'workflows.triggers.popover.at', value: '10:00' }).props.onBlur());
        expect(screen.getTextContent()).not.toContain('workflows.triggers.popover.nextOccurrence');
    });

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
    it('requires a new Event to be configured before Done', async () => {
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="new-event-validity" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['pluginEvent']} sessionId={null} showThen={false}
            initial={null} workflowOptions={[]} onSubmit={submit} />);
        expect(screen.findByTestId('new-event-validity-submit')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('new-event-validity-submit');
        expect(submit).not.toHaveBeenCalled();
    });
    it('edits an exact saved Event row in place in the When it runs card and turns it off there', async () => {
        const { WorkflowTriggerSetV1Schema} = await import('@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1');
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'event-set', revision: 7, enabled: true,
            health: 'available', triggers: [{ id: 'event-row', revision: 3, enabled: true,
                createdAt: 1, updatedAt: 1, kind: 'pluginEvent', eventRef: { pluginId: 'acme.github', localId: 'issue-opened' },
                sourceSelectorId: '11111111-1111-4111-8111-111111111111', sourceContractVersion: 3,
                observation: { kind: 'socket', watcher: null }, sourceStatus: null, sourceCatalogStatus: null,
                triggerDefinitionEnvelope: 'sealed-private' }] });
        const change = vi.fn();
        const screen = await renderScreen(<WorkflowTriggerSection testIDPrefix="event-workflow" set={set}
            draft={{ adds: [], updates: {}, removes: [] }} onChangeDraft={change} status="ready" onRetry={vi.fn()}
            stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} />);
        // No popover: the Event's own rows sit in the card, with its edit entry.
        expect(screen.findByTestId('event-workflow-trigger-popover')).toBeNull();
        expect(screen.findByTestId('event-workflow-trigger:saved:event-row-configure-event')).toBeTruthy();
        // QA-C: a saved source is configured even before its sealed label is read; it offers Edit, never Set up.
        expect(screen.findByTestId('event-workflow-trigger:saved:event-row-configure-event')?.props.accessibilityLabel)
            .toBe('workflows.triggers.card.source: workflows.triggers.popover.editEvent');
        expect(screen.findByTestId('event-workflow-trigger:saved:event-row-starts.trigger')?.props.accessibilityLabel)
            .toBe('workflows.triggers.card.when: workflows.triggers.kind.pluginEvent');
        await toggleTrigger(screen, 'event-workflow-trigger:saved:event-row');
        expect(change).toHaveBeenCalledWith({ adds: [], updates: { 'event-row': { enabled: false } }, removes: [] });
        await removeTrigger(screen, 'event-workflow-trigger:saved:event-row');
        expect(change).toHaveBeenLastCalledWith({ adds: [], updates: {}, removes: ['event-row'] });
    });
    it('adds schedules and Any Session starts immediately and keeps an unselected Action incomplete', async () => {
        const change = vi.fn();
        const screen = await renderScreen(<WorkflowTriggerSection testIDPrefix="starts-workflow" set={null}
            draft={{ adds: [], updates: {}, removes: [] }} onChangeDraft={change} status="ready" onRetry={vi.fn()}
            stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} />);
        expect(screen.getTextContent()).toContain('workflows.triggers.card.empty');
        await addTrigger(screen, 'starts-workflow', 'session:turnEnds');
        expect(change).toHaveBeenCalledTimes(1);
        expect(change.mock.calls[0]?.[0].adds).toMatchObject([{ trigger: { kind: 'sessionLifecycle', enabled: true,
            events: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'], policy: { kind: 'everyMatch' } } }]);
        expect(change.mock.calls[0]?.[0].adds[0].trigger).not.toHaveProperty('subject');
        change.mockClear();
        await addTrigger(screen, 'starts-workflow', 'action:before');
        expect(change).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('workflows.triggers.card.incomplete');
        expect(screen.getTextContent()).not.toContain('workflows.triggers.card.empty');
        await addTrigger(screen, 'starts-workflow', 'schedule');
        expect(change).toHaveBeenCalledTimes(1);
        expect(change.mock.calls[0]?.[0].adds).toMatchObject([{ trigger: { kind: 'schedule', enabled: true,
            schedule: { kind: 'cron', scheduleExpr: '0 9 * * *' } } }]);
    });
    it.each([true, false])('keeps an invalid new Once out of the save draft and restores the same trigger when completed (enabled=%s)', async (enabled) => {
        const { EMPTY_WORKFLOW_TRIGGER_INCOMPLETE } = await import('./workflowTriggerStarts');
        let current: React.ComponentProps<typeof WorkflowTriggerSection>['draft'] = { adds: [], updates: {}, removes: [] };
        function Editor() {
            const [draft, setDraft] = React.useState(current);
            const [incomplete, setIncomplete] = React.useState(EMPTY_WORKFLOW_TRIGGER_INCOMPLETE);
            current = draft;
            return <WorkflowTriggerSection testIDPrefix="once-workflow" set={null} draft={draft} onChangeDraft={setDraft}
                incomplete={{ state: incomplete, onChange: setIncomplete }} status="ready" onRetry={() => {}}
                stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} />;
        }
        const screen = await renderScreen(<Editor />);
        await addTrigger(screen, 'once-workflow', 'schedule');
        expect(current.adds).toMatchObject([{ trigger: { kind: 'schedule', enabled: true,
            schedule: { kind: 'cron', scheduleExpr: '0 9 * * *' } } }]);
        const clientId = current.adds[0]!.clientId;
        const prefix = `once-workflow-trigger:new:${clientId}`;
        if (!enabled) await toggleTrigger(screen, prefix);
        await screen.pressByTestIdAsync(`${prefix}-repeat:once`);
        const relative = () => screen.findAll(node => node.props.testID === `${prefix}-relative`
            && typeof node.props.onChangeText === 'function')[0]!;
        await act(async () => { relative().props.onChangeText('2m'); });
        await act(async () => { relative().props.onBlur(); });
        expect(screen.findByTestId(`${prefix}-incomplete`)).not.toBeNull();
        expect(current.adds).toEqual([]);
        expect(relative().props.value).toBe('2m');
        await act(async () => { relative().props.onChangeText('in 2 min'); });
        const before = Date.now();
        await act(async () => { relative().props.onBlur(); });
        expect(current.adds).toHaveLength(1);
        expect(current.adds[0]).toMatchObject({ clientId, trigger: { kind: 'schedule', enabled,
            schedule: { kind: 'once', scheduledAt: expect.any(Number) } } });
        const schedule = current.adds[0]!.trigger;
        if (schedule.kind !== 'schedule' || schedule.schedule.kind !== 'once') throw new Error('Expected Once');
        expect(schedule.schedule.scheduledAt).toBeGreaterThanOrEqual(before + 120_000);
        expect(screen.findByTestId(`${prefix}-incomplete`)).toBeNull();
        await screen.unmount();
    });
    it('does not save a prior complete schedule edit while the saved trigger has an incomplete Once', async () => {
        const { WorkflowTriggerSetV1Schema } = await import('@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1');
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'once-set', revision: 1, enabled: true, health: 'available',
            triggers: [{ ...DAILY_TRIGGER, id: 'daily-row', revision: 1, createdAt: 1, updatedAt: 1,
                nextRunAt: null, triggerDefinitionEnvelope: null }] });
        let current: React.ComponentProps<typeof WorkflowTriggerSection>['draft'] = { adds: [], updates: {}, removes: [] };
        function Editor() {
            const [draft, setDraft] = React.useState(current);
            current = draft;
            return <WorkflowTriggerSection testIDPrefix="saved-once" set={set} draft={draft} onChangeDraft={setDraft}
                status="ready" onRetry={() => {}} stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} />;
        }
        const screen = await renderScreen(<Editor />);
        const prefix = 'saved-once-trigger:saved:daily-row';
        const time = () => screen.findAll(node => node.props.testID === `${prefix}-at`
            && typeof node.props.onChangeText === 'function')[0]!;
        await act(async () => { time().props.onChangeText('10:00'); });
        await act(async () => { time().props.onBlur(); });
        expect(current.updates['daily-row']?.trigger).toMatchObject({ kind: 'schedule', schedule: { scheduleExpr: '0 10 * * *' } });
        await screen.pressByTestIdAsync(`${prefix}-repeat:once`);
        expect(screen.findByTestId(`${prefix}-incomplete`)).not.toBeNull();
        expect(current.updates['daily-row']?.trigger).toBeUndefined();
        expect(current.removes).toEqual([]);
        expect(set.triggers[0]).toMatchObject(DAILY_TRIGGER);
        await screen.unmount();
    });
    it('the Sentence view\'s "or…" writes exactly what the card\'s Add a trigger writes, and both show the same incomplete trigger', async () => {
        const { EMPTY_WORKFLOW_TRIGGER_INCOMPLETE } = await import('./workflowTriggerStarts');
        const card = vi.fn();
        const sentence = vi.fn();
        function BothPresentations() {
            const [incomplete, setIncomplete] = React.useState(EMPTY_WORKFLOW_TRIGGER_INCOMPLETE);
            const shared = { set: null, draft: { adds: [], updates: {}, removes: [] }, status: 'ready' as const, onRetry: vi.fn(),
                stepsUnsaved: false, whereTarget: null, whereSummary: null, inputs: [],
                incomplete: { state: incomplete, onChange: (update: (current: typeof incomplete) => typeof incomplete) => setIncomplete(update) } };
            return <>
                <WorkflowTriggerSection testIDPrefix="card-workflow" onChangeDraft={card} {...shared} />
                <WorkflowTriggerSection testIDPrefix="sentence-workflow" onChangeDraft={sentence} presentation="sentence" {...shared} />
            </>;
        }
        const screen = await renderScreen(<BothPresentations />);
        const sentenceAdd = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'sentence-workflow-sentence-add-trigger-menu')!;
        await act(async () => { sentenceAdd().props.onOpenChange(true); });
        await act(async () => { sentenceAdd().props.onSelect('schedule'); });
        await addTrigger(screen, 'card-workflow', 'schedule');
        const { clientId: _sentenceClient, ...fromSentence } = sentence.mock.calls[0]![0].adds[0];
        const { clientId: _cardClient, ...fromCard } = card.mock.calls[0]![0].adds[0];
        expect(fromSentence).toEqual(fromCard);
        // An incomplete trigger (no Action yet) added in the sentence shows in the card too.
        await act(async () => { sentenceAdd().props.onOpenChange(true); });
        await act(async () => { sentenceAdd().props.onSelect('action:before'); });
        expect(screen.findAll(node => typeof node.props.testID === 'string' && /^card-workflow-trigger:new:.+-incomplete$/.test(node.props.testID)).length)
            .toBeGreaterThan(0);
        expect(screen.findAll(node => typeof node.props.testID === 'string' && /^sentence-workflow-sentence-trigger:new:/.test(node.props.testID)).length)
            .toBeGreaterThan(0);
    });
    it('the When select switches a session trigger to another session event and keeps its Session and How often', async () => {
        const change = vi.fn();
        const subject = { kind: 'session' as const, serverId, sessionId: 'session-a' };
        const trigger = { kind: 'sessionLifecycle' as const, enabled: true, subject,
            events: ['parentTurnCompleted' as const, 'parentTurnFailed' as const, 'parentTurnCancelled' as const], policy: { kind: 'firstMatch' as const } };
        const screen = await renderScreen(<WorkflowTriggerSection testIDPrefix="when-workflow" set={null}
            draft={{ adds: [{ clientId: 'c1', trigger }], updates: {}, removes: [] }} onChangeDraft={change}
            status="ready" onRetry={vi.fn()} stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} />);
        const when = screen.findAll(node => node.props.testID === 'when-workflow-trigger:new:c1-starts'
            && typeof node.props.onSelect === 'function')[0]!;
        expect(when.props.selectedId).toBe('session:turnEnds');
        await act(async () => { when.props.onSelect('session:needsYou'); });
        expect(change).toHaveBeenLastCalledWith({ adds: [{ clientId: 'c1', trigger: { kind: 'sessionLifecycle', enabled: true,
            subject, events: ['userActionRequired'], policy: { kind: 'firstMatch' } } }], updates: {}, removes: [] });
        await screen.pressByTestIdAsync('when-workflow-trigger:new:c1-how-often:everyTime');
        expect(change.mock.lastCall?.[0].adds[0].trigger.policy).toEqual({ kind: 'everyMatch' });
    });
    it.each([true, false])('rebinds This turn only with a portable Home and retains an unchanged Session turn (portable identity=%s)', async (hasPortableIdentity) => {
        const { WorkflowTriggerBlock } = await import('./WorkflowTriggerBlock');
        const { buildTriggerDefinition } = await import('./sessionTriggerForm');
        const sessions = ['turn-source', 'turn-destination'].map(id => createPlainSessionCurrentProjectionRecordFixture({ id, active: true,
            metadata: { machineId: 'machine-1', path: '/repo', host: 'host', name: id } }));
        const batch = createSessionReadBatchHttpBoundary(request => {
            const session = sessions.find(candidate => request.path === `/v2/sessions/${candidate.id}`);
            return session ? Response.json({ session }) : undefined;
        });
        const portableHome = 'srv_trigger_turn_home';
        const served = await serveAccountHomes({ homes: [{ key: 'turns', serverUrl: 'https://trigger-turns.test', accountId: 'turn-account',
            ...(hasPortableIdentity ? { serverIdentityId: portableHome } : {}) }],
            route: request => {
                if (request.path === '/v2/sessions') return Response.json({ sessions, nextCursor: null, hasNext: false });
                if (request.path === '/v2/sessions/archived' || request.path === '/v2/sessions/active') {
                    return Response.json({ sessions: [], nextCursor: null, hasNext: false });
                }
                return batch.handle(request);
            } });
        onTestFinished(() => served.dispose());
        const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
        expect(await resolveServerCredentialAccountScope(served.homes.turns!.profileId)).toMatchObject({ kind: 'bound' });
        getStorage().setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
        const change = vi.fn<React.ComponentProps<typeof WorkflowTriggerBlock>['onChangeWhen']>();
        expect(served.homes.turns!.profileId).not.toBe(portableHome);
        const subject = { kind: 'session' as const, serverId: portableHome, sessionId: 'turn-source' };
        const screen = await renderScreen(<WorkflowTriggerBlock testID="turn-workflow" title="Turn completion"
            when={{ kind: 'turnEnds', subject, sourceTurnId: 'turn-a' }} enabled incomplete={false}
            startOptions={[]} onSelectStart={vi.fn()} onChangeWhen={change} onRemove={vi.fn()}
            machineId={null} serverId={served.homes.turns!.profileId} />);
        const menu = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'turn-workflow-session')!;
        await act(async () => { menu().props.onOpenChange(true); });
        await waitForHomeGovernance(() => expect(menu().props.items).toContainEqual(expect.objectContaining({ id: 'turn-destination' })));
        await act(async () => { menu().props.onSelect('turn-source'); });
        expect(change.mock.lastCall?.[0]).toEqual({ kind: 'turnEnds', subject, sourceTurnId: 'turn-a' });
        await act(async () => { menu().props.onOpenChange(true); });
        await waitForHomeGovernance(() => expect(menu().props.items).toContainEqual(expect.objectContaining({ id: 'turn-destination' })));
        await act(async () => { menu().props.onSelect('turn-destination'); });
        const rebound = change.mock.lastCall![0];
        if (!hasPortableIdentity) {
            expect(rebound).toEqual({ kind: 'turnEnds', subject, sourceTurnId: 'turn-a' });
            await screen.unmount();
            return;
        }
        const reboundSubject = { ...subject, sessionId: 'turn-destination' };
        expect(rebound).toMatchObject({ subject: reboundSubject });
        expect(buildTriggerDefinition({ when: rebound, enabled: true, sessionId: null })).toEqual({
            kind: 'sessionLifecycle', enabled: true, subject: reboundSubject,
            events: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'], policy: { kind: 'firstMatch' },
        });
        await screen.unmount();
    });
    it('draws no Loading line while a saved workflow\'s Team grants load, so the card keeps its size (07 §7)', async () => {
        const { createWorkflowDefinitionFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        let grantsRequested = false;
        // The grants read stays in flight: the state that used to draw a trailing "Loading…" row.
        home.answer(serverId, '/v1/artifacts/saved-workflow/access/grants', { select: () => {
            grantsRequested = true;
            return new Promise(() => {});
        } });
        const connection = await restoreServerAccountForTest({ serverUrl: getActiveServerSnapshot().serverUrl,
            accountId: 'account-a', request: home.request,
            credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) } });
        onTestFinished(() => connection.dispose());
        const definition = createWorkflowDefinitionFixture({});
        const screen = await renderScreen(<WorkflowTriggerSection testIDPrefix="grants-workflow" set={null}
            workflowDefinitionId="saved-workflow"
            draft={{ adds: [{ clientId: 'daily', trigger: DAILY_TRIGGER }], updates: {}, removes: [] }} onChangeDraft={vi.fn()}
            status="ready" onRetry={vi.fn()}
            stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={definition.inputs} {...{ definition }} />);
        await vi.waitFor(() => expect(grantsRequested).toBe(true));
        expect(screen.getTextContent()).not.toContain('common.loading');
    });
    it.each([false, true])('only offers Roles for used roles and keeps the trigger rows while they are open: used=%s', async (used) => {
        const { createWorkflowDefinitionFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const { PromptLibraryRowsListResponseV1Schema, sealPromptLibraryContentV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        home.answer(serverId, '/v1/account/entity-rows/prompt-library', { body: PromptLibraryRowsListResponseV1Schema.parse({
            status: 'listed', rows: [{ key: 'role-overrides', revision: 1, content: sealPromptLibraryContentV1({
                record: { key: 'role-overrides', value: { v: 1, overrides: {} } }, mode: 'plain', material: null,
            }) }],
        }) });
        const connection = await restoreServerAccountForTest({ serverUrl: getActiveServerSnapshot().serverUrl,
            accountId: 'account-a', request: home.request,
            credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) } });
        onTestFinished(() => connection.dispose());
        const definition = createWorkflowDefinitionFixture({
            defaults: used ? { roleId: 'portable_builder' } : {},
            roles: [{ roleId: 'portable_builder', name: 'Builder', instructions: 'Build carefully', runsAs: { kind: 'session' } }],
            inputs: [{ name: 'release', valueType: 'string', required: false }],
        });
        const { createWorkflowEditorReadable } = await import('../editor/workflowEditorDraftStore');
        const definitionSource = createWorkflowEditorReadable(definition);
        const screen = await renderScreen(<WorkflowTriggerSection testIDPrefix="roles-workflow" set={null}
            draft={{ adds: [{ clientId: 'daily', trigger: DAILY_TRIGGER }], updates: {}, removes: [] }} onChangeDraft={vi.fn()}
            status="ready" onRetry={vi.fn()}
            stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={definition.inputs}
            {...(used ? { definitionSource } : { definition })} />);
        const roles = screen.findByTestId('roles-workflow-trigger-roles');
        if (!used) {
            expect(roles).toBeNull();
            return;
        }
        expect(roles).not.toBeNull();
        const mainText = screen.getTextContent();
        expect(mainText.indexOf('workflows.triggers.editor.roles')).toBeLessThan(mainText.indexOf('workflows.triggers.card.add'));
        await screen.pressByTestIdAsync('roles-workflow-trigger-roles');
        await vi.waitFor(() => expect(screen.findByTestId('roles-workflow-trigger-roles-role-portable_builder-target:background_run')).not.toBeNull());
        expect(screen.findByProps({ accessibilityLabel: 'workflows.triggers.popover.at', value: '09:00' })).toBeTruthy();
        expect(screen.findByTestId('roles-workflow-trigger-input-release')).not.toBeNull();
        await act(async () => { definitionSource.set({ ...definition, defaults: {} }); });
        expect(screen.findByTestId('roles-workflow-trigger-roles')).toBeNull();
        expect(screen.findByTestId('roles-workflow-trigger-input-release')).not.toBeNull();
        await act(async () => { definitionSource.set(definition); });
        expect(screen.findByTestId('roles-workflow-trigger-roles')).not.toBeNull();
    });
    it('Add a trigger searches built-in starts and the Machine\'s plugin Events; a picked Event shows its own rows', async () => {
        const { DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const machine = createMachineFixture({ id: 'trigger-events-machine', activeAt: Date.now(), storageMode: 'plain',
            access: createPlainMachineRowFixture({ id: 'trigger-events-machine', accountId: 'account-a' }).access });
        getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
        publishMachineActivityForTest([machine]);
        home.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine: createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a' }) } });
        const eligible = (pluginId: string, localId: string, title: string) => DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({ event: {
            id: `${pluginId}/${localId}`, identity: { pluginId, localId }, occurrenceId: `capture-${pluginId}`,
            sourceCustody: { kind: 'development', registeredRootId: 'capture-root' }, title, description: null,
            payloadSchema: { type: 'object', properties: { action: { type: 'string' } }, additionalProperties: false },
            automation: { v: 1, eligible: true, source: { sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull'],
                sourceConfigSchema: { type: 'object', additionalProperties: false }, setupActionRef: { pluginId, localId: 'setup-source' } } },
        }, setupAction: { id: `${pluginId}/setup-source`, identity: { pluginId, localId: 'setup-source' }, occurrenceId: `capture-${pluginId}`,
            title: 'Set up source', description: null, inputSchema: { type: 'object', additionalProperties: false }, inputHints: null } });
        machineRpc.mockImplementation(async (request) => request.method === `${machine.id}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`
            ? { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                installedPackagesById: { 'happier.scm.forge.github': { id: 'happier.scm.forge.github', displayName: 'GitHub', version: '1.0.0', enabled: true,
                    source: { kind: 'path', locator: '/plugins/github' } } }, familiesById: {} }),
                automationEligibleEvents: [eligible('happier.scm.forge.github', 'automation/issue-opened-v1', 'An issue opens'),
                    eligible('happier.scm.forge.github', 'automation/pull-request-opened-v1', 'A pull request opens'),
                    eligible('happier.sentry', 'issue-transition', 'A new issue appears')] } : { error: 'method_not_found' });
        const change = vi.fn();
        const screen = await renderScreen(<WorkflowTriggerSection testIDPrefix="add-workflow" set={null}
            accountLifetime={undefined} draft={{ adds: [], updates: {}, removes: [] }} onChangeDraft={change}
            status="ready" onRetry={vi.fn()} stepsUnsaved={false} whereTarget={{ machineId: machine.id, directory: '/repo' }}
            whereSummary={null} inputs={[]} />);
        await act(async () => { addMenu(screen, 'add-workflow').props.onOpenChange(true); });
        const ids = () => (addMenu(screen, 'add-workflow').props.items as MenuItems).map(item => item.id);
        await waitForHomeGovernance(async () => {
            await act(async () => {});
            expect(ids()).toContain('event:happier.sentry/issue-transition');
        });
        // The menu's own search (the selectable menu owner's matcher) runs across built-in and plugin starts.
        const matching = (query: string) => (addMenu(screen, 'add-workflow').props.items as MenuItems)
            .filter(item => matchesHappierMenuQuery({ label: item.title, query })).map(item => item.id);
        expect(matching('issue')).toEqual(['event:happier.scm.forge.github/automation/issue-opened-v1', 'event:happier.sentry/issue-transition']);
        expect(matching('schedule')).toEqual(['schedule']);
        expect(addMenu(screen, 'add-workflow').props.footer).toBeTruthy();
        await addTrigger(screen, 'add-workflow', 'event:happier.sentry/issue-transition');
        // Not set up yet: nothing is written, and the block names the Event and asks for its source.
        expect(change).not.toHaveBeenCalled();
        const block = screen.findAll(node => typeof node.props.testID === 'string' && /^add-workflow-trigger:new:.*-starts$/.test(node.props.testID)
            && typeof node.props.onSelect === 'function')[0]!;
        expect(block.props.selectedId).toBe('event:happier.sentry/issue-transition');
        const blockId = String(block.props.testID).replace(/-starts$/, '');
        expect(screen.findByTestId(`${blockId}-title`)?.props.children).toBe('A new issue appears');
        expect(screen.findByTestId(`${blockId}-configure-event`)?.props.accessibilityLabel)
            .toBe('workflows.triggers.card.source: workflows.triggers.card.setUp');
        expect(screen.getTextContent()).toContain('workflows.triggers.card.incomplete');
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
            status="ready" onRetry={vi.fn()} stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} />);
        await toggleTrigger(screen, 'event-workflow-trigger:new:event-draft');
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
        expect(submit).not.toHaveBeenCalled();
        if (result === 'matched') {
            await screen.pressByTestIdAsync('event-trigger-submit');
            expect(submit.mock.calls[0]?.[1]).toMatchObject({ trigger: value, target: { kind: 'inline' } });
            expect(submit.mock.calls[0]?.[1]).not.toHaveProperty('observationOnly');
        }
    });
    it.each(['actionRefused', 'changedDraft', 'changedAccount'] as const)(
        'does not publish a diagnostic for %s', async (change) => {
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
            if (change === 'actionRefused') {
                const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
                const { settingsParse } = await import('@/sync/domains/settings/settings');
                const state = getStorage().getState();
                state.applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse({ ...state.settings,
                    actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'workflow.trigger.test': { enabled: false } } }),
                }), 1);
            }
            const when = { kind: 'pluginEvent', value } as const;
            let changeWhen!: React.Dispatch<React.SetStateAction<typeof when>>;
            function Rows() {
                const [currentWhen, setWhen] = React.useState(when);
                changeWhen = setWhen;
                return <TriggerPluginEventRows testID="pending-event" when={currentWhen}
                    activityEvent={activityEvent} onChange={vi.fn()} machineId={null} serverId={null} />;
            }
            const screen = await renderScreen(<ModalProvider><Rows /></ModalProvider>);
            // The diagnostic owner is pure. Its promise is still pending in this
            // synchronous turn, so retire the draft/Account before flushing it.
            act(() => { screen.pressByTestId('pending-event-test'); });
            expect(screen.findByTestId('pending-event-test-result')).toBeNull();
            expect(screen.findByTestId('pending-event-test')?.props.disabled).toBe(true);
            act(() => {
                if (change === 'changedDraft') changeWhen({ ...when, value: { ...value, maximumObservationAgeMs: 1 } });
                if (change === 'changedAccount') {
                    const scope = getStorage().getState().profileScope;
                    if (!scope) throw new Error('expected an Account scope');
                    getStorage().setState({ profileScope: { ...scope, accountId: 'account-b' } });
                }
            });
            await act(async () => {});
            expect(screen.findByTestId('pending-event-test-result')).toBeNull();
            if (change === 'actionRefused') {
                expect(screen.findByType(WebAlertModal).props.config).toMatchObject({ title: 'common.error', message: expect.any(String) });
                // The real modal host retains its hidden entry through exit.
                // Assert the primitive count so a failure cannot traverse Fibers.
                vi.useFakeTimers();
                try {
                    await screen.pressByTestIdAsync('web-modal-button-0');
                    await act(async () => { await vi.advanceTimersByTimeAsync(motionTokens.overlay.modal.exitMs); });
                } finally { vi.useRealTimers(); }
                expect(screen.findAllByType(WebAlertModal).length).toBe(0);
            } else expect(screen.findAllByType(WebAlertModal).length).toBe(0);
        });
    it('points the trigger form back to its resolved anchor', async () => {
        const screen = await renderScreen(<TriggerPopover testID="anchored-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['turnEnds']} sessionId="session-1" initial={null}
            workflowOptions={[]} onSubmit={vi.fn<ExistingTriggerSubmit>(async () => {})} />);
        expect(screen.findByTestId('floating-overlay-arrow')).toBeTruthy();
    });
    it('seeds a new contextual Session subject with its portable Home independently of lifetime', async () => {
        const contextHome = await home.addHome({ name: 'Contextual trigger Home',
            serverUrl: 'https://context-trigger-home.test', serverIdentityId: 'srv_context_trigger_home',
            accountId: 'account-a', active: false });
        const { resolvePortableServerIdentityForRoutingId } = await import('@/sync/domains/server/resolvePortableServerIdentityForRoutingId');
        const portableHome = resolvePortableServerIdentityForRoutingId(contextHome);
        expect(portableHome).toBeTruthy();
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="context-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['turnEnds']} sessionId="watched-session" serverId={contextHome}
            initial={null} initialWhen={{ kind: 'turnEnds', sourceTurnId: 'turn-one' }} showThen={false}
            workflowOptions={[]} onSubmit={submit} />);
        await screen.pressByTestIdAsync('context-trigger-submit');
        expect(submit.mock.calls[0]?.[1].trigger).toEqual({ kind: 'sessionLifecycle', enabled: true,
            subject: { kind: 'session', serverId: portableHome, sessionId: 'watched-session' },
            events: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'],
            policy: { kind: 'currentTurn', sourceTurnId: 'turn-one' } });
    });
    it('keeps a new contextual lifecycle draft unsaved for an unresolved contextual Home identity', async () => {
        const unresolvedHome = await home.addHome({ name: 'Unadopted Home', serverUrl: 'https://unadopted-trigger-home.test', accountId: 'account-a' });
        const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
        expect(await resolveServerCredentialAccountScope(unresolvedHome)).toMatchObject({ kind: 'bound' });
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="unresolved-context-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['turnEnds']} sessionId="watched-session" serverId={unresolvedHome}
            initial={null} showThen={false} workflowOptions={[]} onSubmit={submit} />);
        expect(screen.findByTestId('unresolved-context-trigger-submit')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('unresolved-context-trigger-submit');
        expect(submit).not.toHaveBeenCalled();
        await home.addHome({ name: 'Resolved Home', serverUrl: 'https://unadopted-trigger-home.test',
            serverIdentityId: 'srv_resolved_trigger_home', accountId: 'account-a' });
        await screen.update(<TriggerPopover testID="unresolved-context-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['turnEnds']} sessionId="watched-session" serverId={unresolvedHome}
            initial={null} showThen={false} workflowOptions={[]} onSubmit={submit} />);
        await screen.pressByTestIdAsync('unresolved-context-trigger-submit');
        expect(submit.mock.calls[0]?.[1].trigger).toMatchObject({ kind: 'sessionLifecycle',
            subject: { kind: 'session', serverId: 'srv_resolved_trigger_home', sessionId: 'watched-session' } });
    });
    it.each(['schedule', 'turnEnds'] as const)('retains a saved %s choice for an unresolved contextual Home identity', async (kind) => {
        const { createDefaultWhen } = await import('./sessionTriggerForm');
        const unresolvedHome = await home.addHome({ name: 'Unadopted saved Home',
            serverUrl: 'https://unadopted-saved-trigger-home.test', accountId: 'account-a' });
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="unresolved-saved-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule', 'turnEnds', 'needsYou']} sessionId="watched-session" serverId={unresolvedHome}
            initial={{ when: createDefaultWhen(kind), enabled: true, then: { kind: 'runWorkflow', ref: null, inputs: {} } }}
            showThen={false} workflowOptions={[]} onSubmit={submit} />);
        await screen.pressByTestIdAsync(`unresolved-saved-trigger-when:${kind === 'schedule' ? 'turnEnds' : 'needsYou'}`);
        await screen.pressByTestIdAsync('unresolved-saved-trigger-submit');
        expect(submit.mock.calls[0]?.[1].trigger?.kind).toBe(kind === 'schedule' ? 'schedule' : 'sessionLifecycle');
        if (kind === 'turnEnds') expect(submit.mock.calls[0]?.[1].trigger).toMatchObject({ events: ['userActionRequired'] });
        expect(submit.mock.calls[0]?.[1].trigger).not.toHaveProperty('subject');
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
        const { WORKFLOW_STARTER_EXAMPLES_V1} = await import('@happier-dev/protocol/workflows/builtins/examples');
        const contextHome = await home.addHome({ name: 'Example trigger Home', serverUrl: 'https://example-trigger-home.test',
            serverIdentityId: 'srv_example_trigger_home', accountId: 'account-a', active: false });
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="example-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['turnEnds']} sessionId="session-1" serverId={contextHome} initial={null}
            workflowOptions={[]} onSubmit={submit} />);
        await act(async () => { screen.findAllByType(DropdownMenu).find((menu) => menu.props.testID === 'example-trigger-then')!.props.onSelect('example'); });
        await reportCollectionLayout(screen, 'workflow-examples:cards');
        await screen.pressByTestIdAsync('workflow-examples:ask-once:use');
        expect(screen.findByTestId('example-trigger-submit')?.props.disabled).toBe(true);
        await act(async () => { screen.changeTextByTestId('example-trigger-input-request', 'Review the changes'); });
        expect(screen.findByTestId('example-trigger-submit')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('example-trigger-submit');
        expect(submit.mock.calls[0]?.[1]).toMatchObject({ target: { kind: 'inline',
            definition: WORKFLOW_STARTER_EXAMPLES_V1.find((entry) => entry.key === 'ask-once')!.definition },
            inputs: { request: 'Review the changes' } });
    });
    it('shows defaults, refuses missing or invalid inputs, and submits typed edits', async () => {
        const { WORKFLOW_STARTER_EXAMPLES_V1 } = await import('@happier-dev/protocol/workflows/builtins/examples');
        const askOnce = WORKFLOW_STARTER_EXAMPLES_V1.find(example => example.key === 'ask-once')!.definition;
        const definition = WorkflowDefinitionV1Schema.parse({ ...askOnce, inputs: [...askOnce.inputs,
            { name: 'maxRounds', valueType: 'number', required: false, default: 3 },
            { name: 'useJudge', valueType: 'boolean', required: false, default: false },
        ] });
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="typed-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['turnEnds']} sessionId="session-1" serverId={serverId}
            initial={{ when: { kind: 'turnEnds' }, enabled: true,
                then: { kind: 'kept', target: { kind: 'inline', definition }, inputs: {} } }}
            workflowOptions={[]} onSubmit={submit} />);
        const field = (name: string) => screen.findByTestId(`typed-trigger-input-${name}`);
        expect(field('maxRounds')?.props.value).toBe('3');
        expect(screen.findByTestId('typed-trigger-submit')?.props.disabled).toBe(true);
        await act(async () => { screen.changeTextByTestId('typed-trigger-input-request', 'Review the changes'); });
        await act(async () => { screen.changeTextByTestId('typed-trigger-input-maxRounds', '3e'); });
        expect(field('maxRounds')?.props.value).toBe('3e');
        expect(screen.findByTestId('typed-trigger-submit')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('typed-trigger-submit');
        expect(submit).not.toHaveBeenCalled();
        await act(async () => { screen.changeTextByTestId('typed-trigger-input-maxRounds', '5'); });
        expect(screen.findByTestId('typed-trigger-submit')?.props.disabled).toBe(false);
        await act(async () => { screen.pressByTestId('typed-trigger-submit'); });
        expect(submit.mock.calls[0]?.[1]).toMatchObject({ target: { kind: 'inline', definition },
            inputs: { request: 'Review the changes', maxRounds: 5, useJudge: false } });
    });


    it('leaves an origin Session default for the new-session trigger claim to bind', async () => {
        const submit = vi.fn<Extract<React.ComponentProps<typeof TriggerPopover>, { creatingSession: true }>['onSubmit']>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="new-review-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['sessionStarts']} creatingSession sessionId={null} serverId={serverId}
            initial={{ when: { kind: 'sessionStarts' }, enabled: true,
                then: { kind: 'runWorkflow', ref: 'builtin:review-and-converge',
                    inputs: { reviewers: [{ kind: 'engine', engineId: 'codex', includeSessionTranscript: true }] } } }}
            workflowOptions={[{ ref: 'builtin:review-and-converge', title: 'Review & converge' }]} onSubmit={submit} />);
        expect(screen.findByTestId('new-review-trigger-submit')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('new-review-trigger-submit');
        expect(submit).toHaveBeenCalled();
        expect(submit.mock.calls[0]?.[1].inputs).not.toHaveProperty('reviewSession');
    });

    it('keeps JSON drafts distinct from string values and preserves an explicit false input on reopen', async ({ onTestFinished }) => {
        // Plugin definition content is Account-scoped; this fixture must establish its disclosure scope.
        const previousScope = getStorage().getState().profileScope;
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        getStorage().setState({ profileScope: { serverId, accountId: 'account-a' } });
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
        const machine = createMachineFixture({ id: 'trigger-inputs-machine', activeAt: Date.now(), storageMode: 'plain',
            access: createPlainMachineRowFixture({ id: 'trigger-inputs-machine', accountId: 'account-a' }).access });
        getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
        publishMachineActivityForTest([machine]);
        home.answer(serverId, `/v1/machines/${machine.id}`, { body: {
            machine: createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a' }),
        } });
        machineRpc.mockImplementation(async (request) => request.method === `${machine.id}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`
            ? { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                installedPackagesById: { 'example.workflows': { id: 'example.workflows', displayName: 'Example workflows', version: '1.0.0', enabled: true,
                    source: { kind: 'path', locator: '/plugins/example.workflows' } } }, familiesById: { workflows: { family: 'workflows', entriesById: {
                    'example.workflows/review': { id: 'example.workflows/review', pluginId: 'example.workflows', pluginVersion: '1.0.0',
                        definition: { id: 'review', title: 'Review', definition } },
                } } } }) } : { error: 'method_not_found' });
        const screen = await renderScreen(<TriggerPopover testID="json-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['turnEnds']} sessionId="session-1"
            initial={{ when: { kind: 'turnEnds' }, enabled: true,
                then: { kind: 'runWorkflow', ref, inputs: { payload: 'Saved JSON string', announce: false } } }}
            workflowOptions={[{ ref, title: 'Review' }]} onSubmit={submit} />);
        await waitForHomeGovernance(async () => {
            await act(async () => {});
            expect(screen.findByTestId('json-trigger-input-payload')?.props.value, JSON.stringify({
                methods: machineRpc.mock.calls.map(([request]) => request.method),
                paths: home.requests.map(request => request.path),
            })).toBe('"Saved JSON string"');
        });
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
    it.each(['runs-in', 'runs-in-session'] as const)('waits for %s intent before reading unopened prompt destinations', async (field) => {
        const { createDefaultWhen } = await import('./sessionTriggerForm');
        const { AsyncLocalStorage } = getVitestNodeBuiltin<typeof import('node:async_hooks')>('node:async_hooks');
        // Keep the real chooser and Sync running: async context attributes HTTP
        // reads to this user intent without replacing any internal reader.
        const intent = new AsyncLocalStorage<'chooser' | 'bootstrap'>();
        onTestFinished(() => intent.disable());
        const chooserSnapshots: unknown[] = [];
        const bootstrapSnapshots: unknown[] = [];
        const unattributedSnapshots: unknown[] = [];
        const session = createPlainSessionCurrentProjectionRecordFixture({ id: 'unopened-prompt', active: true, metadata: {
            flavor: 'claude', claudeSessionId: 'resume', claudeTranscriptPath: '/tmp/prompt.jsonl',
            machineId: 'machine-1', path: '/repo', host: 'host', name: 'Unopened prompt destination',
        } });
        const batch = createSessionReadBatchHttpBoundary(request => request.path === `/v2/sessions/${session.id}`
            ? Response.json({ session }) : undefined);
        const served = await intent.run('bootstrap', () => serveAccountHomes({ homes: [{ key: 'prompt', serverUrl: 'https://trigger-demand.test', accountId: 'prompt-account' }],
            route: request => {
                if (request.path === '/v2/sessions/read-batch') {
                    const initiator = intent.getStore();
                    (initiator === 'chooser' ? chooserSnapshots
                        : initiator === 'bootstrap' ? bootstrapSnapshots : unattributedSnapshots).push(request.body);
                }
                if (request.path === '/v2/sessions') return Response.json({ sessions: [session], nextCursor: null, hasNext: false });
                if (request.path === '/v2/sessions/archived' || request.path === '/v2/sessions/active') {
                    return Response.json({ sessions: [], nextCursor: null, hasNext: false });
                }
                return batch.handle(request);
            } }));
        onTestFinished(() => served.dispose());
        const promptServerId = served.homes.prompt!.id;
        getStorage().setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
        const beforeMount = served.requests.length;
        const screen = await renderScreen(<TriggerPopover testID="demand-prompt" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule']} sessionId={null} serverId={promptServerId} machineId="machine-1"
            initial={{ when: createDefaultWhen('schedule'), enabled: true, then: { kind: 'sendPrompt',
                prompt: 'Summarize the night', selection: {}, ...(field === 'runs-in-session'
                    ? { runsIn: { kind: 'session', sessionId: 'retained', machineId: 'machine-1' } as const } : {}) } }}
            workflowOptions={[]} onSubmit={vi.fn<ExistingTriggerSubmit>(async () => {})} />);
        const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
        await act(async () => { expect((await resolveServerCredentialAccountScope(promptServerId)).kind).toBe('bound'); });
        expect(served.requests.slice(beforeMount).filter(request => request.path === '/v2/sessions/read-batch'
            || request.path === '/v2/sessions/archived')).toHaveLength(0);
        const menu = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === `demand-prompt-${field}`)!;
        await intent.run('chooser', async () => {
            await act(async () => { menu().props.onOpenChange(true); });
            await waitForHomeGovernance(() => {
                const items = menu().props.items as readonly { id: string; disabled?: boolean }[];
                expect(field === 'runs-in' ? items.find(item => item.id === 'session')?.disabled
                    : items.some(item => item.id === session.id)).toBe(field === 'runs-in' ? undefined : true);
            });
        });
        expect(served.requests.some(request => request.path === '/v2/sessions/archived')).toBe(true);
        // Current list rows omit documents. The demanded inventory admits its
        // owner projection in one snapshot cohort; the chooser must reuse it,
        // without a second detail read, turns/messages or opening a Session.
        expect(getStorage().getState().sessions[session.id]).toBeUndefined();
        const snapshot = expect.objectContaining({ sessionIds: [session.id],
            includeSnapshot: true, includeTurns: false, includeMessages: false });
        expect(unattributedSnapshots).toEqual([]);
        expect(chooserSnapshots).toEqual([snapshot]);
        // Bootstrap is independent of opening this chooser. It may race the
        // inventory, but has at most one snapshot-only cohort for this Home.
        expect(bootstrapSnapshots.length).toBeLessThanOrEqual(1);
        for (const request of bootstrapSnapshots) expect(request).toEqual(snapshot);
        await screen.unmount();
    });
    it('says a failed Session read on "A session…" and retries it in place until the Session is offered', async () => {
        const { createDefaultWhen } = await import('./sessionTriggerForm');
        const session = createPlainSessionCurrentProjectionRecordFixture({ id: 'retry-destination', active: true, metadata: {
            flavor: 'claude', claudeSessionId: 'resume', claudeTranscriptPath: '/tmp/retry.jsonl',
            machineId: 'machine-1', path: '/repo', host: 'host', name: 'Nightly summary',
        } });
        let failing = true;
        const batch = createSessionReadBatchHttpBoundary(request => request.path === `/v2/sessions/${session.id}`
            ? Response.json({ session }) : undefined);
        const served = await serveAccountHomes({ homes: [{ key: 'retry', serverUrl: 'https://trigger-retry.test', accountId: 'retry-account' }],
            route: request => {
                if (request.path === '/v2/sessions') return Response.json({ sessions: [session], nextCursor: null, hasNext: false });
                // The detailed inventory's own page fails; the Home itself stays reachable.
                if (request.path === '/v2/sessions/archived') return failing ? new Response('unavailable', { status: 503 })
                    : Response.json({ sessions: [], nextCursor: null, hasNext: false });
                if (request.path === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
                return batch.handle(request);
            } });
        onTestFinished(() => served.dispose());
        const retryServerId = served.homes.retry!.id;
        getStorage().setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
        const screen = await renderScreen(<TriggerPopover testID="retry-prompt" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule']} sessionId={null} serverId={retryServerId} machineId="machine-1"
            initial={{ when: createDefaultWhen('schedule'), enabled: true, then: { kind: 'sendPrompt', prompt: 'Summarize the night', selection: {} } }}
            workflowOptions={[]} onSubmit={vi.fn<ExistingTriggerSubmit>(async () => {})} />);
        const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
        await act(async () => { expect((await resolveServerCredentialAccountScope(retryServerId)).kind).toBe('bound'); });
        const menu = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'retry-prompt-runs-in')!;
        const sessionChoice = () => (menu().props.items as readonly { id: string; disabled?: boolean; subtitle?: string }[])
            .find(item => item.id === 'session');
        await act(async () => { menu().props.onOpenChange(true); });
        await waitForHomeGovernance(() => expect(sessionChoice()?.subtitle).toBe('workflows.conversation.sessionsFailedRetry'));
        expect(sessionChoice()?.disabled).not.toBe(true);
        failing = false;
        // The person's own press on the open menu's row, not a call into the select's handler.
        await screen.pressByTestIdAsync('retry-prompt-runs-in:session');
        expect(menu().props.open).toBe(true);
        await waitForHomeGovernance(() => expect(sessionChoice()?.subtitle).toBeUndefined());
        expect(sessionChoice()?.disabled).not.toBe(true);
        await screen.unmount();
    });
    it('calls a stored Session unavailable only once a settled read no longer offers it', async () => {
        const { createDefaultWhen } = await import('./sessionTriggerForm');
        const session = createPlainSessionCurrentProjectionRecordFixture({ id: 'offered-destination', active: true, metadata: {
            flavor: 'claude', claudeSessionId: 'resume', claudeTranscriptPath: '/tmp/offered.jsonl',
            machineId: 'machine-1', path: '/repo', host: 'host', name: 'Nightly summary',
        } });
        const batch = createSessionReadBatchHttpBoundary(request => request.path === `/v2/sessions/${session.id}`
            ? Response.json({ session }) : undefined);
        const served = await serveAccountHomes({ homes: [{ key: 'stored', serverUrl: 'https://trigger-stored.test', accountId: 'stored-account' }],
            route: request => {
                if (request.path === '/v2/sessions') return Response.json({ sessions: [session], nextCursor: null, hasNext: false });
                if (request.path === '/v2/sessions/archived' || request.path === '/v2/sessions/active') {
                    return Response.json({ sessions: [], nextCursor: null, hasNext: false });
                }
                return batch.handle(request);
            } });
        onTestFinished(() => served.dispose());
        const storedServerId = served.homes.stored!.id;
        getStorage().setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {}, deletedSessionIds: {} });
        const screen = await renderScreen(<TriggerPopover testID="stored-prompt" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule']} sessionId={null} serverId={storedServerId} machineId="machine-1"
            initial={{ when: createDefaultWhen('schedule'), enabled: true, then: { kind: 'sendPrompt', prompt: 'Summarize the night', selection: {},
                runsIn: { kind: 'session', sessionId: 'not-offered-destination', machineId: 'machine-1' } } }}
            workflowOptions={[]} onSubmit={vi.fn<ExistingTriggerSubmit>(async () => {})} />);
        const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
        await act(async () => { expect((await resolveServerCredentialAccountScope(storedServerId)).kind).toBe('bound'); });
        const menu = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'stored-prompt-runs-in-session')!;
        const stored = () => (menu().props.items as readonly { id: string; title: string; disabled?: boolean; subtitle?: string }[])
            .find(item => item.id === 'not-offered-destination');
        // Closed, nothing has read the Sessions: an unloaded Session is not a missing one.
        expect(stored()).toMatchObject({ title: 'workflows.conversation.savedSession' });
        expect(stored()?.disabled).not.toBe(true);
        await act(async () => getStorage().setState({ sessions: { 'not-offered-destination': createSessionFixture({
            id: 'not-offered-destination', serverId: storedServerId, metadata: {
                ...createSessionFixture().metadata!, name: 'Private schedule', path: '/secret',
            },
        }) } }));
        expect(stored()?.title).toBe('Private schedule');
        await act(async () => {
            getStorage().getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [storedServerId]: ['private'] } });
            getStorage().getState().setSessionTagAssignmentsOptimistic(storedServerId, 'not-offered-destination', ['private']);
            setScreenSharingPrivacyActive(true);
        });
        expect(stored()).toMatchObject({ title: 'workflows.conversation.savedSession' });
        expect(stored()?.disabled).not.toBe(true);
        await act(async () => { setScreenSharingPrivacyActive(false); getStorage().setState({ sessions: {} }); });
        await act(async () => { menu().props.onOpenChange(true); });
        await waitForHomeGovernance(() => expect(stored()).toMatchObject({ disabled: true,
            title: 'workflows.conversation.unavailableSession', subtitle: 'workflows.conversation.sessionNotHere' }));
        await screen.unmount();
    });
    it.each(['account', 'session'] as const)('does not submit a retired prompt destination from the %s editor, but keeps an unloaded destination', async (scope) => {
        const { buildTriggerTarget, createDefaultWhen, readTriggerThen } = await import('./sessionTriggerForm');
        const { TriggerTargetV1Schema } = await import('@happier-dev/protocol/workflows/triggers/triggerTargetV1');
        const { resolveWorkflowStepSelectionV1 } = await import('@happier-dev/protocol/workflows/workflowStepSelectionV1');
        const original = TriggerTargetV1Schema.parse(buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Summarize the night',
            runsIn: { kind: 'session', sessionId: 'destination', machineId: 'machine-1' } }, 'account'));
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        getStorage().setState({ isDataReady: true, sessions: {}, deletedSessionIds: {} });
        const screen = await renderScreen(<TriggerPopover testID="retired-target" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule']} sessionId={scope === 'account' ? null : 'scope-session'}
            serverId={serverId} machineId="machine-1"
            initial={{ when: createDefaultWhen('schedule'), enabled: true, then: readTriggerThen(original) }}
            workflowOptions={[]} onSubmit={submit} />);
        // Absence from the hydrated list does not mean deletion: archived and unloaded targets stay valid.
        expect(screen.findByTestId('retired-target-submit')?.props.disabled).toBe(false);
        const session = createSessionFixture({ id: 'destination', serverId, metadata: {
            ...createSessionFixture().metadata!, machineId: 'machine-1', path: '/repo',
            flavor: 'claude', claudeSessionId: 'resume-destination', claudeTranscriptPath: '/tmp/destination.jsonl',
        } });
        const replacement = createSessionFixture({ id: 'replacement', serverId, metadata: {
            ...session.metadata!, claudeSessionId: 'resume-replacement', claudeTranscriptPath: '/tmp/replacement.jsonl',
        } });
        await act(async () => { getStorage().setState({ sessions: { [session.id]: session, [replacement.id]: replacement } }); });
        await act(async () => { getStorage().getState().deleteSession(session.id, 'other-home'); });
        expect(screen.findByTestId('retired-target-submit')?.props.disabled).toBe(false);
        await act(async () => { getStorage().getState().deleteSession(session.id, serverId); });
        expect(screen.findByTestId('retired-target-submit')?.props.disabled).toBe(true);
        if (scope === 'account') {
            // The stored Session stays named with why it cannot be chosen, never an empty "Choose…".
            const storedMenu = screen.findAllByType(DropdownMenu).find(menu => menu.props.testID === 'retired-target-runs-in-session');
            const stored = storedMenu?.props.items.find((item: { id: string }) => item.id === session.id);
            // The value is short enough to survive a narrow panel; the explanation is the field's helper text.
            expect(stored).toMatchObject({ disabled: true, title: 'workflows.conversation.unavailableSession',
                subtitle: 'workflows.conversation.sessionGone' });
            expect(storedMenu?.props.itemTrigger.field).toMatchObject({ invalid: true });
        }
        await screen.pressByTestIdAsync('retired-target-submit');
        expect(submit).not.toHaveBeenCalled();
        if (scope === 'account') {
            const sessions = () => screen.findAllByType(DropdownMenu).find(menu => menu.props.testID === 'retired-target-runs-in-session')!;
            // 9c718cad7e/fe9de9f1f7 defer candidate projection until the chooser is opened.
            await act(async () => { sessions().props.onOpenChange(true); });
            await waitForHomeGovernance(() => expect(sessions().props.items).toContainEqual(expect.objectContaining({ id: replacement.id })));
            await act(async () => { sessions().props.onSelect(replacement.id); });
            expect(screen.findByTestId('retired-target-submit')?.props.disabled).toBe(false);
            await screen.pressByTestIdAsync('retired-target-submit');
            const target = TriggerTargetV1Schema.parse(submit.mock.calls[0]?.[1].target);
            if (target.kind !== 'inline') throw new Error('Expected an inline prompt');
            const step = target.definition.blocks[0];
            expect(resolveWorkflowStepSelectionV1({ defaults: target.definition.defaults,
                step: step?.kind === 'step' ? step.execution : undefined, purpose: 'authoring' }).selection.conversation)
                .toEqual({ kind: 'existing_session', sessionId: replacement.id, machineId: 'machine-1' });
        }
    });
    it('chooses where an Account prompt runs from one select whose unavailable choice keeps its reason', async () => {
        const { createDefaultWhen } = await import('./sessionTriggerForm');
        const submit = vi.fn<ExistingTriggerSubmit>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="runs-in" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['schedule']} sessionId={null}
            initial={{ when: createDefaultWhen('schedule'), enabled: true,
                then: { kind: 'sendPrompt', prompt: 'Summarize the night', selection: {} } }}
            workflowOptions={[]} onSubmit={submit} />);
        // Three long choices do not fit a segmented bar in a popover or on a phone (DESIGN-18 T1).
        const runsIn = () => screen.findAllByType(DropdownMenu).find((menu) => menu.props.testID === 'runs-in-runs-in');
        const select = runsIn();
        if (select === undefined) throw new Error('expected Runs in to be a select');
        expect(select.props.selectedId).toBe('newSession');
        expect(select.props.items.find((item: { id: string }) => item.id === 'session'))
            .toMatchObject({ disabled: true, subtitle: 'workflows.triggers.then.noSessionOnMachine' });
        await act(async () => { select.props.onSelect('backgroundRun'); });
        expect(runsIn()?.props.selectedId).toBe('backgroundRun');
    });
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
        expect(screen.findAllByType(FieldSelect).find(row => row.props.testID === 'wf-trigger-repeat')?.props.selectedId).toBe('interval');
        expect(screen.findByTestId('wf-trigger-expression')).toBeNull();
        await screen.pressByTestIdAsync('wf-trigger-submit');
        expect(submit.mock.calls[0]?.[1].trigger).toEqual({
            kind: 'schedule', enabled: true,
            schedule: { kind: 'interval', scheduleExpr: null, everyMs: 3_600_000, timezone: 'Europe/Zurich' },
        });
    });
});
