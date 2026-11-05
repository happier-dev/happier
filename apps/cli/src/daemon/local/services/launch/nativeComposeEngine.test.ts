import { describe, expect, it } from 'vitest';
import { assertNativeComposeAvailable } from './nativeComposeLifecycle';
import { prepareNativeComposeNormalizationProfileForHost, readNativeComposeEngine, readNativeDockerEffectEngines } from './nativeComposeEngine';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';

describe('canonical Compose discovery lookup profile', () => {
    it('keeps binding lookup placeholders but pins owned controls from the sanctioned host tuple', async () => {
        const profile = await prepareNativeComposeNormalizationProfileForHost({ command: '/docker', prefix: [], cwd: '/release',
            env: { PATH: '/bin', PASSWORD: 'host-password', DOCKER_HOST: 'tcp://approved.example:2376',
                DOCKER_TLS_VERIFY: '1', COMPOSE_PARALLEL_LIMIT: '010', COMPOSE_COMPATIBILITY: 'true', DOCKER_API_VERSION: '1.46' },
            applicationEnvironmentNames: ['PASSWORD', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'HOME',
                'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'COMPOSE_PARALLEL_LIMIT', 'COMPOSE_COMPATIBILITY', 'DOCKER_API_VERSION'],
            discoveryLookup: true,
        });
        expect(profile.env).toEqual({ PATH: '/bin', PASSWORD: '__HAPPIER_BINDING__', DOCKER_API_VERSION: '__HAPPIER_BINDING__' });
        expect(profile.addedArguments).toEqual(['--host', 'tcp://approved.example:2376', '--tlsverify=true']);
        // Native environment Atoi is decimal; a flag must not reinterpret 010 as octal.
        expect(profile.addedComposeArguments).toEqual(['--parallel', '10']);
    });

    it('does not enable TLS or compatibility for absent original controls and preserves native default parallelism', async () => {
        const profile = await prepareNativeComposeNormalizationProfileForHost({ command: '/docker', prefix: [], cwd: '/release',
            env: { PATH: '/bin' }, applicationEnvironmentNames: ['PASSWORD', 'DOCKER_HOST', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY',
                'COMPOSE_PARALLEL_LIMIT', 'COMPOSE_COMPATIBILITY'], discoveryLookup: true,
        });
        expect(profile.env).toEqual({ PATH: '/bin', PASSWORD: '__HAPPIER_BINDING__' });
        expect(profile.addedArguments).toEqual([]);
        expect(profile.addedComposeArguments).toEqual(['--parallel', '-1']);
    });

    it('canonicalizes owned environment names on Windows without changing ordinary binding spelling', async () => {
        const profile = await prepareNativeComposeNormalizationProfileForHost({ command: 'docker.exe', prefix: [], cwd: 'C:\\release',
            env: { Path: 'C:\\bin', docker_host: 'tcp://approved.example:2375', compose_parallel_limit: '7', compose_compatibility: 'false' },
            applicationEnvironmentNames: ['Password', 'docker_host', 'docker_tls_verify', 'compose_parallel_limit', 'compose_compatibility'],
            discoveryLookup: true, platform: 'win32',
        });
        expect(profile.env).toEqual({ Path: 'C:\\bin', Password: '__HAPPIER_BINDING__' });
        expect(profile.addedArguments).toEqual(['--host', 'tcp://approved.example:2375']);
        expect(profile.addedComposeArguments).toEqual(['--parallel', '7']);
    });

    it('keeps the non-discovery projection free of binding lookup placeholders', async () => {
        const profile = await prepareNativeComposeNormalizationProfileForHost({ command: '/docker', prefix: [], cwd: '/release',
            env: { PATH: '/bin', PASSWORD: 'host-password', DOCKER_HOST: 'tcp://approved.example:2375',
                COMPOSE_PARALLEL_LIMIT: '5', COMPOSE_COMPATIBILITY: 'true', DOCKER_API_VERSION: '1.46' },
            applicationEnvironmentNames: ['PASSWORD', 'DOCKER_HOST', 'COMPOSE_PARALLEL_LIMIT', 'COMPOSE_COMPATIBILITY'],
        });
        expect(profile.env).toEqual({ PATH: '/bin', DOCKER_API_VERSION: '1.46' });
        expect(profile.addedArguments).toEqual(['--host', 'tcp://approved.example:2375']);
        expect(profile.addedComposeArguments).toEqual(['--parallel', '5', '--compatibility']);
    });
});

describe('canonical Compose engine observation', () => {
    it('admits installing a missing engine while preserving unavailable-engine ambiguity', async () => {
        const input = { command: 'docker', prefix: [], cwd: '/release', env: {},
            io: { async run() { throw Object.assign(new Error('missing executable'), { code: 'ENOENT' }); } } };
        await expect(readNativeDockerEffectEngines(input)).resolves.toEqual([]);
        await machineNativeEffectAdmission.run({ operation: { operationId: 'known-engine', kind: 'deploy' },
            keys: [{ kind: 'dockerEngine', dockerEndpoint: 'retained-engine' }] }, async () => {
            await expect(readNativeDockerEffectEngines(input)).resolves.toEqual(['retained-engine']);
        });
        for (const code of ['EACCES', 'ECONNREFUSED']) {
            await expect(readNativeDockerEffectEngines({ ...input,
                io: { async run() { throw Object.assign(new Error('unavailable'), { code }); } } }))
                .rejects.toMatchObject({ code: 'native_engine_impact_ambiguous' });
        }
    });
    it('uses the engine identity from structured Docker facts in one finite read', async () => {
        const calls: string[][] = [];
        const id = await assertNativeComposeAvailable({ command: '/docker', prefix: [], cwd: '/release', env: {},
            io: { async run(request) {
                calls.push([...request.args]);
                return { exitCode: 0, stdout: JSON.stringify({ ID: 'current-engine', OperatingSystem: 'Docker Desktop' }) };
            } },
        });
        expect(id).toBe('current-engine');
        expect(calls).toEqual([['info', '--format', '{{json .}}']]);
    });
    it.each([
        ['Docker Desktop', 'dockerDesktop'],
        ['Ubuntu 24.04.3 LTS', 'native'],
        [undefined, 'unknown'],
    ])('projects engine facts without using the host/client platform (%s)', async (operatingSystem, kind) => {
        const engine = await readNativeComposeEngine({ command: '/docker', prefix: [], cwd: '/release', env: {},
            io: { async run() { return { exitCode: 0, stdout: JSON.stringify({ ID: 'engine', OperatingSystem: operatingSystem }) }; } },
        });
        expect(engine).toEqual({ id: 'engine', kind });
    });
    it('does no native work after cancellation and preserves uncertain process custody', async () => {
        const controller = new AbortController();
        controller.abort();
        let reads = 0;
        const input = { command: '/docker', prefix: [], cwd: '/release', env: {},
            io: { async run() { reads++; return { exitCode: 0, stdout: '' }; } } };
        await expect(readNativeComposeEngine({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
        expect(reads).toBe(0);
        const custody = Object.assign(new Error('unsettled'), { code: 'plugin_exec_termination_incomplete' });
        await expect(readNativeComposeEngine({ ...input, io: { async run() { throw custody; } } })).rejects.toBe(custody);
        await expect(readNativeComposeEngine(input)).rejects.toMatchObject({ code: 'native_tool_unavailable',
            details: { prerequisite: { cause: 'unavailable' } } });
    });
});
