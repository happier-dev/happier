import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PluginExecSpawnRequest, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createCuaNativeClient } from './nativeClient.js';

function result(stdout = new Uint8Array(), exitCode = 0): PluginProcessResult {
    return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
        stdout, stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
const text = (value: string) => new TextEncoder().encode(value);
function privateFleetRoute(path = 'api/svc/owned-pool/bound-sandbox-env') {
    return { path, headers: { authorization: 'Bearer private-gateway', 'x-cua-env-authorization': 'Bearer private-env' } };
}

// Pinned cua.env.v1 protobuf boundary fixtures, not mocked internal codecs.
function field(id: number, value: Uint8Array | string) {
    const bytes = typeof value === 'string' ? text(value) : value;
    if (bytes.length >= 128) throw new Error('fixture needs a multibyte length');
    return Buffer.concat([Buffer.from([id * 8 + 2, bytes.length]), bytes]);
}
function grpc(...messages: Uint8Array[]) {
    const frame = (payload: Uint8Array, trailer = false) => {
        const header = Buffer.alloc(5);
        header[0] = trailer ? 128 : 0;
        header.writeUInt32BE(payload.length, 1);
        return Buffer.concat([header, payload]);
    };
    return Buffer.concat([...messages.map(message => frame(message)), frame(text('grpc-status: 0\r\n'), true)]);
}
function processResponse(stdout = new Uint8Array(), exitCode = 0) {
    return grpc(Buffer.from('0a040a02082a', 'hex'),
        ...(stdout.length ? [field(1, field(2, field(2, stdout)))] : []),
        Buffer.from([10, 4, 26, 2, 8, exitCode]));
}
function requestedUploadId(body: Uint8Array) {
    let cursor = 5; // Binary gRPC-Web frame header.
    function length() {
        let value = 0;
        let shift = 0;
        let byte: number;
        do { byte = body[cursor++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
        return value;
    }
    expect(body[cursor++]).toBe(10); // BeginUploadRequest.header field 1.
    const headerLength = length();
    cursor += headerLength;
    expect(body[cursor++]).toBe(18); // BeginUploadRequest.upload_id field 2.
    const idLength = length();
    return new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(cursor, cursor + idLength));
}

describe('Cua private native bootstrap carrier', () => {
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

    it('runs a namespace-qualified Fleet claim through buffered native gRPC-Web without lease or sandbox CLI effects', async () => {
        const requests: { url: string; body?: Uint8Array; headers?: Readonly<Record<string, string>> }[] = [];
        const target = { namespace: 'owned-pool', claimId: 'happier-owned' };
        const output = new Uint8Array([0, 128, 255]);
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run() { throw new Error('Fleet IO must not connect a native lease'); },
        }, fleet: { origin: 'https://fleet.example', headers: { authorization: 'Bearer private-gateway' },
            async guest(reference) {
                expect(reference).toMatchObject(target);
                return { path: 'api/svc/owned-pool/bound-sandbox-env', headers: { 'x-cua-env-authorization': 'Bearer private-env' } };
            }, http: { async request(request) {
                requests.push(request);
                expect(request.headers?.['content-type']).toBe('application/grpc-web+proto');
                expect(request.headers?.authorization).toBe('Bearer private-gateway');
                expect(request.headers?.['x-cua-env-authorization']).toBe('Bearer private-env');
                // StartProcessRequest.kill_on_disconnect=7, stdin=false (omitted).
                expect(Buffer.from(request.body ?? []).includes(Buffer.from([56, 1]))).toBe(true);
                return { status: 200, finalUrl: request.url, headers: {}, body: processResponse(output, 7) };
            } } } });
        const observed = await native.execGuest('fleet:owned-pool:happier-owned', ['happier']);
        expect(observed.stdout).toEqual(Buffer.from(output));
        expect(observed.termination).toEqual({ observed: { kind: 'exit', exitCode: 7 }, requestedBy: { kind: 'none' } });
        expect(requests.map(request => new URL(request.url).pathname)).toEqual([
            '/api/svc/owned-pool/bound-sandbox-env/cua.env.v1.ProcessService/StartProcess',
        ]);
        expect(requests.every(request => !Buffer.from(request.body ?? []).includes(text('private-gateway')))).toBe(true);
    });

    it('uses the native negotiated upload chunks for private Fleet stdin and confirms cleanup', async () => {
        const input = new Uint8Array([0, 128, 255, 1, 2]);
        const directory = '/tmp/happier-cua.native-private';
        const methods: string[] = [];
        const chunks: Uint8Array[] = [];
        let received = 0;
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run() { throw new Error('Fleet IO must use the exact native gateway'); },
        }, fleet: { origin: 'https://fleet.example',
            async guest() { return privateFleetRoute(); },
            http: { async request(request) {
                const method = new URL(request.url).pathname.split('/').at(-1) ?? '';
                methods.push(method);
                let response: Uint8Array;
                if (method === 'StartProcess') {
                    const body = Buffer.from(request.body ?? []);
                    response = processResponse(body.includes(text('mktemp -d')) ? text(`${directory}\n`) : new Uint8Array());
                } else if (method === 'BeginUpload') {
                    response = grpc(Buffer.concat([field(1, requestedUploadId(request.body ?? new Uint8Array())), Buffer.from([24, 2])]));
                } else if (method === 'UploadChunk') {
                    const size = Math.min(2, input.length - received);
                    const bytes = (request.body ?? new Uint8Array()).slice(-size);
                    chunks.push(bytes); received += size;
                    response = grpc(Buffer.from([8, received]));
                } else if (method === 'CommitUpload') {
                    response = grpc(field(2, createHash('sha256').update(input).digest('hex')));
                } else throw new Error(`unexpected native RPC ${method}`);
                return { status: 200, finalUrl: request.url, headers: {}, body: response };
            } } } });
        await native.execGuest('fleet:owned-pool:happier-owned', ['happier'], input);
        expect(Buffer.concat(chunks)).toEqual(Buffer.from(input));
        expect(methods).toEqual(['StartProcess', 'BeginUpload', 'UploadChunk', 'UploadChunk', 'UploadChunk',
            'CommitUpload', 'StartProcess', 'StartProcess']);
    });

    it('preserves separate Fleet binary output streams and native signal termination', async () => {
        const stdout = new Uint8Array([0, 128, 255]);
        const stderr = new Uint8Array([129, 0]);
        const body = grpc(Buffer.from('0a040a02082a', 'hex'), field(1, field(2, field(2, stdout))),
            field(1, field(2, Buffer.concat([Buffer.from([8, stdout.length]), field(3, stderr)]))),
            Buffer.from('0a041a02100f', 'hex'));
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run() { throw new Error('unexpected native CLI'); },
        }, fleet: { origin: 'https://fleet.example/prefix',
            async guest() { return privateFleetRoute(); },
            http: { async request(request) {
                expect(new URL(request.url).pathname).toBe('/prefix/api/svc/owned-pool/bound-sandbox-env/cua.env.v1.ProcessService/StartProcess');
                return { status: 200, finalUrl: request.url, headers: {}, body };
            } } } });
        const observed = await native.execGuest('fleet:owned-pool:happier-owned', ['happier']);
        expect(observed.stdout).toEqual(Buffer.from(stdout));
        expect(observed.stderr).toEqual(Buffer.from(stderr));
        expect(observed.termination).toEqual({ observed: { kind: 'signal', signal: 'SIGTERM' }, requestedBy: { kind: 'none' } });
    });

    it('refuses a guest route outside the exact Fleet namespace before disclosing private command arguments', async () => {
        const effects: string[] = [];
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run() { effects.push('cli'); return result(); },
        }, fleet: { origin: 'https://fleet.example',
            async guest() { return privateFleetRoute('api/svc/other-pool/bound-sandbox-env'); },
            http: { async request(request) {
                effects.push(request.url);
                return { status: 200, finalUrl: request.url, headers: {}, body: processResponse() };
            } } } });
        await expect(native.execGuest('fleet:owned-pool:happier-owned', ['private-command'])).rejects.toThrow('cua_native_exec_unavailable');
        expect(effects).toEqual([]);
    });

    it('rejects incomplete Fleet process streams and a native failure trailer instead of reporting completion', async () => {
        let body = grpc(Buffer.from('0a040a02082a', 'hex'));
        let reachedNativeProcess = false;
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run() { throw new Error('unexpected native CLI'); },
        }, fleet: { origin: 'https://fleet.example',
            async guest() { return privateFleetRoute(); },
            http: { async request(request) {
                reachedNativeProcess = new URL(request.url).pathname.endsWith('/cua.env.v1.ProcessService/StartProcess');
                return { status: 200, finalUrl: request.url, headers: {}, body };
            } } } });
        await expect(native.execGuest('fleet:owned-pool:happier-owned', ['happier'])).rejects.toThrow();
        expect(reachedNativeProcess).toBe(true);
        reachedNativeProcess = false;
        body = Buffer.from(processResponse()).subarray(0, -1);
        await expect(native.execGuest('fleet:owned-pool:happier-owned', ['happier'])).rejects.toThrow();
        expect(reachedNativeProcess).toBe(true);
        reachedNativeProcess = false;
        body = Buffer.from(processResponse());
        body[body.length - 3] = 55; // grpc-status 7 (permission denied).
        await expect(native.execGuest('fleet:owned-pool:happier-owned', ['happier'])).rejects.toThrow();
        expect(reachedNativeProcess).toBe(true);
    });

    it('refuses Fleet native IO before effects when the private guest credential factory is absent', async () => {
        const effects: string[] = [];
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run() { effects.push('cli'); return result(); },
        }, fleet: { origin: 'https://fleet.example', http: { async request(request) {
            effects.push(request.url);
            return { status: 200, finalUrl: request.url, headers: {}, body: processResponse() };
        } } } });
        await expect(native.execGuest('fleet:owned-pool:happier-owned', ['happier'])).rejects.toThrow('cua_native_exec_unavailable');
        expect(effects).toEqual([]);
    });

    it.each(['authorization', 'x-cua-env-authorization'])('refuses Fleet native IO before effects when %s is unavailable', async (missing) => {
        const effects: string[] = [];
        const headers: Record<string, string> = { ...privateFleetRoute().headers };
        delete headers[missing];
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run() { effects.push('cli'); return result(); },
        }, fleet: { origin: 'https://fleet.example',
            async guest() { return { path: 'api/svc/owned-pool/bound-sandbox-env', headers }; },
            http: { async request(request) {
                effects.push(request.url);
                return { status: 200, finalUrl: request.url, headers: {}, body: processResponse() };
            } } } });
        await expect(native.execGuest('fleet:owned-pool:happier-owned', ['happier'])).rejects.toThrow('cua_native_exec_unavailable');
        expect(effects).toEqual([]);
    });

    it('aborts an uncertain Fleet upload and cleans its private directory after cancellation', async () => {
        const controller = new AbortController();
        const methods: string[] = [];
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run() { throw new Error('unexpected native CLI'); },
        }, fleet: { origin: 'https://fleet.example',
            async guest() { return privateFleetRoute(); },
            http: { async request(request, options) {
                const method = new URL(request.url).pathname.split('/').at(-1) ?? '';
                methods.push(method);
                if (method === 'UploadChunk') { controller.abort(); throw new Error('native transport refused'); }
                if (controller.signal.aborted) expect(options?.signal).toBeUndefined();
                const body = method === 'BeginUpload'
                    ? grpc(Buffer.concat([field(1, requestedUploadId(request.body ?? new Uint8Array())), Buffer.from([24, 2])]))
                    : method === 'AbortUpload' ? grpc(new Uint8Array())
                    : processResponse(methods.length === 1 ? text('/tmp/happier-cua.native-private\n') : new Uint8Array());
                return { status: 200, finalUrl: request.url, headers: {}, body };
            } } } });
        await expect(native.execGuest('fleet:owned-pool:happier-owned', ['happier'], text('private'), controller.signal)).rejects.toThrow();
        expect(methods).toEqual(['StartProcess', 'BeginUpload', 'UploadChunk', 'AbortUpload', 'StartProcess']);
    });

    it('reports Fleet private file publication as unknown when cleanup cannot be confirmed', async () => {
        let starts = 0;
        const input = text('private');
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run() { throw new Error('unexpected native CLI'); },
        }, fleet: { origin: 'https://fleet.example',
            async guest() { return privateFleetRoute(); },
            http: { async request(request) {
                const method = new URL(request.url).pathname.split('/').at(-1) ?? '';
                let body: Uint8Array;
                if (method === 'StartProcess') {
                    starts++;
                    body = starts === 1 ? processResponse(text('/tmp/happier-cua.native-private\n'))
                        : processResponse(new Uint8Array(), starts === 3 ? 1 : 0);
                } else if (method === 'BeginUpload') body = grpc(Buffer.concat([
                    field(1, requestedUploadId(request.body ?? new Uint8Array())), Buffer.from([24, 10]),
                ]));
                else if (method === 'UploadChunk') body = grpc(Buffer.from([8, input.length]));
                else if (method === 'CommitUpload') body = grpc(field(2, createHash('sha256').update(input).digest('hex')));
                else throw new Error(`unexpected native RPC ${method}`);
                return { status: 200, finalUrl: request.url, headers: {}, body };
            } } } });
        expect(await native.putGuestFile('fleet:owned-pool:happier-owned', '/tmp/private-file', input)).toEqual({ kind: 'unknown' });
    });

    it('does not upload to or abort a different native upload identity returned by BeginUpload', async () => {
        const methods: string[] = [];
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            async run() { throw new Error('unexpected native CLI'); },
        }, fleet: { origin: 'https://fleet.example',
            async guest() { return privateFleetRoute(); },
            http: { async request(request) {
                const method = new URL(request.url).pathname.split('/').at(-1) ?? '';
                methods.push(method);
                const body = method === 'BeginUpload'
                    ? grpc(Buffer.concat([field(1, 'unrelated-upload'), Buffer.from([24, 2])]))
                    : method === 'AbortUpload' ? grpc(new Uint8Array())
                    : processResponse(methods.length === 1 ? text('/tmp/happier-cua.native-private\n') : new Uint8Array());
                if (method === 'AbortUpload') expect(Buffer.from(request.body ?? []).includes(text('unrelated-upload'))).toBe(false);
                return { status: 200, finalUrl: request.url, headers: {}, body };
            } } } });
        await expect(native.execGuest('fleet:owned-pool:happier-owned', ['happier'], text('private'))).rejects.toThrow();
        expect(methods).toEqual(['StartProcess', 'BeginUpload', 'AbortUpload', 'StartProcess']);
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
