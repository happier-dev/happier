import { spawn } from 'node:child_process';
import * as childProcessBoundary from 'node:child_process';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import * as filesystemBoundary from 'node:fs/promises';
import * as processBoundary from '@happier-dev/cli-common/process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MachinesAgentsListOutputSchema } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { createAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import { registerMachineAgentInstallJobRpcHandlers } from '@/api/machine/rpcHandlers.agentInstallJobs';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { createAgentIsolationMemberPreparationBoundary, runAgentIsolationMemberReadinessBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { prepareRequesterNativeOperation } from '@/daemon/agentIsolation/prepareNativeOperation';
import type { HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { registerCapabilitiesHandlers } from '@/rpc/handlers/capabilities';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { prepareNativeFilesystemEffect } from '@/rpc/handlers/fileSystem/prepareNativeFilesystemEffect';
import { createAgentCliSystemToolService } from '@/plugins/runtime/exec/system/tools/agentCliBinding';
import { resolveCliTsxTsconfigPath } from '@/utils/spawnHappyCLI';
import type { createS0DeploymentDaemonIngress } from '@/deployments/deploymentDaemonIngress.testkit';

// The OS boundary maps a guest UID/home onto a disposable host directory. It
// reads the actual production frame, then executes the real finite entrypoint;
// it never supplies an install result or changes the admitted operation.
const worker = String.raw`
void (async () => {
    const { readAgentLaunchFrame } = await import(process.env.HAPPIER_TEST_FRAME_ENTRY);
    const frame = await readAgentLaunchFrame(process.stdin);
    if (!frame.nativeIdentity || !['agent-install-effect', 'filesystem-effect'].includes(frame.args[0])) throw new Error('Unexpected native effect');
    const backing = process.env.HAPPIER_TEST_MEMBER_BACKING;
    const map = value => typeof value === 'string' ? value.split(frame.nativeIdentity.home).join(backing) : value;
    for (const key of Object.keys(process.env)) if (!key.startsWith('HAPPIER_TEST_') && key !== 'TSX_TSCONFIG_PATH') delete process.env[key];
    Object.assign(process.env, Object.fromEntries(Object.entries(frame.environment).map(([key, value]) => [key, map(value)])));
    const fs = await import('node:fs/promises');
    await fs.mkdir(map(frame.runtimeHome), { recursive: true });
    if (frame.args[0] === 'agent-install-effect') {
      const { runMemberAgentInstallEffect } = await import(process.env.HAPPIER_TEST_INSTALL_ENTRY);
      setImmediate(() => process.stdin.resume());
      await runMemberAgentInstallEffect(process.stdin, process.stdout, new AbortController().signal);
    } else {
      const { runFilesystemEffectInternal } = await import(process.env.HAPPIER_TEST_FILESYSTEM_ENTRY);
      setImmediate(() => process.stdin.resume());
      await runFilesystemEffectInternal(process.stdin, process.stdout);
    }
})().catch(error => { process.stderr.write(JSON.stringify({ code: error?.code ?? 'member_worker_failed', name: error?.name, message: error?.message, stack: error?.stack }) + '\n'); process.exitCode = 1; process.stdin.destroy(); });
`;

type IngressInput = Parameters<typeof createS0DeploymentDaemonIngress>[0];
type RpcConfiguration = NonNullable<IngressInput['configureRpc']>;
type Guest = IngressInput['home'];
export type MemberJourneyInvoke = (actionId: string, input: unknown) => Promise<ActionExecuteResult>;

export async function createMemberInstallJourney(input: Readonly<{ home: Guest; memberAccountId: string }>) {
    const { home, memberAccountId } = input;
    const backing = join(home.baseDir, `member-${memberAccountId}`);
    await mkdir(backing, { recursive: true, mode: 0o700 });
    const activeServerDir = join(home.baseDir, 'member-bindings');
    await mkdir(activeServerDir, { mode: 0o700 });
    const requesterIdentity = { kind: 'isolated' as const, separationRequired: true, homeServerIdentityId: home.serverId,
        requester: { serverId: home.serverId, accountId: memberAccountId, machineId: home.machineId, installationId: home.installationId } };
    const identity = deriveAgentIsolationMemberIdentity(requesterIdentity);
    const native = { home: identity.home, workspace: identity.workspaceRoot, backing, uid: 2401 };
    const workerErrors: string[] = [];
    // Entry specs provide writable OS wrappers before loading production modules.
    const actualFilesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const actualLstat = actualFilesystem.lstat;
    const actualRealpath = actualFilesystem.realpath;
    const actualExec = processBoundary.execFileWithDeadline;
    const lstatBoundary = vi.mocked(filesystemBoundary.lstat).mockImplementation(async path => String(path) === native.home
        ? Object.assign(await actualLstat(native.backing), { uid: native.uid, gid: native.uid, mode: 0o40700 }) : actualLstat(path));
    const realpathBoundary = vi.mocked(filesystemBoundary.realpath).mockImplementation(async path => native.home && [native.home, native.workspace].includes(String(path))
        ? String(path) : actualRealpath(path));
    const execBoundary = vi.spyOn(processBoundary, 'execFileWithDeadline').mockImplementation(async (...request) =>
        await runAgentIsolationMemberReadinessBoundary({ request, nativeHome: { path: native.home, uid: native.uid } })
        ?? actualExec(...request));
    const { spawn: actualSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const spawnBoundary = vi.mocked(childProcessBoundary.spawn).mockImplementation((...args: Parameters<typeof spawn>) => {
        if (args[0] !== 'sudo' || args[1]?.at(-1) !== 'agent-launch') return actualSpawn(...args);
        expect(args[1]).toContain(identity.username);
        const child = actualSpawn(process.execPath, ['--conditions=happier-source', '--import', createRequire(import.meta.url).resolve('tsx/esm'), '-e', worker], {
            ...args[2], cwd: resolve('.'), env: { PATH: process.env.PATH, TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
                HAPPIER_TEST_MEMBER_BACKING: backing,
                HAPPIER_TEST_FRAME_ENTRY: pathToFileURL(resolve('src/daemon/agentIsolation/agentLaunchFrame.ts')).href,
                HAPPIER_TEST_INSTALL_ENTRY: pathToFileURL(resolve('src/capabilities/installJobs/memberInstallEffect.ts')).href,
                HAPPIER_TEST_FILESYSTEM_ENTRY: pathToFileURL(resolve('src/rpc/handlers/fileSystem/filesystemEffectInternal.ts')).href } });
        child.stderr?.on('data', chunk => workerErrors.push(String(chunk)));
        return child;
    });
    const runtimeSpec = getAgentCliRuntimeSpec('claude')!;
    let slow = false;
    const owner = createAgentInstallJobOwner({ accountId: home.accountId, readTrackedSessions: () => [],
        readRegistry: () => ({ agents: [{ id: 'claude', runtimeSpec: { ...runtimeSpec,
            manualInstallRecipes: { linux: [{ cmd: '/bin/sh', args: ['-c', slow
                ? '/bin/sleep 100 & child=$!; printf "%s" "$child" > "$HOME/installer-started"; wait'
                : 'mkdir -p "$HOME/.local/bin"; printf "#!/usr/bin/env bash\\necho 2.1.322\\n" > "$HOME/.local/bin/claude"; chmod 755 "$HOME/.local/bin/claude"'] }] } } }] }) });
    let machine: HostAgentIsolationLaunchContext;
    let members: ReturnType<typeof createAgentIsolationMemberPreparationBoundary>['members'];
    const register: RpcConfiguration = async (rpc, context) => {
        if (!context.isolationNative) throw new Error('Member journey requires the enrolled isolation receiver');
        const source = context.isolationNative.effects;
        // The existing fixture fakes OS account/RunAs facts and executes the
        // real member setup owner against this enrollment's metadata port.
        const memberNative = createAgentIsolationMemberPreparationBoundary({ requesterIdentity,
            activeServerDir, custodianAccountId: home.accountId,
            encryptionMode: home.encryptionMode, uid: native.uid, metadataPort: context.captureMetadataPort() });
        members = memberNative.members;
        machine = { managedHappierBinaryPath: source.installedCli, read: () => {
            const policy = context.readIsolation();
            return policy ? { ...policy, workspaceRoots: [] } : undefined;
        },
            readMember: request => members.read(request),
            prepareMember: async request => {
                const result = await members.prepare(request);
                if (result.kind !== 'ready') throw new Error(`Member preparation failed: ${JSON.stringify(result)}`);
                return result;
            } };
        const prepareNativeOperation = (request: Parameters<typeof prepareRequesterNativeOperation>[0]) =>
            prepareRequesterNativeOperation(request, {
                machine, homeServerIdentityId: home.serverId, machineId: home.machineId, installationId: home.installationId });
        registerMachineAgentInstallJobRpcHandlers({ rpcHandlerManager: rpc, owner, deps: { agentIsolation: machine,
            resolveHostHomeServerIdentityId: async () => home.serverId, nativeOperationRuntime: { prepareNativeOperation } } });
        registerDaemonContributionRegistryProjectionHandler(rpc);
        registerCapabilitiesHandlers(rpc, { filesystemEffectAdmission: createFilesystemEffectAdmission({
            readAgentIsolation: machine.read, resolveHomeServerIdentityId: async () => home.serverId,
            resolveHostIdentity: async () => ({ custodianAccountId: home.accountId, machineId: home.machineId, installationId: home.installationId }),
            executeNativeRpc: async ({ method, input: body, context: ingress, identity: requester }) => {
                const channel = await prepareNativeFilesystemEffect({ prepareNativeOperation, identity: requester,
                    operationKey: ingress.transportRequestId ?? '', signal: ingress.signal, ingress, allowMemberPreparation: false,
                    configuration: { workingDirectory: backing, accessPolicy: { kind: 'osUser' }, requesterAccountId: memberAccountId,
                        ...(ingress.capabilitySessionFactories ? { capabilitySessionFactories: ingress.capabilitySessionFactories } : {}) } });
                try { return await channel.request({ kind: 'filesystem.rpc', method, input: body }); }
                finally { await channel.dispose(); }
            },
        }) });
        return [RPC_METHODS.DAEMON_AGENTS_INSTALL_START, RPC_METHODS.DAEMON_AGENTS_INSTALL_READ,
            RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL, RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST,
            RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            RPC_METHODS.CAPABILITIES_DESCRIBE, RPC_METHODS.CAPABILITIES_DETECT, RPC_METHODS.CAPABILITIES_INVOKE];
    };
    return { register, backing, identity,
        async run(invoke: MemberJourneyInvoke) {
            // Sharing leaves the requester cold. Only deliberate install
            // admission may ask the existing native owner to prepare it.
            const cold = await invoke('machines.agents.list', { machineId: home.machineId, agentId: 'claude', refresh: true });
            expect(cold, JSON.stringify(cold)).toMatchObject({ ok: true, result: { items: [{
                preparation: 'member_not_prepared', installed: false,
                install: { available: true, executionScope: 'member' },
            }] } });
            await expect(members.read({ requesterIdentity })).rejects.toMatchObject({ code: 'member_not_prepared' });
            const start = await invoke('machines.agents.install', { machineId: home.machineId, agentId: 'claude', intent: 'install', consent: { vendorRecipe: true } });
            expect(start, JSON.stringify(start)).toMatchObject({ ok: true, result: { ok: true, executionScope: 'member' } });
            if (!start.ok || !start.result || typeof start.result !== 'object' || !('jobId' in start.result) || typeof start.result.jobId !== 'string') throw new Error('Member install admission failed');
            const succeeded = await owner.read({ jobId: start.result.jobId, cursor: 0, waitForTerminal: true }, memberAccountId);
            expect(succeeded, JSON.stringify({ succeeded, workerErrors })).toMatchObject({ ok: true, done: true, outcome: { kind: 'succeeded', version: '2.1.322' } });
            const detected = await invoke('machines.agents.list', { machineId: home.machineId, agentId: 'claude', refresh: true });
            expect(detected, JSON.stringify({ detected, workerErrors })).toMatchObject({ ok: true });
            const installed = MachinesAgentsListOutputSchema.parse(detected.ok ? detected.result : null);
            expect(installed.items[0]).toMatchObject({ installed: true, install: { executionScope: 'member' } });
            const observed = await machine.readMember!({ requesterIdentity, signal: new AbortController().signal });
            const selection = await createAgentCliSystemToolService({ agentId: 'claude', runtimeSpec,
                binding: { toolId: 'claude-cli' }, definition: { toolId: 'claude-cli', displayName: 'Claude', lookupNames: ['claude'] },
                processEnv: { HOME: home.baseDir, PATH: '' }, memberLaunch: { memberIdentity: observed.identity,
                    managedHappierBinaryPath: machine.managedHappierBinaryPath!, runtimeHome: join(identity.home, 'runtime', 'selection') },
                delegate: { async resolve() { throw new Error('No alternate CLI owner'); } },
            }).resolve({ toolId: 'claude-cli', purpose: 'Composed member launch' });
            expect(selection.executablePath).toBe(join(backing, '.local/bin/claude'));
            slow = true;
            const active = await invoke('machines.agents.install', { machineId: home.machineId, agentId: 'claude', intent: 'install', force: true, consent: { vendorRecipe: true } });
            if (!active.ok || !active.result || typeof active.result !== 'object' || !('jobId' in active.result) || typeof active.result.jobId !== 'string') throw new Error('Active install admission failed');
            const jobId = active.result.jobId;
            await vi.waitFor(() => access(join(backing, 'installer-started')), { timeout: 300_000 });
            const installerPid = Number(await readFile(join(backing, 'installer-started'), 'utf8'));
            expect(owner.read({ jobId, cursor: 0 }, memberAccountId)).toMatchObject({ done: false });
            const cancelled = await invoke('machines.agents.install.cancel', { machineId: home.machineId, jobId });
            expect(cancelled).toMatchObject({ ok: true });
            expect(owner.read({ jobId, cursor: 0 }, memberAccountId)).toMatchObject({ done: true, outcome: { kind: 'failed', code: 'cancelled' } });
            expect(() => process.kill(installerPid, 0)).toThrow();
            const settled = await invoke('machines.agents.install.status', { machineId: home.machineId, jobId, cursor: 0 });
            expect(settled).toMatchObject({ ok: true, result: { ok: true, done: true, outcome: { kind: 'failed', code: 'cancelled' } } });
            const absent = await invoke('machines.agents.install.status', { machineId: home.machineId, jobId: `missing-${jobId}`, cursor: 0 });
            expect(absent, JSON.stringify(absent)).toMatchObject({ ok: false, errorCode: 'job_not_found' });
            return { succeeded, detected, selection, cancelled, settled, absent, jobId };
        },
        async close() { await owner.shutdown(); spawnBoundary.mockRestore(); lstatBoundary.mockRestore(); realpathBoundary.mockRestore(); execBoundary.mockRestore();
            await rm(backing, { recursive: true, force: true }); },
    };
}
