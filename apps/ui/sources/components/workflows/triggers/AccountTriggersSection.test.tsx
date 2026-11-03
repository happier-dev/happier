import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowTriggerSetV1Schema} from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AutomationDefinitionCreateRequestSchema, AutomationDefinitionDetailSchema,
    AutomationDefinitionListResponseSchema, AutomationDefinitionReconcileRequestSchema, type AutomationDefinitionDetail } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema,
    AutomationStoredWorkflowDefinitionV2Schema} from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import {
    sealEncryptedDataKeyEnvelopeV1} from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import {
    WorkflowDefinitionArtifactHeaderV1Schema, WorkflowDefinitionArtifactBodyV1Schema} from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { AutomationTriggerDetailSchema} from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import {
    sealAutomationTriggerDefinitionStoredEnvelopeV1} from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { AutomationTriggerIdSchema} from '@happier-dev/protocol/automations/automationTriggerIdentity';
import {
    type AutomationTriggerDefinitionInput} from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationEventJsonBoundsV1';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN } from '../../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';

const routerPush = vi.hoisted(() => vi.fn());
const routeState = vi.hoisted(() => ({ params: {} as Record<string, string> }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Native/web rendering and Radix are SDK boundaries. Confirmation, provider
// custody, alert buttons and dismissal stay with the actual Modal owners.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
    .createExpoRouterMock({ params: () => routeState.params, router: { push: routerPush } }).module);
vi.mock('@/components/ui/popover', async (importOriginal) => (await import('@/dev/testkit/mocks/popover'))
    .createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 280, placement: 'bottom' }));

const home = createHomeGovernanceHarness();
const httpBoundary = { ...home, request: createSessionReadBatchFetchBoundary(home.request) };
installHomeGovernanceBoundaries(httpBoundary);
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable,
    publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { ModalProvider } = await import('@/modal');
const { WebAlertModal } = await import('@/modal/components/WebAlertModal');
const { TriggerRunsOnRow } = await import('./TriggerRunsOnRow');

const { AccountTriggersSection, NewAccountTriggerPopover } = await import('./AccountTriggersSection');
const { TriggerPopover } = await import('./TriggerPopover');
const { buildTriggerDefinition } = await import('./sessionTriggerForm');
const project = { machineId: 'm1', directory: '/repo' };
function AccountModalHost({ children }: React.PropsWithChildren) {
    return <ModalProvider>{children}</ModalProvider>;
}
function renderAccountScreen(element: React.ReactElement) {
    return renderScreen(element, { wrapper: AccountModalHost });
}
function trigger(id: string, hour = 9) {
    return { id, revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'schedule',
        triggerDefinitionEnvelope: null, nextRunAt: null,
        schedule: { kind: 'cron', scheduleExpr: `0 ${hour} * * *`, everyMs: null, timezone: null } };
}
// The HTTP boundary persists private Event fields in the same revision-bound
// envelope consumed by the real Account host and editor reader.
function storedTrigger(automationId: string, id: string, revision: number, value: AutomationTriggerDefinitionInput,
    previous?: AutomationDefinitionDetail['triggers'][number]) {
    if (value.kind !== 'pluginEvent') return AutomationTriggerDetailSchema.parse({ ...value, id, revision,
        createdAt: 1, updatedAt: 1, nextRunAt: null, triggerDefinitionEnvelope: null });
    if (!('sourceInstanceId' in value) || value.observationTransport.kind === 'durablePush') throw new Error('Expected plain watcher fixture');
    const sourceSelectorId = previous?.kind === 'pluginEvent' ? previous.sourceSelectorId : crypto.randomUUID();
    return AutomationTriggerDetailSchema.parse({ id, revision, enabled: value.enabled, createdAt: 1, updatedAt: 1,
        kind: 'pluginEvent', eventRef: value.eventRef, sourceSelectorId, sourceContractVersion: value.sourceContractVersion,
        observation: { kind: value.observationTransport.kind,
            watcher: { ...value.observationTransport.watcherMaterializationRef, machineInstallationId: 'observer-installation' } },
        sourceStatus: null, sourceCatalogStatus: null,
        triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, automationId, triggerId: AutomationTriggerIdSchema.parse(id), triggerRevision: revision,
                triggerKind: 'pluginEvent', eventRef: value.eventRef, sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(sourceSelectorId) },
            definition: { v: 1, sourceInstanceId: value.sourceInstanceId, sourceConfig: value.sourceConfig,
                displayLabel: value.displayLabel, filter: value.filter, maximumObservationAgeMs: value.maximumObservationAgeMs } })) });
}
function fixture(legacy = false, triggers = [trigger('t1')]) {
    return WorkflowTriggerSetV1Schema.parse({ automationId: 'digest', revision: 1, enabled: true,
        health: 'available', project, ...(legacy ? { legacy: { editable: false, reason: 'created_in_0_2' } } : {}),
        target: { kind: 'inline', definition: { version: 1,
            defaults: { engine: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } },
            blocks: [{ kind: 'step', id: 'first', name: 'Morning digest',
            document: { text: 'Morning digest', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
        triggers });
}
let previous = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
let serverId: string;
let disposeLoader: (() => void) | undefined;
let disposeCredentials: (() => void) | undefined;
let syncLoader: Awaited<ReturnType<typeof loadSyncSingletonForTests>>;
let rows: AutomationDefinitionDetail[] = [];
let listReply: (() => Promise<ReturnType<typeof AutomationDefinitionListResponseSchema.parse>>) | undefined;
let holdLegacyRead = false;
let legacyRead = createDeferred<void>();
const mutations: Array<Readonly<{ automationId: string; input: ReturnType<typeof AutomationDefinitionReconcileRequestSchema.parse> }>> = [];

function listRows() {
    return AutomationDefinitionListResponseSchema.parse({ automations: rows.map(({ executionRecipe: _recipe, templateCiphertext: _template, ...row }) => ({
        ...row, triggers: row.triggers.map(({ triggerDefinitionEnvelope: _envelope, ...trigger }) => trigger),
    })), nextCursor: null });
}
function installRow(id: string) {
    const path = `/v3/automations/${id}`;
    home.answer(serverId, `GET ${path}`, { select: () => ({ body: rows.find(row => row.id === id) }) });
    home.answer(serverId, `PUT ${path}`, { select: raw => {
        const input = AutomationDefinitionReconcileRequestSchema.parse(raw);
        mutations.push({ automationId: id, input });
        const current = rows.find(row => row.id === id);
        if (!current) return { status: 404, body: { error: 'not_found' } };
        if (current.templateVersion !== input.expectedTemplateVersion) return { status: 409, body: { error: 'currentness_conflict' } };
        const { templateCiphertext, ...base } = current;
        const row = AutomationDefinitionDetailSchema.parse({ ...base, ...(input.executionRecipe ? {} : { templateCiphertext }),
            name: input.name, description: input.description, enabled: input.enabled, templateVersion: current.templateVersion + 1,
            workflowDefinitionId: input.workflowDefinitionId === undefined ? current.workflowDefinitionId : input.workflowDefinitionId,
            targetType: input.executionRecipe ? null : current.targetType, existingSessionId: input.executionRecipe ? null : current.existingSessionId,
            executionRecipe: input.executionRecipe ?? current.executionRecipe,
            ...(current.observationOnly ? { observationOnly: { ...current.observationOnly, templateVersion: current.templateVersion + 1 } } : {}),
            assignments: input.assignments.map(value => ({ ...value, enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })),
            triggers: input.triggers.map(value => {
                if (value.kind === 'new') throw new Error('Account edit fixture retains existing schedules');
                const trigger = current.triggers.find(candidate => candidate.id === value.triggerId);
                if (!trigger || trigger.revision !== value.expectedRevision) throw new Error('Trigger CAS fixture mismatch');
                if (value.trigger?.kind === 'pluginEvent') return storedTrigger(id, trigger.id, trigger.revision + 1,
                    { ...value.trigger, enabled: value.enabled ?? trigger.enabled }, trigger);
                return { ...trigger, ...(value.trigger ?? {}), ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
                    revision: trigger.revision + (value.trigger || value.enabled !== undefined ? 1 : 0) };
            }) });
        rows = rows.map(value => value.id === id ? row : value);
        return { body: row };
    } });
    home.answer(serverId, `DELETE ${path}`, { select: () => {
        const current = rows.find(row => row.id === id);
        rows = rows.filter(row => row.id !== id);
        return { body: { ok: true, removedRevision: current?.templateVersion } };
    } });
}
function resetTriggerSets() {
    const state = storage.getState();
    if (!('resetWorkflowTriggerSets' in state) || typeof state.resetWorkflowTriggerSets !== 'function') {
        throw new Error('The real Automation store must provide resetWorkflowTriggerSets');
    }
    state.resetWorkflowTriggerSets();
}
beforeEach(async () => {
    previous = storage.getState();
    previousSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    publishAppliedActiveServerRuntimeAvailability(false);
    resetTriggerSets();
    await home.reset();
    installHomeGovernanceBoundaries(httpBoundary);
    syncLoader = await loadSyncSingletonForTests();
    disposeLoader = await installRealActionExecutorModuleLoader();
    serverId = await home.addHome({ name: 'Account triggers', serverUrl: `https://account-trigger-${crypto.randomUUID()}.test`, accountId: 'account-a' });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' },
        sessions: { 'session-old': createSessionFixture({ id: 'session-old', serverId, encryptionMode: 'e2ee', active: false,
            metadata: { path: '/repo', host: 'test', homeDir: '/home/test', machineId: 'm1', flavor: 'claude', permissionMode: 'default' } }) },
        workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {} });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { encodeBase64 } = await import('@/encryption/base64');
    const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
    const credentials = { token: createAccountTokenForTests('account-a', { currentAccount: true }), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
    const credentialSpy = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
    disposeCredentials = () => credentialSpy.mockRestore();
    const encryption = await createEncryptionFromAuthCredentials(credentials);
    const encryptedKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(9),
        recipientPublicKey: encryption.contentDataKey, randomBytes: length => new Uint8Array(length).fill(3) }), 'base64');
    home.answer(serverId, '/v2/sessions/session-old', { body: { session: { id: 'session-old', seq: 1,
        createdAt: 1, updatedAt: 1, active: false, activeAt: 1, encryptionMode: 'e2ee', metadata: 'encrypted-metadata',
        metadataVersion: 1, agentState: null, agentStateVersion: 1, dataEncryptionKey: encryptedKey, share: null } } });
    rows = [];
    listReply = undefined;
    holdLegacyRead = false;
    legacyRead = createDeferred<void>();
    mutations.length = 0;
    home.answer(serverId, 'GET /v3/automations', { select: async () => {
        if (holdLegacyRead) await legacyRead.promise;
        return { body: await listReply?.() ?? listRows() };
    } });
    home.answer(serverId, 'POST /v3/automations', { select: raw => {
        const input = AutomationDefinitionCreateRequestSchema.parse(raw);
        const row = AutomationDefinitionDetailSchema.parse({ id: input.automationId, name: input.name,
            description: input.description ?? null, enabled: input.enabled, templateVersion: 1,
            workflowDefinitionId: input.workflowDefinitionId ?? null, scopeSessionId: input.scopeSessionId ?? null,
            targetType: null, existingSessionId: null, lastRunAt: null, createdAt: 1, updatedAt: 1,
            executionRecipe: input.executionRecipe, observationOnly: input.observationOnly, assignments: input.assignments?.map(value => ({ ...value,
                enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })) ?? [],
            triggers: input.triggers.map(value => storedTrigger(input.automationId, value.triggerId, 1, value.trigger)) });
        rows = [...rows, row];
        installRow(row.id);
        return { body: row };
    } });
    routerPush.mockReset();
    routeState.params = {};
});
afterEach(async () => {
    await standardCleanup();
    legacyRead.resolve();
    publishAppliedActiveServerRuntimeAvailability(false);
    resetTriggerSets();
    (await import('../library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    await home.reset();
    disposeCredentials?.();
    disposeLoader?.();
    syncLoader?.dispose();
    storage.setState(previous);
    publishAppliedActiveServerSnapshot(previousSnapshot, previousRuntimeAvailable);
});
function serve(set: ReturnType<typeof fixture>) {
    const row = AutomationDefinitionDetailSchema.parse({ id: set.automationId, name: 'Morning digest', description: null,
        enabled: set.enabled, workflowDefinitionId: null, scopeSessionId: null, templateVersion: set.revision,
        targetType: set.legacy ? 'existingSession' : null, existingSessionId: set.legacy ? 'session-old' : null,
        lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: (set.placements ?? [set.project ?? project]).map(value => ({ machineId: value.machineId,
            enabled: true, priority: 0, updatedAt: 1 })), triggers: set.triggers,
        ...(set.legacy ? { templateCiphertext: set.legacy.lockedReason ? AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED : AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN } : {
            executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: set.revision,
                workflow: { t: 'plain', v: { workspace: { directory: set.project?.directory ?? '/repo' }, executionTarget: { kind: 'session' },
                    inlineDefinition: set.target?.kind === 'inline' ? set.target.definition : undefined } }, triggerEvidence: null }),
        }) });
    rows = [row];
    installRow(row.id);
    // A retained cached legacy projection is still editable while its HTTP refresh
    // is pending. The write then opens the real predecessor bytes and Session key.
    if (set.legacy && !set.legacy.lockedReason) {
        holdLegacyRead = true;
        storage.getState().upsertWorkflowTriggerSet({ queryKey: 'account_inline', set });
    }
}
function writes() { return mutations.filter(value => value.input.removedTriggers.length === 0).map(value => value.input); }
function listRequests() { return home.requests.filter(request => request.path.startsWith('/v3/automations?')); }
function writtenContext(input: ReturnType<typeof AutomationDefinitionReconcileRequestSchema.parse>) {
    if (input.executionRecipe?.workflow.t !== 'plain') throw new Error('Expected a canonical plain recipe');
    return input.executionRecipe.workflow.v;
}
async function confirmAction(screen: Awaited<ReturnType<typeof renderAccountScreen>>) {
    await waitForHomeGovernance(() => expect(screen.findByTestId('web-modal-confirm')).not.toBeNull());
    await screen.pressByTestIdAsync('web-modal-confirm');
    await waitForHomeGovernance(() => expect(screen.findAllByType(WebAlertModal).length).toBe(0));
}

describe('Account trigger editing', () => {
    it.each(['account', 'activity'] as const)('stores and reopens Inbox-only source enrollment from %s without a Project or executable target', async (entry) => {
        const { AutomationTriggerDefinitionInputSchema } = await import('@happier-dev/protocol/automations/automationTriggerDefinition');
        const { AutomationRunPluginEventTriggerEvidenceV1Schema } = await import('@happier-dev/protocol/automations/automationRunExecutionRecipeV1');
        const { TriggerFromActivityEvent } = await import('./TriggerFromActivityEvent');
        const { PluginEventAutomationEditor } = await import('@/components/automations/editor/PluginEventAutomationEditor');
        const source = AutomationTriggerDefinitionInputSchema.parse({ kind: 'pluginEvent', enabled: true,
            eventRef: { pluginId: 'acme.monitor', localId: 'issue-transition' }, sourceInstanceId: 'project:42',
            sourceContractVersion: 1, sourceConfig: { project: '42' }, displayLabel: 'Production issues', filter: null,
            maximumObservationAgeMs: null, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
                machineId: 'observer-machine', pluginId: 'acme.monitor', materializationId: 'monitor-1',
            } } });
        if (source.kind !== 'pluginEvent' || !('sourceInstanceId' in source)) throw new Error('Expected configured source');
        const evidence = AutomationRunPluginEventTriggerEvidenceV1Schema.parse({ v: 1, kind: 'pluginEvent', eventRef: source.eventRef,
            sourceSelectorId: '11111111-1111-4111-8111-111111111111', occurrenceId: 'issue-1', occurredAt: 100,
            sourceInstanceId: source.sourceInstanceId, sourceContractVersion: 1, observationReceivedAt: 100,
            payload: {}, filter: { version: null, result: 'matched' } });
        const screen = await renderAccountScreen(entry === 'account'
            ? <NewAccountTriggerPopover anchorRef={React.createRef()} onRequestClose={() => undefined}
                eventSeed={{ eventRef: source.eventRef, setupInput: { project: '42' } }} />
            : <TriggerFromActivityEvent evidence={evidence} />);
        if (entry === 'activity') await screen.pressByTestIdAsync('automation-run-event-create-trigger');
        if (entry === 'account') {
            // Configure's validated output enters its real completion callback;
            // Save admission, Action dispatch and the HTTP persistence boundary stay real.
            await act(async () => {
                screen.findByType(PluginEventAutomationEditor).props.onComplete(source,
                    { observationOnly: { kind: 'observationOnly' } });
            });
            expect(screen.findByTestId('workflows-column-new-trigger-popover-then')).toBeNull();
            await screen.pressByTestIdAsync('workflows-column-new-trigger-popover-submit');
            await waitForHomeGovernance(() => expect(rows).toHaveLength(1));
        } else {
            let operation!: Promise<void>;
            await act(async () => {
                operation = screen.findByType(TriggerPopover).props.onSubmit({ enabled: true,
                    when: { kind: 'pluginEvent', value: source, observationOnly: { kind: 'observationOnly' } },
                    then: { kind: 'sendPrompt', prompt: '' } }, {
                    target: null, trigger: source, inputs: {}, observationOnly: { kind: 'observationOnly' },
                });
            });
            await act(async () => { await operation; });
        }
        expect(rows).toHaveLength(1);
        expect(rows[0]?.observationOnly).toEqual({ kind: 'observationOnly', templateVersion: 1 });
        expect(rows[0]?.executionRecipe).toBeUndefined();
        expect(rows[0]?.assignments).toEqual([]);
        const { createAutomationDefinitionFromDetail } = await import('@/sync/domains/automations/automationDefinitionProjection');
        const { readPluginEventAutomationEditSeed } = await import('@/sync/domains/automations/pluginEventAutomationEditSeed');
        const saved = rows[0]!;
        expect(readPluginEventAutomationEditSeed(createAutomationDefinitionFromDetail(saved), saved.triggers[0]!.id,
            { mode: 'plain' })).toMatchObject({ source: { observationOnly: { kind: 'observationOnly' },
                sourceConfig: source.sourceConfig }, observation: { kind: 'checkpointedPull',
                watcherMaterializationRef: source.observationTransport.kind === 'checkpointedPull' ? source.observationTransport.watcherMaterializationRef : null } });
        const id = rows[0]!.id;
        await screen.unmount();

        const reopened = await renderAccountScreen(<AccountTriggersSection />);
        await waitForHomeGovernance(() => expect(reopened.findByTestId(`workflows-column:trigger:${id}`)).not.toBeNull());
        await reopened.pressByTestIdAsync(`workflows-column:trigger:${id}`);
        const editor = reopened.findByType(TriggerPopover);
        expect(editor.props.initial).toMatchObject({ kind: 'observationOnly', when: {
            kind: 'pluginEvent', observationOnly: { kind: 'observationOnly' }, eventRef: source.eventRef,
        } });
        let update!: Promise<void>;
        await act(async () => {
            update = editor.props.onSubmit({ enabled: true, when: { kind: 'pluginEvent', value: source,
                observationOnly: { kind: 'observationOnly' } }, then: { kind: 'sendPrompt', prompt: '' } }, {
                trigger: { ...source, displayLabel: 'Edited issues' }, target: null, inputs: {}, observationOnly: { kind: 'observationOnly' },
            });
        });
        await act(async () => { await update; });
        expect(rows[0]?.observationOnly).toEqual({ kind: 'observationOnly', templateVersion: 2 });
        expect(rows[0]?.executionRecipe).toBeUndefined();
        expect(rows[0]?.assignments).toEqual([]);
        expect(writes().at(-1)?.triggers[0]).toMatchObject({ kind: 'existing', triggerId: rows[0]?.triggers[0]?.id });
    });


    it('settles acknowledged trigger creation while the unrelated Automation listing refresh is pending', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl(getActiveServerSnapshot().serverUrl);
        if (!credentials) throw new Error('Account credential fixture required');
        const connection = await restoreServerAccountForTest({ serverUrl: getActiveServerSnapshot().serverUrl,
            accountId: 'account-a', credentials, request: home.request });
        const revalidation = createDeferred<void>();
        let listingRequested = false;
        listReply = async () => { listingRequested = true; await revalidation.promise; return listRows(); };
        const set = fixture();
        const screen = await renderAccountScreen(<NewAccountTriggerPopover anchorRef={React.createRef()} onRequestClose={() => undefined} />);
        let operation!: Promise<void>;
        let settled = false;
        try {
            await act(async () => screen.findByType(TriggerRunsOnRow).props.onChange(project));
            const value = { enabled: true, sessionId: null,
                when: { kind: 'schedule' as const, schedule: null, expression: '0 9 * * *', timezone: null },
                then: { kind: 'sendPrompt' as const, prompt: 'Morning digest' } };
            await act(async () => {
                operation = screen.findByType(TriggerPopover).props.onSubmit(value, {
                    target: set.target!, trigger: buildTriggerDefinition(value), inputs: {},
                }).then(() => { settled = true; });
            });
            await confirmAction(screen);
            await waitForHomeGovernance(() => expect(listingRequested).toBe(true));
            expect(rows).toHaveLength(1);
            expect(storage.getState().workflowTriggerSetsById[rows[0]!.id]).toMatchObject({ revision: 1 });
            await act(async () => { await Promise.resolve(); });
            expect(settled).toBe(true);
        } finally {
            revalidation.resolve();
            await operation;
            await screen.unmount();
            await connection.dispose();
        }
    });

    it('leaves the trigger count unknown until the first read succeeds', async () => {
        const read = createDeferred<void>();
        listReply = async () => { await read.promise; return listRows(); };
        const screen = await renderAccountScreen(<AccountTriggersSection first />);
        const headingText = () => screen.findByTestId('workflows-column:group:triggers')!
            .findAll(node => typeof node.type === 'string')
            .flatMap(node => node.children.filter(child => typeof child === 'string' || typeof child === 'number').map(String));
        expect(screen.findByTestId('account-triggers-read')).not.toBeNull();
        expect(headingText()).not.toContain('0');
        serve(fixture());
        await act(async () => read.resolve());
        expect(headingText()).toContain('1');
        expect(screen.findByTestId('account-triggers-read')).toBeNull();
    });
    it('draws nothing between other sections until it is known that triggers exist (DESIGN-14 D12)', async () => {
        const read = createDeferred<void>();
        listReply = async () => { await read.promise; return listRows(); };
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        expect(screen.findByTestId('workflows-column:group:triggers')).toBeNull();
        expect(screen.findByTestId('account-triggers-read')).toBeNull();
        serve(fixture());
        await act(async () => read.resolve());
        expect(screen.findByTestId('workflows-column:group:triggers')).not.toBeNull();
    });
    it.each([true, false])('keeps a retained encrypted trigger paused until its device review is explicitly saved (trigger enabled: %s)', async (triggerEnabled) => {
        const retained = fixture(true, [{ ...trigger('t1'), enabled: triggerEnabled }]);
        const paused = WorkflowTriggerSetV1Schema.parse({ ...retained, enabled: false,
            health: 'source_unavailable', target: undefined,
            legacy: { editable: false, reason: 'created_in_0_2', lockedReason: 'review_required' } });
        serve(WorkflowTriggerSetV1Schema.parse({ ...paused, placements: [project, { machineId: 'm2', directory: '/repo' }] }));
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        const toggle = screen.findByTestId('workflows-column:trigger:digest-switch');
        expect(toggle?.props.value).toBe(false);
        expect(toggle?.props.disabled).toBe(true);
        expect(home.requestsFor('/v2/sessions/session-old?accessProjectionVersion=1')).toHaveLength(0);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        expect(home.requestsFor('/v2/sessions/session-old?accessProjectionVersion=1')).toHaveLength(1);
        expect(writes()).toHaveLength(0);
        expect(storage.getState().workflowTriggerSetsById['digest']).toMatchObject({
            enabled: false, health: 'source_unavailable', legacy: { lockedReason: 'review_required' },
        });
        expect(storage.getState().workflowTriggerSetsById['digest']?.target).toBeUndefined();
        expect(screen.findByTestId('workflows-column-trigger-popover-toggle')).toBeNull();
        expect(screen.findByTestId('workflows-column-trigger-popover-run-now')).toBeNull();
        await act(async () => screen.changeTextByTestId('workflows-column-trigger-popover-prompt', 'Reviewed prompt'));
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        await confirmAction(screen);
        expect(writes()).toMatchObject([{ expectedTemplateVersion: 1, enabled: true,
            triggers: [{ kind: 'existing', triggerId: 't1', expectedRevision: 1, enabled: triggerEnabled }] }]);
        expect(writtenContext(writes()[0]!)).toMatchObject({ inlineDefinition: { blocks: [{ document: { text: 'Reviewed prompt' } }] } });
    });
    it('keeps a failed retained-template review locked and performs no workflow write', async () => {
        const paused = WorkflowTriggerSetV1Schema.parse({ ...fixture(true), enabled: false,
            health: 'source_unavailable', target: undefined,
            legacy: { editable: false, reason: 'created_in_0_2', lockedReason: 'review_required' } });
        serve(paused);
        home.answer(serverId, '/v2/sessions/session-old', { status: 404, body: { error: 'session_not_found' } });
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        expect(writes()).toHaveLength(0);
        expect(screen.findByTestId('workflows-column-trigger-popover')).toBeNull();
        expect(screen.findByTestId('workflows-column:trigger:digest')).not.toBeNull();
        expect(screen.findByType(WebAlertModal).props.config).toMatchObject({
            type: 'alert', title: 'workflows.triggers.legacy.reviewRequired',
            buttons: [{ style: 'cancel' }, { style: 'destructive' }],
        });
        await screen.pressByTestIdAsync('web-modal-button-1');
        await confirmAction(screen);
        expect(screen.findAllByType(WebAlertModal).length).toBe(0);
        await waitForHomeGovernance(() => expect(storage.getState().workflowTriggerSetsById.digest?.triggers).toEqual([]));
        expect(mutations).toMatchObject([{ automationId: 'digest', input: { removedTriggers: [{ triggerId: 't1', expectedRevision: 1 }], triggers: [] } }]);
        expect(rows[0]?.templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
        expect(storage.getState().workflowTriggerSetsById.digest?.triggers).toEqual([]);
        expect(writes()).toHaveLength(0);
    });
    it('reserves no blank status slot around retained rows, and states a failed refresh under them', async () => {
        const set = fixture();
        storage.getState().upsertWorkflowTriggerSet({ queryKey: 'account_inline', set });
        const read = createDeferred<void>();
        listReply = async () => { await read.promise; throw new Error('Down'); };
        // This failure is settled; a Home still being connected keeps a failed read as loading.
        storage.setState({ endpointStatus: 'offline' });
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        // Refreshing retained rows says nothing: no reserved line, no status above the rows.
        expect(screen.findByTestId('account-triggers-read-slot')).toBeNull();
        expect(screen.findByTestId('account-triggers-read')).toBeNull();
        expect(screen.findByTestId('workflows-column:trigger:digest')).not.toBeNull();
        await act(async () => read.resolve());
        expect(screen.findByTestId('workflows-column:trigger:digest')).not.toBeNull();
        const text = screen.getTextContent();
        expect(text.indexOf('workflows.triggers.section.accountLoadFailed')).toBeGreaterThan(text.indexOf('Morning digest'));
    });
    it('reads a column trigger as "{when}" over what it runs, led by its event glyph', async () => {
        serve(fixture());
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        const text = screen.getTextContent();
        // The person's display locale owns the clock format, not the editor's 24-hour input.
        const whenAt = text.indexOf('workflows.triggers.summary.everyDayAt(');
        expect(whenAt).toBeGreaterThanOrEqual(0);
        expect(whenAt).toBeLessThan(text.indexOf('Morning digest'));
        expect(screen.findAll((node) => node.props.name === 'clock').length).toBeGreaterThan(0);
    });
    it('enables an off set through one selected-trigger Action instead of first enabling every schedule', async () => {
        const set = { ...fixture(false, [trigger('t1'), trigger('t2', 19)]), enabled: false }; serve(set);
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await act(async () => screen.findByTestId('workflows-column:trigger:digest:t2-switch')?.props.onValueChange(true));
        await confirmAction(screen);
        expect(writes()).toMatchObject([{ expectedTemplateVersion: 1, enabled: true, triggers: [
            { kind: 'existing', triggerId: 't1', expectedRevision: 1, enabled: false },
            { kind: 'existing', triggerId: 't2', expectedRevision: 1, enabled: true },
        ] }]);
        expect(rows[0]!.triggers.map(value => value.enabled)).toEqual([false, true]);
    });
    it('removes only the reviewed locked schedule without converting its legacy template', async () => {
        const set = WorkflowTriggerSetV1Schema.parse({ ...fixture(true, [trigger('t1'), trigger('t2', 19)]),
            health: 'source_unavailable', target: undefined,
            legacy: { editable: false, reason: 'created_in_0_2', lockedReason: 'session_key_required' } });
        serve(WorkflowTriggerSetV1Schema.parse({ ...set, enabled: false, legacy: { ...set.legacy, lockedReason: 'review_required' } }));
        home.answer(serverId, '/v2/sessions/session-old', { status: 404, body: { error: 'session_not_found' } });
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest:t2');
        expect(writes()).toHaveLength(0);
        expect(screen.findByType(WebAlertModal).props.config).toMatchObject({
            type: 'alert', buttons: [{ style: 'cancel' }, { style: 'destructive' }],
        });
        await screen.pressByTestIdAsync('web-modal-button-1');
        await confirmAction(screen);
        expect(screen.findAllByType(WebAlertModal).length).toBe(0);
        await waitForHomeGovernance(() => expect(storage.getState().workflowTriggerSetsById.digest?.triggers.map(value => value.id)).toEqual(['t1']));
        expect(mutations).toMatchObject([{ automationId: 'digest', input: { removedTriggers: [{ triggerId: 't2', expectedRevision: 1 }],
            triggers: [{ kind: 'existing', triggerId: 't1', expectedRevision: 1 }] } }]);
        expect(rows[0]?.templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
        expect(writes()).toHaveLength(0);
    });
    it('reviews legacy toggles before converting and keeps a cancelled change untouched', async () => {
        const set = fixture(true); serve(set);
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        const toggle = screen.findByTestId('workflows-column:trigger:digest-switch');
        await act(async () => toggle?.props.onValueChange(false));
        expect(writes()).toHaveLength(0);
        expect(screen.findByType(WebAlertModal).props.config).toMatchObject({
            type: 'confirm', title: 'workflows.triggers.legacy.editNotice',
            message: 'workflows.triggers.legacy.conversionBoundary', confirmText: 'workflows.triggers.popover.turnOff',
        });
        await screen.pressByTestIdAsync('web-modal-cancel');
        await waitForHomeGovernance(() => expect(screen.findAllByType(WebAlertModal).length).toBe(0));
        expect(writes()).toHaveLength(0);
        expect(rows[0]!.triggers[0]!.enabled).toBe(true);
        expect(toggle?.props.disabled).toBe(false);
        await act(async () => toggle?.props.onValueChange(false));
        expect(writes()).toHaveLength(0);
        await screen.pressByTestIdAsync('web-modal-confirm');
        await confirmAction(screen);
        expect(screen.findAllByType(WebAlertModal).length).toBe(0);
        await waitForHomeGovernance(() => expect(writes()).toHaveLength(1));
        expect(writes()).toMatchObject([{ expectedTemplateVersion: 1, triggers: [{ kind: 'existing', triggerId: 't1', expectedRevision: 1, enabled: false }] }]);
        expect(rows[0]!.triggers[0]!.enabled).toBe(false);
    });
    it('toggles the trigger through its Action and edits Runs on through the same writer', async () => {
        const set = fixture(false, [trigger('t1'), trigger('t2', 19)]); serve(set);
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        const toggle = screen.findByTestId('workflows-column:trigger:digest:t2-switch');
        expect(toggle).not.toBeNull();
        await act(async () => toggle?.props.onValueChange(false));
        await confirmAction(screen);
        expect(writes()).toMatchObject([{ expectedTemplateVersion: 1, triggers: [
            { kind: 'existing', triggerId: 't1', expectedRevision: 1 },
            { kind: 'existing', triggerId: 't2', expectedRevision: 1, enabled: false },
        ] }]);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest:t2');
        const runsOn = screen.findAllByType(TriggerRunsOnRow)[0];
        expect(runsOn).toBeDefined();
        await act(async () => runsOn?.props.onChange({ machineId: 'm2', directory: '/elsewhere' }));
        await act(async () => screen.changeTextByTestId('workflows-column-trigger-popover-prompt', 'Changed prompt'));
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        await confirmAction(screen);
        expect(writes().at(-1)).toMatchObject({ expectedTemplateVersion: 2, assignments: [{ machineId: 'm2' }], triggers: [
            { kind: 'existing', triggerId: 't1', expectedRevision: 1 },
            { kind: 'existing', triggerId: 't2', expectedRevision: 2,
                trigger: { kind: 'schedule', schedule: { scheduleExpr: '0 19 * * *' } } },
        ] });
        expect(rows[0]?.triggers[0]).toMatchObject({ id: 't1', revision: 1, enabled: true });
        expect(writtenContext(writes().at(-1)!)).toMatchObject({ workspace: { directory: '/elsewhere' },
            inlineDefinition: { blocks: [{ document: { text: 'Changed prompt' } }] } });
    });

    it('edits the selected schedule of a multi-trigger legacy set with conversion disclosed and refusal preserving the draft', async () => {
        // A retained Automation can have an assignment that differs from its
        // authenticated existing Session. The real conversion owner refuses
        // that conversation, before any rewrite of the retained template.
        const set = { ...fixture(true, [trigger('t1'), trigger('t2', 19)]),
            project: { machineId: 'm2', directory: '/repo' } }; serve(set);
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest:t2');
        expect(writes()).toEqual([]);
        expect(screen.getTextContent()).toContain('workflows.triggers.legacy.editNotice');
        expect(screen.getTextContent()).toContain('workflows.triggers.legacy.conversionBoundary');
        expect(screen.findAll((node) => node.props.accessibilityLabel === 'workflows.triggers.popover.at'
            && node.props.value === '19:00').length).toBeGreaterThan(0);
        await act(async () => screen.changeTextByTestId('workflows-column-trigger-popover-prompt', 'Changed prompt'));
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        await confirmAction(screen);
        expect(writes()).toEqual([]);
        expect(rows[0]).toMatchObject({ templateVersion: 1, templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN,
            triggers: [{ id: 't1', revision: 1 }, { id: 't2', revision: 1 }] });
        expect(screen.findByTestId('workflows-column-trigger-popover-prompt')?.props.value).toBe('Changed prompt');
        expect(screen.getTextContent()).toContain('workflows.problem.legacyConversionUnsupported');
        expect(storage.getState().workflowTriggerSetsById.digest?.revision).toBe(1);
    });

    it('keeps a manual legacy row manual when its prompt is edited', async () => {
        const set = fixture(true, []); serve(set);
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        expect(screen.findByTestId('workflows-column-trigger-popover-run-now')).not.toBeNull();
        await act(async () => screen.changeTextByTestId('workflows-column-trigger-popover-prompt', 'Manual edit'));
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        await confirmAction(screen);
        expect(writes()).toHaveLength(1);
        expect(writes()[0]!.triggers).toEqual([]);
        expect(writes()[0]!.removedTriggers).toEqual([]);
    });
    it('deletes a manual set with no triggers through whole-set removal and refreshes', async () => {
        const set = fixture(false, []); serve(set);
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        const remove = screen.findByTestId('workflows-column-trigger-popover-delete');
        expect(remove).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.triggers.popover.deleteTriggerSet');
        const listsBefore = listRequests().length;
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-delete');
        await confirmAction(screen);
        expect(rows).toEqual([]);
        expect(storage.getState().workflowTriggerSetsById.digest).toBeUndefined();
        expect(listRequests().length).toBeGreaterThan(listsBefore);
    });
    it('opens a legacy deep link without writing and retains an opened draft across refreshes', async () => {
        const set = fixture(true); serve(set);
        routeState.params = { trigger: 'digest' };
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        expect(screen.findByTestId('workflows-column-trigger-popover-prompt')).not.toBeNull();
        expect(writes()).toHaveLength(0);
        await act(async () => screen.changeTextByTestId('workflows-column-trigger-popover-prompt', 'My draft'));
        await act(async () => storage.getState().upsertWorkflowTriggerSet({ queryKey: 'account_inline', set: { ...set, revision: 3 } }));
        rows = rows.map(value => ({ ...value, templateVersion: 3 }));
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        expect(writes()).toEqual([]);
        expect(rows[0]!.templateVersion).toBe(3);
        expect(screen.findByTestId('workflows-column-trigger-popover-prompt')?.props.value).toBe('My draft');
    });
    it('saves a manual Automation as a workflow without fabricating a trigger identity', async () => {
        const set = fixture(true, []); serve(set);
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-save-as-workflow');
        expect(writes()).toHaveLength(0);
        const { readTriggerWorkflowSeed, retargetTriggerToWorkflow } = await import('./triggerWorkflowSeed');
        const seedId = routerPush.mock.calls[0]?.[0]?.params.triggerWorkflowSeedId;
        const seed = readTriggerWorkflowSeed(seedId);
        expect(seed?.retarget).not.toHaveProperty('triggerId');
        if (!seed) throw new Error('expected a reviewed draft seed');
        const definitionId = '11111111-1111-4111-8111-111111111111';
        await home.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: definitionId,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(WorkflowDefinitionArtifactHeaderV1Schema.parse({ kind: 'workflow-definition.v1', definitionId,
                revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved copy' } })),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(WorkflowDefinitionArtifactBodyV1Schema.parse({
                kind: 'workflow-definition.v1', definition: seed.definition,
            })) }),
        }) });
        let retarget!: Promise<void>;
        await act(async () => { retarget = retargetTriggerToWorkflow(seed.retarget, '11111111-1111-4111-8111-111111111111'); });
        await confirmAction(screen);
        await act(async () => { await retarget; });
        expect(writes()[0]).toMatchObject({ expectedTemplateVersion: 1,
            workflowDefinitionId: '11111111-1111-4111-8111-111111111111', triggers: [], removedTriggers: [] });
    });
});
