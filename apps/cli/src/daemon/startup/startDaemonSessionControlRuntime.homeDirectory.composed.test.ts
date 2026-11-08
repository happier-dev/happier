import { mkdir } from 'node:fs/promises';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { prepareRunnerDaemonPluginServices } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { issueAgentNativeLaunchQualifierForHost } from '@/plugins/runtime/invocation/services/exec';
import { resolvePreparedSessionDirectory } from './resolvePreparedSessionDirectory';
import { executeNativeSessionDirectoryPreparation } from '@/rpc/handlers/fileSystem/sessionDirectoryEffect';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The listener and HTTP are transport boundaries; admission, custody, path
// selection, registered services, native launch preparation and Exec stay real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
} }));
vi.mock('undici', async importOriginal => {
    const actual = await importOriginal<typeof import('undici')>();
    return { ...actual, fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as unknown as typeof actual.fetch };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); boundary.control = null; });
afterAll(() => pluginReloadController.shutdown());

it.each(['owner', 'requester'] as const)('launches a copied child with stored home shorthand and rejects a foreign cwd (%s)', async actor => {
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, {
        manifest: createPluginManifestV2Fixture({ id: 'acme.project-launch', hostAccess: { required: [{
            id: 'native-process', capability: 'process', reason: 'Run the native Agent fixture',
            scope: { executables: [{ kind: 'systemTool', id: 'native-cli' }] },
        }, { id: 'workspace', capability: 'filesystem', reason: 'Use the Session workspace',
            scope: { locations: [{ root: 'workspace' }], access: ['read'] } }], optional: [] }, contributes: {
            systemTools: [{ id: 'native-cli', title: 'Native CLI fixture', executableNames: ['git'] }],
            agents: [{ id: 'agent', title: 'Home launch Agent', runtime: { kind: 'custom' }, primary: 'sessions',
                capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }],
        } }),
        files: {
            'agent.mjs': 'export function factory() { return { sessions: { open() { throw new Error("Exec boundary only"); } } }; }',
            'daemon.mjs': 'import { factory } from "./agent.mjs"; export function activate(api) { api.agents.register("agent", factory, { sessionRunnerFactory: { module: "./agent.mjs", export: "factory", runtimeApiVersion: 1 } }); }',
        },
    }, undefined, {
        externalActionAccountId: actor === 'owner' ? 'requester' : 'custodian',
        ordinaryAccountSession: actor === 'owner',
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_installed_project_fixture', machineId: 'machine' }),
        agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
    });
    vi.stubEnv('HOME', h.cwd);
    vi.stubEnv('USERPROFILE', h.cwd);
    // R27 commits the child row with "~", then attaches its runner using that
    // stored path instead of the already-prepared absolute caller directory.
    const selected = resolvePreparedSessionDirectory({
        options: { directory: h.cwd }, normalizedExistingSessionId: h.sessionId,
        existingSessionWorkspacePath: '~', ownerMetadata: { v: 1, workspace: { path: '~' } },
    });
    const preparedDirectory = await executeNativeSessionDirectoryPreparation({
        kind: 'session.directory.prepare', request: { directory: { kind: 'path', path: selected.directory } },
        approvedNewDirectoryCreation: false,
    });
    if (!preparedDirectory.ok) throw new Error('Copied child directory preparation failed');
    h.tracked.runnerAgentInvocationContext = { ...h.tracked.runnerAgentInvocationContext!, cwd: preparedDirectory.directory };
    const invocationId = 'copied-child-first-input';
    const services = await prepareRunnerDaemonPluginServices({ invocationId, signal: h.signal,
        local: createUnavailablePluginServices(), dispatch: async operation => {
            const response = await h.dispatch(operation);
            if (!response.ok) throw Object.assign(new Error(response.error.code), { code: response.error.code });
            if (response.result.kind !== 'plugin_services.result_v1') throw new Error('Missing PluginServices result');
            return decodeRunnerDaemonPluginServiceWireValueV1(response.result.value);
        } });
    const resolved = await services.exec.systemTools.resolve({ toolId: 'native-cli', purpose: 'Start copied child', cwd: h.cwd });
    const nativeLaunch = issueAgentNativeLaunchQualifierForHost(services.exec);
    const result = await services.exec.run({ executable: resolved.executable, args: ['--version'],
        cwd: { root: 'workspace', relativePath: '' } }, { nativeLaunch });
    expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
    expect(new TextDecoder().decode(result.stdout)).toMatch(/^git version /);
    expect(preparedDirectory.directory).toBe(h.cwd);
    expect(h.accountReads()).not.toContain('Bearer custodian-token');
    const foreignCwd = `${h.cwd}-sibling`;
    await mkdir(foreignCwd);
    await expect(services.exec.run({ executable: resolved.executable, args: ['--version'], cwd: foreignCwd }, { nativeLaunch }))
        .rejects.toMatchObject({ code: 'outside_root' });
    await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(invocationId) });
}, 120_000);
