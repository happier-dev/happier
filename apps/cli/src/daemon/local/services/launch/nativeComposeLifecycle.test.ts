import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
        h.setRows([container('b', 'running', { '8080/tcp': [{ HostIp: '::1', HostPort: '32000' }] })]);
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'running', endpoint: 'http://[::1]:32000' });
        h.setRows([container('b', 'running', { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '32000' }], '8081/tcp': [{ HostIp: '127.0.0.1', HostPort: '32001' }] })]);
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'running', endpoint: null });
    });

    it.skipIf(!process.env.FX16_DOCKER_PATH)('qualifies installed detached survival, recovery, cancellation, logs, endpoints and exact Stop', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-fx16-compose-'));
        const project = `happier-fx16-${randomUUID()}`;
        const file = join(root, 'compose.yaml');
        const command = process.env.FX16_DOCKER_PATH!;
        const prefix: unknown = JSON.parse(process.env.FX16_DOCKER_ARGS ?? '[]');
        if (!Array.isArray(prefix) || !prefix.every((arg): arg is string => typeof arg === 'string')) throw new Error('Invalid Docker fixture prefix');
        const execute = promisify(execFile);
        // Installed OS process IO is the boundary. Native codec/control remain production code.
        const io: Pick<ProjectNativeEnvironmentIo, 'run'> = { async run(request) {
            try {
                const result = await execute(request.command, [...request.args], { cwd: request.cwd, env: { ...process.env, ...request.env }, signal: request.signal });
                return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
            } catch (error) {
                if (request.signal?.aborted) throw error;
                if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'number'
                    && 'stdout' in error && typeof error.stdout === 'string' && 'stderr' in error && typeof error.stderr === 'string') {
                    return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
                }
                throw error;
            }
        } };
        const compose = ['compose', '--project-name', project, '--file', file];
        const args = [...compose, 'up', '--detach', 'worker'];
        const run = (args: readonly string[]) => io.run({ command, args: [...prefix, ...args], cwd: root, env: {} });
        const capture = () => {
            const control = createNativeComposeLifecycle({ args, io });
            control.bindLaunch({ command, args: [...prefix, ...args], cwd: root, env: {}, release() {} });
            return control;
        };
        const yaml = 'services:\n  worker:\n    image: busybox:1.37\n    command: ["sh", "-c", "echo fx16-out; echo fx16-err >&2; mkdir -p /www; echo fx16-http > /www/index.html; exec httpd -f -p 8080 -h /www"]\n    ports: ["127.0.0.1::8080"]\n';
        try {
            await writeFile(file, yaml);
            expect((await run([...compose, 'up', '--detach', 'missing'])).exitCode).not.toBe(0);
            const first = capture();
            expect(await first.lifecycle.inspect()).toMatchObject({ phase: 'stopped' });
            expect((await run(args)).exitCode).toBe(0);
            const list = ['ps', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'];
            const id = (await run(list)).stdout.trim();
            expect(id).toMatch(/^[a-f0-9]{64}$/u);
            const observation = await first.lifecycle.inspect();
            if (observation.phase !== 'running') throw new Error(`Native fixture did not stay running: ${await first.lifecycle.logs?.()}`);
            expect(observation).toMatchObject({ phase: 'running', readiness: 'not_reported' });
            expect(observation.endpoint).toBeTruthy();
            await expect(fetch(observation.endpoint!).then(response => response.text())).resolves.toContain('fx16-http');
            expect(await first.lifecycle.logs?.()).toContain('fx16-out');
            expect(await first.lifecycle.logs?.()).toContain('fx16-err');
            const cancelled = new AbortController();
            cancelled.abort();
            await expect(first.lifecycle.stop({ signal: cancelled.signal })).rejects.toThrow();
            expect(await first.lifecycle.inspect()).toMatchObject({ phase: 'running' });
            // Daemon replacement obtains a fresh codec, without repeating the starter.
            const recovered = capture();
            await rm(file);
            expect(await recovered.lifecycle.inspect()).toMatchObject({ phase: 'running', endpoint: observation.endpoint });
            expect((await run(list)).stdout.trim()).toBe(id);
            expect(await recovered.lifecycle.stop()).toEqual({ status: 'stopped' });
            expect((await run(list)).stdout.trim()).toBe(id);
            expect(await recovered.lifecycle.inspect()).toMatchObject({ phase: 'stopped' });
            // Down cleanup needs its fixture YAML; production Stop does not.
            await writeFile(file, yaml);
        } finally {
            await writeFile(file, yaml);
            const cleanup = await run([...compose, 'down', '--remove-orphans']);
            expect(cleanup.exitCode).toBe(0);
            expect((await run(['ps', '--all', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'])).stdout.trim()).toBe('');
            expect((await run(['network', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'])).stdout.trim()).toBe('');
            await rm(root, { recursive: true, force: true });
        }
    }, 120_000);
});
