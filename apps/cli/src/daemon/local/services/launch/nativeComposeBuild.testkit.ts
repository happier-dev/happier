import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createTar } from 'tar';
import nacl from 'tweetnacl';
import type { DeploymentImageV1, EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk';
import { environmentSecretBindingIdentityV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentSecretVariableBindingV1, createDeploymentVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { prepareEnvironmentSecretBindings } from '@/deployments/secrets/environmentSecretBindingService';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { createDeploymentSourceMaterializationPort } from '@/deployments/targets/ownServer/exactCommitRelease';
import { createOwnServerNativeImageAcquisition } from '@/deployments/targets/ownServer/nativeImageAcquisition';
import { createOwnServerDockerBoundary } from '@/deployments/targets/ownServer/ownServerDeployment.testkit';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGitBackend, createGitScmBackendRuntimeRegistration } from '../../../../../../../packages/plugins/scm-git/src/backend';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import { createNativeComposeLifecycle, type NativeComposeEnvironmentProject, type NativeComposeEnvironmentProjectInput, type NativeComposeProjectRender } from './nativeComposeLifecycle';
import { machineNativeEffectAdmission, type MachineNativeEffectContext } from './machineNativeEffectAdmission';
import { readNativeComposeArchiveTransportIdentity, resolveNativeComposeDeploymentImageReferences } from './nativeComposeImageIdentity';

/** The launch phase the canonical secret-binding owner accepts. */
type LaunchPhase = NonNullable<Parameters<typeof prepareEnvironmentSecretBindingsForLaunch>[0]['phase']>;

export const nativeBuildFixtureDigest = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const buildSecret = 'buildkit-only-fixture-secret';
const runtimeSecret = 'runtime-only-fixture-secret';

export async function withNativeComposeBuildAdmission<T>(project: NativeComposeEnvironmentProject,
    run: (context: MachineNativeEffectContext) => Promise<T>): Promise<T> {
    const description = await project.describeBuild();
    return machineNativeEffectAdmission.run({ operation: { operationId: 'native-build-fixture', kind: 'build' },
        keys: description.keys, settleNative: project.settleNative }, run);
}

/** Only Docker process output is replaced. Source export, sealed grants, phase
 * attachment, canonical Exec, archive parsing and file hashing remain real. */
export async function withNativeComposeBuildFixture(run: (fixture: Readonly<{
    project: NativeComposeEnvironmentProject;
    source: DeploymentSourceMaterializationV1;
    commitSha: string;
    bindings: readonly EnvironmentSecretBindingV1[];
    requests: Parameters<ProjectNativeToolchainIo['run']>[0][];
    expected: ReadonlyMap<string, Readonly<{ configDigest: string; manifestDigest: string }>>;
    runtimeMachineIds: readonly string[];
    readRuntimeProjection(input?: Readonly<{ machineId?: string; images?: readonly DeploymentImageV1[] }>): Promise<NativeComposeProjectRender>;
    withApprovedImages(images: readonly DeploymentImageV1[], visit: (project: NativeComposeEnvironmentProject) => Promise<void>): Promise<void>;
}>) => Promise<void>, options?: Readonly<{ environmentInstanceId?: string; secretArgument?: boolean; corruptArchive?: boolean; dynamicSecretName?: boolean;
    prebuilt?: boolean; prebuiltIndex?: boolean; preapprovalIndex?: boolean; extensionSecret?: boolean; selectedSubset?: boolean;
    missingBuildx?: boolean; subdirectoryCompose?: boolean;
    bakeFailure?: 'unsupportedPlatform' | 'execFormat' | 'buildFailed';
    bakeFailurePlatform?: string;
    failureOutput?: Readonly<{ command: 'bake' | 'compose' | 'imagetools'; stdout?: string; stderr?: string }>;
    prebuiltContainerd?: 'unchanged' | 'changed' | 'movesAfterLookup';
    effectivePlatforms?: boolean;
    preapprovalArmOnly?: boolean;
    prebuiltSecretReference?: boolean;
    coincidentRuntime?: boolean;
    stageOutput?: NativeComposeEnvironmentProjectInput['stageOutput'];
    publication?: 'ok' | 'missingRepository' | 'pushFailure' | 'resourceChanged' | 'tamperedIndex' | 'secretRepository' | 'engineMismatch' }>) {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-builder-'));
    try {
        const repository = join(root, 'repository');
        const executionDirectory = join(root, 'build-execution');
        await mkdir(repository); await mkdir(executionDirectory);
        const prebuilt = options?.prebuilt || options?.prebuiltIndex || options?.prebuiltContainerd;
        const model = (context: string) => ({ services: {
            web: { ...(options?.effectivePlatforms ? { platform: '${RUNTIME_PLATFORM:?required}' } : {}),
                ...(options?.publication && options.publication !== 'missingRepository' ? { image: options.publication === 'secretRepository'
                ? '${BUILD_SECRET}/web:release' : '${PUBLIC_IMAGE_REGISTRY}/web:release' } : {}),
                ...(prebuilt ? { image: options?.prebuiltIndex ? options.prebuiltSecretReference ? 'registry.example.test/${BUILD_SECRET}/web:mutable' : 'registry.example.test/web:mutable' : 'fixture/web:mutable' } : { build: { context, dockerfile: 'Dockerfile', target: 'release', tags: ['fixture/explicit:latest'], args: { PUBLIC: options?.secretArgument
                ? '${BUILD_SECRET:+visible-build-value}' : '${BUILD_PUBLIC:?required}', BUILD_PUBLIC: null }, secrets: ['token'],
                ...(options?.selectedSubset ? { additional_contexts: { base: 'service:base' } } : {}) } }),
                environment: { RUNTIME_SECRET: '${RUNTIME_SECRET:?required}' },
                ports: [{ target: 3000, published: '${RUNTIME_PORT:?required}', protocol: 'tcp' }] },
            worker: { ...(options?.effectivePlatforms ? { platform: 'linux/amd64' } : {}),
                ...(options?.publication && options.publication !== 'missingRepository' ? { image: '${PUBLIC_IMAGE_REGISTRY}/worker:release' } : {}),
                ...(prebuilt ? { image: options?.prebuiltIndex ? options.prebuiltSecretReference ? 'registry.example.test/${BUILD_SECRET}/worker:mutable' : 'registry.example.test/worker:mutable' : 'fixture/worker:mutable' } : { build: { context, args: { PUBLIC: '${BUILD_PUBLIC:?required}', BUILD_PUBLIC: null },
                ...(options?.extensionSecret ? { 'x-bake': { secret: ['id=worker-token,env=BUILD_SECRET'] } } : {}) } }), command: ['runtime', '${RUNTIME_SECRET:?required}'] },
            ...(options?.selectedSubset ? {
                base: { build: { context, secrets: ['token'] } },
                unused: { build: { context, secrets: ['token'] }, environment: { RUNTIME_SECRET: '${RUNTIME_SECRET:?required}' } },
            } : {}),
        }, secrets: { token: { environment: options?.dynamicSecretName ? '${BUILD_SECRET_ENV_NAME:?required}' : 'BUILD_SECRET' }, runtime: { environment: 'RUNTIME_SECRET' } },
        configs: { runtime: { content: '${RUNTIME_SECRET:?required}' } } });
        const composeFile = options?.subdirectoryCompose ? 'nested/compose.yaml' : 'compose.yaml';
        const contextDirectory = options?.subdirectoryCompose ? join(repository, 'nested/backend') : repository;
        await mkdir(contextDirectory, { recursive: true });
        await writeFile(join(repository, composeFile), JSON.stringify(model(options?.subdirectoryCompose ? './backend' : '.')));
        await writeFile(join(contextDirectory, 'Dockerfile'), 'FROM scratch AS release\n');
        await writeFile(join(repository, '.env'), 'UNREVIEWED=${RUNTIME_SECRET:?runtime-only}\n');
        const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
        git('init', '--quiet'); git('config', 'user.name', 'Native Build Fixture'); git('config', 'user.email', 'native-build@example.test');
        git('add', '.'); git('commit', '--quiet', '-m', 'source');
        const commitSha = git('rev-parse', 'HEAD');
        const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git' }, qualifiedId: 'scm-git/git',
            executableDefinition: { repoModes: ['.git'], capabilities: createGitBackend().declaredCapabilities!, commands: [{ installableKey: 'git-cli', command: 'git' }] },
            registration: createGitScmBackendRuntimeRegistration() })]);
        const source = await createDeploymentSourceMaterializationPort({ registry, async admit() {
            return { environmentId: 'environment', environmentInstanceId: options?.environmentInstanceId ?? 'instance', deploymentId: 'deployment', machineId: 'builder-c',
                installationId: 'installation-c', sourcePath: repository, commitSha,
                deploymentRoot: join(root, 'deployments'), artifactDirectory: join(root, 'artifacts'), async assertCurrent() {} };
        } }).materialize({ environmentId: 'environment', deploymentId: 'deployment' });
        await source.commit();
        const signal = new AbortController().signal;
        const requests: Parameters<ProjectNativeToolchainIo['run']>[0][] = [];
        const expected = new Map<string, Readonly<{ configDigest: string; manifestDigest: string }>>();
        const imageData = (service: string, platform: string) => {
            const [os, architecture, variant] = platform.split('/');
            const config = JSON.stringify({ os, architecture, ...(variant ? { variant } : {}),
                config: { Labels: { service } }, rootfs: { type: 'layers', diff_ids: [] }, history: [] });
            const configDigest = nativeBuildFixtureDigest(config);
            const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
                config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: Buffer.byteLength(config) }, layers: [] });
            return { config, configDigest, manifest, manifestDigest: nativeBuildFixtureDigest(manifest) };
        };
        const indexes = new Map(['web', 'worker'].map(service => {
            const raw = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json',
                manifests: (options?.preapprovalArmOnly ? ['linux/arm64'] : options?.prebuiltSecretReference ? ['linux/arm64', 'linux/amd64'] : ['linux/amd64', 'linux/arm64']).map(platform => {
                    const data = imageData(service, platform); const [os, architecture] = platform.split('/');
                    return { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: data.manifestDigest,
                        size: Buffer.byteLength(data.manifest), platform: { os, architecture } };
                }) });
            return [service, { raw, digest: nativeBuildFixtureDigest(raw) }];
        }));
        const archiveAliases = new Map<string, Readonly<{ image: DeploymentImageV1; reference: string }>>();
        const writeArchive = async (service: string, platform: string, path: string, reference: string) => {
            const data = imageData(service, platform);
            expected.set(`${service}/${platform}`, { configDigest: data.configDigest, manifestDigest: data.manifestDigest });
            const configName = `${data.configDigest.slice(7)}.json`;
            await writeFile(join(executionDirectory, configName), options?.corruptArchive ? '{}' : data.config);
            await writeFile(join(executionDirectory, 'manifest.json'), JSON.stringify([{ Config: configName, RepoTags: [reference], Layers: [] }]));
            await createTar({ cwd: executionDirectory, file: path }, [configName, 'manifest.json']);
            archiveAliases.set(path, { image: { service, platform, configDigest: data.configDigest, manifestDigest: data.manifestDigest }, reference });
            return data;
        };
        const approvedImages: DeploymentImageV1[] = prebuilt ? ['web', 'worker'].map(service => {
            const { configDigest, manifestDigest } = imageData(service, 'linux/amd64');
            expected.set(`${service}/linux/amd64`, { configDigest, manifestDigest });
            return { service, platform: 'linux/amd64', configDigest, manifestDigest,
                ...(options?.prebuiltIndex ? { registryReference: `registry.example.test/${service}@${manifestDigest}`,
                    indexDigest: indexes.get(service)!.digest } : {}) };
        }) : [];
        const nativeContainerdId = (image: DeploymentImageV1) => nativeBuildFixtureDigest(`containerd-native/${image.service}/${image.platform}`);
        const aliases = new Map<string, DeploymentImageV1>(approvedImages.flatMap((image): [string, DeploymentImageV1][] => {
            if (options?.prebuiltSecretReference) return [];
            if (!options?.prebuiltContainerd) return [[image.configDigest, image]];
            const actual = options.prebuiltContainerd === 'changed'
                ? { ...image, service: `${image.service}-moved`, ...imageData(`${image.service}-moved`, image.platform) } : image;
            // Containerd uses a manifest/index ID as its native lookup identity;
            // CONFIG is portable content proof, not an assumed Docker alias.
            return [[`fixture/${image.service}:mutable`, actual], [nativeContainerdId(actual), actual]];
        }));
        const published = new Map<string, string>();
        const pushedData = (service: string, platform: string) => {
            const data = imageData(service, platform);
            const manifest = JSON.stringify({ ...JSON.parse(data.manifest), mediaType: 'application/vnd.docker.distribution.manifest.v2+json' });
            return { ...data, manifest, manifestDigest: nativeBuildFixtureDigest(manifest) };
        };
        const seed = new Uint8Array(32).fill(83);
        const runtimeInstallations = [options?.coincidentRuntime
            ? { machineId: source.machineId, installationId: source.installationId, seed }
            : { machineId: 'runtime-a', installationId: 'installation-a', seed: new Uint8Array(32).fill(84) },
            { machineId: 'runtime-b', installationId: 'installation-b', seed: new Uint8Array(32).fill(85) }]
            .map(installation => ({ ...installation, publicKey: nacl.sign.keyPair.fromSeed(installation.seed).publicKey }));
        const bindings: EnvironmentSecretBindingV1[] = [
            createDeploymentVariableBindingV1({ phase: 'build', name: 'BUILD_PUBLIC', source: { kind: 'value', value: 'visible-build-value' } }),
            createDeploymentVariableBindingV1({ phase: 'build', name: 'PUBLIC_IMAGE_REGISTRY', source: { kind: 'value', value: 'registry.example.test' } }),
            createDeploymentVariableBindingV1({ phase: 'build', name: 'BUILD_SECRET_ENV_NAME', source: { kind: 'value', value: 'BUILD_SECRET' } }),
            createDeploymentSecretVariableBindingV1({ phase: 'build', name: 'BUILD_SECRET', resourceId: 'build-secret', resourceRevision: 2 }),
            createDeploymentSecretVariableBindingV1({ phase: 'runtime', name: 'RUNTIME_SECRET', resourceId: 'runtime-secret', resourceRevision: 2 }),
            createDeploymentVariableBindingV1({ phase: 'runtime', name: 'RUNTIME_PLATFORM', source: { kind: 'value', value: 'linux/arm64' } }),
            createDeploymentVariableBindingV1({ phase: 'runtime', name: 'RUNTIME_PORT', source: { kind: 'value', value: '3000' } }),
        ];
        const resource = { resourceId: 'build-secret', ownerAccountId: 'account', displayName: 'Build secret', kind: 'password' as const,
            encryptionMode: 'plain' as const, revision: 2, materialStatus: 'ready' as const, capabilities: { use: true },
            storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'Build secret', kind: 'password' as const, value: buildSecret } } };
        const registryUse: Extract<EnvironmentSecretBindingV1, { purpose: 'registry' }> = { purpose: 'registry', targetLinkId: 'builder-c',
            registryOrigin: 'https://registry.example.test', access: options?.publication ? 'pushPull' : 'pull', source: { kind: 'secret',
                ref: formatSharedSavedSecretRefV1('registry-secret'), resourceRevision: 1 } };
        if (options?.publication === 'engineMismatch') bindings.push(createDeploymentVariableBindingV1({ phase: 'build', name: 'DOCKER_HOST',
            source: { kind: 'value', value: 'tcp://approved-engine:2375' } }));
        const registryResource = { ...resource, resourceId: 'registry-secret', displayName: 'Registry secret', revision: 1,
            storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'Registry secret', kind: 'password' as const,
                value: JSON.stringify({ username: 'native-registry-user', password: 'native-registry-sentinel' }) } } };
        const runtimeResource = { ...resource, resourceId: 'runtime-secret', displayName: 'Runtime secret',
            storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'Runtime secret', kind: 'password' as const, value: runtimeSecret } } };
        const hasRegistry = options?.prebuiltIndex || options?.publication;
        const resources = hasRegistry ? [resource, runtimeResource, registryResource] : [resource, runtimeResource];
        if (hasRegistry) bindings.push(registryUse);
        const prepared = await prepareEnvironmentSecretBindings({ environmentId: source.environmentId, bindings, previousBindings: [],
            runtimeInstallations, buildInstallation: { machineId: source.machineId, installationId: source.installationId,
                publicKey: nacl.sign.keyPair.fromSeed(seed).publicKey }, existingGrants: [],
            operationalDestinations: hasRegistry ? [{ binding: registryUse, installations: [{ machineId: source.machineId,
                installationId: source.installationId, publicKey: nacl.sign.keyPair.fromSeed(seed).publicKey }] }] : [],
            materializer: createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [], resources,
                resourceCatalogState: 'ready', isCurrent: () => true }), assertCurrent: source.assertCurrent });
        const exec = createStablePluginExecService({ signal,
            isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: '/docker' }), resolvePath: async path => String(path),
            systemTools: { async resolve(request) { return { grantId: 'docker-fixture', toolId: request.toolId, displayName: 'Docker fixture', source: 'system', executablePath: '/docker', launch: { kind: 'binary', executablePath: '/docker' } }; } } });
        const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'build', signal,
            isCurrent: () => true, prepare: ({ phase }: Readonly<{ phase: LaunchPhase }>) => prepareEnvironmentSecretBindingsForLaunch({ phase, environmentId: source.environmentId,
                machineId: source.machineId, installationId: source.installationId, installationPrivateSeed: seed,
                registryUses: hasRegistry && !options?.preapprovalIndex ? [registryUse] : [], registryConfigBaseDir: join(root, 'registry-configs'),
                bindings, grants: prepared.grants, assertCurrent: source.assertCurrent }) });
        const registryEnvPort = createDeploymentExecEnvPortForHost({ bindingIdentity: environmentSecretBindingIdentityV1(registryUse), signal,
            isCurrent: () => true, prepare: () => prepareEnvironmentSecretBindingsForLaunch({ use: registryUse, environmentId: source.environmentId,
                machineId: source.machineId, installationId: source.installationId, installationPrivateSeed: seed,
                registryConfigBaseDir: join(root, 'registry-configs'), bindings, grants: prepared.grants,
                 assertCurrent: source.assertCurrent }) });
        const assertRegistryOnly = async (request: Parameters<ProjectNativeToolchainIo['run']>[0]) => {
            assert.equal(Object.hasOwn(request.env, 'BUILD_PUBLIC'), false);
            assert.equal(Object.hasOwn(request.env, 'BUILD_SECRET'), false);
            const config = JSON.parse(await readFile(join(request.env.DOCKER_CONFIG, 'config.json'), 'utf8'));
            assert.deepEqual(config, { auths: { 'registry.example.test': {
                auth: Buffer.from('native-registry-user:native-registry-sentinel').toString('base64') } } });
        };
        const mutableIndexReads = new Set<string>();
        const configurationDocker = await createOwnServerDockerBoundary(join(root, 'configuration-docker'));
        const io: ProjectNativeToolchainIo = { async resolveTool() { return null; }, async run(request) {
            requests.push(request);
            if (options?.missingBuildx && request.args[0] === 'buildx') {
                return { exitCode: 125, stdout: '', stderr: 'unknown flag: --raw\nprivate-registry-sentinel' };
            }
            if (options?.bakeFailure && request.args[0] === 'buildx' && request.args[1] === 'bake' && !request.args.includes('--print')
                && (!options.bakeFailurePlatform || request.args.includes(`*.platform=${options.bakeFailurePlatform}`))) {
                const reason = options.bakeFailure === 'unsupportedPlatform'
                    ? 'no support for running processes with linux/arm64 platform, supported: linux/amd64'
                    : options.bakeFailure === 'execFormat' ? 'exec user process caused: exec format error' : 'process did not complete successfully: exit code: 2';
                return { exitCode: 1, stdout: '', stderr: `${reason}\nprivate-registry-sentinel` };
            }
            if (options?.failureOutput && (options.failureOutput.command === 'bake'
                ? request.args[0] === 'buildx' && request.args[1] === 'bake' && !request.args.includes('--print')
                : options.failureOutput.command === 'compose' && request.args[0] === 'compose' && request.args.includes('config'))) {
                return { exitCode: 1, stdout: options.failureOutput.stdout ?? '', stderr: options.failureOutput.stderr ?? '' };
            }
            // Docker output is this fixture's OS boundary. Exercise the real
            // admitted launch's streaming sanitizer before delivering bytes.
            if (request.output) {
                assert.equal(request.output.redaction.isActive(), true);
                const raw = request.args[0] === 'image' && request.args[1] === 'tag'
                    ? 'tagged image without application inputs\n'
                    : request.args[0] === 'buildx' && request.args[1] === 'bake' && request.args.includes('--metadata-file')
                    ? `built image ${buildSecret} BUILD_PUBLIC=${request.env.BUILD_PUBLIC}\n` : '';
                if (raw) {
                    const sanitizer = request.output.redaction.createStreamingSanitizer();
                    const bytes = Buffer.from(raw);
                    const split = Math.floor(bytes.byteLength / 2);
                    for (const chunk of [sanitizer.push(bytes.subarray(0, split)), sanitizer.push(bytes.subarray(split)), sanitizer.flush()]) {
                        if (chunk) request.output.onChunk('stdout', Buffer.from(chunk));
                    }
                }
            }
            const runtimePhase = request.cwd === source.rootPath;
            const sourceNormalization = request.args.includes('--no-interpolate');
            assert.equal(request.cwd, runtimePhase ? source.rootPath : executionDirectory);
            // Runtime values stay in the carrier; the key inventory may carry
            // its constant non-secret lookup, never the actual credential.
            assert.notEqual(request.env.RUNTIME_SECRET, runtimeSecret);
            if (runtimePhase) {
                assert.equal(Object.hasOwn(request.env, 'BUILD_SECRET'), false);
                assert.equal(Object.hasOwn(request.env, 'BUILD_PUBLIC'), false);
            }
            assert.equal(Object.hasOwn(request.env, 'UNREVIEWED'), false);
            if (request.args[0] === 'info') return { exitCode: 0, stdout: JSON.stringify({ ID: options?.publication === 'engineMismatch'
                ? request.env.DOCKER_HOST === 'tcp://approved-engine:2375' ? 'approved-engine' : 'different-engine'
                : 'native-build-fixture-engine' }) };
            if (request.args.includes('version')) return { exitCode: 0, stdout: request.args.includes('compose') ? '2.39.4' : 'linux/amd64' };
            if (request.args.includes('config')) {
                if (sourceNormalization) {
                    assert.equal(Object.hasOwn(request.env, 'BUILD_SECRET'), false);
                    assert.equal(Object.hasOwn(request.env, 'BUILD_PUBLIC'), false);
                    assert.equal(request.args.includes('--no-path-resolution'), false);
                }
                // Reuse the canonical Docker boundary's native include/env-file,
                // stdin, variable discovery and dollar-reload semantics.
                const stdout = execFileSync(process.execPath, [configurationDocker.executablePath, ...request.args], {
                    cwd: request.cwd, env: request.env, encoding: 'utf8',
                    ...(request.stdin ? { input: Buffer.from(request.stdin) } : {}),
                });
                return { exitCode: 0, stdout };
            }
            if (request.args[0] === 'image') {
                if (request.args[1] === 'load') {
                    const path = request.args[request.args.indexOf('--input') + 1];
                    const data = await readFile(path);
                    assert.ok(data.byteLength);
                    const archive = archiveAliases.get(path); assert.ok(archive);
                    // Containerd's native lookup identity need not be CONFIG;
                    // the archive restores its RepoTag and the engine's actual
                    // native Id; CONFIG is not a portable native lookup alias.
                    aliases.set(archive.reference, archive.image);
                    aliases.set(options?.publication || options?.prebuiltContainerd
                        ? nativeContainerdId(archive.image) : archive.image.configDigest, archive.image);
                    return { exitCode: 0, stdout: '' };
                }
                if (request.args[1] === 'push') {
                    await assertRegistryOnly(request);
                    if (options?.publication === 'pushFailure') return { exitCode: 1, stdout: '' };
                    const reference = request.args.at(-1)!;
                    const image = aliases.get(reference); assert.ok(image);
                    const data = pushedData(image.service, image.platform);
                    published.set(reference, data.manifest);
                    published.set(`registry.example.test/${image.service}@${data.manifestDigest}`, data.manifest);
                    if (options?.publication === 'resourceChanged') registryResource.revision += 1;
                    return { exitCode: 0, stdout: '' };
                }
                if (request.args[1] === 'pull') {
                    await assertRegistryOnly(request);
                    const reference = request.args.at(-1)!;
                    const platform = request.args[request.args.indexOf('--platform') + 1];
                    const service = reference.split('/').at(-1)!.split(/[:@]/u)[0];
                    const data = imageData(service, platform);
                    const repository = options?.prebuiltSecretReference ? `registry.example.test/${buildSecret}/${service}:mutable`
                        : `registry.example.test/${service}`;
                    assert.equal(reference, `${repository}@${data.manifestDigest}`);
                    const image = { service, platform, configDigest: data.configDigest, manifestDigest: data.manifestDigest,
                        registryReference: reference, indexDigest: indexes.get(service)!.digest };
                    aliases.set(reference, image); aliases.set(image.configDigest, image);
                    return { exitCode: 0, stdout: '' };
                }
                if (request.args[1] === 'tag') {
                    const image = aliases.get(request.args[2]); assert.ok(image);
                    if (options?.publication) assert.notEqual(request.args[2], image.configDigest);
                    aliases.set(request.args[3], image);
                    return { exitCode: 0, stdout: '' };
                }
                const reference = request.args.at(-1)!;
                if (options?.preapprovalIndex && !reference.includes('@') && reference.includes(':mutable') && request.args[1] === 'inspect') {
                    return { exitCode: 1, stdout: '[]' };
                }
                if (!options?.prebuiltContainerd) assert.equal(!reference.includes('@') && reference.includes(':mutable'), false,
                    'Admitted build must not re-resolve mutable source tags');
                const image = aliases.get(reference);
                if (!image) return { exitCode: 1, stdout: '[]' };
                if (request.args[1] === 'inspect') {
                    if (options?.prebuiltContainerd === 'movesAfterLookup' && reference.includes(':mutable')) {
                        aliases.set(reference, { ...image, service: `${image.service}-moved`, ...imageData(`${image.service}-moved`, image.platform) });
                    }
                    return { exitCode: 0, stdout: JSON.stringify([{
                        Id: options?.prebuiltContainerd || options?.publication ? nativeContainerdId(image) : image.configDigest }]) };
                }
                if (request.args[1] === 'save') {
                    await writeArchive(image.service, image.platform, request.args[request.args.indexOf('--output') + 1], reference);
                    return { exitCode: 0, stdout: '' };
                }
                throw new Error('Unexpected image operation');
            }
            if (request.args[0] === 'buildx' && request.args[1] === 'imagetools') {
                await assertRegistryOnly(request);
                if (options?.failureOutput?.command === 'imagetools' && request.args[2] === 'inspect') {
                    return { exitCode: 1, stdout: options.failureOutput.stdout ?? '', stderr: options.failureOutput.stderr ?? '' };
                }
                if (options?.publication && request.args[2] === 'create') {
                    const reference = request.args[request.args.indexOf('--tag') + 1];
                    const repository = reference.slice(0, reference.lastIndexOf(':'));
                    const sources = request.args.filter(arg => arg.startsWith(`${repository}@`));
                    const manifests = sources.map(ref => {
                        const raw = published.get(ref); assert.ok(raw);
                        const platform = ['linux/amd64', 'linux/arm64'].find(platform => ref.endsWith(`@${pushedData(repository.split('/').at(-1)!, platform).manifestDigest}`));
                        assert.ok(platform); const [os, architecture] = platform.split('/');
                        return { digest: nativeBuildFixtureDigest(raw), size: Buffer.byteLength(raw),
                            mediaType: 'application/vnd.docker.distribution.manifest.v2+json', platform: { os, architecture } };
                    });
                    const raw = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests });
                    const digest = nativeBuildFixtureDigest(raw);
                    published.set(`${repository}@${digest}`, options.publication === 'tamperedIndex' ? `${raw} ` : raw);
                    await writeFile(request.args[request.args.indexOf('--metadata-file') + 1], JSON.stringify({ 'containerimage.descriptor': {
                        digest, size: Buffer.byteLength(raw), mediaType: 'application/vnd.oci.image.index.v1+json' } }));
                    return { exitCode: 0, stdout: '' };
                }
                const reference = request.args.at(-1)!;
                if (options?.publication) {
                    const raw = published.get(reference); assert.ok(raw);
                    if (request.args.includes('--raw')) return { exitCode: 0, stdout: raw };
                    const manifest = JSON.parse(raw);
                    const platform = ['linux/amd64', 'linux/arm64'].find(platform => ['web', 'worker'].some(service => imageData(service, platform).configDigest === manifest.config.digest));
                    assert.ok(platform); return { exitCode: 0, stdout: JSON.stringify({ os: platform.split('/')[0], architecture: platform.split('/')[1] }) };
                }
                const service = reference.split('/').at(-1)!.split(/[:@]/u)[0];
                if (!reference.includes('@') && reference.includes(':mutable')) {
                    assert.equal(options?.preapprovalIndex, true);
                    assert.equal(request.args.includes('--raw'), true);
                    assert.equal(mutableIndexReads.has(service), false);
                    mutableIndexReads.add(service);
                }
                const index = indexes.get(service)!;
                if (!reference.includes('@') && reference.includes(':mutable') || reference.endsWith(`@${index.digest}`)) return { exitCode: 0, stdout: index.raw };
                const platform = ['linux/amd64', 'linux/arm64'].find(platform => reference.endsWith(`@${imageData(service, platform).manifestDigest}`));
                assert.ok(platform);
                const data = imageData(service, platform);
                return { exitCode: 0, stdout: request.args.includes('--raw') ? data.manifest : data.config };
            }
            if (request.args[0] !== 'buildx' || request.args[1] !== 'bake') throw new Error(`Unexpected Docker boundary: ${request.args.join(' ')}`);
            const projection = JSON.parse(await readFile(request.args[request.args.indexOf('--file') + 1], 'utf8'));
            assert.equal(JSON.stringify(projection).includes('RUNTIME_'), false);
            assert.equal(JSON.stringify(projection).includes(buildSecret), false);
            assert.equal(request.env.BUILD_PUBLIC, 'visible-build-value');
            assert.equal(request.env.BUILD_SECRET, buildSecret);
            const implicitPublicArguments = Object.fromEntries(['web', 'worker'].map(service => {
                const value = projection.services[service].build.args.BUILD_PUBLIC;
                // The native build must receive the declared argument, whether
                // it is still bare or already represented as a public value.
                const resolved = value === null ? request.env.BUILD_PUBLIC : typeof value === 'string'
                    ? value.replace('${BUILD_PUBLIC:?required}', request.env.BUILD_PUBLIC) : value;
                assert.equal(resolved, 'visible-build-value');
                return [service, resolved];
            }));
            const requested = request.args.filter(arg => /^[a-z]+-native$/u.test(arg)).map(arg => arg.slice(0, -7));
            const services = requested.length ? [...new Set(requested.flatMap(service => service === 'web' && options?.selectedSubset
                ? ['web', 'base'] : [service]))] : Object.keys(projection.services);
            if (request.args.includes('--print')) return { exitCode: 0, stdout: JSON.stringify({ target: Object.fromEntries(services.map(service =>
                [`${service}-native`, { context: projection.services[service].build.context,
                    dockerfile: join(projection.services[service].build.context, projection.services[service].build.dockerfile ?? 'Dockerfile'),
                    tags: projection.services[service].build.tags?.length ? projection.services[service].build.tags : [projection.services[service].image],
                    ...(service === 'web' && options?.selectedSubset ? { contexts: { base: 'target:base-native' } } : {}),
                    ...(service === 'base' && requested.length ? { output: [{ type: 'cacheonly' }] } : {}),
                    secret: service === 'web' || service === 'base' || service === 'unused' ? [{ id: 'token', env: 'BUILD_SECRET' }]
                        : options?.extensionSecret ? [{ id: 'worker-token', env: 'BUILD_SECRET' }] : [],
                    args: { PUBLIC: 'visible-build-value', ...(implicitPublicArguments[service] !== undefined
                        ? { BUILD_PUBLIC: implicitPublicArguments[service] } : {}) } }])) }) };
            const settings = request.args.flatMap((arg, index) => arg === '--set' ? [request.args[index + 1]] : []);
            const platform = settings.find(setting => setting.startsWith('*.platform='))!.split('=')[1];
            const metadata: Record<string, unknown> = {};
            for (const service of requested) {
                const target = `${service}-native`;
                assert.ok(request.args.includes(target));
                assert.equal(projection.services[service].build.args.PUBLIC, '${BUILD_PUBLIC:?required}');
                const path = settings.find(setting => setting.startsWith(`${target}.output=`))!.split('dest=')[1];
                assert.ok(settings.includes(`${target}.tags=${projection.services[service].image}`));
                const { configDigest, manifestDigest } = await writeArchive(service, platform, path, projection.services[service].image);
                metadata[target] = { 'containerimage.config.digest': configDigest, 'containerimage.digest': manifestDigest,
                    'containerimage.descriptor': { digest: manifestDigest, mediaType: 'application/vnd.oci.image.manifest.v1+json' } };
            }
            await writeFile(request.args[request.args.indexOf('--metadata-file') + 1], JSON.stringify(metadata));
            return { exitCode: 0, stdout: '' };
        } };
        const createProject = (images: readonly DeploymentImageV1[]) => createNativeComposeLifecycle({ kind: 'environmentProject', phase: 'build', executionDirectory, exec, envPort, source,
            files: [composeFile], services: options?.selectedSubset ? ['web'] : ['web', 'worker'], images,
            ...(options?.publication ? { imageAcquisition: createOwnServerNativeImageAcquisition({ source,
                runtime: { exec, buildExecutionDirectory: executionDirectory, secrets: { installationPrivateSeed: seed,
                    grants: prepared.grants, registryConfigBaseDir: join(root, 'registry-configs') } },
                environment: { name: 'Native builder', retainPreviousDeployments: 3,
                    definition: { kind: 'repository', ref: 'fixture-source', compose: { path: composeFile, profiles: [], services: ['web', 'worker'] } }, bindings },
                targetLinkId: registryUse.targetLinkId, operation: 'deploy', signal, assertCurrent: source.assertCurrent,
            }) } : hasRegistry ? { imageAcquisition: { operation: 'deploy' as const, registries: [{ access: registryUse.access,
                origin: registryUse.registryOrigin, bindingIdentity: environmentSecretBindingIdentityV1(registryUse), envPort: registryEnvPort,
                }] } } : {}),
            io, ...(options?.stageOutput ? { stageOutput: options.stageOutput } : {}), async settleNative() {} });
        const project = createProject(approvedImages);
        const withApprovedImages = async (images: readonly DeploymentImageV1[], visit: (project: NativeComposeEnvironmentProject) => Promise<void>) => {
            const queued = createProject(images);
            try { await visit(queued); } finally { await queued.dispose(); }
        };
        const readRuntimeProjection = async (selection?: Readonly<{ machineId?: string; images?: readonly DeploymentImageV1[] }>) => {
            const installation = runtimeInstallations.find(value => value.machineId === (selection?.machineId ?? runtimeInstallations[0]!.machineId));
            assert.ok(installation, 'Runtime must use a prepared installation');
            const runtimeSource = { ...source, machineId: installation.machineId, installationId: installation.installationId };
            const runtimeEnvPort = createDeploymentExecEnvPortForHost({ source: runtimeSource, phase: 'runtime', signal,
                isCurrent: () => true, prepare: ({ phase }: Readonly<{ phase: LaunchPhase }>) => prepareEnvironmentSecretBindingsForLaunch({ phase, environmentId: source.environmentId,
                    machineId: installation.machineId, installationId: installation.installationId, installationPrivateSeed: installation.seed,
                    bindings, grants: prepared.grants, assertCurrent: source.assertCurrent }) });
            const archives = await Promise.all((selection?.images ?? []).map(async image => {
                const archive = [...archiveAliases].find(([, value]) => value.image.service === image.service
                    && value.image.platform === image.platform && value.image.configDigest === image.configDigest
                    && value.image.manifestDigest === image.manifestDigest);
                assert.ok(archive, 'Runtime image must come from the actual build output');
                const path = archive[0];
                const transport = await readNativeComposeArchiveTransportIdentity(path);
                // Filesystem transfer is the boundary substitute. Native archive
                // verification, import, pin selection and tags stay real.
                return { image, ...transport, async acquire() { return { path, ...transport }; } };
            }));
            const runtime = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort: runtimeEnvPort, source: runtimeSource,
                files: [composeFile], services: options?.selectedSubset ? ['web'] : ['web', 'worker'], images: selection?.images ?? [],
                ...(archives.length ? { imageAcquisition: { operation: 'deploy', archives } } : {}), io, async settleNative() {} });
            try {
                const render = await runtime.render();
                if (selection?.images) {
                    // Image pins are assigned after runtime expression resolution.
                    // Observe the real image-preparation effect, not a retired
                    // config carrier or the intentionally image-free config read.
                    const before = requests.length;
                    await machineNativeEffectAdmission.run({ operation: { operationId: `runtime-images-${installation.machineId}`, kind: 'deploy' },
                        keys: render.keys, settleNative: runtime.settleNative }, context => runtime.prepareRuntimeImages({ render, context }));
                    const tags = requests.slice(before).filter(request => request.args[0] === 'image' && request.args[1] === 'tag');
                    for (const service of render.services) {
                        const platform = render.servicePlatforms.find(value => value.service === service)?.platform;
                        const image = selection.images.find(value => value.service === service && value.platform === platform);
                        assert.ok(image);
                        const reference = resolveNativeComposeDeploymentImageReferences({ environmentInstanceId: runtimeSource.environmentInstanceId,
                            deploymentId: runtimeSource.deploymentId, image }).activationRef;
                        assert.ok(tags.some(request => request.args[3] === reference));
                    }
                }
                return render;
            } finally { await runtime.dispose(); }
        };
        try { await run({ project, source, commitSha, bindings, requests, expected,
            runtimeMachineIds: runtimeInstallations.map(value => value.machineId), readRuntimeProjection, withApprovedImages }); }
        finally { await project.dispose(); await source.abort(); }
    } finally { await rm(root, { recursive: true, force: true }); }
}
