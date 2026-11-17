import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentSecretVariableBindingV1, createDeploymentVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { authorizePluginExecLaunchForHost, createProjectNativeToolchainIoForHost, createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import { createNativeRuntimeProjectionForHost } from '@/daemon/local/services/launch/candidateRuntimeProjection';
import { readNativeComposeLogsForHost } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { admitNativeServiceCommandForHost, executeAdmittedServiceCommand } from '@/daemon/local/services/launch/serviceCommand';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES } from '@/plugins/runtime/invocation/services/managedServiceNativeLogs';
import { createProtectedLocalStateFileExclusive } from '@/utils/fs/protectedLocalState';
import { createScmBackendRegistry } from '@/scm/registry';
import { createSavedSecretMaterializerV1, type SavedSecretCatalogResourceInputV1 } from '@/settings/secrets/savedSecretCatalog';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createDeploymentSourceMaterializationPort } from '../targets/ownServer/exactCommitRelease';
import { createDeploymentGitRegistry } from '../targets/ownServer/exactCommitRelease.testkit';
import { createDeploymentExecEnvPortForHost } from './deploymentExecEnvPort';
import { prepareEnvironmentSecretBindings } from './environmentSecretBindingService';
import { prepareEnvironmentSecretBindingsForLaunch } from './prepareEnvironmentSecretBindingsForLaunch';

const executable = { kind: 'systemTool', id: 'fixture.node' } as const;
const sentinel = 'opaque-exec-composed-sentinel-71ad';
const pooledSentinel = 'pooled-database-sentinel-f198';
const directSentinel = 'direct-database-sentinel-fc82';
const buildSentinel = 'finite-build-only-sentinel-190d';
const sharedSentinel = 'shared-build-runtime-sentinel-e155';
const nativeComposeVersion = process.env.HAPPIER_NATIVE_COMPOSE_CONFIG_VERSION ?? '2.39.4';
const nativeInterpolationValues = {
    AM9_DOLLAR: 'prefix$sentinel $literal ${DO_NOT_EXPAND} $$ $(untouched) ${AM9_RESOURCE_LITERAL:?must-remain-literal}',
    AM9_BACKSLASH: 'C:\\one\\two\\\\tail\\',
    AM9_ESCAPE_INTERACTION: '\\$literal \\\\${DO_NOT_EXPAND} \\n \\" trailing\\',
    AM9_QUOTES: 'single\' and "double" #hash =equals',
    AM9_MULTILINE: 'one\n二\r\nthree\rfour\tend',
    AM9_UNICODE: 'é e\u0301 🐚 中文 \u2028\u2029',
    AM9_EMPTY: '',
    // Config-byte characterization only: this does NOT certify that a native
    // container OS environment can execute with NUL in an environment value.
    AM9_NUL: 'before\0after',
    AM9_BARE: 'native-bare-lookup',
    AM9_UNUSED: 'must-not-be-projected',
} as const;

async function withInvocation(run: (input: Readonly<{
    service: ReturnType<typeof createStablePluginExecService>;
    source: Awaited<ReturnType<ReturnType<typeof createDeploymentSourceMaterializationPort>['materialize']>>;
    port: ReturnType<typeof createDeploymentExecEnvPortForHost>;
    readMaterial(): Awaited<ReturnType<typeof prepareEnvironmentSecretBindingsForLaunch>> | undefined;
    buildPort?: ReturnType<typeof createDeploymentExecEnvPortForHost>;
    outside: string;
}>) => Promise<void>, connections?: 'both' | 'pooledOnly' | 'revokedDirect' | 'retainedBuilder' | 'nativeInterpolation' | 'nativeRepository' | 'nativeActivation' | 'telemetry' | 'telemetryOffline',
    envFileForm: 'literal' | 'bare' | 'required' = 'literal', finiteReferences = false, runtimeSecret = sentinel) {
    await withTempDir('deployment-exec-port-', async root => {
        const controller = new AbortController();
        const assertCurrent = async () => { controller.signal.throwIfAborted(); };
        const document = 'services: { web: { image: app } }';
        let repositorySource: { sourcePath: string; commitSha: string } | undefined;
        if (connections === 'nativeRepository') {
            const repository = join(root, 'repository');
            await mkdir(join(repository, 'included'), { recursive: true });
            const git = (args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
            git(['init', '--quiet']);
            git(['config', 'user.name', 'Deployment Fixture']);
            git(['config', 'user.email', 'deployment@example.test']);
            await writeFile(join(repository, 'compose.yaml'), 'include:\n  - included/compose.yaml\n');
            await writeFile(join(repository, 'included', 'compose.yaml'), [
                'services:', '  web:', '    image: native-config-only', '    env_file: runtime.env',
                '    environment:', '      EXPLICIT_ONLY: retained-explicit',
                ...(finiteReferences ? ['      PASSWORD: ${PASSWORD}'] : []),
                '    labels:', '      fixture.label-only: ${PORT}',
                ...(finiteReferences ? ['      fixture.binding: ${PASSWORD}'] : []),
                '  redis:', '    image: native-redis-config-only', '    environment:', '      REDIS_ONLY: retained-redis', '',
            ].join('\n'));
            await writeFile(join(repository, 'included', 'runtime.env'), [
                { literal: 'PASSWORD=file-value', bare: 'PASSWORD', required: 'PASSWORD=${PASSWORD:?required}' }[envFileForm],
                'FROM_BINDING=${PASSWORD}', 'FILE_ONLY=retained-file', '',
            ].join('\n'));
            git(['add', '.']);
            git(['commit', '--quiet', '-m', 'native Compose environment fixture']);
            repositorySource = { sourcePath: repository, commitSha: git(['rev-parse', 'HEAD']) };
        }
        const sourcePort = createDeploymentSourceMaterializationPort({
            registry: repositorySource ? createDeploymentGitRegistry() : createScmBackendRegistry([]), async admit() {
            const admission = { environmentId: 'environment', environmentInstanceId: 'environment', deploymentId: 'deployment',
                machineId: 'machine', installationId: 'installation', deploymentRoot: join(root, 'releases'),
                artifactDirectory: join(root, 'artifacts'), assertCurrent };
            if (repositorySource) return { ...admission, ...repositorySource };
            return { ...admission,
                definition: { kind: 'stored', contentRevision: 1, document,
                    composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web'] } };
        } });
        const source = await sourcePort.materialize({ environmentId: 'environment', deploymentId: 'deployment' });
        const outside = join(root, 'other-source');
        await mkdir(outside);
        const seed = new Uint8Array(32).fill(42);
        const bindings: EnvironmentSecretBindingV1[] = [
            createDeploymentSecretVariableBindingV1({ phase: 'runtime', name: 'PASSWORD', resourceId: 'credential', resourceRevision: 3 }),
            createDeploymentVariableBindingV1({ phase: 'runtime', name: 'PORT', source: { kind: 'value', value: '3000' } }),
        ];
        const resource: SavedSecretCatalogResourceInputV1 = { resourceId: 'credential', ownerAccountId: 'account',
            displayName: 'Credential', kind: 'password', encryptionMode: 'plain', revision: 3,
            materialStatus: 'ready', capabilities: { use: true },
            storedContent: { t: 'plain', v: { v: 1, name: 'Credential', kind: 'password', value: runtimeSecret } } };
        const resources = [resource];
        if (connections === 'telemetry' || connections === 'telemetryOffline') {
            bindings.push({ ...createDeploymentSecretVariableBindingV1({ phase: 'runtime', name: 'OTEL_EXPORTER_OTLP_HEADERS',
                resourceId: 'credential', resourceRevision: 3 }), managedBy: 'telemetry', valueFormat: 'otelAuthorizationHeader' });
            bindings.push({ ...createDeploymentVariableBindingV1({ phase: 'runtime', name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
                source: connections === 'telemetryOffline' ? { kind: 'deploymentFact', fact: 'telemetryEndpoint' }
                    : { kind: 'value', value: 'http://collector:4318' } }), managedBy: 'telemetry' });
        }
        if (connections && connections !== 'retainedBuilder' && connections !== 'nativeInterpolation' && connections !== 'nativeRepository' && connections !== 'telemetry' && connections !== 'telemetryOffline') {
            for (const [name, resourceId, value] of [
                ['DATABASE_URL', 'pooled-connection', pooledSentinel],
                ...(connections === 'pooledOnly' ? [] : [['DIRECT_URL', 'direct-connection', directSentinel]]),
            ]) {
                bindings.push(createDeploymentSecretVariableBindingV1({ phase: 'runtime', name, resourceId, resourceRevision: 3 }));
                resources.push({ ...resource, resourceId, displayName: 'Connection', storedContent: { t: 'plain', v: {
                    v: 1, name: 'Connection', kind: 'password', value,
                } } });
            }
        }
        if (connections === 'retainedBuilder') {
            for (const [name, phase, resourceId, value] of [
                ['BUILD_ONLY', 'build', 'build-only', buildSentinel],
                ['SHARED_BUILD', 'build', 'shared', sharedSentinel],
                ['SHARED_RUNTIME', 'runtime', 'shared', sharedSentinel],
            ] as const) {
                bindings.push(createDeploymentSecretVariableBindingV1({ phase, name, resourceId, resourceRevision: 3 }));
                if (!resources.some(resource => resource.resourceId === resourceId)) resources.push({ ...resource, resourceId, displayName: resourceId,
                    storedContent: { t: 'plain', v: { v: 1, name: resourceId, kind: 'password', value } } });
            }
        }
        if (connections === 'nativeInterpolation') for (const [name, value] of Object.entries(nativeInterpolationValues)) {
            if (name === 'AM9_DOLLAR') {
                const resourceId = 'native-interpolation-secret';
                bindings.push(createDeploymentSecretVariableBindingV1({ phase: 'runtime', name, resourceId, resourceRevision: 3 }));
                resources.push({ ...resource, resourceId, displayName: 'Native fixture secret', storedContent: { t: 'plain', v: {
                    v: 1, name: 'Native fixture secret', kind: 'password', value,
                } } });
            } else bindings.push(createDeploymentVariableBindingV1({ phase: 'runtime', name, source: { kind: 'value', value } }));
        }
        if (connections === 'nativeRepository' || connections === 'nativeActivation') for (const [name, value] of [
            ['ORDINARY_UNUSED', 'ordinary-unreferenced-binding'],
            ['DOCKER_HOST', 'tcp://application-only.invalid:2375'],
            ['COMPOSE_PARALLEL_LIMIT', 'application-not-an-integer'],
        ]) bindings.push(createDeploymentVariableBindingV1({ phase: 'runtime', name, source: { kind: 'value', value } }));
        const materializer = createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [],
            resources, resourceCatalogState: 'ready', isCurrent: () => true });
        const installation = { machineId: source.machineId, installationId: source.installationId,
            publicKey: nacl.sign.keyPair.fromSeed(seed).publicKey };
        const prepared = await prepareEnvironmentSecretBindings({ environmentId: source.environmentId, bindings,
            previousBindings: [], runtimeInstallations: [installation],
            ...(connections === 'retainedBuilder' ? { buildInstallation: installation } : {}),
            existingGrants: [], materializer, assertCurrent });
        const nativeEnvironment: Record<string, string> = Object.fromEntries(
            ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'PATHEXT', 'DOCKER_CONFIG'].flatMap(name => {
                const value = process.env[name]; return value === undefined ? [] : [[name, value]];
            }));
        const native = connections === 'nativeInterpolation' || connections === 'nativeRepository' || connections === 'nativeActivation';
        const service = createStablePluginExecService({
            ...(native ? { environment: nativeEnvironment,
                systemTools: createPluginExecSystemToolResolver({ baseEnv: nativeEnvironment,
                    definitions: [{ toolId: 'docker', displayName: 'Docker', lookupNames: ['docker'] }], registerGrant() {} }) } : {}),
            signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
            resolveExecutable: async () => {
                if (native) throw new Error('Expected canonical native Docker tool resolution');
                return { command: process.execPath };
            }, resolvePath: async () => source.rootPath });
        let material: Awaited<ReturnType<typeof prepareEnvironmentSecretBindingsForLaunch>> | undefined;
        const port = createDeploymentExecEnvPortForHost({ source, phase: 'runtime', signal: controller.signal,
            isCurrent: () => !controller.signal.aborted,
            prepare: async ({ phase }) => material = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: source.environmentId,
                machineId: source.machineId, installationId: source.installationId, installationPrivateSeed: seed,
                phase, bindings, grants: prepared.grants.filter(grant => connections !== 'revokedDirect'
                    || grant.kind !== 'secret' || grant.resourceId !== 'direct-connection'), assertCurrent,
                resolveNonSecret: async () => { throw new Error('collector_unreachable'); } }) });
        const buildPort = connections === 'retainedBuilder' ? createDeploymentExecEnvPortForHost({ source,
            phase: 'build', signal: controller.signal, isCurrent: () => !controller.signal.aborted,
            prepare: ({ phase }) => prepareEnvironmentSecretBindingsForLaunch({ environmentId: source.environmentId,
                machineId: source.machineId, installationId: source.installationId, installationPrivateSeed: seed,
                phase, bindings, grants: prepared.grants, assertCurrent }) }) : undefined;
        try { await run({ service, source, port, outside, buildPort, readMaterial: () => material }); }
        finally { controller.abort(); await source.abort(); }
    });
}

describe('deployment opaque environment through source, installation grants and canonical Exec', () => {
    it('keeps authored collector values while injecting declared empty telemetry slots at native launch', async () => {
        await withInvocation(async ({ service, source, port }) => {
            const telemetryFacts: unknown[] = [];
            const authored = { services: { web: { image: 'app', environment: {
                OTEL_EXPORTER_OTLP_ENDPOINT: 'https://project-collector.example',
                OTEL_EXPORTER_OTLP_HEADERS: null,
                PASSWORD: 'authored-ordinary-value',
            } }, worker: { image: 'worker', environment: {
                OTEL_EXPORTER_OTLP_ENDPOINT: null, OTEL_EXPORTER_OTLP_HEADERS: null,
            } } } };
            const attachment = await port.prepare({ source, phase: 'runtime' });
            // Docker normalization is the system boundary; carrier files, grants,
            // value selection, projection and Exec admission stay real.
            const projection = createNativeRuntimeProjectionForHost({ kind: 'configuration', bindRuntimeEnvironment: true,
                source, composeArguments: ['compose'], services: ['web', 'worker'], model: authored,
                onTelemetryProjection: facts => telemetryFacts.push(...facts),
                assertCurrent: () => source.assertCurrent(), io: {
                    async resolveTool() { return null; },
                    async run(request) {
                        return { exitCode: 0, stdout: JSON.stringify(request.args.includes('--variables')
                            ? { OTEL_EXPORTER_OTLP_ENDPOINT: {}, OTEL_EXPORTER_OTLP_HEADERS: {}, PASSWORD: {} } : authored) };
                    },
                } });
            const launch = await authorizePluginExecLaunchForHost(service, { executable, cwd: source.rootPath,
                args: ['compose', 'config'], deploymentEnv: attachment }, { agentIsolation: null,
                signal: new AbortController().signal, deploymentRuntimeProjection: projection });
            try {
                const include = JSON.parse(await readFile(launch.args[launch.args.indexOf('--file') + 1]!, 'utf8'));
                const model = JSON.parse(await readFile(include.include[0].path, 'utf8'));
                expect(model.services.web.environment).toEqual([
                    'OTEL_EXPORTER_OTLP_ENDPOINT=https://project-collector.example',
                    'PASSWORD=authored-ordinary-value',
                    'PASSWORD=${PASSWORD}',
                ]);
                expect(telemetryFacts).toEqual([
                    { service: 'web', usesOwnCollector: true, receivesTelemetry: false, requiresTelemetryEndpoint: false },
                    { service: 'worker', usesOwnCollector: false, receivesTelemetry: true, requiresTelemetryEndpoint: true },
                ]);
            } finally { await launch.release(); }
        }, 'telemetry');
    });
    it.each(['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
        'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'])(
        'launches with an authored collector %s while the unused managed collector is offline', async endpointName => {
        await withInvocation(async ({ service, source, port, readMaterial }) => {
            const authored = { services: { web: { image: 'app', environment: {
                [endpointName]: 'https://project-collector.example',
                OTEL_EXPORTER_OTLP_HEADERS: null, PASSWORD: null,
            } } } };
            const attachment = await port.prepare({ source, phase: 'runtime' });
            const projection = createNativeRuntimeProjectionForHost({ kind: 'configuration', bindRuntimeEnvironment: true,
                source, composeArguments: ['compose'], services: ['web'], model: authored,
                assertCurrent: () => source.assertCurrent(), io: { async resolveTool() { return null; },
                    async run(request) { return { exitCode: 0, stdout: JSON.stringify(request.args.includes('--variables')
                        ? { PASSWORD: {} } : authored) }; } } });
            const launch = await authorizePluginExecLaunchForHost(service, { executable, cwd: source.rootPath,
                args: ['compose', 'config'], deploymentEnv: attachment }, { agentIsolation: null,
                signal: new AbortController().signal, deploymentRuntimeProjection: projection });
            try {
                const include = JSON.parse(await readFile(launch.args[launch.args.indexOf('--file') + 1]!, 'utf8'));
                const model = JSON.parse(await readFile(include.include[0].path, 'utf8'));
                expect(model.services.web.environment).toEqual([
                    `${endpointName}=https://project-collector.example`,
                    'PASSWORD', 'PASSWORD=${PASSWORD}',
                ]);
                expect(readMaterial()?.env.PASSWORD).toBe(sentinel);
                expect(readMaterial()?.env).not.toHaveProperty('OTEL_EXPORTER_OTLP_HEADERS');
                expect(readMaterial()?.telemetryTokenHash).toBeUndefined();
            } finally { await launch.release(); }
        }, 'telemetryOffline');
    });
    it('delivers a Saved Secret as an OTLP header without changing ordinary secret variables', async () => {
        await withInvocation(async ({ service, source, port, readMaterial }) => {
            // Positive control uses the same installation grants and real Exec.
            const ordinary = await port.prepare({ source, phase: 'runtime' });
            const launch = await authorizePluginExecLaunchForHost(service, { executable, cwd: source.rootPath,
                args: ['-e', ''], deploymentEnv: ordinary }, { agentIsolation: null, signal: new AbortController().signal });
            try {
                expect(launch.env.PASSWORD).toBe(sentinel);
                expect(launch.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer%20${sentinel}`);
                expect(launch.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector:4318');
                expect(launch.env).not.toHaveProperty('OTEL_TRACES_SAMPLER');
                expect(launch.env).not.toHaveProperty('OTEL_TRACES_SAMPLER_ARG');
                expect(readMaterial()?.telemetryTokenHash).toBe(createHash('sha256').update(sentinel).digest('hex'));
            } finally { await launch.release(); }
        }, 'telemetry');
    });
    // Native opt-in runs pass the worker's DOCKER_CONFIG explicitly: Vitest's
    // isolated HOME intentionally does not contain user-installed CLI plugins.
    it.runIf(process.env.HAPPIER_NATIVE_SERVICE_EXEC_TEST === '1')(
        'activates private app bindings on native Docker and executes the retained service after P42 detach without steering the host', async () => {
            await withInvocation(async ({ service, source, port }) => {
                const { executable: docker } = await service.systemTools.resolve({ toolId: 'docker',
                    purpose: 'deployment-native-compose', cwd: source.rootPath });
                const nativeIo = createProjectNativeToolchainIoForHost({ async resolveTool() { return null; } });
                const io: typeof nativeIo = { ...nativeIo, async run(request) {
                    const result = await nativeIo.run(request);
                    expect(result.exitCode, JSON.stringify({ command: request.command, args: request.args,
                        stderr: (result.stderr ?? '').replaceAll(sentinel, '[REDACTED]') })).toBe(0);
                    return result;
                } };
                const projectName = `cp30-am9-${randomUUID()}`;
                const composeArguments = ['compose', '--project-name', projectName, '--project-directory', source.rootPath];
                const activation = await port.prepare({ source, phase: 'runtime' });
                const launch = await authorizePluginExecLaunchForHost(service, { executable: docker, cwd: source.rootPath,
                    args: ['compose', 'up'], deploymentEnv: activation }, {
                    agentIsolation: null,
                    signal: new AbortController().signal,
                    deploymentRuntimeProjection: createNativeRuntimeProjectionForHost({ kind: 'runtime', source,
                        composeArguments, services: ['web'], model: { services: { web: {
                            image: 'busybox:1.37', command: ['sleep', '3600'], network_mode: 'none',
                            environment: { PASSWORD: '${PASSWORD}', PORT: '${PORT}', DOCKER_HOST: '${DOCKER_HOST}',
                                COMPOSE_PARALLEL_LIMIT: '${COMPOSE_PARALLEL_LIMIT}' },
                        } } }, commandArguments: ['up', '--detach', '--pull', 'never', 'web'],
                        io, assertCurrent: () => source.assertCurrent(),
                    }),
                });
                try {
                    expect(launch.env.DOCKER_HOST).not.toBe('tcp://application-only.invalid:2375');
                    expect(launch.env.COMPOSE_PARALLEL_LIMIT).not.toBe('application-not-an-integer');
                    const result = await io.run({ command: launch.command, args: launch.args, cwd: source.rootPath,
                        env: launch.env, ...(launch.stdin ? { stdin: launch.stdin } : {}) });
                    expect(result.exitCode, result.stderr).toBe(0);
                    // The app keeps its environment; the detached current-command
                    // host goes back to the ordinary admitted host tuple.
                    const observer = launch.detachDeploymentEnvironmentForObservation?.();
                    if (!observer) throw new Error('Expected the retained native host tuple');
                    expect(observer.env.DOCKER_HOST).not.toBe('tcp://application-only.invalid:2375');
                    expect(observer.env.COMPOSE_PARALLEL_LIMIT).not.toBe('application-not-an-integer');
                    await machineNativeEffectAdmission.run({ operation: { operationId: projectName, kind: 'exec' }, keys: [] }, async context => {
                        const command = admitNativeServiceCommandForHost({ context, assertCurrent: () => source.assertCurrent(),
                            async launch() { return { ...observer,
                                args: [...composeArguments, 'exec', '-T', 'web', 'sh', '-c',
                                    'printenv PASSWORD; test "$DOCKER_HOST" = tcp://application-only.invalid:2375 && test "$COMPOSE_PARALLEL_LIMIT" = application-not-an-integer && test "$PORT" = 3000 && printf activation-exec-ok'],
                            }; },
                        });
                        expect(await executeAdmittedServiceCommand(command)).toMatchObject({ kind: 'completed', exitCode: 0,
                            stdout: '[REDACTED]\nactivation-exec-ok' });
                    });
                } finally {
                    await launch.release();
                    const found = await io.run({ command: launch.command, args: ['ps', '--all', '--quiet',
                        '--filter', `label=com.docker.compose.project=${projectName}`], cwd: source.rootPath, env: launch.env });
                    const ids = found.stdout.trim().split(/\s+/u).filter(Boolean);
                    if (ids.length) expect((await io.run({ command: launch.command,
                        args: ['rm', '--force', ...ids], cwd: source.rootPath, env: launch.env })).exitCode).toBe(0);
                }
            }, 'nativeActivation');
        });

    it.runIf(process.env.HAPPIER_NATIVE_COMPOSE_CONFIG_TEST === '1')(
        'decodes private carrier bytes with real pinned Compose 2.39.4 config without a Docker engine', async () => {
        await withInvocation(async ({ service, source, port }) => {
            const { executable: docker } = await service.systemTools.resolve({ toolId: 'docker',
                purpose: 'deployment-native-compose', cwd: source.rootPath });
            const version = await service.run({ executable: docker, cwd: source.rootPath, args: ['compose', 'version', '--short'] });
            expect(version.termination.observed, Buffer.from(version.stderr).toString('utf8')).toEqual({ kind: 'exit', exitCode: 0 });
            expect(Buffer.from(version.stdout).toString('utf8').trim()).toBe(nativeComposeVersion);
            const selected = Object.keys(nativeInterpolationValues).filter(name => name !== 'AM9_UNUSED');
            let privateDirectoryFile: string | undefined;
            let preparations = 0;
            let reloadableConfig = false;
            const options = { signal: new AbortController().signal, deploymentRuntimeProjection: { source,
                async prepare(runtime: Readonly<{
                    host: Readonly<{ env: Readonly<Record<string, string>> }>;
                    files(names: readonly string[]): Promise<Readonly<{ interpolationFile: string; emptyEnvironmentFile: string;
                        projectionFile: string; includeFile: string }>>;
                }>) {
                    preparations++;
                    const files = await runtime.files(selected);
                    privateDirectoryFile = files.interpolationFile;
                    // Minimal native consumer of the REAL carrier encoder. No
                    // fixture dotenv/interpolation decoder or Docker engine is
                    // involved. Bare declared slots are resolved by native
                    // include loading, then --no-interpolate emits exact JSON
                    // values rather than config's reloadable dollar escaping.
                    await createProtectedLocalStateFileExclusive(files.projectionFile, JSON.stringify({ services: {
                        web: { image: 'native-config-only', environment: selected },
                    } }));
                    await createProtectedLocalStateFileExclusive(files.includeFile, JSON.stringify({ include: [{
                        path: files.projectionFile, project_directory: source.rootPath, env_file: files.interpolationFile,
                    }] }));
                    return { env: runtime.host.env, args: ['compose', '--project-name', 'am9-config-only',
                        '--project-directory', source.rootPath, '--env-file', files.emptyEnvironmentFile,
                        '--file', files.includeFile, 'config', '--format', 'json',
                        ...(reloadableConfig ? [] : ['--no-interpolate']),
                        ...(reloadableConfig ? [] : ['--no-normalize', '--no-env-resolution']), '--no-consistency'] };
                } } };
            const attachment = await port.prepare({ source, phase: 'runtime' });
            const launch = await authorizePluginExecLaunchForHost(service, { executable: docker, cwd: source.rootPath,
                args: ['compose', 'config'], deploymentEnv: attachment }, { ...options, agentIsolation: null });
            try {
                expect(preparations, 'canonical Exec must consume the actual attachment carrier').toBe(1);
                expect(selected.every(name => !Object.hasOwn(launch.env, name))).toBe(true);
                const io = createProjectNativeToolchainIoForHost({ async resolveTool() { return null; } });
                const output = await io.run({ command: launch.command, args: launch.args, cwd: source.rootPath, env: launch.env });
                expect(output.exitCode).toBe(0);
                const model = JSON.parse(output.stdout);
                expect(model.services.web.environment).toEqual(selected.map(name => `${name}=${nativeInterpolationValues[name as keyof typeof nativeInterpolationValues]}`));
                expect(JSON.stringify(model)).not.toContain(nativeInterpolationValues.AM9_UNUSED);
            } finally { await launch.release(); }
            expect(privateDirectoryFile).toBeTruthy();
            await expect(access(privateDirectoryFile!)).rejects.toMatchObject({ code: 'ENOENT' });
            // Actual pinned Compose config emits doubled dollars for reload.
            // An embedded dollar means these bytes do not contain the entire
            // original secret, so original-only redaction cannot hide them.
            reloadableConfig = true;
            const reloadableAttachment = await port.prepare({ source, phase: 'runtime' });
            const reloadable = await authorizePluginExecLaunchForHost(service, { executable: docker, cwd: source.rootPath,
                args: ['compose', 'config'], deploymentEnv: reloadableAttachment }, { ...options, agentIsolation: null });
            try {
                const io = createProjectNativeToolchainIoForHost({ async resolveTool() { return null; } });
                const request = { command: reloadable.command, args: reloadable.args, cwd: source.rootPath, env: reloadable.env };
                const raw = await io.run(request);
                expect(raw.exitCode).toBe(0);
                const encoded = nativeInterpolationValues.AM9_DOLLAR.replaceAll('$', () => '$$');
                expect(raw.stdout).toContain(encoded);
                expect(raw.stdout).not.toContain(nativeInterpolationValues.AM9_DOLLAR);
                const redaction = reloadable.secretRedactionLease;
                if (!redaction) throw new Error('Expected actual carrier redaction custody');
                const chunks: Uint8Array[] = [];
                const staged = await io.run({ ...request, output: { redaction,
                    onChunk(_stream, chunk) { chunks.push(chunk); } } });
                expect(staged.exitCode).toBe(0);
                expect(staged.stdout).toContain('[REDACTED]');
                expect(staged.stdout).not.toContain(encoded);
                expect(staged.stderr ?? '').not.toContain(encoded);
                const delivered = Buffer.concat(chunks).toString('utf8');
                expect(delivered).toContain('[REDACTED]');
                expect(delivered).not.toContain(encoded);
            } finally { await reloadable.release(); }
            await expect(access(privateDirectoryFile!)).rejects.toMatchObject({ code: 'ENOENT' });
            // The production finite projection reads native environment-backed
            // secret values, then reloads their literal content through stdin.
            // Unlike ordinary config output, its raw resource query has not
            // escaped dollars yet. Exercise that second native load as well.
            const nativeResourceIo = createProjectNativeToolchainIoForHost({ async resolveTool() { return null; } });
            const resourceIo = { ...nativeResourceIo,
                async run(request: Parameters<typeof nativeResourceIo.run>[0]) {
                    const output = await nativeResourceIo.run(request);
                    if (output.exitCode !== 0) {
                        const phase = request.args.includes('--variables') ? 'variables'
                            : request.args.includes('--no-interpolate') ? 'raw-resources'
                            : request.stdin ? 'literal-resource-reload' : 'normalization';
                        const stderr = Object.values(nativeInterpolationValues).filter(value => value !== '').reduce(
                            (text, value) => text.replaceAll(value.replaceAll('$', () => '$$'), '[fixture-value]')
                                .replaceAll(value, '[fixture-value]'), output.stderr ?? '');
                        expect(output.exitCode, JSON.stringify({ phase, exitCode: output.exitCode,
                            stderr: stderr.slice(0, 2048) })).toBe(0);
                    }
                    return output;
                },
            };
            const resourceAttachment = await port.prepare({ source, phase: 'runtime' });
            const resourceLaunch = await authorizePluginExecLaunchForHost(service, { executable: docker, cwd: source.rootPath,
                args: ['compose', 'config'], deploymentEnv: resourceAttachment }, {
                agentIsolation: null,
                signal: options.signal,
                deploymentRuntimeProjection: createNativeRuntimeProjectionForHost({ kind: 'candidate', source,
                    composeArguments: ['compose', '--project-name', 'am9-resource-reload', '--project-directory', source.rootPath],
                    service: 'web', model: {
                        services: { web: { image: 'native-config-only', secrets: ['literal_secret'] } },
                        secrets: { literal_secret: { environment: 'AM9_DOLLAR' } },
                    },
                    commandArguments: ['config', '--format', 'json', '--no-consistency', 'web'],
                    io: resourceIo, assertCurrent: () => source.assertCurrent(),
                }),
            });
            try {
                expect(selected.every(name => !Object.hasOwn(resourceLaunch.env, name))).toBe(true);
                const reloaded = await resourceIo.run({ command: resourceLaunch.command, args: resourceLaunch.args,
                    cwd: source.rootPath, env: resourceLaunch.env,
                    ...(resourceLaunch.stdin ? { stdin: resourceLaunch.stdin } : {}) });
                // The secret contains a required expression as literal data.
                // Re-interpreting it on this native load must fail, so success
                // discriminates native semantic preservation without peeking
                // into the private stdin representation or a Docker engine.
                expect(reloaded.exitCode).toBe(0);
                const model = JSON.parse(reloaded.stdout);
                expect(JSON.stringify(model)).not.toContain(nativeInterpolationValues.AM9_UNUSED);
            } finally { await resourceLaunch.release(); }
        }, 'nativeInterpolation');
    });
    it.runIf(process.env.HAPPIER_NATIVE_COMPOSE_CONFIG_TEST === '1')(
        'reloads literal environment-backed config resources through pinned Compose', async () => {
        await withInvocation(async ({ service, source, port }) => {
            const { executable: docker } = await service.systemTools.resolve({ toolId: 'docker',
                purpose: 'deployment-native-compose', cwd: source.rootPath });
            const version = await service.run({ executable: docker, cwd: source.rootPath, args: ['compose', 'version', '--short'] });
            expect(version.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
            expect(Buffer.from(version.stdout).toString('utf8').trim()).toBe(nativeComposeVersion);
            const io = createProjectNativeToolchainIoForHost({ async resolveTool() { return null; } });
            const attachment = await port.prepare({ source, phase: 'runtime' });
            // This independent neighbor retains the observed native config
            // normalization refusal instead of conflating it with secret reload.
            const launch = await authorizePluginExecLaunchForHost(service, { executable: docker, cwd: source.rootPath,
                args: ['compose', 'config'], deploymentEnv: attachment }, {
                agentIsolation: null,
                signal: new AbortController().signal,
                deploymentRuntimeProjection: createNativeRuntimeProjectionForHost({ kind: 'candidate', source,
                    composeArguments: ['compose', '--project-name', 'am9-config-resource-reload', '--project-directory', source.rootPath],
                    service: 'web', model: {
                        services: { web: { image: 'native-config-only', configs: ['literal_config'] } },
                        configs: { literal_config: { environment: 'AM9_DOLLAR' } },
                    },
                    commandArguments: ['config', '--format', 'json', '--no-consistency', 'web'],
                    io, assertCurrent: () => source.assertCurrent(),
                }),
            });
            try {
                expect(Object.keys(nativeInterpolationValues).every(name => !Object.hasOwn(launch.env, name))).toBe(true);
                const reloaded = await io.run({ command: launch.command, args: launch.args, cwd: source.rootPath,
                    env: launch.env, ...(launch.stdin ? { stdin: launch.stdin } : {}) });
                expect(reloaded.exitCode).toBe(0);
                const encoded = nativeInterpolationValues.AM9_DOLLAR.replaceAll('$', () => '$$');
                expect(JSON.parse(Buffer.from(launch.stdin!).toString('utf8')).configs.literal_config.content).toBe(encoded);
                expect(JSON.parse(reloaded.stdout).configs.literal_config.content).toBe(encoded);
            } finally { await launch.release(); }
        }, 'nativeInterpolation');
    });
    it.runIf(process.env.HAPPIER_NATIVE_COMPOSE_CONFIG_TEST === '1').each([
        ...(['configuration', 'runtime'] as const).flatMap(kind =>
            (['literal', 'bare', 'required'] as const).map(envFileForm => ({ scope: 'ordinary' as const, kind, envFileForm }))),
        ...(['configuration', 'candidate'] as const).map(kind => ({ scope: 'finite' as const, kind, envFileForm: 'literal' as const })),
    ])(
        'preserves repository include and env_file inputs with $scope binding precedence through pinned Compose: $kind/$envFileForm', async ({ scope, kind, envFileForm }) => {
        await withInvocation(async ({ service, source, port }) => {
            const { executable: docker } = await service.systemTools.resolve({ toolId: 'docker',
                purpose: 'deployment-native-compose', cwd: source.rootPath });
            const version = await service.run({ executable: docker, cwd: source.rootPath, args: ['compose', 'version', '--short'] });
            expect(version.termination.observed, Buffer.from(version.stderr).toString('utf8')).toEqual({ kind: 'exit', exitCode: 0 });
            expect(Buffer.from(version.stdout).toString('utf8').trim()).toBe(nativeComposeVersion);
            const nativeIo = createProjectNativeToolchainIoForHost({ async resolveTool() { return null; } });
            const io = { ...nativeIo,
                async run(request: Parameters<typeof nativeIo.run>[0]) {
                    const output = await nativeIo.run(request);
                    if (output.exitCode !== 0) {
                        const stage = request.args.includes('--variables') ? 'variables'
                            : request.args.includes('--no-interpolate') ? 'source'
                            : request.stdin ? 'model-config' : 'included-config';
                        const stderr = [sentinel, '3000', 'ordinary-unreferenced-binding',
                            'tcp://application-only.invalid:2375', 'application-not-an-integer'].reduce(
                            (text, value) => text.replaceAll(value, '[fixture-value]'), output.stderr ?? '');
                        expect(output.exitCode, JSON.stringify({ stage, exitCode: output.exitCode,
                            stderr: stderr.slice(0, 2048) })).toBe(0);
                    }
                    return output;
                },
            };
            const signal = new AbortController().signal;
            const composeArguments = ['compose', '--project-name', 'ordinary-config-only', '--project-directory', source.rootPath];
            const services = ['web', 'redis'];
            const bindingNames = ['PASSWORD', 'PORT', 'ORDINARY_UNUSED', 'DOCKER_HOST', 'COMPOSE_PARALLEL_LIMIT'];
            const runProjection = async (projection: ReturnType<typeof createNativeRuntimeProjectionForHost>) => {
                const attachment = await port.prepare({ source, phase: 'runtime' });
                const launch = await authorizePluginExecLaunchForHost(service, { executable: docker, cwd: source.rootPath,
                    args: ['compose', 'config'], deploymentEnv: attachment }, { agentIsolation: null, signal, deploymentRuntimeProjection: projection });
                let privateInclude: string | undefined;
                try {
                    expect(bindingNames.every(name => !Object.hasOwn(launch.env, name))).toBe(true);
                    expect(JSON.stringify(launch.args)).not.toContain(sentinel);
                    const file = launch.args[launch.args.indexOf('--file') + 1];
                    if (file?.endsWith('include.json')) privateInclude = file;
                    const output = await io.run({ command: launch.command, args: launch.args, cwd: source.rootPath,
                        env: launch.env, ...(launch.stdin ? { stdin: launch.stdin } : {}), signal });
                    expect(output.exitCode).toBe(0);
                    return JSON.parse(output.stdout);
                } finally {
                    await launch.release();
                    if (privateInclude) await expect(access(privateInclude)).rejects.toMatchObject({ code: 'ENOENT' });
                }
            };
            // Read the committed include through the production source projection;
            // neither fixture files nor environment values are added to its materialized source.
            const model = await runProjection(createNativeRuntimeProjectionForHost({ kind: 'source', source,
                composeArguments, sourceFiles: [join(source.rootPath, 'compose.yaml')], services, io,
                assertCurrent: () => source.assertCurrent() }));
            expect(model.services.web.env_file).toMatchObject([{
                path: join(source.rootPath, 'included', 'runtime.env'),
            }]);
            const common = { source, model, composeArguments, services, io,
                assertCurrent: () => source.assertCurrent() };
            const projection = kind === 'configuration'
                ? createNativeRuntimeProjectionForHost({ ...common, kind, bindRuntimeEnvironment: scope === 'ordinary' })
                : kind === 'runtime' ? createNativeRuntimeProjectionForHost({ ...common, kind,
                    commandArguments: ['config', '--format', 'json', '--no-consistency', ...services] })
                : createNativeRuntimeProjectionForHost({ ...common, kind, service: 'web',
                    commandArguments: ['config', '--format', 'json', '--no-consistency', 'web'] });
            const resolved = await runProjection(projection);
            expect(resolved.services.web.environment).toEqual({
                PASSWORD: sentinel, FROM_BINDING: sentinel,
                EXPLICIT_ONLY: 'retained-explicit', FILE_ONLY: 'retained-file',
            });
            if (kind === 'candidate') expect(resolved.services).not.toHaveProperty('redis');
            else {
                expect(resolved.services.redis.environment).toEqual({ REDIS_ONLY: 'retained-redis' });
                for (const name of bindingNames) expect(resolved.services.redis.environment).not.toHaveProperty(name);
                expect(resolved.services.redis.image).toBe('native-redis-config-only');
            }
            expect(resolved.services.web.labels['fixture.label-only']).toBe('3000');
            if (scope === 'finite') expect(resolved.services.web.labels['fixture.binding']).toBe(sentinel);
            for (const name of bindingNames.filter(name => name !== 'PASSWORD')) {
                expect(resolved.services.web.environment).not.toHaveProperty(name);
            }
            expect(resolved.services.web).not.toHaveProperty('env_file');
            expect(resolved.services.web.image).toBe('native-config-only');
        }, 'nativeRepository', envFileForm, scope === 'finite');
    });
    it('ends finite build authority while retained same-installation runtime custody remains usable', async () => {
        await withInvocation(async ({ service, source, port, buildPort }) => {
            if (!buildPort) throw new Error('Expected admitted finite build port');
            await expect(port.prepare({ source, phase: 'build' })).rejects.toMatchObject({ code: 'unavailable' });
            await expect(buildPort.prepare({ source, phase: 'runtime' })).rejects.toMatchObject({ code: 'unavailable' });
            const runtimeEnv = await port.prepare({ source, phase: 'runtime' });
            const runtime = await authorizePluginExecLaunchForHost(service, { executable, cwd: source.rootPath,
                deploymentEnv: runtimeEnv, args: [] }, { agentIsolation: null });
            expect(runtime.env.PASSWORD).toBe(sentinel);
            expect(runtime.env.SHARED_RUNTIME).toBe(sharedSentinel);
            expect(runtime.env).not.toHaveProperty('BUILD_ONLY');
            expect(runtime.env).not.toHaveProperty('SHARED_BUILD');
            const observer = runtime.detachDeploymentEnvironmentForObservation?.();
            if (!observer) throw new Error('Expected serving runtime custody');
            expect(observer.deploymentSecretRefs).toEqual([
                { resourceId: 'credential', resourceRevision: 3 }, { resourceId: 'shared', resourceRevision: 3 },
            ]);
            try {
                const buildEnv = await buildPort.prepare({ source, phase: 'build' });
                const build = await authorizePluginExecLaunchForHost(service, { executable, cwd: source.rootPath,
                    deploymentEnv: buildEnv, args: [] }, { agentIsolation: null });
                expect(build.env.BUILD_ONLY).toBe(buildSentinel);
                expect(build.env.SHARED_BUILD).toBe(sharedSentinel);
                expect(build.env).not.toHaveProperty('PASSWORD');
                const buildRedaction = build.secretRedactionLease;
                await build.release();
                expect(build.env).not.toHaveProperty('BUILD_ONLY');
                expect(build.env).not.toHaveProperty('SHARED_BUILD');
                expect(buildRedaction?.isActive()).toBe(false);
                await expect(build.recheckInputs?.()).rejects.toMatchObject({ code: 'unavailable' });
                expect(observer.secretRedactionLease?.isActive()).toBe(true);
                expect(observer.secretRedactionLease?.redact(sharedSentinel)).toBe('[REDACTED]');
                const freshRuntime = await port.prepare({ source, phase: 'runtime' });
                const next = await authorizePluginExecLaunchForHost(service, { executable, cwd: source.rootPath,
                    deploymentEnv: freshRuntime, args: [] }, { agentIsolation: null });
                try { expect(next.env.SHARED_RUNTIME).toBe(sharedSentinel); expect(next.env).not.toHaveProperty('BUILD_ONLY'); }
                finally { await next.release(); }
            } finally { await observer.release(); }
        }, 'retainedBuilder');
    });

    it('transfers only exact refs and secret redaction once to the admitted observation tuple', async () => {
        await withInvocation(async ({ service, source, port }) => {
            const deploymentEnv = await port.prepare({ source, phase: 'runtime' });
            const launch = await authorizePluginExecLaunchForHost(service, { executable, cwd: source.rootPath, deploymentEnv, args: [] }, { agentIsolation: null });
            const delivered = launch.env;
            const observer = launch.detachDeploymentEnvironmentForObservation?.();
            if (!observer) throw new Error('Expected host generation custody transfer');
            try {
                expect(delivered).not.toHaveProperty('PASSWORD');
                expect(delivered).not.toHaveProperty('PORT');
                expect(observer.env).not.toHaveProperty('PASSWORD');
                expect(observer.env).not.toHaveProperty('PORT');
                expect(observer.deploymentSecretRefs).toEqual([{ resourceId: 'credential', resourceRevision: 3 }]);
                expect(Object.isFrozen(observer.deploymentSecretRefs)).toBe(true);
                expect(observer.secretRedactionLease?.redact(`${sentinel} PORT=3000`)).toBe('[REDACTED] PORT=3000');
                await expect(launch.recheckInputs?.()).rejects.toMatchObject({ code: 'unavailable' });
                expect(() => launch.detachDeploymentEnvironmentForObservation?.()).toThrow();
            } finally { await observer.release(); }
            expect(observer.secretRedactionLease?.isActive()).toBe(false);
        });
    });

    it('masks quoted runtime secret representations before the native log byte boundary', async () => {
        const marker = 'quoted-runtime-marker-8421';
        const runtimeSecret = `${marker}"value\ncontinuation`;
        await withInvocation(async ({ service, source, port }) => {
            const deploymentEnv = await port.prepare({ source, phase: 'runtime' });
            const launch = await authorizePluginExecLaunchForHost(service, { executable, cwd: source.rootPath, deploymentEnv, args: [] }, { agentIsolation: null });
            const observer = launch.detachDeploymentEnvironmentForObservation?.();
            if (!observer?.secretRedactionLease) throw new Error('Expected original runtime secret masking custody');
            const redactionLease = observer.secretRedactionLease;
            let diagnostic = `raw ${runtimeSecret} PORT=3000`;
            // Only native Docker output is substituted; the original grant,
            // attachment, detached lease and native page reader stay real.
            const read = () => readNativeComposeLogsForHost({ containerIds: ['a'.repeat(64)],
                environment: true, redactionLease, async run(_args, _signal, capture) {
                    capture?.output?.onChunk('stdout', Buffer.from(capture.output.redaction.redact(diagnostic)));
                    return { exitCode: 0 };
                },
            }, { kind: 'read', maxBytes: MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES });
            try {
                expect(await read()).toMatchObject({ kind: 'page', page: { text: 'raw [REDACTED] PORT=3000' } });
                const visiblePrefix = 'PORT=3000\n';
                const escaped = JSON.stringify(runtimeSecret).slice(1, -1);
                diagnostic = visiblePrefix + 'x'.repeat(MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES
                    - Buffer.byteLength(visiblePrefix, 'utf8') - Buffer.byteLength(marker, 'utf8') - 2) + escaped;
                const page = await read();
                expect(page.kind).toBe('page');
                if (page.kind !== 'page') throw new Error('Expected a retained generation log page');
                expect(page.page.text).toContain('PORT=3000');
                expect(page.page.text).not.toContain(marker);
                expect(page.page.text).toContain('[REDACTED]');
            } finally { await observer.release(); }
        }, undefined, 'literal', false, runtimeSecret);
    });

    it('retires finite delivered overlay copies and closes secret custody on release', async () => {
        await withInvocation(async ({ service, source, port }) => {
            const deploymentEnv = await port.prepare({ source, phase: 'runtime' });
            const launch = await authorizePluginExecLaunchForHost(service, { executable, cwd: source.rootPath, deploymentEnv, args: [] }, { agentIsolation: null });
            expect(launch.env.PASSWORD).toBe(sentinel);
            const redaction = launch.secretRedactionLease;
            await launch.release();
            expect(launch.env).not.toHaveProperty('PASSWORD');
            expect(launch.env).not.toHaveProperty('PORT');
            expect(redaction?.isActive()).toBe(false);
            await expect(launch.recheckInputs?.()).rejects.toMatchObject({ code: 'unavailable' });
            await expect(authorizePluginExecLaunchForHost(service, { executable, cwd: source.rootPath,
                deploymentEnv, args: [] }, { agentIsolation: null })).rejects.toMatchObject({ code: 'unavailable' });
        });
    });

    it.each(['both', 'pooledOnly', 'revokedDirect'] as const)('preserves ordinary runtime connection bindings through real Exec: %s', async connections => {
        await withInvocation(async ({ service, source, port }) => {
            if (connections === 'revokedDirect') {
                await expect(port.prepare({ source, phase: 'runtime' })).rejects.toMatchObject({ code: 'secret_missing' });
                return;
            }
            const before = await port.prepare({ source, phase: 'runtime' });
            const result = await service.run({ executable, cwd: source.rootPath, deploymentEnv: before, args: ['-e',
                'process.stdout.write(JSON.stringify({pooled:process.env.DATABASE_URL.startsWith("pooled-"),direct:process.env.DIRECT_URL?.startsWith("direct-")??false}));process.stderr.write(process.env.DATABASE_URL+(process.env.DIRECT_URL??""))'] });
            expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual({ pooled: true, direct: connections === 'both' });
            expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
            expect(JSON.stringify(result)).not.toContain(pooledSentinel);
            expect(JSON.stringify(result)).not.toContain(directSentinel);
        }, connections);
    });

    it('allows trusted caller environment additions while bindings keep precedence and process output stays redacted', async () => {
        await withInvocation(async ({ service, source, port }) => {
            const deploymentEnv = await port.prepare({ source, phase: 'runtime' });
            const result = await service.run({ executable, cwd: source.rootPath, deploymentEnv,
                env: { UNREVIEWED: 'caller-value', PASSWORD: 'caller-override' }, args: ['-e',
                    'process.stdout.write(JSON.stringify({selected:process.env.PASSWORD.startsWith("opaque-"),extra:process.env.UNREVIEWED}));process.stderr.write(process.env.PASSWORD)'] });
            expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual({ selected: true, extra: 'caller-value' });
            expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
            expect(Buffer.from(result.stderr).toString()).toBe('[REDACTED]');
            expect(JSON.stringify(result)).not.toContain(sentinel);
        });
    });

    it.each(['preparing', 'another'] as const)('allows trusted code to select its launch directory and %s Exec while retaining secret-safe process output', async selection => {
        await withInvocation(async ({ service, source, port, outside }) => {
            const deploymentEnv = await port.prepare({ source, phase: 'runtime' });
            const controller = new AbortController();
            const selectedExec = selection === 'preparing' ? service : createStablePluginExecService({ signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
                resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async path => String(path) });
            let result: Awaited<ReturnType<typeof service.run>>;
            try { result = await selectedExec.run({ executable, cwd: outside, deploymentEnv,
                args: ['-e', 'process.stdout.write(process.env.PASSWORD+" PORT="+process.env.PORT)'] });
            } finally { controller.abort(); }
            expect(Buffer.from(result.stdout).toString()).toBe('[REDACTED] PORT=3000');
            expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
            expect(JSON.stringify(result)).not.toContain(sentinel);
        });
    });
});
