import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, type WorktreeRemovedEventV1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createWorktreePortsOwner } from '@/workspaces/execution/worktreePorts';
import { subscribeWorktreePortRemoval } from '@/workspaces/execution/worktreePortRemoval';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createPlainProjectAccountRefRow, mockProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import type { ProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import type { ProjectFiniteActionRuntime } from './projectFiniteAction';
import { prepareProjectCheckoutRemoval } from './projectCheckoutRemoval';

afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); });

it.each([
    { associated: true, externallyRemoved: false },
    { associated: false, externallyRemoved: false },
    { associated: true, externallyRemoved: true },
    { associated: false, externallyRemoved: true },
])('releases only the captured physical assignment through an alias (Workspace $associated, externally removed $externallyRemoved)', async ({ associated, externallyRemoved }) => {
    const directory = await mkdtemp(join(tmpdir(), 'project-removal-physical-'));
    const physical = join(directory, 'physical');
    const alias = join(directory, 'alias');
    const sibling = join(directory, 'sibling');
    await Promise.all([mkdir(physical), mkdir(sibling)]);
    await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    mockProjectAccountRowsHttpBoundary(associated ? [createPlainProjectAccountRefRow({ id: 'workspace', serverId: 'home',
        machineId: 'machine', rootPath: alias, projectKey: 'project', createdAtMs: 1 })] : []);
    const plugin = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
    const services = plugin.registry.projectManagedServices;
    if (!services) throw new Error('Missing canonical Project service owner');
    let nativeStopped = false;
    const service = await services.superviseProject({ kind: 'workspace',
        workspace: { id: 'service-workspace', serverId: 'home', machineId: 'machine', rootPath: physical, createdAtMs: 1 },
        declaration: { workspaceRefId: 'service-workspace', selection: { kind: 'manifest', name: 'worker' } },
        requester: { serverId: 'home', accountId: 'account', machineId: 'machine', installationId: 'installation' },
        cwd: physical, serviceId: 'removal-worker', specIdentity: 'reviewed-worker', isCurrent: () => true,
        authorizeLaunch: async () => ({ command: 'unused-native-starter', args: [], cwd: physical, env: {}, release() {} }),
        // The native service adapter is the OS boundary; custody and activity stay real.
        processSpec: { mode: { kind: 'native', builtinLifecycle: {
            inspect: async () => ({ phase: nativeStopped ? 'stopped' : 'running', readiness: 'not_reported', endpoint: null }),
            stop: async () => { nativeStopped = true; return { status: 'stopped' }; },
        } } },
    });
    const broker = plugin.registry.stableEventsBroker;
    if (!broker) throw new Error('Missing real host event broker');
    const statePath = join(directory, 'ports.json');
    const ports = createWorktreePortsOwner({ statePath });
    const terminalSessions = createTerminalPtySessionManager({
        // No process may start during skipped cleanup; the native PTY is the OS boundary.
        ptyProvider: { spawn() { throw new Error('Unexpected cleanup process'); } },
        config: readDaemonTerminalPtyConfig({}).sessionManager,
    });
    const operationRuntime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
        supportsCoreCancellation: () => true });
    const environmentIo: ProjectNativeToolchainIoForHost = { resolveTool: async () => null,
        run: async () => { throw new Error('Unexpected toolchain process'); }, createInvocation: () => environmentIo };
    const runtime: ProjectFiniteActionRuntime = { credentials: { token: 'requester', encryption: null }, serverId: 'home',
        serverHttpBaseUrl: 'https://home.test', machineId: 'machine', accountId: 'account', operationRuntime,
        workerAdmission: createProjectWorkerAdmission({ machineId: 'machine', admissionDrain: createDaemonAdmissionDrain(),
            readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: 1 }, source: 'default', metadataVersion: 1 }) }),
        resolveWorkspaceExecutionConfig: async () => null, nativeIo: { resolveTool: async () => null }, environmentIo, terminalSessions };
    const subscription = subscribeWorktreePortRemoval({ broker, portsOwner: ports,
        resolveCurrentMachineId: () => 'machine', isCurrent: () => true });
    const removals: WorktreeRemovedEventV1[] = [];
    const observation = broker.subscribeHost({
        target: { eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' } },
        isCurrent: () => true,
        listener(event) { if (event.payload.kind === 'worktreeRemoved') removals.push(event.payload.removal); },
    });
    try {
        expect(await ports.assign({ rootPath: physical, slots: 1, listenerKeys: [] })).toMatchObject({ kind: 'ready' });
        expect(await ports.assign({ rootPath: sibling, slots: 1, listenerKeys: [] })).toMatchObject({ kind: 'ready' });
        const captured = await realpath(physical);
        const retainedSibling = await realpath(sibling);
        const before = JSON.parse(await readFile(statePath, 'utf8'));
        const signal = new AbortController().signal;
        const result = await operationRuntime.observeExecution({ actionId: 'scm.worktree.remove', input: { cwd: directory,
            worktreePath: alias }, rpcContext: { signal }, execute: async operation => {
            await expect(prepareProjectCheckoutRemoval({ runtime, ingress: { signal }, context: {}, operation,
                worktreePath: join(directory, 'missing'), skipCleanup: true })).rejects.toMatchObject({ code: 'project_worktree_root_unavailable' });
            // A retained backend registration supplies this capture after an external
            // deletion; a plain missing input above must still fail unavailable.
            if (externallyRemoved) await rm(physical, { recursive: true });
            const removalInput = { runtime, ingress: { signal }, context: {}, operation,
                worktreePath: alias, ...(externallyRemoved
                    ? { missingWorktree: { physicalRootPath: captured, alreadyAbsent: true as const } }
                    : { skipCleanup: true }) };
            await expect(prepareProjectCheckoutRemoval(removalInput)).rejects.toMatchObject({ code: 'workspace_root_in_use' });
            expect(removals).toEqual([]);
            expect(JSON.parse(await readFile(statePath, 'utf8')).assignments[captured]).toEqual(before.assignments[captured]);
            expect(await service.stop()).toEqual({ status: 'stopped' });
            expect(nativeStopped).toBe(true);
            const removal = await prepareProjectCheckoutRemoval({ runtime, ingress: { signal }, context: {}, operation,
                worktreePath: alias, ...(externallyRemoved
                    ? { missingWorktree: { physicalRootPath: captured, alreadyAbsent: true as const } }
                    : { skipCleanup: true }) });
            expect(removal.cleanup).toBe(associated ? 'skipped' : 'unassociated');
            if (!externallyRemoved) await rm(physical, { recursive: true });
            await rm(alias);
            removal.settle('deleted');
            return { ok: true, result: {} };
        } });
        expect(result).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(removals).toEqual([expect.objectContaining({
            workspace: associated ? expect.objectContaining({ workspaceId: 'workspace', rootPath: alias }) : null,
            worktreePath: captured,
        })]));
        await vi.waitFor(async () => {
            const after = JSON.parse(await readFile(statePath, 'utf8'));
            expect(after.assignments[captured]).toBeUndefined();
            expect(after.assignments[retainedSibling]).toEqual(before.assignments[retainedSibling]);
        });
    } finally {
        await observation.dispose();
        await subscription.dispose();
        await terminalSessions.dispose();
        await plugin.dispose();
        await rm(directory, { recursive: true, force: true });
    }
});
