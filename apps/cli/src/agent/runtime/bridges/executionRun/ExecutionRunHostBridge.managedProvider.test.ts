import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFailed, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { createExecutionRunManagedProviderEndpointPreparer } from './runtime/managedProvider';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createAccountConnectionManagedConsumerSourceOpen } from '@/providers/broker/accountConnectionSource';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';

const { directory, originalHome } = await vi.hoisted(async () => {
    const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
        import('node:fs/promises'), import('node:os'), import('node:path'),
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'happier-managed-run-host-'));
    const originalHome = process.env.HAPPIER_HOME_DIR;
    process.env.HAPPIER_HOME_DIR = join(directory, 'home');
    return { directory, originalHome };
});

it('opens the admitted managed source for the actual Run controller and consumes its isolated endpoint', async () => {
    let phase = 'committed Agent and Gateway fixture';
    onTestFailed(() => { console.info('managed Run host fixture phase:', phase); });
    const fixture = await createManagedRunLaunchFixture({ directory, controller: pluginReloadController, physicalGateway: true });
    const connectionId = ProviderConnectionIdSchema.parse('run-gateway');
    const otherConnectionId = ProviderConnectionIdSchema.parse('other-connection');
    let manager: InstanceType<typeof ExecutionRunHostBridge> | null = null;
    let sourceOpens = 0;
    let consumerClosed = false;
    let runSignal: AbortSignal | null = null;
    let endpointCleanup: (() => void | Promise<void>) | null = null;
    let differentProviderAuthority: ReturnType<ExecutionRunHostBridge['resolveLiveBrokerAuthority']> | null = null;
    try {
        phase = 'real engine registry';
        const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.lease.registry });
        const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({
            resolveAgentIdentity: () => ({ pluginId: 'acme.managed-run', localId: 'agent' }),
        });
        const purposeResolver = fixture.gateway!.purposeBindingOwner.resolveBindingIntent;
        const models = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
            happyHomeDir: fixture.happyHomeDir, registry: fixture.contributes, featureGate: { isEnabled: () => true },
            acquireRuntimeLease: async () => await acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: fixture.happyHomeDir }),
            modelSettingsMutation: async () => { throw new Error('Unexpected model mutation'); },
        });
        const prepareEndpoint = createExecutionRunManagedProviderEndpointPreparer({
          machineId: fixture.machineId, accountId: 'account', readAccountSettingsSnapshot: async () => fixture.snapshot,
          resolveManagedPurposeBindingIntent: purposeResolver,
          openSource: async ({ request: sourceRequest, signal, isCurrent }) => {
            runSignal = signal;
            const consumer = sourceRequest.consumer;
            if (consumer.kind !== 'execution_run') throw new Error('Expected Run consumer');
            const executionRunId = consumer.executionRunId;
            const executionRunOccurrenceId = sourceRequest.executionRunOccurrenceId;
            if (!executionRunOccurrenceId) throw new Error('Expected admitted Run occurrence');
            expect(await isCurrent()).toBe(true);
            expect(manager!.resolveLiveBrokerAuthority({ v: 1, executionRunId,
                expectedOccurrenceId: executionRunOccurrenceId })).toMatchObject({ status: 'current' });
            const otherProviderProof = { v: 1 as const, executionRunId,
                expectedOccurrenceId: executionRunOccurrenceId,
                expectedProviderConnectionModel: { agentId: fixture.agentId, agentTargetKey: fixture.agentTargetKey,
                    providerConnectionId: otherConnectionId, modelId: 'example' } };
            differentProviderAuthority = manager!.resolveLiveBrokerAuthority(otherProviderProof);
            expect(manager!.resolveLiveBrokerAuthority({ ...otherProviderProof,
                expectedProviderConnectionModel: { ...otherProviderProof.expectedProviderConnectionModel,
                    providerConnectionId: connectionId } })).toMatchObject({ status: 'current' });
            const open = createAccountConnectionManagedConsumerSourceOpen({ homeId: 'home', accountId: 'account', machineId: fixture.machineId,
                expectedAccountSettingsScopeKey: fixture.snapshot.scopeKey!, getAccountSettingsSnapshot: () => fixture.snapshot,
                custody: createManagedProviderExplicitStartCustody({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir,
                    controller: pluginReloadController }), withRegistry: async read => await read(fixture.contributes),
                resolveBindingIntent: purposeResolver,
                admitConsumer: async request => await isCurrent()
                    && request.executionRunOccurrenceId === executionRunOccurrenceId
                    && manager!.resolveLiveBrokerAuthority({ v: 1, executionRunId,
                        expectedOccurrenceId: executionRunOccurrenceId }).status === 'current',
                projectModels: async request => await models.projectModelsForAccount(request, {
                    getAccountSettingsSnapshot: () => fixture.snapshot, resolveManagedPurposeBindingIntent: purposeResolver, signal, isCurrent }),
            });
            const opened = await open({ ...sourceRequest, signal });
            expect(opened).not.toBeNull();
            if (!opened) throw new Error('Expected admitted Run source');
            sourceOpens++;
            return { ...opened, cleanup: async () => { await opened.cleanup(); consumerClosed = true; } };
          },
        });
        const prepareManagedEndpoint: NonNullable<ConstructorParameters<typeof ExecutionRunHostBridge>[0]['prepareManagedEndpoint']> = async input => {
            const endpoint = await prepareEndpoint(input);
            endpointCleanup = endpoint.cleanup;
            return endpoint;
        };
        const providerPorts = { prepareManagedEndpoint, resolveManagedPurposeBindingIntent: purposeResolver };
        manager = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: fixture.happyHomeDir,
            happyHomeDir: fixture.happyHomeDir, machineId: fixture.machineId, sendAcp: async () => {},
            resolveProvidersFeatureEnabled: () => true,
            resolveAccountSettingsSnapshot: async () => fixture.snapshot,
            resolveExecutionRunProfileCatalog: async () => ({ profileCatalog, engineRegistry }),
            ...providerPorts,
        });
        phase = 'Run start';
        const started = await manager.start({ sessionId: null, intent: 'agent',
            backendTarget: { kind: 'builtInAgent', agentId: fixture.agentId },
            modelSelection: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: connectionId, modelId: 'example' },
            accountSettings: fixture.snapshot.settings, instructions: 'Exercise the admitted Provider endpoint.',
            permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' });
        phase = 'terminal Run settlement';
        await manager.waitForTerminal(started.runId);
        expect(differentProviderAuthority).toMatchObject({ status: 'not_current', reason: 'identity_mismatch' });
        expect(manager.get(started.runId), JSON.stringify({ summary: manager.get(started.runId)?.summary,
            result: manager.getLatestToolResult(started.runId), sourceOpens })).toMatchObject({ status: 'succeeded' });
        expect(sourceOpens).toBe(1);
        expect(await readFile(join(directory, 'gateway-started'), 'utf8')).toMatch(/^\d+$/);
        expect(runSignal && (runSignal as AbortSignal).aborted).toBe(true);
        await (endpointCleanup as (() => void | Promise<void>) | null)?.();
        expect(consumerClosed).toBe(true);
        expect(manager.resolveLiveBrokerAuthority({ v: 1, executionRunId: started.runId, expectedOccurrenceId: null })).toMatchObject({ status: 'not_current', reason: 'terminal' });
    } finally {
        await manager?.dispose();
        await fixture.cleanup();
        vi.unstubAllEnvs();
        if (originalHome === undefined) delete process.env.HAPPIER_HOME_DIR;
        else process.env.HAPPIER_HOME_DIR = originalHome;
        await rm(directory, { recursive: true, force: true });
    }
}, 30_000);
