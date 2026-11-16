import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/types';
import { createWorkflowAccountRunActionOwner } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';


import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { bindPresentUserActionConfirmation } from '@/sync/ops/actions/presentUserConfirmation';
import { createDeferred, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { createManagedMachineSelectionDraft, type ManagedMachineAcquisitionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedMachineCreationProgress } from '@/components/settings/machines/managed/managedMachineCreation';
import type { ManagedAcquireAgentStartV1 } from '@happier-dev/protocol/machines/managed/agentStartV1';
import type { MachineReferenceCensusV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { readMachineReferenceCensusV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { loadProfileCatalogV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { MachinePoolViewV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { isManagedPresetAcquireInputV1, ManagedAcquireInputV1Schema, MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineSetupV1Schema } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { AutomationTriggerDetailSchema } from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import type { AutomationDefinitionDetail } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { createWorkflowTriggerActions } from '@happier-dev/protocol/actions/executor/workflowTriggerActions';
import type { AcceptedManagedWorkflowCreation } from './newManagedWorkflowCreation';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { WorkflowRunStartRequestV1Schema, WorkflowRunStartResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { ManagedMachineActionInputSchemasV1, ManagedMachineBirthResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { SessionManagedCreationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createDelegatedManagedPresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

const homes = createHomeGovernanceHarness();
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { buildManagedMachineAcquireInput, runManagedMachineCreation } = await import('@/components/settings/machines/managed/managedMachineCreation');
const { bindNewManagedMachineCreationScope, readManagedCreationScopeBirthSource, readManagedCreationScopeRule } =
    await import('@/sync/ops/actions/managedCreationScopeBinding');
const { runNewManagedWorkflowCreation } = await import('./newManagedWorkflowCreation');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { createPlainSessionCurrentProjectionRecordFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } =
    await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { WorkflowTriggerListResultV1Schema } = await import('@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1');
const { createManagedMachineInstallationRespond } = await import('@/sync/ops/actions/managedMachineInstallationAction');
await loadSyncSingletonForTests();

const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} };
const controller = { machineId: 'controller', installationId: 'installation' };
const draft = createManagedMachineSelectionDraft({
    enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
    selection: { kind: 'one-off', homeId: 'home', launch, controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
    receipt: { launch, controller, optionStatus: 'current', prerequisites: [],
        billing: { location: 'local', stoppedBilling: 'not-billed' }, retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
});
const initial: ManagedMachineAcquisitionDraft = { requestId: 'send-1', selection: draft.selection };
const exactPresetContentOverride = { content: { t: 'plain' as const, v: { exactPresetRevision: true } } };
const baseMachine: ManagedMachineFullV1 = { id: 'paid', homeId: 'home', custodianAccountId: 'account', launch, controller,
    allocation: 'bound', resource: { contributionRef: launch.provider, schemaVersion: 1, value: { nativeId: 'same-native-id' } },
    creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };

function opaqueTeamPreset(id: string, homeId: string, revision: number, name: string) {
    return createDelegatedManagedPresetFixture({ preset: {
        id, homeId, revision, name, owner: { kind: 'team', teamId: 'team' }, launch, controller,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    }, custodianAccountId: 'company', installationPublicKey: 'BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY', descriptor: {
        id: 'native', title: 'Compute', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
        launchSchema: { type: 'object', properties: {}, additionalProperties: false },
        resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
        billing: draft.receipt.billing, retention: draft.receipt.retentionCapabilities,
        actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
    } });
}

it('uses the strict acquire schema as the single identity admission in the creation builder', () => {
    const complete = buildManagedMachineAcquireInput(draft);
    if (!complete) throw new Error('Expected reviewed one-off acquire input');
    if (isManagedPresetAcquireInputV1(complete)) throw new Error('Expected the one-off acquire input');
    expect(complete).toMatchObject({ enrollmentIdentity: draft.enrollmentIdentity });
    const { enrollmentIdentity: _identity, ...incomplete } = complete;
    const admitted = ManagedAcquireInputV1Schema.safeParse(incomplete);
    if (admitted.success) throw new Error('Acquire identity must remain schema-required');
    expect(buildManagedMachineAcquireInput({ ...draft, enrollmentIdentity: undefined })).toBeNull();
});

it('binds preset acquisition to its selected opaque override without sending its enrollment identity', () => {
    const selection = { kind: 'preset' as const, homeId: 'home', id: 'selected-preset', revision: 4 };
    const presetContentOverride = { content: { t: 'plain' as const, v: { selectedRevision: 4 } } };
    const selected = createManagedMachineSelectionDraft({ ...draft, selection, presetContentOverride });

    const input = buildManagedMachineAcquireInput(selected);

    expect(input).toMatchObject({ selection, presetContentOverride });
    expect(input).not.toHaveProperty('enrollmentIdentity');
    expect(buildManagedMachineAcquireInput({ ...selected, presetContentOverride: undefined })).toBeNull();
});

it('builds a deferred author preset acquire from its exact opaque override and structural origin only', () => {
    const selection = { kind: 'preset' as const, homeId: 'home', id: 'author-preset', revision: 6 };
    const presetContentOverride = { content: { t: 'plain' as const, v: { authorPreset: true } } };
    const presetOrigin = { id: selection.id, homeId: selection.homeId, revision: selection.revision,
        controllerPoolId: '4d783830-8626-4da8-8fde-a6da516025e1', retention: { kind: 'until-delete' as const },
        wakeOnAcceptedMessage: false };

    const selected = createManagedMachineSelectionDraft({ deferredAuthorPreset: true, selection, presetContentOverride, presetOrigin });

    expect(selected).not.toHaveProperty('receipt');
    expect(buildManagedMachineAcquireInput(selected)).toEqual({ selection, retention: presetOrigin.retention,
        wakeOnAcceptedMessage: false, presetContentOverride });
    expect(buildManagedMachineAcquireInput(selected)).not.toHaveProperty('reviewedFacts');
    expect(buildManagedMachineAcquireInput(selected)).not.toHaveProperty('enrollmentIdentity');
});

it('carries an omitted sealed preset policy to admission without choosing client defaults', () => {
    const selection = { kind: 'preset' as const, homeId: 'home', id: 'inherited-policy', revision: 1 };
    const selected = createManagedMachineSelectionDraft({ deferredAuthorPreset: true, selection,
        presetContentOverride: exactPresetContentOverride,
        presetOrigin: { id: selection.id, homeId: selection.homeId, revision: selection.revision, controller } });
    const input = buildManagedMachineAcquireInput(selected);
    expect(input).not.toBeNull();
    expect(input).not.toHaveProperty('retention');
    expect(input).not.toHaveProperty('wakeOnAcceptedMessage');
});

function bindingTransport(options: Readonly<{ beforeWrite?: () => Promise<void>; custodianAccountId?: string; homeId?: string; unrelatedRuns?: number; retainedEffect?: 'stop' | 'delete' }> = {}) {
    const rows = new Map<string, AutomationDefinitionDetail>();
    const births = new Map<string, string>(Array.from({ length: options.unrelatedRuns ?? 0 }, (_, index) =>
        [`unrelated-home:unrelated-managed-${index}`, `unrelated-run-${index}`] as const));
    let finCreates = 0;
    const confirmations: string[] = [];
    let machine: ManagedMachineFullV1 = { ...baseMachine, homeId: options.homeId ?? baseMachine.homeId,
        custodianAccountId: options.custodianAccountId ?? baseMachine.custodianAccountId,
        enrolledMachineId: 'guest', reviewedFacts: draft.receipt,
        ...(options.retainedEffect ? { creationScopeRetention: { effect: options.retainedEffect, source: { kind: 'session', sessionId: 'created-session' } } } : {}) };
    const runs = createWorkflowAccountRunActionOwner({
        resolveAccountId: async () => 'account',
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        definitions: { get: async () => { throw new Error('Inline task has no saved definition'); } },
        // Account persistence and native workspace preparation are external boundaries.
        storage: { execute: async operation => {
            if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
            if (operation.operation === 'admit') {
                if (typeof operation.runId !== 'string') throw new Error('Run admission requires a run id');
                if (operation.managedCreation) {
                    const birth = SessionManagedCreationV1Schema.parse(operation.managedCreation);
                    births.set(`${birth.homeId}:${birth.managedId}`, operation.runId);
                }
                return { kind: 'created', run: createWorkflowRunSummaryFixture({
                    id: operation.runId, ownerAccountId: 'account', machineId: 'guest', state: 'queued', origin: { kind: 'direct' },
                }) };
            }
            throw new Error(`Unexpected Run storage operation: ${operation.operation}`);
        } },
        normalizeAbsolutePath: resolveAbsolutePath,
        randomBytes: () => { throw new Error('Plain Account has no encryption keys'); },
        prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
            machineId: 'guest', directory: '/work', checkoutRootPath: '/work',
        } } }),
        resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    let identity = 0;
    const triggers = createWorkflowTriggerActions({
        newId: kind => `${kind}-${++identity}`,
        resolveSession: async () => ({ project: { machineId: 'guest', directory: '/work' }, nativeGoalOwner: false }),
        resolveRunSource: async () => ({ terminal: false }),
        resolveWorkflow: async () => { throw new Error('unexpected_workflow_read'); },
        resolveManagedMachine: async () => machine,
        openContext: async row => row.executionRecipe?.v === 2 && row.executionRecipe.workflow.t === 'plain' ? row.executionRecipe.workflow.v : null,
        sealContext: async ({ context, templateVersion }) => AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({
            v: 2, templateVersion, workflow: { t: 'plain', v: context }, triggerEvidence: null,
        }),
        // These operations are the Account's persistent Automation transport.
        automations: {
            list: async () => ({ automations: [...rows.values()], nextCursor: null }),
            listDetails: async () => ({ automations: [...rows.values()], nextCursor: null }),
            get: async id => rows.get(id) ?? null,
            create: async input => {
                await options.beforeWrite?.();
                finCreates++;
                const row: AutomationDefinitionDetail = { id: input.automationId, name: input.name, description: input.description ?? null,
                    enabled: input.enabled, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
                    workflowDefinitionId: input.workflowDefinitionId ?? null, scopeSessionId: input.scopeSessionId ?? null,
                    assignments: (input.assignments ?? []).map(value => ({ machineId: value.machineId, enabled: value.enabled ?? true, priority: 0, updatedAt: 1 })),
                    triggers: input.triggers.map(value => AutomationTriggerDetailSchema.parse({ ...value.trigger, id: value.triggerId,
                        revision: 0, createdAt: 1, updatedAt: 1, remainingOccurrences: 1,
                        status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: null })), executionRecipe: input.executionRecipe };
                rows.set(row.id, row);
                return row;
            },
            reconcile: async (id, input) => {
                const row = rows.get(id)!;
                const retained = row.triggers.filter(value => !input.removedTriggers.some(item => item.triggerId === value.id));
                const updated = { ...row, enabled: input.enabled, triggers: retained,
                    assignments: input.assignments.map(value => ({ machineId: value.machineId, enabled: value.enabled ?? true, priority: 0, updatedAt: 1 })),
                    ...(input.executionRecipe ? { executionRecipe: input.executionRecipe, templateVersion: row.templateVersion + 1 } : {}) };
                rows.set(id, updated);
                return updated;
            },
            delete: async id => { rows.delete(id); return { ok: true }; },
        },
    });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        // The host modal is external; canonical Action admission and confirmation policy stay real.
        presentUserActionConfirmation: async ({ actionId }) => {
            confirmations.push(actionId);
            return true;
        },
        managedMachineAction: async request => {
            if (request.actionId === 'machines.managed.get') return machine;
            if (request.actionId === 'machines.managed.retention.update') {
                await options.beforeWrite?.();
                const policy = ManagedMachineActionInputSchemasV1['machines.managed.retention.update'].parse(request.input);
                if (!('creationScopeRetention' in policy)) throw new Error('Unexpected ordinary policy edit');
                const runId = births.get(`${machine.homeId}:${machine.id}`);
                machine = { ...machine, intentRevision: machine.intentRevision + 1,
                    creationScopeRetention: policy.creationScopeRetention ? { ...policy.creationScopeRetention,
                        source: runId ? { kind: 'run', source: { kind: 'workflow_run', runId } }
                            : { kind: 'session', sessionId: 'created-session' } } : undefined };
                return machine;
            }
            throw new Error('unexpected_power_effect');
        },
        workflowAction: async request => {
            if (request.actionId === 'workflow.run.start') return runs.execute({ ...request,
                input: WorkflowRunStartRequestV1Schema.parse(request.input) });
            if (request.actionId === 'session.trigger.list') return triggers.sessionList(request.input, request.context);
            if (request.actionId === 'workflow.trigger.list') return triggers.list(request.input, request.context);
            if (request.actionId === 'session.trigger.add') return triggers.sessionAdd(request.input, request.context);
            if (request.actionId === 'session.trigger.remove') return triggers.sessionRemove(request.input, request.context);
            if (request.actionId === 'session.trigger.update') return triggers.sessionUpdate(request.input, request.context);
            if (request.actionId === 'workflow.trigger.add') return triggers.add(request.input, request.context);
            if (request.actionId === 'workflow.trigger.update') return triggers.update(request.input, request.context);
            if (request.actionId === 'workflow.trigger.remove') return triggers.remove(request.input, request.context);
            throw new Error('unexpected_trigger_action');
        },
    }));
    return { rows, get machine() { return machine; }, confirmations, executeAction: createFrontDoorActionExecute(executor), finCreates: () => finCreates,
        lookupBirth: (input: unknown) => {
            const request = ManagedMachineActionInputSchemasV1['machines.managed.birth.get'].parse(input);
            const runId = births.get(`${request.homeId}:${request.managedId}`);
            return ManagedMachineBirthResultV1Schema.parse({ source: runId
                ? { kind: 'run', source: { kind: 'workflow_run', runId } } : null });
        }, runCount: () => births.size, admitBirth: (runId: string) => births.set(`${machine.homeId}:${machine.id}`, runId) };
}

describe('New managed durable workflow continuation', () => {
    it.each(['stop', 'delete'] as const)('recovers the admitted Run on a cold Machine detail through Keep → %s → Keep without inventory reads', async effect => {
        installHomeGovernanceBoundaries(homes);
        const previousState = storage.getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const homeId = 'srv_managed_workflow_birth';
        const serverUrl = 'https://managed-workflow-birth.test';
        const credentials = { token: createAccountTokenForTests('account', { currentAccount: true }) };
        const serverId = await homes.addHome({ name: 'Workflow Home', serverUrl, serverIdentityId: homeId,
            accountId: 'account', credentials });
        const scopeServerId = resolveServerProfileScopeIdForIdentifier(serverId);
        // Admit the saved Home's real Account scope without starting unrelated background Sync.
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId: scopeServerId, accountId: 'account' } });
        try {
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) throw new Error('Missing restored Account lifetime');
            const h = bindingTransport({ homeId, unrelatedRuns: 1_500 });
            const runId = '11111111-1111-4111-8111-111111111111';
            const expectedSource = { kind: 'run' as const, source: { kind: 'workflow_run' as const, runId } };
            const creationDraft = { ...draft, selection: { ...draft.selection, homeId }, archiveEffect: 'keep' as const };
            const signal = new AbortController().signal;
            const scope = { serverId: scopeServerId, accountId: 'account' };
            const unrelatedSessions = Array.from({ length: 1_000 }, (_, index) => createPlainSessionCurrentProjectionRecordFixture({
                id: `unrelated-${index}`, active: index % 2 === 0,
                metadata: { path: '/repo', host: 'test.local', machineId: 'unrelated-machine' } }));
            homes.answer(serverId, 'POST /v1/machines/managed/actions/birth.get', { select: input => ({ body: h.lookupBirth(input) }) });
            homes.answer(serverId, '/v2/sessions', { body: { sessions: unrelatedSessions.slice(0, 500), nextCursor: null, hasNext: false } });
            homes.answer(serverId, '/v2/sessions/archived', { body: { sessions: unrelatedSessions.slice(500), nextCursor: null, hasNext: false } });
            const admitted = await runNewManagedWorkflowCreation({
                draft: creationDraft, acquisition: { ...initial, selection: creationDraft.selection, managedId: h.machine.id }, scope, signal,
                isCurrent: () => true, onAcquisitionChange: () => {}, onProgress: () => {}, onApprovalPending: () => {},
                onAccepted: () => {}, executeAction: h.executeAction,
                startRun: async (machineId, managedCreation) => {
                    const result = await h.executeAction('workflow.run.start', { runId, managedCreation,
                        source: { kind: 'inline', definition: { version: 1, defaults: {}, inputs: [], blocks: [{ kind: 'wait', id: 'wait',
                            document: { text: 'Continue', references: [], attachments: [] }, result: { kind: 'text' } }] } } },
                    { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'account', callerPermissionMode: 'default',
                        externalActionTarget: { kind: 'machine', machineId, project: { machineId, directory: '/work' } } });
                    expect(result.ok, JSON.stringify(result)).toBe(true);
                    if (!result.ok) throw new Error(result.error);
                    return WorkflowRunStartResultV1Schema.parse(result.result);
                },
            });
            expect(admitted, JSON.stringify(admitted)).toMatchObject({ kind: 'accepted', binding: { kind: 'kept' } });
            expect(h.finCreates()).toBe(0);
            expect(h.rows.size).toBe(0);
            expect(h.runCount()).toBe(1_501);
            // Reopen from an empty client projection: accepted-hook custody and FIN are absent.
            storage.setState({ sessions: {}, workflowRunsById: {} });
            const before = homes.requests.length;
            const readSource = () => readManagedCreationScopeBirthSource({ machine: h.machine, accountLifetime: lifetime, signal });
            expect(await readSource()).toEqual(expectedSource);
            const bound = await bindNewManagedMachineCreationScope({ draft: { ...creationDraft, archiveEffect: effect },
                machine: h.machine, source: expectedSource, scope, signal, isCurrent: () => true, executeAction: h.executeAction });
            expect(bound).toMatchObject({ kind: 'bound', binding: { source: expectedSource } });
            if (bound.kind !== 'bound') throw new Error('Missing FIN binding');
            expect(readManagedCreationScopeRule(h.machine)).toMatchObject({ effect, binding: { source: expectedSource } });
            expect(await readSource()).toEqual(expectedSource);
            const createsBeforeKeep = h.finCreates();
            expect(await bindNewManagedMachineCreationScope({ draft: creationDraft, machine: h.machine, source: expectedSource,
                existingBinding: bound.binding, scope, signal, isCurrent: () => true, executeAction: h.executeAction }))
                .toEqual({ kind: 'kept' });
            expect(h.finCreates()).toBe(createsBeforeKeep);
            expect([...h.rows.values()].flatMap(row => row.triggers)).toEqual([]);
            expect(readManagedCreationScopeRule(h.machine)).toBeNull();
            expect(await readSource()).toEqual(expectedSource);
            const reads = homes.requests.slice(before);
            expect(reads.filter(request => /^\/v[12]\/sessions(?:[/?]|$)/.test(request.path))).toHaveLength(0);
            const runReads = reads.filter(request => request.path === '/v1/machines/managed/actions/birth.get');
            expect(runReads).toHaveLength(3);
            for (const request of runReads) expect(request.input).toEqual({ homeId, managedId: h.machine.id });
            expect(storage.getState().sessions).toEqual({});
            expect(storage.getState().workflowRunsById).toEqual({});
        } finally {
            await homes.reset();
            storage.setState(previousState);
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });

    it.each(['keep', 'stop', 'delete'] as const)('binds %s only after durable Run admission through the Action executor', async effect => {
        const h = bindingTransport();
        const runId = '11111111-1111-4111-8111-111111111111';
        const result = await runNewManagedWorkflowCreation({
            draft: { ...draft, archiveEffect: effect }, acquisition: { ...initial, managedId: baseMachine.id },
            scope: { serverId: 'server', accountId: 'account' }, signal: new AbortController().signal, isCurrent: () => true,
            onAcquisitionChange: () => {}, onProgress: () => {}, onApprovalPending: () => {}, executeAction: h.executeAction,
            onAccepted: () => { expect(h.rows.size).toBe(0); },
            startRun: async (machineId, ...creation) => {
                expect(creation[0]).toEqual({ homeId: 'home', managedId: 'paid', controller });
                const started = await h.executeAction('workflow.run.start', { runId, managedCreation: creation[0], source: { kind: 'inline', definition: {
                    version: 1, defaults: {}, inputs: [], blocks: [{ kind: 'wait', id: 'wait',
                        document: { text: 'Continue', references: [], attachments: [] }, result: { kind: 'text' } }],
                } } }, { surface: 'ui', authority: 'present_user', serverId: 'server', expectedAccountId: 'account', callerPermissionMode: 'default',
                    externalActionTarget: { kind: 'machine', machineId, project: { machineId, directory: '/work' } } });
                expect(started.ok, JSON.stringify(started)).toBe(true);
                if (!started.ok) throw new Error(started.error);
                return WorkflowRunStartResultV1Schema.parse(started.result);
            },
        });
        expect(result).toMatchObject({ kind: 'accepted', binding: effect === 'keep' ? { kind: 'kept' } : { kind: 'bound',
            binding: { source: { kind: 'run', source: { kind: 'workflow_run', runId } } } } });
        expect(h.rows.size).toBe(0);
        expect(h.machine.creationScopeRetention?.effect).toBe(effect === 'keep' ? undefined : effect);
    });

    it('repairs an incomplete binding without starting its admitted Run again', async () => {
        let failWrite = true;
        const h = bindingTransport({ beforeWrite: async () => { if (failWrite) throw new Error('Reply unavailable'); } });
        let accepted: AcceptedManagedWorkflowCreation | undefined;
        let starts = 0;
        const input = {
            draft: { ...draft, archiveEffect: 'stop' as const }, acquisition: { ...initial, managedId: baseMachine.id },
            scope: { serverId: 'server', accountId: 'account' }, signal: new AbortController().signal, isCurrent: () => true,
            onAcquisitionChange: () => {}, onProgress: () => {}, onApprovalPending: () => {}, executeAction: h.executeAction,
            onAccepted: (value: AcceptedManagedWorkflowCreation) => { accepted = value; },
            startRun: async () => { starts++; h.admitBirth('11111111-1111-4111-8111-111111111111'); return { admission: 'created' as const,
                run: createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', machineId: 'guest', origin: { kind: 'direct' } }) }; },
        };
        expect(await runNewManagedWorkflowCreation(input)).toMatchObject({ kind: 'accepted', binding: { kind: 'incomplete' } });
        expect(accepted).toBeDefined();
        failWrite = false;
        expect(await runNewManagedWorkflowCreation({ ...input, accepted })).toMatchObject({ kind: 'accepted', binding: { kind: 'bound' } });
        expect(starts).toBe(1);
        expect(h.rows.size).toBe(0);
    });

    it('does not bind a refused or retired durable Run admission', async () => {
        const h = bindingTransport();
        const input = { draft: { ...draft, archiveEffect: 'delete' as const }, acquisition: { ...initial, managedId: baseMachine.id },
            scope: { serverId: 'server', accountId: 'account' }, signal: new AbortController().signal, isCurrent: () => true,
            onAcquisitionChange: () => {}, onProgress: () => {}, onApprovalPending: () => {}, executeAction: h.executeAction,
            onAccepted: () => { throw new Error('No Run was accepted'); }, startRun: async () => null };
        expect(await runNewManagedWorkflowCreation(input)).toMatchObject({ kind: 'pending' });
        expect(await runNewManagedWorkflowCreation({ ...input, isCurrent: () => false })).toMatchObject({ kind: 'failed', code: 'continuation_retired' });
        expect(h.rows.size).toBe(0);
    });
});

function transport(input: Readonly<{ current?: () => boolean; wait?: () => Promise<void>; enrolled?: boolean; failed?: boolean; setupFails?: boolean; setupSucceeds?: boolean; custodianAccountId?: string; denyCrossMachine?: boolean; preset?: ManagedMachinePresetV1; accountExecution?: boolean;
    requesterConsent?: boolean; trustBeforeConsent?: boolean; administratorAsk?: boolean; serverId?: string; homeId?: string;
    unreadableMachine?: boolean;
    actionFailure?: Readonly<{ actionId: string; error: Error }>;
    agentStartFailure?: { code: string; machineId: string; agentId: string };
    agentUpdate?: import('@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1').SessionAgentUpdateNoticeV1;
    createConfirmation?: boolean; pairingReview?: 'admitted' | 'absent' | 'forged' | 'unrelated';
    machineSetup?: ManagedMachineFullV1['machineSetup'] }> = {}) {
    // Persisted actor policy is fixture input, not a mocked policy decision or production waiver.
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
        'machines.setup.apply': ['ui'], 'machines.managed.setup.skip': ['ui'],
        // These tests exercise installer-secret custody, not child-policy review.
        // The composed CLI owner tests retain explicit Require on both effects.
        'machines.setup.adminAccess.set': ['ui'], 'machines.agentIsolation.set': ['ui'],
        'machines.managed.acquire': ['ui', 'agent'], 'machines.managed.bootstrap.retry': ['ui'],
        'machines.managed.bootstrap.respond': ['ui'], 'machines.managed.cancel': ['ui'],
        'machines.managed.get': ['ui'], 'action.operations.get': ['ui'],
        // The Agent-policy case permits the compute recipe's ordinary role seed.
        'machines.roles.set': ['agent'],
    } });
    const actions: Array<{ actionId: string; input: unknown }> = [];
    const additionalConfirmations: string[] = [];
    let reviewedChild: HostReviewedChildPortV1 | undefined;
    let consent: boolean | undefined;
    let trusted = false;
    let administrator: 'asked' | 'password' | 'cancelled' = 'asked';
    const establishPasswords: string[] = [];
    let machine = { ...baseMachine, ...(input.accountExecution ? { controller: undefined } : {}), homeId: input.homeId ?? baseMachine.homeId, custodianAccountId: input.custodianAccountId ?? baseMachine.custodianAccountId,
        ...(input.requesterConsent ? { enrollmentAccountId: 'account' } : {}),
        ...(input.enrolled ? { enrolledMachineId: 'guest' } : {}),
        ...(input.machineSetup ? { preset: { id: 'preset', revision: 4, contentEncryptionMode: 'plain' as const }, machineSetup: input.machineSetup } : {}) };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        resolveAgentStartContext: async () => ({ caller: { kind: 'session', sessionId: 'parent', starterDepth: 0, turnDepth: 0 },
            baseline: { machineId: 'parent-machine', directory: '/work' }, roles: {}, ledSubtreeSessionIds: [],
            workDepthLimit: 4, callerPermissionCeiling: 'yolo' }),
        readActionsSettings: () => settings,
        // The generic confirmation presenter is a UI boundary. A completed
        // in-page decision must never reach it; real policy stays active.
        presentUserActionConfirmation: async ({ actionId }) => {
            additionalConfirmations.push(actionId);
            return false;
        },
        managedMachineReferences: async ({ input: request, signal }) => readMachineReferenceCensusV1({
            homeId: request.homeId, machineId: machine.enrolledMachineId ?? null, signal,
        }, {
            // Genuine Account persistence ports; requester census and Profile authority remain real.
            artifacts: { list: async () => ({ items: [], coverage: 'complete' }), read: async () => null,
                readMany: async artifactIds => artifactIds.map(() => null) },
            readSettings: async () => ({}),
            readProfileCatalog: () => loadProfileCatalogV1({ mode: 'plain', material: null,
                readPage: async () => ({ status: 'listed', rows: [], nextCursor: null, complete: true,
                    referenceGuardRevision: 'absent', transferControl: { status: 'absent' }, diagnostics: [] }),
                readReferenceGuard: async () => ({ status: 'ready', revision: 'absent' }),
                readTransfer: async () => ({ status: 'absent' }), readSource: async () => ({}), signal }),
            readPools: async () => ({ pools: [MachinePoolViewV1Schema.parse({
                pool: { id: '00000000-0000-4000-8000-000000000001', name: 'Guest pool', description: null,
                    revision: 1, createdAt: 1, updatedAt: 1,
                    members: [{ machineId: 'guest', enabled: true, priorityTier: 0, state: 'connected' }] },
                availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
            })] }),
            readAssignments: async () => ({ automations: [], nextCursor: null }),
            readDeployments: async () => { throw new Error('deployment_reference_transport_unavailable'); },
        }),
        // These ports are the controller socket and Account HTTP boundaries;
        // real Action admission, strict schemas, output validation and continuation remain active.
        machinePresetAction: async request => {
            actions.push(request);
            if (request.actionId === 'machines.presets.get' && input.preset) return { kind: 'found', preset: input.preset };
            throw new Error('unexpected_preset_action');
        },
        machineManagedInstallationRespond: createManagedMachineInstallationRespond(),
        managedMachineAction: async request => {
            actions.push(request);
            if (request.actionId === input.actionFailure?.actionId) throw input.actionFailure.error;
            if (request.actionId === 'machines.managed.get') return input.unreadableMachine ? null : machine;
            if (request.actionId === 'machines.managed.delete') return {
                kind: 'accepted', managedId: machine.id, intentRevision: machine.intentRevision + 1,
                operation: { operationId: 'delete' }, machineReferences: {
                    homeId: machine.homeId, machineId: machine.enrolledMachineId ?? null, coverage: 'complete',
                    references: [{ kind: 'machine_pool', id: 'pool', name: 'Guest pool' }], unavailable: [],
                },
            };
            if (request.actionId === 'machines.managed.acquire' || request.actionId === 'machines.managed.bootstrap.retry') {
                reviewedChild = request.context.hostReviewedChild;
                if (input.accountExecution) {
                    expect(request.context.executionRunTargetMachineId).toBeUndefined();
                    machine = { ...machine, enrolledMachineId: 'guest' };
                    return { managedId: machine.id };
                }
                return { managedId: machine.id, operation: { operationId: 'install' } };
            }
            if (request.actionId === 'machines.managed.cancel') { administrator = 'cancelled'; return { machine }; }
            if (request.actionId === 'machines.managed.setup.skip' && machine.machineSetup) {
                machine = { ...machine, machineSetup: { ...machine.machineSetup, state: 'skipped', errorCode: undefined } };
                return machine;
            }
            throw new Error('unexpected_machine_action');
        },
        machineSetupPlan: async request => {
            actions.push({ actionId: 'machines.setup.plan', input: request.input });
            const sources = 'sources' in request.input && request.input.sources ? request.input.sources : [
                { kind: 'accountPresetOpaque', presetId: 'other', presetRevision: 1, contentEncryptionMode: 'plain' },
                { kind: 'direct', setup: { scripts: [{ body: '\r\necho direct\r\n' }] } },
            ];
            return MachineSetupPlanResultV1Schema.parse({ desiredRevision: 6, exclusions: [], support: [], sources,
                ...('mode' in request.input && request.input.mode === 'effects' ? { recipePlans: [] } : {}) });
        },
        machineSetupApply: async request => {
            actions.push({ actionId: 'machines.setup.apply', input: request.input });
            if (!machine.machineSetup) throw new Error('unexpected_environment_setup');
            machine = { ...machine, machineSetup: { ...machine.machineSetup, state: 'running', errorCode: undefined,
                operation: { operationId: 'setup' } } };
            return { operationId: 'setup' };
        },
        actionOperationAction: async request => {
            actions.push(request);
            await input.wait?.();
            if (input.trustBeforeConsent && !trusted) return { kind: 'found', operation: {
                version: 1, operationId: 'install', revision: 1, actionId: 'machines.managed.acquire', state: 'running',
                scope: { accountId: 'account', machineId: 'controller' }, title: 'Install', createdAt: 1, startedAt: 1,
                cancellation: 'supported', domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller,
                    bootstrapTask: { id: 'requester-pairing', taskKind: 'remote.ssh.bootstrapMachine.v1',
                        prompt: { kind: 'ssh.trustHost', message: 'Trust this guest?', host: 'guest.test', keyType: 'ssh-ed25519',
                            fingerprint: 'SHA256:guest', existingFingerprint: null } } },
            } };
            if (input.requesterConsent && consent === undefined) return { kind: 'found', operation: {
                version: 1, operationId: 'install', revision: 1, actionId: 'machines.managed.acquire', state: 'running',
                scope: { accountId: 'account', machineId: 'controller' }, title: 'Install', createdAt: 1, startedAt: 1,
                cancellation: 'supported', domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller,
                    bootstrapTask: { id: 'requester-pairing', taskKind: 'remote.ssh.bootstrapMachine.v1',
                        prompt: { kind: 'auth.approveRemoteProvisioning', message: 'Sign this guest into your Account?' } } },
            } };
            if (input.administratorAsk && consent === true && administrator === 'asked') return { kind: 'found', operation: {
                version: 1, operationId: 'install', revision: 1, actionId: 'machines.managed.acquire', state: 'running',
                scope: { accountId: 'account', machineId: 'controller' }, title: 'Install', createdAt: 1, startedAt: 1,
                cancellation: 'supported', domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller,
                    bootstrapTask: { id: 'requester-pairing', taskKind: 'remote.ssh.bootstrapMachine.v1',
                        prompt: { kind: 'administrator.establish', promptId: 'administrator-prompt', administratorUsername: 'operator',
                            message: 'Your new administrator password passes through setup.' } } },
            } };
            if (administrator === 'cancelled') return { kind: 'found', operation: {
                version: 1, operationId: 'install', revision: 2, actionId: 'machines.managed.acquire', state: 'cancelled',
                scope: { accountId: 'account', machineId: 'controller' }, title: 'Install', createdAt: 1, startedAt: 1,
                settledAt: 2, cancellation: 'supported',
                domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller },
            } };
            if (input.requesterConsent && consent === false) return { kind: 'found', operation: {
                version: 1, operationId: 'install', revision: 2, actionId: 'machines.managed.acquire', state: 'failed',
                scope: { accountId: 'account', machineId: 'controller' }, title: 'Install', createdAt: 1, startedAt: 1,
                settledAt: 2, cancellation: 'supported', error: { errorCode: 'auth_declined', error: 'Enrollment declined' },
                domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller },
            } };
            if ('operationId' in request.input && request.input.operationId === 'setup') {
                if (machine.machineSetup) machine = { ...machine, machineSetup: { ...machine.machineSetup, state: 'succeeded' } };
                return { kind: 'found', operation: { version: 1, operationId: 'setup', revision: 2,
                    actionId: 'machines.setup.apply', state: 'succeeded',
                    scope: { accountId: 'account', machineId: 'guest' }, title: 'Set up',
                    createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported' } };
            }
            if (!input.failed) machine = { ...machine, enrolledMachineId: 'guest' };
            if (input.setupFails && machine.machineSetup) machine = { ...machine,
                machineSetup: { ...machine.machineSetup, state: 'failed', errorCode: 'setup_failed' } };
            if (input.setupSucceeds && machine.machineSetup) machine = { ...machine,
                machineSetup: { ...machine.machineSetup, state: 'succeeded', errorCode: undefined } };
            return { kind: 'found', operation: { version: 1, operationId: 'install', revision: 2,
                actionId: 'machines.managed.acquire', state: input.failed || input.setupFails || input.agentStartFailure ? 'failed' : 'succeeded',
                scope: { accountId: 'account', machineId: 'controller' }, title: 'Install',
                createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported',
                ...(input.requesterConsent || input.agentUpdate ? { domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller,
                    ...(input.agentUpdate ? { agentUpdate: input.agentUpdate } : {}) } } : {}),
                ...(input.agentStartFailure ? { error: { errorCode: input.agentStartFailure.code, error: 'Agent is not ready',
                    details: { kind: 'managedAgentStart', machineId: input.agentStartFailure.machineId, agentId: input.agentStartFailure.agentId } } }
                    : input.failed || input.setupFails ? { error: { errorCode: input.setupFails ? 'setup_failed' : 'installation_failed', error: 'Creation stage failed' } } : {}) } };
        },
    }));
    let acquisition = initial;
    const progress: ManagedMachineCreationProgress[] = [];
    const hostContext = (actionId: Parameters<typeof executor.execute>[0], context: Parameters<typeof executor.execute>[2]) => ({
        ...context, actionsSettings: settings, actionCaller: { kind: 'host' as const }, runtimeAccountId: 'account',
        actionRequestId: context?.actionRequestId ?? `managed-confirm:${actionId}`,
    });
    const executeAsAgent: typeof executor.execute = (actionId, value, context) => executor.execute(actionId, value, { ...context,
        actionsSettings: settings,
        surface: 'agent', authority: 'account_automation', defaultSessionId: 'parent', callerPermissionMode: 'yolo',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
        sessionInputSource: { sourceSessionId: 'parent', sourceTurnId: 'turn', via: 'action' },
        sessionAgentSpawnPolicyV1: { allowCrossMachine: false },
    });
    const runInput = (options: Readonly<{ retryInstallation?: boolean; setupRecovery?: 'retry' | 'skip' | 'delete';
        reviewDelete?: (census: MachineReferenceCensusV1) => Promise<boolean>;
        acquisition?: ManagedMachineAcquisitionDraft; draft?: typeof draft; agentStart?: ManagedAcquireAgentStartV1 }> = {}): Parameters<typeof runManagedMachineCreation>[0]
            & { executeAction: ReturnType<typeof createFrontDoorActionExecute> } => ({
        draft: options.draft ?? draft, acquisition: options.acquisition ?? acquisition, scope: { serverId: input.serverId ?? 'server', accountId: 'account' },
        signal: new AbortController().signal, isCurrent: input.current ?? (() => true),
        executeAction: createFrontDoorActionExecute(input.denyCrossMachine ? {
            execute: executeAsAgent,
            executeConfirmed: executeAsAgent,
        } : { ...executor,
            execute: (actionId, value, context) => executor.execute(actionId, value, hostContext(actionId, context)),
            // New's real entry calls the confirmed front door. Model its human
            // surface at that boundary, preserving the real confirmation binding.
            executeConfirmed: async (actionId, value, context) => {
                // The surface's designed Create confirmation is a human UI boundary;
                // its exact-input admission still comes from the real binding owner.
                if (input.createConfirmation && actionId === 'machines.managed.acquire') {
                    const { Modal } = await import('@/modal');
                    if (!await Modal.confirm('Create machine', 'Create the reviewed Team machine?')) {
                        return { ok: false, errorCode: 'approval_canceled', error: 'approval_canceled' };
                    }
                }
                const bound = bindPresentUserActionConfirmation(actionId, value, hostContext(actionId, context));
                return executor.execute(actionId, value, bound);
            },
        }),
        onAcquisitionChange: value => { acquisition = value; }, onProgress: value => progress.push(value),
        onApprovalPending: () => { throw new Error('unexpected_approval'); }, ...options,
    });
    const run = (options?: Parameters<typeof runInput>[0]) => runManagedMachineCreation(runInput(options));
    const runWorkflow = (options?: Parameters<typeof runInput>[0]) => {
        const invocation = runInput(options);
        const workflow = bindingTransport({ custodianAccountId: input.custodianAccountId, homeId: input.homeId });
        return runNewManagedWorkflowCreation({ ...invocation, draft: { ...draft, ...invocation.draft, archiveEffect: 'keep' }, onAccepted: () => {},
            startRun: async (machineId, managedCreation) => {
                actions.push({ actionId: 'workflow.run.start', input: { machineId, managedCreation } });
                const result = await workflow.executeAction('workflow.run.start', {
                    runId: '11111111-1111-4111-8111-111111111111', managedCreation,
                    source: { kind: 'inline', definition: { version: 1, defaults: {}, inputs: [], blocks: [{ kind: 'wait', id: 'wait',
                        document: { text: 'Continue', references: [], attachments: [] }, result: { kind: 'text' } }] } },
                }, { surface: 'ui', authority: 'present_user', serverId: 'server', expectedAccountId: 'account', callerPermissionMode: 'default',
                    externalActionTarget: { kind: 'machine', machineId, project: { machineId, directory: '/work' } } });
                if (!result.ok) throw new Error(result.error);
                return WorkflowRunStartResultV1Schema.parse(result.result);
            },
        });
    };
    return { run, runWorkflow, actions, progress, additionalConfirmations, establishPasswords, getAcquisition: () => acquisition, readMachine: () => machine,
        readReviewedChild: () => input.pairingReview === 'admitted' ? reviewedChild
            : input.pairingReview === 'forged' && reviewedChild ? { parent: reviewedChild.parent, invoke: reviewedChild.invoke }
            : input.pairingReview === 'unrelated' ? createHostReviewedChildPortV1({ actionId: 'machines.managed.inspect',
                input: { homeId: machine.homeId, managedId: machine.id }, context: {}, reviewAdmitted: true,
                execute: async () => ({ ok: true, result: {} }) }) : undefined,
        answer: (response: import('@happier-dev/protocol/machines/managed/actionsV1').ManagedInstallationResponseV1) => {
            const answer = response.answer;
            if (typeof answer !== 'object' || answer === null) throw new Error('The native answer is missing');
            if (response.expectedPromptKind === 'administrator.establish' && 'password' in answer && typeof answer.password === 'string') {
                establishPasswords.push(answer.password);
                administrator = 'password';
            } else if (response.expectedPromptKind === 'ssh.trustHost' && 'trusted' in answer && typeof answer.trusted === 'boolean') trusted = answer.trusted;
            else if ('approved' in answer && typeof answer.approved === 'boolean') consent = answer.approved;
            else throw new Error('Unexpected native answer');
        },
        changeIntentRevision: (intentRevision: number) => { machine = { ...machine, intentRevision }; } };
}

describe('ordinary managed creation continuation', () => {
    it.each(['machines.managed.acquire', 'machines.managed.get'])('retains the typed owner cause from %s in creation progress', async actionId => {
        const failureCause = { phase: actionId, errorClass: 'ManagedMachineControllerError' as const,
            errorCode: 'credential_scope_denied', httpStatus: null };
        const boundary = transport({ actionFailure: { actionId,
            error: Object.assign(new Error('Private native diagnostic'), { code: 'action_failed', failureCause }) } });
        expect(await boundary.run()).toMatchObject({ kind: 'failed', code: 'action_failed' });
        const progress = boundary.progress.at(-1);
        expect(progress).toMatchObject({ kind: 'failed', code: 'action_failed' });
        if (progress?.kind !== 'failed') throw new Error('Expected failed creation progress');
        expect(progress.diagnosticDetail).toContain('credential_scope_denied');
        expect(progress.diagnosticDetail).toContain('ManagedMachineControllerError');
        expect(progress.diagnosticDetail).not.toContain('Private native diagnostic');
    });
    it.each([false, true])('keeps the managed read refusal in both result and progress (retained=%s)', async retained => {
        const boundary = transport({ unreadableMachine: true });
        const result = await boundary.run(retained ? { acquisition: { ...initial, managedId: baseMachine.id } } : {});
        expect(boundary.progress.at(-1)).toMatchObject({ kind: 'failed', code: 'invalid_action_output' });
        expect(result).toMatchObject({ kind: 'failed', code: 'invalid_action_output' });
        expect(boundary.getAcquisition().managedId ?? (retained ? baseMachine.id : undefined)).toBe(baseMachine.id);
    });
    it('retains the actual enrolled Agent setup target and names its owner for setup refusal', async () => {
        const { presentMachineAgentStartRefusal } = await import('@/components/machines/agents/presentMachineAgentStartRefusal');
        const { machineCollectionHref } = await import('@/components/settings/machines/collection/machineCollectionModel');
        const { Modal } = await import('@/modal');
        const alert = vi.spyOn(Modal, 'alert').mockImplementation(() => {});
        const openSetup = vi.fn();
        try {
            expect(presentMachineAgentStartRefusal({ code: 'agent_cli_not_ready', agentTitle: 'Claude', machineName: 'Guest',
                setupOwnerName: 'Alex', setupTarget: { serverId: 'server', machineId: 'guest' }, openSetup })).toBe(true);
            expect(alert.mock.calls[0]?.slice(0, 2).join(' ')).toContain('Alex');
            const setupButton = alert.mock.calls[0]?.[2]?.find(button => button.onPress);
            expect(setupButton).toBeDefined();
            setupButton?.onPress?.();
            expect(openSetup).toHaveBeenCalledWith(machineCollectionHref({ serverId: 'server', machineId: 'guest' }));
        } finally { alert.mockRestore(); }
    });
    it('retains the actual enrolled Agent setup target from a failed controller operation', async () => {
        const boundary = transport({ agentStartFailure: { code: 'agent_cli_missing', machineId: 'guest', agentId: 'claude' } });
        const result = await boundary.run({ acquisition: { ...initial, managedId: baseMachine.id, operation: { operationId: 'install' } } });
        expect(result, JSON.stringify({ actions: boundary.actions.map(action => action.actionId), confirmations: boundary.additionalConfirmations })).toMatchObject({ kind: 'failed', code: 'agent_cli_missing',
            agentStartFailure: { kind: 'managedAgentStart', machineId: 'guest', agentId: 'claude' } });
    });
    it.each(['pending', 'failed'] as const)('retains the optional Agent update notice from successful managed creation (%s)', async status => {
        const agentUpdate = { agentId: 'claude', status, requestId: `manual:managed-update-${status}` };
        const boundary = transport({ agentUpdate });
        expect(await boundary.run({ acquisition: { ...initial, managedId: baseMachine.id, operation: { operationId: 'install' } } }))
            .toMatchObject({ kind: 'enrolled', machine: { enrolledMachineId: 'guest' }, agentUpdate });
    });
    it('creates and resumes an Account resource without selecting a controller Machine', async () => {
        const { controller: _receiptController, ...receipt } = draft.receipt;
        if (draft.selection.kind !== 'one-off') throw new Error('Expected a one-off creation');
        const { controller: _selectionController, ...selection } = draft.selection;
        const selected = createManagedMachineSelectionDraft({ ...draft, selection, receipt });
        const boundary = transport({ accountExecution: true });
        expect(await boundary.run({ draft: selected, acquisition: { ...initial, selection } }))
            .toMatchObject({ kind: 'enrolled', machine: { id: 'paid', enrolledMachineId: 'guest' } });
        expect(await boundary.run({ draft: selected })).toMatchObject({ kind: 'enrolled' });
        expect(boundary.actions.filter(action => action.actionId === 'machines.managed.acquire')).toHaveLength(1);
        expect(boundary.actions.filter(action => action.actionId === 'action.operations.get')).toHaveLength(0);
    });
    it.each([
        ...[{ entry: 'creation', approved: true, trust: false },
        { entry: 'workflow', approved: true, trust: false },
        { entry: 'creation', approved: true, trust: true }].map(value => ({ ...value, review: 'absent' as const, createConfirmation: false })),
        ...(['admitted', 'absent', 'forged', 'unrelated'] as const).map(review => ({ entry: 'creation', approved: true,
            trust: false, review, createConfirmation: true })),
    ])('uses the existing requester question presenter and resumes the same delegated acquisition ($entry, approve: $approved, trust: $trust, review: $review, Create confirmation: $createConfirmation)', async ({ entry, approved, trust, review, createConfirmation }) => {
        const { Modal } = await import('@/modal');
        const hostKeyQuestion = vi.spyOn(Modal, 'show').mockImplementation(config => {
            const props: unknown = config.props;
            if (config.chrome?.testID !== 'ssh-host-key-modal' || !props || typeof props !== 'object'
                || !('onResolve' in props) || typeof props.onResolve !== 'function') throw new Error('Unexpected custom question');
            expect(homes.requestsFor('/v1/auth/response')).toHaveLength(0);
            props.onResolve(approved);
            return 'host-key-question';
        });
        const confirmation = vi.spyOn(Modal, 'confirm').mockImplementation(async () => {
            expect(homes.requestsFor('/v1/auth/response')).toHaveLength(0);
            return approved;
        });
        await homes.reset();
        const homeId = 'srv_managed_requester_entry';
        const serverUrl = `https://managed-${entry}-${approved}-${trust}-${review}-${createConfirmation}.test`;
        const token = createAccountTokenForTests('account', { currentAccount: true });
        const serverId = await homes.addHome({ name: 'Requester Home', serverUrl, serverIdentityId: homeId,
            accountId: 'account', currentAccount: true, credentials: { token } });
        const preset = createDelegatedManagedPresetFixture({ preset: {
            id: 'team-preset', homeId, revision: 1, name: 'Team sandbox', owner: { kind: 'team', teamId: 'team' },
            launch, controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        }, custodianAccountId: 'company', installationPublicKey: 'BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY', descriptor: {
            id: 'native', title: 'Compute', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false },
            resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
            billing: draft.receipt.billing, retention: draft.receipt.retentionCapabilities,
            actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
        } });
        const selection = { kind: 'preset' as const, homeId: preset.homeId, id: preset.id, revision: preset.revision };
        const boundary = transport({ preset, requesterConsent: true, trustBeforeConsent: trust, custodianAccountId: 'company', serverId, homeId,
            createConfirmation, pairingReview: review });
        const { installManagedInstallationResponseBoundary } = await import('@/dev/testkit/harness/managedInstallationResponseBoundary');
        const installation = installManagedInstallationResponseBoundary({ homes, serverId, serverUrl, homeId, token,
            enrollmentAccountId: 'account', readMachine: boundary.readMachine, onAnswer: boundary.answer,
            readReviewedChild: boundary.readReviewedChild });
        try {
            const result = await (entry === 'workflow' ? boundary.runWorkflow : boundary.run)({ draft: { ...draft, selection, presetContentOverride: exactPresetContentOverride },
                acquisition: { ...initial, selection } });
            expect(result, JSON.stringify(result)).toMatchObject(approved ? entry === 'workflow'
                ? { kind: 'accepted', accepted: { machine: { id: 'paid', enrolledMachineId: 'guest' } } }
                : { kind: 'enrolled', machine: { id: 'paid', enrolledMachineId: 'guest' } }
                    : { kind: 'failed', code: 'auth_declined' });
            expect(hostKeyQuestion.mock.calls.length + confirmation.mock.calls.length).toBe(createConfirmation
                ? 1 : trust ? 1 : 0);
            expect(boundary.additionalConfirmations).toEqual([]);
            expect(installation.answers).toEqual([
                ...(trust ? [expect.objectContaining({ homeId, managedId: 'paid', operationId: 'install', taskId: 'requester-pairing',
                    controller, resource: baseMachine.resource, expectedPromptKind: 'ssh.trustHost', answer: { trusted: true } })] : []),
                expect.objectContaining({ homeId, managedId: 'paid', operationId: 'install', taskId: 'requester-pairing',
                    controller, resource: baseMachine.resource, expectedPromptKind: 'auth.approveRemoteProvisioning', answer: { approved } }),
            ]);
            expect(homes.requestsFor('/v1/auth/response')).toHaveLength(approved ? 1 : 0);
            // SEC2: the existing private response supplies both secret and F2
            // admission once; the response consumes the supplied answer.
            expect(installation.deliveries).toHaveLength(1);
            expect(boundary.actions.filter(value => value.actionId === 'action.operations.get')).toHaveLength(trust ? 3 : 2);
            expect(boundary.actions.filter(value => value.actionId === 'machines.managed.acquire')).toHaveLength(1);
            expect(boundary.actions.filter(value => value.actionId === 'workflow.run.start')).toHaveLength(entry === 'workflow' && approved ? 1 : 0);
        } finally { installation.dispose(); hostKeyQuestion.mockRestore(); confirmation.mockRestore(); await homes.reset(); }
    });
    it.each([{ entry: 'creation', answer: 'password' }, { entry: 'workflow', answer: 'password' },
        { entry: 'creation', answer: 'decline' }, { entry: 'workflow', answer: 'decline' }] as const)(
        'asks the named administrator’s password in the installer Modal and resumes or cancels without exposing it ($entry, $answer)', async ({ entry, answer }) => {
        const { Modal } = await import('@/modal');
        const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
        const secret = 'correct-horse-battery-staple';
        const prompt = vi.spyOn(Modal, 'prompt').mockResolvedValue(answer === 'password' ? secret : null);
        const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
        await homes.reset();
        const homeId = 'srv_managed_administrator_entry';
        const serverUrl = `https://managed-administrator-${entry}-${answer}.test`;
        const token = createAccountTokenForTests('account', { currentAccount: true });
        const serverId = await homes.addHome({ name: 'Requester Home', serverUrl, serverIdentityId: homeId,
            accountId: 'account', currentAccount: true, credentials: { token } });
        const preset = createDelegatedManagedPresetFixture({ preset: {
            id: 'team-preset', homeId, revision: 1, name: 'Team sandbox', owner: { kind: 'team', teamId: 'team' },
            launch, controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        }, custodianAccountId: 'company', installationPublicKey: 'BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY', descriptor: {
            id: 'native', title: 'Compute', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false },
            resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
            billing: draft.receipt.billing, retention: draft.receipt.retentionCapabilities,
            actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
        } });
        const selection = { kind: 'preset' as const, homeId: preset.homeId, id: preset.id, revision: preset.revision };
        const boundary = transport({ preset, requesterConsent: true, administratorAsk: true, custodianAccountId: 'company', serverId, homeId });
        const { installManagedInstallationResponseBoundary } = await import('@/dev/testkit/harness/managedInstallationResponseBoundary');
        const installation = installManagedInstallationResponseBoundary({ homes, serverId, serverUrl, homeId, token,
            enrollmentAccountId: 'account', readMachine: boundary.readMachine, onAnswer: boundary.answer });
        try {
            const result = await (entry === 'workflow' ? boundary.runWorkflow : boundary.run)({ draft: { ...draft, selection, presetContentOverride: exactPresetContentOverride,
                enrollmentIdentity: { kind: 'dedicatedDaemonUser' as const, username: 'happier' as const, serviceMode: 'user' as const,
                    role: 'server' as const, adminAccessAtCreation: 'ask' as const, administrator: { username: 'operator' } } },
                acquisition: { ...initial, selection } });
            // The creation is admitted (spent) before the question; the only answer authority is the existing requester response Action.
            expect(result).toMatchObject(answer === 'password'
                ? entry === 'workflow' ? { kind: 'accepted' } : { kind: 'enrolled' }
                : { kind: 'failed', code: 'creation_canceled' });
            expect(boundary.actions.filter(value => value.actionId === 'machines.managed.acquire')).toHaveLength(1);
            expect(prompt).toHaveBeenCalledTimes(1);
            expect(prompt.mock.calls[0]![2]).toMatchObject({ inputType: 'secure-text' });
            expect(String(prompt.mock.calls[0]![1])).toContain('operator');
            const establish = installation.answers.filter(value => value.expectedPromptKind === 'administrator.establish');
            if (answer === 'password') {
                expect(result).toMatchObject(entry === 'workflow'
                    ? { kind: 'accepted', accepted: { machine: { id: 'paid', enrolledMachineId: 'guest' } } }
                    : { kind: 'enrolled', machine: { id: 'paid', enrolledMachineId: 'guest' } });
                expect(establish).toEqual([expect.objectContaining({ homeId, managedId: 'paid', operationId: 'install', taskId: 'requester-pairing',
                    controller, resource: baseMachine.resource, expectedPromptKind: 'administrator.establish',
                    expectedPromptId: 'administrator-prompt', answer: { password: secret } })]);
                expect(boundary.actions.filter(value => value.actionId === 'machines.managed.cancel')).toHaveLength(0);
            } else {
                expect(result).toEqual({ kind: 'failed', code: 'creation_canceled' });
                expect(establish).toHaveLength(0);
                expect(boundary.actions.filter(value => value.actionId === 'machines.managed.cancel')).toEqual([
                    expect.objectContaining({ input: { homeId, managedId: 'paid', expectedIntentRevision: baseMachine.intentRevision } })]);
            }
            // The secret travels only in the one response; it never reaches progress, action records or logs.
            const observable = JSON.stringify([boundary.progress, boundary.actions, logs.flatMap(log => log.mock.calls)]);
            expect(observable).not.toContain(secret);
            // No controller grant is created for the requester.
            expect(boundary.actions.filter(value => /controller\.(update|grant)|grant/.test(value.actionId))).toHaveLength(0);
        } finally { installation.dispose(); confirmation.mockRestore(); prompt.mockRestore(); logs.forEach(log => log.mockRestore()); await homes.reset(); }
    });
    it('keeps fresh ordinary owner preset creation on the existing acquire continuation', async () => {
        const preset = opaqueTeamPreset('preset', 'home', 1, 'Owner sandbox');
        const selection = { kind: 'preset' as const, homeId: preset.homeId, id: preset.id, revision: preset.revision };
        const boundary = transport({ preset });
        expect(await boundary.run({ draft: { ...draft, selection, presetContentOverride: exactPresetContentOverride }, acquisition: { ...initial, selection } }))
            .toMatchObject({ kind: 'enrolled', machine: { id: 'paid' } });
        expect(boundary.actions.filter(value => value.actionId === 'machines.managed.acquire')).toHaveLength(1);
    });
    it('resumes the selected Preset revision with its captured opaque carrier without reading a newer Preset', async () => {
        const selection = { kind: 'preset' as const, homeId: 'home', id: 'selected-preset', revision: 4 };
        const selectedPreset = opaqueTeamPreset(selection.id, selection.homeId, selection.revision, 'Selected revision');
        const { createManagedMachinePresetAcquireOverrideV1, projectManagedMachinePresetForRecipientV1 } =
            await import('@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
        const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({
            presetId: selectedPreset.id,
            mode: 'plain',
            projection: projectManagedMachinePresetForRecipientV1({
                content: selectedPreset.content,
                recipients: selectedPreset.recipients,
                recipientAccountId: 'account',
            }),
            enrollmentIdentity: draft.enrollmentIdentity!,
        });
        if (!presetContentOverride) throw new Error('Expected the selected opaque override');
        const selected = createManagedMachineSelectionDraft({ selection, receipt: selectedPreset.opened.reviewedFacts, presetContentOverride });
        // This is deliberately newer than the selected draft. A resume must not fetch it to rebuild the carrier.
        const newer = opaqueTeamPreset(selection.id, selection.homeId, 5, 'Changed later');
        const boundary = transport({ preset: newer });

        expect(await boundary.run({ draft: selected, acquisition: { ...initial, selection } }))
            .toMatchObject({ kind: 'enrolled', machine: { id: 'paid' } });

        expect(boundary.actions.filter(value => value.actionId === 'machines.presets.get')).toEqual([]);
        const acquire = boundary.actions.find(value => value.actionId === 'machines.managed.acquire');
        expect(acquire?.input).toMatchObject({ selection, presetContentOverride });
        expect(acquire?.input).not.toHaveProperty('enrollmentIdentity');
    });
    it('continues sealed pool creation through the admitted controller and installer prompt without a native review', async () => {
        const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
        const restoreLoader = await installRealActionExecutorModuleLoader();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
            ExternalActionRequestEnvelopeV1Schema, projectExternalActionManagedAdmissionV1 } = await import('@happier-dev/protocol/actions/externalActionApi');
        const { computeExternalActionRequestEnvelopeDigestV1 } = await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
        const { encodeBase64 } = await import('@happier-dev/protocol/crypto/base64');
        const { installManagedInstallationResponseBoundary } = await import('@/dev/testkit/harness/managedInstallationResponseBoundary');
        const { Modal } = await import('@/modal');
        const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
        const nacl = (await import('tweetnacl')).default;
        const homeId = 'srv_fresh_pool_continuation';
        const serverUrl = 'https://fresh-pool.test';
        const boundaryErrors: string[] = [];
        const token = createAccountTokenForTests('account', { currentAccount: true });
        await homes.reset();
        let installation: ReturnType<typeof installManagedInstallationResponseBoundary> | undefined;
        try {
            const serverId = await homes.addHome({ name: 'Requester Home', serverUrl, serverIdentityId: homeId,
                accountId: 'account', currentAccount: true, machinePoolsEnabled: true, credentials: { token } });
            const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: homeId } } });
            // Mirror the full enabled Action fixture capability chain. The Pool resolver
            // is a server-owned child of Machines, but this journey also crosses the
            // Session creation front door before it reaches that resolver.
            for (const feature of ['sessions', 'sessions.drafts', 'sessions.ephemeralRunner', 'machines', 'machines.pools',
                'encryption.plaintextStorage', 'e2ee.keylessAccounts'] as const) {
                if (!tryWriteServerEnabledBitInPlace(features, feature, true)) {
                    throw new Error(`The ${feature} feature could not be enabled in its canonical fixture snapshot`);
                }
            }
            const { getServerFeaturesSnapshot, primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
            primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
            homes.answer(serverId, '/v1/features', { body: features });
            homes.answer(serverId, '/v1/features/authenticated', { body: features });
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('@/sync/domains/features/featureDecisionRuntime');
            const featureAccount = await captureLazyActionAccountContext(serverId);
            try {
                const snapshot = await getServerFeaturesSnapshot({ serverId: featureAccount.serverId });
                expect(resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'machines.pools',
                    settings: featureAccount.readLiveSettings() ?? await featureAccount.readSettings(), snapshot })).toMatchObject({ state: 'enabled' });
            } finally {
                featureAccount.dispose();
            }
            const requirement = { kind: 'systemTool' as const, id: { pluginId: 'custom.compute', localId: 'docker' } };
            const exactPreset = createDelegatedManagedPresetFixture({ preset: { id: 'pool-preset', homeId, revision: 1,
                name: 'Pool sandbox', owner: { kind: 'team', teamId: 'team' }, launch, controller,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }, custodianAccountId: 'company',
                installationPublicKey: encodeBase64(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(6)).publicKey, 'base64url'),
                descriptor: { id: 'native', title: 'Compute', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
                    launchSchema: { type: 'object', properties: {}, additionalProperties: false },
                    resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'],
                    prerequisites: [requirement], billing: draft.receipt.billing, retention: draft.receipt.retentionCapabilities,
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } });
            const poolId = '4d783830-8626-4da8-8fde-a6da516025e1';
            const preset = { ...exactPreset, controller: undefined, controllerPoolId: poolId };
            const selection = { kind: 'preset' as const, homeId, id: preset.id, revision: preset.revision };
            let machine: ManagedMachineFullV1 = { ...baseMachine, homeId, custodianAccountId: 'company', enrollmentAccountId: 'account',
                controllerAccess: exactPreset.opened.controllerAccess };
            let answered = false;
            installation = installManagedInstallationResponseBoundary({ homes, serverId, serverUrl, homeId, token,
                enrollmentAccountId: 'account', readMachine: () => machine, onAnswer: () => { answered = true; } });
            // The installation boundary owns its own ordinary feature fixture. Reapply
            // this case's enabled Pool capability after installing that genuine
            // boundary so the later action reads the same feature contract that this
            // journey is intended to exercise.
            primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
            homes.answer(serverId, '/v1/features', { body: features });
            homes.answer(serverId, '/v1/features/authenticated', { body: features });
            homes.answer(serverId, '/v1/machines/pools/resolve', { body: { kind: 'resolved', poolId,
                machineId: controller.machineId, priorityTier: 0, managedPreset: {
                    preset: { id: preset.id, revision: preset.revision, contentEncryptionMode: preset.contentEncryptionMode },
                    controller, controllerAccess: exactPreset.opened.controllerAccess,
                    retention: preset.retention, wakeOnAcceptedMessage: preset.wakeOnAcceptedMessage } } });
            for (const actionId of ['machines.managed.acquire', 'action.operations.get'] as const) {
                homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: value => {
                    try {
                    const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(value);
                    const managedAdmission = envelope.v === 1 ? projectExternalActionManagedAdmissionV1(actionId, envelope.input) : envelope.managedAdmission;
                    return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'exact-pool-root', binding: {
                        serverIdentityId: homeId, accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
                        machineId: controller.machineId, installationId: controller.installationId, custodianAccountId: 'company',
                        accountEncryptionMode: 'plain', actionId, requestId: envelope.requestId, target: envelope.target,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                        ...(actionId === 'action.operations.get' ? { managedAdmission } : {}),
                    } }) };
                    } catch (error) { boundaryErrors.push(String(error)); throw error; }
                } });
                homes.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                    try {
                    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(value);
                    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
                    expect(envelope.target).toEqual({ kind: 'machine', machineId: controller.machineId });
                    if (actionId === 'machines.managed.acquire') {
                        expect(envelope.input).toMatchObject({ controller, selection,
                            presetContentOverride: exactPresetContentOverride });
                        expect(envelope.input).not.toHaveProperty('reviewedFacts');
                    }
                    else expect(envelope.input).toMatchObject({ machineId: controller.machineId,
                        managed: { homeId, managedId: machine.id }, operationId: 'pool-install', includeManagedPrompt: true });
                    if (answered) machine = { ...machine, enrolledMachineId: 'guest' };
                    return { body: { v: 1, requestId: envelope.requestId, actionId, execution: { ok: true,
                        result: actionId === 'machines.managed.acquire' ? { managedId: machine.id, operation: { operationId: 'pool-install' } }
                            : { kind: 'found', operation: { version: 1, operationId: 'pool-install', revision: answered ? 2 : 1,
                                actionId: 'machines.managed.acquire', state: answered ? 'succeeded' : 'running',
                                scope: { accountId: 'account', machineId: controller.machineId }, title: 'Create pool sandbox',
                                createdAt: 1, startedAt: 2, ...(answered ? { settledAt: 3 } : {}), cancellation: 'supported',
                                domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller,
                                    ...(!answered ? { bootstrapTask: { id: 'pool-task', taskKind: 'remote.ssh.bootstrapMachine.v1',
                                        prompt: { kind: 'auth.approveRemoteProvisioning', message: 'Pair the created guest' } } } : {}) } } },
                    } } };
                    } catch (error) { boundaryErrors.push(String(error)); throw error; }
                } });
            }
            const progress: unknown[] = [];
            const result = await runManagedMachineCreation({ draft: { deferredAuthorPreset: true, selection, archiveEffect: 'keep',
                presetContentOverride: exactPresetContentOverride,
                presetOrigin: { id: preset.id, homeId: preset.homeId, revision: preset.revision,
                    controllerPoolId: poolId, retention: preset.retention,
                    wakeOnAcceptedMessage: preset.wakeOnAcceptedMessage } },
                acquisition: { ...initial, selection }, scope: { serverId, accountId: 'account' },
                signal: new AbortController().signal, isCurrent: () => true, onAcquisitionChange: () => {},
                onProgress: value => progress.push(value), onApprovalPending: () => { throw new Error('Create already confirmed'); },
                executeAction: createFrontDoorActionExecute(createDefaultActionExecutor()) });
            // TH 2026-11-13: saved review is informational; acquire owns delegated admission.
            expect(result, JSON.stringify({ result, boundaryErrors, requests: homes.requests.map(request => ({path:request.path})) })).toMatchObject({ kind: 'enrolled', machine: { id: machine.id, enrolledMachineId: 'guest' } });
            expect(homes.requestsFor('/v1/machines/pools/resolve')).toHaveLength(1);
            expect(homes.requestsFor('/v1/machines/presets/get')).toHaveLength(0);
            expect(homes.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(1);
            expect(installation.answers).toHaveLength(1);
            {
                expect(installation.answers[0]).toMatchObject({ controller, operationId: 'pool-install', taskId: 'pool-task',
                    expectedPromptKind: 'auth.approveRemoteProvisioning', answer: { approved: true } });
                expect(progress).toContainEqual(expect.objectContaining({ kind: 'acquiring', operation: expect.objectContaining({ state: 'succeeded' }) }));
            }
            expect(homes.requestsFor('/v1/machines/read-batch')).toHaveLength(0);
        } finally { installation?.dispose(); confirmation.mockRestore(); restoreLoader(); await homes.reset(); }
    });
    it('observes the admitted requester creation operation through exact resource scope without a controller grant', async () => {
        const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
        const restoreLoader = await installRealActionExecutorModuleLoader();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
            ExternalActionRequestEnvelopeV1Schema, projectExternalActionManagedAdmissionV1 } = await import('@happier-dev/protocol/actions/externalActionApi');
        const { computeExternalActionRequestEnvelopeDigestV1 } = await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
        const { encodeBase64 } = await import('@happier-dev/protocol/crypto/base64');
        const nacl = (await import('tweetnacl')).default;
        const homeId = 'srv_managed_composer_requester';
        await homes.reset();
        try {
            const serverId = await homes.addHome({ name: 'Requester Home', serverUrl: 'https://managed-composer-requester.test',
                serverIdentityId: homeId, accountId: 'account', credentials: { token: createAccountTokenForTests('account', { currentAccount: true }) } });
            const selection = { kind: 'preset' as const, homeId, id: 'team-preset', revision: 1 };
            const selected = { ...draft, selection, receipt: { ...draft.receipt, preset: { id: selection.id, revision: 1, name: 'Team sandbox' } } };
            const machine: ManagedMachineFullV1 = { ...baseMachine, homeId, custodianAccountId: 'company', enrollmentAccountId: 'account',
                controllerAccess: { custodian: { accountId: 'company' }, installationPublicKey: encodeBase64(
                    nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(6)).publicKey, 'base64url') } };
            const operation = { version: 1, operationId: 'install', revision: 1, actionId: 'machines.managed.acquire', state: 'running',
                scope: { accountId: 'account', machineId: controller.machineId }, title: 'Create Team sandbox', createdAt: 1, startedAt: 2,
                cancellation: 'supported', domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller,
                    bootstrapTask: { id: 'installation-task', taskKind: 'remote.ssh.bootstrapMachine.v1' } } };
            homes.answer(serverId, '/v1/machines/managed/actions/get', { body: machine });
            homes.answer(serverId, '/v1/actions/action.operations.get/execution-authorization', { select: value => {
                const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(value);
                const managedAdmission = envelope.v === 1 ? projectExternalActionManagedAdmissionV1('action.operations.get', envelope.input) : envelope.managedAdmission;
                return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'exact-resource-root', binding: {
                    serverIdentityId: homeId, accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
                    machineId: controller.machineId, installationId: controller.installationId, custodianAccountId: 'company', accountEncryptionMode: 'plain',
                    actionId: 'action.operations.get', requestId: envelope.requestId, target: envelope.target,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), managedAdmission,
                } }) };
            } });
            homes.answer(serverId, '/v1/actions/action.operations.get', { select: value => {
                if (!value || typeof value !== 'object' || !('envelope' in value)) throw new Error('Expected the signed operation read');
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(value.envelope);
                expect(envelope.input).toMatchObject({ managed: { homeId, managedId: machine.id }, operationId: 'install',
                    waitForTerminal: true, includeManagedPrompt: true });
                return { body: { v: 1, requestId: envelope.requestId, actionId: 'action.operations.get', execution: { ok: true,
                    result: { kind: 'found', operation } } } };
            } });
            const progress: unknown[] = [];
            const result = await runManagedMachineCreation({ draft: selected,
                acquisition: { ...initial, selection, managedId: machine.id, operation: { operationId: 'install' } },
                scope: { serverId, accountId: 'account' }, signal: new AbortController().signal, isCurrent: () => true,
                onAcquisitionChange: () => {}, onProgress: value => progress.push(value), onApprovalPending: () => {},
                executeAction: createFrontDoorActionExecute(createDefaultActionExecutor()) });
            expect(result).toEqual({ kind: 'pending', managedId: machine.id });
            expect(progress).toContainEqual({ kind: 'acquiring', managedId: machine.id, operation });
            expect(homes.requestsFor('/v1/machines/read-batch')).toHaveLength(0);
        } finally { restoreLoader(); await homes.reset(); }
    });
    it('refuses a denied authored Agent continuation before controller admission while bare compute remains allowed', async () => {
        const boundary = transport({ denyCrossMachine: true });
        const agentStart: ManagedAcquireAgentStartV1 = { directory: { kind: 'path', path: '/work' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'native.agent', localId: 'agent' } },
            initialInput: { text: 'Do the submitted work' } };
        expect(await boundary.run({ agentStart })).toEqual({ kind: 'failed', code: 'policy_denied_field' });
        expect(boundary.actions).toEqual([]);
        expect(boundary.getAcquisition()).not.toHaveProperty('managedId');
        const bareCompute = await boundary.run();
        expect(bareCompute, JSON.stringify(bareCompute)).toMatchObject({ kind: 'enrolled', machine: { id: 'paid' } });
        expect(boundary.actions.filter(value => value.actionId === 'machines.managed.acquire')).toHaveLength(1);
        expect(boundary.actions.find(value => value.actionId === 'machines.managed.acquire')?.input).not.toHaveProperty('agentStart');
    });
    it('deletes the same failed-setup row after one in-page review with zero additional approval prompts', async () => {
        const boundary = transport({ enrolled: true,
            machineSetup: { setup: { scripts: [{ body: 'echo ready' }] }, state: 'failed', errorCode: 'setup_failed' } });
        const reviewed: MachineReferenceCensusV1[] = [];
        const result = await boundary.run({ acquisition: { ...initial, managedId: 'paid' }, setupRecovery: 'delete',
            reviewDelete: async census => { reviewed.push(census); return true; } });
        expect(boundary.additionalConfirmations).toEqual([]);
        expect(result, JSON.stringify(result)).toEqual({ kind: 'delete_requested', managedId: 'paid' });
        // The deployment HTTP boundary is unavailable. Preserve the real
        // census's incompleteness in the Delete disclosure rather than inventing coverage.
        expect(reviewed).toEqual([{ homeId: 'home', machineId: 'guest', coverage: 'partial',
            references: [{ kind: 'machine_pool', id: '00000000-0000-4000-8000-000000000001', name: 'Guest pool' }], unavailable: ['deployments'] }]);
        expect(boundary.actions.filter(value => value.actionId === 'machines.managed.delete').map(value => value.input))
            .toEqual([{ homeId: 'home', managedId: 'paid', when: 'now', expectedRevision: 1,
                intent: 'delete', reviewedDependencies: true }]);
        expect(boundary.actions.some(value => ['machines.managed.acquire', 'machines.managed.bootstrap.retry',
            'machines.setup.apply', 'machines.managed.setup.skip'].includes(value.actionId))).toBe(false);
    });
    it('keeps failed-setup recovery when the Delete review is declined', async () => {
        const boundary = transport({ enrolled: true,
            machineSetup: { setup: { scripts: [{ body: 'echo ready' }] }, state: 'failed', errorCode: 'setup_failed' } });
        expect(await boundary.run({ acquisition: { ...initial, managedId: 'paid' }, setupRecovery: 'delete',
            reviewDelete: async () => false })).toEqual({ kind: 'failed', code: 'setup_failed' });
        expect(boundary.actions.some(value => value.actionId === 'machines.managed.delete')).toBe(false);
        expect(boundary.progress).toContainEqual(expect.objectContaining({ kind: 'failed', retrySetupAvailable: true }));
    });
    it('requires a fresh Delete review when the retained row intent changes during confirmation', async () => {
        const boundary = transport({ enrolled: true,
            machineSetup: { setup: { scripts: [{ body: 'echo ready' }] }, state: 'failed', errorCode: 'setup_failed' } });
        expect(await boundary.run({ acquisition: { ...initial, managedId: 'paid' }, setupRecovery: 'delete',
            reviewDelete: async () => { boundary.changeIntentRevision(2); return true; } }))
            .toEqual({ kind: 'failed', code: 'intent_changed' });
        expect(boundary.actions.some(value => value.actionId === 'machines.managed.delete')).toBe(false);
        expect(boundary.progress).toContainEqual(expect.objectContaining({ kind: 'failed', retrySetupAvailable: true }));
    });
    it('rejoins the retained acquisition while an enrolled target awaits setup without a guest operation', async () => {
        const boundary = transport({ enrolled: true, setupSucceeds: true,
            machineSetup: { setup: { scripts: [{ body: 'echo ready' }] }, state: 'pending' } });
        expect(await boundary.run({ acquisition: { ...initial, managedId: 'paid', operation: { operationId: 'install' } } }))
            .toMatchObject({ kind: 'enrolled', machine: { id: 'paid', enrolledMachineId: 'guest', machineSetup: { state: 'succeeded' } } });
        expect(boundary.actions.some(value => value.actionId === 'machines.managed.acquire')).toBe(false);
    });
    it('holds the enrolled target until setup succeeds or is explicitly skipped without reacquisition', async () => {
        for (const state of ['pending', 'running', 'failed', 'succeeded', 'skipped'] as const) {
            const boundary = transport({ enrolled: true, machineSetup: { setup: { scripts: [{ body: 'echo ready' }] }, state,
                ...(state === 'failed' ? { errorCode: 'setup_failed' } : {}) } });
            const result = await boundary.run({ acquisition: { ...initial, managedId: 'paid' } });
            expect(result.kind).toBe(state === 'succeeded' || state === 'skipped' ? 'enrolled' : state === 'failed' ? 'failed' : 'pending');
            if (state === 'pending' || state === 'running') expect(boundary.progress).toContainEqual(expect.objectContaining({ kind: 'setup_pending', state }));
            if (state === 'failed') expect(boundary.progress).toContainEqual(expect.objectContaining({ kind: 'failed',
                code: 'setup_failed', retrySetupAvailable: true, machineSetup: expect.objectContaining({ state: 'failed' }) }));
            expect(boundary.actions.map(value => value.actionId)).not.toContain('machines.managed.acquire');
        }
    });
    it('retries the admitted preset setup on the joined machine and waits its operation before returning the target', async () => {
        const setup = MachineSetupV1Schema.parse({ scripts: [{ body: '\r\necho ready\r\n', affects: 'none',
            check: { executable: 'test', args: ['-f', '/tmp/ready'], unsatisfiedExitCodes: [1] } }],
            toolchain: { adapterId: 'mise' as const, config: '\r\n[tools]\r\n' },
            secretRefs: { v: 1, bindings: { TOKEN: { ref: formatSharedSavedSecretRefV1('shared-build-token'), revision: 3 } } } });
        const boundary = transport({ enrolled: true, machineSetup: { setup, state: 'failed', errorCode: 'setup_failed' } });
        const result = await boundary.run({ acquisition: { ...initial, managedId: 'paid' }, setupRecovery: 'retry' });
        expect(result, JSON.stringify(result))
            .toMatchObject({ kind: 'enrolled', machine: { id: 'paid', machineSetup: { state: 'succeeded' } } });
        expect(boundary.actions.filter(value => value.actionId === 'machines.setup.apply').map(value => value.input))
            .toMatchObject([{ homeId: 'home', machineId: 'guest', targets: [{ homeId: 'home', machineId: 'guest', sources: [
                { kind: 'accountPresetOpaque', presetId: 'other', presetRevision: 1, contentEncryptionMode: 'plain' },
                { kind: 'accountPresetOpaque', presetId: 'preset', presetRevision: 4, contentEncryptionMode: 'plain' },
                { kind: 'direct', setup: { scripts: [{ body: '\r\necho direct\r\n' }] } },
            ] }] }]);
        expect(boundary.actions.filter(value => value.actionId === 'machines.setup.plan').map(value => value.input))
            .toEqual([{ homeId: 'home', machineId: 'guest' }, { homeId: 'home', machineId: 'guest', mode: 'effects', sources: [
                { kind: 'accountPresetOpaque', presetId: 'other', presetRevision: 1, contentEncryptionMode: 'plain' },
                { kind: 'accountPresetOpaque', presetId: 'preset', presetRevision: 4, contentEncryptionMode: 'plain' },
                { kind: 'direct', setup: { scripts: [{ body: '\r\necho direct\r\n' }] } },
            ] }]);
        expect(boundary.actions.find(value => value.actionId === 'action.operations.get')?.input)
            .toMatchObject({ machineId: 'guest', operationId: 'setup', waitForTerminal: true });
        expect(boundary.actions.some(value => value.actionId === 'machines.managed.acquire' || value.actionId === 'machines.managed.bootstrap.retry')).toBe(false);
    });
    it('continues only after the ordinary skip Action records setup skipped on the same creation row', async () => {
        const boundary = transport({ enrolled: true, machineSetup: { setup: { scripts: [{ body: 'echo ready' }] }, state: 'failed', errorCode: 'setup_failed' } });
        const result = await boundary.run({ acquisition: { ...initial, managedId: 'paid' }, setupRecovery: 'skip' });
        expect(result, JSON.stringify(result))
            .toMatchObject({ kind: 'enrolled', machine: { id: 'paid', machineSetup: { state: 'skipped' } } });
        expect(boundary.actions.find(value => value.actionId === 'machines.managed.setup.skip')?.input)
            .toEqual({ homeId: 'home', managedId: 'paid', expectedIntentRevision: 1 });
        expect(boundary.actions.some(value => value.actionId === 'machines.setup.apply' || value.actionId === 'machines.managed.acquire')).toBe(false);
    });
    it('observes the admitted retry running on its actual row while its guest operation is still pending', async () => {
        const waiting = createDeferred<void>();
        const finish = createDeferred<void>();
        const boundary = transport({ enrolled: true, wait: () => { waiting.resolve(); return finish.promise; },
            machineSetup: { setup: { scripts: [{ body: 'echo ready' }] }, state: 'failed', errorCode: 'setup_failed' } });
        const run = boundary.run({ acquisition: { ...initial, managedId: 'paid' }, setupRecovery: 'retry' });
        await waiting.promise;
        const progressWhilePending = boundary.progress.slice();
        finish.resolve();
        await run;
        expect(progressWhilePending).toContainEqual(expect.objectContaining({ kind: 'setup_pending', state: 'running',
            machineSetup: expect.objectContaining({ state: 'running', operation: { operationId: 'setup' } }) }));
    });
    it('offers setup recovery after a newly admitted creation joins but its setup stage fails', async () => {
        const boundary = transport({ setupFails: true,
            machineSetup: { setup: { scripts: [{ body: 'echo ready' }] }, state: 'pending' } });
        expect(await boundary.run()).toEqual({ kind: 'failed', code: 'setup_failed' });
        expect(boundary.progress).toContainEqual(expect.objectContaining({ kind: 'failed', managedId: 'paid',
            machineSetup: expect.objectContaining({ state: 'failed' }), retrySetupAvailable: true, retryInstallationAvailable: false }));
    });
    it('retains the offered archive Delete choice on a shared controller without creating a FIN trigger', async () => {
        const created = transport({ custodianAccountId: 'alice' });
        const creation = await created.run({ draft: { ...draft, archiveEffect: 'delete' } });
        expect(creation)
            .toMatchObject({ kind: 'enrolled', machine: { enrolledMachineId: 'guest' } });
        expect(created.actions.find(action => action.actionId === 'machines.managed.acquire')?.input)
            .toMatchObject({ creationScopeRetention: { effect: 'delete' } });
        const boundary = bindingTransport({ custodianAccountId: 'alice', retainedEffect: 'delete' });
        expect(await bindNewManagedMachineCreationScope({ draft: { ...draft, archiveEffect: 'delete' },
            machine: boundary.machine,
            source: { kind: 'session', sessionId: 'created-session' }, scope: { serverId: 'server', accountId: 'account' },
            signal: new AbortController().signal, isCurrent: () => true, executeAction: boundary.executeAction }))
            .toMatchObject({ kind: 'bound' });
        expect(boundary.rows.size).toBe(0);
    });

    it.each(['stop', 'delete'] as const)('reads the admitted %s choice without a FIN workflow', async effect => {
        const boundary = bindingTransport({ retainedEffect: effect });
        const result = await bindNewManagedMachineCreationScope({ draft: { ...draft, archiveEffect: effect }, machine: boundary.machine,
            source: { kind: 'session', sessionId: 'created-session' }, scope: { serverId: 'server', accountId: 'account' },
            signal: new AbortController().signal, isCurrent: () => true, executeAction: boundary.executeAction });
        expect(result).toMatchObject({ kind: 'bound', binding: { source: { kind: 'session', sessionId: 'created-session' } } });
        expect(boundary.rows.size).toBe(0);
        expect(boundary.confirmations).toEqual([]);
    });

    it('Keep writes no rule, and a retired creation cannot write a selected rule', async () => {
        const boundary = bindingTransport();
        const input = { draft, machine: boundary.machine, source: { kind: 'session' as const, sessionId: 'created-session' },
            scope: { serverId: 'server', accountId: 'account' }, signal: new AbortController().signal,
            isCurrent: () => true, executeAction: boundary.executeAction };
        expect(await bindNewManagedMachineCreationScope(input)).toEqual({ kind: 'kept' });
        expect(boundary.rows.size).toBe(0);
        expect(await bindNewManagedMachineCreationScope({ ...input, draft: { ...draft, archiveEffect: 'stop' }, isCurrent: () => false }))
            .toEqual({ kind: 'incomplete', code: 'continuation_retired' });
        expect(boundary.rows.size).toBe(0);
    });

    it('rejoins the same selected binding and Keep clears it without a power effect', async () => {
        const boundary = bindingTransport();
        const input = { draft: { ...draft, archiveEffect: 'stop' as const }, machine: boundary.machine,
            source: { kind: 'session' as const, sessionId: 'created-session' }, scope: { serverId: 'server', accountId: 'account' },
            signal: new AbortController().signal, isCurrent: () => true, executeAction: boundary.executeAction };
        const bound = await bindNewManagedMachineCreationScope(input);
        expect(bound).toMatchObject({ kind: 'bound' });
        if (bound.kind !== 'bound') throw new Error('Expected selected binding');
        expect(await bindNewManagedMachineCreationScope(input)).toEqual(bound);
        expect(boundary.rows.size).toBe(0);
        expect(await bindNewManagedMachineCreationScope({ ...input, draft, existingBinding: bound.binding })).toEqual({ kind: 'kept' });
        expect([...boundary.rows.values()].flatMap(row => row.triggers)).toEqual([]);
    });

    it('keeps a failed retention edit visibly incomplete', async () => {
        const boundary = bindingTransport({ beforeWrite: async () => { throw Object.assign(new Error('Unknown transport delivery'), { code: 'outcome_unknown' }); } });
        const result = await bindNewManagedMachineCreationScope({ draft: { ...draft, archiveEffect: 'stop' }, machine: boundary.machine,
            source: { kind: 'session', sessionId: 'created-session' }, scope: { serverId: 'server', accountId: 'account' },
            signal: new AbortController().signal, isCurrent: () => true, executeAction: boundary.executeAction });
        expect(result).toMatchObject({ kind: 'incomplete' });
        expect(boundary.rows.size).toBe(0);
    });

    it('changes the Home choice and keeps FIN empty', async () => {
        const boundary = bindingTransport();
        const input = { machine: boundary.machine, source: { kind: 'session' as const, sessionId: 'created-session' },
            scope: { serverId: 'server', accountId: 'account' }, signal: new AbortController().signal,
            isCurrent: () => true, executeAction: boundary.executeAction };
        expect(await bindNewManagedMachineCreationScope({ ...input, draft: { ...draft, archiveEffect: 'stop' } })).toMatchObject({ kind: 'bound' });
        expect(await bindNewManagedMachineCreationScope({ ...input, draft: { ...draft, archiveEffect: 'delete' } })).toMatchObject({ kind: 'bound' });
        expect(boundary.machine.creationScopeRetention?.effect).toBe('delete');
        expect(boundary.rows.size).toBe(0);
    });

    it('admits a supported reviewed archive effect without binding before a Session exists', async () => {
        const boundary = transport();
        expect(await boundary.run({ draft: { ...draft, archiveEffect: 'stop' } })).toMatchObject({
            kind: 'enrolled', machine: { id: 'paid', enrolledMachineId: 'guest' },
        });
        expect(boundary.actions.filter(value => value.actionId === 'machines.managed.acquire')).toHaveLength(1);
        expect(boundary.actions.some(value => value.actionId === 'session.trigger.add')).toBe(false);
    });

    it('acquires only on explicit submission, waits installation, and reuses the paid reference after reload', async () => {
        const boundary = transport();
        expect(boundary.actions).toEqual([]);
        expect(await boundary.run()).toMatchObject({ kind: 'enrolled', machine: { id: 'paid', enrolledMachineId: 'guest' } });
        const reloaded = transport({ enrolled: true });
        expect(await reloaded.run({ acquisition: boundary.getAcquisition() })).toMatchObject({ kind: 'enrolled', machine: { id: 'paid' } });
        expect([...boundary.actions, ...reloaded.actions].filter(value => value.actionId === 'machines.managed.acquire')).toHaveLength(1);
        const acquire = boundary.actions.find(value => value.actionId === 'machines.managed.acquire')!;
        expect(acquire.input).not.toHaveProperty('agentStart');
    });

    it('retains the same resource across failed installation and explicit installation retry', async () => {
        const failed = transport({ failed: true });
        expect(await failed.run()).toEqual({ kind: 'failed', code: 'installation_failed' });
        expect(failed.getAcquisition().managedId).toBe('paid');
        expect(failed.progress).toContainEqual(expect.objectContaining({
            kind: 'failed', managedId: 'paid', retryInstallationAvailable: true,
            operation: expect.objectContaining({ operationId: 'install', state: 'failed' }),
        }));
        const retry = transport();
        expect(await retry.run({ acquisition: failed.getAcquisition(), retryInstallation: true })).toMatchObject({ kind: 'enrolled', machine: { id: 'paid' } });
        expect(retry.actions.filter(value => value.actionId === 'machines.managed.acquire')).toEqual([]);
        expect(retry.actions.find(value => value.actionId === 'machines.managed.bootstrap.retry')?.input).toEqual({ homeId: 'home', managedId: 'paid', expectedIntentRevision: 1 });
    });

    it('retires a replaced local continuation even when its original operation later enrolls', async () => {
        const waiting = createDeferred<void>();
        let current = true;
        const boundary = transport({ current: () => current, wait: () => waiting.promise });
        const pending = boundary.run();
        await expect.poll(() => boundary.actions.some(value => value.actionId === 'action.operations.get')).toBe(true);
        current = false;
        waiting.resolve();
        expect(await pending).toEqual({ kind: 'failed', code: 'continuation_retired' });
        expect(boundary.getAcquisition().managedId).toBe('paid');
        expect(boundary.progress.some(value => typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'ready')).toBe(false);
    });
});
