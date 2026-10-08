import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { DEVCONTAINER_PLUGIN } from '../manifest.js';

const roots: string[] = [];
const pinnedFeature = `example/feature@sha256:${'a'.repeat(64)}`;
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function result(value: unknown): PluginProcessResult {
  return { termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } },
    stdout: new TextEncoder().encode(JSON.stringify(value)), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
async function reviewBoundary() {
  const workspaceFolder = await mkdtemp(join(tmpdir(), 'happier-devcontainer-review-'));
  roots.push(workspaceFolder);
  await mkdir(join(workspaceFolder, '.devcontainer'));
  const configPath = join(workspaceFolder, '.devcontainer', 'devcontainer.json');
  await writeFile(configPath, JSON.stringify({ image: 'example:latest', initializeCommand: 'host-setup' }));
  const nativeConfiguration: { configuration: Record<string, unknown>; workspace: Record<string, unknown>;
    mergedConfiguration: Record<string, unknown>; featuresConfiguration: Record<string, unknown> } = { configuration: { image: 'example:latest', initializeCommand: 'host-setup',
    remoteEnv: { API_TOKEN: 'private-value' }, runArgs: ['--network', 'host'],
    mounts: ['type=bind,source=/host/data,target=/data'], features: { 'example/feature:1': {} } },
    workspace: { workspaceFolder: '/work/project', workspaceMount: `type=bind,source=${workspaceFolder},target=/work/project` },
    mergedConfiguration: { postCreateCommands: ['child-setup'], remoteUser: 'coder', workspaceFolder: '/work/project' },
    featuresConfiguration: { featureSets: [] } };
  const compose = { services: { app: { image: 'example:latest', network_mode: 'host',
    command: ['run-app'], volumes: [{ type: 'bind', source: '/host/data', target: '/data' }] } } };
  const composeNamespace = { inherited: 'uncontrolled-project', enabled: false };
  const composeExternalEnvironment: { key?: string } = {};
  const incumbent = { present: false };
  const nativeHookEnvironment: { key?: string; merged?: boolean; prefix?: string; child?: boolean; imageKey?: string } = {};
  const imageCache: { present: boolean; config: Record<string, unknown> } = { present: true, config: { Labels: {} } };
  const featureMetadata = { postCreateCommand: 'locked-feature-setup' };
  const requests: Parameters<ExecService['run']>[0][] = [];
  const handlers = new Map<string, ActionHandler>();
  // Action registration, native process IO and installed tool availability are external boundaries.
  await DEVCONTAINER_PLUGIN.activate({ actions: { register(id: string, handler: ActionHandler) {
    handlers.set(id, handler); return { dispose() {} };
  } } } as unknown as PluginApi);
  const context = { invokedAtMs: 42, signal: new AbortController().signal,
    services: { exec: { run: async (request: Parameters<ExecService['run']>[0]) => {
      requests.push(request);
      if (request.args?.[0] === 'read-configuration') {
        // Native CLI provided id-labels bypass the workspace-label incumbent fallback.
        if (incumbent.present && !request.args.includes('happier.managed-machine= ')) {
          return result({ ...nativeConfiguration, mergedConfiguration: { postCreateCommands: ['incumbent-only-hook'] } });
        }
        if (nativeHookEnvironment.key) {
          const effectiveHook = `${nativeHookEnvironment.prefix ?? ''}${request.env?.[nativeHookEnvironment.key] ?? ''}`;
          return result(nativeHookEnvironment.merged ? { ...nativeConfiguration,
            mergedConfiguration: { ...nativeConfiguration.mergedConfiguration, postCreateCommands: [
              ...(nativeHookEnvironment.imageKey ? [`echo ${request.env?.[nativeHookEnvironment.imageKey] ?? ''}`] : []), effectiveHook,
            ], ...(nativeHookEnvironment.imageKey ? { entrypoints: [`echo ${request.env?.[nativeHookEnvironment.imageKey] ?? ''}`, effectiveHook] } : {}) },
          } : { ...nativeConfiguration, configuration: {
            ...nativeConfiguration.configuration, initializeCommand: effectiveHook,
            ...(nativeHookEnvironment.child ? { postCreateCommand: effectiveHook } : {}),
          }, ...(nativeHookEnvironment.child ? { mergedConfiguration: {
            ...nativeConfiguration.mergedConfiguration, postCreateCommands: [effectiveHook],
          } } : {}) });
        }
        return result(nativeConfiguration);
      }
      if (request.args?.[0] === 'image') {
        if (!imageCache.present) return { ...result(null), termination: {
          requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 1 },
        } };
        return result([{ Id: 'sha256:image', Config: imageCache.config }]);
      }
      if (request.args?.[0] === 'pull') { imageCache.present = true; return result(null); }
      if (request.args?.[0] === 'compose') {
        if (request.args.includes('--no-normalize')) {
          if (composeExternalEnvironment.key) return result({ ...compose, networks: { external: {
            external: true, name: '${HAPPIER_EXTERNAL_NETWORK}',
          } }, volumes: { custom: { name: '${HAPPIER_EXTERNAL_NETWORK}' } } });
          if (composeNamespace.enabled) return result({ ...compose, volumes: { data: {} }, networks: { default: {} },
            services: { app: { ...compose.services.app, volumes: [{ type: 'volume', source: 'data', target: '/data' }] } } });
          return result(compose);
        }
        if (composeExternalEnvironment.key) return result({ ...compose, networks: { external: {
          external: true, name: request.env?.[composeExternalEnvironment.key]?.replaceAll('$', () => '$$'),
        } }, volumes: { custom: { name: request.env?.[composeExternalEnvironment.key]?.replaceAll('$', () => '$$') } } });
        if (!composeNamespace.enabled) return result(compose);
        const namespace = request.env?.COMPOSE_PROJECT_NAME ?? composeNamespace.inherited;
        return result({ ...compose, name: namespace, networks: { default: { name: `${namespace}_default` } },
          volumes: { data: { name: `${namespace}_data` } }, services: { app: { ...compose.services.app,
            volumes: [{ type: 'volume', source: 'data', target: '/data' }] } } });
      }
      if (request.args?.[0] === 'features') return result({ canonicalId: pinnedFeature,
        manifest: { annotations: { 'dev.containers.metadata': JSON.stringify(featureMetadata) } } });
      throw new Error(`Unexpected native effect: ${request.args?.join(' ')}`);
    } }, managedServices: { dependencies: { status: async (id: string) => ({ state: 'ready', executable: {
      kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: id },
    } }) } } },
  } as unknown as PluginInvocationContext;
  return { workspaceFolder, configPath, nativeConfiguration, compose, composeNamespace, composeExternalEnvironment, incumbent, nativeHookEnvironment, imageCache, featureMetadata, requests, handlers, context };
}

describe('Devcontainer public passive effect review', () => {
  it('offers reviewed launch choices and typed host/child effects through the existing options role without evaluating hooks', async () => {
    const boundary = await reviewBoundary();
    expect(DEVCONTAINER_PLUGIN.manifest.contributes.machineProvisioners[0]?.actions.options).toBe('options');
    const value = await boundary.handlers.get('options')!({ workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath }, boundary.context);
    const options = MachineProvisionerOptionsResultV1Schema.parse(value);
    expect(options.choices).toHaveLength(1);
    expect(options.choices[0]).toMatchObject({ available: true, launch: {
      workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath,
      reviewedEffectDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }, effectReview: { kind: 'devcontainer', effects: expect.arrayContaining([
      expect.objectContaining({ scope: 'host', kind: 'initialize', details: ['host-setup'] }),
      expect.objectContaining({ scope: 'child', kind: 'lifecycle', details: ['child-setup'] }),
      expect.objectContaining({ scope: 'child', kind: 'environment', details: ['API_TOKEN'] }),
    ]) } });
    expect(JSON.stringify(options)).not.toContain('private-value');
    expect(boundary.requests.map(request => request.args?.[0])).toEqual(['read-configuration', 'image']);
    expect(boundary.requests[0]?.args).toEqual(expect.arrayContaining(['--include-merged-configuration', '--include-features-configuration']));
  });

  it('forwards the same inherited native environment for passive review and realization, including arbitrary localEnv and Compose selection', async () => {
    const boundary = await reviewBoundary();
    const composePath = join(boundary.workspaceFolder, '.devcontainer', 'native.yml');
    await writeFile(composePath, 'services:\n  app:\n    image: example:latest\n');
    vi.stubEnv('HAPPIER_NATIVE_REVIEW_CUSTOM', 'native-custom-value');
    vi.stubEnv('DOCKER_HOST', 'unix:///native/docker.sock');
    vi.stubEnv('COMPOSE_FILE', composePath);
    boundary.nativeConfiguration.configuration.dockerComposeFile = [];
    boundary.nativeConfiguration.configuration.service = 'app';
    const options = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(
      { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath }, boundary.context));
    await boundary.handlers.get('acquire')!({ launch: options.choices[0]?.launch, managedId: 'native-env-row' }, boundary.context);
    const nativeReadsAndLaunch = boundary.requests.filter(request => request.args?.[0] === 'read-configuration' || request.args?.[0] === 'up');
    expect(nativeReadsAndLaunch.some(request => request.args?.[0] === 'up')).toBe(true);
    for (const request of nativeReadsAndLaunch) {
      expect({ HAPPIER_NATIVE_REVIEW_CUSTOM: request.env?.HAPPIER_NATIVE_REVIEW_CUSTOM,
        DOCKER_HOST: request.env?.DOCKER_HOST, COMPOSE_FILE: request.env?.COMPOSE_FILE }).toEqual({ HAPPIER_NATIVE_REVIEW_CUSTOM: 'native-custom-value',
        DOCKER_HOST: 'unix:///native/docker.sock', COMPOSE_FILE: composePath });
      const pathEntry = Object.entries(request.env ?? {}).find(([key]) => key.toUpperCase() === 'PATH');
      expect(pathEntry?.[1]).toBe(process.env.PATH);
    }
    expect(JSON.stringify(options)).not.toContain('native-custom-value');
    expect(JSON.stringify(options)).not.toContain('unix:///native/docker.sock');
  });

  it('refuses changed reviewed host effects before native acquisition', async () => {
    const boundary = await reviewBoundary();
    const options = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(
      { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath }, boundary.context));
    boundary.nativeConfiguration.configuration.initializeCommand = 'different-host-setup';
    const acquired = await boundary.handlers.get('acquire')!({ launch: options.choices[0]?.launch, managedId: 'managed-review' }, boundary.context);
    expect(acquired).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
    expect(boundary.requests.some(request => request.args?.[0] === 'up')).toBe(false);
  });

  it('preserves non-Compose hook text and refuses different effective hooks containing the namespace witness', async () => {
    const boundary = await reviewBoundary();
    await writeFile(boundary.configPath, JSON.stringify({ image: 'example:latest', initializeCommand: 'touch /tmp/happierreview' }));
    boundary.nativeConfiguration.configuration.initializeCommand = 'touch /tmp/happierreview';
    boundary.nativeHookEnvironment.key = 'HAPPIER_REVIEW_HOOK';
    boundary.nativeHookEnvironment.merged = true;
    vi.stubEnv('HAPPIER_REVIEW_HOOK', 'touch /tmp/happierreview');
    const query = { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath };
    const first = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(first.choices[0]?.effectReview?.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'initialize', details: ['touch /tmp/happierreview'] }),
    ]));
    vi.stubEnv('HAPPIER_REVIEW_HOOK', 'touch /tmp/${managedMachineNamespace}');
    const second = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(second.choices[0]?.launch).not.toEqual(first.choices[0]?.launch);
    const acquired = await boundary.handlers.get('acquire')!({ launch: first.choices[0]?.launch, managedId: 'managed-review' }, boundary.context);
    expect(acquired).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
    expect(boundary.requests.some(request => request.args?.[0] === 'up')).toBe(false);
  });

  it('discloses authored localEnv hook templates without leaking inherited values while binding their effective digest', async () => {
    const boundary = await reviewBoundary();
    const template = 'echo ${localEnv:HAPPIER_REVIEW_TOKEN}';
    // JSONC is the real Devcontainer config grammar, including comments and trailing commas.
    await writeFile(boundary.configPath, `// Authored hook\n{ "image": "example:latest", "initializeCommand": "${template}", "postCreateCommand": "${template}", }`);
    boundary.nativeHookEnvironment.key = 'HAPPIER_REVIEW_TOKEN';
    boundary.nativeHookEnvironment.prefix = 'echo ';
    boundary.nativeHookEnvironment.child = true;
    vi.stubEnv('HAPPIER_REVIEW_TOKEN', 'inherited-secret-value');
    const query = { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath };
    const first = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(first.choices[0]?.effectReview?.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'initialize', details: [template] }),
      expect.objectContaining({ kind: 'lifecycle', details: [template] }),
    ]));
    expect(JSON.stringify(first)).not.toContain('inherited-secret-value');
    vi.stubEnv('HAPPIER_REVIEW_TOKEN', 'different-inherited-secret');
    const second = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(second.choices[0]?.launch).not.toEqual(first.choices[0]?.launch);
    expect(JSON.stringify(second)).not.toContain('different-inherited-secret');
  });

  it('discloses native image and Feature hook templates without exposing their substituted merged values', async () => {
    const boundary = await reviewBoundary();
    const template = 'echo ${localEnv:HAPPIER_REVIEW_FEATURE_TOKEN}';
    boundary.nativeConfiguration.featuresConfiguration = { featureSets: [{
      sourceInformation: { type: 'oci', userFeatureId: 'example/feature:1', manifestDigest: 'sha256:source' },
      features: [{ id: 'feature', postCreateCommand: template, entrypoint: template }],
    }] };
    boundary.nativeHookEnvironment.key = 'HAPPIER_REVIEW_FEATURE_TOKEN';
    boundary.nativeHookEnvironment.prefix = 'echo ';
    boundary.nativeHookEnvironment.merged = true;
    boundary.nativeHookEnvironment.imageKey = 'HAPPIER_REVIEW_IMAGE_TOKEN';
    const imageTemplate = 'echo ${localEnv:HAPPIER_REVIEW_IMAGE_TOKEN}';
    boundary.imageCache.config.Labels = { 'devcontainer.metadata': JSON.stringify({ postCreateCommand: imageTemplate, entrypoint: imageTemplate }) };
    vi.stubEnv('HAPPIER_REVIEW_FEATURE_TOKEN', 'inherited-feature-secret');
    vi.stubEnv('HAPPIER_REVIEW_IMAGE_TOKEN', 'inherited-image-secret');
    const options = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(
      { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath }, boundary.context));
    expect(options.choices[0]?.effectReview?.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'lifecycle', details: [template] }),
      expect.objectContaining({ kind: 'lifecycle', details: [imageTemplate] }),
    ]));
    expect(JSON.stringify(options)).not.toContain('inherited-feature-secret');
    expect(JSON.stringify(options)).not.toContain('inherited-image-secret');
  });

  it('reviews effective Compose service effects and refuses changed service networking before acquisition', async () => {
    const boundary = await reviewBoundary();
    const composePath = join(boundary.workspaceFolder, '.devcontainer', 'compose.yml');
    await writeFile(composePath, 'services:\n  app:\n    image: example:latest\n');
    boundary.nativeConfiguration.configuration.dockerComposeFile = ['compose.yml'];
    boundary.nativeConfiguration.configuration.service = 'app';
    const options = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(
      { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath }, boundary.context));
    expect(options.choices[0]).toMatchObject({ effectReview: { effects: expect.arrayContaining([
      expect.objectContaining({ kind: 'compose', scope: 'child', title: 'app' }),
      expect.objectContaining({ kind: 'network', scope: 'child', details: expect.arrayContaining(['host']) }),
    ]) } });
    expect(boundary.requests.find(request => request.args?.[0] === 'compose')?.args).toEqual(
      ['compose', '--project-directory', join(boundary.workspaceFolder, '.devcontainer'), '-f', composePath, '--profile', '*', 'config', '--format', 'json']);
    boundary.compose.services.app.network_mode = 'none';
    const acquired = await boundary.handlers.get('acquire')!({ launch: options.choices[0]?.launch, managedId: 'managed-review' }, boundary.context);
    expect(acquired).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
    expect(boundary.requests.some(request => request.args?.[0] === 'up')).toBe(false);
  });

  it('reviews row-derived Compose names parametrically, including dependent mount and network names', async () => {
    const boundary = await reviewBoundary();
    await writeFile(join(boundary.workspaceFolder, '.devcontainer', 'compose.yml'),
      'services:\n  app:\n    image: example:latest\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\nnetworks:\n  default: {}\n');
    boundary.nativeConfiguration.configuration.dockerComposeFile = ['compose.yml'];
    boundary.composeNamespace.enabled = true;
    boundary.nativeConfiguration.configuration.service = 'app';
    const query = { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath };
    const first = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    boundary.composeNamespace.inherited = 'another-uncontrolled-project';
    const second = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(second.choices[0]?.launch).toEqual(first.choices[0]?.launch);
    expect(first.choices[0]?.effectReview?.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'mount', details: expect.arrayContaining(['volume: data → /data']) }),
      expect.objectContaining({ kind: 'mount', details: expect.arrayContaining(['data: ${managedMachineNamespace}_data']) }),
      expect.objectContaining({ kind: 'network', details: expect.arrayContaining(['default: ${managedMachineNamespace}_default']) }),
    ]));
    expect(JSON.stringify(first)).not.toContain('uncontrolled-project');
    expect(boundary.requests.some(request => request.args?.includes('--no-normalize') && request.args.includes('--no-interpolate'))).toBe(true);
  });

  it('preserves explicit external Compose identities and refuses changed unrelated environment-derived names', async () => {
    const boundary = await reviewBoundary();
    await writeFile(join(boundary.workspaceFolder, '.devcontainer', 'compose.yml'),
      'services:\n  app:\n    image: example:latest\nnetworks:\n  external:\n    external: true\n    name: ${HAPPIER_EXTERNAL_NETWORK}\nvolumes:\n  custom:\n    name: ${HAPPIER_EXTERNAL_NETWORK}\n');
    boundary.nativeConfiguration.configuration.dockerComposeFile = ['compose.yml'];
    boundary.nativeConfiguration.configuration.service = 'app';
    boundary.composeExternalEnvironment.key = 'HAPPIER_EXTERNAL_NETWORK';
    vi.stubEnv('HAPPIER_EXTERNAL_NETWORK', 'happierreview-cache');
    const query = { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath };
    const first = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(first.choices[0]?.effectReview?.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'network', details: ['external: happierreview-cache (external)'] }),
      expect.objectContaining({ kind: 'mount', details: ['custom: happierreview-cache'] }),
    ]));
    vi.stubEnv('HAPPIER_EXTERNAL_NETWORK', '${managedMachineNamespace}-cache');
    const second = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(second.choices[0]?.launch).not.toEqual(first.choices[0]?.launch);
    const acquired = await boundary.handlers.get('acquire')!({ launch: first.choices[0]?.launch, managedId: 'external-network-review' }, boundary.context);
    expect(acquired).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
    expect(boundary.requests.some(request => request.args?.[0] === 'up')).toBe(false);
  });

  it('uses the native CLI workspace docker-compose defaults for an empty Compose file list', async () => {
    const boundary = await reviewBoundary();
    boundary.nativeConfiguration.configuration.dockerComposeFile = [];
    boundary.nativeConfiguration.configuration.service = 'app';
    const defaultPath = join(boundary.workspaceFolder, 'docker-compose.yml');
    const overridePath = join(boundary.workspaceFolder, 'docker-compose.override.yml');
    await writeFile(defaultPath, 'services:\n  app:\n    image: example:latest\n');
    await writeFile(overridePath, 'services:\n  app:\n    network_mode: host\n');
    // Docker Compose itself prefers compose.yaml; the Devcontainer native owner does not.
    await writeFile(join(boundary.workspaceFolder, 'compose.yaml'), 'services:\n  unselected:\n    image: other\n');
    await boundary.handlers.get('options')!({ workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath }, boundary.context);
    expect(boundary.requests.find(request => request.args?.[0] === 'compose')?.args).toEqual([
      'compose', '--project-directory', boundary.workspaceFolder, '-f', defaultPath, '-f', overridePath,
      '--profile', '*', 'config', '--format', 'json',
    ]);
    expect(boundary.requests.find(request => request.args?.[0] === 'compose')?.cwd).toBe(boundary.workspaceFolder);
  });

  it('keeps the review stable across native Feature staging directory changes without dropping source identities', async () => {
    const boundary = await reviewBoundary();
    boundary.nativeConfiguration.featuresConfiguration = { dstFolder: '/native/staging/first', featureSets: [{
      sourceInformation: { type: 'oci', userFeatureId: 'example/feature:1', manifestDigest: 'sha256:source' },
      features: [{ id: 'feature', postCreateCommand: 'feature-setup', cachePath: '/native/staging/first/feature' }],
    }] };
    const query = { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath };
    const first = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    boundary.nativeConfiguration.featuresConfiguration = { dstFolder: '/native/staging/second', featureSets: [{
      sourceInformation: { type: 'oci', userFeatureId: 'example/feature:1', manifestDigest: 'sha256:source' },
      features: [{ id: 'feature', postCreateCommand: 'feature-setup', cachePath: '/native/staging/second/feature' }],
    }] };
    const second = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(second.choices[0]?.launch).toEqual(first.choices[0]?.launch);
    boundary.nativeConfiguration.featuresConfiguration = { featureSets: [{
      sourceInformation: { type: 'oci', userFeatureId: 'example/feature:1', manifestDigest: 'sha256:different-source' },
      features: [{ id: 'feature', postCreateCommand: 'feature-setup', cachePath: '/native/staging/second/feature' }],
    }] };
    const changed = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(changed.choices[0]?.launch).not.toEqual(second.choices[0]?.launch);
  });

  it('reads future source effects rather than changing the review when an incumbent appears', async () => {
    const boundary = await reviewBoundary();
    const query = { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath };
    const first = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    boundary.incumbent.present = true;
    const second = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(second.choices[0]?.launch).toEqual(first.choices[0]?.launch);
    expect(JSON.stringify(second)).not.toContain('incumbent-only-hook');
    expect(boundary.requests.filter(request => request.args?.[0] === 'read-configuration').every(request =>
      request.args?.includes('happier.managed-machine= '))).toBe(true);
  });

  it('keeps Dockerfile source and secret-bearing instructions out of public choices while binding source edits', async () => {
    const boundary = await reviewBoundary();
    delete boundary.nativeConfiguration.configuration.image;
    boundary.nativeConfiguration.mergedConfiguration.postCreateCommands = [];
    boundary.nativeConfiguration.configuration.build = { dockerfile: 'Dockerfile', context: '.', args: { PRIVATE_TOKEN: 'private-build-value' } };
    const dockerfile = join(boundary.workspaceFolder, '.devcontainer', 'Dockerfile');
    await writeFile(dockerfile, 'FROM example:latest\nENV PRIVATE_TOKEN=private-source-value\nRUN install-package\n');
    const query = { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath };
    const first = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(JSON.stringify(first)).not.toContain('private-build-value');
    expect(JSON.stringify(first)).not.toContain('private-source-value');
    expect(first.choices[0]?.effectReview?.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'build', details: ['PRIVATE_TOKEN'] }),
      expect.objectContaining({ kind: 'build', details: [dockerfile] }),
    ]));
    await writeFile(dockerfile, 'FROM example:latest\nRUN different-package\n');
    const changed = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(changed.choices[0]?.launch).not.toEqual(first.choices[0]?.launch);
  });

  it('allows a Dockerfile with known hooks but refuses unavailable base-image hook origins without disclosing their effective values', async () => {
    const boundary = await reviewBoundary();
    delete boundary.nativeConfiguration.configuration.image;
    const template = 'echo ${localEnv:HAPPIER_REVIEW_TOKEN}';
    boundary.nativeConfiguration.configuration.build = { dockerfile: 'Dockerfile' };
    boundary.nativeConfiguration.configuration.postCreateCommand = 'echo inherited-build-secret';
    boundary.nativeConfiguration.mergedConfiguration.postCreateCommands = ['echo inherited-build-secret'];
    await writeFile(boundary.configPath, JSON.stringify({ build: { dockerfile: 'Dockerfile' }, postCreateCommand: template }));
    await writeFile(join(boundary.workspaceFolder, '.devcontainer', 'Dockerfile'), 'FROM example:latest\n');
    const query = { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath };
    const known = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(known.choices[0]?.available).toBe(true);
    expect(JSON.stringify(known)).not.toContain('inherited-build-secret');
    // Native merged output now includes an image-origin command whose raw
    // template/base-image identity is absent from public read-configuration.
    boundary.nativeConfiguration.mergedConfiguration.postCreateCommands = ['echo unidentified-base-secret', 'echo inherited-build-secret'];
    await expect(boundary.handlers.get('options')!(query, boundary.context)).rejects.toMatchObject({ code: 'native_observation_unavailable' });
    const acquired = await boundary.handlers.get('acquire')!({ launch: known.choices[0]?.launch, managedId: 'unavailable-origin-review' }, boundary.context);
    expect(acquired).toMatchObject({ kind: 'rejected', code: 'provider_unavailable' });
    expect(boundary.requests.some(request => request.args?.[0] === 'up')).toBe(false);
  });

  it('can passively obtain absent image metadata through the native image owner without evaluating a configuration', async () => {
    const boundary = await reviewBoundary();
    boundary.imageCache.present = false;
    const options = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(
      { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath }, boundary.context));
    expect(options.choices[0]?.available).toBe(true);
    expect(boundary.requests.map(request => request.args?.[0])).toEqual(['read-configuration', 'image', 'pull', 'image']);
    expect(JSON.stringify(options)).toContain('cache');
  });

  it('reviews native image entrypoint, command, user and environment names without disclosing environment values', async () => {
    const boundary = await reviewBoundary();
    boundary.imageCache.config = { Labels: {}, Entrypoint: ['image-entrypoint'], Cmd: ['image-command'],
      User: 'image-user', Env: ['IMAGE_TOKEN=private-image-value'] };
    const options = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(
      { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath }, boundary.context));
    expect(options.choices[0]?.effectReview?.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'child', kind: 'lifecycle', details: ['image-entrypoint'] }),
      expect.objectContaining({ scope: 'child', kind: 'lifecycle', details: ['image-command'] }),
      expect.objectContaining({ scope: 'child', kind: 'user', details: ['image-user'] }),
      expect.objectContaining({ scope: 'child', kind: 'environment', details: ['IMAGE_TOKEN'] }),
    ]));
    expect(JSON.stringify(options)).not.toContain('private-image-value');
  });

  it('refuses an uncontained config without invoking native reads', async () => {
    const boundary = await reviewBoundary();
    await expect(boundary.handlers.get('options')!({ workspaceFolder: boundary.workspaceFolder,
      configPath: join(boundary.workspaceFolder, '..', 'other-config.json') }, boundary.context)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(boundary.requests).toHaveLength(0);
  });

  it('discloses pinned Feature metadata through the native manifest read instead of claiming latest metadata is the locked effect', async () => {
    const boundary = await reviewBoundary();
    await writeFile(join(boundary.workspaceFolder, '.devcontainer', 'devcontainer-lock.json'), JSON.stringify({ features: {
      'example/feature:1': { version: '1.0.0', resolved: pinnedFeature, integrity: `sha256:${'a'.repeat(64)}` },
    } }));
    const options = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(
      { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath }, boundary.context));
    expect(options.choices[0]).toMatchObject({ effectReview: { effects: expect.arrayContaining([
      expect.objectContaining({ kind: 'feature', details: expect.arrayContaining([pinnedFeature]) }),
      expect.objectContaining({ kind: 'lifecycle', scope: 'child', details: ['locked-feature-setup'] }),
    ]) } });
    expect(boundary.requests.find(request => request.args?.[0] === 'features')?.args).toEqual(
      ['features', 'info', 'manifest', pinnedFeature, '--output-format', 'json']);
  });

  it('does not bind unlocked Feature source observations when the reviewed lockfile pins that Feature', async () => {
    const boundary = await reviewBoundary();
    await writeFile(join(boundary.workspaceFolder, '.devcontainer', 'devcontainer-lock.json'), JSON.stringify({ features: {
      'example/feature:1': { version: '1.0.0', resolved: pinnedFeature, integrity: `sha256:${'a'.repeat(64)}` },
    } }));
    boundary.nativeConfiguration.featuresConfiguration = { featureSets: [{
      sourceInformation: { type: 'oci', userFeatureId: 'example/feature:1', manifestDigest: 'sha256:unlocked-first' },
      features: [{ id: 'feature', postCreateCommand: 'unlocked-feature-setup' }],
    }] };
    const query = { workspaceFolder: boundary.workspaceFolder, configPath: boundary.configPath };
    const first = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    boundary.nativeConfiguration.featuresConfiguration = { featureSets: [{
      sourceInformation: { type: 'oci', userFeatureId: 'example/feature:1', manifestDigest: 'sha256:unlocked-second' },
      features: [{ id: 'feature', postCreateCommand: 'different-unlocked-feature-setup' }],
    }] };
    const second = MachineProvisionerOptionsResultV1Schema.parse(await boundary.handlers.get('options')!(query, boundary.context));
    expect(second.choices[0]?.launch).toEqual(first.choices[0]?.launch);
    expect(JSON.stringify(second)).not.toContain('different-unlocked-feature-setup');
  });

  it('refuses a contained-looking config symlink escaping the selected workspace before native reads', async () => {
    const boundary = await reviewBoundary();
    const outside = await mkdtemp(join(tmpdir(), 'happier-devcontainer-outside-'));
    roots.push(outside);
    const outsideConfig = join(outside, 'devcontainer.json');
    await writeFile(outsideConfig, JSON.stringify({ image: 'unreviewed-image' }));
    const linkedConfig = join(boundary.workspaceFolder, '.devcontainer', 'linked.json');
    await symlink(outsideConfig, linkedConfig);
    await expect(boundary.handlers.get('options')!({ workspaceFolder: boundary.workspaceFolder,
      configPath: linkedConfig }, boundary.context)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(boundary.requests).toHaveLength(0);
  });
});
