import { expect, it, onTestFinished, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import { runMemberAgentInstallEffect } from '@/capabilities/installJobs/memberInstallEffect';
import { buildMemberAgentInstallEnvironment } from '@/capabilities/installJobs/memberInstallEnvironment';
import { registerMachineAgentInstallJobRpcHandlers } from '@/api/machine/rpcHandlers.agentInstallJobs';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Only the control listener and native process placement are replaced. The
// installed Action factory, RPC transport, job owner and finite installer run.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
} }));

it.skipIf(process.platform !== 'linux')('Use member cancels its running member install through the installed Action executor and aborts the child', async () => {
    onTestFinished(() => { vi.restoreAllMocks(); boundary.control = null; });
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
        ordinaryAccountSession: true, externalActionAccountId: 'member', serverId: 'home', homeServerIdentityId: 'srv_home',
        machineAccess: { custodianAccountId: 'custodian', role: 'use' },
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_home', machineId: 'machine' }),
    });
    const ingress = h.daemon.externalActionIngressOwner;
    const manager: unknown = Reflect.get(h.machine, 'rpcHandlerManager');
    if (!ingress || !(manager instanceof RpcHandlerManager)) throw new Error('Missing installed ingress');
    const input = new PassThrough(), output = new PassThrough();
    const owner = createAgentInstallJobOwner({ accountId: 'custodian', readTrackedSessions: () => [], readRegistry: () => ({ agents: [{
        id: 'fixture-member', runtimeSpec: { id: 'fixture-member', title: 'Fixture', binaryName: 'fixture-member',
          sourcePreferenceDefault: 'system-first', managedInstall: null, manualInstallKind: 'vendor_recipe',
          manualInstallRecipes: { linux: [{ cmd: '/bin/sh', args: ['-c', '/bin/sleep 100 & child=$!; printf "%s" "$child" > "$HOME/started"; wait'] }] },
          acceptsJavaScriptFileOverride: false },
    }] }) });
    registerMachineAgentInstallJobRpcHandlers({ owner, rpcHandlerManager: manager });
    onTestFinished(async () => { await owner.shutdown(); input.destroy(); output.destroy(); });
    const started = owner.start({ agentId: 'fixture-member', intent: 'install', consent: { vendorRecipe: true } }, {
        accountId: 'member', executeMember: async (operation, signal) => {
            const outcome = new Promise<import('@happier-dev/protocol/daemon/agent-install-jobs').AgentInstallJobOutcome>(resolve => {
                let bytes = '';
                output.on('data', chunk => { bytes += String(chunk); for (const line of bytes.split('\n').filter(Boolean)) {
                    const record = JSON.parse(line); if (record.t === 'outcome') { resolve(record.outcome); input.end(); }
                } });
            });
            input.write(JSON.stringify({ kind: 'install', ...operation }) + '\n');
            const stop = () => { input.write('cancel\n'); };
            signal.addEventListener('abort', stop, { once: true });
            try { await runMemberAgentInstallEffect(input, output, new AbortController().signal, buildMemberAgentInstallEnvironment(h.f.directory)); return await outcome; }
            finally { signal.removeEventListener('abort', stop); }
        },
    });
    if (!started.ok) throw new Error('Missing install job');
    await vi.waitFor(() => access(join(h.f.directory, 'started')));
    const pid = Number(await readFile(join(h.f.directory, 'started'), 'utf8'));
    const cancel = async (accountId: string) => {
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admission', binding: {
            accountId, custodianAccountId: 'custodian', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
            serverIdentityId: 'srv_home', actionId: 'machines.agents.install.cancel', requestId: 'cancel', machineId: 'machine',
            installationId: h.f.installation.installationId, admittedMachineRole: 'use', target: { kind: 'machine', machineId: 'machine' }, requestEnvelopeDigest: 'a'.repeat(43),
        } });
        return ingress.executor.execute('machines.agents.install.cancel', { machineId: 'machine', jobId: started.jobId }, {
            surface: 'ui', authority: 'present_user', bypassApprovals: true, actionRequestId: 'cancel',
            externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
            verifyMachineAdmissionCurrent: async () => true, signal: new AbortController().signal,
        });
    };
    expect(await cancel('other-account')).toMatchObject({ ok: false, errorCode: 'job_not_found' });
    expect(owner.read({ jobId: started.jobId, cursor: 0 }, 'member')).toMatchObject({ done: false });
    expect(await cancel('member')).toMatchObject({ ok: true });
    expect(owner.read({ jobId: started.jobId, cursor: 0 }, 'member')).toMatchObject({ done: true, outcome: { kind: 'failed', code: 'cancelled' } });
    expect(() => process.kill(pid, 0)).toThrow();
});
