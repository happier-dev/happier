import { readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagedServiceProcessSupervisorHost } from './managedProcessSupervisor';
import type { ManagedServiceProcessSpec } from './managedProcessSupervisor';
import type { ManagedServiceProcessDurabilityOwner } from './managedServiceDurability';
import { createStablePluginExecService } from './exec';

// The custody helper's OS job operations are a genuine system boundary: these
// tests fake only terminate/query while the spawn wrap, the post-assignment
// handshake, custody projection, and every internal decision stay real.
const terminateProcessCustodyByJob = vi.hoisted(() => vi.fn(async () => 'absent' as const));

vi.mock('@/subprocess/supervision/processCustody', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/subprocess/supervision/processCustody')>();
    return {
        ...actual,
        terminateProcessCustodyByJob,
    };
});

const tempDirs: string[] = [];

afterEach(async () => {
    terminateProcessCustodyByJob.mockReset();
    terminateProcessCustodyByJob.mockImplementation(async () => 'absent' as const);
    await Promise.all(tempDirs.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
    }));
});
terminateProcessCustodyByJob.mockImplementation(async () => 'absent' as const);

// Stand-in for the staged `happier-process-custody` runtime. It reproduces the
// helper's run-mode contract: parse the job/handshake options, publish the
// post-assignment handshake carrying the target pid, then hold the containment
// until termination. FIXTURE_CUSTODY_WITHOUT_HANDSHAKE=1 (injected through the
// authorized launch env) reproduces the assignment-failure shape: the helper
// exits nonzero and no handshake ever exists.
const CUSTODY_HELPER_SCRIPT = `#!/usr/bin/env node
const { writeFileSync, existsSync } = require('node:fs');
const args = process.argv.slice(2);
const handshakeArgument = args.find((argument) => argument.startsWith('--handshake='));
const jobArgument = args.find((argument) => argument.startsWith('--job='));
if (!handshakeArgument || !jobArgument) process.exit(2);
const handshakePath = handshakeArgument.slice('--handshake='.length);
const jobName = jobArgument.slice('--job='.length);
if (process.env.FIXTURE_CUSTODY_WITHOUT_HANDSHAKE === '1') {
    process.exit(4);
}
writeFileSync(handshakePath, JSON.stringify({ v: 1, pid: process.pid, job: jobName }) + '\\n');
writeFileSync(handshakePath + '.test-target-pid', String(process.pid));
const killMarker = handshakePath + '.kill';
const poll = setInterval(() => {
    if (existsSync(killMarker)) {
        clearInterval(poll);
        process.exit(0);
    }
}, 5);
// Deliberately NOT unref'd: the helper must hold the containment alive until
// the supervisor's termination actually happens, like the real runtime.
`;

async function writeCustodyHelper(root: string): Promise<string> {
    const helperPath = join(root, 'happier-process-custody-fixture.cjs');
    await writeFile(helperPath, CUSTODY_HELPER_SCRIPT, 'utf8');
    // The host spawns the staged helper as the command itself, so the fixture
    // must be directly executable like the real runtime support binary.
    await chmod(helperPath, 0o755);
    return helperPath;
}

function createDurability(): ManagedServiceProcessDurabilityOwner & {
    publishEndpointProjection: ReturnType<typeof vi.fn>;
} {
    return {
        publishEndpointProjection: vi.fn(async () => 'c'.repeat(64)),
        releaseEndpointProjection: vi.fn(async () => true),
        openLog: vi.fn(async () => ({
            path: '/host/logs/redacted.log',
            write: () => undefined,
            close: async () => undefined,
        })),
    };
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
        const spawn = vi.fn(async () => {
            throw new Error('must not spawn');
        });
        const host = createManagedServiceProcessSupervisorHost({
            platform: 'win32',
            resolveProcessCustodyRuntimeExecutable: () => null,
        });
        const servers = host.bind({
            generation: 'generation-win-custody-absent',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec: { spawn, run: spawn },
        });

        await expect(servers.supervise(windowsManagedSpec())).rejects.toMatchObject({
            code: 'plugin_managed_server_custody_failed',
        });
        expect(spawn).not.toHaveBeenCalled();
    });

    it('establishes job custody, projects the target pid and job identity, and terminates by job', async () => {
        const root = await mkdtemp(join(tmpdir(), 'svc09-win-custody-live-'));
        tempDirs.push(root);
        const helperPath = await writeCustodyHelper(root);

        const exec = createStablePluginExecService({
            allowedExecutables: [{ kind: 'systemTool', id: 'fixture.server' }],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            authorizeLaunch: async () => ({
                command: '/bin/sleep',
                args: ['30'],
                env: { FIXTURE_MANAGED_ENV: '1' },
                release: () => undefined,
            }),
        });
        const durability = createDurability();
        const host = createManagedServiceProcessSupervisorHost({
            platform: 'win32',
            resolveProcessCustodyRuntimeExecutable: () => helperPath,
            durability,
            fetch: vi.fn(async () => new Response('', { status: 200 })),
            createInstanceId: () => 'opaque-custody-live',
        });
        const servers = host.bind({
            generation: 'generation-win-custody-live',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            sessionId: 'session-win-custody-live',
            isGenerationCurrent: () => true,
            exec,
        });

        const handle = await servers.supervise(windowsManagedSpec());

        // The projected pid is the TARGET pid from the post-assignment
        // handshake — never the pid of the process the host spawned itself.
        const targetPidSidecar = readdirSync(root)
            .filter((entry) => entry.endsWith('.test-target-pid'))
            .map((entry) => join(root, entry))
            .map((path) => Number(readFileSync(path, 'utf8')))
            .at(0);
        expect(targetPidSidecar).toBeGreaterThan(0);
        expect(handle.snapshot().pid).toBe(targetPidSidecar);

        // Health flows through the mocked fetch, then the projection persists
        // the tagged job identity with the exact target pid.
        await handle.waitUntilHealthy({ timeoutMs: 30_000 });
        expect(durability.publishEndpointProjection).toHaveBeenCalledTimes(1);
        const projectedRecord = durability.publishEndpointProjection.mock.calls[0]?.[0] as {
            process: { pid: number; startIdentity: string };
        };
        expect(projectedRecord.process.pid).toBe(targetPidSidecar);
        expect(projectedRecord.process.startIdentity).toMatch(/^winjob:Local\\happier-svc09-.+$/u);

        // Emulate the kernel's job termination: the (faked) terminate-by-job
        // proves absence and the contained member dies with it.
        terminateProcessCustodyByJob.mockImplementationOnce(async () => {
            if (targetPidSidecar) {
                process.kill(targetPidSidecar, 'SIGKILL');
            }
            return 'absent' as const;
        });
        await handle.dispose();

        expect(terminateProcessCustodyByJob).toHaveBeenCalledTimes(1);
        const terminationCall = terminateProcessCustodyByJob.mock.calls[0]?.[0];
        expect(terminationCall?.executablePath).toBe(helperPath);
        expect(terminationCall?.jobName).toBe(
            projectedRecord.process.startIdentity.slice('winjob:'.length),
        );
        expect(handle.snapshot().state).toBe('stopped');
    });

    it('fails establishment before any projection when the handshake never proves assignment', async () => {
        const root = await mkdtemp(join(tmpdir(), 'svc09-win-custody-unproven-'));
        tempDirs.push(root);
        const helperPath = await writeCustodyHelper(root);

        const exec = createStablePluginExecService({
            allowedExecutables: [{ kind: 'systemTool', id: 'fixture.server' }],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            authorizeLaunch: async () => ({
                command: helperPath,
                args: [],
                env: { FIXTURE_CUSTODY_WITHOUT_HANDSHAKE: '1' },
                release: () => undefined,
            }),
        });
        const durability = createDurability();
        const host = createManagedServiceProcessSupervisorHost({
            platform: 'win32',
            resolveProcessCustodyRuntimeExecutable: () => helperPath,
            durability,
        });
        const servers = host.bind({
            generation: 'generation-win-custody-unproven',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            sessionId: 'session-win-custody-unproven',
            isGenerationCurrent: () => true,
            exec,
        });

        await expect(servers.supervise(windowsManagedSpec())).rejects.toMatchObject({
            code: 'plugin_managed_server_custody_failed',
        });
        // Cleanup still enforces containment on the generation-unique job name
        // (a no-op when the job never existed), but no custody was published.
        expect(durability.publishEndpointProjection).not.toHaveBeenCalled();
        expect(terminateProcessCustodyByJob).toHaveBeenCalledTimes(1);
    });
});
