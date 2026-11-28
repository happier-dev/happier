import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { configuration } from '@/configuration';
import { formatProcessOwnerTag, PROCESS_OWNER_ENV_KEY } from '@/processes/ownerTag';
import { spawnAuthorizedHostExecLaunchForHost } from './exec';

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
    ...await importOriginal<typeof import('node:child_process')>(),
    spawn: native.spawn,
}));
vi.mock('@happier-dev/cli-common/process', async importOriginal => ({
    ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
    resolveProcessCustodySupportExecutable: () => 'custody.exe',
}));

// Model only the OS boundary. The descendant's parent has already retired, so
// the process tree can only find it through the launcher Job's membership.
class WindowsChild extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    exitCode: number | null = null;
    signalCode = null;
    constructor(readonly pid: number) { super(); }
    exit(code: number) {
        this.exitCode = code;
        this.emit('exit', code, null);
        this.emit('close', code, null);
    }
}

it('stops one hosted Session Job including its detached descendant, while its sibling keeps running', async () => {
    const jobs = new Map<string, { launcher: WindowsChild; descendant: number }>();
    const children: WindowsChild[] = [];
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    native.spawn.mockImplementation((command: string, args: readonly string[]) => {
        const child = new WindowsChild(4100 + children.length * 2);
        children.push(child);
        const name = args.find(arg => arg.startsWith('--job='))?.slice(6);
        const handshakePath = args.find(arg => arg.startsWith('--handshake='))?.slice(12);
        if (command === 'custody.exe' && name && handshakePath) {
            const descendant = child.pid + 1;
            jobs.set(name, { launcher: child, descendant });
            void writeFile(handshakePath, JSON.stringify({ v: 1, pid: descendant, job: name }));
        }
        return child;
    });
    const launch = (id: string) => runAddedHostedSession({
        environment: { [PROCESS_OWNER_ENV_KEY]: formatProcessOwnerTag({
            happierHomeDir: configuration.happyHomeDir, owner: { kind: 'session', sessionId: id },
        }) },
        workingDirectory: process.cwd(), end() {},
    }, () => spawnAuthorizedHostExecLaunchForHost({ command: 'fixture.exe', args: [], env: {}, release() {} }, {
        processTreeSystemBoundary: {
            platform: 'win32',
            censusDependencies: {
                platform: 'win32', helperExecutablePath: 'custody.exe',
                execFile: async (_file, args) => {
                    const name = args.find(arg => arg.startsWith('--job='))?.slice(6);
                    const job = name ? jobs.get(name) : undefined;
                    return { stdout: JSON.stringify({
                        v: 1, capturedAtMs: Date.now(), logicalCpus: 1, partial: [],
                        rows: [process.pid, ...[...jobs.values()].map(entry => entry.descendant)].map(pid => ({
                            pid, ppid: 1, start: { startTimeMs: pid },
                            principal: { kind: 'sid', value: 'S-1-5-21-1000' },
                            name: 'fixture', memory: null, cpuTimeUs: null,
                            ...(job?.descendant === pid ? { jobs: [name] } : {}),
                        })),
                        jobObservations: name ? [{ name, ...(job
                            ? { state: 'live', pids: [job.descendant] } : { state: 'absent' }) }] : [],
                    }) };
                },
            },
            terminateWindowsJob: async ({ jobName }) => {
                jobs.get(jobName)?.launcher.exit(1);
                jobs.delete(jobName);
                return 'absent';
            },
        },
    }));
    try {
        const first = launch('a');
        const second = launch('b');
        const [firstJob, secondJob] = [...jobs.keys()];
        expect(jobs.size).toBe(2);
        await first.dispose();
        expect(jobs.has(firstJob!)).toBe(false);
        expect(jobs.has(secondJob!)).toBe(true);
        expect(second.child.exitCode).toBeNull();
        await second.dispose();
    } finally {
        for (const child of children) if (child.exitCode === null) child.exit(1);
        Object.defineProperty(process, 'platform', platform);
        native.spawn.mockReset();
    }
});
