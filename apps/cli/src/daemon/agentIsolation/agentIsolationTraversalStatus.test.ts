import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createMachineSetupNativeBackend } from '@happier-dev/cli-common/machineSetup';
import { MachineAgentIsolationPreviewResultV1Schema, readMachineAgentIsolationPolicyV1,
    type MachineAgentIsolationStatusV1 } from '@happier-dev/protocol';
import type { RpcHandlerContext, RpcHandlerMap } from '@/api/rpc/types';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';

it.skipIf(process.platform !== 'linux')('retains the exact masked native ancestor through Apply, recovery Preview and own status', async () => {
    await withTempDir('isolation-masked-ancestor-', async ancestor => {
        const workspace = join(ancestor, 'workspace');
        await mkdir(workspace);
        await chmod(ancestor, 0o700);
        let granted = false;
        const traversal = createMachineSetupNativeBackend({ run: async ({ executable, args }) => {
            if (executable === 'getent') return { code: 0, stdout: 'happier-agent:x:996:988::/var/lib/happier-agent:/usr/sbin/nologin\n', stderr: '' };
            if (executable === 'getfacl') return { code: 0, stdout: ['user::rwx', ...(granted ? ['user:996:--x'] : []),
                'group::---', `mask::${(await lstat(String(args.at(-1)))).mode & 0o010 ? '--x' : '---'}`, 'other::---'].join('\n'), stderr: '' };
            if (executable === 'setfacl') {
                granted = true;
                await chmod(String(args.at(-1)), 0o710);
                return { code: 0, stdout: '', stderr: '' };
            }
            throw new Error(`Unexpected native command: ${executable}`);
        } });
        let enabled = false, metadataVersion = 1;
        let status: MachineAgentIsolationStatusV1 = { kind: 'disabled' };
        // The canonical virtual native fixture represents preinstalled host
        // bootstrap resources; the failing traversal uses the real observer.
        const native = createAgentIsolationEffectsBoundary({ installationId: 'installation', installedCli: '/opt/happier/current/happier',
            readRoots: () => [{ rootId: 'workspace', path: workspace }], readSessionsToReplace: () => 0,
            publishStatus: async value => { status = value; }, backend: {
                observe: async step => step.kind === 'pathTraversal' ? traversal.observe(step)
                    : { stepId: step.id, status: 'satisfied', facts: {} },
                apply: async step => { if (step.kind === 'pathTraversal') await traversal.apply(step); },
            } });
        // A later native child can initialize its default home after the
        // root interpreter verified the grant, before the daemon's CHECK.
        const effects = { ...native.effects, elevation: { ...native.effects.elevation,
            spawn: ((request) => {
                const child = native.effects.elevation.spawn!(request);
                return { ...child, settled: child.settled.then(async result => {
                    if (granted) await chmod(ancestor, 0o700);
                    return result;
                }) };
            }) satisfies NonNullable<typeof native.effects.elevation.spawn>,
        } };
        const handlers: RpcHandlerMap = new Map();
        registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler: (id, handler) => { handlers.set(id, handler); } }, {
            target: () => ({ serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' }),
            readCanonicalHomeServerIdentityId: () => 'home', read: () => ({ enabled, status }), effects,
            runActionOperation: createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine', resolveAccountId: async () => 'owner' }).runActionOperation,
            captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadataVersion, metadata: { agentIsolation: { enabled } } }),
                compareAndSwap: async input => {
                    const policy = readMachineAgentIsolationPolicyV1(input.metadata);
                    if (policy.status !== 'ready') throw new Error('Invalid metadata boundary');
                    enabled = policy.policy.enabled;
                    return { status: 'applied', metadataVersion: ++metadataVersion, metadata: { agentIsolation: { enabled } } };
                } }),
        });
        const context: RpcHandlerContext = { callerAuthority: 'present_user', signal: new AbortController().signal,
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true, transportRequestId: 'traversal-review' };
        const preview = () => handlers.get('machines.agentIsolation.preview')!({ machineId: 'machine', enabled: true }, context);
        const reviewed = MachineAgentIsolationPreviewResultV1Schema.parse(await preview());
        if (reviewed.kind !== 'ready') throw new Error('Review unavailable');
        const expected = { kind: 'unavailable', code: 'provisioning_unavailable', prerequisite: {
            reason: 'native_effect_pending', requiredFact: 'pathTraversal', detail: 'acl_mask_denied', path: ancestor,
            remedy: 'machines.agentIsolation.preview',
        } };
        expect(await handlers.get('machines.agentIsolation.set')!({ machineId: 'machine', enabled: true,
            expectedMetadataVersion: reviewed.metadataVersion, expectedPolicy: reviewed.policy, expectedPlanDigest: reviewed.plan.planDigest },
        { ...context, transportRequestId: 'traversal-apply' })).toMatchObject({ kind: 'accepted', status: expected });
        // A generic qualification result from an older observation must not
        // hide the current native CHECK's discriminating repair fact.
        status = { kind: 'unavailable', code: 'launch_probe_failed' };
        expect(await preview()).toMatchObject({ kind: 'ready', status: expected });
        expect(await handlers.get('machines.agentIsolation.status')!({ machineId: 'machine' }, context))
            .toMatchObject({ protection: 'trusted_administrator', status: expected });
    });
});
