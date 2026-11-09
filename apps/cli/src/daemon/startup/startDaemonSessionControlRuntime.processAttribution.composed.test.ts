import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';
import { expect, it } from 'vitest';
import { once } from 'node:events';
import { configuration } from '@/configuration';
import { formatProcessOwnerTag } from '@/processes/ownerTag';
import { spawnInlineNodeTestProcess } from '@/testkit/process/spawn';
import { listExecutionRunMarkersForRehydration, writeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import { RequesterWorkAttributionV1Schema } from '@/daemon/lifecycle/requesterWorkAttribution';
import { resolveProcessOwnerRequester } from '@/daemon/processes/ownership/resolveProcessOwnerRequester';
import { authorizeResolvedProjectExecLaunchForHost, createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';

it('projects only the bound profile of Session and Run roots into immutable Home attribution', async () => {
    const machineId = 'machine';
    const home = 'srv_process_home';
    let originReads = 0;
    const startup = await createAttachedManagedRunFixture({ browserStartup: {
        resolveCurrentMachineExecutionOriginContext: async () => {
            originReads += 1;
            return { serverIdentityId: home, machineId };
        },
    } });
    const runId = 'profile-attribution-run';
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)', { env: { ...process.env,
        HAPPIER_PROCESS_OWNER: formatProcessOwnerTag({ happierHomeDir: configuration.happyHomeDir,
            owner: { kind: 'run', runId } }),
    } });
    let stopService: (() => Promise<void>) | undefined;
    try {
        await once(child, 'spawn');
        if (!child.pid) throw new Error('Run fixture did not start');
        startup.tracked.sessionRunnerPid = child.pid;
        const expected = RequesterWorkAttributionV1Schema.parse({ serverId: home, machineId,
            installationId: 'installation', accountId: 'account' });
        const serviceOwner = startup.fixture.lease.registry.projectManagedServices;
        const workspace = { id: 'profile-attribution-workspace', serverId: 'home', machineId,
            rootPath: startup.directory, createdAtMs: 1 };
        const service = await serviceOwner.superviseProject({ kind: 'workspace', workspace,
            declaration: { workspaceRefId: workspace.id, selection: { kind: 'manifest', name: 'worker' } },
            cwd: startup.directory, serviceId: 'profile-attribution-service',
            requester: { ...expected, serverId: 'home' }, specIdentity: 'profile-attribution-native-launch', isCurrent: () => true,
            processSpec: { mode: { kind: 'managedSpawn', endpointNone: true } },
            authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({ signal, assertCurrent() {},
                projectLaunch: { status: 'ready', reviewedEffectDigest: 'profile-attribution-native-launch',
                    toolchain: { selection: { kind: 'host' }, root: startup.directory, platform: process.platform,
                        io: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }) } },
                launch: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: startup.directory,
                    env: {}, release() {} } }),
        });
        stopService = async () => { await service.stop(); };
        const variants = [
            { ...expected, serverId: 'home' },
            expected,
            { ...expected, serverId: 'srv_foreign_home' },
            { ...expected, machineId: 'foreign-machine', serverId: 'home' },
            { ...expected, installationId: 'foreign-installation', serverId: 'home' },
            { ...expected, accountId: 'foreign-account', serverId: 'home' },
        ];
        const sessionOwner = { kind: 'session', sessionId: 'parent-session' } as const;
        const runOwner = { kind: 'run', runId } as const;
        let updatedAtMs = 0;
        for (const phase of ['live', 'ended-run', 'ended-session'] as const) {
            if (phase === 'ended-session') {
                const exited = once(child, 'exit');
                child.kill('SIGKILL');
                await exited;
            }
            for (const [index, attribution] of variants.entries()) {
                startup.tracked.requesterWorkAttributionV1 = RequesterWorkAttributionV1Schema.parse(attribution);
                await writeExecutionRunMarker({ pid: child.pid, runId, happySessionId: null, callId: 'call', sidechainId: 'side',
                    intent: 'review', backendTarget: { kind: 'backend', backendId: startup.fixture.agentId },
                    status: phase === 'live' ? 'running' : 'succeeded', startedAtMs: 1, updatedAtMs: ++updatedAtMs,
                    requesterWorkAttributionV1: attribution });
                const previousOriginReads = originReads;
                const read = await startup.runtime.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
                if (read.status !== 'ok') throw new Error('Native process census unavailable');
                expect(originReads - previousOriginReads).toBe(1);
                const serviceRoot = read.roots.find(root => root.owner.kind === 'service' && root.owner.serviceId === service.instanceId);
                expect(serviceRoot?.requesterWorkAttributionV1).toEqual(expected);
                expect(serviceOwner.readResourceTargets().find(target => target.root.owner.kind === 'service'
                    && target.root.owner.serviceId === service.instanceId)?.root.requesterWorkAttributionV1)
                    .toEqual({ ...expected, serverId: 'home' });
                const owners = phase === 'ended-session' ? [sessionOwner] : phase === 'ended-run' ? [runOwner] : [sessionOwner, runOwner];
                for (const owner of owners) {
                    const root = read.roots.find(root => root.owner.kind === owner.kind
                        && (root.owner.kind === 'session' ? root.owner.sessionId === 'parent-session'
                            : root.owner.kind === 'run' && root.owner.runId === runId));
                    if (!root) throw new Error(`Missing ${phase} ${owner.kind} root for variant ${index}`);
                    expect(root.live).toBe(phase === 'live');
                    expect(root.requesterWorkAttributionV1).toEqual({ ...attribution,
                        serverId: attribution.serverId === 'home' ? home : attribution.serverId });
                    const requester = resolveProcessOwnerRequester(owner, read.roots, { target: expected, custodianAccountId: expected.accountId });
                    expect(requester?.accountId === expected.accountId, `${owner.kind} disclosure for variant ${index}`).toBe(index < 2);
                    if (owner.kind === 'session' && phase === 'live') startup.tracked.runnerProcessIdentity = {
                        pid: child.pid, processStartTimeMs: root.start.startTimeMs,
                    };
                }
                // Projection never rewrites the credential owner's routing fact or the stored Run marker input.
                expect(startup.tracked.requesterWorkAttributionV1).toEqual(attribution);
                expect((await listExecutionRunMarkersForRehydration()).find(marker => marker.runId === runId)
                    ?.requesterWorkAttributionV1).toEqual(attribution);
            }
        }
    } finally {
        try { await stopService?.(); }
        finally {
            try {
                if (child.exitCode === null && child.signalCode === null) {
                    const exited = once(child, 'exit');
                    child.kill('SIGKILL');
                    await exited;
                }
            } finally { await startup.cleanup(); }
        }
    }
});
