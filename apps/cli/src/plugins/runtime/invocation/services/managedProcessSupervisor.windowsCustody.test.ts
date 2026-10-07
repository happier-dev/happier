import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagedServiceProcessSupervisorHost } from './managedProcessSupervisor';
import type { ManagedServiceProcessSpec } from './managedProcessSupervisor';
import { createManagedServiceDurabilityOwner } from './managedServiceDurability';
import { readManagedServiceEndpointProjectionCandidates } from './managedServiceEndpointProjection';
import { createStablePluginExecService } from './exec';
import { queryProcessCustodyJob } from '@/subprocess/supervision/processCustody';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

const tempDirs: string[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
    await Promise.all(tempDirs.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
    }));
});

// Stand-in for the staged `happier-process-custody` runtime. It reproduces the
// helper's run-mode contract: parse the job/handshake options, publish the
// post-assignment handshake carrying the target pid, then hold the containment
// until termination. FIXTURE_CUSTODY_WITHOUT_HANDSHAKE=1 (injected through the
// authorized launch env) reproduces the assignment-failure shape: the helper
// exits nonzero and no handshake ever exists.
const CUSTODY_HELPER_SCRIPT = `#!${process.execPath}
const { writeFileSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const handshakeArgument = args.find((argument) => argument.startsWith('--handshake='));
const jobArgument = args.find((argument) => argument.startsWith('--job='));
if (!jobArgument) process.exit(2);
const jobName = jobArgument.slice('--job='.length);
const custodyPath = join(__dirname, 'custody.json');
if (args[0] === 'query' || args[0] === 'terminate') {
    let custody;
    try { custody = JSON.parse(readFileSync(custodyPath,'utf8')); } catch {}
    if (!custody || custody.job !== jobName) {
        console.log(JSON.stringify({state:'absent'})); process.exit(0);
    }
    if (args[0] === 'terminate') {
        try { process.kill(custody.pid,'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const observe = () => {
        const live = [custody.pid,custody.helperPid].some((pid) => {
            try { process.kill(pid,0); return true; } catch { return false; }
        });
        if (!live) {
            rmSync(custodyPath,{force:true});
            console.log(JSON.stringify({state:'absent'})); process.exit(0);
        }
        if (args[0] === 'query') { console.log(JSON.stringify({state:'live'})); process.exit(0); }
    };
    observe();
    setInterval(observe,5);
} else {
if (!handshakeArgument) process.exit(2);
const handshakePath = handshakeArgument.slice('--handshake='.length);
if (process.env.FIXTURE_CUSTODY_WITHOUT_HANDSHAKE === '1') {
    process.exit(4);
}
const targetArgs = args.slice(args.indexOf('--') + 1);
const target = spawn(targetArgs[0], targetArgs.slice(1), {stdio:'inherit'});
target.once('error', () => process.exit(4));
target.once('spawn', () => {
    writeFileSync(custodyPath, JSON.stringify({job:jobName,pid:target.pid,helperPid:process.pid}));
    writeFileSync(handshakePath, JSON.stringify({v:1,pid:target.pid,job:jobName}) + '\\n');
});
target.once('exit', () => process.exit(0));
}
`;

async function writeCustodyHelper(root: string): Promise<string> {
    const helperPath = join(root, 'happier-process-custody-fixture.cjs');
    await writeFile(helperPath, CUSTODY_HELPER_SCRIPT, 'utf8');
    // The host spawns the staged helper as the command itself, so the fixture
    // must be directly executable like the real runtime support binary.
    await chmod(helperPath, 0o755);
    return helperPath;
}

function createDurability(root: string, helperPath: string) {
    return createManagedServiceDurabilityOwner({
        rootDir: join(root, 'durability'), platform: 'win32',
        resolveProcessCustodyRuntimeExecutable: () => helperPath,
    });
}

function windowsManagedSpec(): ManagedServiceProcessSpec {
    return {
        id: 'windows-managed',
        startupTimeoutMs: 30_000,
        watchdog: { intervalMs: 5_000, missedIntervals: 2 },
        mode: { kind: 'managedSpawn', host: '127.0.0.1', port: 49152 },
        launch: { executable: { kind: 'systemTool', id: 'fixture.server' }, args: ['serve'] },
    };
}

describe('managed SVC09 Windows job custody', () => {
    it('refuses to spawn a Windows managed server when the custody helper is unavailable', async () => {
        const resolveExecutable = vi.fn(async () => {
            throw new Error('must not resolve');
        });
        const exec = createStablePluginExecService({
            allowedExecutables: [{ kind: 'systemTool', id: 'fixture.server' }],
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
            resolveExecutable,
            resolvePath: async () => {
                throw new Error('must not resolve a path');
            },
        });
        const host = createManagedServiceProcessSupervisorHost({
            platform: 'win32',
            resolveProcessCustodyRuntimeExecutable: () => null,
        });
        const servers = host.bind({
            occurrenceId: 'occurrenceId-win-custody-absent',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isOccurrenceCurrent: () => true,
            exec,
        });

        await expect(servers.supervise(windowsManagedSpec())).rejects.toMatchObject({
            code: 'plugin_managed_server_custody_failed',
        });
        expect(resolveExecutable).not.toHaveBeenCalled();
    });

    it('establishes job custody, projects the target pid and job identity, and terminates by job', async () => {
        const root = await mkdtemp(join(tmpdir(), 'svc09-win-custody-live-'));
        tempDirs.push(root);
        const helperPath = await writeCustodyHelper(root);
        const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [{ manifest: createPluginManifestV2Fixture({ id: 'fixture.plugin' }),
                files: { 'daemon.mjs': 'export function activate() {}' } }],
        });
        disposers.push(runtime.dispose);
        const sourceCustody = runtime.registry.readPluginSourceCustody?.('fixture.plugin');
        if (!sourceCustody) throw new Error('Expected admitted fixture source custody');

        const exec = createStablePluginExecService({
            allowedExecutables: [{ kind: 'systemTool', id: 'fixture.server' }],
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
            resolveExecutable: async () => {
                throw new Error('preauthorized launch must not resolve an executable');
            },
            resolvePath: async () => {
                throw new Error('preauthorized launch must not resolve a path');
            },
            authorizeLaunch: async () => ({
                command: process.execPath,
                args: ['-e', 'setInterval(() => {}, 1000)'],
                env: { FIXTURE_MANAGED_ENV: '1' },
                release: () => undefined,
            }),
        });
        const durability = createDurability(root, helperPath);
        const host = createManagedServiceProcessSupervisorHost({
            platform: 'win32',
            resolveProcessCustodyRuntimeExecutable: () => helperPath,
            durability,
            createInstanceId: () => 'opaque-custody-live',
        });
        const servers = host.bind({
            occurrenceId: 'occurrenceId-win-custody-live',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            sessionId: 'session-win-custody-live',
            sourceCustody,
            isOccurrenceCurrent: () => true,
            exec,
        });

        const handle = await servers.supervise(windowsManagedSpec());
        disposers.push(() => handle.dispose());

        // The projected pid is the TARGET pid from the post-assignment
        // handshake — never the pid of the process the host spawned itself.
        const targetPidSidecar = handle.snapshot().pid;
        expect(targetPidSidecar).toBeGreaterThan(0);
        const custodyWitness: { pid: number; helperPid: number; job: string } = JSON.parse(
            await readFile(join(root, 'custody.json'), 'utf8'),
        );
        expect(targetPidSidecar).toBe(custodyWitness.pid);
        expect(targetPidSidecar).not.toBe(custodyWitness.helperPid);

        // The no-health readiness path persists the tagged job identity with
        // the exact target pid through the real durability owner.
        await handle.waitUntilHealthy({ timeoutMs: 30_000 });
        const projectedRecord = await durability.resolveEndpointProjection({
            pluginId: 'fixture.plugin', sessionId: 'session-win-custody-live',
            contributionId: 'fixture.agent',
            selector: { kind: 'baseUrl', baseUrl: 'http://127.0.0.1:49152' },
        });
        if (!projectedRecord || projectedRecord.mode !== 'managedSpawn') throw new Error('Expected persisted managed projection');
        expect(projectedRecord.process.pid).toBe(targetPidSidecar);
        expect(projectedRecord.process.startIdentity).toMatch(/^winjob:Local\\happier-svc09-.+$/u);
        expect(projectedRecord.process.startIdentity).toBe(`winjob:${custodyWitness.job}`);

        await handle.dispose();

        await expect(queryProcessCustodyJob({
            executablePath: helperPath, jobName: projectedRecord.process.startIdentity.slice('winjob:'.length),
        })).resolves.toBe('absent');
        expect(readManagedServiceEndpointProjectionCandidates(join(root, 'durability'))).toEqual([]);
        expect(handle.snapshot().state).toBe('stopped');
    });

    it('fails establishment before any projection when the handshake never proves assignment', async () => {
        const root = await mkdtemp(join(tmpdir(), 'svc09-win-custody-unproven-'));
        tempDirs.push(root);
        const helperPath = await writeCustodyHelper(root);

        const exec = createStablePluginExecService({
            allowedExecutables: [{ kind: 'systemTool', id: 'fixture.server' }],
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
            resolveExecutable: async () => {
                throw new Error('preauthorized launch must not resolve an executable');
            },
            resolvePath: async () => {
                throw new Error('preauthorized launch must not resolve a path');
            },
            authorizeLaunch: async () => ({
                command: helperPath,
                args: [],
                env: { FIXTURE_CUSTODY_WITHOUT_HANDSHAKE: '1' },
                release: () => undefined,
            }),
        });
        const durability = createDurability(root, helperPath);
        const host = createManagedServiceProcessSupervisorHost({
            platform: 'win32',
            resolveProcessCustodyRuntimeExecutable: () => helperPath,
            durability,
        });
        const servers = host.bind({
            occurrenceId: 'occurrenceId-win-custody-unproven',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            sessionId: 'session-win-custody-unproven',
            isOccurrenceCurrent: () => true,
            exec,
        });

        await expect(servers.supervise(windowsManagedSpec())).rejects.toMatchObject({
            code: 'plugin_managed_server_custody_failed',
        });
        // Cleanup still enforces containment on the occurrenceId-unique job name
        // (a no-op when the job never existed), but no custody was published.
        expect(readManagedServiceEndpointProjectionCandidates(join(root, 'durability'))).toEqual([]);
    });
});
