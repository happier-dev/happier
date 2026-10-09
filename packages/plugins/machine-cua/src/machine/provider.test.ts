import { describe, expect, it, vi } from 'vitest';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createCuaNativeClient } from './nativeClient.js';
import { createCuaLocalSandbox } from './localSandbox.js';

const launch = { on: 'local', runtimeId: 'qemu', imageId: 'ghcr.io/acme/linux@sha256:chosen',
    size: { cpu: 4, memoryBytes: 4 * 1024 ** 3, diskBytes: 40 * 1024 ** 3 } };
const resource = { kind: 'sandbox', namespace: 'local', runtimeId: 'qemu', sandboxId: 'local:owned' };
const nativeSandbox = { id: 'local:owned', name: 'owned', location: 'local', runtime: 'qemu',
    kind: 'vm', image: launch.imageId, status: 'ready', state: 'running', ephemeral: false,
    endpoints: { env: 'http://private-host:3211?token=private' }, provider_details: 'private' };

function result(value: unknown, exitCode = 0): PluginProcessResult {
    return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)),
        stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
// Genuine native-process boundary. All argument generation, identity/schema
// decoding, power and cleanup logic beneath it is real.
function harness(...results: PluginProcessResult[]) {
    const argv: string[][] = [];
    const run = vi.fn(async (request: { args?: readonly string[] }) => {
        argv.push([...(request.args ?? [])]);
        const next = results.shift();
        if (!next) throw new Error('Unexpected native command');
        return next;
    });
    const native = createCuaNativeClient({ exec: { run }, executable: { kind: 'systemTool', id: 'cua' } });
    return { run, argv, native, sandbox: createCuaLocalSandbox(native) };
}

describe('single Cua native process adapter', () => {
    it('decodes JSON only after successful untruncated completion and respects cancellation', async () => {
        const h = harness(result({ native: 'fact' }), { ...result({ native: 'incomplete' }), stdoutTruncated: true }, result('not-json'));
        expect(await h.native.json(['sandbox', 'info', 'local:owned'])).toEqual({ kind: 'success', value: { native: 'fact' } });
        expect(await h.native.json(['sandbox', 'info', 'local:owned'])).toEqual({ kind: 'unknown', reason: 'truncated' });
        expect(await h.native.json(['sandbox', 'info', 'local:owned'])).toEqual({ kind: 'unknown', reason: 'response' });
        const aborted = AbortSignal.abort();
        await expect(h.native.json(['sandbox', 'create'], aborted)).rejects.toThrow();
        expect(h.argv).toHaveLength(3);
    });
    it('does not disclose native failures or mistake command text for a JSON result', async () => {
        const h = harness(result('private bearer in stderr', 1), result('Sandbox removed'));
        expect(await h.native.effect(['sandbox', 'rm', 'local:owned', '--force'])).toEqual({ kind: 'unknown', reason: 'termination' });
        expect(await h.native.effect(['sandbox', 'rm', 'local:owned', '--force'])).toEqual({ kind: 'success', value: undefined });
    });
});

describe('Cua local sandbox native identity and recovery', () => {
    it('creates explicitly locally on the selected runtime and ignores private returned fields', async () => {
        const h = harness(result(nativeSandbox));
        expect(await h.sandbox.create(launch, 'owned', launch.size.diskBytes)).toEqual({ kind: 'bound', resource });
        expect(h.argv[0]).toEqual(['--json', '--embedded', 'sandbox', 'create', '--on=local', '--runtime=qemu', '--name=owned',
            '--cpu=4', '--memory=4096MB', '--keep-on-failure', launch.imageId]);
    });
    it('refuses cloud or runtime drift and never falls back to another create', async () => {
        const h = harness(result({ ...nativeSandbox, id: 'cloud:owned', location: 'cloud' }));
        expect(await h.sandbox.create(launch, 'owned', launch.size.diskBytes)).toMatchObject({ kind: 'unknown',
            recovery: { namespace: 'local', runtimeId: 'qemu', sandboxId: 'local:owned' } });
        expect(h.argv).toHaveLength(1);
        const drift = harness(result({ ...nativeSandbox, runtime: 'runc' }));
        expect((await drift.sandbox.create(launch, 'owned', launch.size.diskBytes)).kind).toBe('unknown');
    });
    it('preserves exact recovery on lost creation reply and rejects ignored disk sizing before effect', async () => {
        const h = harness();
        expect(await h.sandbox.create(launch, 'owned', launch.size.diskBytes)).toMatchObject({ kind: 'unknown',
            recovery: { namespace: 'local', runtimeId: 'qemu', sandboxId: 'local:owned' } });
        const mismatch = harness();
        expect(await mismatch.sandbox.create(launch, 'owned', 20 * 1024 ** 3)).toEqual({ kind: 'unavailable', reason: 'image_disk_mismatch' });
        expect(mismatch.argv).toHaveLength(0);
    });
    it('distinguishes actual missing native compute, stale registry presence and failed reads', async () => {
        const h = harness(result(nativeSandbox), result({ ...nativeSandbox, image: null, status: 'missing', state: 'missing' }), result('Permission denied', 1));
        expect(await h.sandbox.inspect(resource)).toMatchObject({ existence: 'present', power: 'running', imageId: launch.imageId, resource });
        expect(await h.sandbox.inspect(resource)).toMatchObject({ existence: 'absent', power: 'unknown', resource });
        expect(await h.sandbox.inspect(resource)).toMatchObject({ existence: 'unknown', power: 'unknown', resource });
        expect(JSON.stringify(await harness(result(nativeSandbox)).sandbox.inspect(resource))).not.toContain('private');
    });
    it('does not treat a registry record with unknown engine status as proof of existing compute', async () => {
        const h = harness(result({ ...nativeSandbox, status: 'starting', state: 'unknown' }));
        expect(await h.sandbox.inspect(resource)).toMatchObject({ existence: 'unknown', power: 'unknown', resource });
        const pending = harness(result({ ...nativeSandbox, status: 'starting', state: 'unknown' }));
        expect(await pending.sandbox.power(resource, 'resume')).toMatchObject({ kind: 'unavailable', reason: 'native_resource_unknown' });
        expect(pending.argv).toHaveLength(1);
    });
    it('rejects native state-file path names before dispatch and does not normalize them to another identity', async () => {
        const h = harness();
        await expect(h.sandbox.create(launch, '../neighbor', launch.size.diskBytes)).rejects.toThrow();
        await expect(h.sandbox.destroy({ ...resource, sandboxId: 'local:..\\neighbor' })).rejects.toThrow();
        expect(h.argv).toHaveLength(0);
    });
    it('refuses native Stop rather than implementing it as delete, suspend or replacement', async () => {
        const h = harness();
        expect(await h.sandbox.power(resource, 'stop')).toEqual({ kind: 'unsupported', intent: 'stop', resource });
        expect(h.argv).toHaveLength(0);
    });
    it('observes power after acceptance and never resumes a missing or changed identity', async () => {
        const h = harness(result({ ...nativeSandbox, image: null, status: 'stopped', state: 'suspended' }), result('Resuming'), result(nativeSandbox));
        expect(await h.sandbox.power(resource, 'resume')).toMatchObject({ kind: 'observed', existence: 'present', power: 'running', resource });
        expect(h.argv[1]).toEqual(['--json', '--embedded', 'sandbox', 'resume', 'local:owned']);
        const missing = harness(result({ ...nativeSandbox, image: null, status: 'missing', state: 'missing' }));
        expect(await missing.sandbox.power(resource, 'resume')).toMatchObject({ kind: 'unavailable', reason: 'native_resource_absent' });
        expect(missing.argv).toHaveLength(1);
    });
});

describe('qualified local sandbox cleanup', () => {
    it('accepts only the awaited exact local deletion result, not native failure text or a neighboring identity', async () => {
        const h = harness(result(nativeSandbox), result({ deleted: 'local:owned', missing: false }));
        expect(await h.sandbox.destroy(resource)).toEqual({ kind: 'deleted', existence: 'absent', resource });
        expect(h.argv).toEqual([['--json', '--embedded', 'sandbox', 'info', 'local:owned'], ['--json', '--embedded', 'sandbox', 'rm', 'local:owned', '--force']]);
        const neighbor = harness(result(nativeSandbox), result({ deleted: 'local:neighbor', missing: false }));
        expect(await neighbor.sandbox.destroy(resource)).toMatchObject({ kind: 'unknown', existence: 'unknown', resource });
        const failure = harness(result(nativeSandbox), result('Deleted', 1));
        expect(await failure.sandbox.destroy(resource)).toMatchObject({ kind: 'unknown', existence: 'unknown', resource });
    });
    it('does not delete unqualified compute and preserves actual absence without another effect', async () => {
        const unknown = harness(result('Not found', 1));
        expect(await unknown.sandbox.destroy(resource)).toMatchObject({ kind: 'unknown', resource });
        expect(unknown.argv).toHaveLength(1);
        const missing = harness(result({ ...nativeSandbox, status: 'missing', state: 'missing' }));
        expect(await missing.sandbox.destroy(resource)).toEqual({ kind: 'deleted', existence: 'absent', resource });
        expect(missing.argv).toHaveLength(1);
    });
});
