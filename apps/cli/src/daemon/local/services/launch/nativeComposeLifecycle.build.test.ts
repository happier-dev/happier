import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { nativeBuildFixtureDigest as digest, withNativeComposeBuildFixture as withBuilder,
    withNativeComposeBuildAdmission as admitted } from './nativeComposeBuild.testkit';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';
import { readDeploymentSystemToolFailure } from '@/deployments/deploymentSystemToolFailure';
import { readDeploymentChildResult } from '@/deployments/deploymentChild';
import { projectDeploymentFailure, projectDeploymentReceiptFailure } from '@/deployments/deploymentFailure';

describe('phase-correct native platform image production', () => {
    it.each([
        ['JavaScript heap out of memory', 'deployment_out_of_memory', 'machines'],
        ['no space left on device', 'deployment_disk_full', 'machines'],
        ['ERR_PNPM_OUTDATED_LOCKFILE', 'deployment_lockfile_mismatch', 'source'],
        ['required variable APP_KEY is missing a value', 'deployment_env_var_missing', 'variables'],
        ['container web is unhealthy', 'deployment_health_check_failed', 'logs'],
        ['Bind for 0.0.0.0:3000 failed: port is already allocated', 'deployment_port_in_use', 'source'],
        ['pull access denied for private/image', 'deployment_image_pull_denied', 'connectedAccounts'],
        ['manifest unknown', 'deployment_image_not_found', 'source'],
        ['toomanyrequests: pull rate limit reached', 'deployment_image_rate_limited', 'registryCredentials'],
        ['getaddrinfo EAI_AGAIN registry.example.test', 'deployment_network_unavailable', 'machines'],
        ['Missing script: "build"', 'deployment_build_script_missing', 'source'],
        ['COPY failed: file not found in build context', 'deployment_build_input_missing', 'source'],
        ['npm error code EBADENGINE\nnpm error engine Unsupported engine', 'deployment_build_runtime_incompatible', 'source'],
        ['Your lock file does not contain a compatible set of packages. Please run composer update.', 'deployment_build_dependencies_incompatible', 'source'],
        ['ERROR: No matching distribution found for example-package==1.0.0', 'deployment_build_dependencies_incompatible', 'source'],
        ['E: Unable to locate package happier-sos-1128-nonexistent-package', 'deployment_build_dependencies_incompatible', 'source'],
        ['failed to authorize: failed to fetch oauth token: unexpected status from GET request to https://registry.example.test/token: 401 Unauthorized', 'deployment_image_pull_denied', 'connectedAccounts'],
        ['Error response from daemon: driver failed programming external connectivity: bind: cannot assign requested address', 'deployment_bind_address_unavailable', 'source'],
        ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'deployment_docker_daemon_unavailable', 'machines'],
    ] as const)('retains a safe classified cause through build, command and receipt for %s', async (output, code, destination) => {
        for (const command of ['bake', 'compose'] as const) {
            await withBuilder(async ({ project, requests }) => {
                const error: unknown = await (command === 'bake'
                    ? admitted(project, context => project.prepareImages({ context, platforms: ['linux/amd64'],
                        build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } }))
                    : project.describeBuild()).catch((failure: unknown) => failure);
                const failure = projectDeploymentFailure(command === 'bake' ? 'native_build_failed' : 'native_failed', error);
                expect(failure.failureCause?.errorCode).toBe(code);
                const receipt = projectDeploymentReceiptFailure(failure, command === 'bake' ? 'build' : 'activate');
                expect(receipt.failureCause?.errorCode).toBe(code);
                expect(readDeploymentFailureRecoveryV1(receipt.code, receipt).nextAction.destination).toBe(destination);
                if (command === 'bake') expect(receipt.effectAttempted).toBe(true);
                // One failed build settles; diagnosis never retries it or starts the app.
                expect(requests.filter(request => request.args[0] === 'buildx' && request.args[1] === 'bake'
                    && !request.args.includes('--print'))).toHaveLength(command === 'bake' ? 1 : 0);
                expect(requests.some(request => request.args.includes('up'))).toBe(false);
                expect(JSON.stringify(receipt)).not.toContain('private-output-sentinel');
            }, { failureOutput: { command, stdout: output, stderr: 'https://fixture-user:private-output-sentinel@registry.example.test/check' } });
        }
    });

    it('carries a failed image-only Compose configuration through Action and Receipt', async () => {
        const catalog: { apps: Array<{ itemId: string; app: { compose: { document: string; services: string[] } } }> } =
            JSON.parse(await readFile(new URL('../../../../../../../packages/plugins/deployment-templates/resources/registry/apps.json', import.meta.url), 'utf8'));
        const template = catalog.apps.find(({ itemId }) => itemId === 'postgresql');
        if (!template) throw new Error('PostgreSQL catalog fixture is missing');
        const stderr = [
            'older diagnostic '.repeat(512),
            String.raw`compose could not open C:\Program Files\Docker data\candidate.compose.json`,
            'https://fixture-user:fixture-password@registry.example.test/check',
            'native hint buildkit-only-fixture-secret',
        ].join('\r\n');
        await withBuilder(async ({ project, requests }) => {
            await expect(project.describeBuild()).resolves.toBeDefined();
            const error: unknown = await project.prepareImages({ planOnly: true }).catch(failure => failure);
            const failure = projectDeploymentFailure('native_failed', error);
            const child = readDeploymentChildResult(JSON.parse(JSON.stringify(failure)));
            const details = { nativeCompose: { subcommand: 'config', exitStatus: 23,
                stderrTail: expect.stringContaining('candidate.compose.json') } };
            expect(failure).toMatchObject({ ok: false, errorCode: 'native_failed', details });
            expect(child).toMatchObject({ ok: false, errorCode: 'native_failed', details });
            expect(projectDeploymentReceiptFailure(projectDeploymentFailure('native_failed',
                new Error('refused', { cause: child })), 'build')).toMatchObject({ code: 'native_failed', ...details });
            expect(JSON.stringify(child)).not.toContain('fixture-password');
            expect(JSON.stringify(child)).not.toContain('buildkit-only-fixture-secret');
            expect(JSON.stringify(child)).toContain('older diagnostic '.repeat(512));
            const candidate = requests.filter(({ args }) => args.some(arg => arg.endsWith('candidate.compose.json')));
            expect(candidate).toHaveLength(1);
            const args = candidate[0]!.args;
            const file = args[args.indexOf('--file') + 1]!;
            expect(file).toContain('happier native builder-');
            expect(args.slice(args.indexOf('--file') + 1)).toEqual([file, 'config', '--format', 'json']);
        }, { sourceCompose: template.app.compose, failureOutput: { command: 'candidate-config', exitCode: 23, stderr } });
    });

    it('keeps stderr when the host Docker CLI rejects the input-free Compose version check', async () => {
        const stderr = 'unknown flag: --short\r\nSee https://fixture-user:fixture-password@docker.example.test/help';
        await withBuilder(async ({ project, requests }) => {
            const error: unknown = await project.describeBuild().catch(failure => failure);
            const failure = projectDeploymentFailure('native_failed', error);
            const nativeCompose = { subcommand: 'version', exitStatus: 125,
                stderrTail: expect.stringContaining('unknown flag: --short') };
            expect(failure).toMatchObject({ ok: false, errorCode: 'native_failed', details: { nativeCompose } });
            expect(projectDeploymentReceiptFailure(failure, 'build')).toMatchObject({ nativeCompose });
            expect(JSON.stringify(failure)).not.toContain('fixture-password');
            expect(requests.some(({ args }) => args.includes('config'))).toBe(false);
        }, { failureOutput: { command: 'compose-version', exitCode: 125, stderr } });
    });

    it.each(['bake', 'info'] as const)('names the attempted Docker socket when %s is denied', async command => {
        const endpoint = 'unix:///run/user/1001/docker.sock';
        const native = `permission denied while trying to connect to the Docker daemon socket at ${endpoint}: private-output-sentinel`;
        await withBuilder(async ({ project }) => {
            const error: unknown = await (command === 'bake'
                ? admitted(project, context => project.prepareImages({ context, platforms: ['linux/amd64'],
                    build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } }))
                : project.describeBuild()).catch((failure: unknown) => failure);
            const errorCode = command === 'bake' ? 'native_failed' : 'native_tool_unavailable';
            const failure = projectDeploymentFailure(errorCode, error);
            const child = readDeploymentChildResult(JSON.parse(JSON.stringify(failure)));
            const receipt = projectDeploymentReceiptFailure(projectDeploymentFailure(errorCode, new Error('refused', { cause: child })), 'build');
            expect(receipt).toMatchObject({ code: errorCode, failureCause: {
                errorCode: 'deployment_docker_socket_access_denied', nativeErrorCode: 'EACCES',
            } });
            const recovery = readDeploymentFailureRecoveryV1(receipt.code, receipt);
            expect(recovery.remedy).toContain(endpoint);
            expect(recovery.remedy).toMatch(/grant.*Docker socket access/i);
            expect(recovery.nextAction.destination).toBe('machines');
            expect(JSON.stringify({ child, receipt })).not.toContain('private-output-sentinel');
            if (command === 'bake') expect(receipt.effectAttempted).toBe(true);
        }, { failureOutput: { command, stderr: native } });
    });

    it.each(['process exited with code: 137', 'Killed', 'unrecognized private-output-sentinel'])(
        'keeps ambiguous output generic instead of guessing memory exhaustion (%s)', async stdout => {
        await withBuilder(async ({ project }) => {
            const error: unknown = await admitted(project, context => project.prepareImages({ context,
                platforms: ['linux/amd64'], build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } }))
                .catch((failure: unknown) => failure);
            const failure = projectDeploymentReceiptFailure(projectDeploymentFailure('native_build_failed', error), 'build');
            expect(failure).toMatchObject({ code: 'native_build_failed', effectAttempted: true,
                failureCause: { errorCode: 'native_build_failed' } });
            expect(JSON.stringify(failure)).not.toContain(stdout);
        }, { failureOutput: { command: 'bake', stdout } });
    });

    it.each([
        ['unsupportedPlatform', 'build_platform_unsupported', 'runtime_platform_unsupported'],
        ['execFormat', 'native_build_failed', 'execution_format_error'],
        ['buildFailed', 'native_build_failed', 'build_failed'],
    ] as const)('keeps the observed bake cause and builder remedy (%s)', async (bakeFailure, errorCode, cause) => {
        await withBuilder(async ({ project, requests }) => {
            const error: unknown = await admitted(project, context => project.prepareImages({ context,
                platforms: ['linux/amd64', 'linux/arm64'], build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } }))
                .catch((failure: unknown) => failure);
            expect(error).toMatchObject({ code: errorCode });
            const failure = projectDeploymentFailure(errorCode, error);
            expect(failure).toMatchObject({ ok: false, errorCode, details: { buildSupport: {
                status: 'failed', requestedPlatforms: ['linux/amd64', 'linux/arm64'], builtPlatforms: ['linux/amd64'], cause, exitCode: 1,
            } } });
            const serialized = JSON.stringify(failure);
            const child = readDeploymentChildResult(JSON.parse(serialized));
            expect(JSON.stringify(projectDeploymentFailure(errorCode, new Error(errorCode, { cause: child })))).toBe(serialized);
            expect(projectDeploymentReceiptFailure(failure, 'build')).toMatchObject({ code: errorCode,
                failureCause: { phase: `deployment.native.build.${cause}` }, effectAttempted: true });
            expect(JSON.stringify(failure)).not.toContain('private-registry-sentinel');
            expect(requests.some(request => request.args.includes('up') || request.args.includes('load'))).toBe(false);
        }, { bakeFailure, bakeFailurePlatform: 'linux/arm64' });
    });
    it.each(['image inspection', 'source build'] as const)('retains the missing Buildx remedy for %s without native output', async phase => {
        await withBuilder(async ({ project, requests }) => {
            const failure = await (phase === 'source build' ? project.describeBuild() : project.prepareImages({ planOnly: true }))
                .catch((error: unknown) => error);
            expect(failure).toMatchObject({ code: 'docker_buildx_not_installed' });
            const diagnostic = readDeploymentSystemToolFailure('docker_buildx_not_installed', failure);
            expect(diagnostic).toMatchObject({ ok: false, errorCode: 'docker_buildx_not_installed',
                details: { kind: 'systemToolUnavailable', toolId: 'docker-buildx', remedy: 'install_docker_buildx_plugin_on_machine' } });
            expect(diagnostic?.error).not.toBe('docker_buildx_not_installed');
            const child = readDeploymentChildResult(JSON.parse(JSON.stringify(diagnostic)));
            expect(readDeploymentSystemToolFailure('docker_buildx_not_installed', new Error('refused', { cause: child }))).toEqual(diagnostic);
            expect(JSON.stringify(diagnostic)).not.toContain('private-registry-sentinel');
            expect(JSON.stringify(failure)).not.toContain('private-registry-sentinel');
            expect(requests.filter(request => request.args[0] === 'buildx')).toHaveLength(1);
            expect(requests.some(request => request.args.includes('pull') || request.args.includes('load') || request.args.includes('up'))).toBe(false);
        }, { ...(phase === 'image inspection' ? { prebuiltIndex: true, preapprovalIndex: true } : {}), missingBuildx: true });
    });
    it('builds different apps concurrently on one engine while retaining setup exclusion', async () => {
        await withBuilder(async first => {
            await withBuilder(async second => {
                const [left, right] = await Promise.all([first.project.describeBuild(), second.project.describeBuild()]);
                const engine = left.keys.find(key => 'dockerEndpoint' in key);
                if (!engine || !('dockerEndpoint' in engine)) throw new Error('Build engine was not observed');
                let setupEffects = 0;
                await machineNativeEffectAdmission.run({ operation: { operationId: 'app-A-build', kind: 'build' }, keys: left.keys }, async leftContext => {
                    await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'engine-setup', kind: 'setup' },
                        keys: [{ kind: 'machineSetup' }, { kind: 'dockerEngine', dockerEndpoint: engine.dockerEndpoint }] }, async () => { setupEffects++; }))
                        .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'app-A-build' });
                    await machineNativeEffectAdmission.run({ operation: { operationId: 'app-B-build', kind: 'build' }, keys: right.keys }, async rightContext => {
                        const images = await Promise.all([
                            first.project.prepareImages({ context: leftContext, platforms: ['linux/amd64'],
                                build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } }),
                            second.project.prepareImages({ context: rightContext, platforms: ['linux/amd64'],
                                build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } }),
                        ]);
                        expect(images.map(value => value.images.length)).toEqual([2, 2]);
                    });
                });
                expect(setupEffects).toBe(0);
                for (const fixture of [first, second]) expect(fixture.requests.filter(request => request.args.includes('bake')
                    && !request.args.includes('--print'))).toHaveLength(1);
            }, { environmentInstanceId: 'app-B' });
        }, { environmentInstanceId: 'app-A' });
    });
    it.each([false, true])('builds on C and renders exact images on both runtime installations without combining phases (coincident: %s)', async coincidentRuntime => {
        await withBuilder(async ({ project, source, requests, runtimeMachineIds, readRuntimeProjection }) => {
            expect(source.machineId).toBe('builder-c');
            expect(runtimeMachineIds).toEqual([coincidentRuntime ? 'builder-c' : 'runtime-a', 'runtime-b']);
            const { images } = await admitted(project, context => project.prepareImages({ context, platforms: ['linux/amd64'],
                build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } }));
            for (const machineId of runtimeMachineIds) {
                const runtime = await readRuntimeProjection({ machineId, images });
                expect(runtime.review).toMatchObject({ inspection: 'complete', services: [
                    { name: 'web', ports: [{ target: 3000, published: '3000' }] }, { name: 'worker' }] });
                expect(JSON.stringify(runtime)).not.toContain('buildkit-only-fixture-secret');
            }
            const builds = requests.filter(request => request.args.includes('bake') && !request.args.includes('--print'));
            expect(builds).toHaveLength(1);
            expect(builds[0]!.env.BUILD_PUBLIC).toBe('visible-build-value');
            expect(builds[0]!.env.BUILD_SECRET).toBe('buildkit-only-fixture-secret');
            for (const request of requests) {
                expect(Object.hasOwn(request.env, 'BUILD_SECRET') && Object.hasOwn(request.env, 'RUNTIME_SECRET')).toBe(false);
                expect(request.args.join(' ')).not.toContain('buildkit-only-fixture-secret');
                expect(request.args.join(' ')).not.toContain('runtime-only-fixture-secret');
            }
        }, { coincidentRuntime });
    });
    it('cancels admitted image preparation before reading or building with phase material', async () => {
        await withBuilder(async ({ project, requests }) => {
            await admitted(project, async context => {
                const abort = new AbortController();
                abort.abort();
                const before = requests.length;
                await expect(project.prepareImages({ context, signal: abort.signal, platforms: ['linux/amd64'],
                    build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } }))
                    .rejects.toMatchObject({ details: { reason: 'deployment_source_unavailable' } });
                expect(requests).toHaveLength(before);
            });
        });
    });
    it.each(['linux/amd64', 'linux/arm64'])('uses a redacted indexed source privately for reviewed platform %s', async platform => {
        await withBuilder(async ({ project, requests, withApprovedImages }) => {
            const { images: seed } = await project.prepareImages({ planOnly: true });
            expect(seed.map(image => image.platform)).toEqual(['linux/arm64', 'linux/arm64']);
            for (const image of seed) {
                expect(image.registryReference).toBeUndefined();
                expect(image.indexDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
            }
            const discoveryEnd = requests.length;
            await withApprovedImages(seed, queued => admitted(queued, async context => {
                const { images } = await queued.prepareImages({ context, servicePlatforms: [
                    { service: 'web', platform }, { service: 'worker', platform }],
                    build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } });
                expect(images.map(image => image.platform)).toEqual([platform, platform]);
                for (const image of images) expect(image.registryReference).toBeUndefined();
                expect(JSON.stringify(await queued.exportImages({ images, context }))).not.toContain('buildkit-only-fixture-secret');
            }));
            const queuedRequests = requests.slice(discoveryEnd);
            expect(queuedRequests.some(request => request.args.includes('bake'))).toBe(false);
            expect(queuedRequests.filter(request => request.args[0] === 'image' && request.args[1] === 'pull')).toHaveLength(2);
            for (const request of queuedRequests.filter(request => request.args.includes('imagetools') || request.args.includes('pull'))) {
                expect(request.args.at(-1)).toMatch(/@sha256:[a-f0-9]{64}$/u);
            }
        }, { prebuiltIndex: true, preapprovalIndex: true, prebuiltSecretReference: true });
    });
    it('builds only reviewed service/platform pairs instead of their host cross-product', async () => {
        await withBuilder(async ({ project, requests, readRuntimeProjection }) => {
            const native = await readRuntimeProjection();
            expect(native.servicePlatforms).toEqual([
                { service: 'web', platform: 'linux/arm64' }, { service: 'worker', platform: 'linux/amd64' }]);
            await admitted(project, async context => {
                const selection = { context, platforms: ['linux/amd64', 'linux/arm64'], servicePlatforms: native.servicePlatforms,
                    build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } };
                expect(await project.describeBuild({ servicePlatforms: selection.servicePlatforms })).toMatchObject({
                    services: ['web', 'worker'], buildServices: ['web', 'worker'],
                    buildSecretVariables: [{ service: 'web', names: ['BUILD_SECRET'] }, { service: 'worker', names: [] }],
                });
                const { images } = await project.prepareImages(selection);
                expect(images.map(({ service, platform }) => ({ service, platform }))).toEqual(selection.servicePlatforms);
                expect(await project.exportImages({ images, context })).toHaveLength(2);
                const builds = requests.filter(request => request.args.includes('bake') && !request.args.includes('--print'));
                expect(builds).toHaveLength(2);
                for (const build of builds) expect(build.args.filter(arg => /^[a-z]+-native$/u.test(arg))).toHaveLength(1);
            });
        }, { effectivePlatforms: true });
    });

    it('uses reviewed prebuilt platforms without evaluating runtime-only platform expressions on the builder', async () => {
        await withBuilder(async ({ project }) => {
            await admitted(project, async context => {
                const selection = { context, platforms: ['linux/amd64'], servicePlatforms: [
                    { service: 'web', platform: 'linux/amd64' }, { service: 'worker', platform: 'linux/amd64' }],
                    build: { noCacheServices: [], secretVariableNames: [] } };
                const { images } = await project.prepareImages(selection);
                expect(images.map(({ service, platform }) => ({ service, platform }))).toEqual(selection.servicePlatforms);
            });
        }, { prebuiltContainerd: 'unchanged', effectivePlatforms: true });
    });
    it('exports only requested services and includes native build dependencies in secret cache provenance', async () => {
        await withBuilder(async ({ project, requests }) => {
            const description = await project.describeBuild();
            expect(description.services).toEqual(['web']);
            expect(description.buildServices).toEqual(['web']);
            expect(description.buildSecretVariables).toEqual([
                { service: 'web', names: ['BUILD_SECRET'] }, { service: 'base', names: ['BUILD_SECRET'] }]);
            await admitted(project, async context => {
                const { images } = await project.prepareImages({ context, platforms: ['linux/amd64'],
                    build: { noCacheServices: ['base'], secretVariableNames: ['BUILD_SECRET'] } });
                expect(images.map(image => image.service)).toEqual(['web']);
                expect((await project.exportImages({ images, context })).map(archive => archive.image.service)).toEqual(['web']);
                const builds = requests.filter(request => request.args.includes('bake') && !request.args.includes('--print'));
                expect(builds).toHaveLength(1);
                expect(builds[0]!.args).toContain('base-native.no-cache=true');
                expect(builds[0]!.args.filter(arg => /^[a-z]+-native$/u.test(arg))).toEqual(['web-native']);
                expect(builds[0]!.args.some(arg => arg.startsWith('base-native.output=') || arg.startsWith('unused-native.'))).toBe(false);
            });
        }, { selectedSubset: true });
    });
    it('refuses engine mutations without canonical native-effect admission', async () => {
        await withBuilder(async ({ project, requests }) => {
            await expect(project.prepareImages({ platforms: ['linux/amd64'], build: { noCacheServices: [], secretVariableNames: [] } }))
                .rejects.toMatchObject({ code: 'admission_unavailable' });
            expect(requests.some(request => request.args.includes('bake') && !request.args.includes('--print'))).toBe(false);
        });
    });
    it('builds once per distinct platform and service, preserves native target mapping and exports exact bytes', async () => {
        const stageChunks: string[] = [];
        await withBuilder(async ({ project, requests, expected }) => {
            await admitted(project, async context => {
            const prepared = await project.prepareImages({ context, platforms: ['linux/amd64', 'linux/arm64', 'linux/amd64', 'linux/arm64/v8'],
                build: { noCacheServices: ['web'], secretVariableNames: ['BUILD_SECRET'] } });
            expect(prepared).toHaveProperty('buildSupport', { status: 'built',
                requestedPlatforms: ['linux/amd64', 'linux/arm64'], builtPlatforms: ['linux/amd64', 'linux/arm64'] });
            const images = prepared.images;
            expect(images).toHaveLength(4);
            for (const image of images) expect(image).toEqual({ service: image.service, platform: image.platform,
                ...expected.get(`${image.service}/${image.platform}`) });
            const builds = requests.filter(request => request.args[0] === 'buildx' && request.args[1] === 'bake' && !request.args.includes('--print'));
            expect(builds).toHaveLength(2);
            for (const build of builds) {
                expect(build.args).toEqual(expect.arrayContaining(['web-native', 'worker-native', 'web-native.no-cache=true']));
                expect(build.args).not.toContain('worker-native.no-cache=true');
            }
            const archives = await project.exportImages({ images, context });
            expect(archives).toHaveLength(4);
            for (const archive of archives) {
                const bytes = await readFile(archive.path);
                expect(archive).toMatchObject({ sizeBytes: bytes.byteLength, sha256: digest(bytes).slice(7), image: images.find(image =>
                    image.service === archive.image.service && image.platform === archive.image.platform) });
            }
            expect(requests.some(request => request.args.includes('up') || request.args.includes('load'))).toBe(false);
            expect(stageChunks.join('')).toContain('built image [REDACTED] BUILD_PUBLIC=visible-build-value');
            expect(stageChunks.join('')).not.toContain('buildkit-only-fixture-secret');
            for (const build of builds) expect(build.output?.redaction.isActive()).toBe(false);
            });
        }, { stageOutput: { appendRedacted(_stream, chunk) { stageChunks.push(Buffer.from(chunk).toString('utf8')); }, assertWritten() {} } });
    });

    it('plans source builds without build effects and describes only their admitted build inputs', async () => {
        await withBuilder(async ({ project, requests }) => {
            expect(await project.prepareImages({ planOnly: true })).toEqual({ images: [] });
            expect(requests.some(request => request.args.includes('bake'))).toBe(false);
            const description = await project.describeBuild();
            expect(description).toMatchObject({ services: ['web', 'worker'], buildServices: ['web', 'worker'],
                buildSecretVariables: [{ service: 'web', names: ['BUILD_SECRET'] }, { service: 'worker', names: [] }],
                basis: { toolVersion: '2.39.4', configInputDigests: [{ path: 'compose.yaml', digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) }] } });
            expect(description.basis.manifestFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
            expect(description.basis.physicalProjectName).toBeTruthy();
            expect(requests.some(request => request.args.includes('bake') && !request.args.includes('--print'))).toBe(false);
        });
    });

    it('rejects a secret-dependent public-looking build arg before any build effect', async () => {
        await withBuilder(async ({ project, requests }) => {
            await admitted(project, async context => {
            await expect(project.prepareImages({ context, platforms: ['linux/amd64'], build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } }))
                .rejects.toMatchObject({ code: 'invalid_request', details: { reason: 'secret_build_argument' } });
            expect(requests.some(request => request.args.includes('bake') && !request.args.includes('--print'))).toBe(false);
            });
        }, { secretArgument: true });
    });

    it('describes the actual native-selected BuildKit secret variable when its source name is interpolated', async () => {
        await withBuilder(async ({ project, requests }) => {
            expect((await project.describeBuild()).buildSecretVariables).toEqual([
                { service: 'web', names: ['BUILD_SECRET'] }, { service: 'worker', names: [] }]);
            expect(requests.some(request => request.args.includes('bake') && !request.args.includes('--print'))).toBe(false);
        }, { dynamicSecretName: true });
    });

    it('includes native Bake extension secrets in the per-service cache provenance', async () => {
        await withBuilder(async ({ project }) => {
            expect((await project.describeBuild()).buildSecretVariables).toEqual([
                { service: 'web', names: ['BUILD_SECRET'] }, { service: 'worker', names: ['BUILD_SECRET'] }]);
        }, { extensionSecret: true });
    });

    it('refuses exporter metadata whose CONFIG does not match the actual archive bytes', async () => {
        await withBuilder(async ({ project }) => {
            await admitted(project, async context => {
            await expect(project.prepareImages({ context, platforms: ['linux/amd64'], build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } }))
                .rejects.toMatchObject({ details: { reason: 'deployment_image_identity_mismatch' } });
            });
        }, { corruptArchive: true });
    });

    it('exports approved prebuilt variants without rereading the mutable source tag', async () => {
        const stageChunks: string[] = [];
        await withBuilder(async ({ project, requests, expected }) => {
            await admitted(project, async context => {
            const { images } = await project.prepareImages({ context, platforms: ['linux/amd64'], build: { noCacheServices: [], secretVariableNames: [] } });
            expect(images).toHaveLength(2);
            for (const image of images) expect(image).toEqual({ service: image.service, platform: 'linux/amd64',
                ...expected.get(`${image.service}/linux/amd64`) });
            const archives = await project.exportImages({ images, context });
            expect(archives).toHaveLength(2);
            for (const archive of archives) expect(archive.sha256).toBe(digest(await readFile(archive.path)).slice(7));
            expect(requests.some(request => request.args.includes('bake'))).toBe(false);
            const tags = requests.filter(request => request.args[0] === 'image' && request.args[1] === 'tag');
            expect(tags).toHaveLength(images.length);
            for (const tag of tags) {
                for (const key of ['BUILD_PUBLIC', 'BUILD_SECRET', 'RUNTIME_SECRET']) expect(Object.hasOwn(tag.env, key)).toBe(false);
                expect(tag.output?.redaction.isActive()).toBe(false);
            }
            expect(stageChunks.join('')).toContain('tagged image without application inputs');
            });
        }, { prebuilt: true, stageOutput: {
            appendRedacted(_stream, chunk) { stageChunks.push(Buffer.from(chunk).toString('utf8')); }, assertWritten() {},
        } });
    });

    it('selects a missing prebuilt platform only from its approved immutable index with registry-only credentials', async () => {
        await withBuilder(async ({ project, expected }) => {
            await admitted(project, async context => {
                const { images } = await project.prepareImages({ context, platforms: ['linux/amd64', 'linux/arm64'],
                    build: { noCacheServices: [], secretVariableNames: [] } });
                expect(images).toHaveLength(4);
                for (const image of images) expect(image).toMatchObject({ service: image.service, platform: image.platform,
                    ...expected.get(`${image.service}/${image.platform}`), indexDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) });
                expect(await project.exportImages({ images, context })).toHaveLength(4);
            });
        }, { prebuiltIndex: true });
    });

    it.each(['unchanged', 'movesAfterLookup'] as const)('locates an approved local-only containerd image (%s) without assuming CONFIG is a native alias', async prebuiltContainerd => {
        await withBuilder(async ({ project, requests, expected }) => {
            await admitted(project, async context => {
                const { images } = await project.prepareImages({ context, platforms: ['linux/amd64'],
                    build: { noCacheServices: [], secretVariableNames: [] } });
                for (const image of images) expect(image).toEqual({ service: image.service, platform: image.platform,
                    ...expected.get(`${image.service}/${image.platform}`) });
                expect(await project.exportImages({ images, context })).toHaveLength(2);
                const tags = requests.filter(request => request.args[0] === 'image' && request.args[1] === 'tag');
                expect(tags).toHaveLength(2);
                for (const tag of tags) {
                    expect(tag.args[2]).toMatch(/^sha256:[a-f0-9]{64}$/u);
                    expect(images.some(image => tag.args[2] === image.configDigest || tag.args[2] === image.manifestDigest)).toBe(false);
                }
                expect(requests.some(request => request.args.includes('imagetools') || request.args.includes('pull')
                    || request.args.includes('load') || request.args.includes('bake'))).toBe(false);
            });
        }, { prebuiltContainerd });
    });

    it('refuses changed local source-alias bytes instead of accepting their current image identity', async () => {
        await withBuilder(async ({ project, requests }) => {
            await admitted(project, async context => {
                await expect(project.prepareImages({ context, platforms: ['linux/amd64'],
                    build: { noCacheServices: [], secretVariableNames: [] } }))
                    .rejects.toMatchObject({ code: 'native_failed', details: { reason: 'deployment_image_identity_mismatch' } });
                expect(requests.some(request => ['tag', 'pull', 'load', 'push'].includes(request.args[1]))).toBe(false);
            });
        }, { prebuiltContainerd: 'changed' });
    });

    it.each([false, true])('discovers one actual preapproval index variant without requiring a builder-host variant (ARM-only: %s)', async preapprovalArmOnly => {
        await withBuilder(async ({ project, requests }) => {
            const { images } = await project.prepareImages({ planOnly: true });
            expect(images).toHaveLength(2);
            for (const image of images) {
                expect(image.indexDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
                expect(image.registryReference).toBe(`registry.example.test/${image.service}:mutable@${image.manifestDigest}`);
                expect(image.platform).toBe(preapprovalArmOnly ? 'linux/arm64' : 'linux/amd64');
            }
            expect(requests.some(request => request.args.includes('pull') || request.args.includes('load') || request.args.includes('bake'))).toBe(false);
        }, { prebuiltIndex: true, preapprovalIndex: true, preapprovalArmOnly, effectivePlatforms: preapprovalArmOnly });
    });
});
