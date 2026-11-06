import { afterAll, afterEach, expect, it, vi } from 'vitest';
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

afterEach(async () => { await fixtures.at(-1)?.lease.release(); });

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
    return { fixture, detect: handlers.get(RPC_METHODS.CAPABILITIES_DETECT)!, invoke: handlers.get(RPC_METHODS.CAPABILITIES_INVOKE)! };
}

it('removes native sign-in identity from Use capability replies without mutating the native facts or other results', async () => {
    // The native RPC transport is the OS-user process boundary. Keep the real
    // capability service, effect admission and final reply projection beneath it.
    const response = { protocolVersion: 1, results: {
        [`cli.${agentId}`]: { ok: true, checkedAt: 100, data: {
            available: true, version: '1.0', isLoggedIn: true,
            signIn: { status: 'signedIn', loginSupport: 'status_only', required: true, accountLabel: 'owner@example.invalid' },
            authStatus: { state: 'logged_in', method: 'oauth_cli', accountLabel: 'owner@example.invalid',
                reason: null, source: 'command', checkedAt: 100 },
        } },
        'cli.unavailable': { ok: false, checkedAt: 100, error: { code: 'unavailable', message: 'Unavailable' } },
        'dep.az': { ok: true, checkedAt: 100, data: {
            installed: true, capabilityId: 'dep.az', installedVersion: '2.80.0', authenticated: true,
            authStatus: 'authenticated', setupUrl: 'https://learn.microsoft.com/cli/azure/install-azure-cli',
            loginCommand: ['az', 'login'], accountName: 'owner@example.invalid', tenantId: 'owner-tenant',
        } },
        'tool.tmux': { ok: true, checkedAt: 100, data: { available: false } },
    } };
    const { detect } = await setup(async () => response);
    const request = { requests: [{ id: `cli.${agentId}`, params: { includeLoginStatus: true } }, { id: 'dep.az' }] };
    const use = await detect(request, requester);
    expect(use).toEqual({ ...response, results: { ...response.results,
        'dep.az': { ok: true, checkedAt: 100, data: {
            installed: true, capabilityId: 'dep.az', installedVersion: '2.80.0', authenticated: true,
            authStatus: 'authenticated', setupUrl: 'https://learn.microsoft.com/cli/azure/install-azure-cli',
            loginCommand: ['az', 'login'],
        } },
        [`cli.${agentId}`]: { ok: true, checkedAt: 100, data: {
            available: true, version: '1.0', isLoggedIn: true,
            signIn: { status: 'signedIn', loginSupport: 'status_only', required: true },
            authStatus: { state: 'logged_in', method: 'oauth_cli', reason: null, source: 'command', checkedAt: 100 },
        } },
    } });
    expect(response.results[`cli.${agentId}`].data.signIn.accountLabel).toBe('owner@example.invalid');
    expect(response.results[`cli.${agentId}`].data.authStatus.accountLabel).toBe('owner@example.invalid');
    expect(await detect({ requests: [request.requests[0]!] }, { ...requester,
        machineAdmission: { ...requester.machineAdmission!, role: 'manage' },
    })).toMatchObject({ results: { [`cli.${agentId}`]: { ok: true, data: {
        signIn: { status: 'unknown', required: false }, authStatus: null,
    } } } });
});

it.each([
    { method: 'wait', legacyFields: true }, { method: 'poll', legacyFields: true },
    { method: 'wait', legacyFields: false }, { method: 'poll', legacyFields: false },
])('withholds daemon Account identity from Use system-task $method results (legacy fields: $legacyFields)', async ({ method, legacyFields }) => {
    const status = { serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'machine',
        daemonServerUrl: 'https://home.invalid', daemonComparableKey: 'home',
        ...(legacyFields ? { daemonAccountId: 'owner', daemonAccountLabel: 'Owner fixture' } : {}),
        ownerProfile: { email: 'owner@example.invalid' },
        daemonMachineRegistered: true, cliUpdate: null };
    const task = { protocolVersion: 1, taskId: 'fixture-status', ok: true, data: status };
    const wrap = (result: unknown) =>
        ({ ok: true, result: method === 'wait' ? result : { events: [], nextCursor: 0, result, pendingPrompt: null } });
    // Substitute the native process transport, preserving the actual service
    // and handler that publish a task's completed status.
    const response = wrap(task);
    const { invoke } = await setup(async () => response);
    const input = { id: 'tool.systemTasks', method, params: { taskId: task.taskId } };
    const { daemonAccountId: _id, daemonAccountLabel: _label, ownerProfile: _profile, ...facts } = status;
    expect(await invoke(input, requester)).toEqual(wrap({ ...task, data: facts }));
    const manage = { ...requester, machineAdmission: { ...requester.machineAdmission!, role: 'manage' as const } };
    // Manage runs the actual daemon effect, rather than crossing the substituted
    // requester-process transport. This fixture Home has no stored Account.
    const started = await invoke({ id: 'tool.systemTasks', method: 'start', params: { spec: {
        protocolVersion: 1, kind: 'daemon.service.status.v1', params: { target: { kind: 'local' } },
    } } }, manage) as { ok: true; result: { taskId: string } };
    expect(started).toMatchObject({ ok: true, result: { taskId: expect.any(String) } });
    const completed = await invoke({ id: 'tool.systemTasks', method: 'wait', params: started.result }, manage);
    expect(completed).toMatchObject({ ok: true, result: { ok: true, data: { daemonAccountId: null, daemonAccountLabel: null } } });
});

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
