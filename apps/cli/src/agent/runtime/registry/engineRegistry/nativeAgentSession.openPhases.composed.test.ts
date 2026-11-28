import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntime, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentProviderRequirementsV1Schema } from '@happier-dev/protocol/providers/compatibility/v1';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import type { RetainedAgentRuntimePreparation } from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import { logger } from '@/ui/logger';
import {
    createExternalContributionFixtures,
    createLease,
    createNativeAgentRuntimeSessionPlanFixture,
    createNativeSessionClientTestPort,
    createSessionHostServiceOwners,
} from './nativeAgentSession.composed.testkit';

it('separates retained source loading from the actual factory call in the native open record', async () => {
    const agentId = 'acme-runtime-factory';
    const contributions = createExternalContributionFixtures(agentId);
    const diagnostic = vi.spyOn(logger, 'infoFile');
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const factoryPreparation = {
        startedAtMs: 1_000, bindingProofMs: 40, manifestProjectionMs: 2,
        moduleResolutionMs: 8, moduleLoadMs: 175, catalogProjectionMs: 25,
        loadMode: 'source-ts',
    } as const;
    const plan = await createNativeAgentRuntimeSessionPlanFixture({
        createRuntime: async (factoryInput: Readonly<{
            signal: AbortSignal;
            onFactoryInvoked?: (preparation?: RetainedAgentRuntimePreparation) => void;
        }>) => {
            clock.mockReturnValue(250);
            wallClock.mockReturnValue(1_250);
            factoryInput.onFactoryInvoked?.(factoryPreparation);
            clock.mockReturnValue(275);
            return { sessions: { open: async () => ({
                send: async () => ({ status: 'admitted' }),
                watch: () => ({ dispose() {} }),
                dispose: async () => undefined,
            }) } };
        },
        authorizeNewTurn: async () => ({ status: 'admitted' }),
        lease: createLease(agentId), backend: contributions.backend, agent: contributions.agent,
        createSessionHostServiceOwners,
        createInvocationServices: async () => createUnavailablePluginServices(),
        sessionInput: buildPluginSessionBindingInput({
            credentials: { token: 'runtime-factory-fixture', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            directory: '/tmp/runtime-factory',
            backendTarget: { kind: 'backend', backendId: agentId },
        }),
    });
    let created: Awaited<ReturnType<typeof plan.config.createSessionRuntime>> | undefined;
    try {
        created = await plan.config.createSessionRuntime({
            directory: '/tmp/runtime-factory', metadata: {}, machineId: 'machine-runtime-factory',
            session: createNativeSessionClientTestPort('session-runtime-factory'),
            transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
            getPermissionMode: () => 'default', setThinking: () => undefined, memoryRecallGuidanceEnabled: false,
        } as never);
        const factoryRecords = diagnostic.mock.calls.flatMap(([label, facts]) => (
            label === '[NativeAgentSession] Open phase' && facts && typeof facts === 'object'
                && Reflect.get(facts, 'phase') === 'runtime_factory' ? [facts] : []
        ));
        expect(factoryRecords).toEqual([expect.objectContaining({
            sessionId: 'session-runtime-factory', durationMs: 275,
            factoryInvokedAtMs: 1_250, factoryInvocationMs: 25,
            factoryPreparation,
        })]);
    } finally {
        await created?.operations.resetOrDisposeRuntime('session_closed');
        diagnostic.mockRestore();
        clock.mockRestore();
        wallClock.mockRestore();
    }
});

describe('native Session host-service phase attribution', () => {
    it.each(['completed', 'failed'] as const)('attributes the single awaited Team binding as %s without opening early or repeating it', async outcome => {
        const agentId = 'acme-host-services';
        const contributions = createExternalContributionFixtures(agentId);
        const diagnostic = vi.spyOn(logger, 'infoFile');
        const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
        const failure = new Error('binding unavailable');
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        let bindingRoundTrips = 0;
        const opened: AgentSessionOpenRequest[] = [];
        const nativeSession: AgentSessionRuntime = {
            send: async () => ({ status: 'admitted' }),
            watch: () => ({ dispose() {} }),
            dispose: async () => undefined,
        };
        const plan = await createNativeAgentRuntimeSessionPlanFixture({
            runtime: { sessions: { open: async request => { opened.push(request); return nativeSession; } } },
            lease: createLease(agentId), backend: contributions.backend,
            agent: {
                ...contributions.agent,
                richDefinition: {
                    ...contributions.agent.richDefinition,
                    definition: {
                        ...contributions.agent.richDefinition.definition,
                        providerRequirements: AgentProviderRequirementsV1Schema.parse({
                            acceptsProtocols: ['openai-responses'], required: {},
                            credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
                            authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['HOSTSERVLAT_REGION'] },
                            materialization: 'spawnEnv', applyPolicy: 'next_prompt', supportsFreeformModelIds: true,
                        }),
                    },
                },
            },
            createSessionHostServiceOwners,
            createInvocationServices: async () => createUnavailablePluginServices(),
            // The runner delegates this operation to the daemon over HTTP. Only that process boundary is supplied here.
            prepareTeamCredentialProviderBinding: async () => {
                bindingRoundTrips++;
                entered();
                await pending;
                if (outcome === 'failed') throw failure;
                return {
                    providerBinding: {
                        upstream: { protocol: 'openai-responses', normalizedUrl: 'https://provider.invalid/v1', credential: 'none' },
                        source: { kind: 'team_resource', resourceId: 'resource-host-services', resourceRevision: 3 },
                        model: { id: 'team-model', name: 'Team model' },
                        materialization: { v: 1, kind: 'spawnEnv' },
                    },
                    environmentOverlay: [{ name: 'HOSTSERVLAT_REGION', value: 'test-region', source: 'provider' }],
                    additionalRedactionValues: [], cleanup: () => undefined,
                };
            },
            sessionInput: buildPluginSessionBindingInput({
                credentials: { token: 'hostservlat-fixture', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
                directory: '/tmp/host-services',
                backendTarget: { kind: 'backend', backendId: agentId },
                teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-host-services',
                    teamId: 'team-host-services', expectedResourceRevision: 3, deliveryMode: 'direct' }],
                modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: `backend:${agentId}`,
                    providerConnectionId: null, modelId: 'team-model' } },
            }),
        });
        const phaseRecords = () => diagnostic.mock.calls.flatMap(([label, facts]) => (
            label === '[NativeAgentSession] Open phase' && facts && typeof facts === 'object' ? [facts] : []
        ));
        const phaseCount = (status: string) => phaseRecords().filter(facts => (
            Reflect.get(facts, 'phase') === 'team_provider_binding' && Reflect.get(facts, 'status') === status
        )).length;
        const opening = plan.config.createSessionRuntime({
            directory: '/tmp/host-services', metadata: {}, machineId: 'machine-host-services',
            session: createNativeSessionClientTestPort('session-host-services'),
            transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
            getPermissionMode: () => 'default', setThinking: () => undefined, memoryRecallGuidanceEnabled: false,
        } as never);
        // Attach the rejection observer before releasing the external operation.
        const settled = opening.then(value => ({ value }), error => ({ error }));
        let created: Awaited<typeof opening> | undefined;
        try {
            await Promise.race([started, settled.then(result => {
                if ('error' in result) throw result.error;
                throw new Error('Native open completed before its binding operation');
            })]);
            expect(bindingRoundTrips).toBe(1);
            expect(opened).toHaveLength(0);
            expect(phaseCount('started')).toBe(1);
            expect(phaseCount('completed')).toBe(0);
            clock.mockReturnValue(250);
            release();
            const result = await settled;
            if ('error' in result) {
                if (outcome === 'completed') throw result.error;
                expect(result.error).toBe(failure);
            } else {
                created = result.value;
                expect(outcome).toBe('completed');
                expect(opened).toHaveLength(1);
                expect(opened[0]?.launchEnvironment?.values.HOSTSERVLAT_REGION).toBe('test-region');
                expect(opened[0]?.providerBinding?.source).toEqual({ kind: 'team_resource',
                    resourceId: 'resource-host-services', resourceRevision: 3 });
                // The additive parent remains available; child durations must not reset its cursor.
                expect(phaseRecords().filter(facts => Reflect.get(facts, 'phase') === 'host_services')).toHaveLength(1);
                expect(phaseRecords().find(facts => Reflect.get(facts, 'phase') === 'host_services')).toMatchObject({
                    durationMs: 250, elapsedMs: 250,
                });
            }
            expect(bindingRoundTrips).toBe(1);
            expect(phaseCount(outcome)).toBe(1);
            expect(phaseRecords().find(facts => Reflect.get(facts, 'phase') === 'team_provider_binding'
                && Reflect.get(facts, 'status') === outcome)).toMatchObject({ durationMs: 250 });
            expect(phaseRecords().filter(facts => Reflect.get(facts, 'parentPhase') === 'host_services'
                && Reflect.get(facts, 'phase') === 'team_provider_binding')).toHaveLength(2);
        } finally {
            release();
            const result = await settled;
            if ('value' in result) created = result.value;
            await created?.operations.resetOrDisposeRuntime('session_closed');
            diagnostic.mockRestore();
            clock.mockRestore();
        }
    });
});
