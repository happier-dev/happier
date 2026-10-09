import { describe, expect, it, vi } from 'vitest';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createCuaNativeClient } from './nativeClient.js';
import { createCuaNativeFacts } from './nativeFacts.js';

// Native JSON shapes from trycua/cua@2bce4442c107fc34c45b374b29a35d09f630fd83:
// cua-vmm/src/auto.rs DoctorReport and cua-cli/src/catalog.rs row().
const doctor = {
    host: { os: 'linux', arch: 'x86_64', kvm: true, accel: { x86_64: 'kvm', aarch64: 'tcg' } },
    backends: [
        { backend: 'qemu', ready: true, provisionable: false, detail: 'private endpoint', missing: [], provisioning: [] },
        { backend: 'lume', ready: false, provisionable: false, detail: 'private' },
        { backend: 'container', ready: true, provisionable: false, detail: 'http://private-engine' },
        { backend: 'managed', ready: false, provisionable: true, detail: 'private' },
    ],
    qemu: { version: 'QEMU emulator version 10.1.0', binaries: { x86_64: '/private/qemu' }, qemu_img: '/private/qemu-img' },
    lume: { supported_host: false, serving: false, version: null, url: 'http://private-lume?token=private' },
    container: { reachable: true, gvisor: false, runtimes: ['runc'], endpoint: 'http://private-engine' },
};
const digest = 'sha256:397b827871cddd41bb9d1a3a8ab11684b503ab717fc1e0390cc4f451ac956759';
const image = {
    ref: 'ghcr.io/trycua/linux:24.04-disk', os: 'linux', arch: ['amd64', 'arm64'],
    local: 'qemu', published: true, spacesd: true, browser_tools: true,
    digest, sizes: { digest, platforms: [{ arch: 'amd64', disk: 21474836480 }] },
    cloud: 'kubevirt', create: ['cua sb create private'], summary: 'private',
    endpoint: 'http://private?token=private',
};

function result(value: unknown): PluginProcessResult {
    return {
        termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(JSON.stringify(value)), stderr: new Uint8Array(),
        stdoutTruncated: false, stderrTruncated: false,
    };
}

function harness(report: unknown = doctor, images: unknown = [image]) {
    const argv: string[][] = [];
    // Mock only the genuine OS/process boundary; the shared native JSON adapter
    // and all fact decoding/qualification execute unchanged.
    const run = vi.fn(async (request: { args?: readonly string[] }) => {
        const args = [...(request.args ?? [])];
        argv.push(args);
        if (['--json runtime doctor', '--json --embedded runtime doctor'].includes(args.join(' '))) return result(report);
        if (args.join(' ') === '--json images ls') return result(images);
        throw new Error('Unexpected native effect or credential read');
    });
    const native = createCuaNativeClient({ exec: { run }, executable: { kind: 'systemTool', id: 'cua' } });
    return { argv, run, facts: createCuaNativeFacts(native) };
}

describe('Cua native read facts', () => {
    it('reads real native shapes without effects and projects only nonsecret qualified facts', async () => {
        const h = harness();
        const facts = await h.facts.read();
        expect(facts.doctor).toMatchObject({ kind: 'known', value: {
            host: { os: 'linux', arch: 'x86_64', kvm: true },
            runtimes: [
                { id: 'qemu', ready: true, provisionable: false, version: '10.1.0' },
                { id: 'lume', ready: false, provisionable: false },
                { id: 'runc', ready: true }, { id: 'gvisor', ready: false },
            ],
        } });
        expect(facts.images).toMatchObject({ kind: 'known', value: [{
            imageId: image.ref, os: 'linux', runtimeIds: ['qemu'], architectures: ['amd64', 'arm64'],
            digest,
            disk: { kind: 'known', value: [{ arch: 'amd64', bytes: 21474836480 }] },
        }] });
        expect(facts.nativeVersion).toEqual({ kind: 'unknown', reason: 'not_reported' });
        expect(facts.headroom).toEqual({ kind: 'unknown', reason: 'not_reported' });
        expect(facts.license).toMatchObject({ component: 'cua-spacesd', license: 'FSL-1.1-MIT', qualification: 'unqualified' });
        expect(JSON.stringify(facts)).not.toContain('private');
        expect(h.argv).toEqual([['--json', '--embedded', 'runtime', 'doctor'], ['--json', 'images', 'ls']]);
    });

    it('uses the observed built-in gVisor runtime on macOS without claiming runc or macOS capture support', async () => {
        const h = harness({ ...doctor,
            host: { os: 'macos', arch: 'aarch64', kvm: false, accel: { x86_64: 'tcg', aarch64: 'hvf' } },
            backends: doctor.backends.map((backend) => ({ ...backend, ready: backend.backend === 'managed' })),
            container: { ...doctor.container, reachable: false },
        }, [{ ...image, ref: 'ghcr.io/trycua/linux:24.04', local: 'container' }]);
        const facts = await h.facts.read();
        expect(facts.doctor).toMatchObject({ kind: 'known', value: { runtimes: [
            { id: 'qemu', ready: false }, { id: 'lume', ready: false },
            { id: 'runc', ready: false }, { id: 'gvisor', ready: true },
        ] } });
        expect(facts.capture).toEqual({ kind: 'unknown', reason: 'not_reported' });
        expect(await h.facts.options()).toMatchObject({ choices: [
            { id: 'runc:ghcr.io/trycua/linux:24.04', available: false },
            { id: 'gvisor:ghcr.io/trycua/linux:24.04', available: true },
        ] });
    });

    it('exposes image/runtime choices without inventing complete launches, prices or available headroom', async () => {
        const h = harness();
        expect(await h.facts.check()).toEqual({ available: true });
        expect(await h.facts.options()).toEqual({ choices: [{
            id: `qemu:${image.ref}`, title: `${image.ref} (qemu)`, available: true,
            nativeFacts: { image: { id: image.ref, title: image.ref }, location: { id: 'qemu', title: 'qemu' } },
        }] });
        expect(h.argv.every((args) => args.join(' ') === '--json --embedded runtime doctor'
            || args.join(' ') === '--json images ls')).toBe(true);
    });

    it('does not treat provisioning, cloud images, unsupported architectures or stale size data as usable facts', async () => {
        const noRuntime = harness({ ...doctor, backends: doctor.backends.map((entry) => ({ ...entry, ready: false })) });
        expect(await noRuntime.facts.check()).toEqual({ available: false, code: 'native_runtime_unavailable' });
        const h = harness(doctor, [
            { ...image, ref: 'https://private?token=private' },
            { ...image, ref: 'ghcr.io/trycua/cloud:1', local: null },
            { ...image, ref: 'ghcr.io/trycua/unpublished:1', published: false },
            { ...image, ref: 'ghcr.io/trycua/arm:1', arch: ['arm64'], sizes: null },
            { ...image, sizes: { ...image.sizes, digest: 'sha256:stale' } },
        ]);
        const facts = await h.facts.read();
        expect(facts.images).toMatchObject({ kind: 'known', value: [
            { imageId: 'ghcr.io/trycua/arm:1', disk: { kind: 'unknown', reason: 'not_reported' } },
            { imageId: image.ref, disk: { kind: 'unknown', reason: 'image_digest_mismatch' } },
        ] });
        expect(await h.facts.options()).toMatchObject({ choices: [
            { id: 'qemu:ghcr.io/trycua/arm:1', available: false }, { id: `qemu:${image.ref}`, available: true },
        ] });
        expect(JSON.stringify(facts)).not.toContain('private');
    });

    it('keeps malformed or failed native reads unknown and honors cancellation without exposing native errors', async () => {
        const malformed = harness({ ...doctor, host: { ...doctor.host, os: 'cloud' } }, {});
        expect((await malformed.facts.read()).doctor).toEqual({ kind: 'unknown', reason: 'response' });
        expect(await malformed.facts.check()).toEqual({ available: false, code: 'native_facts_unknown' });
        expect(await malformed.facts.options()).toEqual({ choices: [] });
        const failed = harness();
        failed.run.mockRejectedValue(new Error('http://private?token=private'));
        expect((await failed.facts.read()).doctor).toEqual({ kind: 'unknown', reason: 'transport' });
        expect(await failed.facts.options()).toEqual({ choices: [] });
        const canceled = harness();
        await expect(canceled.facts.read(AbortSignal.abort())).rejects.toThrow();
        expect(canceled.argv).toHaveLength(0);
    });
});
