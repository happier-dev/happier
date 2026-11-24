import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { convertBackendTargetRefV2ToV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { createRunnerExecutionRunProviderLaunchServices } from '@/daemon/agentRuntime/runnerExecutionRunProviderLaunch';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { ExecutionRunHostBridge } from '../ExecutionRunHostBridge';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { areExecutionRunBackendTargetsEqual } from '../backendTargets';

it.each([
    { workspaceWrites: undefined, runnerDeniesWrites: false, engineDeniesWrites: false, admitted: true },
    { workspaceWrites: 'deny', runnerDeniesWrites: true, engineDeniesWrites: false, admitted: false },
    { workspaceWrites: 'deny', runnerDeniesWrites: false, engineDeniesWrites: true, admitted: true },
] as const)('uses engine enforcement with a selected runner ($workspaceWrites, engine=$engineDeniesWrites, runner=$runnerDeniesWrites)', async ({ workspaceWrites, runnerDeniesWrites, engineDeniesWrites, admitted }) => {
    let requests = 0;
    const endpoint = createServer((request, response) => {
        if (request.headers.authorization !== 'Bearer runner-fixture-token') { response.writeHead(401).end(); return; }
        requests++;
        response.end('ready');
    });
    await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
    const address = endpoint.address();
    if (!address || typeof address === 'string') throw new Error('Expected endpoint address');
    const fixture = await createManagedRunLaunchFixture({ physicalGateway: true, reviewEngine: true,
        ...(runnerDeniesWrites ? { workspaceWrites: 'deny' } : {}),
        ...(engineDeniesWrites ? { engineWorkspaceWrites: 'deny' } : {}),
        agentIsolation: {
            requesterIdentity: selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'fixture-home',
                hostAccountAgent: { accountId: 'fixture-account', custodianAccountId: 'fixture-account',
                    machineId: 'fixture-machine', installationId: 'fixture-installation' } }),
            read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }),
        },
    });
    const resources = createProviderLaunchResourceScope();
    let acquisitions = 0;
    let released = 0;
    let manager: ExecutionRunHostBridge | undefined;
    try {
        const backendTarget = { kind: 'backend' as const, backendId: 'acme.managed-run/engine' };
        const runnerAgentTarget = { kind: 'agent' as const, identity: { pluginId: 'acme.managed-run', localId: 'agent' } };
        const descriptor = await resolveRunnerAgentSessionDescriptorForLease({ target: backendTarget, lease: fixture.lease });
        const binding = fixture.lease.registry.agentRuntimesByAgentId.get(backendTarget.backendId)?.sessionRunnerFactoryBinding;
        if (!descriptor || !binding) throw new Error('Expected admitted engine');
        const providerLaunch = createRunnerExecutionRunProviderLaunchServices({ agent: { descriptor, binding }, backendTarget,
            runtimeRegistryLease: fixture.lease, retainCleanup: resources.register,
            resolvePreparation: async () => ({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir,
                featureEnabled: true, accountSettingsSnapshot: fixture.snapshot, readCurrentnessRefusal: async () => null,
                resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
                // Managed endpoint acquisition is the external network/process boundary.
                prepareManagedEndpoint: async () => {
                    acquisitions++;
                    return { normalizedUrl: 'http://127.0.0.1:' + address.port, downstreamBearer: 'runner-fixture-token',
                        revalidateBeforeCommit: async () => ({ ok: true as const }), cleanup: async () => { released++; } };
                },
            }),
        });
        const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.lease.registry });
        const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({
            resolveAgentIdentity: () => ({ pluginId: 'acme.managed-run', localId: 'engine' }),
        });
        manager = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: fixture.happyHomeDir,
            happyHomeDir: fixture.happyHomeDir, machineId: fixture.machineId, sendAcp: async () => {},
            resolveProvidersFeatureEnabled: () => true, resolveAccountSettingsSnapshot: async () => fixture.snapshot,
            resolveExecutionRunProfileCatalog: async () => ({ profileCatalog, engineRegistry, providerLaunch }),
        });
        const started = await manager.start({ sessionId: null, intent: 'agent', backendTarget: convertBackendTargetRefV2ToV1(backendTarget),
            runnerAgentTarget,
            modelSelection: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' },
            accountSettings: fixture.snapshot.settings, instructions: 'Review with selected runner.', permissionMode: 'read_only',
            ...(workspaceWrites ? { workspaceWrites } : {}),
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', connectedServices: null,
        });
        await manager.waitForTerminal(started.runId);
        const completed = manager.getPublic(started.runId);
        expect(completed?.status, JSON.stringify(completed?.error)).toBe(admitted ? 'succeeded' : 'failed');
        if (!admitted) expect(completed?.error).toMatchObject({ code: 'role_policy_unenforceable' });
        expect(areExecutionRunBackendTargetsEqual(completed!.backendTarget, backendTarget)).toBe(true);
        expect(requests).toBe(admitted ? 1 : 0);
        expect(acquisitions).toBe(1);
        await manager.dispose();
        await resources.retire();
        expect(released).toBe(1);
    } finally {
        await manager?.dispose();
        await resources.retire();
        await fixture.cleanup();
        await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()));
    }
});
