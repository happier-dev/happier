import { describe, expect, it, vi } from 'vitest';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { CuaLocalProvisionerSchemas, prepareCuaLocalStoredSchemas } from './localProvisionerSchemas.js';
import { createCuaNativeClient } from './nativeClient.js';
import { createCuaLocalSandbox } from './localSandbox.js';
import { createCuaLocalSpace } from './localSpace.js';

const launch = { on: 'local', runtimeId: 'qemu', imageId: 'ghcr.io/trycua/linux:24.04-disk',
    size: { cpu: 4, memoryBytes: 4096 * 1024 ** 2, diskBytes: 20 * 1024 ** 3 } };
const sandbox = { kind: 'sandbox', namespace: 'local', runtimeId: 'qemu', sandboxId: 'local:owned' };
const space = { kind: 'space', runtimeId: 'qemu', spaceId: 'local:owned', sandboxId: 'local:owned' };
function roles() {
    return CuaLocalProvisionerSchemas;
}
function nativeBoundary() {
    const run = vi.fn(async (): Promise<PluginProcessResult> => ({
        termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode('{}'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
    }));
    const native = createCuaNativeClient({ exec: { run }, executable: { kind: 'systemTool', id: 'cua' } });
    return { run, sandbox: createCuaLocalSandbox(native), space: createCuaLocalSpace(native) };
}

describe('Cua local portable provisioner role admission', () => {
    it('reopens stored native launch and resource additions while retaining strict role ingress', async () => {
        const stored = await prepareCuaLocalStoredSchemas();
        const futureLaunch = { ...launch, future: true, size: { ...launch.size, future: true } };
        expect(stored.launchStored.parse(futureLaunch)).toEqual(launch);
        expect(stored.resourceStored.parse({ ...space, future: true })).toEqual(space);
        expect(stored.resourceStored.safeParse({ ...space, runtimeId: 'cloud' }).success).toBe(false);
        expect(roles().acquireInput.safeParse({ launch: futureLaunch }).success).toBe(false);
        expect(roles().resourceInput.safeParse({ resource: { ...space, future: true } }).success).toBe(false);
    });
    it('admits the declared raw native launch/resource and bound family envelope without another value wrapper', () => {
        const schemas = roles();
        expect(schemas.acquireInput.parse({ launch })).toEqual({ launch });
        expect(schemas.resourceInput.parse({ resource: sandbox })).toEqual({ resource: sandbox });
        expect(schemas.resourceInput.parse({ resource: space })).toEqual({ resource: space });
        const bound = { kind: 'bound', resource: {
            contributionRef: { pluginId: 'test.machine-cua', localId: 'local-sandbox' }, schemaVersion: 1, value: sandbox,
        } };
        expect(schemas.acquireResult.parse(bound)).toEqual(bound);
        expect(schemas.acquireInput.safeParse({ launch: { value: launch } }).success).toBe(false);
        expect(schemas.resourceInput.safeParse({ resource: bound.resource }).success).toBe(false);
        expect(schemas.acquireResult.safeParse({ ...bound, resource: { ...bound.resource, value: { value: sandbox } } }).success).toBe(false);
    });
    it('rejects strict additions, nonlocal inputs and native numeric/path values outside their real contract', () => {
        const schemas = roles();
        expect(schemas.acquireInput.safeParse({ launch: { ...launch, extra: true } }).success).toBe(false);
        expect(schemas.acquireInput.safeParse({ launch: { ...launch, size: { ...launch.size, extra: true } } }).success).toBe(false);
        expect(schemas.resourceInput.safeParse({ resource: { ...sandbox, token: 'private' } }).success).toBe(false);
        expect(schemas.acquireInput.safeParse({ launch: { ...launch, on: 'cloud' } }).success).toBe(false);
        expect(schemas.acquireInput.safeParse({ launch: { ...launch, runtimeId: 'kubevirt' } }).success).toBe(false);
        expect(schemas.acquireInput.safeParse({ launch: { ...launch, size: { ...launch.size, cpu: 4_294_967_296 } } }).success).toBe(false);
        expect(schemas.acquireInput.safeParse({ launch: { ...launch, size: { ...launch.size, memoryBytes: Number.MAX_SAFE_INTEGER + 1 } } }).success).toBe(false);
        expect(schemas.acquireInput.safeParse({ launch: { ...launch, size: { ...launch.size, diskBytes: 1.5 } } }).success).toBe(false);
        expect(schemas.resourceInput.safeParse({ resource: { ...sandbox, sandboxId: 'local:..\\neighbor' } }).success).toBe(false);
        expect(schemas.resourceInput.safeParse({ resource: { ...sandbox, sandboxId: 'local:name\0tail' } }).success).toBe(false);
    });
    it('retains representable native CPU/byte boundaries without adding a hardware quota', () => {
        const admitted = { ...launch, size: { cpu: 4_294_967_295, memoryBytes: 1024 ** 2, diskBytes: Number.MAX_SAFE_INTEGER } };
        expect(roles().acquireInput.parse({ launch: admitted })).toEqual({ launch: admitted });
    });
    it('rejects trailing native-name newlines in portable resources and before native creation', async () => {
        const h = nativeBoundary();
        expect(roles().resourceInput.safeParse({ resource: { ...sandbox, sandboxId: 'local:owned\n' } }).success).toBe(false);
        expect(roles().resourceInput.safeParse({ resource: { ...space, spaceId: 'local:owned\n', sandboxId: 'local:owned\n' } }).success).toBe(false);
        await expect(h.sandbox.create(launch, 'owned\n', launch.size.diskBytes)).rejects.toThrow();
        await expect(h.space.create(launch, 'owned\n', launch.size.diskBytes)).rejects.toThrow();
        expect(h.run).not.toHaveBeenCalled();
    });
    it('rejects memory that cannot become native integral MiB before either local creation can dispatch', async () => {
        const h = nativeBoundary();
        const invalid = { ...launch, size: { ...launch.size, memoryBytes: launch.size.memoryBytes + 1 } };
        await expect(h.sandbox.create(invalid, 'owned', launch.size.diskBytes)).rejects.toThrow();
        // Spaces already owns native integer MiB/GiB qualification; a portable
        // declaration must not bypass that owner on its VM or container routes.
        await expect(h.space.create(invalid, 'owned', launch.size.diskBytes)).resolves.toEqual({
            kind: 'unavailable', reason: 'native_size_units_unrepresentable',
        });
        await expect(h.space.create({ ...invalid, runtimeId: 'gvisor' }, 'owned', launch.size.diskBytes)).rejects.toThrow();
        expect(h.run).not.toHaveBeenCalled();
    });
    it('rejects unequal created Space/sandbox identity before every native operation, including unsupported Stop', async () => {
        const h = nativeBoundary();
        const mismatched = { ...space, spaceId: 'local:neighbor' };
        await expect(h.sandbox.inspect(mismatched)).rejects.toThrow();
        await expect(h.sandbox.power(mismatched, 'stop')).rejects.toThrow();
        await expect(h.sandbox.destroy(mismatched)).rejects.toThrow();
        await expect(h.space.inspect(mismatched)).rejects.toThrow();
        await expect(h.space.power(mismatched, 'stop')).rejects.toThrow();
        await expect(h.space.destroy(mismatched)).rejects.toThrow();
        expect(h.run).not.toHaveBeenCalled();
    });
});
