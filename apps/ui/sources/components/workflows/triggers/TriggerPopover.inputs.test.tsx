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
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';

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

const { TriggerPopover } = await import('./TriggerPopover');
const { WorkflowTriggerSection } = await import('./WorkflowTriggerSection');
const { WorkflowDefinitionV1Schema } = await import('@happier-dev/protocol');
type ExistingTriggerSubmit = Extract<React.ComponentProps<typeof TriggerPopover>, { creatingSession?: false }>['onSubmit'];

describe('Run a workflow trigger inputs', () => {
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
        // Unresolved Machine facts explain the unavailable control; the Account
        // prompt must still expose its authentication choice instead of hiding it.
        expect(screen.findByTestId('account-prompt-agent-connectedServices-unavailable')).toBeTruthy();
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
        const change = vi.fn();
        const screen = await renderScreen(<WorkflowTriggerSection testIDPrefix="event-workflow" set={set}
            draft={{ adds: [], updates: {}, removes: [] }} onChangeDraft={change} status="ready" onRetry={vi.fn()}
            runsOn={null} stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} />);
        await screen.pressByTestIdAsync('event-workflow-trigger:saved:event-row');
        expect(screen.findByTestId('event-workflow-trigger-popover-configure-event')).toBeTruthy();
        await act(async () => { screen.findByTestId('event-workflow-trigger:saved:event-row-switch')!.props.onValueChange(false); });
        expect(change).toHaveBeenCalledWith({ adds: [], updates: { 'event-row': { enabled: false } }, removes: [] });
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
        await reportCollectionLayout(screen, 'workflow-examples:cards');
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
            screen.find((node) => node.props.testID === 'typed-trigger-input-engines'
                && typeof node.props.onChange === 'function').props.onChange(['codex']);
        });
        await act(async () => { screen.changeTextByTestId('typed-trigger-input-maxRounds', '3e'); });
        expect(field('maxRounds')?.props.value).toBe('3e');
        expect(screen.findByTestId('typed-trigger-submit')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('typed-trigger-submit');
        expect(submit).not.toHaveBeenCalled();
        await act(async () => { screen.changeTextByTestId('typed-trigger-input-maxRounds', '5'); });
        expect(screen.findByTestId('typed-trigger-submit')?.props.disabled).toBe(false);
        await act(async () => {
            screen.find((node) => node.props.testID === 'typed-trigger-input-apply'
                && typeof node.props.onChange === 'function').props.onChange('report');
        });
        await act(async () => { screen.pressByTestId('typed-trigger-submit'); });
        expect(submit.mock.calls[0]?.[1]).toMatchObject({ target: { kind: 'workflow', ref: 'builtin:review-and-converge' },
            inputs: { engines: ['codex'], maxRounds: 5, apply: 'report', useJudge: false,
                reviewSession: { serverId, sessionId: 'session-1' } } });
    });

    it('leaves an origin Session default for the new-session trigger claim to bind', async () => {
        const submit = vi.fn<Extract<React.ComponentProps<typeof TriggerPopover>, { creatingSession: true }>['onSubmit']>(async () => {});
        const screen = await renderScreen(<TriggerPopover testID="new-review-trigger" anchorRef={React.createRef()}
            onRequestClose={vi.fn()} whenKinds={['sessionStarts']} creatingSession sessionId={null} serverId={serverId}
            initial={{ when: { kind: 'sessionStarts' }, enabled: true,
                then: { kind: 'runWorkflow', ref: 'builtin:review-and-converge', inputs: { engines: ['codex'] } } }}
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
        const machine = createMachineFixture({ id: 'trigger-inputs-machine', activeAt: Date.now() });
        getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
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
            expect(screen.findByTestId('json-trigger-input-payload')?.props.value).toBe('"Saved JSON string"');
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
        const session = createPlainSessionCurrentProjectionRecordFixture({ id: 'unopened-prompt', active: true, metadata: {
            flavor: 'claude', claudeSessionId: 'resume', claudeTranscriptPath: '/tmp/prompt.jsonl',
            machineId: 'machine-1', path: '/repo', host: 'host', name: 'Unopened prompt destination',
        } });
        const batch = createSessionReadBatchHttpBoundary(request => request.path === `/v2/sessions/${session.id}`
            ? Response.json({ session }) : undefined);
        const served = await serveAccountHomes({ homes: [{ key: 'prompt', serverUrl: 'https://trigger-demand.test', accountId: 'prompt-account' }],
            route: request => {
                if (request.path === '/v2/sessions') return Response.json({ sessions: [session], nextCursor: null, hasNext: false });
                if (request.path === '/v2/sessions/archived' || request.path === '/v2/sessions/active') {
                    return Response.json({ sessions: [], nextCursor: null, hasNext: false });
                }
                return batch.handle(request);
            } });
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
        await act(async () => { menu().props.onOpenChange(true); });
        await waitForHomeGovernance(() => {
            const items = menu().props.items as readonly { id: string; disabled?: boolean }[];
            expect(field === 'runs-in' ? items.find(item => item.id === 'session')?.disabled
                : items.some(item => item.id === session.id)).toBe(field === 'runs-in' ? undefined : true);
        });
        expect(served.requests.some(request => request.path === '/v2/sessions/archived')).toBe(true);
        // The inventory already admitted these plain owner facts. Opening a
        // destination chooser must not reacquire the same full Session.
        expect(served.requests.some(request => request.path === '/v2/sessions/read-batch')).toBe(false);
        expect(getStorage().getState().sessions[session.id]).toBeUndefined();
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
        expect(screen.findByTestId('wf-trigger-repeat:interval')).not.toBeNull();
        expect(screen.findByTestId('wf-trigger-expression')).toBeNull();
        await screen.pressByTestIdAsync('wf-trigger-submit');
        expect(submit.mock.calls[0]?.[1].trigger).toEqual({
            kind: 'schedule', enabled: true,
            schedule: { kind: 'interval', scheduleExpr: null, everyMs: 3_600_000, timezone: 'Europe/Zurich' },
        });
    });
});
