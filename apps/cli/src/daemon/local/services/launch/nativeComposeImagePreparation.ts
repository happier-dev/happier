import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentImageV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk/services';
import { isDeploymentSourceUnchangedManifestInput } from '@/deployments/targets/ownServer/exactCommitRelease';
import { createNativeComposeImageIdentity, resolveNativeComposeDeploymentOwnedImageTag, normalizeNativeComposePlatform,
    type NativeComposeImageArchive, type NativeComposeImageAcquisition, type NativeComposeRegistryAcquisition,
    type NativeComposeEffectAuthority } from './nativeComposeImageIdentity';
import { publishNativeComposeImages } from './nativeComposeImagePublication';

export type NativeComposeBuildSelection = Readonly<{
    signal?: AbortSignal;
    /** Reviewed effective pairs; only absent facts use the legacy host matrix. */
    servicePlatforms?: readonly Readonly<{ service: string; platform: string }>[];
}>;

export type NativeComposePrepareImagesOptions = NativeComposeBuildSelection & Readonly<{
    platforms?: readonly string[];
    /** Preapproval discovers prebuilt images and declares source builds without executing them. */
    planOnly?: boolean;
    build?: Readonly<{ noCacheServices: readonly string[]; secretVariableNames: readonly string[] }>;
    /** Only the native lifecycle supplies this from its admitted engine keys. */
    authority?: NativeComposeEffectAuthority;
}>;

export type NativeComposeBuildDescription = Readonly<{
    services: readonly string[];
    buildServices: readonly string[];
    /** Variable names only. The receipt owner resolves current secret refs/revisions. */
    buildSecretVariables: readonly Readonly<{ service: string; names: readonly string[] }>[];
    basis: Readonly<{ manifestFingerprint: string; configInputDigests: readonly Readonly<{ path: string; digest: string }>[];
        toolVersion: string; physicalProjectName: string }>;
}>;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refuse(reason: string): never {
    throw new PluginError({ code: 'native_failed', message: 'Native Compose image preparation could not be completed', details: { reason } });
}

function secretArgument(): never {
    throw new PluginError({ code: 'invalid_request', message: 'Build arguments must use non-secret values; use a BuildKit secret instead',
        details: { reason: 'secret_build_argument' } });
}

/** Inspect references, not values: a conditional/empty secret remains a secret input.
 * Escaped $$ is a literal dollar under the Compose interpolation contract. */
function referencesSecret(value: unknown, names: ReadonlySet<string>): boolean {
    if (typeof value !== 'string') return false;
    for (const token of value.matchAll(/\$\$|\$(?:\{)?([_a-zA-Z][_a-zA-Z0-9]*)/gu)) {
        if (token[1] && names.has(token[1])) return true;
    }
    return false;
}

function selectedServices(model: Record<string, unknown>, names?: readonly string[]) {
    if (!record(model.services) || !Object.keys(model.services).length) return refuse('native_target_missing');
    const definitions = model.services;
    if (names?.some(name => !record(definitions[name]))) return refuse('native_target_missing');
    return Object.entries(definitions).filter(([service]) => !names?.length || names.includes(service)).map(([service, definition]) => {
        if (!record(definition)) return refuse('native_compose_configuration_invalid');
        return { service, definition };
    });
}

function buildSecretVariables(targets: readonly Readonly<{ service: string; definition: Record<string, unknown> }>[]) {
    return targets.map(({ service, definition }) => {
        const names = new Set<string>();
        if (definition.secret !== undefined && !Array.isArray(definition.secret)) return refuse('native_compose_configuration_invalid');
        for (const secret of Array.isArray(definition.secret) ? definition.secret : []) {
            if (!record(secret) || typeof secret.id !== 'string') return refuse('native_compose_configuration_invalid');
            if (typeof secret.env === 'string' && secret.env.length) names.add(secret.env);
            // BuildKit's implicit source uses the ID when that environment
            // variable is present. Receipt projection intersects current build
            // bindings, so file-only IDs do not create secret references.
            else if (!secret.src) names.add(secret.id);
        }
        return { service, names: [...names].sort() };
    });
}

function exporter(path: string): string {
    const field = `dest=${path}`;
    return `type=docker,${/[,"\r\n]/u.test(field) ? `"${field.replaceAll('"', '""')}"` : field}`;
}

/** The existing native Compose normalizer supplies one model. Bake evaluates only
 * its build projection; it owns Compose build options, target names and links. */
export function createNativeComposeImagePreparation(input: Readonly<{
    source: DeploymentSourceMaterializationV1;
    images: readonly DeploymentImageV1[];
    imageAcquisition?: NativeComposeImageAcquisition;
    phase: 'build' | 'runtime';
    executionDirectory?: string;
    services: readonly string[];
    projectName: string;
    composeArgs: readonly string[];
    normalize(signal?: AbortSignal): Promise<Readonly<{ model: Record<string, unknown>;
        configInputDigests: readonly Readonly<{ path: string; digest: string }>[]; toolVersion: string }>>;
    parseComposeModel(stdout: string): Record<string, unknown>;
    directory(): Promise<string>;
    assertCurrent(signal?: AbortSignal): Promise<void>;
    run(args: readonly string[], signal?: AbortSignal, checkExit?: boolean,
        registry?: NativeComposeRegistryAcquisition | null, authority?: NativeComposeEffectAuthority): Promise<Readonly<{ stdout: string; exitCode: number }>>;
    withOutput<T>(args: readonly string[], signal: AbortSignal | undefined,
        visit: (stdout: string, redact: (value: string) => string) => Promise<T>,
        runtimeModel?: Readonly<{ services: Readonly<Record<string, unknown>> }>): Promise<T>;
}>) {
    const identity = createNativeComposeImageIdentity({ directory: input.directory,
        run: (args, signal, registry, authority) => input.run(args, signal, args[1] !== 'inspect', registry, authority) });
    const imageKey = (image: DeploymentImageV1) => JSON.stringify([image.service, image.platform, image.configDigest, image.manifestDigest]);
    const prepared = new Set<string>();
    const acquiredReferences = new Map<string, string>();
    const ownedTag = (service: string, platform: string) => resolveNativeComposeDeploymentOwnedImageTag({
        environmentInstanceId: input.source.environmentInstanceId, deploymentId: input.source.deploymentId, service, platform });
    const buildProjection = (model: Record<string, unknown>, services: ReturnType<typeof selectedServices>, platform?: string) => {
        const sources = new Set(services.flatMap(({ definition }) => record(definition.build) && Array.isArray(definition.build.secrets)
            ? definition.build.secrets.flatMap(secret => typeof secret === 'string' ? [secret]
                : record(secret) && typeof secret.source === 'string' ? [secret.source] : []) : []));
        return { name: input.projectName, services: Object.fromEntries(services.map(({ service, definition }) => [service, {
            build: platform && record(definition.build) ? { ...definition.build,
                tags: [...(Array.isArray(definition.build.tags) ? definition.build.tags : []), ownedTag(service, platform)] } : definition.build,
            ...(platform ? { image: ownedTag(service, platform) } : {}),
        }])), ...(record(model.secrets) ? { secrets: Object.fromEntries(Object.entries(model.secrets).filter(([name]) => sources.has(name))) } : {}) };
    };
    const readTargets = (stdout: string, services: ReturnType<typeof selectedServices>, platform: string, onlyPresent = false) => {
        const evaluated: unknown = JSON.parse(stdout);
        if (!record(evaluated) || !record(evaluated.target)) return refuse('native_compose_configuration_invalid');
        const targets = Object.entries(evaluated.target);
        const captured = services.flatMap(({ service }) => {
            const matching = targets.filter(([, target]) => record(target) && Array.isArray(target.tags) && target.tags.includes(ownedTag(service, platform)));
            if (onlyPresent && !matching.length) return [];
            if (matching.length !== 1 || !record(matching[0][1])) return refuse('native_compose_configuration_invalid');
            const [target, definition] = matching[0] as [string, Record<string, unknown>];
            return [{ service, target, definition }];
        });
        if (onlyPresent && (captured.length !== targets.length || new Set(captured.map(item => item.target)).size !== targets.length)) {
            return refuse('native_compose_configuration_invalid');
        }
        return captured;
    };
    const readBuildGraph = async (prefix: readonly string[], allBuilds: ReturnType<typeof selectedServices>,
        selectedBuilds: ReturnType<typeof selectedServices>, platform: string, signal?: AbortSignal) => {
        // Compose/Bake owns target naming. The first print correlates source
        // services with invocation-owned tags; the selected print then owns the
        // actual dependency graph, including native cache-only linked targets.
        const selected = await input.withOutput([...prefix, '--print'], signal,
            async stdout => readTargets(stdout, selectedBuilds, platform));
        const built = await input.withOutput([...prefix, '--print', ...selected.map(item => item.target)], signal,
            async (stdout, redact) => {
                const graph = readTargets(stdout, allBuilds, platform, true);
                if (selected.some(item => !graph.some(target => target.service === item.service && target.target === item.target))) {
                    return refuse('native_compose_configuration_invalid');
                }
                for (const { definition } of graph) if (record(definition.args)
                    && Object.values(definition.args).some(value => typeof value === 'string' && redact(value) !== value)) secretArgument();
                if (buildSecretVariables(graph).some(use => use.names.some(name => redact(name) !== name))) {
                    return refuse('deployment_build_secret_source_unavailable');
                }
                return graph;
            });
        return { selected, built };
    };
    const selectedPlatforms = async (platforms: readonly string[] | undefined, signal?: AbortSignal) => {
        const selected = [...new Set((platforms ?? [(await input.run(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], signal)).stdout.trim()])
            .map(normalizeNativeComposePlatform))];
        if (!selected.length || selected.some(platform => !/^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-zA-Z0-9_.-]+)?$/u.test(platform))) {
            return refuse('deployment_platform_unavailable');
        }
        return selected;
    };
    const outputServices = (model: Record<string, unknown>, servicePlatforms: NativeComposeBuildSelection['servicePlatforms']) => {
        if (servicePlatforms && !servicePlatforms.length) return refuse('deployment_platform_unavailable');
        return selectedServices(model, servicePlatforms ? [...new Set(servicePlatforms.map(item => item.service))] : input.services);
    };
    const needsPlatform = (service: string, platform: string, servicePlatforms: NativeComposeBuildSelection['servicePlatforms']) =>
        !servicePlatforms || servicePlatforms.some(item => item.service === service && normalizeNativeComposePlatform(item.platform) === platform);
    const validateLocalInputs = async (targets: readonly Record<string, unknown>[], verified: Set<string>) => {
        const root = await realpath(input.source.rootPath);
        const remote = (path: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(path) || /^(?:git@|target:|service:)/u.test(path);
        const local = async (path: string, base: string) => {
            const actual = await realpath(resolve(base, path));
            const child = relative(root, actual);
            if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) return refuse('deployment_source_unavailable');
            return actual;
        };
        const contexts = new Set<string>();
        const dockerfiles = new Set<string>();
        for (const target of targets) {
            const context = typeof target.context === 'string' ? target.context : '.';
            if (!remote(context)) {
                const path = await local(context, root);
                contexts.add(path);
                if (typeof target['dockerfile-inline'] !== 'string') dockerfiles.add(await local(
                    typeof target.dockerfile === 'string' ? target.dockerfile : 'Dockerfile', path));
            }
            if (record(target.contexts)) for (const value of Object.values(target.contexts)) {
                if (typeof value === 'string' && !remote(value)) contexts.add(await local(value, root));
            }
        }
        // Verify one covering source subtree rather than hashing it again for
        // every service/platform. Selected Dockerfiles also get their exact entry proof.
        for (const path of contexts) {
            if ([...contexts].some(parent => parent !== path && relative(parent, path) && !relative(parent, path).startsWith(`..${sep}`)
                && relative(parent, path) !== '..' && !isAbsolute(relative(parent, path)))) continue;
            if (!verified.has(path)) {
                if (!await isDeploymentSourceUnchangedManifestInput(input.source, path)) return refuse('deployment_source_unavailable');
                verified.add(path);
            }
        }
        for (const path of dockerfiles) if (!verified.has(path)) {
            if (!await isDeploymentSourceUnchangedManifestInput(input.source, path)) return refuse('deployment_source_unavailable');
            verified.add(path);
        }
    };
    const withPrebuiltModel = async <T>(services: ReturnType<typeof selectedServices>, signal: AbortSignal | undefined,
        visit: (definitions: Record<string, unknown>, redact: (value: string) => string) => Promise<T>) => {
        const file = join(await input.directory(), 'candidate.compose.json');
        const model = { name: input.projectName, services: Object.fromEntries(services.map(({ service, definition }) =>
            [service, { image: definition.image }])) };
        await writeFile(file, JSON.stringify(model), { mode: 0o600 });
        return input.withOutput([...input.composeArgs, '--file', file, 'config', '--format', 'json'], signal, async (stdout, redact) => {
            const evaluated = input.parseComposeModel(stdout);
            if (!record(evaluated.services)) return refuse('native_compose_configuration_invalid');
            return visit(evaluated.services, redact);
        }, input.phase === 'runtime' ? model : undefined);
    };
    return {
        async describeBuild(options?: NativeComposeBuildSelection): Promise<NativeComposeBuildDescription> {
            if (input.phase !== 'build') return refuse('deployment_build_phase_required');
            const { model, configInputDigests, toolVersion } = await input.normalize(options?.signal);
            const services = outputServices(model, options?.servicePlatforms);
            const builds = services.filter(({ definition }) => definition.build !== undefined);
            const allBuilds = selectedServices(model).filter(({ definition }) => definition.build !== undefined);
            let variables: NativeComposeBuildDescription['buildSecretVariables'] = [];
            if (builds.length) {
                const platforms = await selectedPlatforms(options?.servicePlatforms?.map(item => item.platform), options?.signal);
                const uses = new Map<string, Set<string>>();
                for (const [index, platform] of platforms.entries()) {
                    const selected = builds.filter(item => needsPlatform(item.service, platform, options?.servicePlatforms));
                    if (!selected.length) continue;
                    const file = join(await input.directory(), `describe-build-${index}.compose.yaml`);
                    await writeFile(file, JSON.stringify(buildProjection(model, allBuilds, platform)), { mode: 0o600 });
                    const { built } = await readBuildGraph(['buildx', 'bake', '--file', file, '--set', `*.platform=${platform}`],
                        allBuilds, selected, platform, options?.signal);
                    for (const use of buildSecretVariables(built)) {
                        const names = uses.get(use.service) ?? new Set<string>();
                        for (const name of use.names) names.add(name);
                        uses.set(use.service, names);
                    }
                }
                variables = [...uses].map(([service, names]) => ({ service, names: [...names].sort() }));
            }
            return { services: services.map(({ service }) => service),
                buildServices: builds.map(({ service }) => service), buildSecretVariables: variables, basis: {
                    manifestFingerprint: input.source.manifestFingerprint, configInputDigests, toolVersion, physicalProjectName: input.projectName } };
        },
        async prepareImages(options?: NativeComposePrepareImagesOptions): Promise<readonly DeploymentImageV1[]> {
            const signal = options?.signal;
            if (options?.build && !options.planOnly && (input.phase !== 'build' || !input.executionDirectory)) return refuse('deployment_build_phase_required');
            const { model } = await input.normalize(signal);
            const services = outputServices(model, options?.servicePlatforms);
            const builds = services.filter(({ definition }) => definition.build !== undefined);
            const allBuilds = selectedServices(model).filter(({ definition }) => definition.build !== undefined);
            if (builds.length && !options?.planOnly && !options?.build) {
                throw new PluginError({ code: 'unsupported', message: 'Deployment build preparation requires an admitted build operation' });
            }
            const selectedBuilds = options?.planOnly ? [] : builds;
            const prebuilt = services.filter(({ definition }) => definition.build === undefined);
            if (!selectedBuilds.length && !prebuilt.length) return [];
            // Before runtime review, discover one actual source variant, not a
            // variant inferred from the controller/build machine's platform.
            const platforms = options?.planOnly ? []
                : await selectedPlatforms(options?.servicePlatforms?.map(item => item.platform) ?? options?.platforms, signal);
            const images: DeploymentImageV1[] = [];
            let localSourceReferences: ReadonlyMap<string, string> | undefined;
            const localSourceReference = async (service: string) => {
                localSourceReferences ??= await withPrebuiltModel(prebuilt, signal, async definitions => new Map(prebuilt.map(({ service }) => {
                    const definition = definitions[service];
                    if (!record(definition) || typeof definition.image !== 'string' || !definition.image.trim()) return refuse('deployment_image_unavailable');
                    return [service, definition.image] as const;
                })));
                return localSourceReferences.get(service) ?? refuse('deployment_image_unavailable');
            };
            if (prebuilt.length && options?.build && !options.planOnly) {
                const selections = prebuilt.map(({ service }) => {
                    const approved = input.images.filter(image => image.service === service);
                    const requiredPlatforms = platforms.filter(platform => needsPlatform(service, platform, options.servicePlatforms));
                    const missing = requiredPlatforms.filter(platform => !approved.some(image => normalizeNativeComposePlatform(image.platform) === platform));
                    return { service, approved, requiredPlatforms, missing };
                });
                const prepare = async (definitions?: Record<string, unknown>, redact?: (value: string) => string) => {
                    for (const { service, approved, requiredPlatforms, missing } of selections) {
                        const definition = definitions?.[service];
                        const referenceFor = (image: DeploymentImageV1) => image.registryReference
                            ?? (record(definition) && typeof definition.image === 'string' ? definition.image : undefined);
                        const pinReference = (reference: string, digest: string) => {
                            const at = reference.lastIndexOf('@');
                            return `${at < 0 ? reference : reference.slice(0, at)}@${digest}`;
                        };
                        const variants = [...approved];
                        if (missing.length) {
                            const indexReferences = [...new Set(approved.flatMap(image => {
                                const reference = referenceFor(image);
                                // The private source supplies only the repository;
                                // approved immutable index bytes remain authority.
                                return image.indexDigest && reference ? [pinReference(reference, image.indexDigest)] : [];
                            }))];
                            if (indexReferences.length !== 1) return refuse('deployment_prebuilt_platform_pin_unavailable');
                            const selected = await identity.resolveVariants({ service, reference: indexReferences[0], platforms: missing },
                                { signal, registries: input.imageAcquisition?.registries });
                            if (selected.some(image => !image.indexDigest || !indexReferences[0].endsWith(`@${image.indexDigest}`))) {
                                return refuse('deployment_image_manifest_mismatch');
                            }
                            variants.push(...selected);
                        }
                        for (const platform of requiredPlatforms) {
                            const pins = variants.filter(image => normalizeNativeComposePlatform(image.platform) === platform);
                            if (pins.length !== 1) return refuse('deployment_prebuilt_platform_pin_unavailable');
                            const pin = pins[0];
                            const reference = !pin.registryReference && pin.indexDigest ? referenceFor(pin) : undefined;
                            const image = reference ? { ...pin, registryReference: pinReference(reference, pin.manifestDigest) } : pin;
                            const located = await identity.acquire(image, {
                                purpose: 'buildSource',
                                authority: options.authority,
                                ...(!image.registryReference ? { localSourceReference: () => localSourceReference(service) } : {}),
                                references: [ownedTag(service, image.platform), image.configDigest, ...(image.registryReference ? [image.registryReference] : [])],
                                acquisition: input.imageAcquisition,
                                async pull(registry, reference) { await input.run(['image', 'pull', '--platform', platform, reference], signal, true, registry, options.authority); },
                            });
                            acquiredReferences.set(imageKey(image), located.reference);
                            const { registryReference, ...portable } = image;
                            images.push(registryReference && (!redact || redact(registryReference) === registryReference) ? image : portable);
                        }
                    }
                };
                if (selections.some(selection => selection.approved.some(image => image.indexDigest && !image.registryReference))) {
                    // A secret-derived source reference is never persisted.
                    // Re-evaluate only this build-phase projection, and keep
                    // native resolution/acquisition inside its redaction scope.
                    await withPrebuiltModel(prebuilt, signal, prepare);
                } else await prepare();
            } else if (prebuilt.length) {
                await withPrebuiltModel(prebuilt, signal, async (definitions, redact) => {
                    for (const { service } of prebuilt) {
                        const definition = definitions[service];
                        if (!record(definition) || typeof definition.image !== 'string' || !definition.image.trim()) return refuse('deployment_image_unavailable');
                        const resolved: DeploymentImageV1[] = [];
                        const requiredPlatforms = platforms.filter(platform => needsPlatform(service, platform, options?.servicePlatforms));
                        if (input.phase === 'build' || options?.planOnly) {
                            resolved.push(...await identity.resolveVariants({ service, reference: definition.image,
                                ...(!options?.planOnly ? { platforms: requiredPlatforms } : {}) },
                                { signal, registries: input.imageAcquisition?.registries }));
                        } else {
                            // Existing runtime/local discovery has no registry
                            // demand authority. Builder planning owns index IO.
                            for (const platform of requiredPlatforms) resolved.push(await identity.resolve({ service, reference: definition.image, platform }, { signal }));
                        }
                        for (const image of resolved.filter(image => options?.planOnly || needsPlatform(service, image.platform, options?.servicePlatforms))) {
                            const { registryReference, ...portable } = image;
                            images.push(registryReference && redact(registryReference) === registryReference ? image : portable);
                        }
                    }
                });
            }
            if (selectedBuilds.length) {
                if (input.phase !== 'build' || !input.executionDirectory || !options?.build) return refuse('deployment_build_phase_required');
                const secretNames = new Set(options.build.secretVariableNames);
                const verifiedLocalInputs = new Set<string>();
                for (const [index, platform] of platforms.entries()) {
                    const requiredBuilds = selectedBuilds.filter(item => needsPlatform(item.service, platform, options.servicePlatforms));
                    if (!requiredBuilds.length) continue;
                    const dir = await input.directory();
                    const file = join(dir, `build-${index}.compose.yaml`);
                    await writeFile(file, JSON.stringify(buildProjection(model, allBuilds, platform)), { mode: 0o600 });
                    const prefix = ['buildx', 'bake', '--file', file, '--allow', `fs.read=${input.source.rootPath}`,
                        '--allow', `fs.write=${input.executionDirectory}`, '--set', `*.platform=${platform}`];
                    const { selected: selections, built } = await readBuildGraph(prefix, allBuilds, requiredBuilds, platform, signal);
                    for (const target of built) {
                        const definition = allBuilds.find(service => service.service === target.service)!.definition;
                        if (record(definition.build) && record(definition.build.args)) {
                            for (const [name, value] of Object.entries(definition.build.args)) {
                                if (value === null && secretNames.has(name) || referencesSecret(value, secretNames)) secretArgument();
                            }
                        }
                    }
                    await validateLocalInputs(built.map(item => item.definition), verifiedLocalInputs);
                    const metadataPath = join(dir, `build-${index}.metadata.json`);
                    const outputs = selections.map((selection, serviceIndex) => ({ ...selection, path: join(dir, `image-${index}-${serviceIndex}.tar`) }));
                    const args = [...prefix, '--metadata-file', metadataPath,
                        ...outputs.flatMap(output => ['--set', `${output.target}.output=${exporter(output.path)}`,
                            '--set', `${output.target}.tags=${ownedTag(output.service, platform)}`]),
                        ...built.flatMap(target => options.build!.noCacheServices.includes(target.service)
                            ? ['--set', `${target.target}.no-cache=true`] : []),
                        ...selections.map(selection => selection.target)];
                    await input.run(args, signal, true, undefined, options.authority);
                    const metadata: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
                    if (!record(metadata)) return refuse('deployment_image_identity_unavailable');
                    for (const output of outputs) images.push(await identity.resolveBuildArchive({ service: output.service, platform,
                        archivePath: output.path, metadata: metadata[output.target] }));
                }
            }
            const published = await publishNativeComposeImages({ phase: input.phase, source: input.source, model, images,
                acquisition: input.imageAcquisition, identity, composeArgs: input.composeArgs, parseComposeModel: input.parseComposeModel,
                directory: input.directory, assertCurrent: input.assertCurrent, run: input.run, withOutput: input.withOutput, signal,
                authority: options?.authority });
            images.splice(0, images.length, ...published);
            await input.assertCurrent(signal);
            for (const image of images) prepared.add(imageKey(image));
            return images;
        },
        async exportImages(request: Readonly<{ images: readonly DeploymentImageV1[]; signal?: AbortSignal;
            authority?: NativeComposeEffectAuthority }>): Promise<readonly NativeComposeImageArchive[]> {
            const archives: NativeComposeImageArchive[] = [];
            for (const image of request.images) {
                await input.assertCurrent(request.signal);
                if (!prepared.has(imageKey(image))) return refuse('deployment_image_identity_unavailable');
                archives.push(await identity.exportImage(image, { references: [
                    ...(acquiredReferences.has(imageKey(image)) ? [acquiredReferences.get(imageKey(image))!] : []),
                    ownedTag(image.service, image.platform), image.configDigest, ...(image.registryReference ? [image.registryReference] : [])],
                    ownedTag: ownedTag(image.service, image.platform), signal: request.signal, authority: request.authority }));
            }
            await input.assertCurrent(request.signal);
            return archives;
        },
    };
}
