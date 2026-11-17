import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { createNativeComposeLifecycle, readNativeComposeLogTargetForHost } from './nativeComposeLifecycle';
import { readColdNativeComposeTargetsForHost } from './nativeComposeDiscovery';
import { readNativeComposeEngine } from './nativeComposeEngine';
import { createNativeComposeImageIdentity } from './nativeComposeImageIdentity';
import { createMachineServicesRuntime } from './machineServices';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

const target = { deploymentRoot: '/deployments', environmentId: 'environment', environmentInstanceId: 'instance',
    projectName: 'project', composeService: 'web' };
const malformed = '{"PRIVATE_VALUE":"private-container-secret",';

describe('native Compose local failure diagnostics', () => {
    afterEach(() => vi.restoreAllMocks());

    it('retains the native engine IO cause before projecting its existing prerequisite refusal', async () => {
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        await expect(readNativeComposeEngine({ command: '/docker', prefix: [], cwd: '/release', env: {}, io: {
            async run() { throw Object.assign(new Error('private engine text'), { code: 'ECONNREFUSED' }); },
        } })).rejects.toMatchObject({ code: 'native_tool_unavailable' });
        expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            phase: 'native_compose.engine.read', errorClass: 'Error', errorCode: 'ECONNREFUSED', httpStatus: null,
        }));
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private engine text');
    });

    it('retains invalid native image JSON causes before the existing identity refusal', async () => {
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const images = createNativeComposeImageIdentity({ directory: async () => '/unused',
            async run() { return { exitCode: 0, stdout: malformed }; } });
        await expect(images.readLocalImage('image')).rejects.toMatchObject({ code: 'native_failed' });
        expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            phase: 'native_compose.image.parse', errorClass: 'SyntaxError', errorCode: null, httpStatus: null,
        }));
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-container-secret');
    });

    it('retains malformed watch candidate causes without publishing or mutating a watch', async () => {
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
        const target = { serverId: 'home', machineId: 'machine' };
        const runtime = createMachineServicesRuntime({ target, readMetadata: () => ({ status: 'unavailable' }),
            captureMetadataPort: () => ({ read: async () => ({ status: 'unavailable' }),
                compareAndSwap: async () => { throw new Error('Malformed watch must not reach metadata mutation'); } }) });
        try {
            expect(await runtime.execute({ actionId: 'machines.services.watch', context: { surface: 'cli', authority: 'present_user' },
                input: { ...target, candidateId: malformed, expectedRevision: 'a'.repeat(64), lifecyclePurpose: 'deployment' } }))
                .toEqual({ kind: 'unavailable', reason: 'unavailable' });
            expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                phase: 'machine_service.watch.parse', errorClass: 'SyntaxError', errorCode: null, httpStatus: null,
            }));
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-container-secret');
        } finally { await runtime.dispose(); await fixture.dispose(); }
    });

    it('retains malformed cold inspection causes while keeping observation unavailable and output private', async () => {
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        expect(readNativeComposeLogTargetForHost({ ...target, stdout: malformed })).toBeNull();
        expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            phase: 'native_compose.containers.parse', errorClass: 'SyntaxError', errorCode: null, httpStatus: null,
        }));
        diagnostic.mockClear();
        expect(await readColdNativeComposeTargetsForHost({ ...target, composeServices: ['web'],
            async run(args) { return { exitCode: 0, stdout: args[0] === 'ps' ? 'a'.repeat(64) : malformed }; } })).toBeNull();
        expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            phase: 'native_compose.discovery.parse', errorClass: 'SyntaxError', errorCode: null, httpStatus: null,
        }));
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-container-secret');
    });

    it('retains native inspection transport causes without turning an unknown observation into success', async () => {
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const capture = createNativeComposeLifecycle({ args: ['compose', '--project-name', 'project', 'up', 'web'], io: {
            async run() { throw Object.assign(new Error('private inspection text'), { code: 'ECONNREFUSED' }); },
        } });
        capture.bindLaunch({ command: '/docker', args: ['compose', '--project-name', 'project', 'up', 'web'], cwd: '/release', env: {}, release() {} });
        expect(await capture.lifecycle.inspect()).toMatchObject({ phase: 'unknown' });
        expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            phase: 'native_compose.inspect', errorClass: 'Error', errorCode: 'ECONNREFUSED', httpStatus: null,
        }));
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private inspection text');
    });

    it('retains accounting parse and transport causes after observing the native generation', async () => {
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const id = 'a'.repeat(64);
        const args = ['compose', '--project-name', 'project', 'up', 'web'];
        const row = { Id: id, Config: { Labels: { 'com.docker.compose.project': 'project', 'com.docker.compose.service': 'web' } },
            State: { Status: 'running' }, NetworkSettings: { Ports: {} } };
        let failure: Error | undefined;
        const capture = createNativeComposeLifecycle({ args, engineId: 'engine', environment: { composeService: 'web', containerIds: [id] }, io: {
            async events() { return { async dispose() {} }; },
            async run(request) {
                if (request.args.includes('stats')) {
                    if (failure) throw failure;
                    return { exitCode: 0, stdout: malformed };
                }
                return { exitCode: 0, stdout: JSON.stringify([row]) };
            },
        } });
        capture.bindLaunch({ command: '/docker', args, cwd: '/release', env: {}, release() {} });
        const subscription = await capture.lifecycle.observe!(() => {});
        try {
            expect(await capture.lifecycle.readAccounting!()).toEqual({ kind: 'unavailable', reason: 'unavailable' });
            expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                phase: 'native_compose.accounting.parse', errorClass: 'SyntaxError', errorCode: null, httpStatus: null,
            }));
            diagnostic.mockClear();
            failure = Object.assign(new Error('private accounting text'), { code: 'EIO' });
            expect(await capture.lifecycle.readAccounting!()).toEqual({ kind: 'unavailable', reason: 'unavailable' });
            expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                phase: 'native_compose.accounting', errorClass: 'Error', errorCode: 'EIO', httpStatus: null,
            }));
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private accounting text');
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-container-secret');
        } finally { await subscription.dispose(); }
    });
});
