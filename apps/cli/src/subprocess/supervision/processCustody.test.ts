import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createProcessCustodyHandshakePath,
    createWindowsJobCustodyName,
    formatDarwinNativeStartIdentity,
    formatWindowsJobCustodyStartIdentity,
    observeNativeDarwinProcessStartIdentity,
    parseProcessCustodyHandshakeLine,
    parseProcessCustodyStartIdentity,
    queryProcessCustodyJob,
    resolveProcessCustodyRuntimeExecutable,
    terminateProcessCustodyByJob,
    waitForProcessCustodyHandshake,
} from './processCustody';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
    }));
});

describe('process custody identity format', () => {
    it('formats and parses the tagged Windows job identity', () => {
        const jobName = createWindowsJobCustodyName('opaque-1');
        expect(jobName).toMatch(/^Local\\happier-svc09-.+$/u);
        const identity = formatWindowsJobCustodyStartIdentity(jobName);
        expect(identity).toBe(`winjob:${jobName}`);
        expect(parseProcessCustodyStartIdentity(identity)).toEqual({
            kind: 'win32-job',
            jobName,
        });
    });

    it('formats and parses the tagged Darwin native identity', () => {
        const identity = formatDarwinNativeStartIdentity(4242, { sec: 1754041400, usec: 123456 });
        expect(identity).toBe('darwin-proc:4242:1754041400:123456');
        expect(parseProcessCustodyStartIdentity(identity)).toEqual({
            kind: 'darwin-proc',
            pid: 4242,
            sec: 1754041400,
            usec: 123456,
        });
    });

    it('parses legacy and malformed identities as null instead of guessing', () => {
        expect(parseProcessCustodyStartIdentity('41:1754041400000')).toBeNull();
        expect(parseProcessCustodyStartIdentity('garbage')).toBeNull();
        expect(parseProcessCustodyStartIdentity('winjob:')).toBeNull();
        expect(parseProcessCustodyStartIdentity('darwin-proc:4242:1754041400:1000000')).toBeNull();
        expect(parseProcessCustodyStartIdentity('darwin-proc:0:1754041400:1')).toBeNull();
        expect(() => formatWindowsJobCustodyStartIdentity('  ')).toThrow(TypeError);
    });

    it('parses the post-assignment handshake only for the exact expected job', () => {
        const jobName = createWindowsJobCustodyName('opaque-2');
        expect(parseProcessCustodyHandshakeLine(
            `{"v":1,"pid":1234,"job":${JSON.stringify(jobName)}}`,
            jobName,
        )).toEqual({ pid: 1234, jobName });
        expect(parseProcessCustodyHandshakeLine(
            `{"v":1,"pid":1234,"job":${JSON.stringify(jobName)}}`,
            createWindowsJobCustodyName('opaque-3'),
        )).toBeNull();
        expect(parseProcessCustodyHandshakeLine('{"v":1,"pid":0,"job":"x"}', 'x')).toBeNull();
        expect(parseProcessCustodyHandshakeLine('{"v":1,"pid":1234}', 'x')).toBeNull();
        expect(parseProcessCustodyHandshakeLine('not json', 'x')).toBeNull();
        expect(parseProcessCustodyHandshakeLine('', 'x')).toBeNull();
    });

    it('issues unguessable private handshake paths', () => {
        expect(createProcessCustodyHandshakePath()).not.toBe(createProcessCustodyHandshakePath());
    });
});

describe('process custody runtime outcomes', () => {
    function fakeExec(stdout: string, code = 0) {
        if (code === 0) {
            return vi.fn(async () => ({ stdout, stderr: '' }));
        }
        return vi.fn(async () => {
            throw Object.assign(new Error('custody helper failed'), { code });
        });
    }

    it('maps the job query outcomes honestly', async () => {
        await expect(queryProcessCustodyJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('{"v":1,"state":"absent"}\n'),
        })).resolves.toBe('absent');
        await expect(queryProcessCustodyJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('{"v":1,"state":"live","members":3}\n'),
        })).resolves.toBe('live');
        await expect(queryProcessCustodyJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('garbage'),
        })).resolves.toBe('unavailable');
        await expect(queryProcessCustodyJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('', 5),
        })).resolves.toBe('unavailable');
    });

    it('keeps membership-remaining distinct from proven absence', async () => {
        await expect(terminateProcessCustodyByJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('{"v":1,"state":"absent"}\n'),
        })).resolves.toBe('absent');
        await expect(terminateProcessCustodyByJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('{"v":1,"state":"members-remaining","members":2}\n'),
        })).resolves.toBe('members-remaining');
        await expect(terminateProcessCustodyByJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('', 3),
        })).resolves.toBe('members-remaining');
    });

    it('falls back to null when the Darwin native witness is unavailable or refuses', async () => {
        await expect(observeNativeDarwinProcessStartIdentity({
            executablePath: 'custody',
            pid: 4242,
            execFile: fakeExec('{"v":1,"pid":4242,"sec":1754041400,"usec":123456}\n'),
        })).resolves.toEqual({ sec: 1754041400, usec: 123456 });
        await expect(observeNativeDarwinProcessStartIdentity({
            executablePath: 'custody',
            pid: 4242,
            execFile: fakeExec('{"v":1,"pid":4242,"sec":1754041400,"usec":1000000}\n'),
        })).resolves.toBeNull();
        await expect(observeNativeDarwinProcessStartIdentity({
            executablePath: 'custody',
            pid: 4242,
            execFile: fakeExec('', 5),
        })).resolves.toBeNull();
    });
});

describe('post-assignment handshake', () => {
    it('consumes the marker exactly once and rejects foreign or malformed facts', async () => {
        const root = await mkdtemp(join(tmpdir(), 'process-custody-handshake-'));
        tempDirs.push(root);
        const handshakePath = join(root, 'handshake.json');
        const jobName = createWindowsJobCustodyName('opaque-4');
        await writeFile(
            handshakePath,
            `${JSON.stringify({ v: 1, pid: 4242, job: jobName })}\n`,
            'utf8',
        );
        const removals: string[] = [];
        await expect(waitForProcessCustodyHandshake({
            handshakePath,
            jobName,
            readFile: async (path) => await readFile(path, 'utf8'),
            removeFile: async (path) => {
                removals.push(path);
            },
            delay: async () => undefined,
        })).resolves.toEqual({ pid: 4242 });
        expect(removals).toEqual([handshakePath]);

        await writeFile(handshakePath, `${JSON.stringify({ v: 1, pid: 99, job: 'other' })}\n`, 'utf8');
        await expect(waitForProcessCustodyHandshake({
            handshakePath,
            jobName,
            readFile: async (path) => await readFile(path, 'utf8'),
            removeFile: async () => undefined,
            delay: async () => undefined,
        })).resolves.toBeNull();
    });

    it('answers null on timeout so callers fail custody closed', async () => {
        const root = await mkdtemp(join(tmpdir(), 'process-custody-handshake-missing-'));
        tempDirs.push(root);
        await expect(waitForProcessCustodyHandshake({
            handshakePath: join(root, 'never.json'),
            jobName: 'Local\\j',
            timeoutMs: 25,
            delay: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
        })).resolves.toBeNull();
    });
});

describe('staged runtime resolution', () => {
    it('answers null without a staged helper on this host instead of guessing a path', () => {
        // This checkout has no staged daemon-support payload, so the only
        // honest answer is absence: callers fail closed on that.
        if (process.platform === 'linux') {
            expect(resolveProcessCustodyRuntimeExecutable('linux')).toBeNull();
        }
        expect(typeof createProcessCustodyHandshakePath()).toBe('string');
    });

    it('smokes the real helper on this platform when one is staged for live validation', async () => {
        const executablePath = resolveProcessCustodyRuntimeExecutable();
        if (!executablePath || process.platform !== 'darwin') {
            // Real helper smoke is a mac-host live lane; unit runs skip it.
            return;
        }
        const { stdout } = await execFileAsync(executablePath, ['pid-startidentity', String(process.pid)]);
        const witness = JSON.parse(stdout) as { v: number; pid: number; sec: number; usec: number };
        expect(witness.v).toBe(1);
        expect(witness.pid).toBe(process.pid);
        expect(witness.usec).toBeGreaterThanOrEqual(0);
        expect(witness.usec).toBeLessThanOrEqual(999_999);
        // Cross-check the seconds against the independent `ps lstart` witness.
        const lstart = (
            await execFileAsync('ps', ['-o', 'lstart=', '-p', String(process.pid)])
        ).stdout.trim();
        expect(Math.trunc(Date.parse(lstart) / 1000)).toBe(witness.sec);
    });
});
