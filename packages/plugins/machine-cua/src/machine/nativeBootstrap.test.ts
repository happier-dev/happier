import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginExecSpawnRequest, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createCuaNativeClient } from './nativeClient.js';

function result(stdout = new Uint8Array(), exitCode = 0): PluginProcessResult {
    return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
        stdout, stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
const text = (value: string) => new TextEncoder().encode(value);

describe('Cua private native bootstrap carrier', () => {
    it('preserves authored failure details when private file cleanup refuses', async () => {
        const refusal = new PluginError({ code: 'host_access_denied', message: 'Allow native cleanup', details: { phase: 'cleanup' } });
        const bytes = text('private input');
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run(request) {
                const args = request.args ?? [];
                const command = args.at(-1) ?? '';
                if (command.startsWith('rm -')) throw refusal;
                if (command.startsWith('mktemp -d')) return result(text('/tmp/happier-cua.native-private\n'));
                if (args.includes('cp')) return result(text(JSON.stringify({ direction: 'upload', size: bytes.length,
                    sha256: createHash('sha256').update(bytes).digest('hex') })));
                return result();
            },
        } });
        await expect(native.putGuestFile('local:owned', '/tmp/final-private-file', bytes)).rejects.toBe(refusal);
    });
    it('preserves authored failure details across native reads, effects and guest startup', async () => {
        const refusal = new PluginError({ code: 'host_access_denied', message: 'Allow the native process', details: { phase: 'admission' } });
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' },
            exec: { run: async () => { throw refusal; } } });
        for (const invoke of [() => native.json(['--embedded', 'runtime', 'doctor']),
            () => native.effect(['--embedded', 'sandbox', 'rm', 'local:owned']),
            () => native.execGuest('local:owned', ['true']),
            () => native.configureGuestProcess('local:owned', ['true'])]) await expect(invoke()).rejects.toBe(refusal);
    });
    it('runs every native command with the daemon user home so embedded state matches the user CLI', async () => {
        const requests: PluginExecSpawnRequest[] = [];
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run(request) { requests.push(request); return result(text('{}')); },
        } });
        expect((await native.json(['--embedded', 'runtime', 'doctor'])).kind).toBe('success');
        expect(requests).toHaveLength(1);
        expect(requests[0]?.env).toEqual({ HOME: homedir() });
    });

    it('puts private stdin through native files, preserves buffered bytes and cleans the guest and controller files', async () => {
        const requests: PluginExecSpawnRequest[] = [];
        const privateInput = text('private enrollment bearer\0binary');
        let localPath = '';
        const output = new Uint8Array([0, 128, 255, 10]);
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run(request) {
                requests.push(request);
                const args = request.args ?? [];
                if (args.includes('cp')) {
                    localPath = args[args.indexOf('cp') + 1];
                    expect(await readFile(localPath)).toEqual(Buffer.from(privateInput));
                    expect((await stat(localPath)).mode & 0o777).toBe(0o600);
                    return result(text(JSON.stringify({ direction: 'upload', size: privateInput.length,
                        sha256: createHash('sha256').update(privateInput).digest('hex') })));
                }
                const command = args.at(-1) ?? '';
                if (command.startsWith('mktemp -d')) return result(text('/tmp/happier-cua.native-private\n'));
                if (command.includes("'happier'")) return result(output, 7);
                return result();
            },
        } });
        const observed = await native.execGuest('local:owned', ['happier', 'auth', "literal '$()'"], privateInput);
        expect(observed.stdout).toEqual(output);
        expect(observed.termination.observed).toEqual({ kind: 'exit', exitCode: 7 });
        expect(JSON.stringify(requests)).not.toContain('private enrollment bearer');
        expect(requests.every((request) => request.args?.includes('--embedded'))).toBe(true);
        await expect(stat(localPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not run the guest after an unknown file transfer and attempts cleanup after cancellation', async () => {
        const controller = new AbortController();
        const requests: PluginExecSpawnRequest[] = [];
        let localPath = '';
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run(request) {
                requests.push(request);
                const args = request.args ?? [];
                if (args.includes('cp')) {
                    localPath = args[args.indexOf('cp') + 1];
                    controller.abort();
                    throw new Error('native endpoint with private bearer');
                }
                return args.at(-1)?.startsWith('mktemp -d') ? result(text('/tmp/happier-cua.native-private\n')) : result();
            },
        } });
        await expect(native.execGuest('local:owned', ['happier'], text('secret'), controller.signal)).rejects.toThrow();
        expect(requests.some((request) => request.args?.at(-1)?.includes("'happier'"))).toBe(false);
        expect(requests.some((request) => request.args?.at(-1)?.startsWith('rm -'))).toBe(true);
        await expect(stat(localPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each(['aws', 'gcp', 'modal'])('uses the exact qualified %s sandbox for private exec and file publication', async (cloud) => {
        const input = text('private remote enrollment');
        const requests: PluginExecSpawnRequest[] = [];
        const sandboxId = `${cloud}:happier-owned`;
        const output = new Uint8Array([0, 128, 255]);
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run(request) {
                requests.push(request);
                const args = request.args ?? [];
                if (args.includes('cp')) {
                    expect(args.at(-1)).toMatch(new RegExp(`^${sandboxId}:/tmp/happier-cua\\.native-private/(stdin|payload)$`));
                    return result(text(JSON.stringify({ direction: 'upload', size: input.length,
                        sha256: createHash('sha256').update(input).digest('hex') })));
                }
                expect(args[args.indexOf('shell') + 1]).toBe(sandboxId);
                const command = args.at(-1) ?? '';
                if (command.startsWith('mktemp -d')) return result(text('/tmp/happier-cua.native-private\n'));
                return command.includes("'happier'") ? result(output) : result();
            },
        } });
        expect((await native.execGuest(sandboxId, ['happier'], input)).stdout).toEqual(output);
        expect(await native.putGuestFile(sandboxId, '/tmp/final-private-file', input)).toEqual({ kind: 'confirmed' });
        expect(requests.every(request => request.args?.includes('--embedded'))).toBe(true);
        expect(requests.some(request => request.args?.includes('create') || request.args?.includes('connect'))).toBe(false);
        expect(JSON.stringify(requests)).not.toContain('private remote enrollment');
    });

    it('keeps captured controller credentials in process environment for native effects and private IO', async () => {
        const requests: PluginExecSpawnRequest[] = [];
        const environment = { AWS_SECRET_ACCESS_KEY: 'private-cloud-credential' };
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, environment, exec: {
            async run(request) {
                requests.push(request);
                return result(text('{}'));
            },
        } });
        expect((await native.json(['--embedded', 'cloud', 'status', 'aws'])).kind).toBe('success');
        expect((await native.effect(['--embedded', 'sandbox', 'delete', 'aws:happier-owned', '--force'])).kind).toBe('success');
        await native.execGuest('aws:happier-owned', ['happier']);
        expect(requests.every(request => request.env?.AWS_SECRET_ACCESS_KEY === environment.AWS_SECRET_ACCESS_KEY)).toBe(true);
        expect(JSON.stringify(requests.map(request => request.args))).not.toContain(environment.AWS_SECRET_ACCESS_KEY);
    });

    it.each(['cloud:owned', 'direct:host:3211', 'relay:abcd1234', 'owned', 'aws:../owned', 'gcp:owned:other'])('rejects unqualified or unsupported resource %s before file transfer or shell execution', async (reference) => {
        const requests: PluginExecSpawnRequest[] = [];
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run(request) { requests.push(request); return result(); },
        } });
        await expect(native.execGuest(reference, ['happier'], text('secret'))).rejects.toThrow();
        expect(requests).toEqual([]);
    });
    it('does not report successful bootstrap when private guest input cleanup is unconfirmed', async () => {
        const input = text('private');
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run(request) {
                const args = request.args ?? [];
                if (args.includes('cp')) return result(text(JSON.stringify({ direction: 'upload', size: input.length,
                    sha256: createHash('sha256').update(input).digest('hex') })));
                if (args.at(-1)?.startsWith('mktemp -d')) return result(text('/tmp/happier-cua.native-private\n'));
                return args.at(-1)?.startsWith('rm -') ? result(new Uint8Array(), 1) : result();
            },
        } });
        await expect(native.execGuest('local:owned', ['happier'], input)).rejects.toThrow('cua_private_input_cleanup_unknown');
    });
    it('keeps native temporary upload siblings private before publishing an arbitrary guest file', async () => {
        const input = text('private file');
        const requests: PluginExecSpawnRequest[] = [];
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run(request) {
                requests.push(request);
                const args = request.args ?? [];
                if (args.includes('cp')) {
                    // Pinned AtomicWriter creates a 0644 sibling while uploading:
                    // only a private parent protects its bytes before commit.
                    expect(args.at(-1)).toBe('local:owned:/tmp/happier-cua.native-private/payload');
                    return result(text(JSON.stringify({ direction: 'upload', size: input.length,
                        sha256: createHash('sha256').update(input).digest('hex') })));
                }
                return args.at(-1)?.startsWith('mktemp -d') ? result(text('/tmp/happier-cua.native-private\n')) : result();
            },
        } });
        expect(await native.putGuestFile('local:owned', '/tmp/final-private-file', input)).toEqual({ kind: 'confirmed' });
        expect(requests.some(request => request.args?.at(-1)?.includes("chmod 600 '/tmp/happier-cua.native-private/payload' && mv --"))).toBe(true);
        expect(requests.some(request => request.args?.at(-1)?.includes("rm -rf -- '/tmp/happier-cua.native-private'"))).toBe(true);
    });
    it('removes a native partial-upload sibling when stdin transfer fails before guest execution', async () => {
        let partialGuestInputRemains = false;
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run(request) {
                const args = request.args ?? [];
                if (args.includes('cp')) { partialGuestInputRemains = true; return result(new Uint8Array(), 1); }
                const command = args.at(-1) ?? '';
                if (command.startsWith('mktemp -d')) return result(text('/tmp/happier-cua.native-private\n'));
                if (command === "rm -rf -- '/tmp/happier-cua.native-private'") partialGuestInputRemains = false;
                // Real rmdir cannot remove a directory with a native .part file.
                return command.includes('rmdir') && partialGuestInputRemains ? result(new Uint8Array(), 1) : result();
            },
        } });
        await expect(native.execGuest('local:owned', ['happier'], text('private'))).rejects.toThrow();
        expect(partialGuestInputRemains).toBe(false);
    });
});
