import { describe, expect, it, vi } from 'vitest';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createCuaNativeClient } from './nativeClient.js';
import { createCuaLocalSpace } from './localSpace.js';

const launch = { on: 'local', runtimeId: 'qemu', imageId: 'ghcr.io/acme/linux@sha256:chosen',
    size: { cpu: 4, memoryBytes: 4 * 1024 ** 3, diskBytes: 40 * 1024 ** 3 } };
const resource = { kind: 'space', runtimeId: 'qemu', sandboxId: 'local:owned', spaceId: 'local:owned' };
const sandbox = { id: 'local:owned', name: 'owned', location: 'local', runtime: 'qemu',
    kind: 'vm', image: launch.imageId, status: 'ready', state: 'running', ephemeral: false,
    endpoints: { env: 'http://private-host:3211?token=private' } };
const registered = { id: 'local:owned', provider: 'local', name: 'owned',
    power_state: 'running', token: 'private', url: 'http://private-host:3211' };
const neighbor = { id: 'local:neighbor', provider: 'local', name: 'neighbor' };

function result(value: unknown, exitCode = 0): PluginProcessResult {
    return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(JSON.stringify(value)), stderr: new Uint8Array(),
        stdoutTruncated: false, stderrTruncated: false };
}

// Only the OS/native-process boundary is replaced; the shared native transport
// and sandbox identity/lifecycle owner are exercised, not mocked.
function harness(...responses: Array<PluginProcessResult | Error>) {
    const argv: string[][] = [];
    const run = vi.fn(async (request: { args?: readonly string[] }) => {
        argv.push([...(request.args ?? [])]);
        const response = responses.shift();
        if (response instanceof Error) throw response;
        if (!response) throw new Error('Unexpected native command');
        return response;
    });
    const native = createCuaNativeClient({ exec: { run }, executable: { kind: 'systemTool', id: 'cua' } });
    return { argv, spaces: createCuaLocalSpace(native) };
}

describe('created local Cua Space native leaf', () => {
    it('binds the exact local Space only after inspecting its sandbox on the selected runtime', async () => {
        const h = harness(result({ spaces: [registered] }), result(sandbox));
        expect(await h.spaces.create(launch, 'owned', 20 * 1024 ** 3)).toEqual({ kind: 'bound', resource });
        expect(h.argv).toEqual([
            ['--json', '--embedded', 'spaces', 'create', '--on=local', '--runtime=qemu', '--name=owned',
                '--cpus=4', '--memory-mb=4096', '--disk-gb=40', '--', launch.imageId],
            ['--json', '--embedded', 'sandbox', 'info', 'local:owned'],
        ]);
    });

    it('does not adopt a returned neighbor or retry a dropped create response', async () => {
        const wrong = harness(result({ spaces: [neighbor] }));
        expect(await wrong.spaces.create(launch, 'owned', launch.size.diskBytes)).toMatchObject({ kind: 'unknown', recovery: resource });
        expect(wrong.argv).toHaveLength(1);
        const lost = harness(new Error('private failed reply'), result(sandbox), result({ spaces: [registered], relay_error: null }));
        expect(await lost.spaces.create(launch, 'owned', launch.size.diskBytes)).toMatchObject({ kind: 'unknown', recovery: resource });
        expect(await lost.spaces.inspect(resource)).toMatchObject({ resource, existence: 'present', registry: 'present' });
        expect(lost.argv.filter((args) => args.includes('create'))).toHaveLength(1);
    });

    it('refuses a local Space whose native sandbox is actually on another runtime', async () => {
        const h = harness(result({ spaces: [registered] }), result({ ...sandbox, runtime: 'runc' }));
        expect(await h.spaces.create(launch, 'owned', launch.size.diskBytes)).toMatchObject({ kind: 'unknown', recovery: resource });
        expect(h.argv).toHaveLength(2);
    });

    it('does not bind a VM Space whose actual image differs from the selected image', async () => {
        const h = harness(result({ spaces: [registered] }), result({ ...sandbox, image: 'ghcr.io/acme/linux@sha256:neighbor' }));
        expect(await h.spaces.create(launch, 'owned', launch.size.diskBytes)).toEqual({ kind: 'unknown', recovery: resource });
        expect(h.argv).toHaveLength(2);
    });

    it('does not round hardware sizes that the native integer MiB/GiB flags cannot represent', async () => {
        const h = harness();
        expect(await h.spaces.create({ ...launch, size: { ...launch.size, diskBytes: launch.size.diskBytes + 1 } }, 'owned', launch.size.diskBytes))
            .toEqual({ kind: 'unavailable', reason: 'native_size_units_unrepresentable' });
        expect(h.argv).toHaveLength(0);
    });

    it('creates a container Space through the sandbox owner and registers only that newly owned local id', async () => {
        const containerLaunch = { ...launch, runtimeId: 'gvisor' };
        const containerResource = { ...resource, runtimeId: 'gvisor' };
        const h = harness(result({ ...sandbox, runtime: 'gvisor', kind: 'container' }), result(registered));
        expect(await h.spaces.create(containerLaunch, 'owned', launch.size.diskBytes)).toEqual({ kind: 'bound', resource: containerResource });
        expect(h.argv).toEqual([
            ['--json', '--embedded', 'sandbox', 'create', '--on=local', '--runtime=gvisor', '--name=owned',
                '--cpu=4', '--memory=4096MB', '--keep-on-failure', launch.imageId],
            ['--json', '--embedded', 'spaces', 'add', 'local:owned'],
        ]);
        const invalid = harness();
        expect(await invalid.spaces.create(containerLaunch, 'owned', 20 * 1024 ** 3))
            .toEqual({ kind: 'unavailable', reason: 'image_disk_mismatch' });
        expect(invalid.argv).toHaveLength(0);
    });

    it('recovers the same created container after a lost registration reply without creating again', async () => {
        const containerLaunch = { ...launch, runtimeId: 'runc' };
        const containerResource = { ...resource, runtimeId: 'runc' };
        const container = { ...sandbox, runtime: 'runc', kind: 'container' };
        const h = harness(result(container), new Error('private registration reply lost'),
            result(container), result({ spaces: [registered] }));
        expect(await h.spaces.create(containerLaunch, 'owned', launch.size.diskBytes))
            .toEqual({ kind: 'unknown', recovery: containerResource });
        expect(await h.spaces.inspect(containerResource)).toMatchObject({ existence: 'present', registry: 'present', resource: containerResource });
        expect(h.argv.filter((args) => args.includes('create'))).toHaveLength(1);
    });

    it('keeps registry absence separate from native existence and does not expose addresses or tokens', async () => {
        const h = harness(result(sandbox), result({ spaces: [neighbor], relay_error: 'private relay unavailable' }));
        const inspected = await h.spaces.inspect(resource);
        expect(inspected).toMatchObject({ resource, existence: 'present', power: 'running', registry: 'absent' });
        expect(JSON.stringify(inspected)).not.toContain('private');
        expect(h.argv).not.toContainEqual(expect.arrayContaining(['local:neighbor']));
    });

    it('deletes the exact native sandbox and removes only its registry entry', async () => {
        const h = harness(result(sandbox), result({ deleted: 'local:owned', missing: false }),
            result({ spaces: [registered, neighbor], relay_error: null }), result({ removed: registered }),
            result({ spaces: [neighbor], relay_error: null }));
        expect(await h.spaces.destroy(resource)).toEqual({ kind: 'deleted', sandbox: 'absent', registry: 'removed', resource });
        expect(h.argv.filter((args) => args.includes('rm'))).toEqual([
            ['--json', '--embedded', 'sandbox', 'rm', 'local:owned', '--force'],
            ['--json', '--embedded', 'spaces', 'rm', 'local:owned'],
        ]);
        expect(h.argv.some((args) => args.includes('local:neighbor'))).toBe(false);
    });

    it('reports removed registry but uncertain native deletion as incomplete cleanup', async () => {
        const h = harness(result(sandbox), result({ error: 'private native failure' }, 1),
            result({ spaces: [registered, neighbor] }), result({ removed: registered }), result({ spaces: [neighbor] }));
        expect(await h.spaces.destroy(resource)).toEqual({ kind: 'incomplete', sandbox: 'unknown', registry: 'removed', resource });
    });

    it('does not treat registry removal acceptance as removal when the entry remains', async () => {
        const h = harness(result(sandbox), result({ deleted: 'local:owned', missing: true }),
            result({ spaces: [registered] }), result({ removed: registered }), result({ spaces: [registered] }));
        expect(await h.spaces.destroy(resource)).toEqual({ kind: 'incomplete', sandbox: 'absent', registry: 'present', resource });
    });

    it('can finish registry cleanup after the exact native sandbox is already absent', async () => {
        const h = harness(result({ ...sandbox, status: 'missing', state: 'missing' }), result({ spaces: [neighbor] }));
        expect(await h.spaces.destroy(resource)).toEqual({ kind: 'deleted', sandbox: 'absent', registry: 'removed', resource });
        expect(h.argv.filter((args) => args.includes('rm'))).toHaveLength(0);
    });

    it.each([
        { ...resource, spaceId: 'direct:host:3211' },
        { ...resource, spaceId: 'local:neighbor' },
        { ...resource, sandboxId: 'cloud:owned' },
    ])('does not grant imported or mismatched resources cleanup authority', async (input) => {
        const h = harness();
        await expect(h.spaces.destroy(input)).rejects.toThrow();
        expect(h.argv).toHaveLength(0);
    });

    it('preserves unsupported Stop instead of mapping it to Space suspend or delete', async () => {
        const h = harness();
        expect(await h.spaces.power(resource, 'stop')).toEqual({ kind: 'unsupported', intent: 'stop', resource });
        expect(h.argv).toHaveLength(0);
    });
});
