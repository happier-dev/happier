import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { computeSshHostKeyFingerprint } from '@happier-dev/protocol/ssh/hostTrust';
import { reloadConfiguration } from '@/configuration';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { createMachineProvisionersInvocationService } from '@/plugins/runtime/invocation/services/machineProvisioners';
import { createPluginInvocationLifetime } from '@/plugins/runtime/invocation/lifetime';
import { prepareManagedSessionSshTrust, runManagedSessionSshTrust, runPreparedPresetSshHostTrust } from './enrollmentSshTrust';

const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
vi.mock('node:child_process', async original => {
    const actual = await original<typeof import('node:child_process')>();
    return { ...actual, spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
        if (args[0] !== 'ssh-keyscan') return actual.spawnSync(...args);
        return { status: 0, stdout: `192.0.2.7 ${key}\n`, stderr: '' };
    } };
});
const roots: string[] = [];
afterEach(async () => {
    vi.unstubAllEnvs(); reloadConfiguration();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function home() {
    const root = await mkdtemp(join(tmpdir(), 'happier-bootstrap-trust-')); roots.push(root);
    vi.stubEnv('HAPPIER_HOME_DIR', root); reloadConfiguration();
}
const carrier = { kind: 'ssh' as const, address: '192.0.2.7', user: 'admin',
    hostKeyEvidence: { hostKey: `192.0.2.7 ${key}`, fingerprint: computeSshHostKeyFingerprint(key.split(' ')[1]!) } };

async function trust(managedId: string, answer: 'approve' | 'decline' | 'cancel', delegated = true, serverAuthorization = delegated) {
    const lifetime = createPluginInvocationLifetime();
    const prompts: string[] = [];
    const correlation = { homeId: 'home', managedId, requestId: 'request', expectedIntentRevision: 0,
        controller: { machineId: 'controller', installationId: 'installation' } };
    let ready!: (taskId: string) => void;
    const taskId = new Promise<string>(resolve => { ready = resolve; });
    const owner = getLiveSystemTasksRunnerAdapter();
    let responseFailure: unknown;
    const service = createMachineProvisionersInvocationService({ seed: {
        plugin: { id: 'fixture.compute', version: '0' }, contribution: { id: 'bootstrap', qualifiedId: 'fixture.compute/bootstrap' },
        occurrenceId: 'occurrence', correlationId: 'request', surface: 'plugin', signal: lifetime.signal,
        isOccurrenceCurrent: () => true, retainCleanup: lifetime.retainCleanup,
        managedSshHostTrust: observed => runManagedSessionSshTrust({ correlation, carrier: observed,
            signal: lifetime.signal, operationId: 'operation', onTask: task => { ready(task.taskId); },
            ...(delegated ? { requesterEnrollmentAccountId: 'member' } : {}),
            onPrompt: prompt => {
                if (!prompt) return;
                prompts.push(prompt.kind);
                if (answer === 'cancel') { void lifetime.complete(); return; }
                void taskId.then(async id => {
                    try { await owner.respond({ taskId: id, answer: { trusted: answer === 'approve' }, ...(serverAuthorization ? {
                    responseAuthorization: { kind: 'machine.managedInstallation.serverOrigin', actorAccountId: 'owner', custodianAccountId: 'owner',
                        purpose: { ...correlation, operationId: 'operation', taskId: id, expectedPromptKind: prompt.kind, phase: 'answer' } } } : {}) }); }
                    catch (error) { responseFailure = error; await lifetime.complete(); }
                });
            } }),
    } })!;
    try { await service.establishSshHostTrust(carrier); }
    catch (error) { throw responseFailure ?? error; }
    finally { await lifetime.complete(); }
    return { prompts, correlation };
}

it('establishes trust before guest work and lets the existing Session owner consume the same persisted decision', async () => {
    await home();
    const approved = await trust('clone-a', 'approve');
    expect(approved.prompts).toEqual(['ssh.trustHost']);
    await expect(prepareManagedSessionSshTrust({ correlation: approved.correlation,
        carrier: { ...carrier, credentialRef: { kind: 'shared_resource', resourceId: 'key' } } })).resolves.toHaveProperty('knownHostsPath');
    expect((await trust('clone-a', 'approve')).prompts).toEqual([]);
    expect((await trust('clone-b', 'approve')).prompts).toEqual(['ssh.trustHost']);
});

it('accepts the authenticated custodian answer for trust attached to a finite operation', async () => {
    await home();
    expect((await trust('owner-clone', 'approve', false)).prompts).toEqual(['ssh.trustHost']);
});

it('requires the existing Home authorization for a delegated enrollment answer', async () => {
    await home();
    await expect(trust('member-clone', 'approve', true, false)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(prepareManagedSessionSshTrust({ correlation: { homeId: 'home', managedId: 'member-clone' },
        carrier: { ...carrier, credentialRef: { kind: 'shared_resource', resourceId: 'key' } } }))
        .rejects.toMatchObject({ code: 'ssh_host_trust_required' });
});

it.each(['decline', 'cancel'] as const)('does not retain first-use approval on %s', async answer => {
    await home();
    await expect(trust('clone-a', answer)).rejects.toMatchObject(answer === 'decline'
        ? { code: 'host_trust_declined' } : { name: expect.any(String) });
    await expect(prepareManagedSessionSshTrust({ correlation: { homeId: 'home', managedId: 'clone-a' },
        carrier: { ...carrier, credentialRef: { kind: 'shared_resource', resourceId: 'key' } } }))
        .rejects.toMatchObject({ code: 'ssh_host_trust_required' });
});

it('scopes preparation trust to its admitted operation and persists only a real approved answer', async () => {
    await home();
    const correlation = { homeId: 'home', presetId: 'preset', operationId: 'prepare-a' };
    const prompts: string[] = [];
    const prompt = async (request: Readonly<{ kind: string }>) => { prompts.push(request.kind); return { trusted: true }; };
    await expect(runPreparedPresetSshHostTrust({ correlation, carrier, prompt: async () => ({ trusted: false }) }))
        .rejects.toMatchObject({ code: 'host_trust_declined' });
    await runPreparedPresetSshHostTrust({ correlation, carrier, prompt });
    await runPreparedPresetSshHostTrust({ correlation, carrier, prompt });
    expect(prompts).toEqual(['ssh.trustHost']);
    await runPreparedPresetSshHostTrust({ correlation: { ...correlation, operationId: 'prepare-b' }, carrier, prompt });
    expect(prompts).toEqual(['ssh.trustHost', 'ssh.trustHost']);
});
