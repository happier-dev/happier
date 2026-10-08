import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalizePath, isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type { DevcontainerEffectReviewV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { DevcontainerReviewQuerySchema } from './schemas.js';
import type { DevcontainerReviewQuery } from './schemas.js';

type NativeReviewInput = Readonly<{ exec: Pick<ExecService, 'run'>; docker: ManagedExecutableRef;
  devcontainer: ManagedExecutableRef; signal: AbortSignal; environment?: Readonly<Record<string, string>> }>;
type Effect = DevcontainerEffectReviewV1['effects'][number];
const reviewComposeNamespace = 'happierreview';
const namespaceParameter = '${managedMachineNamespace}';
/** Native Compose accepts the existing managed row identity as its namespace. */
export function devcontainerComposeProjectName(managedMachineId: string): string {
  return `happier${Buffer.from(managedMachineId).toString('hex')}`;
}
/** Ephemeral native CLI input. It is never a saved launch/resource or disclosure. */
export function readDevcontainerNativeEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
}
function parameterizeComposeIdentities(compose: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const definitions = (kind: 'networks' | 'volumes') => Object.fromEntries(Object.entries(record(compose[kind])).map(([key, entry]) => {
    const definition = record(entry);
    const authored = record(record(source[kind])[key]);
    // Compose uses explicit names as-is, even for nonexternal resources.
    // Native Normalize generates project_key only when name is absent
    // (compose-go loader/normalize.go:290–314). Never rewrite static keys or
    // references, or unrelated environment-derived explicit names.
    const generated = !Object.hasOwn(authored, 'name') && definition.external !== true && authored.external !== true
      && definition.name === `${reviewComposeNamespace}_${key}`;
    return [key, generated ? { ...definition, name: `${namespaceParameter}_${key}` } : definition];
  }));
  return { ...compose,
    ...(compose.name === reviewComposeNamespace ? { name: namespaceParameter } : {}),
    networks: definitions('networks'), volumes: definitions('volumes'),
  };
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function nativeJson(result: PluginProcessResult): unknown {
  if (result.termination.requestedBy.kind !== 'none' || result.termination.observed.kind !== 'exit'
    || result.termination.observed.exitCode !== 0 || result.stdoutTruncated) fail('native_observation_unavailable');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)); }
  catch { return fail('native_observation_unavailable'); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(record(value)).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(strings);
  return [];
}
function commands(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.every(entry => typeof entry === 'string') ? [value.join(' ')] : value.flatMap(commands);
  }
  return Object.entries(record(value)).flatMap(([name, entry]) => commands(entry).map(command => `${name}: ${command}`));
}
function metadata(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'string') return [];
  try { const parsed: unknown = JSON.parse(value); return (Array.isArray(parsed) ? parsed : [parsed]).map(record); }
  catch { return fail('native_observation_unavailable'); }
}
async function contained(root: string, candidate: string): Promise<string> {
  const path = await canonicalizePath(candidate);
  if (!isCanonicalAbsolutePathInsideRoot(root, path)) fail('invalid_request');
  return path;
}
async function optionalSource(root: string, path: string): Promise<string | undefined> {
  try { return await readFile(await contained(root, path), 'utf8'); }
  catch (error) {
    if (record(error).code === 'ENOENT') return undefined;
    if (record(error).code === 'invalid_request') throw error;
    return fail('native_observation_unavailable');
  }
}

/** Native read-configuration does not launch or run lifecycle hooks. It resolves
 * Feature staging and image metadata; cache paths are not reviewed effects.
 * CLI main/spec-node/devContainersSpecCLI.ts:990–1146 and featureUtils.ts:5–22. */
export async function readDevcontainerEffectReview(input: NativeReviewInput, rawQuery: DevcontainerReviewQuery) {
  const environment = input.environment ?? readDevcontainerNativeEnvironment();
  const reviewEnvironment = { ...environment, COMPOSE_PROJECT_NAME: reviewComposeNamespace };
  const query = DevcontainerReviewQuerySchema.parse(rawQuery);
  if (!isAbsolute(query.workspaceFolder) || !isAbsolute(query.configPath)) fail('invalid_request');
  const workspaceFolder = await canonicalizePath(query.workspaceFolder);
  const configPath = await contained(workspaceFolder, query.configPath);
  const configSource = await optionalSource(workspaceFolder, configPath);
  if (configSource === undefined) fail('native_observation_unavailable');
  // Reuse the repository's Devcontainer JSONC display parser, without making
  // raw configuration an evaluator or acquisition authority. The native CLI
  // owns resolved effects; its public read output omits its internal raw peer.
  let authoredConfiguration: Record<string, unknown>;
  try { authoredConfiguration = record((await import('json5')).default.parse<unknown>(configSource)); }
  catch { return fail('native_observation_unavailable'); }
  const lockPath = join(dirname(configPath), basename(configPath).startsWith('.') ? '.devcontainer-lock.json' : 'devcontainer-lock.json');
  const lockSource = await optionalSource(workspaceFolder, lockPath);
  let lockedFeatures: Record<string, unknown> = {};
  if (lockSource?.trim()) {
    try { lockedFeatures = record(record(JSON.parse(lockSource)).features); }
    catch { fail('native_observation_unavailable'); }
  }
  const run = async (executable: ManagedExecutableRef, args: readonly string[]) => nativeJson(
    await input.exec.run({ executable, args, cwd: workspaceFolder,
      env: reviewEnvironment }, { signal: input.signal }));
  const native = record(await run(input.devcontainer, ['read-configuration', '--workspace-folder', workspaceFolder,
    '--config', configPath, '--id-label', `devcontainer.local_folder=${workspaceFolder}`,
    '--id-label', `devcontainer.config_file=${configPath}`, '--id-label', 'happier.managed-machine= ',
    '--include-merged-configuration', '--include-features-configuration']));
  // CLI id-label validation requires a nonempty value. Protocol row ids trim
  // and reject blank values, so this existing-label exclusion cannot select a
  // managed row. Provided labels bypass incumbent fallback (CLI utils:668–673).
  // It is only a passive source selector, never a Machine/resource identity.
  if (!isRecord(native.configuration) || !isRecord(native.mergedConfiguration) || !isRecord(native.workspace)) fail('native_observation_unavailable');
  const configuration = record(native.configuration);
  const merged = record(native.mergedConfiguration);
  const workspace = record(native.workspace);
  const effects: Effect[] = [];
  const evidence: unknown[] = [];
  let selectedImageMetadata: Record<string, unknown>[] | undefined;
  let mergedHookPeers: Record<string, unknown>[] = [];
  let mergedEntrypointPeers: Record<string, unknown>[] = [];
  const add = (scope: Effect['scope'], kind: Effect['kind'], title: string, details: readonly string[]) => {
    if (details.length) effects.push({ scope, kind, title, details: [...details] });
  };
  const authoredHook = (hook: string): unknown | undefined => {
    const value = authoredConfiguration[hook];
    return commands(value).some(command => /\$\{(?:localEnv|env):/u.test(command)) ? value : undefined;
  };
  const configuredHook = (hook: string) => authoredHook(hook) ?? configuration[hook];
  const mergedCommandDisplay = (hook: string, command: unknown, index: number, values: readonly unknown[],
    origins: readonly Record<string, unknown>[]): unknown => {
    const peers = origins.filter(peer => Boolean(peer[hook]));
    // The public native reader omits Dockerfile base-image raw metadata. Known
    // Feature/config peers account for all commands only when their counts
    // agree; otherwise an unknown image hook cannot be faithfully disclosed
    // without possibly exposing an inherited value. No private base parser.
    if (selectedImageMetadata === undefined && values.length !== peers.length) fail('native_observation_unavailable');
    const peer = peers[index - (values.length - peers.length)];
    const rawTemplate = peer && commands(peer[hook]).some(value => /\$\{(?:localEnv|env):/u.test(value));
    return rawTemplate && (peer !== authoredConfiguration || canonical(command) === canonical(configuration[hook]))
      ? peer[hook] : command;
  };
  const hooks = (source: Record<string, unknown>, title: string) => {
    for (const hook of ['onCreateCommand', 'updateContentCommand', 'postCreateCommand', 'postStartCommand', 'postAttachCommand']) {
      add('child', 'lifecycle', `${title} · ${hook}`, commands(source === configuration ? configuredHook(hook) : source[hook]));
      // Native merged configuration carries plural arrays of lifecycle commands.
      const plural = `${hook}s`;
      if (Array.isArray(source[plural])) {
        const values: unknown[] = source[plural];
        for (const [index, command] of values.entries()) {
          // Native metadata appends Feature/config peers after image peers
          // (imageMetadata.ts:273–295, mergeLifecycleHooks:136–144). Preserve
          // authored env templates only at those known ordered origins, never
          // by secret name or by replacing arbitrary environment values.
          const display = source === merged ? mergedCommandDisplay(hook, command, index, values, mergedHookPeers) : command;
          add('child', 'lifecycle', `${title} · ${hook}`, commands(display));
        }
      }
    }
    if (source === merged && Array.isArray(source.entrypoints)) {
      const values: unknown[] = source.entrypoints;
      for (const [index, command] of values.entries()) add('child', 'lifecycle', `${title} · entrypoint`,
        strings(mergedCommandDisplay('entrypoint', command, index, values, mergedEntrypointPeers)));
    } else add('child', 'lifecycle', `${title} · entrypoint`, strings(source.entrypoints ?? source.entrypoint));
    add('child', 'environment', title, Object.keys(record(source.remoteEnv)));
    add('child', 'environment', title, Object.keys(record(source.containerEnv)));
    add('child', 'user', title, strings([source.remoteUser, source.containerUser, source.userEnvProbe]));
    add('child', 'mount', title, Array.isArray(source.mounts) ? source.mounts.map(mount => typeof mount === 'string' ? mount
      : `${String(record(mount).type ?? '')}: ${String(record(mount).source ?? '')} → ${String(record(mount).target ?? '')}`) : []);
    add('child', 'network', title, strings(source.runArgs));
    add('child', 'network', `${title} · ports`, strings([source.appPort, source.forwardPorts]));
    add('child', 'network', `${title} · privileges`, strings([source.privileged, source.capAdd, source.securityOpt]));
  };
  add('host', 'initialize', 'initializeCommand', commands(configuredHook('initializeCommand')));
  add('host', 'image', 'Passive native metadata inspection', [
    'Passive inspection may download Feature metadata and full container images into native caches. It never runs configuration hooks.',
  ]);
  hooks(configuration, 'Devcontainer');
  add('child', 'mount', 'Workspace', strings([workspace.workspaceMount, configuration.workspaceMount]));
  add('child', 'user', 'Workspace', strings([workspace.workspaceFolder, configuration.workspaceFolder]));

  async function image(imageRef: unknown, selected = false) {
    if (typeof imageRef !== 'string') return;
    add('host', 'image', 'Container image', [imageRef]);
    let inspection = await input.exec.run({ executable: input.docker, args: ['image', 'inspect', imageRef],
      cwd: workspaceFolder, env: reviewEnvironment }, { signal: input.signal });
    if (inspection.termination.requestedBy.kind === 'none' && inspection.termination.observed.kind === 'exit'
      && inspection.termination.observed.exitCode !== 0) {
      // Native read-configuration can obtain registry metadata without a local
      // image (utils.ts:260–289). This additional image-config inspection may
      // download the full image into Docker's cache when it is absent locally;
      // no container, Dockerfile instruction or lifecycle hook is evaluated.
      const pulled = await input.exec.run({ executable: input.docker, args: ['pull', imageRef],
        cwd: workspaceFolder, env: reviewEnvironment }, { signal: input.signal });
      if (pulled.termination.requestedBy.kind !== 'none' || pulled.termination.observed.kind !== 'exit'
        || pulled.termination.observed.exitCode !== 0) fail('native_observation_unavailable');
      inspection = await input.exec.run({ executable: input.docker, args: ['image', 'inspect', imageRef],
        cwd: workspaceFolder, env: reviewEnvironment }, { signal: input.signal });
    }
    const inspected = nativeJson(inspection);
    if (!Array.isArray(inspected) || inspected.length !== 1 || typeof record(inspected[0]).Id !== 'string') fail('native_observation_unavailable');
    const nativeImage = record(inspected[0]);
    const imageConfig = record(nativeImage.Config);
    const imageMetadata = record(imageConfig.Labels)['devcontainer.metadata'];
    evidence.push({ image: imageRef, id: nativeImage.Id, metadata: imageMetadata ?? null });
    add('child', 'lifecycle', `Image ${imageRef} · entrypoint`, strings(imageConfig.Entrypoint));
    add('child', 'lifecycle', `Image ${imageRef} · command`, strings(imageConfig.Cmd));
    add('child', 'user', `Image ${imageRef}`, strings(imageConfig.User));
    add('child', 'environment', `Image ${imageRef}`, strings(imageConfig.Env).map(value => value.split('=', 1)[0]!).filter(Boolean));
    const rawMetadata = metadata(imageMetadata);
    if (selected) selectedImageMetadata = rawMetadata;
    for (const entry of rawMetadata) hooks(entry, `Image ${imageRef}`);
  }
  const sources: Record<string, string> = { [configPath]: configSource };
  if (lockSource !== undefined) sources[lockPath] = lockSource;
  async function dockerfile(source: unknown, base: string, title: string) {
    if (typeof source !== 'string') return;
    const path = await contained(workspaceFolder, resolve(base, source));
    const body = await optionalSource(workspaceFolder, path);
    if (body === undefined) fail('native_observation_unavailable');
    sources[path] = body;
    add('host', 'build', title, [path]);
    // Full source belongs to the Files view, not a retained public choice.
    // The digest binds every instruction without exposing ENV/ARG secrets or
    // inventing a second Dockerfile parser/evaluator.
  }
  const build = record(configuration.build);
  await dockerfile(configuration.dockerFile ?? build.dockerfile, dirname(configPath), 'Dockerfile');
  add('host', 'build', 'Build context', strings([configuration.context, build.context, build.target]));
  add('host', 'build', 'Build argument names', Object.keys(record(build.args)));
  await image(configuration.image, !configuration.dockerFile && !build.dockerfile && !('dockerComposeFile' in configuration));

  let compose: Record<string, unknown> | undefined;
  if ('dockerComposeFile' in configuration) {
    const declaredFiles = strings(configuration.dockerComposeFile);
    let selectedFiles = declaredFiles.map(file => resolve(dirname(configPath), file));
    if (selectedFiles.length === 0) {
      // Exact Devcontainer native file-selection contract, configuration.ts:
      // 219–252. This is not a second Compose/.env interpolation parser.
      const envPath = join(workspaceFolder, '.env');
      const envSource = await optionalSource(workspaceFolder, envPath);
      if (envSource !== undefined) sources[envPath] = envSource;
      const composeFile = environment.COMPOSE_FILE || /^COMPOSE_FILE=(.+)$/mu.exec(envSource ?? '')?.[1]?.trim();
      if (composeFile) selectedFiles = composeFile.split(delimiter).map(file => resolve(workspaceFolder, file));
      else {
        selectedFiles = [join(workspaceFolder, 'docker-compose.yml')];
        const override = join(workspaceFolder, 'docker-compose.override.yml');
        if (await optionalSource(workspaceFolder, override) !== undefined) selectedFiles.push(override);
      }
    }
    const files = await Promise.all(selectedFiles.map(file => contained(workspaceFolder, file)));
    for (const file of files) {
      const body = await optionalSource(workspaceFolder, file);
      if (body === undefined) fail('native_observation_unavailable');
      sources[file] = body;
    }
    const composeArgs = ['compose', '--project-directory', dirname(files[0]!),
      ...files.flatMap(file => ['-f', file]), '--profile', '*', 'config'];
    compose = record(await run(input.docker, [...composeArgs, '--format', 'json']));
    if (!compose.services || Object.keys(record(compose.services)).length === 0) fail('native_observation_unavailable');
    // The same native parser's source model preserves authored expressions and
    // explicit names without creating a YAML/interpolation owner here.
    // Docker Compose config.go:75–78,277–298; compose-go loader.go:586–592.
    const composeSource = record(await run(input.docker, [...composeArgs, '--no-normalize', '--no-interpolate', '--format', 'json']));
    if (!composeSource.services || Object.keys(record(composeSource.services)).length === 0) fail('native_observation_unavailable');
    evidence.push({ composeSource });
    // Only proven native-generated Compose platform names are parametric.
    // Static keys/references and hook/image/env/build facts keep literal bytes:
    // the witness can coincidentally occur in an unrelated effective command.
    // Authored source bytes below remain unnormalized.
    compose = parameterizeComposeIdentities(compose, composeSource);
    add('host', 'compose', 'Compose namespace', ['${managedMachineNamespace} is derived from the existing managed row id.']);
    for (const [serviceName, value] of Object.entries(record(compose.services))) {
      const service = record(value);
      add('child', 'compose', serviceName, strings([service.command, service.entrypoint, service.image, service.user]));
      add('child', 'network', serviceName, [...strings(service.network_mode), ...Object.keys(record(service.networks)),
        ...(Array.isArray(service.ports) ? service.ports.map(port => `${String(record(port).published ?? '')}:${String(record(port).target ?? '')}`) : [])]);
      add('child', 'mount', serviceName, Array.isArray(service.volumes) ? service.volumes.map(volume => typeof volume === 'string' ? volume
        : `${String(record(volume).type ?? '')}: ${String(record(volume).source ?? '')} → ${String(record(volume).target ?? '')}`) : []);
      add('child', 'environment', serviceName, Object.keys(record(service.environment)));
      add('child', 'network', `${serviceName} · privileges`, strings([service.privileged, service.cap_add, service.security_opt]));
      const serviceBuild = record(service.build);
      const base = typeof serviceBuild.context === 'string' ? resolve(dirname(files[0] ?? configPath), serviceBuild.context) : dirname(files[0] ?? configPath);
      if (service.build) await dockerfile(serviceBuild.dockerfile ?? 'Dockerfile', base, `${serviceName} · Dockerfile`);
      await image(service.image, serviceName === configuration.service && !service.build);
    }
    const nativeNames = (definitions: unknown) => Object.entries(record(definitions)).map(([key, value]) => {
      const definition = record(value);
      return `${key}: ${String(definition.name ?? key)}${definition.external === true ? ' (external)' : ''}`;
    });
    add('child', 'network', 'Compose networks', nativeNames(compose.networks));
    add('child', 'mount', 'Compose volumes', nativeNames(compose.volumes));
  }

  const featureSets = record(native.featuresConfiguration).featureSets;
  const stableFeatureSets = Array.isArray(featureSets) ? featureSets.map(value => {
    const set = record(value);
    const features = Array.isArray(set.features) ? set.features.map(value => {
      const { cachePath: _cachePath, ...feature } = record(value);
      return feature;
    }) : [];
    return { ...set, features };
  }) : [];
  for (const id of Object.keys(record(configuration.features))) add('host', 'feature', id, [id]);
  for (const set of stableFeatureSets) {
    const source = record(set.sourceInformation);
    const title = typeof source.userFeatureId === 'string' ? source.userFeatureId : 'Feature';
    if (!(title in lockedFeatures)) for (const feature of set.features) hooks(feature, title);
    if (source.type === 'file-path' && typeof source.resolvedFilePath === 'string') {
      for (const name of ['devcontainer-feature.json', 'install.sh']) {
        const path = await contained(workspaceFolder, join(source.resolvedFilePath, name));
        const body = await optionalSource(workspaceFolder, path);
        if (body !== undefined) sources[path] = body;
      }
    }
  }
  // read-configuration deliberately ignores lockfiles. Read pinned OCI metadata
  // through the CLI's public passive manifest command, rather than calling the
  // unlocked Feature resolution the installed effect. Other source kinds retain
  // their exact locked identity with an explicit metadata uncertainty.
  for (const [id, value] of Object.entries(lockedFeatures)) {
    const locked = record(value);
    if (typeof locked.resolved !== 'string') fail('native_observation_unavailable');
    add('host', 'feature', id, [locked.resolved]);
    if (!/^[^\s]+@sha256:[a-f0-9]{64}$/u.test(locked.resolved)) {
      add('child', 'feature', id, ['Lifecycle metadata for this locked source is unavailable from the native manifest reader.']);
      continue;
    }
    const manifest = record(await run(input.devcontainer, ['features', 'info', 'manifest', locked.resolved, '--output-format', 'json']));
    if (!manifest.manifest || typeof manifest.canonicalId !== 'string') fail('native_observation_unavailable');
    evidence.push({ feature: id, resolved: locked.resolved, manifest });
    const entries = metadata(record(record(manifest.manifest).annotations)['dev.containers.metadata']);
    if (entries.length === 0) add('child', 'feature', id, ['Lifecycle metadata is absent from this pinned Feature manifest.']);
    for (const entry of entries) hooks(entry, id);
  }
  if (Object.keys(lockedFeatures).length) add('child', 'feature', 'Locked and currently observed Feature metadata', [
    'Pinned Feature metadata is authoritative. Native merged configuration observes unlocked Feature metadata; changes to that observation may require another review.',
  ]);
  const authoritativeFeatureSets = stableFeatureSets.filter(set => !(String(record(set.sourceInformation).userFeatureId ?? '') in lockedFeatures));
  // Native merge order is base-image metadata, raw Feature peers, then the
  // selected config (imageMetadata.ts:273–295). Align only those known native
  // origins, rather than replacing equal text in unrelated commands.
  mergedEntrypointPeers = [...(selectedImageMetadata ?? []), ...stableFeatureSets.flatMap(set => set.features)];
  mergedHookPeers = [...mergedEntrypointPeers, authoredConfiguration];
  hooks(merged, Object.keys(lockedFeatures).length ? 'Native merged configuration (unlocked Feature resolution)' : 'Native merged configuration');
  const reviewedEffectDigest = createHash('sha256').update(canonical({ workspaceFolder, configPath,
    observed: { configuration, workspace, mergedConfiguration: merged,
      featureSets: authoritativeFeatureSets, compose: compose ?? null, evidence }, sources })).digest('hex');
  return { launch: { workspaceFolder, configPath, reviewedEffectDigest },
    effectReview: { kind: 'devcontainer' as const, reviewedEffectDigest, effects } };
}

export async function assertDevcontainerEffectReview(input: NativeReviewInput, query: DevcontainerReviewQuery,
  reviewedEffectDigest: string): Promise<void> {
  const current = await readDevcontainerEffectReview(input, { workspaceFolder: query.workspaceFolder, configPath: query.configPath });
  if (current.launch.reviewedEffectDigest !== reviewedEffectDigest) fail('request_conflict');
}
