import { describe, expect, it } from 'vitest';
import type { AgentSessionConfigurationSnapshot, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentProviderRequirementsV1Schema } from '@happier-dev/protocol/providers/compatibility/v1';
import { AgentSessionConfigurationSnapshotV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { applyModelIntentSessionMetadata, createModelIntentV2MetadataCasCandidate } from '@happier-dev/agents/session/state/metadataWriters';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { serializeProviderBindingLaunchHandoffForEnv, HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY } from '@/plugins/runtime/providerBindings/handoff';
import { applyNativeAgentConfigurationUpdate } from './nativeAgentSession';
import {
    createNativeAgentRuntimeSessionPlanFixture, createNativeSessionClientTestPort,
    createExternalContributionFixtures, createLease, createSessionHostServiceOwners,
} from './nativeAgentSession.testkit';

const agentId = 'acme-model-choice';
const selection = { agentTargetKey: `backend:${agentId}`, providerConnectionId: null, modelId: 'custom/unlisted' } as const;

async function readOpenedConfiguration(metadata: Readonly<Record<string, unknown>>, launchSelection = false, providerBinding?: AgentSessionProviderBinding, delivery: 'factory' | 'late' = 'factory') {
    const contributions = createExternalContributionFixtures(agentId);
    const opens: AgentSessionOpenRequest[] = [];
    // The executable Agent is the external boundary; host configuration and Protocol parsing remain real.
    const nativeSession: AgentSessionRuntime = {
        send: async () => ({ status: 'admitted' }), watch: () => ({ dispose() {} }), dispose: async () => undefined,
    };
    const plan = await createNativeAgentRuntimeSessionPlanFixture({
        runtime: { sessions: { open: async request => { opens.push(request); return nativeSession; } } },
        lease: createLease(agentId), backend: contributions.backend,
        agent: { ...contributions.agent, richDefinition: { ...contributions.agent.richDefinition,
            definition: { ...contributions.agent.richDefinition.definition,
                providerRequirements: AgentProviderRequirementsV1Schema.parse({
                    acceptsProtocols: ['openai-responses'], required: {},
                    credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
                    authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
                    materialization: 'spawnEnv', applyPolicy: 'next_prompt', supportsFreeformModelIds: true,
                }),
            },
        } },
        createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        sessionInput: buildPluginSessionBindingInput({
            credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } },
            directory: '/tmp/model-choice', backendTarget: { kind: 'backend', backendId: agentId },
            ...(launchSelection ? { modelSelection: { v: 1, updatedAt: 7, ref: selection } } : {}),
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
    const created = await plan.config.createSessionRuntime({
        directory: '/tmp/model-choice', metadata, machineId: 'machine-1',
        session: createNativeSessionClientTestPort('model-choice'), transcriptSession: {}, messageBuffer: {},
        mcpServers: {}, permissionHandler: {}, getPermissionMode: () => 'default', setThinking: () => undefined,
        memoryRecallGuidanceEnabled: false,
        ...(delivery === 'factory' && providerBinding ? { providerBinding } : {}),
    } as never);
    try {
        expect(opens).toHaveLength(1);
        if (providerBinding) expect(opens[0]!.providerBinding).toEqual(providerBinding);
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
        expect((await readOpenedConfiguration({}, true, binding, delivery)).model.value).toBe(selection.modelId);
    });
    it('preserves an exact target-qualified launch choice as explicit', async () => {
        expect((await readOpenedConfiguration({}, true)).model).toEqual({
            value: selection.modelId, updatedAtMs: 7, selectionSource: 'explicit',
        });
    });

    it('preserves the real model-intent writer output as an explicit choice', async () => {
        const metadata = applyModelIntentSessionMetadata({}, { selection, updatedAt: 9 });
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
        const metadata = applyModelIntentSessionMetadata({}, { selection, updatedAt: 9 });
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
