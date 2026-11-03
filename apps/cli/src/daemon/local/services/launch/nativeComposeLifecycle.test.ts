import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { canReadIncompleteSecretMaskingForHost } from '@/plugins/runtime/invocation/services/managedServiceNativeLogs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createNativeComposeLifecycle } from './nativeComposeLifecycle';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';

describe('Compose exact native resource lifetime', () => {
    afterEach(() => vi.useRealTimers());

    it('samples one admitted full-container accounting batch on demand and leaves unknown metrics null', async () => {
        const ids = ['a'.repeat(64), 'b'.repeat(64)];
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const requests: string[][] = [];
        let release!: () => void;
        let entered!: () => void;
        let pending = new Promise<void>(resolve => { release = resolve; });
        const sampling = new Promise<void>(resolve => { entered = resolve; });
        let failure: unknown;
        let stats: unknown[] = [
            { ID: ids[0], CPUPerc: '12.5%', MemUsage: '2MiB / 1GiB' },
            { ID: ids[1], CPUPerc: '--', MemUsage: '-- / --' },
        ];
        const capture = createNativeComposeLifecycle({ args, engineId: 'accounting-test',
            environment: { composeService: 'worker', containerIds: ids }, io: {
                async events() { return { async dispose() {} }; },
                async run(request) {
                    requests.push([...request.args]);
                    if (request.args.includes('stats')) {
                        entered(); await pending;
                        if (failure) throw failure;
                        return { exitCode: 0, stdout: stats.map(row => JSON.stringify(row)).join('\n') };
                    }
                    return { exitCode: 0, stdout: JSON.stringify(ids.map(id => ({ ...container(id[0], 'running'), Id: id }))) };
                },
            } });
        capture.bindLaunch({ command: '/docker', args, cwd: '/release', env: {}, release() {} });
        const observation = await capture.lifecycle.observe!(() => {});
        try {
            for (let index = 0; index < 100; index++) await capture.lifecycle.inspect();
            expect(requests.filter(request => request.includes('stats'))).toHaveLength(0);
            const first = capture.lifecycle.readAccounting!();
            const second = capture.lifecycle.readAccounting!();
            await sampling;
            expect(requests.filter(request => request.includes('stats'))).toEqual([
                ['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}', ...ids],
            ]);
            release();
            const expected = { kind: 'sample', samples: [
                { nativeResourceId: ids[0], cpuPercent: 12.5, memoryBytes: 2097152 },
                { nativeResourceId: ids[1], cpuPercent: null, memoryBytes: null },
            ] };
            expect(await first).toEqual(expected);
            expect(await second).toEqual(expected);
            expect(capture.lifecycle.runtimeFacts!().accounting?.memoryBytes).toBeUndefined();
            pending = Promise.resolve();
            expect(await capture.lifecycle.readAccounting!()).toEqual(expected);
            expect(requests.filter(request => request.includes('stats'))).toHaveLength(2);
            stats = ids.map(id => ({ ID: id, CPUPerc: '0%', MemUsage: '2MiB / 1GiB' }));
            await capture.lifecycle.readAccounting!();
            expect(capture.lifecycle.runtimeFacts!().accounting).toMatchObject({ memoryBytes: 4194304 });
            stats = [{ ID: 'c'.repeat(64), CPUPerc: '99%', MemUsage: '100MiB / 1GiB' }];
            expect(await capture.lifecycle.readAccounting!()).toEqual({ kind: 'unavailable', reason: 'unavailable' });
            expect(capture.lifecycle.runtimeFacts!().accounting?.memoryBytes).toBeUndefined();
            stats = [];
            expect(await capture.lifecycle.readAccounting!()).toEqual({ kind: 'sample', samples: ids.map(nativeResourceId => ({
                nativeResourceId, cpuPercent: null, memoryBytes: null,
            })) });
            failure = new PluginError({ code: 'plugin_exec_termination_incomplete', message: 'Native query custody is unsettled' });
            await expect(capture.lifecycle.readAccounting!()).rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete' });
        } finally { release(); await observation.dispose(); }
        expect(await capture.lifecycle.readAccounting!()).toEqual({ kind: 'unavailable', reason: 'unavailable' });
        expect(requests.filter(request => request.includes('stats'))).toHaveLength(6);
    });

    it('shares one proven engine subscription and outage recovery across 120 admitted services', async () => {
        vi.useFakeTimers();
        const requests: string[][] = [];
        const subscriptions: Array<Readonly<{ event(value: unknown): void; disconnected(): void }>> = [];
        let available = true;
        let unhealthy = false;
        let releases = 0;
        const ids = Array.from({ length: 120 }, (_, index) => index.toString(16).padStart(64, '0'));
        const io = { async run(request: Parameters<ProjectNativeToolchainIo['run']>[0]) {
            requests.push([...request.args]);
            const selected = ids.filter(id => request.args.includes(id));
            return { exitCode: 0, stdout: JSON.stringify(selected.map(id => ({
                ...container('a', 'running'), Id: id,
                Config: { Labels: { 'com.docker.compose.project': 'happier-test', 'com.docker.compose.service': `service-${ids.indexOf(id)}` } },
                State: { Status: 'running', StartedAt: '2026-10-30T12:00:00.000Z', Pid: 10000 + ids.indexOf(id), Health: { Status: unhealthy && id === ids[0] ? 'unhealthy' : 'healthy' } },
                RestartCount: 0, HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } },
            }))) };
        } };
        const events = async (request: Readonly<{ event(value: unknown): void; disconnected(): void; signal: AbortSignal }>) => {
            subscriptions.push(request);
            if (!available) throw new Error('engine disconnected');
            return { async dispose() { releases += 1; } };
        };
        const host = createManagedServiceProcessSupervisorHost({});
        const supervisor = host.bind({ kind: 'project', isOccurrenceCurrent: () => true });
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const captures = ids.map((id, index) => {
            const input = { args, io: { ...io, events }, engineId: 'engine-shared-count-test', environment: { composeService: `service-${index}`, containerIds: [id] } };
            const capture = createNativeComposeLifecycle(input);
            capture.bindLaunch({ command: '/docker', args, cwd: '/release', env: {},
                secretRedactionLease: createProviderRedactionLease({ values: [] }), release() {} });
            return capture;
        });
        const handles = await Promise.all(captures.map((capture, index) => supervisor.supervise({
            id: `engine-service-${index}`, watchdog: { intervalMs: 5000, missedIntervals: 2 },
            mode: { kind: 'native', observationOnly: true, builtinLifecycle: capture.lifecycle, releaseObservation: async () => {} },
        })));
        try {
            expect(subscriptions).toHaveLength(1);
            expect(captures[0].lifecycle.runtimeFacts!().accounting).toEqual({ startedAtMs: Date.parse('2026-10-30T12:00:00.000Z') });
            expect(captures[0].lifecycle.runtimeFacts!().healthSince).toBeUndefined();
            expect(requests).toHaveLength(1);
            expect(requests[0].filter(arg => ids.includes(arg))).toHaveLength(120);
            const evidence = captures[0].lifecycle.nativeContainers?.();
            expect(evidence).toEqual([{ id: ids[0], composeProject: 'happier-test', service: 'service-0', pid: 10000,
                restartCount: 0, restartPolicy: { name: 'unless-stopped', maximumRetryCount: 0 } }]);
            for (let index = 0; index < 100; index += 1) expect(captures[0].lifecycle.nativeContainers?.()).toBe(evidence);
            expect(requests).toHaveLength(1);
            expect(handles.every(handle => handle.snapshot().state === 'healthy')).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
            requests.length = 0;
            subscriptions[0].event({ Type: 'container', Action: 'start', Actor: { ID: 'f'.repeat(64) } });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(requests).toHaveLength(0);
            unhealthy = true;
            for (let index = 0; index < 100; index += 1) subscriptions[0].event({ Type: 'container', Action: 'health_status: unhealthy', time: 1793361605, timeNano: 1793361605123000000, Actor: { ID: ids[0] } });
            await vi.advanceTimersByTimeAsync(0);
            expect(requests.filter(request => request.includes('inspect'))).toHaveLength(1);
            expect(handles[0].snapshot().state).toBe('unhealthy');
            expect(captures[0].lifecycle.runtimeFacts!().healthSince).toBe(1793361605123);
            expect(requests.filter(request => request.includes('logs'))).toHaveLength(1);
            expect(handles.slice(1).every(handle => handle.snapshot().state === 'healthy')).toBe(true);
            const failed = handles[0].snapshot();
            const unchanged = handles[1].snapshot();
            requests.length = 0;
            subscriptions[0].event({ Type: 'container', Action: 'health_status: unhealthy', Actor: { ID: ids[0] } });
            await vi.advanceTimersByTimeAsync(0);
            expect(requests.filter(request => request.includes('inspect'))).toHaveLength(1);
            expect(requests.filter(request => request.includes('logs'))).toHaveLength(0);
            expect(handles[0].snapshot()).toBe(failed);
            expect(handles[1].snapshot()).toBe(unchanged);
            unhealthy = false;
            subscriptions[0].event({ Type: 'container', Action: 'health_status: healthy', Actor: { ID: ids[0] } });
            await vi.advanceTimersByTimeAsync(0);
            const transitions: string[] = [];
            const listener = handles[0].observe!(snapshot => { transitions.push(`${snapshot.nativePhase}:${snapshot.state}`); });
            transitions.length = 0;
            requests.length = 0;
            try {
                // A quick native restart cannot disappear behind its later
                // healthy inspect; the supervisor consumes both facts in order.
                subscriptions[0].event({ Type: 'container', Action: 'restart', Actor: { ID: ids[0] } });
                await vi.advanceTimersByTimeAsync(0);
                expect(transitions.filter((value, index) => value !== transitions[index - 1]))
                    .toEqual(['unknown:unhealthy', 'running:healthy']);
                expect(requests.filter(request => request.includes('inspect'))).toHaveLength(1);
                expect(requests.filter(request => request.includes('logs'))).toHaveLength(0);
                expect(vi.getTimerCount()).toBe(0);
            } finally { listener.dispose(); }
            requests.length = 0;
            available = false;
            subscriptions[0].disconnected();
            await vi.advanceTimersByTimeAsync(0);
            expect(handles.every(handle => handle.snapshot().nativePhase === 'unknown')).toBe(true);
            expect(captures[0].lifecycle.nativeContainers?.()).toBeNull();
            expect(captures[0].lifecycle.runtimeFacts!().healthSince).toBeUndefined();
            expect(requests.filter(request => request.includes('logs'))).toHaveLength(0);
            requests.length = 0;
            await vi.advanceTimersByTimeAsync(15_000);
            expect(subscriptions).toHaveLength(4);
            expect(requests).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(1);
            available = true;
            unhealthy = false;
            await vi.advanceTimersByTimeAsync(5000);
            expect(subscriptions).toHaveLength(5);
            expect(requests.filter(request => request.includes('inspect'))).toHaveLength(1);
            expect(handles.every(handle => handle.snapshot().state === 'healthy')).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
            available = false;
            subscriptions[4].disconnected();
            await vi.advanceTimersByTimeAsync(0);
            expect(vi.getTimerCount()).toBe(1);
        } finally {
            await Promise.all(handles.map(handle => handle.dispose()));
        }
        expect(releases).toBe(2);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(subscriptions).toHaveLength(5);
    });

    it('keeps person Environment logs readable with incomplete masking while automation refuses and the app keeps running', async () => {
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const requests: string[][] = [];
        let diagnostic = 'retired-secret-sentinel PORT=3000';
        const io: Pick<ProjectNativeToolchainIo, 'run'> = { async run(request) {
            requests.push([...request.args]);
            return { exitCode: 0, stdout: request.args.includes('ps') ? 'a'.repeat(64)
                : request.args.includes('inspect') ? JSON.stringify([container('a', 'running')])
                    : diagnostic };
        } };
        const control = createNativeComposeLifecycle({ args, io,
            environment: { composeService: 'worker', containerIds: ['a'.repeat(64)] } });
        const launch = { command: '/docker', args, cwd: '/release', env: {}, release() {} };
        control.bindLaunch(launch);

        expect(await control.lifecycle.inspect()).toMatchObject({ phase: 'running' });
        await expect(control.lifecycle.logs?.({ kind: 'read', maxBytes: 8192 }))
            .rejects.toMatchObject({ code: 'secret_redaction_unavailable' });
        expect(requests.filter(request => request.includes('logs'))).toHaveLength(0);
        // A plugin claiming person authority is not the person's own host read.
        await expect(control.lifecycle.logs?.({ kind: 'read', maxBytes: 8192,
            ...(canReadIncompleteSecretMaskingForHost({ surface: 'plugin', authority: 'present_user' })
                ? { allowIncompleteSecretMasking: true as const } : {}) }))
            .rejects.toMatchObject({ code: 'secret_redaction_unavailable' });
        expect(requests.filter(request => request.includes('logs'))).toHaveLength(0);
        const personPage = await control.lifecycle.logs?.({ kind: 'read', maxBytes: 8192,
            ...(canReadIncompleteSecretMaskingForHost({ surface: 'cli', authority: 'present_user' })
                ? { allowIncompleteSecretMasking: true as const } : {}) });
        expect(personPage).toMatchObject({ kind: 'page', page: { secretMasking: 'incomplete',
            text: diagnostic } });
        expect(JSON.stringify(personPage)).toContain('retired-secret-sentinel PORT=3000');
        const readsAfterPerson = requests.filter(request => request.includes('logs')).length;
        await expect(control.lifecycle.logs?.({ kind: 'read', maxBytes: 8192 }))
            .rejects.toMatchObject({ code: 'secret_redaction_unavailable' });
        expect(requests.filter(request => request.includes('logs'))).toHaveLength(readsAfterPerson);
        expect(await control.lifecycle.inspect()).toMatchObject({ phase: 'running' });
        expect(requests.some(request => request.includes('stop') || request.includes('down'))).toBe(false);

        // Explicit empty custody proves this generation had no delivered secrets.
        diagnostic = 'plain diagnostic PORT=3000';
        const secretRedactionLease = createProviderRedactionLease({ values: [] });
        control.bindLaunch({ ...launch, secretRedactionLease });
        expect(await control.lifecycle.logs?.({ kind: 'read', maxBytes: 8192 }))
            .toMatchObject({ kind: 'page', page: { text: 'plain diagnostic PORT=3000' } });
        secretRedactionLease.close();
        const reads = requests.filter(request => request.includes('logs')).length;
        await expect(control.lifecycle.logs?.({ kind: 'read', maxBytes: 8192 }))
            .rejects.toMatchObject({ code: 'secret_redaction_unavailable' });
        expect(requests.filter(request => request.includes('logs'))).toHaveLength(reads);
    });

    it('observes and controls only the admitted Environment service without reactivating its project', async () => {
        const requests: string[][] = [];
        let dbState = 'running';
        let dbHealth = 'unhealthy';
        const web = { ...container('a', 'running'), Config: { Labels: {
            'com.docker.compose.project': 'happier-test', 'com.docker.compose.service': 'web',
        } }, State: { Status: 'running', Health: { Status: 'healthy' } } };
        const db = () => ({ ...container('b', dbState), Config: { Labels: {
            'com.docker.compose.project': 'happier-test', 'com.docker.compose.service': 'db',
        } }, State: { Status: dbState, Health: { Status: dbHealth } } });
        const io: Pick<ProjectNativeToolchainIo, 'run'> = { async run(request) {
            const args = [...request.args];
            requests.push(args);
            const rows = args.includes('label=com.docker.compose.service=web') ? [web]
                : args.includes('label=com.docker.compose.service=db') ? [db()] : [web, db()];
            // A retained Compose file may require app substitutions. Existing
            // generation controls must not parse it or need that overlay again.
            if (args.includes('compose')) return { exitCode: 1, stdout: '', stderr: 'SECRET is required' };
            if (args.includes('stop')) dbState = 'exited';
            if (args.includes('start') || args.includes('restart')) { dbState = 'running'; dbHealth = 'healthy'; }
            return { exitCode: 0, stdout: args.includes('ps') ? rows.map(row => row.Id).join('\n')
                : args.includes('inspect') ? JSON.stringify([web, db()].filter(row => args.includes(row.Id)))
                    : args.includes('logs') ? args.includes('b'.repeat(64)) ? 'db diagnostic' : 'web diagnostic' : '' };
        } };
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const capture = (composeService: string) => {
            const control = createNativeComposeLifecycle({ args, io, environment: { composeService,
                containerIds: [(composeService === 'web' ? 'a' : 'b').repeat(64)] } });
            control.bindLaunch({ command: '/docker', args, cwd: '/release', env: {},
                secretRedactionLease: createProviderRedactionLease({ values: [] }), release() {} });
            return control.lifecycle;
        };
        const webLifecycle = capture('web');
        const dbLifecycle = capture('db');
        expect(await webLifecycle.inspect()).toMatchObject({ phase: 'running', readiness: 'ready', displayName: 'happier-test' });
        expect(await dbLifecycle.inspect()).toMatchObject({ phase: 'running', readiness: 'not_ready' });
        expect(await webLifecycle.logs?.({ kind: 'read', maxBytes: 8192 })).toMatchObject({ kind: 'page', page: { text: 'web diagnostic' } });
        expect(await dbLifecycle.logs?.({ kind: 'read', maxBytes: 8192 })).toMatchObject({ kind: 'page', page: { text: 'db diagnostic' } });
        await expect(dbLifecycle.prepareStart?.()).rejects.toMatchObject({ code: 'deployment_generation_required' });
        expect(await dbLifecycle.stop()).toEqual({ status: 'stopped' });
        expect(await dbLifecycle.start?.()).toMatchObject({ phase: 'running', readiness: 'ready' });
        expect(await dbLifecycle.restart?.()).toMatchObject({ phase: 'running', readiness: 'ready' });
        expect(requests.filter(request => ['start', 'restart', 'stop'].includes(request[0]))).toEqual([
            ['stop', 'b'.repeat(64)], ['start', 'b'.repeat(64)], ['restart', 'b'.repeat(64)],
        ]);
        expect(requests.some(request => request.includes('compose'))).toBe(false);
        expect(requests.some(request => request.includes('up') || request.includes('down'))).toBe(false);
        expect(await webLifecycle.inspect()).toMatchObject({ phase: 'running', readiness: 'ready' });
    });

    function fixture() {
        let rows: unknown = [container('a', 'running')];
        let code = 0;
        const requests: string[][] = [];
        // Docker process IO is the system boundary; codec and native decisions remain real.
        const io: Pick<ProjectNativeToolchainIo, 'run'> = { async run(request) {
            requests.push([...request.args]);
            return { exitCode: code, stdout: request.args.includes('ps') ? Array.isArray(rows) ? rows.map(row => row.Id).join('\n') : ''
                : request.args.includes('inspect') ? JSON.stringify(rows) : 'native output' };
        } };
        const control = createNativeComposeLifecycle({ args: ['compose', '--project-name', 'happier-test', '--file', '/root/compose.yaml', 'up', '--detach', 'worker'], io });
        control.bindLaunch({ command: '/docker', args: ['compose', '--project-name', 'happier-test', '--file', '/root/compose.yaml', 'up', '--detach', 'worker'], cwd: '/root', env: {}, release() {} });
        return { control, requests, setRows(value: unknown) { rows = value; }, fail() { code = 1; }, recover() { code = 0; } };
    }
    function container(id: string, state: string, ports: unknown = {}) {
        return { Id: id.repeat(64), Config: { Labels: { 'com.docker.compose.project': 'happier-test', 'com.docker.compose.service': 'worker' } },
            State: { Status: state }, NetworkSettings: { Ports: ports } };
    }
    it('reads a bounded diagnostic from admitted container IDs without rediscovering resources', async () => {
        const h = fixture();
        await h.control.lifecycle.inspect();
        h.requests.length = 0;
        expect(await h.control.lifecycle.logs?.({ kind: 'read', maxBytes: 8_192 })).toMatchObject({ kind: 'page', page: { text: 'native output' } });
        expect(h.requests).toEqual([['logs', '--tail', '8192', 'a'.repeat(64)]]);
    });
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
    it('retains unobserved recovery until the incumbent can be observed and stopped', async () => {
        const neverStarted = fixture();
        neverStarted.fail();
        expect(await neverStarted.control.lifecycle.inspect()).toMatchObject({ phase: 'unknown' });
        expect(await neverStarted.control.lifecycle.stop()).toEqual({ status: 'termination_incomplete' });
        expect(await neverStarted.control.lifecycle.inspect()).toMatchObject({ phase: 'unknown' });
        expect(neverStarted.requests.some(args => args.includes('stop'))).toBe(false);
        neverStarted.recover();
        expect(await neverStarted.control.lifecycle.stop()).toEqual({ status: 'termination_incomplete' });
        expect(neverStarted.requests).toContainEqual(['stop', 'a'.repeat(64)]);
        neverStarted.setRows([container('a', 'exited')]);
        expect(await neverStarted.control.lifecycle.stop()).toEqual({ status: 'stopped' });
        const captured = fixture();
        expect(await captured.control.lifecycle.inspect()).toMatchObject({ phase: 'running' });
        captured.fail();
        expect(await captured.control.lifecycle.stop()).toEqual({ status: 'termination_incomplete' });
        expect(await captured.control.lifecycle.inspect()).toMatchObject({ phase: 'unknown' });
    });
    it('clears only a proved-empty admission that never launched when observation is lost', async () => {
        const h = fixture();
        h.setRows([]);
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'stopped' });
        h.fail();
        expect(await h.control.lifecycle.stop()).toEqual({ status: 'stopped' });
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'stopped' });
        const started = fixture();
        started.setRows([]);
        await started.control.lifecycle.inspect();
        started.control.lifecycle.markStarted?.();
        started.fail();
        expect(await started.control.lifecycle.stop()).toEqual({ status: 'termination_incomplete' });
    });
    it('discovers an incumbent during Stop before treating a fresh capture as empty', async () => {
        const h = fixture();
        expect(await h.control.lifecycle.stop()).toEqual({ status: 'termination_incomplete' });
        expect(h.requests).toContainEqual(['stop', 'a'.repeat(64)]);
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'running' });
    });
    it('withdraws an empty witness when a subsequent nonempty listing cannot be decoded', async () => {
        const h = fixture();
        h.setRows([]);
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'stopped' });
        h.setRows([container('invalid', 'running')]);
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'unknown' });
        h.fail();
        expect(await h.control.lifecycle.stop()).toEqual({ status: 'termination_incomplete' });
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
        const io: Pick<ProjectNativeToolchainIo, 'run'> = { async run(request) {
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
        const yaml = 'services:\n  worker:\n    image: busybox:1.37\n    command: ["sh", "-c", "echo fx16-out; echo fx16-err >&2; mkdir -p /www; echo fx16-http > /www/index.html; httpd -f -p 8080 -h /www & trap \'\' TERM; wait"]\n    ports: ["127.0.0.1::8080"]\n';
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
            if (observation.phase !== 'running') throw new Error(`Native fixture did not stay running: ${await first.lifecycle.logs?.({ kind: 'read', maxBytes: 8_192 })}`);
            expect(observation).toMatchObject({ phase: 'running', readiness: 'not_reported' });
            expect(observation.endpoint).toBeTruthy();
            await expect(fetch(observation.endpoint!).then(response => response.text())).resolves.toContain('fx16-http');
            expect(await first.lifecycle.logs?.({ kind: 'read', maxBytes: 8_192 })).toMatchObject({ kind: 'page', page: { text: expect.stringContaining('fx16-out') } });
            expect(await first.lifecycle.logs?.({ kind: 'read', maxBytes: 8_192 })).toMatchObject({ kind: 'page', page: { text: expect.stringContaining('fx16-err') } });
            const cancelled = new AbortController();
            // Docker's exact-resource kill event proves Stop reached the daemon
            // before cancellation. The fixture ignores TERM, using Docker's own
            // grace period (no new product timeout or cancellation polling).
            const events = execFile(command, [...prefix, 'events', '--since', new Date().toISOString(),
                '--filter', `container=${id}`, '--filter', 'event=kill', '--format', '{{json .}}']);
            const eventsExited = new Promise<void>(resolve => {
                events.once('exit', () => resolve());
                events.once('error', () => resolve());
            });
            let nativeKillObserved = false;
            let eventOutput = '';
            events.stdout?.on('data', chunk => {
                eventOutput += String(chunk);
                if (eventOutput.includes('\n')) { nativeKillObserved = true; cancelled.abort(); }
            });
            try {
                await expect(first.lifecycle.stop({ signal: cancelled.signal })).rejects.toThrow();
                expect(nativeKillObserved).toBe(true);
            } finally {
                events.kill('SIGTERM');
                await eventsExited;
            }
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
