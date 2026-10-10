import { describe, expect, it } from 'vitest';
import type { AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionTeamCredentialBindingIntentV1 } from '@happier-dev/protocol';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createNativeAgentRuntimeSessionPlan } from './nativeAgentSession';
import { createNativeSessionClientTestPort, createExternalContributionFixtures, createLease, createSessionHostServiceOwners } from './nativeAgentSession.testkit';

async function openSession(binding?: SessionTeamCredentialBindingIntentV1, connectedAccounts: NonNullable<AgentSessionOpenRequest['connectedAccounts']> = []) {
    const agentId = 'acme-applied-reader';
    const contributions = createExternalContributionFixtures(agentId);
    const nativeSession: AgentSessionRuntime = {
        send: async () => ({ status: 'admitted' }),
        watch: () => ({ dispose: () => undefined }), dispose: async () => undefined,
    };
    const plan = await createNativeAgentRuntimeSessionPlan({
        runtime: { sessions: { open: async () => nativeSession } },
        lease: createLease(agentId), backend: contributions.backend, agent: contributions.agent,
        createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        // Runner materialization is out-of-process custody, not a replacement of host logic.
        prepareTeamCredentialProviderBinding: async () => ({
            providerBinding: {
                source: { kind: 'team_resource', resourceId: 'opened-resource', resourceRevision: 3 },
                model: { id: 'team-model', name: 'Team model' },
                upstream: { protocol: 'openai-responses', normalizedUrl: 'https://provider.example/v1', credential: 'apiKey' },
                materialization: { v: 1, kind: 'spawnEnv' },
            },
            environmentOverlay: [], additionalRedactionValues: [], cleanup: () => undefined,
        }),
        sessionInput: buildPluginSessionBindingInput({
            credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } },
            directory: '/tmp/applied-reader', backendTarget: { kind: 'backend', backendId: agentId },
            resolveLateEnvironment: async () => ({
                environmentVariables: {}, unsetEnvironmentVariables: [], sensitiveEnvironmentVariableNames: [],
                sessionConnectedAccounts: connectedAccounts,
            }),
            ...(binding ? {
                modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: `backend:${agentId}`, providerConnectionId: null, modelId: 'team-model' } },
                teamCredentialBindings: [binding],
            } : {}),
        }),
    });
    if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
    const session = createNativeSessionClientTestPort('applied-reader');
    // The host factory's process/transport fixture is intentionally narrower than a full runner.
    const created = await plan.config.createSessionRuntime({
        directory: '/tmp/applied-reader', metadata: {}, machineId: 'machine-1', session,
        transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
        getPermissionMode: () => 'default', setThinking: () => undefined, memoryRecallGuidanceEnabled: false,
    } as never);
    return { created, session, agentId };
}

describe('native accepted-open applied selection', () => {
    it.each(['direct', 'brokered'] as const)('reads the opened %s Team identity without pending intent or private material', async (deliveryMode) => {
        const { created, session, agentId } = await openSession({
            v: 1, slot: { kind: 'provider_model' }, resourceId: 'opened-resource',
            expectedResourceRevision: 3, deliveryMode, teamId: 'opened-team',
        });
        try {
            expect.soft(created.operations.openedWithoutConnectedServices?.()).toBe(true);
            await session.updateMetadata((metadata) => ({ ...metadata, modelSelectionIntentV2: {
                kind: 'team_credential_provider_model', resourceId: 'pending-resource', teamId: 'pending-team',
                expectedResourceRevision: 4, deliveryMode, agentTargetKey: `backend:${agentId}`, modelId: 'pending-model',
            } }));
            expect(created.operations.readAppliedTeamCredentialModel?.()).toEqual({
                kind: 'team_credential_provider_model', resourceId: 'opened-resource', teamId: 'opened-team',
                expectedResourceRevision: 3, deliveryMode, agentTargetKey: `backend:${agentId}`, modelId: 'team-model',
            });
        } finally { await created.operations.resetOrDisposeRuntime(); }
        expect(created.operations.readAppliedTeamCredentialModel?.()).toBeUndefined();
        expect(created.operations.openedWithoutConnectedServices?.()).toBe(false);
    });

    it('distinguishes an opened native Session from an unavailable legacy Team identity', async () => {
        const native = await openSession();
        try {
            expect.soft(native.created.operations.openedWithoutConnectedServices?.()).toBe(true);
            expect(native.created.operations.readAppliedTeamCredentialModel?.()).toBeNull();
        } finally { await native.created.operations.resetOrDisposeRuntime(); }
        const legacyTeam = await openSession({ v: 1, slot: { kind: 'provider_model' },
            resourceId: 'opened-resource', expectedResourceRevision: 3, deliveryMode: 'brokered' });
        try {
            expect(legacyTeam.created.operations.readAppliedTeamCredentialModel?.()).toBeUndefined();
        } finally { await legacyTeam.created.operations.resetOrDisposeRuntime(); }
    });

    it('does not turn an accepted Connected Account into empty-route proof', async () => {
        const { created } = await openSession(undefined, [{
            purpose: 'primary', account: { service: { pluginId: 'acme.connected-account', localId: 'credential' }, accountId: 'account-a' },
        }]);
        try {
            expect(created.operations.openedWithoutConnectedServices?.()).toBe(false);
            expect(created.operations.readAppliedTeamCredentialModel?.()).toBeNull();
        } finally { await created.operations.resetOrDisposeRuntime(); }
    });
});
