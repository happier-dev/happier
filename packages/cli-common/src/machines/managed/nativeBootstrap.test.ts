import { createHash } from 'node:crypto';
import type { JsonValue } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ManagedEnrollmentCorrelationV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createManagedNativeBootstrapIO, ensureManagedGuestSessionHolder } from './nativeBootstrap.js';
import { openManagedNativeChannel } from './nativeChannel.js';
import type { ManagedNativeBootstrapIO } from '../../systemTasks/kinds/managedMachineEnrollment.js';
import type { ManagedNativeInvocationIO } from './reconcile.js';

const correlation = ManagedEnrollmentCorrelationV1Schema.parse({ homeId: 'home', managedId: 'managed', requestId: 'request',
    expectedIntentRevision: 0, controller: { machineId: 'controller', installationId: 'installation' },
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'same-resource' } } });

describe('portable native enrollment IO', () => {
    it('preserves private Unicode input, binary views and decoded native output', async () => {
        const bytes = new Uint8Array([5, 0, 255, 128, 42]);
        const io = createManagedNativeBootstrapIO(correlation, async (role, body): Promise<JsonValue> => {
            if (role === 'putFile') {
                expect(body).toEqual({ resource: correlation.resource.value, guestPath: '/payload', bytesBase64: encodeBase64(bytes.subarray(1, 4)) });
                return { kind: 'confirmed' };
            }
            expect(role).toBe('exec');
            expect(body).toEqual({ resource: correlation.resource.value, argv: ['sh', '-c', 'read-private'],
                inputBase64: encodeBase64(new TextEncoder().encode('秘密\n')) });
            return { stdoutBase64: encodeBase64(new TextEncoder().encode('\uFEFFhéllo')), stderrBase64: '',
                stdoutTruncated: false, stderrTruncated: false,
                termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } } };
        });
        await io.putFile({ path: '/payload', bytes: bytes.subarray(1, 4) });
        expect(await io.exec({ command: 'read-private', input: '秘密\n' })).toEqual({ status: 0, stdout: '\uFEFFhéllo', stderr: '' });
        expect(decodeBase64(encodeBase64(bytes.subarray(1, 4)))).toEqual(bytes.subarray(1, 4));
    });
    it('never decodes incomplete native output as command success', async () => {
        const io = createManagedNativeBootstrapIO(correlation, async () => ({ stdoutBase64: 'c2VjcmV0', stderrBase64: '',
            stdoutTruncated: true, stderrTruncated: false,
            termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } } }));
        await expect(io.exec({ command: 'private-command' })).rejects.toMatchObject({ code: 'provider_unavailable' });
    });
});

describe('native stream channel', () => {
    // The provider's channel process is the boundary: an echo carrier that
    // ends when its stdin ends, like `holder attach` over `docker exec -i`.
    function echoCarrier() {
        const calls: unknown[] = [];
        const invoke = async (role: string, body: unknown, io?: ManagedNativeInvocationIO): Promise<JsonValue> => {
            calls.push({ role, body });
            let release!: () => void;
            const ended = new Promise<void>(resolve => { release = resolve; });
            const unbind = io!.channel!.bindInput({
                async write(data) { io!.channel!.onOutput({ stream: 'stdout', data: new Uint8Array([...new TextEncoder().encode('echo:'), ...data]) }); },
                async closeStdin() { release(); },
            });
            io!.signal?.addEventListener('abort', () => release(), { once: true });
            await ended;
            unbind();
            return { termination: { observed: { kind: 'exit', exitCode: 0 },
                requestedBy: io!.signal?.aborted ? { kind: 'abort' } : { kind: 'none' } } };
        };
        return { calls, invoke };
    }

    it('is a duplex byte stream over the stream role, written input arrives as live output', async () => {
        const carrier = echoCarrier();
        const channel = openManagedNativeChannel(correlation, carrier.invoke, { argv: ['hshim', 'attach', '--socket', '/s'] });
        const received: Buffer[] = [];
        channel.on('data', (chunk: Buffer) => received.push(chunk));
        channel.write(Buffer.from([0, 1, 2]));
        channel.write(Buffer.from('x'));
        await expect.poll(() => Buffer.concat(received).toString('latin1')).toBe('echo:\u0000\u0001\u0002echo:x');
        expect(carrier.calls).toEqual([{ role: 'stream', body: { resource: correlation.resource.value, argv: ['hshim', 'attach', '--socket', '/s'] } }]);
        const closed = new Promise(resolve => channel.once('close', resolve));
        channel.end();
        await closed;
        // The carrier's own termination is reported, never as the remote process's exit.
        expect(channel.carrierTermination).toMatchObject({ observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } });
    });

    it('ends the invocation when the channel is destroyed', async () => {
        const carrier = echoCarrier();
        const channel = openManagedNativeChannel(correlation, carrier.invoke, { argv: ['x'] });
        await new Promise(resolve => setImmediate(resolve));
        const closed = new Promise(resolve => channel.once('close', resolve));
        channel.destroy();
        await closed;
        await expect.poll(() => channel.carrierTermination?.requestedBy.kind).toBe('abort');
    });

    it('closes the channel when the provider refuses the stream role', async () => {
        const channel = openManagedNativeChannel(correlation, async () => { throw new Error('provider_unavailable'); }, { argv: ['x'] });
        const failure = await new Promise<Error>(resolve => channel.once('error', resolve));
        expect(failure.message).toContain('provider_unavailable');
    });
});

describe('Session holder bootstrap in a managed guest', () => {
    // The guest is this host's shell in a private HOME: putFile and exec are the
    // provider's two native roles, implemented at the OS boundary.
    async function guest() {
        const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { spawn } = await import('node:child_process');
        const home = await mkdtemp(join(tmpdir(), 'holder-guest-'));
        const puts: string[] = [];
        let tamperUpload = false;
        const io: ManagedNativeBootstrapIO = {
            putFile: async ({ path, bytes }) => {
                puts.push(path);
                await writeFile(path, tamperUpload ? Buffer.from('tampered') : bytes);
            },
            exec: ({ command }) => new Promise((resolve, reject) => {
                const child = spawn('sh', ['-c', command], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
                let stdout = ''; let stderr = '';
                child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
                child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
                child.once('error', reject);
                child.once('close', status => resolve({ status: status ?? 1, stdout, stderr }));
            }),
        };
        return { home, io, puts, tamper: () => { tamperUpload = true; }, dispose: () => rm(home, { recursive: true, force: true }) };
    }
    const artifact = (text: string) => ({ bytes: new TextEncoder().encode(text), sha256: createHash('sha256').update(text).digest('hex') });
    const artifacts = { holder: artifact('#!/bin/sh\necho holder\n'), helper: artifact('#!/bin/sh\necho helper\n') };

    it('places both binaries once, digest-checked, in ~/.happier/holder/<version>/, and reuses them', async () => {
        const g = await guest();
        try {
            const resolve = vi.fn(async (platform: Readonly<{ os: string; arch: string }>) => { expect(platform.os).toBe('linux'); return artifacts; });
            const placed = await ensureManagedGuestSessionHolder({ io: g.io, version: '0.3.0-test', resolveArtifacts: resolve });
            expect(placed.holderPath).toBe(`${g.home}/.happier/holder/0.3.0-test/happier-session-holder`);
            expect(placed.helperPath).toBe(`${g.home}/.happier/holder/0.3.0-test/happier-process-custody`);
            expect(placed.socketDirectory).toBe(`${g.home}/.happier/holder/run`);
            expect(g.puts).toHaveLength(2);
            const run = await g.io.exec({ command: `"${placed.holderPath}"; stat -c %a "${placed.socketDirectory}"` });
            expect(run.stdout).toBe('holder\n700\n');
            await ensureManagedGuestSessionHolder({ io: g.io, version: '0.3.0-test', resolveArtifacts: resolve });
            expect(g.puts).toHaveLength(2);
        } finally { await g.dispose(); }
    });

    it('refuses a payload whose digest does not verify and promotes nothing', async () => {
        const g = await guest();
        try {
            g.tamper();
            await expect(ensureManagedGuestSessionHolder({ io: g.io, version: 'v', resolveArtifacts: async () => artifacts }))
                .rejects.toMatchObject({ code: 'session_holder_digest_mismatch' });
            const listed = await g.io.exec({ command: `ls -A "${g.home}/.happier/holder/v"` });
            expect(listed.stdout).toBe('');
        } finally { await g.dispose(); }
    });
});
