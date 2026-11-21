import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { createAccountWorkflowTriggerActions } from '@happier-dev/protocol/actions';

import type { AutomationDefinitionDetail } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationTriggerDetailSchema } from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { createActionAutomationPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { answerApprovalAutomaticConsentV1, createApprovalAutomaticChecksV1, readApprovalAutomaticSelectionV1 } from '@happier-dev/protocol/actions/executor/automaticApprovalContinuation';
import { createWorkflowActorConsentPortV1 } from '@happier-dev/protocol/actions/executor/workflowTriggerActions';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';

import type { RpcHandler } from '@/api/rpc/types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createWorkflowMaterializationHostV1 } from '@/session/actions/workflowMaterializationHost';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';
import { parseDaemonContributionRegistryProjectionDescribeResponse } from '../../../../ui/sources/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import { adaptDaemonContributionRegistryProjectionToMergedProjectionInputs } from '../../../../ui/sources/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';

const pluginId = 'acme.workflow-isolation';
const actionId = `${pluginId}/read`;
const machineId = 'workflow-machine';

describe('external Settings declarations and Workflow materialization', () => {
    let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>;
    beforeAll(async () => {
        const manifest = createPluginManifestV2Fixture({ id: pluginId, contributes: {
                actions: [{ id: 'read', title: 'Read', dangerLevel: 'safe', scopes: ['global'],
                    execution: { target: 'daemon' }, surfaces: ['cli', 'agent'],
                    inputSchema: { type: 'object', additionalProperties: false }, resultSchema: { type: 'string' } }],
                settings: [{ id: 'ambiguous', title: 'Ambiguous', target: { kind: 'plugin' }, scope: 'daemon',
                    fields: [{ id: 'limit', title: 'Limit', schema: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, default: null }] },
                { id: 'invalid-default', title: 'Invalid default', target: { kind: 'plugin' }, scope: 'daemon',
                    fields: [{ id: 'wrong-default', title: 'Default', schema: { type: 'boolean' }, default: 'true' }] },
                { id: 'invalid-pattern', title: 'Invalid pattern', target: { kind: 'plugin' }, scope: 'daemon',
                    fields: [{ id: 'wrong-pattern', title: 'Pattern', schema: { type: 'string', pattern: '[' } }] },
                ...Array.from({ length: 100 }, (_, index) => ({ id: `healthy-${index}`, title: 'Healthy',
                    target: { kind: 'plugin' }, scope: 'daemon',
                    fields: [{ id: `enabled-${index}`, title: 'Enabled', schema: { type: 'boolean' }, default: true }] }))],
            } });
        // Physical generation accepted by an earlier host. New admission must
        // still refuse it, while ordinary discovery isolates only bad groups.
        expect(ingestCanonicalPluginManifest(manifest, { sourceProvenance: 'localSource' }).ok).toBe(false);
        fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{
            manifest,
            files: { 'daemon.mjs': `export function activate(api) {
                api.actions.register('read', async (_input, context) => {
                    const settings = context.services.settings.forScope({ kind: 'daemon' });
                    await settings.set('enabled-0', false);
                    if (await settings.get('enabled-0') !== false) throw new Error('Settings roundtrip failed');
                    return 'ready';
                });
            }` },
        }],
        });
    });
    afterAll(async () => { await fixture?.dispose(); });

    function handlers(readServerIdentity: () => string | null = () => 'srv_workflow_home', settingsBound = true) {
        const result = new Map<string, RpcHandler>();
        registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { result.set(method, handler); } }, {
            resolveRuntimeRegistry: async () => settingsBound ? fixture.registry : {
                ...fixture.registry, createPluginSettingsService: undefined,
            },
            resolveGeneration: async () => fixture.registry.generation,
            resolveInstalledPackages: async () => [],
            resolveServerFeaturesSnapshot: () => undefined,
            resolvePluginProjectionExecutionOriginContext: () => {
                const serverIdentityId = readServerIdentity();
                return serverIdentityId ? { serverIdentityId, machineId } : null;
            },
        });
        return result;
    }

    it('excludes only the invalid Settings contribution with its typed author diagnostic in full and Settings reads', async () => {
        const describe = handlers().get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!;
        for (const selection of [undefined, 'settings'] as const) {
            const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await describe({ machineId, ...(selection ? { selection } : {}) }));
            expect(Object.keys(response.projection.settingsById)).toHaveLength(100);
            expect(response.projection.settingsById).not.toHaveProperty(`${pluginId}/ambiguous`);
            expect(response.projection.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
                plugin: { id: pluginId, version: '1.0.0', source: 'localPath' },
                contribution: { pluginId, localId: 'ambiguous' },
                data: expect.objectContaining({ code: 'PLUGIN_SETTINGS_PROJECTION_INVALID', severity: 'error',
                    details: expect.objectContaining({ fieldId: 'limit' }) }),
            })]));
            expect(response.projection.diagnostics).toEqual(expect.arrayContaining([
                expect.objectContaining({ contribution: { pluginId, localId: 'invalid-default' },
                    data: expect.objectContaining({ code: 'PLUGIN_SETTINGS_DEFAULT_INVALID', details: { fieldId: 'wrong-default' } }) }),
                expect.objectContaining({ contribution: { pluginId, localId: 'invalid-pattern' },
                    data: expect.objectContaining({ code: 'PLUGIN_SETTINGS_SCHEMA_INVALID', details: { fieldId: 'wrong-pattern' } }) }),
            ]));
            if (!selection) {
                expect(response.projection.actionsById[actionId]).toMatchObject({ pluginId, available: true });
                const client = parseDaemonContributionRegistryProjectionDescribeResponse(response);
                expect(client).not.toBeNull();
                const details = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(client!.projection).pluginProjectionById[pluginId];
                expect(details.editableSettingsGroups).toHaveLength(100);
                expect(details.actions).toHaveLength(1);
                expect(details.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
                    code: 'PLUGIN_SETTINGS_PROJECTION_INVALID', contribution: { pluginId, localId: 'ambiguous' },
                })]));
            }
        }
    });

    it.each([false, true])('serves healthy external Settings through activation and daemon Get/Set; missing binding refuses (%s)', async (miswired) => {
        await fixture.registry.activateContributionsOnDemand([{ pluginId, family: 'actions', localId: 'read' }]);
        expect(await fixture.registry.targetActionInvocations!.invoke({ pluginId, localId: 'read', input: {}, surface: 'cli' }))
            .toEqual({ status: 'executed', value: 'ready' });
        const routes = handlers(undefined, !miswired);
        const get = routes.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET)!;
        const set = routes.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET)!;
        const target = { serverIdentityId: 'srv_workflow_home', machineId,
            pluginId, scope: { kind: 'daemon' } };
        if (miswired) {
            await expect(get(target)).rejects.toMatchObject({ code: 'PLUGIN_SETTINGS_RUNTIME_UNAVAILABLE' });
            await expect(set({ ...target, fieldId: 'enabled-0', mutation: { kind: 'set', value: true } }))
                .rejects.toMatchObject({ code: 'PLUGIN_SETTINGS_RUNTIME_UNAVAILABLE' });
            return;
        }
        await expect(get({ ...target, serverIdentityId: 'srv_other_home' }))
            .rejects.toMatchObject({ code: 'plugin_settings_target_not_current' });
        expect(await get(target)).toMatchObject({ values: { 'enabled-0': false } });
        await expect(set({ ...target, fieldId: 'enabled-0', mutation: { kind: 'set', value: 'true' } }))
            .rejects.toMatchObject({ code: 'plugin_settings_validation_failed' });
        expect(await set({ ...target, fieldId: 'enabled-0', mutation: { kind: 'set', value: true } }))
            .toMatchObject({ status: 'applied', snapshot: { values: { 'enabled-0': true } } });
        await expect(set({ ...target, fieldId: 'wrong-default', mutation: { kind: 'set', value: true } }))
            .rejects.toMatchObject({ code: 'PLUGIN_SETTINGS_UNKNOWN_KEY' });
    });

    it('reads mounted caller and exact Action facts without constructing unrelated families', async () => {
        const describe = handlers().get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!;
        const occurrenceId = fixture.registry.readPluginOccurrenceId!(pluginId)!;
        const sourceCustody = fixture.registry.readPluginSourceCustody!(pluginId)!;
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await describe({
            machineId, selection: 'mountedActions',
            callers: [{ pluginId, occurrenceId, sourceCustody }],
            actions: [{ pluginId, localId: 'read' }],
        }));
        expect(Object.keys(response.projection.actionsById)).toEqual([actionId]);
        expect(response.projection.actionsById[actionId]).toMatchObject({ pluginId, occurrenceId,
            available: true, execution: { target: 'daemon' }, executionOrigin: { serverIdentityId: 'srv_workflow_home' } });
        expect(Object.keys(response.projection.installedPackagesById)).toEqual([pluginId]);
        expect(response.projection.settingsById).toEqual({});
        expect(response.projection.agentsById).toEqual({});
        expect(response.projection.familiesById).toEqual({});
        const client = parseDaemonContributionRegistryProjectionDescribeResponse(response)!;
        const facts = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(client.projection);
        expect(facts.pluginProjectionById[pluginId]?.actions).toHaveLength(1);
    });

    it('refuses a retired caller rather than projecting its selected Actions', async () => {
        const describe = handlers().get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!;
        await expect(describe({ machineId, selection: 'mountedActions',
            callers: [{ pluginId, occurrenceId: 'retired-caller', sourceCustody: fixture.registry.readPluginSourceCustody!(pluginId)! }],
            actions: [{ pluginId, localId: 'read' }],
        })).rejects.toMatchObject({ code: 'plugin_occurrence_stale' });
    });

    it('refreshes selected Action origins when authority changes within the same generation', async () => {
        let serverIdentityId: string | null = 'srv_workflow_home';
        const describe = handlers(() => serverIdentityId).get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!;
        const request = { machineId, selection: 'workflowMaterialization' };
        const read = async () => DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await describe(request));
        expect((await read()).projection.actionsById[actionId]?.executionOrigin).toMatchObject({ serverIdentityId });
        serverIdentityId = 'srv_workflow_replacement';
        expect((await read()).projection.actionsById[actionId]?.executionOrigin).toMatchObject({ serverIdentityId });
        serverIdentityId = null;
        expect((await read()).projection.actionsById[actionId]?.executionOrigin).toBeUndefined();
    });

    it.each([false, true])('materializes a canonical Action with only Agent/Action demand; missing schema transport propagates (%s)', async (miswired) => {
        const routes = handlers();
        if (miswired) routes.delete(RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ);
        const projectedCounts: number[] = [];
        const selections: unknown[] = [];
        const host = createWorkflowMaterializationHostV1({ credentials: { token: 'workflow-fixture', encryption: null },
            readRoleSelection: async () => ({}), readLaunchProfile: async () => null, readWorkflowDefinition: async () => null,
            // Daemon RPC is the boundary; registration, runtime lease, projection,
            // schema freezing and materialization all run through their real owners.
            callMachineAction: async ({ machineId: target, method, request }) => {
                expect(target).toBe(machineId);
                if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {} };
                const handler = routes.get(method);
                if (!handler) throw new Error('rpc_method_not_found');
                const response = await handler(request);
                if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                    selections.push(Reflect.get(request as object, 'selection'));
                    const { projection } = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(response);
                    projectedCounts.push(Object.keys(projection.agentsById).length + Object.keys(projection.actionsById).length
                        + Object.keys(projection.settingsById).length + Object.values(projection.familiesById)
                            .reduce((count, family) => count + Object.keys(family.entriesById).length, 0));
                    expect(projection.settingsById).toEqual({});
                    expect(projection.familiesById).toEqual({});
                    expect(projection.installedPackagesById).toEqual({});
                }
                return response;
            },
        });
        const target = { machineId, directory: '/repo' };
        const result = materializeWorkflowAcceptedSnapshotV1({ ...await host(target), admission: { kind: 'user' },
            definition: { version: 1, defaults: {}, blocks: [{ kind: 'action', id: 'read',
                actionId: formatQualifiedPluginActionId({ pluginId, localId: 'read' }), input: {} }] },
            context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
                workspaceTarget: { project: { ...target, checkoutRootPath: target.directory } },
                authorization: { principal: { kind: 'host' } } },
        });
        if (miswired) await expect(result).rejects.toThrow('rpc_method_not_found');
        else expect(await result).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ actionContract: {
                inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'string' },
            } }] } });
        expect(selections).toEqual(['workflowMaterialization']);
        expect(projectedCounts).toEqual([1]);
    });

    it('asks again for a newly attached contributed Action after an invocation-scoped Skip', async () => {
        const routes = handlers();
        const schemaReads: unknown[] = [];
        let occurrenceId: string | undefined;
        const project = { machineId, directory: '/repo' };
        const host = createWorkflowMaterializationHostV1({ credentials: { token: 'workflow-fixture', encryption: null },
            readRoleSelection: async () => ({}), readLaunchProfile: async () => null, readWorkflowDefinition: async () => null,
            callMachineAction: async ({ machineId: target, method, request }) => {
                expect(target).toBe(machineId);
                if (method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) schemaReads.push(request);
                const handler = routes.get(method);
                if (!handler) throw new Error(`Unexpected Machine method: ${method}`);
                const response = await handler(request);
                if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                    occurrenceId = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(response).projection.actionsById[actionId]?.occurrenceId;
                }
                return response;
            },
        });
        const childRef = '22222222-2222-4222-8222-222222222222';
        const rootWithPrompt = (text: string) => WorkflowDefinitionV1Schema.parse({ version: 1,
            defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
            blocks: [{ kind: 'step', id: 'review', document: { text, references: [], attachments: [] } }],
        });
        const child = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'plugin-review',
            actionId: formatQualifiedPluginActionId({ pluginId, localId: 'read' }), input: {} }] });
        let root = rootWithPrompt('Review the command.');
        let revision = 1;
        let stored: AutomationDefinitionDetail | null = null;
        const workflowReads: string[] = [];
        const actions = createAccountWorkflowTriggerActions({
            nativeAccount: { accountId: 'actor', serverId: 'home', isCurrent: async () => true },
            resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
            randomBytes: length => new Uint8Array(length), newId: kind => `${kind}-actor`,
            resolveWorkflow: async ref => {
                workflowReads.push(ref);
                return { definition: ref === childRef ? child : root, revision: { headerVersion: 1, bodyVersion: ref === childRef ? 1 : revision } };
            },
            openContext: async row => row.executionRecipe?.v === 2 && row.executionRecipe.workflow.t === 'plain' ? row.executionRecipe.workflow.v : null,
            sealContext: async ({ templateVersion, context }) => ({ v: 2, templateVersion,
                workflow: { t: 'plain', v: context }, triggerEvidence: null, managedTarget: null, visibleTeamId: null }),
            resolveMaterializer: host,
            automations: {
                get: async () => stored,
                list: async () => ({ automations: [], nextCursor: null }),
                listDetails: async () => ({ automations: [], nextCursor: null }),
                create: async input => {
                    stored = { id: input.automationId, name: input.name, description: input.description ?? null, enabled: input.enabled,
                        targetType: null, existingSessionId: null, templateVersion: 1, workflowDefinitionId: input.workflowDefinitionId ?? null,
                        scopeSessionId: null, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [], executionRecipe: input.executionRecipe,
                        triggers: input.triggers.map(item => AutomationTriggerDetailSchema.parse({ ...item.trigger,
                            id: item.triggerId, revision: 1, createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null })) };
                    return stored;
                },
                reconcile: async () => { throw new Error('Skip and changed steps must retain the existing consent row'); },
                delete: async () => ({ ok: true }),
            },
        });
        const subject = { kind: 'machine' as const, machineId, serverId: 'home' };
        const source = { automationId: 'source', triggerId: 'source-trigger', triggerRevision: 1, workflowId: 'root', workflowRevision: 1,
            ownerAccountId: 'author', actionIds: ['machines.command.run'], phase: 'before' as const, mode: 'wait' as const,
            reachesOthers: true, subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject, 'root') };
        const caller = { surface: 'cli' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
            runtimeAccountId: 'actor', serverId: 'home', actionRequestId: 'initial' };
        const admit = { ...caller, authority: 'account_automation' as const, externalActionTarget: subject };
        const consent = createWorkflowActorConsentPortV1({ accountId: 'actor', resolveProject: async () => project, actions });
        const consentTarget = { automationId: source.automationId, triggerId: source.triggerId };
        const saved = await consent.allowConsent({ selection: { ...source, subject, consent: { status: 'missing' } },
            context: caller, executionContext: admit, decisionInput: { artifactId: 'first', decision: 'approve',
                triggerConsent: { ...consentTarget, decision: 'allow' } } });
        const select = (context: typeof admit) => createActionAutomationPortV1({ accountId: 'actor',
            seed: async () => ({ v: 1, rows: [{ ...source, workflowRevision: revision }, saved] }), settle: async () => {},
        }).select({ actionId: source.actionIds[0]!, input: { command: 'printf checked' }, context, resolveConsent: consent.resolveConsent });

        root = rootWithPrompt('Inspect the command carefully.');
        revision = 2;
        const skipContext = { ...admit, actionRequestId: 'skip' };
        const review = createApprovalAutomaticChecksV1(await select(skipContext), false);
        expect(review.consents).toEqual([expect.objectContaining({ decision: 'pending', review: { reason: 'steps',
            changedSteps: [{ sourceKey: '$root', blockId: 'review' }] } })]);
        const skipped = await answerApprovalAutomaticConsentV1({ artifactId: 'skip', checks: review,
            answer: { ...consentTarget, decision: 'skip' }, context: caller, executionContext: skipContext });
        expect(skipped).toMatchObject({ consents: [{ decision: 'skip' }], notices: [{ reason: 'consentSkipped' }] });
        if ('ok' in skipped) throw new Error(skipped.errorCode);
        expect(readApprovalAutomaticSelectionV1({ automaticChecks: skipped })?.before).toEqual([]);
        expect(schemaReads).toEqual([]);

        root = WorkflowDefinitionV1Schema.parse({ ...root, blocks: [...root.blocks, { kind: 'workflow', id: 'child', workflowRef: childRef }] });
        revision = 3;
        workflowReads.length = 0;
        const next = createApprovalAutomaticChecksV1(await select({ ...admit, actionRequestId: 'renewed' }), false);
        expect(next).toMatchObject({ phase: 'consent', consents: [{ ...consentTarget, decision: 'pending', review: {
            reason: 'steps', changedSteps: [{ sourceKey: childRef, blockId: 'plugin-review' }, { sourceKey: '$root', blockId: 'review' }],
        } }] });
        expect(workflowReads).toEqual(['root', childRef]);
        expect(occurrenceId).toEqual(expect.any(String));
        expect(schemaReads).toEqual([{ machineId, qualifiedActionId: actionId, expectedOccurrenceId: occurrenceId }]);
    });
});
