import { expect, it } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import { buildRemoteSshManageHostSystemTaskSpec } from '@/components/systemTasks/specs/remoteSsh/buildRemoteSshManageHostSystemTaskSpec';
import { startAdmittedRemoteHostSystemTask } from './remoteHostTaskOperations';

it('cancels the accepted task if its captured Account retires before runner acceptance returns', async () => {
    const acceptance = createDeferred<string>();
    const canceled: string[] = [];
    // Only the process bridge is replaced; task admission/state remain real.
    const runner = createSystemTaskRunner({ mode: 'tauri', bridge: {
        start: () => acceptance.promise,
        subscribe: async () => () => {},
        cancel: async taskId => { canceled.push(taskId); },
        respond: async () => {},
    } });
    const spec = buildRemoteSshManageHostSystemTaskSpec({ action: 'testConnection', channel: 'stable',
        sshTarget: 'dev@example.test', sshPort: '', sshAuth: 'agent', identityFilePath: '', identityPrivateKey: '',
        sshConfigFilePath: '', sshPassword: '', knownHostsMode: 'app', serviceMode: 'user',
        relayRuntime: { channel: 'stable', mode: 'user' } });
    let current = true;
    const receipt = startAdmittedRemoteHostSystemTask({ runner,
        assertCurrent: () => { if (!current) throw new Error('account_retired'); } }, spec);
    current = false;
    acceptance.resolve('accepted-task');
    await expect(receipt).rejects.toThrow('account_retired');
    expect(runner.getSnapshot('accepted-task')).toMatchObject({ cancelRequested: true, status: 'canceling' });
    expect(canceled).toEqual(['accepted-task']);
});

it('retains a native task accepted after its caller stops observing while Account authority is still current', async () => {
    const acceptance = createDeferred<string>();
    const canceled: string[] = [];
    const observer = new AbortController();
    const runner = createSystemTaskRunner({ mode: 'tauri', bridge: {
        start: () => acceptance.promise, subscribe: async () => () => {},
        cancel: async taskId => { canceled.push(taskId); }, respond: async () => {},
    } });
    const spec = buildRemoteSshManageHostSystemTaskSpec({ action: 'testConnection', channel: 'stable',
        sshTarget: 'dev@example.test', sshPort: '', sshAuth: 'agent', identityFilePath: '', identityPrivateKey: '',
        sshConfigFilePath: '', sshPassword: '', knownHostsMode: 'app', serviceMode: 'user',
        relayRuntime: { channel: 'stable', mode: 'user' } });
    const admission = { runner, signal: observer.signal,
        assertCurrent: () => observer.signal.throwIfAborted(), assertAccountCurrent: () => {},
    };
    const receipt = startAdmittedRemoteHostSystemTask(admission, spec);
    observer.abort();
    acceptance.resolve('accepted-task');
    await expect(receipt).resolves.toEqual({ status: 'task_started', taskId: 'accepted-task' });
    expect(runner.getSnapshot('accepted-task')).toMatchObject({ cancelRequested: false, status: 'running' });
    expect(canceled).toEqual([]);
});
