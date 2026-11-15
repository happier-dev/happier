import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { MachineServiceAccountingV1Schema } from '@happier-dev/protocol';
import { MachineServiceNativeRuntimeFactsV1Schema } from '@happier-dev/protocol/local/services/nativeRuntimeFactsV1';
import { projectNativeComposeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createNativeComposeLifecycle } from './nativeComposeLifecycle';
import { openDockerEngineEvents } from './dockerEngineObservation';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { canReadIncompleteSecretMaskingForHost } from '@/plugins/runtime/invocation/services/managedServiceNativeLogs';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';

// Mirror the genuine process boundary: streamed output is sanitized before
// reaching its sink and is independent of the optional process result buffer.
function dockerLogOutput(request: Parameters<ProjectNativeToolchainIo['run']>[0], text: string) {
    request.output?.onChunk('stdout', Buffer.from(request.output.redaction.redact(text)));
    return { exitCode: 0, stdout: request.output ? '' : text };
}

describe('Compose exact native resource lifetime', () => {
    afterEach(() => vi.useRealTimers());

    it('reads redacted Configuration from the retained inspection without exporting environment values or issuing reads', async () => {
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const requests: string[][] = [];
        const row = { ...container('a', 'running'), Image: `sha256:${'b'.repeat(64)}`,
            Config: { Labels: { 'com.docker.compose.project': 'happier-test', 'com.docker.compose.service': 'worker' },
                Image: 'registry.example/worker:stable', Entrypoint: ['/entrypoint'], Cmd: ['serve', '--password=private-password'],
                Env: ['DATABASE_PASSWORD=private-password', 'PUBLIC_LABEL=private-label', 'DATABASE_PASSWORD=another-value'],
                Healthcheck: { Test: ['CMD-SHELL', 'check private-password'], Interval: 30_000_000_000 } },
            HostConfig: { NetworkMode: 'private-network' },
            NetworkSettings: { Ports: { '3000/tcp': null }, Networks: { 'private-network': {} } } };
        const hostRow = { ...container('c', 'running'),
            Config: { Labels: row.Config.Labels, Entrypoint: null, Cmd: null, Env: [], Healthcheck: { Test: ['NONE'] } },
            HostConfig: { NetworkMode: 'host' }, NetworkSettings: { Ports: {}, Networks: { host: {} } } };
        const capture = createNativeComposeLifecycle({ args, engineId: 'configuration-test',
            environment: { composeService: 'worker', containerIds: [row.Id, hostRow.Id], facts: {
                configuration: projectNativeComposeReview({ services: { worker: {} } }, '/release', value => value).services[0]!,
                containerImages: [],
            } }, io: {
                async events() { return { async dispose() {} }; }, async run(request) {
                    requests.push([...request.args]);
                    return { exitCode: 0, stdout: JSON.stringify([row, hostRow]) };
                },
            } });
        capture.bindLaunch({ command: '/docker', args, cwd: '/release', env: {},
            secretRedactionLease: createProviderRedactionLease({ values: ['private-password'] }), release() {} });
        const subscription = await capture.lifecycle.observe!(() => {});
        try {
            const facts = MachineServiceNativeRuntimeFactsV1Schema.parse(capture.lifecycle.runtimeFacts!());
            expect(facts.configuration?.ports).toContainEqual({ target: 3000, published: null, bindAddress: null, protocol: 'tcp' });
            expect(facts).toMatchObject({ configurationDetails: [{ nativeResourceId: row.Id,
                image: 'registry.example/worker:stable', imageDigest: row.Image,
                command: ['/entrypoint', 'serve', expect.not.stringContaining('private-password')],
                networks: ['private-network'], networkMode: 'private-network', variableNames: ['DATABASE_PASSWORD', 'PUBLIC_LABEL'],
                healthcheck: { test: ['CMD-SHELL', expect.not.stringContaining('private-password')], intervalNs: 30_000_000_000 },
            }, { nativeResourceId: hostRow.Id, networks: ['host'], networkMode: 'host', command: [], variableNames: [], healthcheck: null }] });
            expect(JSON.stringify(facts)).not.toMatch(/private-password|private-label|another-value/u);
            const reads = requests.length;
            for (let index = 0; index < 100; index++) capture.lifecycle.runtimeFacts!();
            expect(requests).toHaveLength(reads);
        } finally { await subscription.dispose(); }
    });

    it('lends the retained Docker transport and every observed replica name and network to Domain routing', async () => {
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const requests: Parameters<ProjectNativeToolchainIo['run']>[0][] = [];
        const rows = ['a', 'b'].map((id, index) => ({ ...container(id, 'running'),
            Name: `/happier-${'f'.repeat(64)}-worker-${index + 1}`, NetworkSettings: { Ports: {}, Networks: { 'generation-network': {} } } }));
        const capture = createNativeComposeLifecycle({ args, engineId: 'selected-engine',
            environment: { composeService: 'worker', containerIds: rows.map(row => row.Id) }, io: {
                async events() { return { async dispose() {} }; }, async run(request) {
                requests.push(request);
                if (request.args.includes('info')) return { exitCode: 0, stdout: JSON.stringify({ ID: 'selected-engine', OperatingSystem: 'Docker Desktop' }) };
                if (request.args.includes('ps')) return { exitCode: 0, stdout: rows.map(row => row.Id).join('\n') };
                if (request.args.includes('inspect')) return { exitCode: 0, stdout: JSON.stringify(rows) };
                return { exitCode: 0, stdout: 'native-result' };
            } } });
        capture.bindLaunch({ command: '/owned/docker', args: ['--context', 'selected', ...args], cwd: '/release', env: { DOCKER_CONFIG: '/owned/config' }, release() {} });
        const subscription = await capture.lifecycle.observe!(() => {});
        try {
        expect(capture.lifecycle.nativeContainers?.()).toMatchObject(rows.map(row => ({
            containerName: row.Id.slice(0, 12), networkNames: ['generation-network'],
        })));
        expect(capture.lifecycle.runtimeFacts!().configurationDetails).toBeUndefined();
        const docker = await capture.lifecycle.nativeDocker?.();
        expect(docker?.engineId).toBe('selected-engine');
        expect(docker?.engineKind).toBe('dockerDesktop');
        expect(await docker?.run(['container', 'ls'])).toMatchObject({ exitCode: 0, stdout: 'native-result' });
        expect(requests.at(-1)).toMatchObject({ command: '/owned/docker', args: ['--context', 'selected', 'container', 'ls'],
            cwd: '/release', env: { DOCKER_CONFIG: '/owned/config' } });
        } finally { await subscription.dispose(); }
    });

    it('observes exact retained-generation absence: rejects failed empty inspection and cached stopped proof', async () => {
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const id = 'a'.repeat(64);
        const requests: string[][] = [];
        let inspectUnavailable = true;
        let present = true;
        let engine = 'retained-engine';
        const capture = createNativeComposeLifecycle({ args, engineId: 'retained-engine',
            environment: { composeService: 'worker', containerIds: [id] }, io: { async run(request) {
                requests.push([...request.args]);
                if (request.args[0] === 'info') return { exitCode: 0, stdout: JSON.stringify({ ID: engine }) };
                if (request.args[0] === 'ps') return { exitCode: 0, stdout: present ? id : '' };
                if (request.args[0] === 'network' && request.args[1] === 'ls') return { exitCode: 0, stdout: '' };
                if (request.args[0] === 'container' && request.args[1] === 'rm') {
                    present = false;
                    return { exitCode: 0, stdout: '' };
                }
                if (inspectUnavailable) return { exitCode: 1, stdout: '[]' };
                return { exitCode: 0, stdout: JSON.stringify(present ? [container('a', 'exited')] : []) };
            } } });
        capture.bindLaunch({ command: '/docker', args, cwd: '/release', env: {}, release() {} });
        expect(await capture.lifecycle.remove!()).toEqual({ status: 'termination_incomplete' });
        // A later read can recover absence, but a different engine cannot
        // inherit the earlier capture's cached stopped result.
        inspectUnavailable = false;
        present = false;
        engine = 'another-engine';
        expect(await capture.lifecycle.remove!()).toEqual({ status: 'termination_incomplete' });
        engine = 'retained-engine';
        expect(await capture.lifecycle.remove!()).toEqual({ status: 'stopped' });
        expect(requests.some(request => request[0] === 'container' && request[1] === 'rm')).toBe(false);
    });

    it('observes exact retained-generation absence without confusing exited containers, engine loss, or replacement with removal', async () => {
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const requests: string[][] = [];
        let engine = 'retained-engine';
        let rows = [container('a', 'exited')];
        let unavailable = false;
        const capture = createNativeComposeLifecycle({ args, engineId: 'retained-engine',
            environment: { composeService: 'worker', containerIds: ['a'.repeat(64)] }, io: { async run(request) {
                requests.push([...request.args]);
                if (request.args[0] === 'info') return { exitCode: 0, stdout: JSON.stringify({ ID: engine }) };
                if (unavailable) return { exitCode: 1, stdout: '' };
                if (request.args[0] === 'ps') return { exitCode: 0, stdout: rows.map(row => row.Id).join('\n') };
                return { exitCode: 0, stdout: JSON.stringify(rows) };
            } } });
        capture.bindLaunch({ command: '/docker', args, cwd: '/release', env: {}, release() {} });
        const inspectRemoval = capture.lifecycle.inspectRemoval!;
        expect(await inspectRemoval()).toBe('present');
        rows = [];
        expect(await inspectRemoval()).toBe('absent');
        rows = [container('b', 'running')];
        expect(await inspectRemoval()).toBe('unknown');
        rows = [];
        engine = 'another-engine';
        expect(await inspectRemoval()).toBe('unknown');
        engine = 'retained-engine';
        unavailable = true;
        expect(await inspectRemoval()).toBe('unknown');
        expect(requests.some(request => request.includes('rm') || request.includes('stop') || request.includes('down'))).toBe(false);
    });

    it('recovers unproved removal without repeating it and requires fresh engine evidence after success', async () => {
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const id = 'a'.repeat(64);
        let engine = 'retained-engine';
        let present = true;
        let unavailable = false;
        let removals = 0;
        const capture = createNativeComposeLifecycle({ args, engineId: engine,
            environment: { composeService: 'worker', containerIds: [id] }, io: { async run(request) {
                if (request.args[0] === 'info') return { exitCode: 0, stdout: JSON.stringify({ ID: engine }) };
                if (request.args[0] === 'container' && request.args[1] === 'rm') {
                    removals += 1;
                    present = false;
                    unavailable = true;
                    return { exitCode: 0, stdout: '' };
                }
                if (unavailable) return { exitCode: 1, stdout: '[]' };
                if (request.args[0] === 'ps') return { exitCode: 0, stdout: present ? id : '' };
                if (request.args[0] === 'network' && request.args[1] === 'ls') return { exitCode: 0, stdout: '' };
                return { exitCode: 0, stdout: JSON.stringify(present ? [container('a', 'running')] : []) };
            } } });
        capture.bindLaunch({ command: '/docker', args, cwd: '/release', env: {}, release() {} });
        expect(await capture.lifecycle.remove!()).toEqual({ status: 'termination_incomplete' });
        unavailable = false;
        expect(await capture.lifecycle.remove!()).toEqual({ status: 'stopped' });
        expect(removals).toBe(1);
        engine = 'another-engine';
        expect(await capture.lifecycle.remove!()).toEqual({ status: 'termination_incomplete' });
        expect(removals).toBe(1);
    });

    it('refuses retained candidate removal on another engine and preserves the matching generation for later cleanup', async () => {
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const prefix = ['--host', 'tcp://retained-engine:2375'];
        const requests: string[][] = [];
        let actualEngine = 'different-engine';
        let present = true;
        const capture = createNativeComposeLifecycle({ args, engineId: 'retained-engine',
            environment: { composeService: 'worker', containerIds: ['a'.repeat(64)] }, io: { async run(request) {
                expect(request.cwd).toBe('/release');
                expect(request.env).toEqual({ DOCKER_CONTEXT: 'retained-context' });
                expect(request.args.slice(0, prefix.length)).toEqual(prefix);
                const nativeArgs = request.args.slice(prefix.length);
                requests.push([...nativeArgs]);
                if (nativeArgs[0] === 'info') return { exitCode: 0, stdout: JSON.stringify({ ID: actualEngine }) };
                if (nativeArgs[0] === 'container' && nativeArgs[1] === 'rm') {
                    expect(actualEngine).toBe('retained-engine');
                    expect(nativeArgs).toEqual(['container', 'rm', '--force', 'a'.repeat(64)]);
                    present = false;
                    return { exitCode: 0, stdout: '' };
                }
                if (nativeArgs[0] === 'ps') return { exitCode: 0, stdout: present && actualEngine === 'retained-engine' ? 'a'.repeat(64) : '' };
                if (nativeArgs[0] === 'network' && nativeArgs[1] === 'ls') return { exitCode: 0, stdout: '' };
                return { exitCode: 0, stdout: JSON.stringify(present && actualEngine === 'retained-engine' ? [container('a', 'running')] : []) };
            } } });
        capture.bindLaunch({ command: '/docker', args: [...prefix, ...args], cwd: '/release', env: { DOCKER_CONTEXT: 'retained-context' }, release() {} });
        expect(await capture.lifecycle.remove!()).toEqual({ status: 'termination_incomplete' });
        expect(requests.some(request => request[0] === 'inspect' || request[0] === 'container')).toBe(false);
        actualEngine = 'retained-engine';
        expect(await capture.lifecycle.inspect()).toMatchObject({ phase: 'running' });
        expect(await capture.lifecycle.remove!()).toEqual({ status: 'stopped' });
        expect(present).toBe(false);
        expect(await capture.lifecycle.inspect()).toMatchObject({ phase: 'stopped' });
    });

    it('refuses retained candidate removal without its source engine witness', async () => {
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const requests: string[][] = [];
        const capture = createNativeComposeLifecycle({ args, environment: { composeService: 'worker', containerIds: ['a'.repeat(64)] },
            io: { async run(request) { requests.push([...request.args]); return { exitCode: 0, stdout: '[]' }; } } });
        capture.bindLaunch({ command: '/docker', args, cwd: '/release', env: {}, release() {} });
        expect(await capture.lifecycle.remove!()).toEqual({ status: 'termination_incomplete' });
        expect(requests).toEqual([]);
    });

    it('cancels a native accounting read only when its final demand is released', async () => {
        const id = 'd'.repeat(64);
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const reads: Array<Readonly<{ signal?: AbortSignal; finish(): void }>> = [];
        let abortFailure: unknown;
        const capture = createNativeComposeLifecycle({ args, engineId: 'accounting-cancellation-test',
            environment: { composeService: 'worker', containerIds: [id] }, io: {
                async events() { return { async dispose() {} }; },
                async run(request) {
                    if (!request.args.includes('stats')) return { exitCode: 0, stdout: JSON.stringify([container('d', 'running')]) };
                    return await new Promise<{ exitCode: number; stdout: string }>((resolve, reject) => {
                        const aborted = () => reject(abortFailure ?? request.signal?.reason);
                        request.signal?.addEventListener('abort', aborted, { once: true });
                        reads.push({ signal: request.signal, finish() {
                            request.signal?.removeEventListener('abort', aborted);
                            resolve({ exitCode: 0, stdout: JSON.stringify({ ID: id, CPUPerc: '1%', MemUsage: '1KiB / 1GiB' }) });
                        } });
                    });
                },
            } });
        capture.bindLaunch({ command: '/docker', args, cwd: '/release', env: {}, release() {} });
        const observation = await capture.lifecycle.observe!(() => {});
        const firstDemand = new AbortController();
        const lastDemand = new AbortController();
        const failedCleanupDemand = new AbortController();
        try {
            const first = capture.lifecycle.readAccounting!({ signal: firstDemand.signal });
            const last = capture.lifecycle.readAccounting!({ signal: lastDemand.signal });
            // Early assertion failure still owns the other pending viewer's cleanup.
            void last.catch(() => {});
            let released = false;
            const cancelled = first.then(() => { released = true; return null; }, (error: unknown) => { released = true; return error; });
            await vi.waitFor(() => expect(reads).toHaveLength(1));
            firstDemand.abort();
            await nextTurn();
            expect(released, 'an aborted visible demand settles without waiting for another viewer').toBe(true);
            expect(await cancelled).toMatchObject({ name: 'AbortError' });
            expect(reads[0].signal?.aborted).toBe(false);
            reads[0].finish();
            expect(await last).toEqual({ kind: 'sample', samples: [{ nativeResourceId: id, cpuPercent: 1, memoryBytes: 1024, networkReceivedBytes: null, networkSentBytes: null, restartCount: null }] });
            const pending = capture.lifecycle.readAccounting!({ signal: lastDemand.signal });
            const finalCancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
            await vi.waitFor(() => expect(reads).toHaveLength(2));
            lastDemand.abort();
            await finalCancelled;
            expect(reads[1].signal?.aborted).toBe(true);
            await nextTurn();
            abortFailure = new PluginError({ code: 'plugin_exec_termination_incomplete', message: 'Cancelled native query custody is unsettled' });
            const failing = capture.lifecycle.readAccounting!({ signal: failedCleanupDemand.signal });
            const failedCleanup = expect(failing).rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete' });
            await vi.waitFor(() => expect(reads).toHaveLength(3));
            failedCleanupDemand.abort();
            await failedCleanup;
        } finally { firstDemand.abort(); lastDemand.abort(); failedCleanupDemand.abort(); for (const read of reads) read.finish(); await observation.dispose(); }
    });

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
            { ID: ids[0], CPUPerc: '12.5%', MemUsage: '2MiB / 1GiB', NetIO: '1.5kB / 2MiB' },
            { ID: ids[1], CPUPerc: '--', MemUsage: '-- / --', NetIO: '0B / --' },
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
                    return { exitCode: 0, stdout: JSON.stringify(ids.map(id => ({ ...container(id[0], 'running'), Id: id, ...(id === ids[0] ? { RestartCount: 0 } : {}) }))) };
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
                { nativeResourceId: ids[0], cpuPercent: 12.5, memoryBytes: 2097152, networkReceivedBytes: 1500, networkSentBytes: 2097152, restartCount: 0 },
                { nativeResourceId: ids[1], cpuPercent: null, memoryBytes: null, networkReceivedBytes: 0, networkSentBytes: null, restartCount: null },
            ] };
            expect(MachineServiceAccountingV1Schema.parse(await first)).toEqual(expected);
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
                nativeResourceId, cpuPercent: null, memoryBytes: null, networkReceivedBytes: null, networkSentBytes: null,
                restartCount: nativeResourceId === ids[0] ? 0 : null,
            })) });
            failure = new PluginError({ code: 'plugin_exec_termination_incomplete', message: 'Native query custody is unsettled' });
            await expect(capture.lifecycle.readAccounting!()).rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete' });
        } finally { release(); await observation.dispose(); }
        expect(await capture.lifecycle.readAccounting!()).toEqual({ kind: 'unavailable', reason: 'unavailable' });
        expect(requests.filter(request => request.includes('stats'))).toHaveLength(6);
    });

    it('proves HTTP subscription over the supervised Docker transport and cancels its child', async () => {
        // The OS process is the boundary: mimic Docker dial-stdio's transparent
        // stream with a real child, leaving HTTP framing/observation real.
        const script = `process.stdin.once('data', () => {
            process.stdout.write('HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n');
            const event = JSON.stringify({Type:'container',Action:'die',Actor:{ID:'${'a'.repeat(64)}'}})+'\\n';
            process.stdout.write(Buffer.byteLength(event).toString(16)+'\\r\\n'+event+'\\r\\n');
        }); process.stdin.resume();`;
        const controller = new AbortController();
        let observed!: () => void;
        const delivered = new Promise<void>(resolve => { observed = resolve; });
        const events: unknown[] = [];
        const open = openDockerEngineEvents({ command: process.execPath, args: [], cwd: process.cwd(), env: {}, release() {} }, ['-e', script, '--']);
        const subscription = await open({ signal: controller.signal, disconnected() {}, event(value) { events.push(value); observed(); } });
        try {
            await delivered;
            expect(events).toEqual([{ Type: 'container', Action: 'die', Actor: { ID: 'a'.repeat(64) } }]);
        } finally {
            controller.abort();
            await subscription.dispose();
        }
    });

    it('joins shared native teardown when abort and supervisor disposal overlap', async () => {
        let release!: () => void;
        let entered!: () => void;
        const teardown = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const capture = createNativeComposeLifecycle({ args, engineId: 'engine-teardown-join-test',
            environment: { composeService: 'worker', containerIds: ['a'.repeat(64)] }, io: {
                async events() { return { async dispose() { entered(); await teardown; } }; },
                async run() { return { exitCode: 0, stdout: JSON.stringify([container('a', 'running')]) }; },
            } });
        capture.bindLaunch({ command: '/docker', args, cwd: '/release', env: {}, release() {} });
        const supervisor = createManagedServiceProcessSupervisorHost({}).bind({ kind: 'project', isOccurrenceCurrent: () => true });
        let observationReleased = false;
        const handle = await supervisor.supervise({ id: 'engine-teardown-join-test', watchdog: { intervalMs: 5000, missedIntervals: 2 },
            mode: { kind: 'native', observationOnly: true, builtinLifecycle: capture.lifecycle,
                async releaseObservation() { observationReleased = true; } } });
        let settled = false;
        const disposal = handle.dispose().then(() => { settled = true; });
        try {
            await started;
            for (let index = 0; index < 20; index++) await Promise.resolve();
            expect(settled).toBe(false);
            expect(observationReleased).toBe(false);
        } finally { release(); await disposal; }
        expect(observationReleased).toBe(true);
    });

    it.each([[false, false], [true, false], [false, true]] as const)('transfers the engine stream before its source capture releases native environment custody (disconnected=%s, allRetire=%s)', async (disconnected, allRetire) => {
        const ids = ['a'.repeat(64), 'b'.repeat(64)];
        const operations: string[] = [];
        const leases = ids.map(() => createProviderRedactionLease({ values: ['native-environment-custody'] }));
        let finishTeardown!: () => void;
        const teardown = new Promise<void>(resolve => { finishTeardown = resolve; });
        let active = 0;
        let maximum = 0;
        let disconnectSource: (() => void) | undefined;
        const host = createManagedServiceProcessSupervisorHost({});
        const supervisor = host.bind({ kind: 'project', isOccurrenceCurrent: () => true });
        const handles = [];
        for (const [index, id] of ids.entries()) {
            const project = `happier-${id[0]}`;
            const args = ['compose', '--project-name', project, '--file', '/release/compose.yaml'];
            const capture = createNativeComposeLifecycle({ args, engineId: 'engine-source-custody-test',
                environment: { composeService: 'worker', containerIds: [id] }, io: {
                    async events(request) {
                        if (index === 0) disconnectSource = request.disconnected;
                        operations.push(`start:${id[0]}`);
                        active++;
                        maximum = Math.max(maximum, active);
                        return { async dispose() {
                            if (index === 0) await teardown;
                            active--;
                            operations.push(`stop:${id[0]}`);
                        } };
                    },
                    async run(request) {
                        return { exitCode: 0, stdout: JSON.stringify(ids.filter(nativeId => request.args.includes(nativeId)).map(nativeId => ({
                            ...container(nativeId[0], 'running'), State: { Status: 'running', Health: { Status: 'healthy' } },
                            Config: { Labels: { 'com.docker.compose.project': `happier-${nativeId[0]}`, 'com.docker.compose.service': 'worker' } },
                        }))) };
                    },
                } });
            const launch = { command: '/docker', args, cwd: '/release', env: {}, secretRedactionLease: leases[index],
                release() { operations.push(`release:${id[0]}`); leases[index].close(); } };
            capture.bindLaunch(launch);
            handles.push(await supervisor.supervise({ id: `engine-source-${id[0]}`, watchdog: { intervalMs: 5000, missedIntervals: 2 },
                mode: { kind: 'native', observationOnly: true, builtinLifecycle: capture.lifecycle,
                    async releaseObservation() { launch.release(); } } }));
        }
        if (disconnected) disconnectSource?.();
        const disposal = handles[0].dispose();
        const otherDisposal = allRetire ? handles[1].dispose() : undefined;
        try {
            for (let index = 0; index < 20; index++) await Promise.resolve();
            expect(leases[0].isActive()).toBe(true);
            expect(operations).toEqual(['start:a']);
            finishTeardown();
            await disposal;
            await otherDisposal;
            if (allRetire) {
                expect(operations).not.toContain('start:b');
                expect(operations.indexOf('release:a')).toBeGreaterThan(operations.indexOf('stop:a'));
            } else expect(operations).toEqual(['start:a', 'stop:a', 'start:b', 'release:a']);
            expect(leases[0].isActive()).toBe(false);
            expect(leases[1].isActive()).toBe(!allRetire);
            if (!allRetire) expect(handles[1].snapshot().state).toBe('healthy');
            expect(maximum).toBe(1);
        } finally {
            finishTeardown();
            await disposal;
            await handles[1].dispose();
        }
        expect(active).toBe(0);
        expect(leases[1].isActive()).toBe(false);
    });

    it('keeps one engine stream while unrelated projects overlap last-observer teardown', async () => {
        let release!: () => void;
        let entered!: () => void;
        const teardown = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        let subscriptions = 0;
        let active = 0;
        let maximum = 0;
        const ids = ['a'.repeat(64), 'b'.repeat(64)];
        const io = {
            async events() {
                subscriptions++;
                active++;
                maximum = Math.max(maximum, active);
                const first = subscriptions === 1;
                return { async dispose() { if (first) { entered(); await teardown; } active--; } };
            },
            async run(request: Parameters<ProjectNativeToolchainIo['run']>[0]) {
                return { exitCode: 0, stdout: JSON.stringify(ids.filter(id => request.args.includes(id)).map(id => ({
                    ...container(id[0], 'running'), Config: { Labels: {
                        'com.docker.compose.project': `happier-${id[0]}`, 'com.docker.compose.service': 'worker',
                    } },
                }))) };
            },
        };
        const captures = ids.map(id => {
            const args = ['compose', '--project-name', `happier-${id[0]}`, '--file', '/release/compose.yaml'];
            const capture = createNativeComposeLifecycle({ args, io, engineId: 'engine-turnover-test',
                environment: { composeService: 'worker', containerIds: [id] } });
            capture.bindLaunch({ command: '/docker', args, cwd: '/release', env: {}, release() {} });
            return capture;
        });
        const first = await captures[0].lifecycle.observe!(() => {});
        const disposal = first.dispose();
        await started;
        const second = captures[1].lifecycle.observe!(() => {});
        try {
            for (let index = 0; index < 20; index++) await Promise.resolve();
            expect(subscriptions).toBe(1);
        } finally {
            release();
            await disposal;
            await (await second).dispose();
        }
        expect(maximum).toBe(1);
        expect(active).toBe(0);
    });

    it('shares one proven engine subscription and outage recovery across 120 admitted services', async () => {
        vi.useFakeTimers();
        let random: ReturnType<typeof vi.spyOn> | undefined;
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
            // [p03redesign.I6] An engine outage reconnects on the shared
            // connection-supervisor backoff (1 s doubling to 60 s), not every 5 s.
            random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
            const beforeOutage = subscriptions.length;
            await vi.advanceTimersByTimeAsync(5 * 60_000);
            expect({ reconnectAttemptsPerFiveMinutes: subscriptions.length - beforeOutage })
                .toEqual({ reconnectAttemptsPerFiveMinutes: 9 });
            expect(requests).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(1);
            available = true;
            unhealthy = false;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(subscriptions).toHaveLength(beforeOutage + 10);
            expect(requests.filter(request => request.includes('inspect'))).toHaveLength(1);
            expect(handles.every(handle => handle.snapshot().state === 'healthy')).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
            available = false;
            subscriptions.at(-1)!.disconnected();
            await vi.advanceTimersByTimeAsync(0);
            expect(vi.getTimerCount()).toBe(1);
        } finally {
            random?.mockRestore();
            await Promise.all(handles.map(handle => handle.dispose()));
        }
        expect(releases).toBe(2);
        expect(vi.getTimerCount()).toBe(0);
        const settled = subscriptions.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(subscriptions).toHaveLength(settled);
    });

    it('derives an interactive shell only from the admitted Compose service generation', async () => {
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const requests: Array<Parameters<ProjectNativeToolchainIo['run']>[0]> = [];
        let current = true;
        let released = 0;
        let selectedEngine = 'shell-engine';
        const redaction = createProviderRedactionLease({ values: ['shell-secret'] });
        const observer = { command: '/docker', args, cwd: '/release', env: { PATH: '/bin', UNREVIEWED: 'ambient' },
            secretRedactionLease: redaction, release() { released += 1; } };
        const control = createNativeComposeLifecycle({ args, engineId: 'shell-engine', retainLaunch: () => observer,
            environment: { composeService: 'worker', containerIds: ['a'.repeat(64)] }, io: { async run(request) {
            requests.push(request);
            return { exitCode: 0, stdout: request.args[0] === 'info' ? JSON.stringify({ ID: selectedEngine })
                : request.args.includes('ps') ? (current ? 'a' : 'b').repeat(64)
                : JSON.stringify([container(current ? 'a' : 'b', 'running')]) };
        } } });
        control.bindLaunch(observer);
        const launch = await control.lifecycle.shell?.();
        expect(launch).toMatchObject({ command: '/docker',
            args: [...args, 'exec', '-it', 'worker', '/bin/sh'], cwd: '/release', env: { PATH: '/bin', COMPOSE_DISABLE_ENV_FILE: '1' } });
        // Owner 2026-10-30 keeps the trusted machine profile; the exact
        // admitted Compose operands above, not ambient filtering, select it.
        expect(launch?.env.UNREVIEWED).toBe('ambient');
        expect(released).toBe(0);
        await launch?.release();
        await launch?.release();
        expect(released).toBe(1);
        expect(requests.every(request => !request.args.includes('exec'))).toBe(true);
        current = false;
        await expect(control.lifecycle.shell?.()).rejects.toMatchObject({ code: 'deployment_generation_required' });
        current = true;
        selectedEngine = 'different-engine';
        await expect(control.lifecycle.shell?.()).rejects.toMatchObject({ code: 'deployment_generation_required' });
        expect(released).toBe(2);
        redaction.close();
        selectedEngine = 'shell-engine';
        await expect(control.lifecycle.shell?.()).rejects.toMatchObject({
            code: 'secret_redaction_redeploy_required', retryable: false,
        });
        expect(released).toBe(3);
        expect(requests.every(request => !request.args.includes('exec'))).toBe(true);
    });

    it('refuses a replacement before the first Environment observation', async () => {
        const requests: string[][] = [];
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const control = createNativeComposeLifecycle({ args, environment: { composeService: 'worker', containerIds: ['a'.repeat(64)] },
            io: { async run(request) {
                requests.push([...request.args]);
                return { exitCode: 0, stdout: request.args.includes('ps') ? 'b'.repeat(64)
                    : request.args.includes('inspect') ? JSON.stringify([container('b', 'running')]) : '' };
            } } });
        control.bindLaunch({ command: '/docker', args, cwd: '/release', env: {}, release() {} });
        expect(await control.lifecycle.inspect()).toMatchObject({ phase: 'unknown' });
        await expect(control.lifecycle.restart?.()).rejects.toMatchObject({ code: 'deployment_generation_required' });
        expect(await control.lifecycle.stop()).toEqual({ status: 'termination_incomplete' });
        expect(requests.some(request => request.includes('compose'))).toBe(false);
    });
    it('returns UTF-8 bounded pages and refuses a cursor after the observed member set changes', async () => {
        let id = 'a';
        const requests: string[][] = [];
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const control = createNativeComposeLifecycle({ args, environment: { composeService: 'worker', containerIds: ['a'.repeat(64)] }, io: { async run(request) {
            requests.push([...request.args]);
            if (request.args.includes('logs')) return dockerLogOutput(request, 'ééééé');
            return { exitCode: 0, stdout: request.args.includes('ps') ? id.repeat(64)
                : request.args.includes('inspect') ? JSON.stringify([container(id, 'running')]) : 'ééééé' };
        } } });
        control.bindLaunch({ command: '/docker', args, cwd: '/release', env: {},
            secretRedactionLease: createProviderRedactionLease({ values: [] }), release() {} });
        await control.lifecycle.inspect();
        expect(requests.filter(request => request.includes('logs'))).toHaveLength(0);
        const result = await control.lifecycle.logs?.({ kind: 'read', maxBytes: 5 });
        expect(result).toMatchObject({ kind: 'page', page: { text: 'éé', truncated: true, nextCursor: null } });
        if (!result || !('kind' in result) || result.kind !== 'page') throw new Error('Expected a native log page');
        id = 'b';
        await control.lifecycle.inspect();
        const reads = requests.filter(request => request.includes('logs')).length;
        expect(await control.lifecycle.logs?.({ kind: 'read', maxBytes: 5,
            cursor: { sourceRevision: result.page.sourceRevision, token: '' } })).toMatchObject({ kind: 'source-changed' });
        expect(requests.filter(request => request.includes('logs'))).toHaveLength(reads);
        const events: unknown[] = [];
        const beforeWatch = requests.length;
        const watch = await control.lifecycle.logs?.({ kind: 'watch', maxBytes: 5, emit: result => events.push(result) });
        expect(events).toEqual([{ kind: 'unavailable', reason: 'unsupported' }]);
        expect(requests).toHaveLength(beforeWatch);
        if (!watch || !('dispose' in watch)) throw new Error('Expected a native watch disposal');
        await watch.dispose();
    });

    it('projects one log page while Docker streams long lines from every admitted container', async () => {
        const ids = ['a'.repeat(64), 'b'.repeat(64)];
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const reads: Parameters<ProjectNativeToolchainIo['run']>[0][] = [];
        const control = createNativeComposeLifecycle({ args,
            environment: { composeService: 'worker', containerIds: ids }, io: { async run(request) {
                reads.push(request);
                // Docker process output is the boundary. A line has no byte-size
                // ceiling, so a line count cannot bound this diagnostic page.
                for (let index = 0; index < 32; index++) {
                    request.output?.onChunk(index % 2 ? 'stderr' : 'stdout', Buffer.from('useful '.repeat(1024)));
                }
                return { exitCode: 0, stdout: '', stderr: '' };
            } } });
        const lease = createProviderRedactionLease({ values: [] });
        control.bindLaunch({ command: '/docker', args, cwd: '/release', env: {}, secretRedactionLease: lease, release() {} });
        try {
            const result = await control.lifecycle.logs?.({ kind: 'read', maxBytes: 8192 });
            expect(result).toMatchObject({ kind: 'page', page: { truncated: true, nextCursor: null } });
            if (!result || !('kind' in result) || result.kind !== 'page') throw new Error('Expected a native log page');
            expect(result.page.text).toHaveLength(8192);
            expect(result.page.text).toBe(('useful '.repeat(2048)).slice(0, 8192));
            expect(reads).toHaveLength(ids.length);
            for (const request of reads) expect(request).toMatchObject({
                maxStdoutBytes: 0, maxStderrBytes: 0, allowTruncatedStdout: true,
            });
        } finally { lease.close(); }
    });

    it('redacts only delivered secret material in post-detach generation logs', async () => {
        const secretRedactionLease = createProviderRedactionLease({ values: ['s0-secret-sentinel'] });
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml', 'up', '--detach', 'worker'];
        const control = createNativeComposeLifecycle({ args, io: { async run(request) {
            if (request.args.includes('logs')) return dockerLogOutput(request, 'after-detach s0-secret-sentinel PORT=3000 COMMIT=abc123');
            return { exitCode: 0, stdout: request.args.includes('ps') ? 'a'.repeat(64)
                : request.args.includes('inspect') ? JSON.stringify([container('a', 'running')])
                    : 'after-detach s0-secret-sentinel PORT=3000 COMMIT=abc123' };
        } } });
        control.bindLaunch({ command: '/docker', args, cwd: '/release',
            env: { S0_SECRET: 's0-secret-sentinel', PORT: '3000', COMMIT: 'abc123' },
            secretRedactionLease, release() { secretRedactionLease.close(); } });
        control.lifecycle.markStarted?.();
        await control.lifecycle.inspect();
        expect(control.lifecycle.redactedValues).toEqual(['s0-secret-sentinel']);
        expect(await control.lifecycle.logs?.({ kind: 'read', maxBytes: 8192 }))
            .toMatchObject({ kind: 'page', page: { text: 'after-detach [REDACTED] PORT=3000 COMMIT=abc123' } });
        secretRedactionLease.close();
        await expect(control.lifecycle.logs?.({ kind: 'read', maxBytes: 8192 })).rejects.toMatchObject({ code: 'secret_redaction_unavailable' });
    });

    it('keeps person Environment logs readable with incomplete masking while automation refuses and the app keeps running', async () => {
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const requests: string[][] = [];
        let diagnostic = 'retired-secret-sentinel PORT=3000';
        const io: Pick<ProjectNativeToolchainIo, 'run'> = { async run(request) {
            requests.push([...request.args]);
            if (request.args.includes('logs')) return dockerLogOutput(request, diagnostic);
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
            if (args.includes('logs')) return dockerLogOutput(request, args.includes('b'.repeat(64)) ? 'db diagnostic' : 'web diagnostic');
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

    it('refuses Environment controls when the admitted native generation is absent or replaced', async () => {
        let id = 'a'.repeat(64);
        const requests: string[][] = [];
        const io: Pick<ProjectNativeToolchainIo, 'run'> = { async run(request) {
            const args = [...request.args];
            requests.push(args);
            return { exitCode: 0, stdout: args.includes('ps') ? id
                : args.includes('inspect') ? JSON.stringify([{ ...container(id.slice(0, 1), 'running'), Id: id }]) : '' };
        } };
        const args = ['compose', '--project-name', 'happier-test', '--file', '/release/compose.yaml'];
        const control = createNativeComposeLifecycle({ args, io, environment: { composeService: 'worker', containerIds: ['a'.repeat(64)] } });
        control.bindLaunch({ command: '/docker', args, cwd: '/release', env: {}, release() {} });
        expect(await control.lifecycle.inspect()).toMatchObject({ phase: 'running' });
        id = 'b'.repeat(64);
        await expect(control.lifecycle.restart?.()).rejects.toMatchObject({ code: 'deployment_generation_required' });
        expect(await control.lifecycle.stop()).toEqual({ status: 'termination_incomplete' });
        id = '';
        expect(await control.lifecycle.inspect()).toMatchObject({ phase: 'unknown' });
        await expect(control.lifecycle.start?.()).rejects.toMatchObject({ code: 'deployment_generation_required' });
        expect(requests.some(request => request.includes('compose'))).toBe(false);
    });

    function fixture() {
        let rows: unknown = [container('a', 'running')];
        let code = 0;
        const requests: string[][] = [];
        // Docker process IO is the system boundary; codec and native decisions remain real.
        const io: Pick<ProjectNativeToolchainIo, 'run'> = { async run(request) {
            requests.push([...request.args]);
            if (request.args.includes('logs')) return dockerLogOutput(request, 'native output');
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
        h.setRows([container('b', 'running', { '8080/tcp': null })]);
        expect(await h.control.lifecycle.inspect()).toMatchObject({ phase: 'running', endpoint: null });
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
            if (observation.phase !== 'running') throw new Error(`Native fixture did not stay running: ${JSON.stringify(await first.lifecycle.logs?.({ kind: 'read', maxBytes: 8_192 }))}`);
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
