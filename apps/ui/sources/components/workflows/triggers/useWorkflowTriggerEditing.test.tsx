import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowTriggerSetV1Schema, type WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AutomationDefinitionCreateRequestSchema, AutomationDefinitionDetailSchema,
    AutomationDefinitionListResponseSchema, AutomationDefinitionDetailsRequestSchema, AutomationDefinitionReconcileRequestSchema, type AutomationDefinitionDetail} from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema,
    AutomationStoredWorkflowDefinitionV2Schema} from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { WorkflowDefinitionArtifactHeaderV1Schema,
    WorkflowDefinitionArtifactBodyV1Schema} from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { AutomationTriggerIdSchema} from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { AutomationTriggerDetailSchema} from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import { AutomationTriggerDefinitionStoredPayloadV1Schema, sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { AutomationStoredContentEnvelopeV1Schema } from '@happier-dev/protocol/automations/automationEventV1';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationEventJsonBoundsV1';
import { WorkflowDraftTriggerSnapshotV1Schema } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import {
    type AutomationTriggerDefinitionInput} from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { createDeferred, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createWorkflowAutomationTriggerDetailFixture, selectWorkflowAutomationDetailsFixture } from '@/dev/testkit/harness/workflowAutomationHttpBoundary';
import { createSessionFixture, createSessionListRenderableSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { WORKFLOW_STARTER_EXAMPLES_V1, materializeWorkflowStarterExample } from '@happier-dev/protocol/workflows/builtins/examples';
import { WorkflowRunAutomationSummariesResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { AUTOMATION_SESSION_LIFECYCLE_EVENT_GROUPS_V1 } from '@happier-dev/protocol/automations/automationSessionLifecycle';

// Native confirmation is the user-input boundary; these Save/history cases accept it.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
// Locale presentation is outside these read/Action contracts; use the shared translation boundary.
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Native portal and vendor Markdown are platform boundaries; the editor and Actions stay real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 280, placement: 'bottom' }));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

// Expo is the native HTTP boundary; preserve the real host placement and Account Action owners.
vi.mock('expo/fetch', async () => (await import('@/dev/testkit/mocks/expoFetch'))
    .createExpoFetchModuleMock((input, init) => home.request(input, init)));

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } =
    await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { useWorkflowTriggerEditing } = await import('./useWorkflowTriggerEditing');
const { editWorkflowTriggerDraft } = await import('./workflowTriggerDraft');
const { commitWorkflowTriggerWhen } = await import('./workflowTriggerStarts');
const { useWorkflowTriggerSets } = await import('./useWorkflowTriggerSets');
const { SessionTriggersSection: SessionTriggersContent } = await import('./SessionTriggersSection');
const { useSessionTriggers } = await import('./useSessionTriggers');

// Match the Info host: acquire the real Session read once, then render its section.
function SessionTriggersSection(props: Omit<React.ComponentProps<typeof SessionTriggersContent>, 'read'>) {
    const read = useSessionTriggers(props.sessionId);
    return <SessionTriggersContent {...props} read={read} />;
}

const definitionId = '00000000-0000-4000-8000-000000000001';
const projectTarget = { machineId: 'm1', directory: '/repo' };
const trigger = { kind: 'schedule', enabled: true, schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } } as const;
const privateEvent = { kind: 'pluginEvent', enabled: true, eventRef: { pluginId: 'acme.monitor', localId: 'message' },
    sourceInstanceId: 'conversation:42', sourceContractVersion: 1, sourceConfig: { conversation: '42' },
    displayLabel: 'Private conversation', filter: null, maximumObservationAgeMs: null,
    observationTransport: { kind: 'socket', watcherMaterializationRef: {
        machineId: 'm1', pluginId: 'acme.monitor', materializationId: 'monitor-1',
    } } } as const satisfies AutomationTriggerDefinitionInput;
const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'set-1', revision: 1, enabled: true, health: 'available', project: projectTarget,
    target: { kind: 'workflow', ref: definitionId }, triggers: [{ ...trigger, id: 't1', revision: 1, createdAt: 1, updatedAt: 1,
        nextRunAt: null, triggerDefinitionEnvelope: null }] });
const definition = createWorkflowDefinitionFixture({
    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
    inputs: [{ name: 'name', valueType: 'string', required: false }],
});
let rows: AutomationDefinitionDetail[] = [];
let serverId: string;
let disposeLoader: (() => void) | undefined;
let listReply: (() => Promise<ReturnType<typeof AutomationDefinitionListResponseSchema.parse>>)| undefined;
let beforeWrite: (() => Promise<void>) | undefined;
const writes: Array<ReturnType<typeof AutomationDefinitionCreateRequestSchema.parse> | ReturnType<typeof AutomationDefinitionReconcileRequestSchema.parse>> = [];

// Only the Home's stored Automation rows/CAS are synthetic. The Action front door,
// registration, codecs, live-definition reader and hook acknowledgements run for real.
function seed(value: WorkflowTriggerSetV1) {
    const row = AutomationDefinitionDetailSchema.parse({ id: value.automationId, name: 'Workflow triggers', description: null,
        enabled: value.enabled, workflowDefinitionId: definitionId, scopeSessionId: null, targetType: null, existingSessionId: null,
        templateVersion: value.revision, lastRunAt: null, createdAt: 1, updatedAt: 1,
        assignments: [{ machineId: value.project?.machineId ?? projectTarget.machineId, enabled: true, priority: 0, updatedAt: 1 }],
        executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: value.revision,
            workflow: { t: 'plain', v: value.context ?? { workspace: { directory: projectTarget.directory }, executionTarget: { kind: 'session' } } },
            triggerEvidence: null }), triggers: value.triggers });
    rows = [row];
    installRow(row.id);
}
function listRows() {
    return AutomationDefinitionListResponseSchema.parse({ automations: rows.map(({ executionRecipe: _recipe, templateCiphertext: _template, ...row }) => ({
        ...row, triggers: row.triggers.map(({ triggerDefinitionEnvelope: _envelope, ...trigger }) => trigger),
    })), nextCursor: null });
}
function persistedTrigger(id: string, value: AutomationTriggerDefinitionInput, revision = 1, automationId = 'set-1'): AutomationDefinitionDetail['triggers'][number] {
    const base = { ...value, id: AutomationTriggerIdSchema.parse(id), revision, createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null };
    if (value.kind === 'schedule') return AutomationTriggerDetailSchema.parse({ ...base, nextRunAt: null });
    if (value.kind === 'prComment' || value.kind === 'ciFailed') {
        const sourceSessionId = rows.find(row => row.id === automationId)?.scopeSessionId;
        if (!sourceSessionId) throw new Error('PR fixture requires its admitted lifetime Session');
        const envelope = 'triggerDefinitionEnvelope' in value ? value.triggerDefinitionEnvelope
            : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding: {
                v: 1, automationId, triggerId: AutomationTriggerIdSchema.parse(id), triggerRevision: revision, triggerKind: value.kind,
            }, definition: { kind: value.kind, pullRequest: value.pullRequest } });
        return AutomationTriggerDetailSchema.parse({ id, kind: value.kind, enabled: value.enabled, revision,
            createdAt: 1, updatedAt: 1, sourceSessionId, triggerDefinitionEnvelope: JSON.stringify(envelope) });
    }
    if (value.kind === 'sessionLifecycle') return createWorkflowAutomationTriggerDetailFixture(automationId,
        { triggerId: AutomationTriggerIdSchema.parse(id), trigger: value }, revision);
    // The server boundary stores private Event input in its revision-bound envelope.
    if (value.kind === 'pluginEvent' && 'sourceInstanceId' in value && value.observationTransport.kind !== 'durablePush') {
        const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse('00000000-0000-4000-8000-000000000042');
        return AutomationTriggerDetailSchema.parse({ id, revision, enabled: value.enabled, createdAt: 1, updatedAt: 1,
            kind: value.kind, eventRef: value.eventRef, sourceSelectorId, sourceContractVersion: value.sourceContractVersion,
            observation: { kind: value.observationTransport.kind,
                watcher: { ...value.observationTransport.watcherMaterializationRef, machineInstallationId: 'observer-installation' } },
            sourceStatus: null, sourceCatalogStatus: null,
            triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, automationId, triggerId: AutomationTriggerIdSchema.parse(id), triggerRevision: revision,
                    triggerKind: value.kind, eventRef: value.eventRef, sourceSelectorId },
                definition: { v: 1, sourceInstanceId: value.sourceInstanceId, sourceConfig: value.sourceConfig,
                    displayLabel: value.displayLabel, filter: value.filter, maximumObservationAgeMs: value.maximumObservationAgeMs } })) });
    }
    throw new Error('Creation fixture supports schedules and Session lifecycle only');
}
function installRow(id: string) {
    const path = `/v3/automations/${id}`;
    home.answer(serverId, `GET ${path}`, { select: () => ({ body: rows.find(row => row.id === id) }) });
    home.answer(serverId, `PUT ${path}`, { select: async raw => {
        const input = AutomationDefinitionReconcileRequestSchema.parse(raw);
        writes.push(input);
        const current = rows.find(row => row.id === id);
        if (!current) return { status: 404, body: { error: 'not_found' } };
        if (input.expectedTemplateVersion !== current.templateVersion) return { status: 409, body: { error: 'template_version_conflict' } };
        if ([...input.triggers.filter(value => value.kind === 'existing'), ...input.removedTriggers]
            .some(value => current.triggers.find(trigger => trigger.id === value.triggerId)?.revision !== value.expectedRevision)) {
            return { status: 409, body: { error: 'trigger_revision_conflict' } };
        }
        await beforeWrite?.();
        const row = AutomationDefinitionDetailSchema.parse({ ...current, name: input.name, description: input.description, enabled: input.enabled,
            workflowDefinitionId: input.workflowDefinitionId ?? current.workflowDefinitionId,
            executionRecipe: input.executionRecipe ?? current.executionRecipe, templateVersion: current.templateVersion + 1,
            assignments: input.assignments.map(value => ({ ...value, enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })),
            triggers: input.triggers.map(value => {
                if (value.kind === 'new') return persistedTrigger(value.triggerId, value.trigger, 1, id);
                const trigger = current.triggers.find(candidate => candidate.id === value.triggerId);
                if (!trigger) throw new Error('Missing retained trigger');
                const updated = value.trigger ? persistedTrigger(trigger.id,
                    { ...value.trigger, enabled: value.enabled ?? trigger.enabled }, trigger.revision + 1, id) : trigger;
                const revision = trigger.revision + (value.trigger || value.enabled !== undefined ? 1 : 0);
                // The plain HTTP writer rebinds retained private content when enablement changes its revision.
                let triggerDefinitionEnvelope = updated.triggerDefinitionEnvelope;
                if (!value.trigger && value.enabled !== undefined && triggerDefinitionEnvelope) {
                    const envelope = AutomationStoredContentEnvelopeV1Schema.parse(JSON.parse(triggerDefinitionEnvelope));
                    if (envelope.t !== 'plain') throw new Error('Expected the plain HTTP fixture');
                    const payload = AutomationTriggerDefinitionStoredPayloadV1Schema.parse(envelope.v);
                    triggerDefinitionEnvelope = JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                        binding: { ...payload.binding, triggerRevision: revision }, definition: payload.definition }));
                }
                return { ...updated, ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
                    revision, triggerDefinitionEnvelope };
            }) });
        rows = rows.map(value => value.id === id ? row : value);
        return { body: row };
    } });
}
function listRequests() { return home.requests.filter(request => request.path === '/v3/automations/query'); }
let channels: Awaited<ReturnType<typeof import('@/dev/testkit/harness/portableAccountPlugin').installPortableAccountPluginReleaseForTest>> | undefined;
async function seedChannels() {
    await channels?.dispose();
    const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-channels/manifest');
    const { activate } = await import('@happier-dev/plugins-channels/happier-plugin-ui/channels-account-runtime');
    const [{ normalizePluginAccountCollectionContractV1}, { PluginAccountCollectionContributionV1Schema}] = await Promise.all([import('@happier-dev/protocol/plugins/data/collectionsV1'), import('@happier-dev/protocol/plugins/data/collectionContributionV1')]);
    const contribution = PLUGIN_MANIFEST.contributes?.accountCollections?.find(entry => entry.id === 'channel-state');
    if (!contribution) throw new Error('Missing Channels producer contract');
    const contract = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels',
        contribution: PluginAccountCollectionContributionV1Schema.parse(contribution) });
    home.answer(serverId, '/v1/plugins/data/contract', { body: { access: 'readOnly', contract } });
    home.answer(serverId, '/v1/plugins/data/query', { body: { rows: [], changeCursor: 1 } });
    home.answer(serverId, '/v1/plugins/data/get', { body: { row: null, absenceEpoch: 0 } });
    home.answer(serverId, '/v1/account/plugin-settings/happier.channels', { body: { status: 'absent' } });
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Active Account required');
    const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
    channels = await installPortableAccountPluginReleaseForTest({ manifest: PLUGIN_MANIFEST, activate,
        accountLifetime: lifetime, publishProjection: true });
}
/** The explicit Session Machine is a remote process; its HTTP carrier stays below real admission. */
async function answerChannelsMachineMetadata() {
    const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
    const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
    const { SessionPullRequestWatchInputV1Schema, SessionPullRequestWatchReadResultV1Schema } = await import('@happier-dev/channels-protocol/v1');
    await answerExternalActionAccountForHome(home, serverId, {
        machineId: projectTarget.machineId, actionId: 'action.invoke', tokenEpoch: 0,
        execute(input) {
            const invocation = getActionSpec('action.invoke').inputSchema.parse(input);
            expect(invocation.action).toEqual({ pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' });
            const request = SessionPullRequestWatchInputV1Schema.parse(invocation.input);
            if (request.kind !== 'get') throw new Error('Expected a Session pull-request metadata read');
            return SessionPullRequestWatchReadResultV1Schema.parse({ kind: 'ready', sessionId: request.sessionId, bindings: [] });
        },
    });
}
const previousPlatform = Platform.OS;
function resetTriggerSets() {
    const state = storage.getState();
    if (!('resetWorkflowTriggerSets' in state) || typeof state.resetWorkflowTriggerSets !== 'function') throw new Error('Real trigger store reset required');
    state.resetWorkflowTriggerSets();
}
let previous = storage.getState();
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
    await loadSyncSingletonForTests();
    previous = storage.getState();
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    disposeLoader = await installRealActionExecutorModuleLoader();
    const homeProfileId = await home.addHome({ name: 'Trigger history', serverUrl: `https://trigger-history-${crypto.randomUUID()}.test`,
        accountId: 'account-a', currentAccount: true, serverIdentityId: `srv_trigger-history-${crypto.randomUUID()}` });
    serverId = (await import('@/sync/domains/server/serverProfiles')).resolveServerProfileScopeIdForIdentifier(homeProfileId);
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    // Restore Sync through the real census so the Session's Machine has answered scoped presence.
    home.answer(serverId, '/v1/machines', { select: () => ({ body: [createPlainMachineRowFixture({
        id: projectTarget.machineId, accountId: 'account-a',
    })] }) });
    // Trigger custody resolves the selected Machine's current Account access at HTTP admission.
    home.answer(serverId, `/v1/machines/${projectTarget.machineId}`, {
        body: { machine: createPlainMachineRowFixture({ id: projectTarget.machineId, accountId: 'account-a' }) },
    });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' },
        sessions: { 'session-a': createSessionFixture({ id: 'session-a', serverId, active: false, metadata: {
            machineId: projectTarget.machineId, path: projectTarget.directory, host: 'test', homeDir: '/home/test' } }) } });
    home.answer(serverId, '/v2/sessions/session-a', { select: () => {
        const session = storage.getState().sessions['session-a'];
        return session ? { body: createPlainSessionByIdResponseFixture(session) }
            : { status: 404, body: { error: 'session_not_found' } };
    } });
    resetTriggerSets();
    rows = [];
    writes.length = 0;
    listReply = undefined;
    beforeWrite = undefined;
    home.answer(serverId, 'GET /v3/automations', { select: async () => ({ body: await listReply?.() ?? listRows() }) });
    home.answer(serverId, 'POST /v3/automations', { select: async raw => {
        const input = AutomationDefinitionCreateRequestSchema.parse(raw);
        writes.push(input);
        await beforeWrite?.();
        const row = AutomationDefinitionDetailSchema.parse({ id: input.automationId, name: input.name, description: input.description ?? null,
            enabled: input.enabled, workflowDefinitionId: input.workflowDefinitionId ?? null, scopeSessionId: input.scopeSessionId ?? null,
            targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
            executionRecipe: input.executionRecipe, assignments: input.assignments?.map(value => ({ ...value,
                enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })) ?? [],
            triggers: input.triggers.map(value => persistedTrigger(value.triggerId, value.trigger, 1, input.automationId)) });
        rows = [...rows, row];
        installRow(row.id);
        return { body: row };
    } });
    await home.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: definitionId,
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent(WorkflowDefinitionArtifactHeaderV1Schema.parse({ kind: 'workflow-definition.v1', definitionId,
            revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'History' }, previewSteps: [] })),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(WorkflowDefinitionArtifactBodyV1Schema.parse({ kind: 'workflow-definition.v1', definition })) }),
    }) });
    await seedChannels();
});
afterEach(async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: previousPlatform });
    await standardCleanup();
    await channels?.dispose(); channels = undefined;
    resetTriggerSets();
    (await import('../library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    await home.reset();
    disposeLoader?.();
    storage.setState(previous);
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable);
});

describe('workflow trigger editing lifetime', () => {
    it('keeps intended Event membership unknown until a saved workflow read settles', async () => {
        const held = createDeferred<void>();
        home.answer(serverId, 'POST /v3/automations/query', { select: async input => {
            await held.promise;
            return { body: selectWorkflowAutomationDetailsFixture(rows, input) };
        } });
        const hook = await renderHook(() => useWorkflowTriggerEditing({ definitionId, sourceKey: 'pending-event-membership', projectTarget }));
        try {
            expect(hook.getCurrent().status).toBe('loading');
            expect(hook.getCurrent().triggerEvents).toBeUndefined();
            expect(hook.getCurrent().intendedTriggers).toBeUndefined();
            await act(async () => { held.resolve(); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
            expect(hook.getCurrent().triggerEvents).toEqual([]);
            expect(hook.getCurrent().intendedTriggers).toEqual([]);
        } finally {
            held.resolve();
            await hook.unmount();
        }
    });

    it('projects declared Event fields once per editor read and follows unsaved trigger membership through history', async () => {
        const payloadSchema = { type: 'object', properties: { title: { type: 'string', title: 'Title' } }, additionalProperties: false } as const;
        const savedId = AutomationTriggerIdSchema.parse('declared-event');
        seed(WorkflowTriggerSetV1Schema.parse({ ...set, triggers: [{ ...persistedTrigger(savedId, { ...privateEvent, enabled: false }), payloadSchema }] }));
        const hook = await renderHook(() => useWorkflowTriggerEditing({ definitionId, sourceKey: 'declared-events', projectTarget }));
        await flushHookEffects();
        expect(hook.getCurrent().triggerEvents).toEqual([{ event: privateEvent.eventRef, payloadSchema }]);
        expect(hook.getCurrent().intendedTriggers).toMatchObject([{ kind: 'pluginEvent', automationId: set.automationId,
            triggerId: savedId, eventRef: privateEvent.eventRef }]);
        const reads = listRequests().length;
        const before = hook.getCurrent().captureSnapshot();
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'remove', triggerId: savedId })));
        expect(hook.getCurrent().triggerEvents).toEqual([]);
        await act(async () => hook.getCurrent().restoreSnapshot(before));
        expect(hook.getCurrent().triggerEvents).toEqual([{ event: privateEvent.eventRef, payloadSchema }]);
        const newEvent = { ...privateEvent, eventRef: { ...privateEvent.eventRef, localId: 'created' } };
        await act(async () => {
            const next = commitWorkflowTriggerWhen({ draft: hook.getCurrent().draft, row: { kind: 'new', clientId: 'created' },
                when: { kind: 'pluginEvent', value: newEvent, payloadSchema }, enabled: true });
            if (!next) throw new Error('Expected the completed Event to join the draft');
            hook.getCurrent().setDraft(next);
        });
        const added = hook.getCurrent().captureSnapshot();
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'discardAdd', clientId: 'created' })));
        await act(async () => hook.getCurrent().restoreSnapshot(WorkflowDraftTriggerSnapshotV1Schema.parse(added)));
        expect(hook.getCurrent().triggerEvents).toEqual([{ event: privateEvent.eventRef, payloadSchema }, { event: newEvent.eventRef, payloadSchema }]);
        expect(hook.getCurrent().intendedTriggers).toMatchObject([{ kind: 'pluginEvent', triggerId: savedId },
            { kind: 'pluginEvent', eventRef: newEvent.eventRef, observationTransport: newEvent.observationTransport }]);
        expect(listRequests()).toHaveLength(reads);
    });

    it('restores a demand-loaded private Event value through Undo and Redo before and after Save', async () => {
        const original = { ...privateEvent, maximumObservationAgeMs: 120_000 };
        const savedId = AutomationTriggerIdSchema.parse('saved-private-event');
        seed(WorkflowTriggerSetV1Schema.parse({ ...set, triggers: [persistedTrigger(savedId, original)] }));
        const hook = await renderHook(() => useWorkflowTriggerEditing({ definitionId, sourceKey: 'private-loaded-history', projectTarget }));
        await flushHookEffects();
        expect(hook.getCurrent().captureSnapshot().rows).toMatchObject([{ trigger: null }]);
        // The Event editor already read this private input before the person changes it.
        const before = hook.getCurrent().captureSnapshot(undefined, { triggerId: savedId, revision: 1, trigger: original });
        expect(before.rows).toMatchObject([{ trigger: original }]);
        expect(hook.getCurrent().dirty).toBe(false);
        const changed = { ...original, maximumObservationAgeMs: 120_001 };
        const { enabled: _enabled, ...changedDefinition } = changed;
        const next = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'update', triggerId: savedId, trigger: changedDefinition });
        const after = hook.getCurrent().captureSnapshot(next);
        await act(async () => hook.getCurrent().setDraft(next));
        await act(async () => { hook.getCurrent().restoreSnapshot(before); });
        expect(hook.getCurrent().captureSnapshot().rows).toMatchObject([{ trigger: original }]);
        expect(hook.getCurrent().dirty).toBe(false);
        await act(async () => { hook.getCurrent().restoreSnapshot(after); });
        expect(hook.getCurrent().captureSnapshot().rows).toMatchObject([{ trigger: changed }]);
        await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'); });
        expect(hook.getCurrent().dirty).toBe(false);
        expect(hook.getCurrent().captureSnapshot(undefined, { triggerId: savedId, revision: 1, trigger: original }).rows)
            .toMatchObject([{ trigger: changed }]);
        await act(async () => { hook.getCurrent().restoreSnapshot(before); });
        expect(hook.getCurrent().captureSnapshot().rows).toMatchObject([{ trigger: original }]);
        expect(hook.getCurrent().draft.updates[savedId]?.trigger).toMatchObject({ maximumObservationAgeMs: 120_000 });
        expect(hook.getCurrent().dirty).toBe(true);
        await act(async () => { hook.getCurrent().restoreSnapshot(WorkflowDraftTriggerSnapshotV1Schema.parse(after)); });
        expect(hook.getCurrent().captureSnapshot().rows).toMatchObject([{ trigger: changed }]);
        expect(hook.getCurrent().dirty).toBe(false);
        expect(writes).toHaveLength(1);
    });

    it('settles a private Event Save and preserves Undo/Redo before and after acknowledgement', async () => {
        const hook = await renderHook(() => useWorkflowTriggerEditing({ definitionId, sourceKey: 'private-save', projectTarget }));
        const before = hook.getCurrent().captureSnapshot();
        const next = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'private-event', trigger: privateEvent });
        const after = hook.getCurrent().captureSnapshot(next);
        await act(async () => hook.getCurrent().setDraft(next));
        await act(async () => { hook.getCurrent().restoreSnapshot(before); });
        expect(hook.getCurrent().dirty).toBe(false);
        await act(async () => { hook.getCurrent().restoreSnapshot(after); });
        expect(hook.getCurrent().draft.adds).toMatchObject([{ trigger: privateEvent }]);
        await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'); });
        expect(rows[0]?.triggers).toMatchObject([{ kind: 'pluginEvent' }]);
        expect(hook.getCurrent().dirty).toBe(false);
        expect(hook.getCurrent().captureSnapshot().rows).toMatchObject([{ trigger: privateEvent }]);
        await act(async () => { hook.getCurrent().restoreSnapshot(before); });
        expect(hook.getCurrent().draft.removes).toEqual([rows[0]!.triggers[0]!.id]);
        // Agent history uses the strict wire snapshot, without editor-only acknowledgement state.
        await act(async () => { hook.getCurrent().restoreSnapshot(WorkflowDraftTriggerSnapshotV1Schema.parse(after)); });
        expect(hook.getCurrent().dirty).toBe(false);
        await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'); });
        expect(writes).toHaveLength(1);
    });

    it('keeps a newer private Event edit during Save and rebases history after its later Save', async () => {
        const deferred = createDeferred<void>();
        beforeWrite = () => deferred.promise;
        const hook = await renderHook(() => useWorkflowTriggerEditing({ definitionId, sourceKey: 'private-newer', projectTarget }));
        const next = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'private-event', trigger: privateEvent });
        const original = hook.getCurrent().captureSnapshot(next);
        await act(async () => hook.getCurrent().setDraft(next));
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        const changed = { ...privateEvent, maximumObservationAgeMs: 60_000 };
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
            { kind: 'add', clientId: 'private-event', trigger: changed })));
        await act(async () => { deferred.resolve(); expect(await saving).toBe('saved'); });
        const savedId = rows[0]!.triggers[0]!.id;
        const { enabled: _enabled, ...changedDefinition } = changed;
        expect(hook.getCurrent().draft.updates).toEqual({ [savedId]: { trigger: changedDefinition } });
        expect(hook.getCurrent().dirty).toBe(true);
        const changedSnapshot = hook.getCurrent().captureSnapshot();
        await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'); });
        expect(hook.getCurrent().dirty).toBe(false);
        await act(async () => { hook.getCurrent().restoreSnapshot(original); });
        const { enabled: _originalEnabled, ...originalDefinition } = privateEvent;
        expect(hook.getCurrent().draft.updates).toEqual({ [savedId]: { trigger: originalDefinition } });
        await act(async () => { hook.getCurrent().restoreSnapshot(changedSnapshot); });
        expect(hook.getCurrent().dirty).toBe(false);
        expect(writes).toHaveLength(2);
    });

    it('retries only the unacknowledged private Event after a partial Save', async () => {
        const hook = await renderHook(() => useWorkflowTriggerEditing({ definitionId, sourceKey: 'private-retry', projectTarget }));
        await act(async () => {
            let next = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'first', trigger: privateEvent });
            next = editWorkflowTriggerDraft(next, { kind: 'add', clientId: 'second', trigger: { ...privateEvent,
                eventRef: { ...privateEvent.eventRef, localId: 'reaction' } } });
            hook.getCurrent().setDraft(next);
        });
        beforeWrite = async () => { if (writes.length === 2) throw new Error('disconnected'); };
        await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('failed'); });
        expect(hook.getCurrent().draft.adds.map(add => add.clientId)).toEqual(['second']);
        expect(hook.getCurrent().draft.updates).toEqual({});
        beforeWrite = undefined;
        await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'); });
        expect(hook.getCurrent().dirty).toBe(false);
        expect(rows[0]?.triggers).toHaveLength(2);
        expect(writes).toHaveLength(3);
    });

    it('settles an enabled-only private Event Save without recreating its accepted private edit', async () => {
        const hook = await renderHook(() => useWorkflowTriggerEditing({ definitionId, sourceKey: 'private-enabled', projectTarget }));
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
            { kind: 'add', clientId: 'private-event', trigger: privateEvent })));
        await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'); });
        const enabled = hook.getCurrent().captureSnapshot();
        const savedId = rows[0]!.triggers[0]!.id;
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
            { kind: 'update', triggerId: savedId, enabled: false })));
        await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'); });
        expect(hook.getCurrent().dirty).toBe(false);
        expect(hook.getCurrent().captureSnapshot().rows).toMatchObject([{ trigger: { ...privateEvent, enabled: false } }]);
        await act(async () => { hook.getCurrent().restoreSnapshot(enabled); });
        expect(hook.getCurrent().draft.updates).toEqual({ [savedId]: { enabled: true } });
        expect(writes).toHaveLength(2);
    });

    it.each(['add', 'update'] as const)('acknowledges an accepted %s even when subsequent Workflow reads fail', async operation => {
        if (operation === 'update') seed(set);
        const hook = await renderHook(() => useWorkflowTriggerEditing({ definitionId, sourceKey: 'save-ack', projectTarget }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
            operation === 'add' ? { kind: 'add', clientId: 'accepted-trigger', trigger }
                : { kind: 'update', triggerId: AutomationTriggerIdSchema.parse('t1'), enabled: false })));
        beforeWrite = async () => {
            home.answer(serverId, `GET /v1/artifacts/${definitionId}`, { status: 503, body: { error: 'unavailable' } });
        };
        await act(async () => expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'));
        expect(hook.getCurrent().dirty).toBe(false);
        expect(hook.getCurrent().captureSnapshot().rows).toMatchObject([{ enabled: operation === 'add' }]);
        expect(rows[0]?.triggers).toMatchObject([{ enabled: operation === 'add' }]);
        await act(async () => expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'));
        expect(writes).toHaveLength(1);
    });
    it('does not reopen private trigger definitions for unrelated planned Home arrivals', async () => {
        seed(set);
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { planSyncActionsFromChanges } = await import('@/sync/runtime/orchestration/changesPlanner');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the real Account lifetime');
        const hook = await renderHook(() => useWorkflowTriggerSets({ scope: 'account_all' }, lifetime));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const detailReads = () => listRequests().length;
        const initialReads = detailReads();
        expect(initialReads).toBe(1);
        for (let index = 0; index < 12; index++) {
            const changes = [{ cursor: index + 1, kind: 'machine' as const, entityId: `machine-${index}`, changedAt: index + 1, hint: null }];
            const planned = planSyncActionsFromChanges(changes);
            await act(async () => publishHomeAccountChange(serverId, changes.map(change => change.entityId), {
                feedPageConsumed: true, changeKinds: changes.map(change => change.kind),
                accountSettingsAffects: planned.invalidate.settings, profileCatalogAffects: false,
            }));
            await flushHookEffects();
        }
        expect(detailReads() - initialReads).toBe(0);
        expect(hook.getCurrent().sets.map(value => value.automationId)).toEqual([set.automationId]);
        await act(async () => publishHomeAccountChange(serverId, undefined, { source: 'connected' }));
        await waitForHomeGovernance(() => expect(detailReads()).toBe(initialReads + 1));
        await hook.unmount();
    });

    it('re-reads on a primary reconnect only while its own last read is not current', async () => {
        seed(set);
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the real Account lifetime');
        const hook = await renderHook(() => useWorkflowTriggerSets({ scope: 'account_all' }, lifetime));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const reads = () => listRequests().length;
        const primaryReconnect = () => publishHomeAccountChange(serverId, undefined, { source: 'connected', changesCatchUp: true });

        const currentReads = reads();
        await act(async () => primaryReconnect());
        await flushHookEffects();
        expect(reads()).toBe(currentReads);

        listReply = () => Promise.reject(new Error('home_unavailable'));
        await act(async () => publishHomeAccountChange(serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('failed'));
        const failedReads = reads();

        listReply = undefined;
        await act(async () => primaryReconnect());
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(reads()).toBe(failedReads + 1);
        await hook.unmount();
    });

    it('keeps an addressed saved workflow trigger acknowledgement visible without a socket wake', async () => {
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the real Account lifetime');
        const hook = await renderHook(() => useWorkflowTriggerEditing({ definitionId, sourceKey: 'saved', projectTarget,
            accountLifetime: lifetime }));
        expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
        await act(async () => { hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
            { kind: 'add', clientId: 'new-trigger', trigger })); });
        await act(async () => {
            const outcome = await hook.getCurrent().save(definitionId, () => true);
            expect(outcome).toBe('saved');
        });
        const acknowledged = hook.getCurrent().captureSnapshot();
        expect(acknowledged.rows).toMatchObject([{ identity: { clientId: 'new-trigger', triggerId: expect.any(String) }, trigger }]);
        expect(hook.getCurrent().dirty).toBe(false);
        await act(async () => { hook.getCurrent().restoreSnapshot({ ...acknowledged, rows: [] }); });
        expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
        await act(async () => { hook.getCurrent().restoreSnapshot(acknowledged); });
        expect(hook.getCurrent().captureSnapshot()).toEqual(acknowledged);
        expect(hook.getCurrent().dirty).toBe(false);
        expect(writes).toHaveLength(1);
        await act(async () => { await home.switchAccount(serverId, 'account-b'); });
        expect(lifetime.isCurrent()).toBe(false);
        expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
        await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('stale'); });
        expect(writes).toHaveLength(1);
    });
    it.each([
        { unfocusedBeforeSave: false, delayedRead: false },
        { unfocusedBeforeSave: true, delayedRead: false },
        { unfocusedBeforeSave: true, delayedRead: true },
        { unfocusedBeforeSave: false, delayedRead: true },
    ])('retains an acknowledged trigger across an addressed Home focus change (unfocused: $unfocusedBeforeSave, delayed read: $delayedRead)', async ({ unfocusedBeforeSave, delayedRead }) => {
        const otherServerId = await home.addHome({ name: 'Other triggers', serverUrl: 'https://acknowledged-trigger-other-home.test',
            accountId: 'account-b', active: false });
        const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { listWorkflowTriggerSets } = await import('@/sync/domains/workflows/workflowTriggerActions');
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            return { binding, ...useWorkflowTriggerEditing({ definitionId, sourceKey: 'saved', projectTarget,
                accountLifetime: binding ?? null }) };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const binding = hook.getCurrent().binding;
        if (!binding) throw new Error('Expected the real addressed Account binding');
        const focusOtherHome = async () => {
            await act(async () => {
                await setActiveServerId(otherServerId, { scope: 'tab' });
                publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
                storage.setState({ profileScope: { serverId: otherServerId, accountId: 'account-b' },
                    settingsScope: { serverId: otherServerId, accountId: 'account-b' } });
                resetTriggerSets();
                storage.getState().upsertWorkflowTriggerSet({ set: { ...set, automationId: 'other-account-set' },
                    queryKey: `workflow:${definitionId}` });
            });
        };
        if (unfocusedBeforeSave) await focusOtherHome();
        const releaseWrite = createDeferred<void>();
        const pendingRead = createDeferred<void>();
        const releaseOldList = createDeferred<void>();
        const settling: Promise<unknown>[] = [];
        try {
            beforeWrite = () => releaseWrite.promise;
            await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
                { kind: 'add', clientId: 'new-trigger', trigger })));
            let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
            await act(async () => {
                saving = hook.getCurrent().save(definitionId, () => true);
                settling.push(Promise.allSettled([saving]));
            });
            // Add must finish its census before we hold a stale observation. Holding
            // that census would deadlock Save before it can reach the POST boundary.
            await waitForHomeGovernance(() => expect(writes).toHaveLength(1));
            let staleRead: ReturnType<typeof listWorkflowTriggerSets> | undefined;
            if (delayedRead) {
                let readStarted = false;
                listReply = async () => {
                    const page = listRows();
                    readStarted = true;
                    await pendingRead.promise;
                    return page;
                };
                // Keep a logical borrower alive when acknowledgement retires the
                // hook's read, so the stale physical response actually completes.
                await act(async () => {
                    hook.getCurrent().retry();
                    staleRead = listWorkflowTriggerSets({ workflow: definitionId }, { accountLifetime: binding });
                    settling.push(Promise.allSettled([staleRead]));
                });
                await waitForHomeGovernance(() => expect(readStarted).toBe(true));
            }
            await act(async () => { releaseWrite.resolve(); expect(await saving).toBe('saved'); });
            const acknowledged = hook.getCurrent().captureSnapshot();
            expect(acknowledged.rows).toMatchObject([{ trigger }]);
            if (delayedRead) {
                await act(async () => { pendingRead.resolve(); expect(await staleRead).toEqual([]); });
                expect(hook.getCurrent().captureSnapshot()).toEqual(acknowledged);
            }
            if (!unfocusedBeforeSave) await focusOtherHome();
            expect(hook.getCurrent().binding).toBe(binding);
            expect(binding?.isCurrent()).toBe(true);
            expect(hook.getCurrent().captureSnapshot()).toEqual(acknowledged);
            expect(hook.getCurrent().dirty).toBe(false);
            if (unfocusedBeforeSave && delayedRead) {
                const saved = rows[0]!;
                let oldListRequested = false;
                listReply = async () => {
                    const page = listRows();
                    oldListRequested = true;
                    await releaseOldList.promise;
                    return page;
                };
                let oldRead!: ReturnType<typeof listWorkflowTriggerSets>;
                await act(async () => {
                    hook.getCurrent().retry();
                    oldRead = listWorkflowTriggerSets({ workflow: definitionId }, { accountLifetime: binding });
                    settling.push(Promise.allSettled([oldRead]));
                });
                await waitForHomeGovernance(() => expect(oldListRequested).toBe(true));
                listReply = undefined;
                await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
                    { kind: 'remove', triggerId: saved.triggers[0]!.id })));
                await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'); });
                expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
                expect(hook.getCurrent().dirty).toBe(false);
                await act(async () => {
                    releaseOldList.resolve();
                    expect(await oldRead).toMatchObject([{ automationId: saved.id }]);
                });
                expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
            }
            const staleSave = hook.getCurrent().save;
            await act(async () => {
                // The replacement Account owns a different Automation collection.
                rows = [];
                await home.switchAccount(serverId, 'replacement-account');
            });
            expect(binding?.isCurrent()).toBe(false);
            expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
            await act(async () => { expect(await staleSave(definitionId, () => true)).toBe('stale'); });
            expect(writes).toHaveLength(unfocusedBeforeSave && delayedRead ? 2 : 1);
        } finally {
            await act(async () => {
                releaseWrite.resolve();
                pendingRead.resolve();
                releaseOldList.resolve();
                await Promise.all(settling);
            });
        }
    });
    it('keeps reads started during Save from replacing its receipt across default and addressed lifetimes', async () => {
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { listWorkflowTriggerSets } = await import('@/sync/domains/workflows/workflowTriggerActions');
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            return { binding, ...useWorkflowTriggerEditing({ definitionId, sourceKey: 'saved', projectTarget,
                accountLifetime: binding ?? null }) };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const binding = hook.getCurrent().binding;
        if (!binding) throw new Error('Expected the real addressed Account binding');
        const releaseWrite = createDeferred<void>();
        const releaseReads = createDeferred<void>();
        const settling: Promise<unknown>[] = [];
        try {
            beforeWrite = () => releaseWrite.promise;
            await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
                { kind: 'add', clientId: 'new-trigger', trigger })));
            let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
            await act(async () => {
                saving = hook.getCurrent().save(definitionId, () => true);
                settling.push(Promise.allSettled([saving]));
            });
            await waitForHomeGovernance(() => expect(writes).toHaveLength(1));
            let readsStarted = 0;
            listReply = async () => {
                const page = listRows();
                readsStarted += 1;
                await releaseReads.promise;
                return page;
            };
            const ordinary = listWorkflowTriggerSets({ workflow: definitionId });
            const addressed = listWorkflowTriggerSets({ workflow: definitionId }, { accountLifetime: binding });
            settling.push(Promise.allSettled([ordinary, addressed]));
            // These are independent Action admissions borrowing one physical JSON
            // acquisition. A mis-bound caller still fails its own Account admission.
            await waitForHomeGovernance(() => expect(readsStarted).toBe(1));
            await expect(listWorkflowTriggerSets({ workflow: definitionId }, {
                accountLifetime: binding, context: { runtimeAccountId: 'wrong-account' },
            })).rejects.toMatchObject({ rawCode: 'action_account_scope_changed' });
            await act(async () => { releaseWrite.resolve(); expect(await saving).toBe('saved'); });
            const acknowledged = hook.getCurrent().captureSnapshot();
            expect(acknowledged.rows).toMatchObject([{ trigger }]);
            await act(async () => {
                releaseReads.resolve();
                expect(await ordinary).toEqual([]);
                expect(await addressed).toEqual([]);
            });
            expect(hook.getCurrent().captureSnapshot()).toEqual(acknowledged);
            expect(readsStarted).toBe(1);
            // A new read after acknowledgement still has authority to observe deletion.
            rows = [];
            listReply = undefined;
            await act(async () => { expect(await listWorkflowTriggerSets({ workflow: definitionId })).toEqual([]); });
            expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
        } finally {
            await act(async () => {
                releaseWrite.resolve();
                releaseReads.resolve();
                await Promise.all(settling);
            });
        }
    });
    it('publishes only changed addressed trigger rows across unchanged refreshes and reordering', async () => {
        seed(set);
        const firstRow = rows[0]!;
        rows = [firstRow, { ...firstRow, id: 'set-2' }];
        installRow('set-2');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const publications: Array<readonly WorkflowTriggerSetV1[]> = [];
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            const read = useWorkflowTriggerSets({ workflow: definitionId }, binding ?? null);
            React.useEffect(() => { publications.push(read.sets); }, [read.sets]);
            return { binding, ...read };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sets).toHaveLength(2));
        await act(async () => {
            const otherServerId = await home.addHome({ name: 'Other trigger refreshes',
                serverUrl: 'https://other-trigger-refresh-home.test', accountId: 'account-b' });
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
            storage.setState({ profileScope: { serverId: otherServerId, accountId: 'account-b' },
                settingsScope: { serverId: otherServerId, accountId: 'account-b' } });
            resetTriggerSets();
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding?.isCurrent()).toBe(true));
        const captured = hook.getCurrent().sets;
        publications.length = 0;
        for (let refresh = 0; refresh < 3; refresh++) {
            await act(async () => hook.getCurrent().retry());
            await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
            expect(hook.getCurrent().sets).toBe(captured);
        }
        expect(publications).toHaveLength(0);

        rows = [{ ...rows[1]!, enabled: false, templateVersion: 2 }, rows[0]!];
        await act(async () => hook.getCurrent().retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().sets[0]).toMatchObject({ automationId: 'set-2', enabled: false }));
        expect(publications).toHaveLength(1);
        expect(hook.getCurrent().sets[1]).toBe(captured[0]);
        expect(hook.getCurrent().sets[0]).not.toBe(captured[1]);
        expect(hook.getCurrent().sets[0]?.triggers).toBe(captured[1]?.triggers);
        await hook.unmount();
    });

    it('keeps an unfocused addressed Home independent of the focused Account trigger projection', async () => {
        seed(set);
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            return { binding, ...useWorkflowTriggerSets({ workflow: definitionId }, binding ?? null) };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sets).toMatchObject([{ automationId: set.automationId }]));
        await act(async () => {
            const otherServerId = await home.addHome({ name: 'Other triggers', serverUrl: 'https://other-trigger-home.test', accountId: 'account-b' });
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
            storage.setState({ profileScope: { serverId: otherServerId, accountId: 'account-b' },
                settingsScope: { serverId: otherServerId, accountId: 'account-b' } });
            resetTriggerSets();
            storage.getState().upsertWorkflowTriggerSet({ set: { ...set, automationId: 'other-account-set' },
                queryKey: `workflow:${definitionId}` });
        });
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().binding?.isCurrent()).toBe(true);
            expect(hook.getCurrent().sets.map(value => value.automationId)).toEqual([set.automationId]);
        });
    });
    it.each([null, 'session-b'])('edits a bound Habit schedule through its real form and Action without changing scope or admission (scope %s)', async (scopeSessionId) => {
        const example = WORKFLOW_STARTER_EXAMPLES_V1.find(value => value.key === 'daily-summary-in-session')!;
        const selection = materializeWorkflowStarterExample(example, { session: { sessionId: 'session-a', machineId: 'm1' } });
        if (selection.status !== 'ready') throw new Error('Session-bound example required');
        seed(set);
        if (scopeSessionId) storage.setState(state => ({ sessions: { ...state.sessions,
            [scopeSessionId]: createSessionFixture({ id: scopeSessionId, serverId, metadata: {
                machineId: 'm1', path: '/repo', host: 'test' } }) } }));
        rows = rows.map(row => AutomationDefinitionDetailSchema.parse({ ...row, workflowDefinitionId: null, scopeSessionId,
            executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
                workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: selection.example.definition,
            } } } }));
        home.answer(serverId, '/v1/plugins/data/query', { status: 503, body: { error: 'unavailable' } });
        const { useSessionTriggers } = await import('./useSessionTriggers');
        const hook = await renderHook(() => useSessionTriggers('session-a'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().sets.map(value => value.automationId)).toEqual([set.automationId]);
        expect(hook.getCurrent().sets[0]?.scopeSessionId).toBe(scopeSessionId);
        expect(hook.getCurrent().sets[0]?.destinations?.targetSessionIds).toEqual(['session-a']);
        expect(hook.getCurrent().pullRequestLinks).toMatchObject({ status: 'unavailable' });
        const originalTarget = hook.getCurrent().sets[0]!.target;
        const screen = await renderScreen(<SessionTriggersSection sessionId="session-a" serverId={serverId} />);
        expect(screen.findByTestId('session-work-trigger:set-1:t1-switch')?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('session-work-trigger:set-1:t1');
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-work-trigger-popover-submit')).not.toBeNull());
        expect.soft(screen.findByTestId('session-work-trigger-popover-runs-in') !== null).toBe(scopeSessionId === null);
        const clock = screen.findAll(node => typeof node.props.onCommit === 'function' && node.props.testID === 'session-work-trigger-popover-at')[0];
        expect(clock).toBeDefined();
        await act(async () => { clock!.props.onCommit('10:30'); });
        expect(screen.findByTestId('session-work-trigger-popover-submit')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('session-work-trigger-popover-submit');
        await waitForHomeGovernance(() => expect(rows[0]?.triggers[0]).toMatchObject({ schedule: { scheduleExpr: '30 10 * * *' } }));
        expect(rows[0]?.scopeSessionId).toBe(scopeSessionId);
        expect.soft(hook.getCurrent().sets[0]?.target).toEqual(originalTarget);
        const recipe = rows[0]!.executionRecipe;
        if (recipe?.v !== 2 || recipe.workflow.t !== 'plain') throw new Error('Expected saved plain recipe');
        const savedWorkflow = AutomationStoredWorkflowDefinitionV2Schema.parse(recipe.workflow.v);
        if (!savedWorkflow.inlineDefinition) throw new Error('Expected saved inline definition');
        const { materializeWorkflowAcceptedSnapshotV1 } = await import('@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1');
        const admission = await materializeWorkflowAcceptedSnapshotV1({ definition: savedWorkflow.inlineDefinition,
            context: { source: { kind: 'inline' }, inputs: {}, machineId: 'm1', executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId: 'm1', directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
            admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
        expect(admission).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ selection: {
            conversation: { kind: 'existing_session', sessionId: 'session-a', machineId: 'm1' },
        } }] } });
        if (scopeSessionId === null) {
            await screen.pressByTestIdAsync('session-work-trigger:set-1:t1');
            const whenPicker = screen.findAll(node => node.props.testID === 'session-work-trigger-popover-when'
                && typeof node.props.onSelect === 'function')[0];
            expect(whenPicker).toBeDefined();
            await act(async () => { whenPicker!.props.onSelect('turnEnds'); });
            expect(screen.findByTestId('session-work-trigger-popover-submit')?.props.disabled).toBe(false);
            await screen.pressByTestIdAsync('session-work-trigger-popover-submit');
            const { resolvePortableServerIdentityForRoutingId } = await import('@/sync/domains/server/resolvePortableServerIdentityForRoutingId');
            await waitForHomeGovernance(() => expect(hook.getCurrent().sets[0]?.triggers[0]).toMatchObject({
                kind: 'sessionLifecycle', subject: { kind: 'session',
                    serverId: resolvePortableServerIdentityForRoutingId(serverId), sessionId: 'session-a' },
                events: AUTOMATION_SESSION_LIFECYCLE_EVENT_GROUPS_V1.turnEnds, policy: { kind: 'everyMatch' },
            }));
            expect(rows[0]?.scopeSessionId).toBeNull();
            expect(hook.getCurrent().sets[0]?.target).toEqual(originalTarget);
        }
        await act(async () => { await hook.getCurrent().update({ triggerId: AutomationTriggerIdSchema.parse('t1'),
            expectedRevision: rows[0]!.templateVersion, patch: { enabled: false } }); });
        expect(hook.getCurrent().sets[0]?.triggers[0]?.enabled).toBe(false);
        expect(rows[0]?.scopeSessionId).toBe(scopeSessionId);
        await act(async () => { await hook.getCurrent().remove('t1'); });
        expect(hook.getCurrent().sets).toEqual([]);
        expect(rows[0]?.triggers).toEqual([]);
    });
    it.each(['prComment', 'ciFailed'] as const)('edits saved %s in the shared section using its saved lifetime without an intake context', async kind => {
        const { WorkflowTriggerSection } = await import('./WorkflowTriggerSection');
        const { WorkflowTriggerBlock } = await import('./WorkflowTriggerBlock');
        seed(set);
        rows = rows.map(row => AutomationDefinitionDetailSchema.parse({ ...row, scopeSessionId: 'session-a' }));
        rows = rows.map(row => AutomationDefinitionDetailSchema.parse({ ...row, triggers: [persistedTrigger('t1', {
            kind, enabled: true, pullRequest: { repository: 'acme/widgets', number: 7 },
        }, 1, row.id)] }));
        // Channels owns the remote binding write; retain real requester admission and transport.
        const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
        const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
        const { SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1, SessionPullRequestBindingInputV1Schema,
            SessionPullRequestBindingResultV1Schema } = await import('@happier-dev/channels-protocol/v1');
        const attachments: ReturnType<typeof SessionPullRequestBindingInputV1Schema.parse>[] = [];
        await answerExternalActionAccountForHome(home, serverId, { machineId: projectTarget.machineId, actionId: 'action.invoke', tokenEpoch: 0,
            execute(input) {
                const invocation = getActionSpec('action.invoke').inputSchema.parse(input);
                expect(invocation.action).toEqual({ pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1 });
                const attachment = SessionPullRequestBindingInputV1Schema.parse(invocation.input);
                if (attachment.kind !== 'attach') throw new Error('Expected the saved trigger binding update');
                attachments.push(attachment);
                return SessionPullRequestBindingResultV1Schema.parse({ kind: 'attached', bindingId: 'binding-a' });
            } });
        const hook = await renderHook(() => useWorkflowTriggerEditing({ definitionId, sourceKey: 'saved-pr', projectTarget,
            lifetimeSession: { sessionId: 'session-a' } }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().set?.scopeSessionId).toBe('session-a'));
        const editor = hook.getCurrent();
        const screen = await renderScreen(<WorkflowTriggerSection testIDPrefix="saved-pr" set={editor.set} draft={editor.draft}
            onChangeDraft={editor.setDraft} status={editor.status} onRetry={editor.retry} stepsUnsaved={false}
            whereTarget={projectTarget} whereSummary="/repo" inputs={[]} />);
        const block = screen.findAll(node => node.type === WorkflowTriggerBlock)[0];
        if (!block) throw new Error('Expected the saved PR editor');
        await act(async () => { block.props.onChangeWhen({ kind, pullRequest: { repository: 'acme/widgets', number: 8 } }); });
        await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'); });
        expect(rows[0]).toMatchObject({ scopeSessionId: 'session-a' });
        await waitForHomeGovernance(() => expect(hook.getCurrent().set?.triggers).toMatchObject([{ kind,
            pullRequest: { repository: 'acme/widgets', number: 8 } }]));
        expect(attachments).toMatchObject([{ kind: 'attach', sessionId: 'session-a', pullRequest: { repository: 'acme/widgets', number: 8 },
            target: { automationId: set.automationId, triggerKind: kind } }]);
    });

    it('supplies Session context and Account destinations through one shared physical-Account census', async () => {
        const { useResourceAutomationsSection } = await import('./useResourceAutomationsSection');
        const { resolvePortableServerIdentityForRoutingId } = await import('@/sync/domains/server/resolvePortableServerIdentityForRoutingId');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        seed(set);
        rows = rows.map(row => AutomationDefinitionDetailSchema.parse({ ...row, scopeSessionId: 'session-a' }));
        const example = WORKFLOW_STARTER_EXAMPLES_V1.find(value => value.key === 'daily-summary-in-session')!;
        const selection = materializeWorkflowStarterExample(example, { session: { sessionId: 'session-a', machineId: 'm1' } });
        if (selection.status !== 'ready') throw new Error('Session-bound example required');
        const destination = AutomationDefinitionDetailSchema.parse({ ...rows[0], id: 'account-destination', scopeSessionId: null,
            workflowDefinitionId: null, executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
                workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: selection.example.definition,
            } } } });
        rows = [...rows, destination];
        installRow(destination.id);
        const subject = { kind: 'session', serverId: resolvePortableServerIdentityForRoutingId(serverId)!, sessionId: 'session-a' } as const;
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const retirement = new AbortController();
        const physical = await captureLazyActionAccountContext(serverId, retirement.signal);
        const physicalServerUrl = (await import('@/sync/domains/server/serverProfiles')).getServerProfileById(serverId)?.serverUrl;
        let presented = false;
        try {
            const focusedServerId = await home.addHome({ name: 'Another focused Home', serverUrl: `https://session-focused-${crypto.randomUUID()}.test`,
                accountId: 'another-account' });
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
            storage.setState({ profileScope: { serverId: focusedServerId, accountId: 'another-account' },
                settingsScope: { serverId: focusedServerId, accountId: 'another-account' } });
            const hook = await renderHook(() => useResourceAutomationsSection({ subject, subjectName: 'Review', accountLifetime: physical.accountLifetime }), {
                wrapper: ({ children }) => <PluginSurfaceFocusEligibilityProvider active={presented}>{children}</PluginSurfaceFocusEligibilityProvider>,
            });
            expect(listRequests()).toEqual([]);
            presented = true;
            await hook.rerender();
            await waitForHomeGovernance(() => expect(hook.getCurrent().session?.status).toBe('ready'));
            await waitForHomeGovernance(() => expect(hook.getCurrent().session?.read.status).toBe('ready'));
            expect(hook.getCurrent().session?.read.sets).toMatchObject([{ scopeSessionId: 'session-a' }]);
            expect(hook.getCurrent().session?.sets.map(value => value.automationId).sort())
                .toEqual(['account-destination', set.automationId].sort());
            expect(hook.getCurrent().session?.pullRequestLinks).toMatchObject({ status: 'unavailable' });
            const queries = listRequests();
            expect(queries.map(query => query.serverUrl)).toEqual(queries.map(() => physicalServerUrl));
            expect(queries.map(query => query.input).filter(query => query && typeof query === 'object' && !('subject' in query) && !('scopeSessionId' in query))).toHaveLength(1);
            expect(queries.map(query => query.input).filter(query => query && typeof query === 'object' && 'scopeSessionId' in query)).toHaveLength(1);
            expect(hook.getCurrent().session?.createSentenceIntent()).toMatchObject({
                trigger: { kind: 'sessionLifecycle', subject }, lifetimeSession: { sessionId: subject.sessionId },
                startContext: { session: { subject } },
            });
            await hook.unmount();
            retirement.abort();
            physical.dispose();
            const beforeRetiredMount = home.requests.length;
            await renderHook(() => useResourceAutomationsSection({ subject, accountLifetime: physical.accountLifetime }));
            await flushHookEffects();
            expect(home.requests.slice(beforeRetiredMount).filter(request => request.path === '/v3/automations/query'
                || request.path === '/v1/plugins/data/query')).toEqual([]);
        } finally { physical.dispose(); }
    });
    it('reads Session and Account Habits while the real pull-request observer attachment is pending', async () => {
        // A native client runs this portable Account Action locally; browser placement requires an advertised daemon receiver.
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const credentials = await TokenStorage.getCredentials();
        const profile = getServerProfileById(serverId);
        if (!credentials || !profile?.serverIdentityId) throw new Error('Current Account credentials required');
        const sessions = storage.getState().sessions;
        const connection = await restoreServerAccountForTest({ serverUrl: profile.serverUrl,
            serverIdentityId: profile.serverIdentityId, credentials, request: home.request,
            configureSocket: configureConnectedServerSocketBoundary });
        const attachment = createDeferred<void>();
        let unmount: (() => Promise<void>) | undefined;
        try {
            storage.setState({ sessions });
            await seedChannels();
            await answerChannelsMachineMetadata();
            const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const ready = await executeDefaultActionInCapturedAccount(await captureLazyActionAccountContext(serverId), 'action.invoke', {
                action: { pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' },
                input: { kind: 'get', sessionId: 'session-a' },
            }, { surface: 'ui', defaultSessionId: 'session-a' });
            expect(ready).toMatchObject({ ok: true, result: { kind: 'ready', bindings: [] } });
            const example = WORKFLOW_STARTER_EXAMPLES_V1.find(value => value.key === 'daily-summary-in-session')!;
            const selection = materializeWorkflowStarterExample(example, { session: { sessionId: 'session-a', machineId: 'm1' } });
            if (selection.status !== 'ready') throw new Error('Session-bound example required');
            seed(set);
            const scoped = AutomationDefinitionDetailSchema.parse({ ...rows[0], scopeSessionId: 'session-a' });
            const account = AutomationDefinitionDetailSchema.parse({ ...rows[0], id: 'account-habit', workflowDefinitionId: null,
                executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
                    workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: selection.example.definition,
                } } } });
            rows = [scoped, account];
            installRow(account.id);
            let collectionReads = 0;
            home.answer(serverId, '/v1/plugins/data/query', { select: () => ({ body: { rows: [], changeCursor: 1 },
                // The observer opens first. Ordinary PR metadata reads remain independent.
                ...(collectionReads++ === 0 ? { respondAfter: attachment.promise } : {}),
            }) });
            const { useSessionTriggers } = await import('./useSessionTriggers');
            const hook = await renderHook(() => useSessionTriggers('session-a'));
            unmount = hook.unmount;
            await waitForHomeGovernance(() => expect(collectionReads).toBeGreaterThan(0));
            await vi.waitFor(() => expect(hook.getCurrent().sets.map(value => value.automationId).sort())
                .toEqual(['account-habit', set.automationId].sort()));
            expect(hook.getCurrent().status).toBe('ready');
            const queries = home.requests.filter(request => request.path === '/v3/automations/query')
                .map(request => request.input);
            expect(queries.filter(query => query && typeof query === 'object' && !('scopeSessionId' in query))).toHaveLength(1);
            expect(queries.filter(query => query && typeof query === 'object' && 'scopeSessionId' in query
                && query.scopeSessionId === 'session-a')).toHaveLength(1);
            expect(hook.getCurrent().observationFailure).toBeNull();
            await act(async () => attachment.resolve());
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', pullRequestLinks: [] }));
        } finally {
            await act(async () => attachment.resolve());
            await unmount?.();
            await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
            await connection.dispose();
        }
    });
    it('keeps ordinary Habits usable without a section-level band when the real pull-request read is unavailable', async () => {
        seed(set);
        home.answer(serverId, '/v1/plugins/data/query', { status: 503, body: { error: 'unavailable' } });
        const { useSessionTriggers } = await import('./useSessionTriggers');
        const hook = await renderHook(() => useSessionTriggers('session-a'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().pullRequestLinks).toMatchObject({ status: 'unavailable' }));
        // This saved Workflow is an Account set; bind it here through its actual scope.
        rows = rows.map(row => AutomationDefinitionDetailSchema.parse({ ...row, scopeSessionId: 'session-a' }));
        await act(async () => hook.getCurrent().retry());
        const screen = await renderScreen(<SessionTriggersSection sessionId="session-a" serverId={serverId} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-work-trigger:set-1:t1')).not.toBeNull());
        expect(screen.findHostByTestId('session-work-trigger-links-unavailable')).toBeNull();
        expect(screen.findByTestId('session-work-trigger:set-1:t1-switch')?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('session-work-trigger:set-1:t1');
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-work-trigger-popover-submit')?.props.disabled).toBe(false));
    });
    it('keeps a Session trigger receipt when its pre-Save reads finish after the replacement read', async () => {
        const { useSessionTriggers } = await import('./useSessionTriggers');
        const hook = await renderHook(() => useSessionTriggers('session-a'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const releaseReads = createDeferred<void>();
        let pendingReads = 0;
        listReply = async () => {
            const page = listRows();
            if (pendingReads < 2) { pendingReads += 1; await releaseReads.promise; }
            return page;
        };
        await act(async () => hook.getCurrent().retry());
        await waitForHomeGovernance(() => expect(pendingReads).toBe(2));
        await act(async () => { await hook.getCurrent().add({ target: { kind: 'inline',
            definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
                document: { text: 'Continue', references: [], attachments: [] } }] }) },
            executionTarget: { kind: 'session' }, trigger }); });
        expect(hook.getCurrent().sets).toMatchObject([{ scopeSessionId: 'session-a', triggers: [{ kind: 'schedule' }] }]);
        const acknowledged = hook.getCurrent().sets;
        await act(async () => { releaseReads.resolve(); await releaseReads.promise; });
        expect(hook.getCurrent().sets).toBe(acknowledged);
        expect(hook.getCurrent().status).toBe('ready');
    });
    it('renews a pending Session-trigger read after same-Account retirement', async () => {
        // A native client runs this portable Account Action locally; browser placement requires an advertised daemon receiver.
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        // Reinstall the release for the native executable platform selected by this case.
        await seedChannels();
        const { useSessionTriggers } = await import('./useSessionTriggers');
        const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const credentials = await TokenStorage.getCredentials();
        const profile = getServerProfileById(serverId);
        if (!credentials || !profile?.serverIdentityId) throw new Error('The fixture Home must have current Account credentials');
        const readLinks = async () => executeDefaultActionInCapturedAccount(await captureLazyActionAccountContext(serverId), 'action.invoke', {
            action: { pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' },
            input: { kind: 'get', sessionId: 'session-a' },
        }, { surface: 'ui', defaultSessionId: 'session-a' });
        // A plugin release alone cannot read through an unrestored Account runtime.
        const unrestoredLinks = await readLinks();
        expect(unrestoredLinks, JSON.stringify(unrestoredLinks)).toMatchObject({ ok: false, errorCode: 'plugin_settings_scope_unavailable' });
        const sessions = storage.getState().sessions;
        // Channels reads Account settings through the real connected Sync owner.
        // Saved credentials alone are not a restored Account runtime.
        const connection = await restoreServerAccountForTest({ serverUrl: profile.serverUrl,
            serverIdentityId: profile.serverIdentityId, credentials, request: home.request,
            configureSocket: configureConnectedServerSocketBoundary });
        storage.setState({ sessions });
        await seedChannels();
        await answerChannelsMachineMetadata();
        const retired = createDeferred<void>();
        try {
            const beforeLinks = await readLinks();
            expect(beforeLinks, JSON.stringify(beforeLinks)).toMatchObject({ ok: true, result: { kind: 'ready', bindings: [] } });
            let first = true;
            listReply = async () => { if (first) { first = false; await retired.promise; } return listRows(); };
            const hook = await renderHook(() => useSessionTriggers('session-a'));
            expect(hook.getCurrent().status).toBe('loading');
            await waitForHomeGovernance(() => expect(first).toBe(false));
            await act(async () => { (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime(); await seedChannels(); });
            const links = await readLinks();
            expect(links, JSON.stringify(links)).toMatchObject({ ok: true, result: { kind: 'ready', sessionId: 'session-a', bindings: [] } });
            await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
            expect(hook.getCurrent().pullRequestLinks).toEqual([]);
            listReply = async () => { throw new Error('Replacement collection unavailable'); };
            await act(async () => (await import('@/sync/api/plugins/data/pluginCollectionChangeWatch')).resetActivePluginCollectionChanges());
            await waitForHomeGovernance(() => expect(hook.getCurrent().pullRequestLinks)
                .toEqual({ status: 'unavailable', code: 'target_unavailable' }));
            expect(hook.getCurrent().status).toBe('ready');
        } finally {
            retired.resolve();
            await standardCleanup();
            await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
            await connection.dispose();
        }
    });

    it('renews a mounted Workflow-trigger collection after same-Account retirement', async () => {
        seed(set);
        const hook = await renderHook(() => useWorkflowTriggerSets({ workflow: definitionId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const loaded = hook.getCurrent().sets;
        expect(loaded).toMatchObject([set]);
        await act(async () => (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime());
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().sets).toEqual(loaded);
    });

    it('loads a new Account’s session triggers without claiming the previous Account’s settled status', async () => {
        const { useSessionTriggers } = await import('./useSessionTriggers');
        const hook = await renderHook(() => useSessionTriggers('session-a'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const next = createDeferred<void>();
        listReply = async () => { await next.promise; return listRows(); };
        await act(async () => { await home.switchAccount(serverId, 'account-b'); storage.setState({ profileScope: { serverId, accountId: 'account-b' } }); await seedChannels(); });
        expect(hook.getCurrent().status).toBe('loading');
        expect(hook.getCurrent().pullRequestLinks).toEqual({ status: 'loading' });
        await act(async () => { next.resolve(); await next.promise; });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
    });
    it('does not reread an unchanged semantic query when its request object is replaced', async () => {
        const hook = await renderHook(useWorkflowTriggerSets, { initialProps: { workflow: definitionId } });
        expect(hook.getCurrent().status).toBe('ready');
        await hook.rerender({ workflow: definitionId });
        expect(listRequests()).toHaveLength(1);
        const otherId = '00000000-0000-4000-8000-000000000002';
        await hook.rerender({ workflow: otherId });
        expect(listRequests().map(request => AutomationDefinitionDetailsRequestSchema.parse(request.input).workflowDefinitionId))
            .toEqual([definitionId, otherId]);
    });
    it('restores semantic history across addition acknowledgement without duplicating a saved trigger', async () => {
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'history', projectTarget } });
        const before = hook.getCurrent().captureSnapshot();
        const next = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'c1', trigger });
        const after = hook.getCurrent().captureSnapshot(next);
        await act(async () => hook.getCurrent().setDraft(next));
        await act(async () => { await hook.getCurrent().save(definitionId, () => true); });
        expect(hook.getCurrent().dirty).toBe(false);
        await act(async () => { await hook.getCurrent().restoreSnapshot(before); });
        expect(hook.getCurrent().draft.removes).toEqual([rows[0]!.triggers[0]!.id]);
        await act(async () => { await hook.getCurrent().restoreSnapshot(after); });
        expect(hook.getCurrent().dirty).toBe(false);
        expect(hook.getCurrent().draft.adds).toEqual([]);
    });

    it('can Undo the first trigger Save before the created definition id reaches the hook props', async () => {
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId: null, sourceKey: 'new-history', projectTarget } });
        const before = hook.getCurrent().captureSnapshot();
        await act(async () => { await hook.getCurrent().restoreSnapshot(before); });
        expect(hook.getCurrent().dirty).toBe(false);
        const next = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'c1', trigger });
        const after = hook.getCurrent().captureSnapshot(next);
        await act(async () => hook.getCurrent().setDraft(next));
        await act(async () => { await hook.getCurrent().save(definitionId, () => true); });
        await act(async () => { await hook.getCurrent().restoreSnapshot(before); });
        expect(hook.getCurrent().draft.removes).toEqual([rows[0]!.triggers[0]!.id]);
        await act(async () => { await hook.getCurrent().restoreSnapshot(after); });
        expect(hook.getCurrent().dirty).toBe(false);
    });

    it('refuses Undo of a private Event whose removal is already being saved without consuming the current draft', async () => {
        const first = set.triggers[0]!;
        if (first.kind !== 'schedule') throw new Error('schedule fixture required');
        const { schedule: _schedule, nextRunAt: _nextRunAt, ...base } = first;
        const eventSet = WorkflowTriggerSetV1Schema.parse({ ...set, triggers: [{ ...base, kind: 'pluginEvent',
            eventRef: { pluginId: 'plugin', localId: 'event' }, sourceSelectorId: 'source', sourceContractVersion: 1,
            observation: { kind: 'socket', watcher: null }, sourceStatus: null, sourceCatalogStatus: null, triggerDefinitionEnvelope: 'sealed-private' }] });
        seed(eventSet);
        const deferred = createDeferred<void>();
        beforeWrite = () => deferred.promise;
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'private-history', projectTarget } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().set).toMatchObject({ automationId: eventSet.automationId }));
        const before = hook.getCurrent().captureSnapshot();
        let saving: ReturnType<ReturnType<typeof hook.getCurrent>['save']> | undefined;
        try {
            await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'remove', triggerId: eventSet.triggers[0]!.id })));
            await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
            await waitForHomeGovernance(() => expect(writes).toHaveLength(1));
            expect(() => hook.getCurrent().restoreSnapshot(before)).toThrowError(expect.objectContaining({ code: 'workflow_trigger_restore_requires_setup' }));
            expect(hook.getCurrent().draft.removes).toEqual(['t1']);
            await act(async () => { deferred.resolve(); await saving; });
            expect(hook.getCurrent().dirty).toBe(false);
        } finally {
            await act(async () => { deferred.resolve(); await Promise.allSettled(saving ? [saving] : []); });
        }
    });

    it('keeps an Undo made while a removal is being saved after its acknowledgement', async () => {
        seed(set);
        const deferred = createDeferred<void>();
        beforeWrite = () => deferred.promise;
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'history', projectTarget } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().set).toMatchObject({ automationId: set.automationId }));
        const before = hook.getCurrent().captureSnapshot();
        let saving: ReturnType<ReturnType<typeof hook.getCurrent>['save']> | undefined;
        try {
            await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'remove', triggerId: set.triggers[0]!.id })));
            await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
            await waitForHomeGovernance(() => expect(writes).toHaveLength(1));
            await act(async () => { await hook.getCurrent().restoreSnapshot(before); });
            await act(async () => { deferred.resolve(); await saving; });
            expect(hook.getCurrent().draft.adds).toEqual([{ clientId: 'saved:t1', trigger }]);
            expect(hook.getCurrent().dirty).toBe(true);
        } finally {
            await act(async () => { deferred.resolve(); await Promise.allSettled(saving ? [saving] : []); });
        }
    });

    it('restores deleted schedules and set context after Save, and reuses the replacement identity on redo', async () => {
        home.answer(serverId, '/v1/machines/m2', {
            body: { machine: createPlainMachineRowFixture({ id: 'm2', accountId: 'account-a' }) },
        });
        const original = WorkflowTriggerSetV1Schema.parse({ ...set, context: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inputs: { name: 'old' } } });
        seed(original);
        const removedProject = { machineId: 'm2', directory: '/other' };
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'history', projectTarget } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().set).toMatchObject({ automationId: original.automationId, context: original.context }));
        const before = hook.getCurrent().captureSnapshot();
        let next = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'remove', triggerId: set.triggers[0]!.id });
        next = editWorkflowTriggerDraft(next, { kind: 'setContext', context: { project: removedProject, inputs: { name: 'new' } } });
        const after = hook.getCurrent().captureSnapshot(next);
        await act(async () => hook.getCurrent().setDraft(next));
        await act(async () => { await hook.getCurrent().save(definitionId, () => true); });
        await act(async () => { await hook.getCurrent().restoreSnapshot(before); });
        expect(hook.getCurrent().draft.adds).toEqual([{ clientId: 'saved:t1', trigger }]);
        expect(hook.getCurrent().draft.context).toEqual({ project: projectTarget, inputs: { name: 'old' } });
        await act(async () => { await hook.getCurrent().save(definitionId, () => true); });
        const replacementId = rows[0]!.triggers[0]!.id;
        expect(replacementId).not.toBe('t1');
        await act(async () => { await hook.getCurrent().restoreSnapshot(after); });
        expect(hook.getCurrent().draft.removes).toEqual([replacementId]);
        expect(hook.getCurrent().draft.adds).toEqual([]);
    });

    it('resets pending edits across source, Account and server changes, including unsaved sources', async () => {
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId: null, sourceKey: 'new-a', projectTarget } });
        const add = async () => act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'c1', trigger })));
        await add();
        expect(hook.getCurrent().dirty).toBe(true);
        await hook.rerender({ definitionId: null, sourceKey: 'new-b', projectTarget });
        expect(hook.getCurrent().dirty).toBe(false);
        await add();
        await act(async () => { await home.switchAccount(serverId, 'account-b'); storage.setState({ profileScope: { serverId, accountId: 'account-b' } }); });
        expect(hook.getCurrent().dirty).toBe(false);
        await add();
        await act(async () => {
            const other = await home.addHome({ name: 'Other', serverUrl: 'https://trigger-other.test', accountId: 'account-b' });
            storage.setState({ profileScope: { serverId: other, accountId: 'account-b' } });
        });
        expect(hook.getCurrent().dirty).toBe(false);
    });

    it('subtracts acknowledged additions while keeping edits made during Save', async () => {
        const deferred = createDeferred<void>();
        beforeWrite = () => deferred.promise;
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'captured', trigger })));
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'later', trigger })));
        await act(async () => { deferred.resolve(); await saving; });
        expect(hook.getCurrent().draft.adds.map((add) => add.clientId)).toEqual(['later']);
    });

    it.each(['change', 'discard'] as const)('keeps a %s made to an addition while Save is pending on its new saved identity', async (edit) => {
        const deferred = createDeferred<void>();
        beforeWrite = () => deferred.promise;
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'c1', trigger })));
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        const changed = { ...trigger, enabled: false, schedule: { ...trigger.schedule, scheduleExpr: '0 8 * * *' } };
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
            edit === 'change' ? { kind: 'add', clientId: 'c1', trigger: changed } : { kind: 'discardAdd', clientId: 'c1' })));
        await act(async () => { deferred.resolve(); await saving; });
        expect(hook.getCurrent().draft.adds).toEqual([]);
        const savedId = rows[0]!.triggers[0]!.id;
        if (edit === 'change') expect(hook.getCurrent().draft.updates).toEqual({ [savedId]: { trigger: { kind: 'schedule', schedule: changed.schedule }, enabled: false } });
        else expect(hook.getCurrent().draft.removes).toEqual([savedId]);
    });

    it('keeps later trigger and context values while acknowledging the captured update batch', async () => {
        home.answer(serverId, '/v1/machines/m2', {
            body: { machine: createPlainMachineRowFixture({ id: 'm2', accountId: 'account-a' }) },
        });
        const original = WorkflowTriggerSetV1Schema.parse({ ...set, context: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inputs: { name: 'old' } } });
        const capturedTrigger = { kind: 'schedule', schedule: { ...trigger.schedule, scheduleExpr: '0 7 * * *' } } as const;
        seed(original);
        const deferred = createDeferred<void>();
        beforeWrite = () => deferred.promise;
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        await act(async () => {
            let draft = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'update', triggerId: original.triggers[0]!.id, trigger: capturedTrigger, enabled: false });
            draft = editWorkflowTriggerDraft(draft, { kind: 'setContext', context: { project: { machineId: 'm2', directory: '/captured' }, inputs: { name: 'captured' } } });
            hook.getCurrent().setDraft(draft);
        });
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        const changedTrigger = { kind: 'schedule', schedule: { ...trigger.schedule, scheduleExpr: '0 8 * * *' } } as const;
        const changedContext = { project: { machineId: 'm3', directory: '/later' }, inputs: { name: 'later' } };
        await act(async () => {
            let draft = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'update', triggerId: original.triggers[0]!.id, trigger: changedTrigger, enabled: true });
            draft = editWorkflowTriggerDraft(draft, { kind: 'setContext', context: changedContext });
            hook.getCurrent().setDraft(draft);
        });
        await act(async () => { deferred.resolve(); await saving; });
        expect(hook.getCurrent().draft.updates).toEqual({ t1: { trigger: changedTrigger, enabled: true } });
        expect(hook.getCurrent().draft.context).toEqual(changedContext);
    });

    it('stops the captured batch after navigation even when the caller fence stays true', async () => {
        const deferred = createDeferred<void>();
        beforeWrite = () => deferred.promise;
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        await act(async () => {
            let draft = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'first', trigger });
            draft = editWorkflowTriggerDraft(draft, { kind: 'add', clientId: 'second', trigger });
            hook.getCurrent().setDraft(draft);
        });
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        await waitForHomeGovernance(() => expect(writes).toHaveLength(1));
        await hook.rerender({ definitionId, sourceKey: 'saved-b', projectTarget });
        let outcome: string | undefined;
        await act(async () => { deferred.resolve(); outcome = await saving; });
        expect(outcome).toBe('stale');
        expect(writes).toHaveLength(1);
        expect(hook.getCurrent().dirty).toBe(false);
    });

    it('keeps the unsaved source draft when its first definition is saved', async () => {
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId: null as string | null, sourceKey: 'new-a', projectTarget } });
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'first', trigger })));
        await hook.rerender({ definitionId, sourceKey: 'new-a', projectTarget });
        expect(hook.getCurrent().draft.adds.map((add) => add.clientId)).toEqual(['first']);
    });

    it('reports a settled Account read failure while its Home reconnects and recovers through the original query', async () => {
        storage.setState({ endpointStatus: 'connecting', socketStatus: 'connecting' });
        listReply = async () => { listReply = undefined; throw new Error('offline'); };
        const query = { scope: 'account_inline' } as const;
        const hook = await renderHook(() => useWorkflowTriggerSets(query));
        expect(hook.getCurrent().status).toBe('failed');
        expect(hook.getCurrent().sets).toEqual([]);
        await act(async () => hook.getCurrent().retry());
        expect(hook.getCurrent().status).toBe('ready');
        expect(listRequests().map(request => AutomationDefinitionDetailsRequestSchema.parse(request.input).scope)).toEqual(['account_inline', 'account_inline']);
    });

    it('settles Habits from a Session list row without demanding Session detail hydration', async () => {
        seed(set);
        rows = rows.map(row => AutomationDefinitionDetailSchema.parse({ ...row, scopeSessionId: 'session-a' }));
        storage.setState({ sessions: {}, sessionListRowsByServerId: { [serverId]: {
            'session-a': createSessionListRenderableSessionFixture({ id: 'session-a',
                metadata: { machineId: 'm1', path: '/repo', host: 'test' } }),
        } } });
        const held = createDeferred<void>();
        listReply = async () => { await held.promise; return listRows(); };
        const hook = await renderHook(() => useSessionTriggers('session-a'));
        try {
            expect(hook.getCurrent().status).toBe('loading');
            await waitForHomeGovernance(() => expect(listRequests()).toHaveLength(2));
            await act(async () => { held.resolve(); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
            expect(hook.getCurrent().sets).toMatchObject([{ automationId: set.automationId }]);
            expect(storage.getState().sessions['session-a']).toBeUndefined();
            expect(listRequests()).toHaveLength(2);
        } finally {
            held.resolve();
            await hook.unmount();
        }
    });

    it('does not restart a pending Account census when identical Session refreshes publish fresh rows', async () => {
        // This Account Workflow has no accepted destination in session-a. Its
        // held detail is still needed to establish complete Account coverage.
        seed(set);
        const detail = createDeferred<void>();
        const started = createDeferred<AbortSignal | null>();
        home.answer(serverId, 'POST /v3/automations/query', { select: async (input, request) => {
            if (input && typeof input === 'object' && !('scopeSessionId' in input)) {
                started.resolve(request.signal ?? null);
                await detail.promise;
            }
            return { body: selectWorkflowAutomationDetailsFixture(rows, input) };
        } });
        const { useSessionTriggers } = await import('./useSessionTriggers');
        const hook = await renderHook(() => useSessionTriggers('session-a'));
        try {
            const physicalSignal = await started.promise;
            expect(hook.getCurrent()).toMatchObject({ status: 'loading', sets: [] });
            const session = storage.getState().sessions['session-a'];
            if (!session) throw new Error('Expected the mounted Session fixture');
            for (let refresh = 0; refresh < 3; refresh += 1) {
                await act(async () => { storage.getState().applySessions([{ ...session }]); });
                expect(hook.getCurrent()).toMatchObject({ status: 'loading', sets: [] });
                expect(physicalSignal?.aborted).toBe(false);
            }
            await flushHookEffects();
            const queries = () => home.requests.filter(request => request.path === '/v3/automations/query')
                .map(request => request.input);
            expect(queries().filter(query => query && typeof query === 'object' && !('scopeSessionId' in query))).toHaveLength(1);
            expect(queries().filter(query => query && typeof query === 'object' && 'scopeSessionId' in query
                && query.scopeSessionId === 'session-a')).toHaveLength(1);
            expect(physicalSignal?.aborted).toBe(false);
            await act(async () => { detail.resolve(); });
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', sets: [] }));
            expect(storage.getState().workflowTriggerSetIdsByQuery.account_all).toEqual([set.automationId]);
            expect(queries().filter(query => query && typeof query === 'object' && !('scopeSessionId' in query))).toHaveLength(1);
        } finally {
            await act(async () => { detail.resolve(); });
            await hook.unmount();
        }
    });

    it('shows a failed Account census in Session Habits while the Session query is pending, then retries into its targeted Account row', async () => {
        const example = WORKFLOW_STARTER_EXAMPLES_V1.find(value => value.key === 'daily-summary-in-session')!;
        const selection = materializeWorkflowStarterExample(example, { session: { sessionId: 'session-a', machineId: 'm1' } });
        if (selection.status !== 'ready') throw new Error('Session-bound example required');
        seed(set);
        rows = rows.map(row => AutomationDefinitionDetailSchema.parse({ ...row, workflowDefinitionId: null,
            executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
                workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: selection.example.definition,
            } } } }));
        const sessionRead = createDeferred<void>();
        let failAccountRead = true;
        home.answer(serverId, 'POST /v3/automations/query', { select: async input => {
            if (input && typeof input === 'object' && 'scopeSessionId' in input) {
                await sessionRead.promise;
                return { body: selectWorkflowAutomationDetailsFixture([], input) };
            }
            return failAccountRead ? { status: 503, body: { error: 'storage_unavailable' } }
                : { body: selectWorkflowAutomationDetailsFixture(rows, input) };
        } });
        // Once the census recovers, this composed section demands the row's public Run status.
        home.answer(serverId, '/v3/automations/runs/workflow-storage', { body: WorkflowRunAutomationSummariesResultV1Schema.parse({
            automationSummaries: [{ automationId: set.automationId, lastRun: null }], remainingAutomationIds: [],
        }) });
        storage.setState({ endpointStatus: 'connecting', socketStatus: 'connecting' });
        const screen = await renderScreen(<SessionTriggersSection sessionId="session-a" serverId={serverId} />);
        try {
            await flushHookEffects();
            expect(screen.findByTestId('session-work-triggers-failed')).not.toBeNull();
            expect(screen.findByTestId('session-work-triggers-loading')).toBeNull();
            expect(screen.findByTestId('session-work-triggers-empty')).toBeNull();
            failAccountRead = false;
            const retry = screen.findAll(node => node.props.testID === 'session-work-triggers-failed'
                && typeof node.props.action?.onPress === 'function')[0];
            expect(retry).toBeDefined();
            await act(async () => { retry!.props.action.onPress(); sessionRead.resolve(); });
            await waitForHomeGovernance(() => expect(screen.findByTestId('session-work-trigger:set-1:t1')).not.toBeNull());
            await waitForHomeGovernance(() => expect(screen.findByTestId('session-work-triggers-failed') === null).toBe(true));
            expect(storage.getState().workflowTriggerSetIdsByQuery).toMatchObject({ account_all: ['set-1'], 'session:session-a': [] });
        } finally { await act(async () => sessionRead.resolve()); }
    });

    /** A refresh shows the last-known answer: a workflow with no triggers keeps reading Manual, not Loading. */
    it('stays ready while a settled read refreshes', async () => {
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'refresh', projectTarget } });
        expect(hook.getCurrent().status).toBe('ready');
        const manual = hook.getCurrent().summary;
        const refresh = createDeferred<void>();
        listReply = async () => { await refresh.promise; return listRows(); };
        await act(async () => hook.getCurrent().retry());
        expect(hook.getCurrent().status).toBe('ready');
        expect(hook.getCurrent().summary).toBe(manual);
        await act(async () => { refresh.resolve(); await refresh.promise; });
        expect(hook.getCurrent().status).toBe('ready');
    });

    it('reports failed reads, keeps known rows and retries the same owner', async () => {
        storage.setState({ endpointStatus: 'offline' });
        seed(set);
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().set?.automationId).toBe('set-1'));
        listReply = async () => { throw new Error('offline'); };
        await act(async () => hook.getCurrent().retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('failed'));
        expect(hook.getCurrent().set?.automationId).toBe('set-1');
        listReply = undefined;
        await act(async () => hook.getCurrent().retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
    });
});
