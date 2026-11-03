import { afterAll, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { reloadConfiguration } from '@/configuration';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { createAuthoredAdmittedPluginRuntimeFixture, retireAdmittedPluginRuntimeRegistry } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { registerCapabilitiesHandlers } from './capabilities';
import { createFilesystemEffectAdmission } from './fileSystem/accessPolicy/filesystemEffectAdmission';

const environment = createEnvKeyScope(['HAPPIER_HOME_DIR']);
const fixtures: Array<Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>> = [];
const agentId = 'acme.project-launch/agent';
const requester: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true };

afterAll(async () => {
    for (const fixture of fixtures.reverse()) await fixture.dispose();
    await pluginReloadController.shutdown();
    environment.restore();
    reloadConfiguration();
});

async function setup(executeNativeRpc: NonNullable<Parameters<typeof createFilesystemEffectAdmission>[0]>['executeNativeRpc']) {
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        plugins: [createFirstConversationAgentFixture('FACTORY_PROJECTION')] });
    fixtures.push(fixture);
    environment.patch({ HAPPIER_HOME_DIR: fixture.happyHomeDir });
    reloadConfiguration();
    const handlers = new Map<string, RpcHandler>();
    registerCapabilitiesHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
        filesystemEffectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home', executeNativeRpc }),
    });
    // Warm the actual capability service before withdrawing its runtime.
    await handlers.get(RPC_METHODS.CAPABILITIES_DESCRIBE)!({});
    return { fixture, detect: handlers.get(RPC_METHODS.CAPABILITIES_DETECT)! };
}

it('releases projected factory custody before requester work can delay registry disposal', async () => {
    const { fixture, detect } = await setup(async request => {
        expect(request.context.capabilitySessionFactories).toEqual({ [agentId]: { nativeAuthenticationRequired: false } });
        await retireAdmittedPluginRuntimeRegistry({ controller: pluginReloadController,
            registry: fixture.registry, happyHomeDir: fixture.happyHomeDir });
        // Observe the real disposal owner without replacing its implementation.
        await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
        return { protocolVersion: 1, results: {} };
    });
    const disposed = vi.spyOn(fixture.registry, 'dispose');
    try {
        await fixture.lease.release();
        await detect({ requests: [{ id: `cli.${agentId}` }] }, requester);
    } finally { disposed.mockRestore(); }
});

it('sends empty factory facts after one unavailable-runtime acquisition instead of retrying for each Agent', async () => {
    const { fixture, detect } = await setup(async request => {
        expect(request.context.capabilitySessionFactories).toEqual({});
        return { protocolVersion: 1, results: {} };
    });
    await fixture.lease.release();
    await pluginReloadController.shutdown();
    // Instrument acquisition cost; all controller and factory logic stays real.
    const acquisition = vi.spyOn(pluginReloadController, 'tryAcquireRuntimeRegistry');
    try {
        await detect({ requests: [{ id: `cli.${agentId}` }, { id: 'cli.codex' }] }, requester);
        expect(acquisition).toHaveBeenCalledTimes(1);
    } finally { acquisition.mockRestore(); }
});
