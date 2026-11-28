import { describe, expect, it } from 'vitest';
import type { AgentSessionConfigurationSnapshot, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionTeamCredentialBindingIntentV1 } from '@happier-dev/protocol';
import { AgentProviderRequirementsV1Schema } from '@happier-dev/protocol/providers/compatibility/v1';
import { AgentSessionConfigurationSnapshotV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { applyModelIntentSessionMetadata, createModelIntentV2MetadataCasCandidate } from '@happier-dev/agents/session/state/metadataWriters';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { serializeProviderBindingLaunchHandoffForEnv, HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY } from '@/plugins/runtime/providerBindings/handoff';
import { applyNativeAgentConfigurationUpdate } from './nativeAgentSession';
import {
    createNativeAgentRuntimeSessionPlanFixture, createNativeSessionClientTestPort,
    createExternalContributionFixtures, createLease, createSessionHostServiceOwners,
} from './nativeAgentSession.composed.testkit';

const agentId = 'acme-model-choice';
const selection = { agentTargetKey: `backend:${agentId}`, providerConnectionId: null, modelId: 'custom/unlisted' } as const;

async function readOpenedConfiguration(metadata: Readonly<Record<string, unknown>>, launchSelection = false, providerBinding?: AgentSessionProviderBinding, delivery: 'factory' | 'late' | 'team' | 'attached-team' = 'factory', replaceTeamModel: boolean | 'revision' | 'clear' = false) {
    const contributions = createExternalContributionFixtures(agentId);
    const teamBinding: SessionTeamCredentialBindingIntentV1 = {
        v: 1, slot: { kind: 'provider_model' }, resourceId: 'shared-resource',
        expectedResourceRevision: 3, deliveryMode: 'brokered', teamId: 'shared-team',
    };
    const opens: AgentSessionOpenRequest[] = [];
    let acceptedBinding: SessionTeamCredentialBindingIntentV1 | null | undefined;
    let observedModelId = providerBinding?.model.id ?? selection.modelId;
    let admittedModelId = providerBinding?.model.id;
    const modelListeners = new Set<() => void>();
    // The executable Agent is the external boundary; host configuration and Protocol parsing remain real.
    const nativeSession: AgentSessionRuntime = {
        send: async () => ({ status: 'admitted' }), watch: () => ({ dispose() {} }), dispose: async () => undefined,
        updateConfiguration: async request => {
            const nextModelId = request.providerBinding?.model.id ?? admittedModelId;
            if (nextModelId && request.model.value !== nextModelId) throw new Error('Bound model configuration is not selectable');
            admittedModelId = nextModelId;
            return { status: 'applied', changed: ['model'] };
        },
    };
    const plan = await createNativeAgentRuntimeSessionPlanFixture({
        runtime: { sessions: { open: async (request, context) => {
            if (request.providerBinding && request.configuration?.model.value !== request.providerBinding.model.id) {
                throw new Error('Bound model configuration is not selectable');
            }
            if (request.providerBinding) context.session.services.models.bind({
                read: () => ({ models: [], catalogConfidence: 'account_unverified', currentModelId: observedModelId }),
                subscribe(listener) { const publish = () => listener({ models: [], catalogConfidence: 'account_unverified', currentModelId: observedModelId });
                    modelListeners.add(publish); publish(); return { dispose: () => { modelListeners.delete(publish); } }; },
            });
            opens.push(request); return nativeSession;
        } } },
        lease: createLease(agentId), backend: contributions.backend,
        agent: { ...contributions.agent, richDefinition: { ...contributions.agent.richDefinition,
            definition: { ...contributions.agent.richDefinition.definition,
                capabilities: { sessions: { ...contributions.agent.richDefinition.definition.capabilities.sessions, configuration: true } },
                providerRequirements: AgentProviderRequirementsV1Schema.parse({
                    acceptsProtocols: ['openai-responses'], required: {},
                    credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
                    authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
                    materialization: 'spawnEnv', applyPolicy: 'next_prompt', supportsFreeformModelIds: true,
                }),
            },
        } },
        createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        // Runner credential materialization crosses a process boundary; the native host path stays real.
        ...(providerBinding && (delivery === 'team' || delivery === 'attached-team') ? {
            prepareTeamCredentialProviderBinding: async request => ({
                providerBinding: replaceTeamModel
                    ? { ...providerBinding, model: { ...providerBinding.model, id: request.modelId },
                        source: { kind: 'team_resource', resourceId: request.resourceId, resourceRevision: request.expectedResourceRevision } }
                    : providerBinding,
                environmentOverlay: [], additionalRedactionValues: [], cleanup: () => undefined,
            }),
        } : {}),
        sessionInput: buildPluginSessionBindingInput({
            credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } },
            directory: '/tmp/model-choice', backendTarget: { kind: 'backend', backendId: agentId },
            ...(launchSelection ? { modelSelection: { v: 1, updatedAt: 7, ref: selection } } : {}),
            ...(delivery === 'team' ? { teamCredentialBindings: [teamBinding] } : {}),
            ...(delivery === 'attached-team' ? {
                existingSessionId: 'model-choice', sessionAttachSecret: { encryptionMode: 'plain', snapshot: {
                    metadata: {}, metadataVersion: 1, agentState: null, agentStateVersion: 0,
                    acceptedTeamCredentialBinding: teamBinding,
                } },
            } : {}),
            ...(delivery === 'late' && providerBinding ? {
                resolveLateEnvironment: async () => ({
                    environmentVariables: { [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
                        serializeProviderBindingLaunchHandoffForEnv({ v: 1, selection,
                            providerBinding, materialization: providerBinding.materialization }) },
                    unsetEnvironmentVariables: [], sensitiveEnvironmentVariableNames: [],
                }),
            } : {}),
        }),
    });
    if (!plan.config.createSessionRuntime) throw new Error('Expected native Session factory');
    const sessionClient = createNativeSessionClientTestPort('model-choice', {
        getAcceptedTeamCredentialBinding: () => acceptedBinding,
    });
    const created = await plan.config.createSessionRuntime({
        directory: '/tmp/model-choice', metadata, machineId: 'machine-1',
        session: sessionClient, transcriptSession: {}, messageBuffer: {},
        mcpServers: {}, permissionHandler: {}, getPermissionMode: () => 'default', setThinking: () => undefined,
        memoryRecallGuidanceEnabled: false,
        ...(delivery === 'factory' && providerBinding ? { providerBinding } : {}),
    } as never);
    try {
        expect(opens).toHaveLength(1);
        if (replaceTeamModel) {
            const nextModelId = 'muse-spark-1.3';
            const expectedResourceRevision = replaceTeamModel === 'revision' ? 4 : 3;
            const candidate = createModelIntentV2MetadataCasCandidate({ selection: { v: 2, updatedAt: 8, ref:
                replaceTeamModel === 'clear' ? { source: 'native', agentTargetKey: selection.agentTargetKey, modelId: nextModelId }
                : { source: 'team_resource', resourceId: 'shared-resource', teamId: 'shared-team',
                    expectedResourceRevision, deliveryMode: 'brokered',
                    agentTargetKey: selection.agentTargetKey, modelId: nextModelId,
                },
            } });
            await sessionClient.updateMetadata(candidate.update);
            if (replaceTeamModel === 'revision') acceptedBinding = { ...teamBinding, expectedResourceRevision };
            if (replaceTeamModel === 'clear') acceptedBinding = null;
            await created.operations.resetOrDisposeRuntime('runtime_recovery', { kind: 'create' });
            expect(opens).toHaveLength(2);
            expect(opens[1]!.configuration?.model.value).toBe(nextModelId);
            if (replaceTeamModel === 'clear') {
                expect(opens[1]).not.toHaveProperty('providerBinding');
                expect(created.operations.readAppliedTeamCredentialModel?.()).toBeNull();
                return AgentSessionConfigurationSnapshotV1Schema.parse(opens[1]!.configuration);
            }
            expect(opens[1]!.providerBinding).toMatchObject({ source: { ...providerBinding!.source, resourceRevision: expectedResourceRevision }, model: { id: nextModelId } });
            expect(created.operations.readAppliedTeamCredentialModel?.()).toMatchObject({
                resourceId: 'shared-resource', expectedResourceRevision, modelId: nextModelId,
            });
            return AgentSessionConfigurationSnapshotV1Schema.parse(opens[1]!.configuration);
        }
        if (providerBinding) {
            expect(opens[0]!.providerBinding).toEqual(providerBinding);
            expect(created.operations.models?.read().currentModelId).toBe(selection.modelId);
            let subscribedModelId: string | null | undefined;
            const subscription = created.operations.models?.subscribe(snapshot => { subscribedModelId = snapshot.currentModelId; });
            expect(subscribedModelId).toBe(selection.modelId);
            observedModelId = 'different-native-model';
            for (const publish of modelListeners) publish();
            expect(created.operations.models?.read().currentModelId).toBe(observedModelId);
            expect(subscribedModelId).toBe(observedModelId);
            subscription?.dispose();
            // Turn preparation re-applies durable intent without repeating the open binding.
            const outcome = await created.operations.updateSessionRuntimeConfig?.({ modelId: selection.modelId });
            expect(outcome?.status).toBe('applied');
            const permissionOutcome = await created.operations.updateSessionRuntimeConfig?.({ permissionMode: 'default' });
            expect(permissionOutcome?.status).toBe('applied');
            const rebound = await created.operations.updateSessionRuntimeConfig?.({ modelId: selection.modelId, providerBinding });
            expect(rebound?.status).toBe('applied');
            const replacementBinding = { ...providerBinding, model: { id: 'replacement', name: 'Replacement' } };
            expect((await created.operations.updateSessionRuntimeConfig?.({ modelId: 'custom/replacement',
                providerBinding: replacementBinding }))?.status).toBe('applied');
            expect((await created.operations.updateSessionRuntimeConfig?.({ modelId: 'custom/replacement' }))?.status).toBe('applied');
        }
        return AgentSessionConfigurationSnapshotV1Schema.parse(opens[0]!.configuration);
    } finally {
        await created.operations.resetOrDisposeRuntime();
    }
}

describe('native model selection provenance', () => {
    it.each(['factory', 'late'] as const)('delivers the admitted managed Connected Account binding through %s before native open', async delivery => {
        const binding: AgentSessionProviderBinding = {
            source: { kind: 'connected_account', purpose: { consumer: { pluginId: 'acme.agent', localId: 'agent' }, purpose: 'inference' },
                account: { service: { pluginId: 'acme.accounts', localId: 'accounts' }, accountId: 'selected-account' } },
            upstream: { protocol: 'openai-responses', normalizedUrl: 'http://127.0.0.1:8741/v1', credential: 'apiKey' },
            model: { id: 'unlisted', name: 'Selected model' }, materialization: { v: 1, kind: 'spawnEnv' },
        };
        expect((await readOpenedConfiguration({}, true, binding, delivery)).model.value).toBe(binding.model.id);
    });
    it.each(['team', 'attached-team'] as const)('projects the admitted Team model after %s custody before native open', async delivery => {
        const binding: AgentSessionProviderBinding = {
            source: { kind: 'team_resource', resourceId: 'shared-resource', resourceRevision: 3 },
            upstream: { protocol: 'openai-responses', normalizedUrl: 'http://127.0.0.1:8741/v1', credential: 'apiKey' },
            model: { id: 'unlisted', name: 'Selected model' }, materialization: { v: 1, kind: 'spawnEnv' },
        };
        expect((await readOpenedConfiguration({}, true, binding, delivery)).model).toEqual({
            value: binding.model.id, updatedAtMs: 7, selectionSource: 'explicit',
        });
    });
    it.each(['team', 'attached-team'] as const)('reopens %s custody with the new model through the native factory', async delivery => {
        const binding: AgentSessionProviderBinding = {
            source: { kind: 'team_resource', resourceId: 'shared-resource', resourceRevision: 3 },
            upstream: { protocol: 'openai-responses', normalizedUrl: 'http://127.0.0.1:8741/v1', credential: 'apiKey' },
            model: { id: selection.modelId, name: 'Selected model' }, materialization: { v: 1, kind: 'spawnEnv' },
        };
        expect((await readOpenedConfiguration({}, true, binding, delivery, true)).model.value).toBe('muse-spark-1.3');
    });
    it('clears the attached Team custody when the committed tuple explicitly has no accepted binding', async () => {
        const binding: AgentSessionProviderBinding = {
            source: { kind: 'team_resource', resourceId: 'shared-resource', resourceRevision: 3 },
            upstream: { protocol: 'openai-responses', normalizedUrl: 'http://127.0.0.1:8741/v1', credential: 'apiKey' },
            model: { id: selection.modelId, name: 'Selected model' }, materialization: { v: 1, kind: 'spawnEnv' },
        };
        expect((await readOpenedConfiguration({}, true, binding, 'attached-team', 'clear')).model.value).toBe('muse-spark-1.3');
    });
    it.each(['team', 'attached-team'] as const)('reopens %s custody using the newly admitted Team revision', async delivery => {
        const binding: AgentSessionProviderBinding = {
            source: { kind: 'team_resource', resourceId: 'shared-resource', resourceRevision: 3 },
            upstream: { protocol: 'openai-responses', normalizedUrl: 'http://127.0.0.1:8741/v1', credential: 'apiKey' },
            model: { id: selection.modelId, name: 'Selected model' }, materialization: { v: 1, kind: 'spawnEnv' },
        };
        expect((await readOpenedConfiguration({}, true, binding, delivery, 'revision')).model.value).toBe('muse-spark-1.3');
    });
    it('preserves an exact target-qualified launch choice as explicit', async () => {
        expect((await readOpenedConfiguration({}, true)).model).toEqual({
            value: selection.modelId, updatedAtMs: 7, selectionSource: 'explicit',
        });
    });

    it('preserves the real model-intent writer output as an explicit choice', async () => {
        const metadata = applyModelIntentSessionMetadata({}, { v: 1, selection, updatedAt: 9 });
        expect((await readOpenedConfiguration(metadata)).model).toEqual({
            value: selection.modelId, updatedAtMs: 9, selectionSource: 'explicit',
        });
    });

    it('keeps an unqualified retained model inherited regardless of its nonzero timestamp', async () => {
        expect((await readOpenedConfiguration({ modelOverrideV1: { v: 1, modelId: 'foreign-model', updatedAt: 999 } })).model).toEqual({
            value: 'foreign-model', updatedAtMs: 999, selectionSource: 'inherited',
        });
    });

    it('keeps the effective legacy override inherited when it supersedes a canonical native choice', async () => {
        const metadata = applyModelIntentSessionMetadata({}, { v: 1, selection, updatedAt: 9 });
        expect((await readOpenedConfiguration({ ...metadata,
            modelOverrideV1: { v: 1, modelId: 'foreign-model', updatedAt: 999 },
        })).model).toEqual({ value: 'foreign-model', updatedAtMs: 999, selectionSource: 'inherited' });
    });

    it('preserves a real V2 native choice carried by the matching qualified launch selection', async () => {
        const candidate = createModelIntentV2MetadataCasCandidate({ selection: {
            v: 2, updatedAt: 7, ref: { source: 'native', agentTargetKey: selection.agentTargetKey, modelId: selection.modelId },
        }, nowMs: () => 7 });
        expect((await readOpenedConfiguration(candidate.update({}), true)).model).toEqual({
            value: selection.modelId, updatedAtMs: 7, selectionSource: 'explicit',
        });
    });

    it('keeps an effective legacy override inherited even when historical V2 names the same model', async () => {
        const candidate = createModelIntentV2MetadataCasCandidate({ selection: {
            v: 2, updatedAt: 7, ref: { source: 'native', agentTargetKey: selection.agentTargetKey, modelId: selection.modelId },
        }, nowMs: () => 7 });
        expect((await readOpenedConfiguration({ ...candidate.update({}),
            modelOverrideV1: { v: 1, modelId: selection.modelId, updatedAt: 999 },
        }, true)).model).toEqual({ value: selection.modelId, updatedAtMs: 999, selectionSource: 'inherited' });
    });

    it('retains provenance on unrelated configuration updates and defaults unqualified model mutations to inherited', () => {
        const current: AgentSessionConfigurationSnapshot = {
            mode: { value: null, updatedAtMs: 0 }, model: { value: 'old', updatedAtMs: 999 },
            permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {},
        };
        const explicit = { modelId: selection.modelId, modelSelectionSource: 'explicit' as const };
        const first = applyNativeAgentConfigurationUpdate(current, explicit);
        expect(first.request.model).toMatchObject({ value: selection.modelId, selectionSource: 'explicit' });
        expect(applyNativeAgentConfigurationUpdate(first.snapshot, { modeId: 'ask' }).snapshot.model).toEqual(first.snapshot.model);
        expect(applyNativeAgentConfigurationUpdate(current, { modelId: 'foreign-model' }).request.model)
            .toMatchObject({ value: 'foreign-model', selectionSource: 'inherited' });
    });
});
