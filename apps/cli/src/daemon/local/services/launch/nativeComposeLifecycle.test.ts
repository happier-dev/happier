import { describe, expect, it } from 'vitest';
import { createNativeComposeLifecycle } from './nativeComposeLifecycle';
import type { ProjectNativeEnvironmentIo } from '@/workspaces/environment/produceProjectNativeEnvironment';

describe('Compose exact native resource lifetime', () => {
    function fixture() {
        let rows: unknown = [container('a', 'running')];
        let code = 0;
        const requests: string[][] = [];
        // Docker process IO is the system boundary; codec and native decisions remain real.
        const io: Pick<ProjectNativeEnvironmentIo, 'run'> = { async run(request) {
            requests.push([...request.args]);
            return { exitCode: code, stdout: request.args.includes('ps') ? Array.isArray(rows) ? rows.map(row => row.Id).join('\n') : ''
                : request.args.includes('inspect') ? JSON.stringify(rows) : 'native output' };
        } };
        const control = createNativeComposeLifecycle({ args: ['compose', '--project-name', 'happier-test', '--file', '/root/compose.yaml', 'up', '--detach', 'worker'], io });
        control.bindLaunch({ command: '/docker', args: ['compose', '--project-name', 'happier-test', '--file', '/root/compose.yaml', 'up', '--detach', 'worker'], cwd: '/root', env: {}, release() {} });
        return { control, requests, setRows(value: unknown) { rows = value; }, fail() { code = 1; } };
    }
    function container(id: string, state: string, ports: unknown = {}) {
        return { Id: id.repeat(64), Config: { Labels: { 'com.docker.compose.project': 'happier-test', 'com.docker.compose.service': 'worker' } },
            State: { Status: state }, NetworkSettings: { Ports: ports } };
    }
    it('recovers the incumbent identity, treats unavailable inspection as unknown, and never stops a replacement', async () => {
        const h = fixture();
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'running', endpoint: null });
        h.setRows([container('b', 'running')]);
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'unknown' });
        expect(await h.control.lifecycle.stop()).toEqual({ status: 'termination_incomplete' });
        expect(h.requests.some(args => args.includes('stop'))).toBe(false);
        h.fail();
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'unknown' });
    });
    it('does not equate an accepted Stop with termination, and preserves portless observation', async () => {
        const h = fixture();
        await h.control.lifecycle.inspect();
        expect(await h.control.lifecycle.stop()).toEqual({ status: 'termination_incomplete' });
        expect(h.requests).toContainEqual(['stop', 'a'.repeat(64)]);
        h.setRows([container('a', 'exited')]);
        expect(await h.control.lifecycle.stop()).toEqual({ status: 'stopped' });
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'stopped', endpoint: null });
        expect(h.requests.every(args => !args.includes('--file'))).toBe(true);
    });
    it('retires only proved-stopped IDs before replacement and observes optional published endpoints', async () => {
        const h = fixture();
        await h.control.lifecycle.inspect();
        await expect(h.control.lifecycle.prepareStart?.()).rejects.toThrow('native_service_stop_unconfirmed');
        h.setRows([container('a', 'exited')]);
        await h.control.lifecycle.prepareStart?.();
        h.setRows([container('b', 'running', { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '32000' }] })]);
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'running', endpoint: 'http://127.0.0.1:32000', readiness: 'not_reported' });
        h.setRows([container('b', 'running', { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '32000' }], '8081/tcp': [{ HostIp: '127.0.0.1', HostPort: '32001' }] })]);
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'running', endpoint: null });
    });
});
