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
    createAutomationPluginEventTriggerDefinitionV1, sealAutomationTriggerDefinitionStoredEnvelopeV1} from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { AutomationTriggerIdSchema} from '@happier-dev/protocol/automations/automationTriggerIdentity';
import {
    type AutomationTriggerDefinitionInput} from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationEventJsonBoundsV1';
import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { selectWorkflowAutomationDetailsFixture, selectWorkflowAutomationListFixture } from '@/dev/testkit/harness/workflowAutomationHttpBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN } from '../../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import capturedBuiltinTriggerSet from './builtinTriggerSet.testFixture.json';

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

const { AccountTriggersSection, NewAccountTriggerPopover, useAccountWorkflowEditor } = await import('./AccountTriggersSection');
const { useWorkflowLibraryView, workflowLibraryRowTitle } = await import('../library/useWorkflowLibraryView');
const { formatTriggerSetSentence, formatTriggerSetSummary } = await import('./formatTriggerSummary');
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
    if (value.kind === 'runLifecycle') return AutomationTriggerDetailSchema.parse({ ...value, id, revision,
        createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null,
        remainingOccurrences: 1, status: { state: 'waiting', runId: null } });
    if (value.kind === 'action' && 'triggerDefinitionEnvelope' in value) return AutomationTriggerDetailSchema.parse({
        ...value, id, revision, createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: JSON.stringify(value.triggerDefinitionEnvelope) });
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
            definition: createAutomationPluginEventTriggerDefinitionV1(value) })) });
}
function fixture(legacy = false, triggers = [trigger('t1')]) {
    return WorkflowTriggerSetV1Schema.parse({ automationId: 'digest', revision: 1, enabled: true,
        health: 'available', project, ...(legacy ? { legacy: { editable: false, reason: 'created_in_0_2' } } : {}),
        target: { kind: 'inline', definition: { version: 1,
            defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
            blocks: [{ kind: 'step', id: 'first', name: 'Morning digest',
            document: { text: 'Morning digest', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
        triggers });
}
let previous = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
let serverId: string;
let disposeLoader: (() => void) | undefined;
let syncLoader: Awaited<ReturnType<typeof loadSyncSingletonForTests>>;
let sourceIntakeConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
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
    installDisconnectedServerSocketBoundary();
    previous = storage.getState();
    previousSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    publishAppliedActiveServerRuntimeAvailability(false);
    resetTriggerSets();
    await home.reset();
    installHomeGovernanceBoundaries(httpBoundary);
    syncLoader = await loadSyncSingletonForTests();
    disposeLoader = await installRealActionExecutorModuleLoader();
    const { withAccountE2eeCustody } = await import('@/auth/storage/tokenStorage');
    const { encodeBase64 } = await import('@/encryption/base64');
    const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
    // Persist the same retained Session custody that concurrent Action readers admit.
    const credentials = withAccountE2eeCustody({ token: createAccountTokenForTests('account-a', { currentAccount: true }),
        secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') }, 'historical');
    serverId = await home.addHome({ name: 'Account triggers', serverUrl: `https://account-trigger-${crypto.randomUUID()}.test`,
        accountId: 'account-a', currentAccount: true, credentials });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    // Trigger custody resolves the selected Machine's current Account access at HTTP admission.
    home.answer(serverId, `/v1/machines/${project.machineId}`, {
        body: { machine: createPlainMachineRowFixture({ id: project.machineId, accountId: 'account-a' }) },
    });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' },
        sessions: { 'session-old': createSessionFixture({ id: 'session-old', serverId, encryptionMode: 'e2ee', active: false,
            metadata: { path: '/repo', host: 'test', homeDir: '/home/test', machineId: 'm1', flavor: 'claude', permissionMode: 'default' } }) },
        workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {} });
    // Match this Home's empty settings baseline so collection filters have an admitted Account snapshot.
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsDefaults, 0);
    // This plain Account retains predecessor Session keys as history, not active Account authority.
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
            triggers: input.triggers.map(value => storedTrigger(input.automationId, value.triggerId, 0, value.trigger)) });
        rows = [...rows, row];
        installRow(row.id);
        return { body: row };
    } });
    routerPush.mockReset();
    routeState.params = {};
});
afterEach(async () => {
    await standardCleanup();
    await sourceIntakeConnection?.dispose();
    sourceIntakeConnection = undefined;
    legacyRead.resolve();
    publishAppliedActiveServerRuntimeAvailability(false);
    resetTriggerSets();
    (await import('../library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    await home.reset();
    disposeLoader?.();
    syncLoader?.dispose();
    storage.setState(previous);
    publishAppliedActiveServerSnapshot(previousSnapshot, previousRuntimeAvailable);
});
function serve(set: ReturnType<typeof fixture>) {
    const row = AutomationDefinitionDetailSchema.parse({ id: set.automationId, name: 'Morning digest', description: null,
        enabled: set.enabled, workflowDefinitionId: set.target?.kind === 'workflow' ? set.target.ref : null, scopeSessionId: set.scopeSessionId ?? null, templateVersion: set.revision,
        targetType: set.legacy ? 'existingSession' : null, existingSessionId: set.legacy ? 'session-old' : null,
        lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: (set.placements ?? [set.project ?? project]).map(value => ({ machineId: value.machineId,
            enabled: true, priority: 0, updatedAt: 1 })), triggers: set.triggers,
        ...(set.legacy ? { templateCiphertext: set.legacy.lockedReason ? AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED : AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN } : {
            executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: set.revision,
                workflow: { t: 'plain', v: { workspace: { directory: set.project?.directory ?? '/repo' }, executionTarget: set.context?.executionTarget ?? { kind: 'session' },
                    ...(set.target?.kind === 'inline' ? { inlineDefinition: set.target.definition } : {}) } }, triggerEvidence: null }),
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
function listRequests() {
    return home.requests.filter(request => (request.method === 'GET' && request.path.startsWith('/v3/automations?'))
        || (request.method === 'POST' && request.path === '/v3/automations/query'));
}
function writtenContext(input: ReturnType<typeof AutomationDefinitionReconcileRequestSchema.parse>) {
    if (input.executionRecipe?.v !== 2 || input.executionRecipe.workflow.t !== 'plain') throw new Error('Expected a canonical plain recipe');
    return input.executionRecipe.workflow.v;
}

// The retained Account adapter below exercises settings, source intake and legacy
// links. Primary Library presentation consumes the unified view tested alongside it.
describe('Account Workflow Library and settings', () => {
    it.each(['account', 'session', 'session-cold'] as const)('hydrates only an interacted selected attachment and uses its set revision through the mounted shared section (%s)', async scope => {
        const { useResourceAutomationsSection } = await import('./useResourceAutomationsSection');
        const { SubjectTriggersSectionContent } = await import('./SubjectTriggersSection');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const sessionId = 'session-selected';
        if (scope !== 'account') storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId,
            active: false, encryptionMode: 'plain', metadataLayoutVersion: 1,
            metadata: { name: 'Selected Session' } as ReturnType<typeof createSessionFixture>['metadata'],
            ownerMetadataView: { path: '/repo', host: 'test', homeDir: '/home/test', machineId: project.machineId, flavor: 'claude' } })]);
        const set = WorkflowTriggerSetV1Schema.parse({ ...fixture(), revision: 7,
            ...(scope !== 'account' ? { scopeSessionId: sessionId } : {}),
            triggers: [{ ...trigger('t1'), nextRunAt: 123 }] });
        serve(set);
        if (scope !== 'account') {
            rows = [AutomationDefinitionDetailSchema.parse({ ...rows[0], id: 'other-habit' }), ...rows];
            installRow('other-habit');
        }
        const subject = scope !== 'account' ? { kind: 'session' as const, serverId, sessionId }
            : { kind: 'machine' as const, serverId, machineId: project.machineId };
        const selected = { automationId: set.automationId, triggerId: 't1', workflowDefinitionId: null,
            relation: 'direct' as const, enabled: true, revision: 1,
            summary: { kind: 'schedule' as const, schedule: trigger('t1').schedule },
            setUpBy: { accountId: 'account-a', displayName: 'Owner' } };
        const exactReads = () => home.requests.filter(request => request.method === 'GET'
            && request.path === `/v3/automations/${set.automationId}`);
        const lifetimePage = createDeferred<void>();
        if (scope !== 'session-cold') lifetimePage.resolve();
        home.answer(serverId, 'POST /v3/automations/query', { select: async input => {
            // Both the Session page and the existing Account destination census can
            // hold this body. Keep both cold until the person opens its selected row.
            if (input !== null && typeof input === 'object' && 'details' in input && input.details === true) await lifetimePage.promise;
            const saved = rows.find(row => row.id === set.automationId);
            const savedTrigger = saved?.triggers.find(trigger => trigger.id === selected.triggerId);
            if (!saved || !savedTrigger) throw new Error('Expected the persisted selected trigger');
            return { body:
            input !== null && typeof input === 'object' && 'subject' in input
                ? AutomationDefinitionListResponseSchema.parse({ automations: [], attached: [{ ...selected,
                    enabled: saved.enabled && savedTrigger.enabled, revision: savedTrigger.revision }], nextCursor: null, skippedNotSharedCount: 0 })
                : input !== null && typeof input === 'object' && 'details' in input && input.details === true
                    ? selectWorkflowAutomationDetailsFixture(rows, input) : selectWorkflowAutomationListFixture(rows, input),
            };
        } });
        let current!: ReturnType<typeof useResourceAutomationsSection>;
        function SharedSection() {
            current = useResourceAutomationsSection({ subject });
            return <SubjectTriggersSectionContent subject={subject} subjectName="Selected resource" automations={current} />;
        }
        const screen = await renderAccountScreen(<PluginSurfaceFocusEligibilityProvider active><SharedSection /></PluginSurfaceFocusEligibilityProvider>);
        await waitForHomeGovernance(() => expect(current.rows).toHaveLength(1));
        if (scope === 'session') await waitForHomeGovernance(() => expect(current.session?.sets).toHaveLength(2));
        if (scope === 'session-cold') expect(current.session?.sets).toEqual([]);
        expect(exactReads()).toEqual([]);
        expect(current.read.sets).toEqual([]);
        await screen.pressByTestIdAsync(`subject-triggers:${set.automationId}:t1`);
        await act(async () => lifetimePage.resolve());
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflows-column-trigger-popover-toggle'),
            JSON.stringify({ writes: writes().length, text: screen.getTextContent() })).not.toBeNull());
        expect(current.editor.popover?.props.set).toMatchObject({ automationId: set.automationId, revision: 7 });
        expect(exactReads()).toHaveLength(scope === 'account' ? 1 : 0);
        expect(Object.hasOwn(storage.getState().workflowTriggerSetIdsByQuery, '')).toBe(false);
        await act(async () => current.editor.popover?.props.onHistory());
        expect(current.editor.popover?.props.pushedPage.content.props.nextRunAt).toBe(123);
        await act(async () => current.editor.popover?.props.pushedPage.onBack());
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-toggle');
        await waitForHomeGovernance(() => {
            expect(writes()).toHaveLength(1);
            expect(current.editor.pending.size).toBe(0);
            expect(current.rows[0]?.off).toBe(true);
            expect(screen.findByTestId('workflows-column-trigger-popover')).toBeNull();
        });
        expect(writes()).toMatchObject([{ expectedTemplateVersion: 7 }]);
        expect(rows.find(row => row.id === set.automationId)?.triggers[0]?.enabled).toBe(false);
        if (scope !== 'account') expect(rows.find(row => row.id === 'other-habit')?.triggers[0]?.enabled).toBe(true);
        expect(home.requests.filter(request => request.method === 'GET' && request.path.startsWith('/v3/automations?'))).toEqual([]);
        await screen.unmount();
    });

    it.each([false, true])('names a selected saved Workflow without hydrating its trigger set or opening the picker (addressed=%s)', async (addressed) => {
        const { useResourceAutomationsSection } = await import('./useResourceAutomationsSection');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        const definitionId = '11111111-1111-4111-8111-111111111111';
        try {
            const target = fixture().target;
            if (target?.kind !== 'inline') throw new Error('Expected an inline fixture Workflow');
            await account.createArtifactDocument({ artifactId: definitionId,
                header: WorkflowDefinitionArtifactHeaderV1Schema.parse({ kind: 'workflow-definition.v1', definitionId,
                    revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Release readiness' } }),
                body: JSON.stringify(WorkflowDefinitionArtifactBodyV1Schema.parse({
                    kind: 'workflow-definition.v1', definition: target.definition,
                })) });
            home.answer(serverId, 'POST /v3/automations/query', { body: AutomationDefinitionListResponseSchema.parse({
                automations: [], attached: [{ automationId: 'selected-saved', triggerId: 'before', workflowDefinitionId: definitionId,
                    relation: 'direct', enabled: true, revision: 1,
                    summary: { kind: 'action', phase: 'before', actionIds: ['session.archive'] },
                    setUpBy: { accountId: 'account-a', displayName: 'Owner' } }],
                nextCursor: null, skippedNotSharedCount: 0,
            }) });
            if (addressed) {
                const focusedServerId = await home.addHome({ name: 'Other focus',
                    serverUrl: `https://selected-title-${crypto.randomUUID()}.test`, accountId: 'account-b' });
                publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
                storage.setState({ profileScope: { serverId: focusedServerId, accountId: 'account-b' },
                    settingsScope: { serverId: focusedServerId, accountId: 'account-b' } });
            }
            const hook = await renderHook(() => useResourceAutomationsSection({
                subject: { kind: 'machine', serverId, machineId: project.machineId }, accountLifetime: account.accountLifetime,
            }), { wrapper: ({ children }) => <PluginSurfaceFocusEligibilityProvider active>{children}</PluginSurfaceFocusEligibilityProvider> });
            await waitForHomeGovernance(() => expect(hook.getCurrent().rows[0]?.subtitle).toContain('Release readiness'));
            expect(hook.getCurrent().read.sets).toEqual([]);
            expect(home.requests.filter(request => request.path === '/v3/automations/selected-saved')).toEqual([]);
            await hook.unmount();
        } finally { account.dispose(); }
    });

    it('reads Action attachments through the shared selected controller with paging and phase changes', async () => {
        const { useActionAutomationsSection } = await import('./useResourceAutomationsSection');
        const { WorkflowAttachedTriggerPageV1Schema } = await import('@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime();
        const page = WorkflowAttachedTriggerPageV1Schema.parse({ attached: [
            { automationId: 'action-check', triggerId: 'direct', workflowDefinitionId: 'builtin:review-and-converge',
                relation: 'direct', enabled: false, revision: 2, summary: { kind: 'action', phase: 'after', actionIds: ['session.archive'] },
                setUpBy: { accountId: 'account-a', displayName: 'Owner' } },
        ], nextCursor: 'next-action-page', skippedNotSharedCount: 2 });
        const requests: unknown[] = [];
        let failed = false;
        let presented = false;
        const initial = createDeferred<void>();
        home.answer(serverId, 'POST /v3/automations/query', { select: async input => {
            requests.push(input);
            await initial.promise;
            if (failed) return { status: 503, body: { error: 'database_transaction_timeout' } };
            const next = typeof input === 'object' && input !== null && 'cursor' in input;
            return { body: AutomationDefinitionListResponseSchema.parse({ automations: [], ...page,
                ...(next ? { attached: [{ ...page.attached[0]!, automationId: 'inline-action-check', workflowDefinitionId: null, triggerId: 'next' }], nextCursor: null } : {}) }) };
        } });
        const hook = await renderHook((props: { phase: 'before' | 'after' }) => useActionAutomationsSection({
            actionId: 'session.archive', phases: [props.phase], accountLifetime: lifetime,
        }), { initialProps: { phase: 'after' },
            wrapper: ({ children }) => <PluginSurfaceFocusEligibilityProvider active={presented}>{children}</PluginSurfaceFocusEligibilityProvider> });
        expect(hook.getCurrent().read.status).toBe('loading');
        expect(requests).toEqual([]);
        presented = true;
        await hook.rerender({ phase: 'after' });
        await act(async () => initial.resolve());
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).not.toBe('loading'));
        expect(home.requests.filter(request => request.method === 'GET' && request.path.startsWith('/v3/automations?'))).toEqual([]);
        expect(requests).toEqual([expect.objectContaining({ actionId: 'session.archive', phase: 'after' })]);
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).toBe('ready'));
        expect(hook.getCurrent().rows).toMatchObject([{ automationId: 'action-check', off: true }]);
        expect(hook.getCurrent().also).toEqual([]);
        expect(hook.getCurrent().skippedNotSharedCount).toBe(2);
        await hook.rerender({ phase: 'after' });
        expect(requests).toHaveLength(1);
        await act(async () => hook.getCurrent().read.loadMore());
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toHaveLength(2));
        expect(requests.at(-1)).toMatchObject({ actionId: 'session.archive', phase: 'after', cursor: 'next-action-page' });
        await hook.rerender({ phase: 'before' });
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toHaveLength(1));
        expect(requests.at(-1)).toMatchObject({ actionId: 'session.archive', phase: 'before' });
        expect(requests.at(-1)).not.toHaveProperty('cursor');
        const retained = hook.getCurrent().rows;
        failed = true;
        await act(async () => hook.getCurrent().read.retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).toBe('failed'));
        expect(hook.getCurrent().rows).toBe(retained);
        expect(requests).toHaveLength(4);
        expect(requests.every(input => typeof input === 'object' && input !== null && 'actionId' in input && !('subject' in input))).toBe(true);
    });

    it('reads the selected resource page without a census and retains direct, context and skipped facts across failure and Retry', async () => {
        const { useResourceAutomationsSection } = await import('./useResourceAutomationsSection');
        const { AutomationSubjectV1Schema } = await import('@happier-dev/protocol/automations/automationSubjectV1');
        const { WorkflowAttachedTriggerPageV1Schema } = await import('@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const subject = AutomationSubjectV1Schema.parse({ kind: 'machine', serverId, machineId: project.machineId });
        const context = AutomationSubjectV1Schema.parse({ kind: 'environment', serverId, environmentId: 'environment' });
        const page = WorkflowAttachedTriggerPageV1Schema.parse({ attached: [
            { automationId: 'saved-direct', triggerId: 'direct', workflowDefinitionId: 'builtin:review-and-converge',
                relation: 'direct', enabled: false, revision: 2, summary: { kind: 'schedule', schedule: trigger('direct').schedule },
                setUpBy: { accountId: 'account-a', displayName: 'Owner' } },
            { automationId: 'saved-context', triggerId: 'context', workflowDefinitionId: 'builtin:review-and-converge',
                relation: 'context', enabled: true, revision: 1, summary: { kind: 'schedule', schedule: trigger('context').schedule },
                setUpBy: { accountId: 'member', displayName: 'Member' } },
        ], nextCursor: 'next-selected-page', skippedNotSharedCount: 3 });
        const requests: unknown[] = [];
        let failed = true;
        let empty = true;
        home.answer(serverId, 'POST /v3/automations/query', { select: input => {
            requests.push(input);
            if (!failed && empty) return { body: AutomationDefinitionListResponseSchema.parse({ automations: [],
                attached: [], nextCursor: null, skippedNotSharedCount: 0 }) };
            if (!failed && typeof input === 'object' && input !== null && 'cursor' in input) return {
                body: AutomationDefinitionListResponseSchema.parse({ automations: [], attached: [
                    { ...page.attached[0]!, automationId: 'saved-next', triggerId: 'next' },
                ], nextCursor: null, skippedNotSharedCount: 3 }),
            };
            return failed ? { status: 503, body: { error: 'database_transaction_timeout' } }
                : { body: AutomationDefinitionListResponseSchema.parse({ automations: [], ...page }) };
        } });
        const hook = await renderHook((props: { subject: typeof subject }) => useResourceAutomationsSection({ subject: props.subject, contextSubjects: [context] }), {
            initialProps: { subject },
            wrapper: ({ children }) => <PluginSurfaceFocusEligibilityProvider active>{children}</PluginSurfaceFocusEligibilityProvider>,
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).not.toBe('loading'));
        expect(requests).toContainEqual(expect.objectContaining({ subject, contextSubjects: [context] }));
        expect(hook.getCurrent().read.status).toBe('failed');
        expect(hook.getCurrent().rows).toEqual([]);
        failed = false;
        await act(async () => hook.getCurrent().read.retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).toBe('ready'));
        expect(hook.getCurrent().rows).toEqual([]);
        expect(hook.getCurrent().also).toEqual([]);
        empty = false;
        await act(async () => hook.getCurrent().read.retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toHaveLength(1));
        expect(hook.getCurrent().rows).toMatchObject([{ automationId: 'saved-direct', off: true, attachment: { relation: 'direct' } }]);
        expect(hook.getCurrent().also).toMatchObject([{ automationId: 'saved-context', attachment: { relation: 'context' } }]);
        expect(hook.getCurrent().skippedNotSharedCount).toBe(3);
        await act(async () => hook.getCurrent().read.loadMore());
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toHaveLength(2));
        expect(hook.getCurrent().read.attachedPage?.nextCursor).toBeNull();
        expect(hook.getCurrent().skippedNotSharedCount).toBe(3);
        expect(requests).toContainEqual(expect.objectContaining({ subject, cursor: 'next-selected-page' }));
        const otherSubject = AutomationSubjectV1Schema.parse({ kind: 'machine', serverId, machineId: 'other-machine' });
        await hook.rerender({ subject: otherSubject });
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).toBe('ready'));
        expect(requests.at(-1)).toMatchObject({ subject: otherSubject });
        expect(requests.at(-1)).not.toHaveProperty('cursor');
        expect(hook.getCurrent().rows).toHaveLength(1);
        const retained = hook.getCurrent().rows;
        failed = true;
        await act(async () => hook.getCurrent().read.retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).toBe('failed'));
        expect(hook.getCurrent().rows).toBe(retained);
        expect(requests.every(input => typeof input === 'object' && input !== null && 'subject' in input)).toBe(true);
        await hook.unmount();
    });
    it('renders the selected facts: own rows switch, others and broader rows read-only with their author, a counted not-shared line and Show more', async () => {
        const { SubjectTriggersSection } = await import('./SubjectTriggersSection');
        const { WorkflowAttachedTriggerPageV1Schema } = await import('@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
        const row = (automationId: string, relation: 'direct' | 'context', accountId: string, displayName: string) => ({
            automationId, triggerId: automationId, workflowDefinitionId: 'builtin:review-and-converge', relation,
            enabled: true, revision: 1, summary: { kind: 'schedule', schedule: trigger(automationId).schedule },
            setUpBy: { accountId, displayName } });
        const page = WorkflowAttachedTriggerPageV1Schema.parse({ attached: [
            row('own', 'direct', 'account-a', 'Owner'), row('mara', 'direct', 'member', 'Mara'), row('broader', 'context', 'account-a', 'Owner'),
        ], nextCursor: 'more', skippedNotSharedCount: 1 });
        home.answer(serverId, 'POST /v3/automations/query', { select: () => ({
            body: AutomationDefinitionListResponseSchema.parse({ automations: [], ...page }) }) });
        const screen = await renderAccountScreen(<PluginSurfaceFocusEligibilityProvider active><ListPresentationProvider value="page">
            <SubjectTriggersSection subject={{ kind: 'machine', machineId: project.machineId }} serverId={serverId} subjectName="Studio" />
        </ListPresentationProvider></PluginSurfaceFocusEligibilityProvider>);
        await waitForHomeGovernance(() => expect(screen.findByTestId('subject-triggers:own:own')).not.toBeNull());
        // The viewer's own trigger keeps its switch; another person's and a broader trigger are read here, changed in their workflow.
        expect(screen.findByTestId('subject-triggers:own:own-switch')).not.toBeNull();
        expect(screen.findByTestId('subject-triggers:mara:mara')).toBeNull();
        expect(screen.findByTestId('subject-triggers-read-only:mara:mara')).not.toBeNull();
        expect(screen.findByTestId('subject-triggers-also')).not.toBeNull();
        expect(screen.findByTestId('subject-triggers-read-only:broader:broader')).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.triggers.section.setUpBy');
        expect(screen.getTextContent()).toContain('workflows.triggers.section.alsoRunsHere');
        expect(screen.findByTestId('subject-triggers-not-shared')).not.toBeNull();
        expect(screen.findByTestId('subject-triggers-more')).not.toBeNull();
        await act(async () => screen.findByTestId('subject-triggers-read-only:mara:mara')!.props.onPress());
        expect(routerPush).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: '/workflows/[id]',
            params: expect.objectContaining({ id: 'builtin:review-and-converge' }) }));
        await screen.unmount();
    });
    it('reviews a linked Workflow against the profile grant audience only when linking, and declines without writes', async () => {
        const { useResourceAutomationsSection } = await import('./useResourceAutomationsSection');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { ArtifactAccessGrantsListResponseV1Schema } = await import('@happier-dev/protocol/artifacts/artifactAccessV1');
        const subject = { kind: 'approvalProfile' as const, serverId, profileId: 'artifact-careful' };
        const principal = { kind: 'group' as const, teamId: 'studio', groupId: 'release' };
        const definitionId = '11111111-1111-4111-8111-111111111111';
        home.answer(serverId, 'POST /v3/automations/query', { body: AutomationDefinitionListResponseSchema.parse({
            automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0,
        }) });
        const profileGrants = `/v1/artifacts/${subject.profileId}/access/grants`;
        home.answer(serverId, `GET ${profileGrants}`, { body: ArtifactAccessGrantsListResponseV1Schema.parse({
            artifactId: subject.profileId, ownerAccountId: 'account-a', access: 'owner', grants: [
                { principal, accessLevel: 'view', createdByAccountId: 'account-a', createdAt: 1, display: { name: 'Release' } },
            ],
        }) });
        const workflowGrants = `/v1/artifacts/${definitionId}/access/grants`;
        const reviews: unknown[] = [];
        home.answer(serverId, `GET ${workflowGrants}`, { select: raw => {
            reviews.push(raw);
            return { body: ArtifactAccessGrantsListResponseV1Schema.parse({ artifactId: definitionId,
                ownerAccountId: 'account-a', access: 'owner', grants: [], missingAudience: [principal] }) };
        } });
        const hook = await renderHook(() => useResourceAutomationsSection({ subject }), {
            wrapper: ({ children }) => <PluginSurfaceFocusEligibilityProvider active>{children}</PluginSurfaceFocusEligibilityProvider>,
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).toBe('ready'));
        expect(home.requests.filter(request => request.path === profileGrants || request.path === workflowGrants)).toEqual([]);
        await act(async () => hook.getCurrent().link.setDraft({ workflow: definitionId,
            trigger: { kind: 'action', phase: 'after', enabled: true, actionIds: ['deployments.deploy'] } }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().audience).toEqual([
            { kind: 'account', accountId: 'account-a' }, principal,
        ]));
        await waitForHomeGovernance(() => expect(hook.getCurrent().link.missingAudience).toEqual([principal]));
        expect(reviews).toHaveLength(1);
        expect(hook.getCurrent().link.draft?.trigger).toMatchObject({ subject });
        await act(async () => { expect(await hook.getCurrent().link.submit('decline')).toEqual({ ok: false, phase: 'declined', shared: [] }); });
        expect(home.requests.filter(request => (request.path === profileGrants || request.path === workflowGrants) && request.method !== 'GET')).toEqual([]);
        expect(rows).toEqual([]);
        await hook.unmount();
    });

    it('reads a canonical profile subject as itself: its own sentence, no legacy starters, and the selected read', async () => {
        const { SubjectTriggersSection } = await import('./SubjectTriggersSection');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
        const requests: unknown[] = [];
        home.answer(serverId, 'POST /v3/automations/query', { select: input => {
            requests.push(input);
            return { body: AutomationDefinitionListResponseSchema.parse({ automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0 }) };
        } });
        const subject = { kind: 'approvalProfile' as const, serverId, profileId: 'artifact-careful' };
        const screen = await renderAccountScreen(<PluginSurfaceFocusEligibilityProvider active><ListPresentationProvider value="page">
            <SubjectTriggersSection subject={subject} subjectName="Careful agent" />
        </ListPresentationProvider></PluginSurfaceFocusEligibilityProvider>);
        await waitForHomeGovernance(() => expect(requests).toContainEqual(expect.objectContaining({ subject })));
        await waitForHomeGovernance(() => expect(screen.findByTestId('subject-triggers-read')).toBeNull());
        expect(screen.getTextContent()).toContain('workflows.triggers.section.approvalProfileInfo');
        expect(screen.findByTestId('subject-triggers-add')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('workflows.triggers.guided.starter');
        // Settled with no rows and no starters: one line says what belongs here, never a blank sheet.
        expect(screen.findByTestId('subject-triggers-empty')).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.triggers.section.empty');
        // Its starts settle with Actions a profile can link before or after: Link lands in its held place.
        await waitForHomeGovernance(() => expect(screen.findByTestId('subject-triggers-link')).not.toBeNull());
        expect(screen.findByTestId('subject-triggers-link-pending')).toBeNull();
        expect(screen.findByTestId('subject-triggers-starts-unavailable')).toBeNull();
        await screen.unmount();
    });
    it('lets a widget frame head a Project\'s section: its actions become the frame\'s, its rows stay the section\'s', async () => {
        const { SubjectTriggersSection } = await import('./SubjectTriggersSection');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { WidgetFrameBodyMetaContext } = await import('@/components/widgets/frame/widgetFrameBodyCaption');
        home.answer(serverId, 'POST /v3/automations/query', { body: AutomationDefinitionListResponseSchema.parse({
            automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0 }) });
        const subject = { kind: 'project' as const, serverId, projectKey: 'project-happier' };
        // The frame (WidgetArea) holds what its body lends and draws it in its header.
        function Frame() {
            const [meta, setMeta] = React.useState<React.ReactNode>(null);
            return <>
                <View testID="frame-header">{meta}</View>
                <WidgetFrameBodyMetaContext.Provider value={setMeta}>
                    <SubjectTriggersSection subject={subject} subjectName="happier" presentation="widget" />
                </WidgetFrameBodyMetaContext.Provider>
            </>;
        }
        const { View } = await import('react-native');
        const screen = await renderAccountScreen(<PluginSurfaceFocusEligibilityProvider active><Frame /></PluginSurfaceFocusEligibilityProvider>);
        await waitForHomeGovernance(() => expect(screen.findByTestId('subject-triggers-empty')).not.toBeNull());
        const header = screen.findByTestId('frame-header')!;
        expect(header.findAll(node => node.props.testID === 'subject-triggers-add').length).toBeGreaterThan(0);
        // The frame names it: the section draws no title of its own, and says what belongs here first.
        expect(screen.getTextContent()).not.toContain('workflows.triggers.section.title');
        expect(screen.findByTestId('subject-triggers-description')).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.triggers.section.projectInfo');
        await screen.unmount();
    });
    it('says, in place of Link, that a Machine\'s starts could not be read', async () => {
        const { SubjectTriggersSection } = await import('./SubjectTriggersSection');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
        home.answer(serverId, 'POST /v3/automations/query', { body: AutomationDefinitionListResponseSchema.parse({
            automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0 }) });
        const screen = await renderAccountScreen(<PluginSurfaceFocusEligibilityProvider active><ListPresentationProvider value="page">
            <SubjectTriggersSection subject={{ kind: 'machine', serverId, machineId: 'unreachable-machine' }} subjectName="Studio" />
        </ListPresentationProvider></PluginSurfaceFocusEligibilityProvider>);
        await waitForHomeGovernance(() => expect(screen.findByTestId('subject-triggers-starts-unavailable')).not.toBeNull());
        expect(screen.findByTestId('subject-triggers-link-pending')).toBeNull();
        expect(screen.findByTestId('subject-triggers-link')).toBeNull();
        expect(screen.getTextContent()).toContain('workflows.triggers.section.startsUnavailable');
        await screen.unmount();
    });
    it('reads a plugin resource without execution placement or opening a saved attachment body', async () => {
        const { useResourceAutomationsSection } = await import('./useResourceAutomationsSection');
        const { AutomationSubjectV1Schema } = await import('@happier-dev/protocol/automations/automationSubjectV1');
        const { WorkflowAttachedTriggerPageV1Schema } = await import('@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        serve({ ...fixture(), target: { kind: 'workflow', ref: 'builtin:review-and-converge' } });
        const page = WorkflowAttachedTriggerPageV1Schema.parse({ attached: [{
            automationId: 'digest', triggerId: 't1', workflowDefinitionId: 'builtin:review-and-converge',
            relation: 'direct', enabled: true, revision: 1, summary: { kind: 'schedule', schedule: trigger('t1').schedule },
            setUpBy: { accountId: 'account-a', displayName: 'Owner' },
        }], nextCursor: null, skippedNotSharedCount: 0 });
        home.answer(serverId, 'POST /v3/automations/query', { body: AutomationDefinitionListResponseSchema.parse({ automations: [], ...page }) });
        const subject = AutomationSubjectV1Schema.parse({ kind: 'plugin', serverId, pluginId: 'acme.tickets',
            subjectKindId: 'ticket', identity: { id: 'issue-1' } });
        const hook = await renderHook(() => useResourceAutomationsSection({ subject }), {
            wrapper: ({ children }) => <PluginSurfaceFocusEligibilityProvider active>{children}</PluginSurfaceFocusEligibilityProvider>,
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).toBe('ready'));
        expect(hook.getCurrent().project).toBeUndefined();
        expect(hook.getCurrent().rows).toHaveLength(1);
        const reads = () => home.requests.filter(request => request.method === 'GET' && request.path === '/v3/automations/digest');
        expect(reads()).toEqual([]);
        await hook.unmount();
    });
    it.each(['schedule', 'action', 'pluginEvent', 'lifetimeSession'] as const)('links a built-in Workflow through the trigger owner without an Artifact grant review (%s)', async kind => {
        const { useResourceAutomationsSection } = await import('./useResourceAutomationsSection');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        home.answer(serverId, 'POST /v3/automations/query', { body: AutomationDefinitionListResponseSchema.parse({
            automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0,
        }) });
        if (kind === 'lifetimeSession') storage.getState().applySessions([createSessionFixture({ id: 'session-link', serverId,
            active: false, encryptionMode: 'plain', metadataLayoutVersion: 1,
            // Layout 1 shared metadata omits the legacy owner fields in the UI Metadata alias.
            metadata: { name: 'Session link' } as ReturnType<typeof createSessionFixture>['metadata'],
            ownerMetadataView: { path: '/repo', host: 'test', homeDir: '/home/test', machineId: project.machineId, flavor: 'claude' } })]);
        const hook = await renderHook(() => useResourceAutomationsSection(kind === 'lifetimeSession'
            ? { subject: { kind: 'session', serverId, sessionId: 'session-link' } }
            : { serverId, subject: { kind: 'environment', machineId: project.machineId, environmentId: 'source-environment' },
                sourceAudience: [{ kind: 'account', accountId: 'reader' }] }),
        { wrapper: ({ children }) => <PluginSurfaceFocusEligibilityProvider active>{children}</PluginSurfaceFocusEligibilityProvider> });
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).toBe('ready'));
        const configuredTrigger: AutomationTriggerDefinitionInput = kind === 'schedule' || kind === 'lifetimeSession'
            ? { kind: 'schedule', enabled: true,
                schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } }
            : kind === 'action' ? { kind: 'action', phase: 'after', enabled: true, actionIds: ['deployments.deploy'],
                filter: { v: 1, all: [{ field: '/outcome', op: 'eq', value: 'failed' }] } }
                : { kind: 'pluginEvent', enabled: true, eventRef: { pluginId: 'acme.deploy', localId: 'released' },
                    sourceInstanceId: 'production', sourceContractVersion: 1, sourceConfig: { environment: 'production' },
                    displayLabel: 'Production', observationTransport: { kind: 'checkpointedPull',
                        watcherMaterializationRef: { machineId: project.machineId, pluginId: 'acme.deploy', materializationId: 'deploy' } },
                    filter: null, maximumObservationAgeMs: null };
        await act(async () => hook.getCurrent().link.setDraft({ workflow: 'builtin:review-and-converge', trigger: configuredTrigger,
            ...(kind === 'lifetimeSession' ? { lifetimeSession: { sessionId: 'session-link' } } : {}) }));
        expect(hook.getCurrent().link.missingAudience).toEqual([]);
        let outcome: Awaited<ReturnType<ReturnType<typeof useResourceAutomationsSection>['link']['submit']>> | undefined;
        await act(async () => { outcome = await hook.getCurrent().link.submit('accept'); });
        if (outcome && !outcome.ok && outcome.phase === 'link') throw outcome.error;
        expect(outcome).toMatchObject({ ok: true, shared: [], write: { set: { target: { kind: 'workflow', ref: 'builtin:review-and-converge' } } } });
        expect(rows).toHaveLength(1);
        const submitted = AutomationDefinitionCreateRequestSchema.parse(home.requests.find(request =>
            request.method === 'POST' && request.path === '/v3/automations')?.input);
        if (kind === 'lifetimeSession') {
            expect(hook.getCurrent().project).toBeUndefined();
            expect(submitted.scopeSessionId).toBe('session-link');
        }
        const submittedTrigger = submitted.triggers[0];
        if (!submittedTrigger) throw new Error('Expected the actual submitted trigger');
        if (kind === 'action') {
            const { openAutomationTriggerDefinitionStoredEnvelopeV1 } = await import('@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent');
            if (submittedTrigger.trigger.kind !== 'action' || !('triggerDefinitionEnvelope' in submittedTrigger.trigger)) throw new Error('Expected private Action definition');
            const { enabled: _enabled, ...authored } = configuredTrigger;
            expect(openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', envelope: submittedTrigger.trigger.triggerDefinitionEnvelope,
                binding: { v: 1, automationId: submitted.automationId, triggerId: submittedTrigger.triggerId, triggerRevision: 0, triggerKind: 'action' } }))
                .toMatchObject({ kind: 'available', definition: { ...authored,
                    subject: { kind: 'environment', serverId, environmentId: 'source-environment' } } });
        } else if (kind === 'pluginEvent') expect(submittedTrigger.trigger).toMatchObject({ ...configuredTrigger,
            subject: { kind: 'environment', serverId, environmentId: 'source-environment' } });
        else expect(submittedTrigger.trigger).toEqual(configuredTrigger);
        expect(home.requests.filter(request => request.path.includes('/access/grants'))).toEqual([]);
        await hook.unmount();
    });
    it('offers admitted Account Action starts without a monitoring Machine and keeps explicit null unavailable', async () => {
        const { useResourceAutomationsSection } = await import('./useResourceAutomationsSection');
        const { useWorkflowActionCatalog } = await import('../presentation/useWorkflowActionCatalog');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { AutomationSubjectV1Schema } = await import('@happier-dev/protocol/automations/automationSubjectV1');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const physicalAccount = captureActiveServerAccountScopeLifetime();
        if (!physicalAccount) throw new Error('Expected the admitted physical Account');
        const subject = AutomationSubjectV1Schema.parse({ kind: 'environment', serverId, environmentId: 'production' });
        home.answer(serverId, 'POST /v3/automations/query', { body: AutomationDefinitionListResponseSchema.parse({
            automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0,
        }) });
        const hook = await renderHook((props: { accountLifetime: import('@/sync/domains/scope/serverAccountScope').ServerAccountScopeLifetime | null }) => {
            const section = useResourceAutomationsSection({ subject, accountLifetime: props.accountLifetime });
            const catalog = useWorkflowActionCatalog({ kind: 'machine', machineId: null, serverId }, 'automation',
                { accountLifetime: props.accountLifetime });
            return { ...section, catalogPhase: catalog.phase, catalogSpecs: catalog.specs };
        }, {
            initialProps: { accountLifetime: physicalAccount },
            wrapper: ({ children }) => <PluginSurfaceFocusEligibilityProvider active>{children}</PluginSurfaceFocusEligibilityProvider>,
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).toBe('ready'));
        expect(hook.getCurrent().accountLifetime).toBe(physicalAccount);
        await waitForHomeGovernance(() => expect(hook.getCurrent().catalogPhase).toBe('ready'));
        expect(hook.getCurrent().project).toBeUndefined();
        expect(hook.getCurrent().catalogSpecs).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'deployments.deploy' })]));
        expect(hook.getCurrent().link.whenStatus).toBe('ready');
        expect(hook.getCurrent().link.whenOptions).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'action:before:deployments.deploy', subject }),
            expect.objectContaining({ id: 'action:after:deployments.deploy', subject }),
        ]));
        const reads = listRequests().length;
        await hook.rerender({ accountLifetime: null });
        expect(hook.getCurrent().accountLifetime).toBeNull();
        expect(hook.getCurrent().read.status).toBe('loading');
        expect(hook.getCurrent().rows).toEqual([]);
        expect(listRequests()).toHaveLength(reads);
        await hook.rerender({ accountLifetime: physicalAccount });
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).toBe('ready'));
        expect(listRequests()).toHaveLength(reads + 1);
        await hook.unmount();
    });
    it.each(['environment', 'machine'] as const)('keeps Resource Link declined read-only and awaits reviewed sharing before its one Workflow trigger write (%s)', async kind => {
        const { useResourceAutomationsSection } = await import('./useResourceAutomationsSection');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        home.answer(serverId, 'POST /v3/automations/query', { body: AutomationDefinitionListResponseSchema.parse({
            automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0,
        }) });
        const { ArtifactAccessGrantSetInputV1Schema, ArtifactAccessGrantsListResponseV1Schema,
            ArtifactAccessGrantMutationResponseV1Schema } = await import('@happier-dev/protocol/artifacts/artifactAccessV1');
        const definitionId = '11111111-1111-4111-8111-111111111111';
        const definition = fixture().target;
        if (definition?.kind !== 'inline') throw new Error('Expected the fixture Workflow definition');
        await home.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: definitionId,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(WorkflowDefinitionArtifactHeaderV1Schema.parse({ kind: 'workflow-definition.v1', definitionId,
                revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Shared check' } })),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(WorkflowDefinitionArtifactBodyV1Schema.parse({
                kind: 'workflow-definition.v1', definition: definition.definition,
            })) }),
        }) });
        const principal = { kind: 'account' as const, accountId: 'reader' };
        const machineAddress = `/v1/machines/${project.machineId}/access`;
        const machineGate = createDeferred<void>();
        home.answer(serverId, `GET ${machineAddress}`, { select: async () => {
            await machineGate.promise;
            return { body: {
            machineId: project.machineId, custodian: { accountId: 'account-a', displayName: 'Owner' },
            access: { custodian: { accountId: 'account-a', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
            canManage: true, ownDirectGrant: false, ownAccessSources: [],
            grants: [{ machineId: project.machineId, principal, level: 'view', display: { name: 'Reader' }, readiness: 'ready',
                audience: [{ accountId: 'reader', displayName: 'Reader', readiness: 'ready', reason: null, canPrepareKeys: false }],
                removal: { losesAccessAccountIds: ['reader'] } }],
        } }; } });
        const grants: import('@happier-dev/protocol/artifacts/artifactAccessV1').ArtifactAccessGrantRowV1[] = [];
        const grantGate = createDeferred<void>();
        const grantAddress = `/v1/artifacts/${definitionId}/access/grants`;
        const snapshot = () => ({ artifactId: definitionId, ownerAccountId: 'account-a', access: 'owner' as const, grants });
        home.answer(serverId, `GET ${grantAddress}`, { select: () => ({ body: ArtifactAccessGrantsListResponseV1Schema.parse({
            ...snapshot(), missingAudience: grants.length === 0 ? [principal] : [],
        }) }) });
        home.answer(serverId, `PUT ${grantAddress}`, { select: async raw => {
            const input = ArtifactAccessGrantSetInputV1Schema.parse(raw);
            await grantGate.promise;
            grants.push({ principal: input.principal, accessLevel: input.accessLevel, createdByAccountId: 'account-a',
                createdAt: 1, display: { name: 'Reader' } });
            return { body: ArtifactAccessGrantMutationResponseV1Schema.parse({ ...snapshot(), changed: true }) };
        } });
        const hook = await renderHook(() => useResourceAutomationsSection({
            serverId,
            subject: kind === 'environment' ? { kind: 'environment', machineId: project.machineId, environmentId: 'source-environment' }
                : { kind: 'machine', machineId: project.machineId },
            ...(kind === 'environment' ? { sourceAudience: [principal] } : {}),
        }), { wrapper: ({ children }) => <PluginSurfaceFocusEligibilityProvider active>{children}</PluginSurfaceFocusEligibilityProvider> });
        await waitForHomeGovernance(() => expect(hook.getCurrent().read.status).toBe('ready'));
        const grantRequests = () => home.requests.filter(request => request.path.startsWith(grantAddress));
        expect(grantRequests()).toEqual([]);
        expect(home.requests.filter(request => request.path === machineAddress)).toEqual([]);
        await act(async () => hook.getCurrent().link.setDraft({ workflow: definitionId,
            trigger: { kind: 'schedule', enabled: true,
                schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } } }));
        if (kind === 'machine') {
            expect(hook.getCurrent().link.loading).toBe(true);
            expect(grantRequests()).toEqual([]);
            await act(async () => machineGate.resolve());
        }
        await waitForHomeGovernance(() => expect(hook.getCurrent().link.missingAudience).toEqual([principal]));
        await act(async () => { expect(await hook.getCurrent().link.submit('decline')).toEqual({ ok: false, phase: 'declined', shared: [] }); });
        expect(grantRequests().filter(request => request.method !== 'GET')).toEqual([]);
        expect(rows).toEqual([]);
        const retainedSubmit = hook.getCurrent().link.submit;
        await act(async () => hook.getCurrent().link.setDraft({ workflow: '22222222-2222-4222-8222-222222222222',
            trigger: { kind: 'schedule', enabled: true,
                schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } } }));
        await act(async () => { expect(await retainedSubmit('accept')).toMatchObject({
            ok: false, phase: 'sharing', shared: [], error: { code: 'action_account_scope_changed' },
        }); });
        expect(grantRequests().filter(request => request.method !== 'GET')).toEqual([]);
        expect(rows).toEqual([]);
        await act(async () => hook.getCurrent().link.setDraft({ workflow: definitionId,
            trigger: { kind: 'schedule', enabled: true,
                schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } } }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().link.missingAudience).toEqual([principal]));
        let submit!: ReturnType<ReturnType<typeof useResourceAutomationsSection>['link']['submit']>;
        await act(async () => { submit = hook.getCurrent().link.submit('accept'); });
        await waitForHomeGovernance(() => expect(grantRequests().filter(request => request.method === 'PUT')).toHaveLength(1));
        expect(rows).toEqual([]);
        await act(async () => { grantGate.resolve(); await submit; });
        expect(await submit).toMatchObject({ ok: true, shared: [principal], write: { set: { target: { kind: 'workflow', ref: definitionId } } } });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.workflowDefinitionId).toBe(definitionId);
        await hook.unmount();
    });
    it('shows the captured built-in trigger on its ordinary catalog page and opens its editor', async () => {
        const set = WorkflowTriggerSetV1Schema.parse(capturedBuiltinTriggerSet);
        serve(set);
        const { WorkflowBuiltinEditorHostScreen } = await import('../screens/WorkflowCatalogEditorHostScreen');
        const { WorkflowEditorBody } = await import('../screens/WorkflowEditorBody');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const screen = await renderAccountScreen(<AppPaneProvider><WorkflowBuiltinEditorHostScreen workflow="builtin:review-and-converge" /></AppPaneProvider>);
        await waitForHomeGovernance(() => {
            expect(screen.findByType(WorkflowEditorBody).props.triggersSummary).toBe(formatTriggerSetSentence(set.triggers));
        });
        await screen.pressByTestIdAsync('workflow-builtin-when-toggle');
        const row = screen.findByTestId(`workflows-column:trigger:${set.automationId}`);
        expect(row).not.toBeNull();
        await act(async () => row!.props.onPress());
        expect(screen.findByTestId('workflows-column-trigger-popover-submit')).not.toBeNull();
    });

    it('saves a contextual scheduled service command through the Account trigger owner without starting an Agent', async () => {
        const { installSessionActionRpcBoundary } = await import('@/dev/testkit/harness/sessionActionRpcBoundary');
        const { buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeResponseSchema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        const projection = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'a'.repeat(64), projection: { v: 2, generation: 1,
                installedPackagesById: {}, actionsById: {}, agentsById: {}, familiesById: {} },
        }));
        // Discovery crosses the daemon wire; native Action input hints stay real.
        installSessionActionRpcBoundary(request => {
            if (!request.method.endsWith(`:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)) {
                throw new Error(`Unexpected scheduled-command fixture RPC: ${request.method}`);
            }
            const read = (request.params as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>).sectionRead;
            return read ? projection.read(read.digest, read.offset, read.includeDigests) : projection.manifest;
        });
        home.answer(serverId, '/v1/auth/ping', { body: { ok: true } });
        const { buildTriggerTarget } = await import('./sessionTriggerForm');
        const target = buildTriggerTarget({ kind: 'doAction', actionId: 'machines.services.exec', input: {
            serverId, machineId: project.machineId,
            target: { kind: 'current', serviceId: 'app/web', expectedGeneration: 'release-a' },
            mode: 'exec', argv: ['task', 'daily'],
        } }, 'account');
        if (!target) throw new Error('Expected command target');
        const screen = await renderAccountScreen(<NewAccountTriggerPopover anchorRef={React.createRef()}
            initialProject={project} initialActionTargets={[target]} onRequestClose={() => undefined} />);
        const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
        await waitForHomeGovernance(() => expect(screen.findAllByType(ActionInputFields)).toHaveLength(1));
        expect(screen.findByType(ActionInputFields).props.input).toMatchObject({
            machineId: project.machineId, mode: 'exec', argv: ['task', 'daily'],
        });
        expect(rows).toHaveLength(0);
        await screen.pressByTestIdAsync('workflows-column-new-trigger-popover-submit');
        await waitForHomeGovernance(() => expect(rows, screen.getTextContent()).toHaveLength(1));
        const recipe = rows[0]!.executionRecipe;
        if (!recipe || !('workflow' in recipe) || recipe.workflow.t !== 'plain') throw new Error('Expected plain Workflow');
        expect(rows[0]!.triggers).toMatchObject([{ kind: 'schedule' }]);
        const stored = AutomationStoredWorkflowDefinitionV2Schema.parse(recipe.workflow.v);
        expect(stored.executionTarget).toEqual({ kind: 'detached_run' });
        expect(stored.inlineDefinition?.blocks).toEqual(target.kind === 'inline' ? target.definition.blocks : []);
        expect(home.requests.some(request => request.path.includes('/sessions') && request.method === 'POST')).toBe(false);
    });

    it('demands workflow options only while the trigger picker is open', async () => {
        serve(fixture());
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflows-column:trigger:digest')).not.toBeNull());
        const workflowReads = () => home.requests.filter(request => request.method === 'GET'
            && request.path.startsWith('/v1/artifacts?') && request.path.includes('workflow-definition'));
        expect(workflowReads()).toHaveLength(0);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        await waitForHomeGovernance(() => expect(workflowReads().length).toBeGreaterThan(0));
        expect(screen.findAllByType(TriggerPopover)).toHaveLength(1);
    });
    it.each(['managedRunLifecycle', 'pluginEvent'] as const)('keeps %s sentence intake bound to its source Home after focus changes', async kind => {
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { prepareWorkflowSentenceEditorEntry } = await import('../authoring/workflowSentenceAuthoring');
        const { readWorkflowDefinitionDraftSeed } = await import('@/sync/domains/workflows/workflowDefinitionDraftSeed');
        const { buildManagedCreationScopeTriggerTarget } = await import('@/sync/domains/machines/managedCreationScopeTrigger');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected source Account lifetime');
        const source = { kind: 'workflow_run', runId: 'addressed-task-run' } as const;
        const target = buildManagedCreationScopeTriggerTarget({
            homeId: 'source-home', managedId: 'source-managed', effect: 'stop', supportedIntents: ['stop'],
        });
        const step = target.kind === 'inline' ? target.definition.blocks[0] : null;
        if (step?.kind !== 'action') throw new Error('Expected the managed Action leaf');
        const eventSeed = { eventRef: { pluginId: 'acme.events', localId: 'completed' }, setupInput: {} };
        const entry = prepareWorkflowSentenceEditorEntry(kind === 'managedRunLifecycle'
            ? { name: 'Task', step, project, executionTarget: 'detached_run',
                trigger: { kind: 'runLifecycle', source, condition: 'terminal', enabled: true } }
            : { name: 'Event', eventSeed }, lifetime);
        if (!entry) throw new Error('Expected the source sentence entry');
        const otherServerId = await home.addHome({ name: 'Focused Home', serverUrl: `https://focused-trigger-${crypto.randomUUID()}.test`, accountId: 'account-b' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        const focusedScope = { serverId: otherServerId, accountId: 'account-b' };
        storage.setState({ profileScope: focusedScope, settingsScope: focusedScope });
        expect(entry.params.serverId).toBe(lifetime.scope.serverId);
        expect(readWorkflowDefinitionDraftSeed(entry.params.definitionDraftSeedId, focusedScope)).toBeNull();
        const seed = readWorkflowDefinitionDraftSeed(entry.params.definitionDraftSeedId, lifetime.scope);
        expect(seed).toMatchObject(kind === 'managedRunLifecycle'
            ? { initialView: 'sentence', definition: { blocks: [step] }, project, executionTarget: 'detached_run',
                trigger: { kind: 'runLifecycle', source, condition: 'terminal', enabled: true } }
            : { initialView: 'sentence', eventSeed });
        expect(rows).toHaveLength(0);
    });
    it('edits a saved task target from Stop to Delete while preserving its exact Run and trigger removal', async () => {
        const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
        const { buildManagedCreationScopeTriggerTarget } = await import('@/sync/domains/machines/managedCreationScopeTrigger');
        const { readManagedMachineTriggerAction } = await import('@happier-dev/protocol/actions/executor/workflowTriggerActions');
        const { createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const { setServerProfileIdentityForUrl, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const { installSessionActionRpcBoundary } = await import('@/dev/testkit/harness/sessionActionRpcBoundary');
        const { buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeResponseSchema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        const projection = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'a'.repeat(64), projection: { v: 2, generation: 1,
                installedPackagesById: {}, actionsById: {}, agentsById: {}, familiesById: {} },
        }));
        // Only the daemon wire is substituted; native Action discovery and its input hints stay real.
        installSessionActionRpcBoundary(request => {
            if (!request.method.endsWith(`:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)) {
                throw new Error(`Unexpected managed-target fixture RPC: ${request.method}`);
            }
            const read = (request.params as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>).sectionRead;
            return read ? projection.read(read.digest, read.offset, read.includeDigests) : projection.manifest;
        });
        home.answer(serverId, '/v1/auth/ping', { body: { ok: true } });
        const homeId = 'srv_managed_keep';
        expect(await setServerProfileIdentityForUrl(getActiveServerSnapshot().serverUrl, homeId))
            .toMatchObject({ serverIdentityId: homeId });
        serverId = resolveServerProfileScopeIdForIdentifier(serverId) ?? serverId;
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        storage.setState({ profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' } });
        const source = { kind: 'workflow_run', runId: 'task-birth-run' } as const;
        const actionTargets = (['stop', 'delete'] as const).map(effect => buildManagedCreationScopeTriggerTarget({
            homeId, managedId: 'managed-exact', effect, supportedIntents: ['stop', 'delete'],
        }));
        const machine = ManagedMachineV1Schema.parse({ id: 'managed-exact', homeId, custodianAccountId: 'account-a',
            launch: { provider: { pluginId: 'acme.compute', localId: 'guest' }, schemaVersion: 1, name: 'Task guest', choices: {} },
            controller: { machineId: project.machineId, installationId: 'controller-installation' }, enrolledMachineId: 'task-guest',
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            resource: { contributionRef: { pluginId: 'acme.compute', localId: 'guest' }, schemaVersion: 1, value: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        home.answer(serverId, 'POST /v1/machines/managed/actions/get', { body: machine });
        home.answer(serverId, 'POST /v3/automations/runs/workflow-storage', { body: { run: createWorkflowRunSummaryFixture({
            id: source.runId, ownerAccountId: 'account-a', machineId: project.machineId,
        }) } });
        serve(WorkflowTriggerSetV1Schema.parse({ ...fixture(), target: actionTargets[0], context: { workspace: { directory: project.directory }, executionTarget: { kind: 'detached_run' } }, triggers: [{ id: 'task-terminal',
            revision: 1, createdAt: 1, updatedAt: 1, enabled: true, kind: 'runLifecycle', source, condition: 'terminal',
            triggerDefinitionEnvelope: null, remainingOccurrences: 1, status: { state: 'waiting', runId: null } }] }));
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflows-column:trigger:digest')).not.toBeNull());
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        const editor = screen.findByType(TriggerPopover);
        expect(editor.props.initial.when).toEqual({ kind: 'runLifecycle', source, condition: 'terminal' });
        expect(rows).toHaveLength(1);
        const actionMenu = () => screen.findAllByType(DropdownMenu)
            .find(menu => menu.props.testID === 'workflows-column-trigger-popover-action');
        await waitForHomeGovernance(() => expect(actionMenu()?.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'machines.managed.delete' }),
        ])));
        await act(async () => actionMenu()!.props.onSelect('machines.managed.delete'));
        const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
        const fields = screen.findByType(ActionInputFields);
        expect(fields.props.input).toMatchObject({ homeId, managedId: 'managed-exact',
            intent: 'delete', when: 'after-idle', reviewedDependencies: true });
        expect(rows).toHaveLength(1);
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        await waitForHomeGovernance(() => expect(mutations, screen.getTextContent()).toHaveLength(1));
        const saved = rows[0]!;
        expect(saved.triggers).toMatchObject([{ kind: 'runLifecycle', source, condition: 'terminal' }]);
        const recipe = saved.executionRecipe;
        const context = recipe && 'workflow' in recipe ? recipe.workflow : null;
        if (context?.t !== 'plain') throw new Error('Expected the authored plain managed target');
        const workflow = AutomationStoredWorkflowDefinitionV2Schema.parse(context.v);
        if (!workflow.inlineDefinition) throw new Error('Expected the authored inline managed target');
        expect(workflow.executionTarget).toEqual({ kind: 'detached_run' });
        expect(readManagedMachineTriggerAction({ kind: 'inline', definition: workflow.inlineDefinition })).toMatchObject({
            actionId: 'machines.managed.delete', input: { homeId: machine.homeId, managedId: machine.id },
        });
        await screen.unmount();
        routeState.params = { trigger: saved.id };
        const reopened = await renderAccountScreen(<AccountTriggersSection />);
        await waitForHomeGovernance(() => expect(reopened.findAllByType(TriggerPopover)).toHaveLength(1));
        expect(reopened.findByType(TriggerPopover).props.initial.when).toEqual({ kind: 'runLifecycle', source, condition: 'terminal' });
        await reopened.pressByTestIdAsync('workflows-column-trigger-popover-delete');
        await waitForHomeGovernance(() => expect(rows[0]?.triggers).toEqual([]));
        // The HTTP fixture changes before the Action's receipt reaches the store.
        // Wait for the authored trigger deletion to reach the materialized store.
        await waitForHomeGovernance(() => {
            const retained = storage.getState().workflowTriggerSetsById[saved.id];
            expect(retained).toBeDefined();
            expect(retained?.triggers).toEqual([]);
        });
    });
    it.each(['account', 'activity'] as const)('stores and reopens Inbox-only source enrollment from %s without a Project or executable target', async (entry) => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl(getActiveServerSnapshot().serverUrl);
        if (!credentials) throw new Error('Account credential fixture required');
        sourceIntakeConnection = await restoreServerAccountForTest({ serverUrl: getActiveServerSnapshot().serverUrl,
            accountId: 'account-a', credentials, request: home.request });
        const { AutomationTriggerDefinitionInputSchema } = await import('@happier-dev/protocol/automations/automationTriggerDefinition');
        const { AutomationRunPluginEventTriggerEvidenceV1Schema } = await import('@happier-dev/protocol/automations/automationRunExecutionRecipeV1');
        const { TriggerFromActivityEvent } = await import('./TriggerFromActivityEvent');
        const { PluginEventAutomationEditor } = await import('@/components/automations/editor/PluginEventAutomationEditor');
        const sourceConfig = { project: '42', checks: [{ id: 'retained-check' }] };
        const source = AutomationTriggerDefinitionInputSchema.parse({ kind: 'pluginEvent', enabled: true,
            eventRef: { pluginId: 'acme.monitor', localId: 'issue-transition' }, sourceInstanceId: 'project:42',
            sourceContractVersion: 1, sourceConfig, displayLabel: 'Production issues', filter: null,
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

        if (entry === 'account') {
            const requestsBeforeIntake = home.requests.length;
            const intake = await renderAccountScreen(<NewAccountTriggerPopover anchorRef={React.createRef()}
                onRequestClose={() => undefined} eventSeed={{ eventRef: source.eventRef,
                    sourceInstanceId: source.sourceInstanceId, setupInput: { subject: 'prebound-subject' } }} />);
            await waitForHomeGovernance(() => expect(intake.findByType(TriggerPopover).props.eventEdit)
                .toEqual({ automationId: id, triggerId: saved.triggers[0]!.id }));
            expect(intake.findByType(TriggerPopover).props.initialEventSeed).toMatchObject({
                monitoringMachineId: 'observer-machine',
                setupInput: { ...sourceConfig, subject: 'prebound-subject' },
            });
            expect(rows).toHaveLength(1);
            expect(home.requests.slice(requestsBeforeIntake).filter(request => request.method === 'GET'
                && request.path === `/v3/automations/${id}`)).toHaveLength(1);
            await intake.unmount();
        }

        const reopened = await renderAccountScreen(<AccountTriggersSection />);
        await waitForHomeGovernance(() => expect(reopened.findByTestId(`workflows-column:trigger:${id}`)).not.toBeNull());
        await reopened.pressByTestIdAsync(`workflows-column:trigger:${id}`);
        const editor = reopened.findByType(TriggerPopover);
        expect(editor.props.initial).toMatchObject({ kind: 'observationOnly', when: {
            kind: 'pluginEvent', observationOnly: { kind: 'observationOnly' }, eventRef: source.eventRef,
        } });
        // An observation has a monitoring origin, but no execution placement.
        // Reopening must allow Done without inventing an executable Runs on target.
        expect(reopened.findAllByType(TriggerRunsOnRow)).toHaveLength(0);
        expect(reopened.findByTestId('workflows-column-trigger-popover-submit')?.props.disabled).toBe(false);
        const writesBeforeDone = writes().length;
        await reopened.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        expect(reopened.findByTestId('workflows-column-trigger-popover-submit')).toBeNull();
        expect(writes()).toHaveLength(writesBeforeDone);
        await reopened.pressByTestIdAsync(`workflows-column:trigger:${id}`);
        let update!: Promise<void>;
        await act(async () => {
            update = reopened.findByType(TriggerPopover).props.onSubmit({ enabled: true, when: { kind: 'pluginEvent', value: source,
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

    it('reopens a saved executable Event with Done enabled and saves only its edited notification', async () => {
        const { AutomationTriggerDefinitionInputSchema } = await import('@happier-dev/protocol/automations/automationTriggerDefinition');
        const { addWorkflowTrigger } = await import('@/sync/domains/workflows/workflowTriggerActions');
        const { buildTriggerTarget } = await import('./sessionTriggerForm');
        const trigger = AutomationTriggerDefinitionInputSchema.parse({ kind: 'pluginEvent', enabled: true,
            eventRef: { pluginId: 'acme.monitor', localId: 'machine-offline' }, sourceInstanceId: 'machine:m1',
            sourceContractVersion: 1, sourceConfig: {}, displayLabel: 'Machine went offline', filter: null,
            maximumObservationAgeMs: null, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
                machineId: 'observer-machine', pluginId: 'acme.monitor', materializationId: 'monitor-1',
            } } });
        const target = buildTriggerTarget({ kind: 'notifyMe', title: 'Machine offline', message: 'Check this machine', channels: [] }, 'account');
        if (!target) throw new Error('Expected a notification target');
        await addWorkflowTrigger({ trigger, target, project });
        const saved = rows[0]!;
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await waitForHomeGovernance(() => expect(screen.findByTestId(`workflows-column:trigger:${saved.id}`)).not.toBeNull());
        await screen.pressByTestIdAsync(`workflows-column:trigger:${saved.id}`);
        expect(screen.findByType(TriggerPopover).props.initial.when).toMatchObject({ kind: 'pluginEvent', value: null });
        expect(screen.findByType(TriggerRunsOnRow).props.target).toEqual(project);
        expect(screen.findByTestId('workflows-column-trigger-popover-submit')?.props.disabled).toBe(false);
        await act(async () => screen.findByType(TriggerRunsOnRow).props.onChange({ ...project }));
        expect(screen.findByTestId('workflows-column-trigger-popover-submit')?.props.disabled).toBe(false);
        await act(async () => screen.findByProps({ accessibilityLabel: 'workflows.triggers.then.message', value: 'Check this machine' })
            .props.onChangeText('The machine needs attention'));
        await act(async () => screen.findByProps({ accessibilityLabel: 'workflows.triggers.then.message', value: 'The machine needs attention' })
            .props.onBlur());
        expect(screen.findByTestId('workflows-column-trigger-popover-submit')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        await waitForHomeGovernance(() => expect(writes()).toHaveLength(1));
        expect(writes()[0]?.triggers).toEqual([{ kind: 'existing', triggerId: saved.triggers[0]!.id, expectedRevision: saved.triggers[0]!.revision }]);
        expect(rows[0]?.triggers).toEqual(saved.triggers);
        expect(writtenContext(writes()[0]!)).toMatchObject({ inlineDefinition: { blocks: [{ input: {
            message: { kind: 'literal', value: 'The machine needs attention' },
        } }] } });
        await screen.pressByTestIdAsync(`workflows-column:trigger:${saved.id}`);
        expect(screen.findByTestId('workflows-column-trigger-popover-submit')?.props.disabled).toBe(false);
        expect(screen.findByType(TriggerRunsOnRow).props.target).toEqual(project);
        expect(screen.findByProps({ accessibilityLabel: 'workflows.triggers.then.message', value: 'The machine needs attention' })).toBeTruthy();
    });

    it.each(['ask', 'automatic'] as const)('reopens saved push consent as Automatic and saves %s with its edited branch and retained trigger identity', async choice => {
        const { addWorkflowTrigger } = await import('@/sync/domains/workflows/workflowTriggerActions');
        const { buildDeploymentPushRequest } = await import('./deploymentPushSetup');
        const { DeploymentPushTriggerFields } = await import('./DeploymentPushTriggerFields');
        const push = { kind: 'pluginEvent' as const, enabled: true,
            eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/repository-pushed-v1' },
            sourceInstanceId: 'repository:app', sourceContractVersion: 1, sourceConfig: {}, displayLabel: 'App repository',
            filter: null, maximumObservationAgeMs: null,
            observationTransport: { kind: 'checkpointedPull' as const, watcherMaterializationRef: {
                machineId: project.machineId, pluginId: 'happier.scm.forge.github', materializationId: 'github' } } };
        const request = buildDeploymentPushRequest({ environment: { serverId, environmentId: 'staging', projectSourceId: 'source' },
            targetLinkId: 'runtime', project }, push, 'ask', 'main');
        await addWorkflowTrigger(request);
        const saved = rows[0]!;
        const recipe = saved.executionRecipe;
        if (recipe?.v !== 2 || recipe.workflow.t !== 'plain') throw new Error('Expected a plain saved push fixture');
        const triggerId = saved.triggers[0]!.id;
        // Persisted HTTP data is a genuine boundary. This is the exact person-proof shape
        // produced by workflowTriggerActions.test.ts's Automatic save contract.
        const savedContext = AutomationStoredWorkflowDefinitionV2Schema.parse(recipe.workflow.v);
        const context = AutomationStoredWorkflowDefinitionV2Schema.parse({ ...savedContext,
            deploymentTriggers: [{ triggerId, branch: 'main', paths: ['apps/web/**'] }],
            actionApprovals: [{ triggerId, operation: {
                parent: { actionId: 'workflow.trigger.add', input: { ...request, actionApproval: 'automatic' } },
                approvedBy: { accountId: 'account-a' }, steps: [{ actionId: 'deployments.deploy',
                    input: { serverId, environmentId: 'staging', targetLinkId: 'runtime', whenBusy: 'supersede' },
                    binding: { kind: 'deployment_sha' } }],
            } }] });
        rows = [AutomationDefinitionDetailSchema.parse({ ...saved, executionRecipe: { ...recipe,
            workflow: { t: 'plain', v: context } } })];
        resetTriggerSets();
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await waitForHomeGovernance(() => expect(screen.findByTestId(`workflows-column:trigger:${saved.id}`)).not.toBeNull());
        await screen.pressByTestIdAsync(`workflows-column:trigger:${saved.id}`);
        expect(screen.findByType(DeploymentPushTriggerFields).props.approval).toBe('automatic');
        expect(screen.findByTestId('deployment-push-branch')?.props.value).toBe('main');
        await act(async () => screen.changeTextByTestId('deployment-push-branch', ' release '));
        if (choice === 'ask') await screen.pressByTestIdAsync('deployment-push-approval:ask');
        expect(screen.findByType(DeploymentPushTriggerFields).props.approval).toBe(choice);
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        await waitForHomeGovernance(() => expect(writes()).toHaveLength(1));
        if (choice === 'ask') expect(writtenContext(writes()[0]!)).not.toHaveProperty('actionApprovals');
        else expect(writtenContext(writes()[0]!)).toMatchObject({ actionApprovals: [{ triggerId, operation: {
            parent: { actionId: 'workflow.trigger.update' }, steps: [{ actionId: 'deployments.deploy',
                input: { serverId, environmentId: 'staging', targetLinkId: 'runtime', whenBusy: 'supersede' },
                binding: { kind: 'deployment_sha' } }] } }] });
        expect(writtenContext(writes()[0]!)).toMatchObject({ deploymentTriggers: [{ triggerId, branch: 'release', paths: ['apps/web/**'] }] });
        expect(rows[0]?.triggers.map(trigger => trigger.id)).toEqual([triggerId]);
        expect(rows[0]).toMatchObject({ enabled: true, triggers: [{ id: triggerId, enabled: true }] });
        expect(writtenContext(writes()[0]!)).toMatchObject({ inputs: request.inputs,
            inlineDefinition: { blocks: [{ actionId: 'deployments.deploy' }] } });
        expect(home.requests.filter(request => request.path.includes('/account/settings')
            && request.method !== 'GET')).toHaveLength(0);
    });

    it.each(['ambiguous', 'unavailable'] as const)('refuses to replace an %s saved source with a new draft', async (condition) => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl(getActiveServerSnapshot().serverUrl);
        if (!credentials) throw new Error('Account credential fixture required');
        sourceIntakeConnection = await restoreServerAccountForTest({ serverUrl: getActiveServerSnapshot().serverUrl,
            accountId: 'account-a', credentials, request: home.request });
        const { AutomationTriggerDefinitionInputSchema } = await import('@happier-dev/protocol/automations/automationTriggerDefinition');
        const { addWorkflowTrigger } = await import('@/sync/domains/workflows/workflowTriggerActions');
        const source = AutomationTriggerDefinitionInputSchema.parse({ kind: 'pluginEvent', enabled: true,
            eventRef: { pluginId: 'acme.monitor', localId: 'issue-transition' }, sourceInstanceId: 'project:42',
            sourceContractVersion: 1, sourceConfig: { checks: [{ id: 'retained-check' }] }, displayLabel: 'Production issues',
            filter: null, maximumObservationAgeMs: null, observationTransport: { kind: 'checkpointedPull',
                watcherMaterializationRef: { machineId: 'observer-machine', pluginId: 'acme.monitor', materializationId: 'monitor-1' } } });
        await addWorkflowTrigger({ trigger: source, observationOnly: { kind: 'observationOnly' } });
        if (condition === 'ambiguous') {
            await addWorkflowTrigger({ trigger: source, observationOnly: { kind: 'observationOnly' } });
        } else {
            // The inventory's batched POST remains readable; only the later
            // exact private GET fails, so this reaches saved-source resolution.
            home.answer(serverId, `GET /v3/automations/${rows[0]!.id}`, { select: (_input, request) =>
                (request.init?.method ?? 'GET').toUpperCase() === 'GET'
                    ? { status: 503, body: { error: 'unavailable' } }
                    : { body: rows[0] } });
        }
        const savedCount = rows.length;
        const requestsBeforeIntake = home.requests.length;
        const screen = await renderAccountScreen(<NewAccountTriggerPopover anchorRef={React.createRef()}
            onRequestClose={() => undefined} eventSeed={{ eventRef: { pluginId: 'acme.monitor', localId: 'issue-transition' },
                sourceInstanceId: 'project:42', setupInput: { subject: 'prebound-subject' } }} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('automation-event-source-intake-unavailable')).not.toBeNull());
        expect(home.requests.slice(requestsBeforeIntake).filter(request => request.method === 'GET'
            && rows.some(row => request.path === `/v3/automations/${row.id}`)).map(request => request.path).sort())
            .toEqual(rows.map(row => `/v3/automations/${row.id}`).sort());
        expect(screen.findAllByType(TriggerPopover)).toHaveLength(0);
        expect(rows).toHaveLength(savedCount);
        expect(writes()).toHaveLength(0);
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
            await waitForHomeGovernance(() => expect(listingRequested).toBe(true));
            await waitForHomeGovernance(() => {
                expect(rows).toHaveLength(1);
                expect(storage.getState().workflowTriggerSetsById[rows[0]!.id]).toMatchObject({ revision: 1 });
                expect(settled).toBe(true);
            });
        } finally {
            revalidation.resolve();
            await operation;
            await screen.unmount();
            await connection.dispose();
        }
    });

    it('keeps Library coverage partial until Account Workflows are read, then counts their membership', async () => {
        const read = createDeferred<void>();
        listReply = async () => { await read.promise; return listRows(); };
        try {
            const library = await renderHook(() => useWorkflowLibraryView(true));
            await waitForHomeGovernance(() => expect(library.getCurrent().library.status).toBe('loaded'));
            expect(library.getCurrent().accountWorkflows.status).toBe('loading');
            expect(library.getCurrent().libraryCoverage).toBe('partial');
            serve(fixture());
            await act(async () => read.resolve());
            await waitForHomeGovernance(() => expect(library.getCurrent().libraryCoverage).toBe('complete'));
            expect(library.getCurrent().accountWorkflows.status).toBe('ready');
            expect(library.getCurrent().libraryCount).toBe(1);
            expect(library.getCurrent().libraryRows).toMatchObject([{ group: 'library', accountTrigger: { automationId: 'digest' } }]);
        } finally {
            await act(async () => read.resolve());
        }
    });
    it('reports an empty Library only after the Account Workflow read settles empty', async () => {
        const read = createDeferred<void>();
        listReply = async () => { await read.promise; return listRows(); };
        try {
            const library = await renderHook(() => useWorkflowLibraryView(true));
            await waitForHomeGovernance(() => expect(library.getCurrent().library.status).toBe('loaded'));
            expect(library.getCurrent().accountWorkflows.status).toBe('loading');
            expect(library.getCurrent().libraryCoverage).toBe('partial');
            await act(async () => read.resolve());
            await waitForHomeGovernance(() => expect(library.getCurrent().libraryCoverage).toBe('complete'));
            expect(library.getCurrent().accountWorkflows.status).toBe('ready');
            expect(library.getCurrent().libraryCount).toBe(0);
            expect(library.getCurrent().libraryRows).toEqual([]);
        } finally {
            await act(async () => read.resolve());
        }
    });
    it.each([true, false])('keeps a retained encrypted trigger paused until its device review is explicitly saved (trigger enabled: %s)', async (triggerEnabled) => {
        home.answer(serverId, '/v1/machines/m2', {
            body: { machine: createPlainMachineRowFixture({ id: 'm2', accountId: 'account-a' }) },
        });
        const retained = fixture(true, [{ ...trigger('t1'), enabled: triggerEnabled }]);
        const paused = WorkflowTriggerSetV1Schema.parse({ ...retained, enabled: false,
            health: 'source_unavailable', target: undefined,
            legacy: { editable: false, reason: 'created_in_0_2', lockedReason: 'review_required' } });
        serve(WorkflowTriggerSetV1Schema.parse({ ...paused, placements: [project, { machineId: 'm2', directory: '/repo' }] }));
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflows-column:trigger:digest-switch')).not.toBeNull());
        const toggle = screen.findByTestId('workflows-column:trigger:digest-switch');
        expect(toggle?.props.value).toBe(false);
        expect(toggle?.props.disabled).toBe(true);
        expect(home.requestsFor('/v2/sessions/session-old?accessProjectionVersion=1')).toHaveLength(0);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflows-column-trigger-popover-prompt')).not.toBeNull());
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
        await waitForHomeGovernance(() => expect(writes()).toHaveLength(1));
        // Explicit review preserves an already-disabled trigger; it does not resume its set.
        expect(writes()).toMatchObject([{ expectedTemplateVersion: 1, enabled: triggerEnabled,
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
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflows-column:trigger:digest')).not.toBeNull());
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        // FIN-COMPOSE #10: refusal belongs inside the trigger editor, not an alert.
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflows-column-trigger-popover-failure')).not.toBeNull());
        expect(writes()).toHaveLength(0);
        expect(screen.findByTestId('workflows-column-trigger-popover')).not.toBeNull();
        expect(screen.findAllByType(WebAlertModal)).toHaveLength(0);
        expect(screen.findByTestId('workflows-column:trigger:digest')).not.toBeNull();
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        expect(writes()).toHaveLength(0);
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-delete');
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
    it('leads an Account Library Workflow with its name, keeps its trigger as metadata and opens its existing settings', async () => {
        const set = fixture();
        serve(set);
        const library = await renderHook(() => {
            const view = useWorkflowLibraryView(true);
            return { ...view, editor: useAccountWorkflowEditor({ read: view.accountWorkflows }) };
        });
        await waitForHomeGovernance(() => expect(library.getCurrent().libraryCoverage).toBe('complete'));
        const row = library.getCurrent().libraryRows[0]!;
        expect(library.getCurrent().libraryCount).toBe(1);
        expect(row).toMatchObject({ group: 'library', name: 'Morning digest', accountTrigger: { automationId: 'digest' },
            triggerSummary: formatTriggerSetSummary(set.triggers),
            openTarget: { kind: 'accountTrigger', automationId: 'digest', triggerId: 't1' } });
        expect(workflowLibraryRowTitle(row)).toBe('Morning digest');
        expect(library.getCurrent().editor.popover).toBeNull();
        const target = row.openTarget;
        if (target.kind !== 'accountTrigger') throw new Error('Expected the Account Workflow settings target');
        await act(async () => library.getCurrent().editor.open(target, { current: null }));
        const popover = library.getCurrent().editor.popover;
        if (popover === null) throw new Error('Expected the existing Account Workflow settings editor');
        const screen = await renderAccountScreen(popover);
        expect(screen.findByTestId('workflows-column-trigger-popover-prompt')?.props.value).toBe('Morning digest');
        expect(screen.findByType(TriggerPopover).props.initial).toMatchObject({ when: { kind: 'schedule' } });
        expect(mutations).toEqual([]);
    });
    it('lists a retained trigger whose Workflow is gone and removes it through the existing Action', async () => {
        const set = fixture();
        serve(set);
        // The source lookup answers the same not-found for a deleted and a revoked Workflow.
        rows = [AutomationDefinitionDetailSchema.parse({ ...rows[0]!, id: 'gone', workflowDefinitionId: '22222222-2222-4222-8222-222222222222', updatedAt: 9 })];
        installRow('gone');
        const library = await renderHook(() => {
            const view = useWorkflowLibraryView(true);
            return { ...view, editor: useAccountWorkflowEditor({ read: view.accountWorkflows }) };
        });
        await waitForHomeGovernance(() => expect(library.getCurrent().libraryRows.map(row => row.key)).toEqual(['account-trigger:gone']));
        const row = library.getCurrent().libraryRows[0]!;
        expect(workflowLibraryRowTitle(row)).toBe('workflows.triggers.row.workflowUnavailable');
        if (row.openTarget.kind !== 'accountTrigger') throw new Error('Expected the retained trigger target');
        const target = row.openTarget;
        const screen = await renderAccountScreen(<></>);
        void library.getCurrent().editor.open(target, { current: null });
        // The review body mounts before its decision footer is published to the modal host.
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
        // Exactly one confirmation: the Action's own.
        await waitForHomeGovernance(() => expect(screen.findAllHostsByTestId('actions.confirmation-review')).toHaveLength(1));
        expect(library.getCurrent().editor.popover).toBeNull();
        expect(home.requests.filter(request => request.method === 'DELETE')).toEqual([]);
        await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
        await waitForHomeGovernance(() => expect(rows).toHaveLength(0));
        await waitForHomeGovernance(() => expect(library.getCurrent().libraryRows).toHaveLength(0));
    });
    it('turns a Library Workflow off from its settings through the selected trigger and closes them (Q7: no row switch)', async () => {
        const set = fixture(false, [trigger('t1'), trigger('t2', 19)]); serve(set);
        const library = await renderHook(() => {
            const view = useWorkflowLibraryView(true);
            return { ...view, editor: useAccountWorkflowEditor({ read: view.accountWorkflows }) };
        });
        await waitForHomeGovernance(() => expect(library.getCurrent().libraryCoverage).toBe('complete'));
        const row = library.getCurrent().libraryRows[0]!;
        if (!('accountTrigger' in row)) throw new Error('Expected the Account Workflow row');
        expect(row.triggerOpenTargets.map(target => target.triggerId)).toEqual(['t1', 't2']);
        await act(async () => library.getCurrent().editor.open(row.triggerOpenTargets[1]!, { current: null }));
        const popover = library.getCurrent().editor.popover;
        if (popover === null) throw new Error('Expected the Account Workflow settings editor');
        const screen = await renderAccountScreen(popover);
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-toggle');
        await waitForHomeGovernance(() => expect(writes()).toHaveLength(1));
        expect(writes()).toMatchObject([{ expectedTemplateVersion: 1, triggers: [
            { kind: 'existing', triggerId: 't1', expectedRevision: 1 },
            { kind: 'existing', triggerId: 't2', expectedRevision: 1, enabled: false },
        ] }]);
        expect(library.getCurrent().editor.popover).toBeNull();
    });
    it('enables an off set through one selected-trigger Action instead of first enabling every schedule', async () => {
        const set = { ...fixture(false, [trigger('t1'), trigger('t2', 19)]), enabled: false }; serve(set);
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflows-column:trigger:digest:t2-switch')).not.toBeNull());
        await act(async () => screen.findByTestId('workflows-column:trigger:digest:t2-switch')?.props.onValueChange(true));
        await waitForHomeGovernance(() => expect(writes()).toHaveLength(1));
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
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflows-column:trigger:digest:t2')).not.toBeNull());
        await screen.pressByTestIdAsync('workflows-column:trigger:digest:t2');
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflows-column-trigger-popover-failure')).not.toBeNull());
        expect(writes()).toHaveLength(0);
        expect(screen.findAllByType(WebAlertModal)).toHaveLength(0);
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-delete');
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
        await waitForHomeGovernance(() => expect(screen.findAllByType(WebAlertModal)).toHaveLength(0));
        await waitForHomeGovernance(() => expect(writes()).toHaveLength(1));
        expect(writes()).toMatchObject([{ expectedTemplateVersion: 1, triggers: [{ kind: 'existing', triggerId: 't1', expectedRevision: 1, enabled: false }] }]);
        expect(rows[0]!.triggers[0]!.enabled).toBe(false);
    });
    it('toggles the trigger through its Action and edits Runs on through the same writer', async () => {
        home.answer(serverId, '/v1/machines/m2', {
            body: { machine: createPlainMachineRowFixture({ id: 'm2', accountId: 'account-a' }) },
        });
        const set = fixture(false, [trigger('t1'), trigger('t2', 19)]); serve(set);
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflows-column:trigger:digest:t2-switch')).not.toBeNull());
        const toggle = screen.findByTestId('workflows-column:trigger:digest:t2-switch');
        expect(toggle).not.toBeNull();
        await act(async () => toggle?.props.onValueChange(false));
        await waitForHomeGovernance(() => expect(writes()).toHaveLength(1));
        expect(writes()).toMatchObject([{ expectedTemplateVersion: 1, triggers: [
            { kind: 'existing', triggerId: 't1', expectedRevision: 1 },
            { kind: 'existing', triggerId: 't2', expectedRevision: 1, enabled: false },
        ] }]);
        // The HTTP handler records entry before the real writer publishes its receipt.
        // Open the editor only after that canonical revision is available to the row.
        await waitForHomeGovernance(() => expect(storage.getState().workflowTriggerSetsById.digest)
            .toMatchObject({ revision: 2, triggers: [{ id: 't1', revision: 1 }, { id: 't2', revision: 2, enabled: false }] }));
        await screen.pressByTestIdAsync('workflows-column:trigger:digest:t2');
        const runsOn = screen.findAllByType(TriggerRunsOnRow)[0];
        expect(runsOn).toBeDefined();
        expect(runsOn?.props.target).toEqual(project);
        expect(screen.findByTestId('workflows-column-trigger-popover-submit')?.props.disabled).toBe(false);
        await act(async () => runsOn?.props.onChange({ machineId: 'm2', directory: '/elsewhere' }));
        await act(async () => screen.changeTextByTestId('workflows-column-trigger-popover-prompt', 'Changed prompt'));
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        await waitForHomeGovernance(() => expect(writes()).toHaveLength(2));
        expect(writes().at(-1)).toMatchObject({ expectedTemplateVersion: 2, assignments: [{ machineId: 'm2' }], triggers: [
            { kind: 'existing', triggerId: 't1', expectedRevision: 1 },
            { kind: 'existing', triggerId: 't2', expectedRevision: 2,
                trigger: { kind: 'schedule', schedule: { scheduleExpr: '0 19 * * *' } } },
        ] });
        expect(rows[0]?.triggers[0]).toMatchObject({ id: 't1', revision: 1, enabled: true });
        expect(writtenContext(writes().at(-1)!)).toMatchObject({ workspace: { directory: '/elsewhere' },
            inlineDefinition: { blocks: [{ document: { text: 'Changed prompt' } }] } });
    });

    it('keeps a failed retained-template review locked after conversion refuses a selected schedule, preserving its draft', async () => {
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
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('workflows.triggers.legacy.changeUnavailable'));
        expect(writes()).toEqual([]);
        expect(rows[0]).toMatchObject({ templateVersion: 1, templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN,
            triggers: [{ id: 't1', revision: 1 }, { id: 't2', revision: 1 }] });
        expect(screen.findByTestId('workflows-column-trigger-popover-prompt')?.props.value).toBe('Changed prompt');
        expect(screen.getTextContent()).toContain('workflows.triggers.legacy.changeUnavailable');
        expect(screen.findByTestId('workflows-column-trigger-popover-submit')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        expect(writes()).toEqual([]);
        expect(storage.getState().workflowTriggerSetsById.digest?.revision).toBe(1);
    });

    it('keeps a manual legacy row manual when its prompt is edited', async () => {
        const set = fixture(true, []); serve(set);
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        expect(screen.findByTestId('workflows-column-trigger-popover-run-now')).not.toBeNull();
        await act(async () => screen.changeTextByTestId('workflows-column-trigger-popover-prompt', 'Manual edit'));
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-submit');
        await waitForHomeGovernance(() => expect(writes()).toHaveLength(1));
        expect(writes()).toHaveLength(1);
        expect(writes()[0]!.triggers).toEqual([]);
        expect(writes()[0]!.removedTriggers).toEqual([]);
    });
    it('deletes a manual set with no triggers through whole-set removal and refreshes', async () => {
        const set = fixture(false, []); serve(set);
        const screen = await renderAccountScreen(<AccountTriggersSection />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflows-column:trigger:digest')).not.toBeNull());
        await screen.pressByTestIdAsync('workflows-column:trigger:digest');
        const remove = screen.findByTestId('workflows-column-trigger-popover-delete');
        expect(remove).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.page.deleteWorkflow');
        const listsBefore = listRequests().length;
        // The real Action waits for the person's confirmation before its press settles.
        await act(async () => screen.pressByTestId('workflows-column-trigger-popover-delete'));
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
        expect(home.requests.filter(request => request.method === 'DELETE')).toEqual([]);
        await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
        await waitForHomeGovernance(() => {
            expect(rows).toEqual([]);
            expect(storage.getState().workflowTriggerSetsById.digest).toBeUndefined();
            expect(listRequests().length).toBeGreaterThan(listsBefore);
        });
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
        await act(async () => { await retarget; });
        expect(writes()[0]).toMatchObject({ expectedTemplateVersion: 1,
            workflowDefinitionId: '11111111-1111-4111-8111-111111111111', triggers: [], removedTriggers: [] });
    });
});
