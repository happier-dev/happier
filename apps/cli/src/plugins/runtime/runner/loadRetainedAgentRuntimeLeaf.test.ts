import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { AgentContribution } from '@happier-dev/plugin-sdk/agents';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { resolvePluginStorePaths } from '../../store/paths';
import {
  createPluginManifestV2Fixture,
} from '../../testkit/manifestV2Fixture';
import {
  createImmutablePluginGenerationRecordFromSource,
  persistValidatedAgentSessionRunnerFactories,
  prepareImmutablePluginGeneration,
} from '../../store/registry/generationStore';
import {
  createAgentSessionRunnerFactoryBinding,
  createHostDeclarativeAcpRunnerBinding,
} from './agentSessionRunnerFactoryBinding';
import {
  loadRetainedAgentRuntimeLeaf,
  verifyRunnerAgentBindingAgainstGeneration,
} from './loadRetainedAgentRuntimeLeaf';
import { attestRetainedPluginSource, resolveRetainedBundledPluginRoot } from '../retainedPluginSourceAttestation';
import { resolveFirstPartyInstallLayout } from '@happier-dev/cli-common/firstPartyRuntime';
import { explainPinnedRunnerSnapshotUnreadiness } from '@happier-dev/cli-common/pinnedRunnerSnapshot';
import { publishPinnedRunnerSnapshotFixture } from '@/testkit/process/spawnHappyCliHarness';
import { readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot } from '@happier-dev/cli-common/componentArtifacts/copyCliNodeRuntimePayload';
import { createBundledActivationSourceResolver } from '../bundledActivationSource';
import { bindPluginRuntimeSourceAuthority } from '../sourceAuthority';
import { loadVerifiedPluginModule } from '../loadPluginModule';
import { resolveBuiltInContributions } from '../../projection/registry/resolveBuiltInContributions';
import { projectManifestAgentContribution } from '../../projection/registry/projectManifestAgentContribution';
import { createRunnerManagedServiceInvocationOwner } from '../invocation/services/createRunnerManagedServiceInvocationOwner';
import { resolveNativeAgentSessionNativeHomeService } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { readAgentRuntimeMaxInputUnicodeCharacters } from '@/capabilities/probes/agentRuntimeInputCapacity';

async function prepareRetainedFactory(input: Readonly<{
  happyHomeDir: string;
  sourceRootPath: string;
  immutableGenerationId: string;
  modulePath: string;
  moduleBytes: string;
  loadMode: 'immutable-js' | 'source-ts';
  pluginId?: string;
  agentId?: string;
  localAgentId?: string;
  manifestEngines?: Readonly<Record<string, string>>;
  externalSessionsExport?: string;
  additionalFiles?: Readonly<Record<string, string>>;
  manifestOverrides?: Readonly<Record<string, unknown>>;
  /**
   * Acquisition identity the generation record is minted from. It decides the
   * record's `sourceProvenance`, and with it the two registry-lifecycle
   * manifest rules — the reserved `happier.*` namespace and the
   * release-stamped engine range — which describe a published artifact and
   * deliberately exempt the default local working tree.
   */
  distribution?: Parameters<
    typeof createImmutablePluginGenerationRecordFromSource
  >[0]['distribution'];
}>) {
  const pluginId = input.pluginId ?? 'acme.runner-loader';
  const localAgentId = input.localAgentId ?? 'fixture';
  const paths = resolvePluginStorePaths({
    happyHomeDir: input.happyHomeDir,
  });
  await mkdir(
    join(input.sourceRootPath, '.happier-plugin'),
    { recursive: true },
  );
  await mkdir(
    join(input.sourceRootPath, 'agent', 'runtime'),
    { recursive: true },
  );
  await writeFile(
    join(input.sourceRootPath, '.happier-plugin', 'plugin.json'),
    JSON.stringify(createPluginManifestV2Fixture({
      id: pluginId,
      ...(input.manifestEngines ? { engines: input.manifestEngines } : {}),
      contributes: {
        agents: [{
          id: localAgentId,
          title: 'Fixture',
          runtime: { kind: 'custom' },
          primary: 'sessions',
          capabilities: {
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        }],
      },
      ...input.manifestOverrides,
    })),
    'utf8',
  );
  await writeFile(
    join(input.sourceRootPath, ...input.modulePath.split('/')),
    input.moduleBytes,
    'utf8',
  );
  for (const [relativePath, contents] of Object.entries(
    input.additionalFiles ?? {},
  )) {
    const path = join(input.sourceRootPath, ...relativePath.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  }
  const generated = await createImmutablePluginGenerationRecordFromSource({
    pluginId,
    sourceRootPath: input.sourceRootPath,
    manifestRelativePath: '.happier-plugin/plugin.json',
    distribution: input.distribution ?? {
      kind: 'localPath',
      canonicalPath: input.sourceRootPath,
    },
    updatePolicy: 'allowed',
    createdAtMs: 1,
  });
  if (generated.sourceCustody?.kind !== 'managed') {
    throw new Error('Expected managed immutable generation fixture custody');
  }
  const record = {
    ...generated,
    immutableGenerationId: input.immutableGenerationId,
    sourceCustody: {
      kind: 'managed' as const,
      immutableGenerationId: input.immutableGenerationId,
      installSource: generated.sourceCustody.installSource,
    },
  };
  const prepared = await prepareImmutablePluginGeneration({
    paths,
    sourceRootPath: input.sourceRootPath,
    record,
  });
  const locator = {
    module: './agent/runtime/factory',
    export: 'createFixtureAgentRuntime',
    runtimeApiVersion: 1 as const,
    ...(input.externalSessionsExport
      ? { externalSessionsExport: input.externalSessionsExport }
      : {}),
  };
  await persistValidatedAgentSessionRunnerFactories({
    paths,
    record,
    manifestAuthority: 'external',
    factories: [{
      localAgentId,
      locator,
      normalizedModulePath: input.modulePath,
      loadMode: input.loadMode,
    }],
  });
  const binding = createAgentSessionRunnerFactoryBinding({
    v: 1,
    pluginId: record.pluginId,
    pluginVersion: '1.0.0',
    agentId: input.agentId ?? localAgentId,
    localAgentId,
    sourceCustody: {
      kind: 'managed',
      immutableGenerationId: record.immutableGenerationId,
      installSource: 'localPath',
    },
    locator,
    normalizedModulePath: input.modulePath,
    loadMode: input.loadMode,
  });
  return { paths, prepared, binding };
}

async function prepareBundledFactory(input: Readonly<{
  happyHomeDir: string;
  sourceRootPath: string;
  moduleBytes: string;
  manifestExport?: string;
  manifestModule?: string;
  manifestOverrides?: Readonly<Record<string, unknown>>;
  additionalFiles?: Readonly<Record<string, string>>;
}>) {
  const pluginId = 'happier.agent.fixture';
  const localAgentId = 'fixture';
  const paths = resolvePluginStorePaths({ happyHomeDir: input.happyHomeDir });
  await mkdir(join(input.sourceRootPath, '.happier-plugin'), {
    recursive: true,
  });
  await mkdir(join(input.sourceRootPath, 'agent', 'runtime'), {
    recursive: true,
  });
  await writeFile(
    join(input.sourceRootPath, '.happier-plugin', 'plugin.json'),
    JSON.stringify(createPluginManifestV2Fixture({
      id: pluginId,
      runtime: {
        apiVersion: 1,
        agentFactories: [{
          localAgentId,
          locator: {
            module: input.manifestModule ?? './agent/runtime/factory',
            export: input.manifestExport ?? 'createFixtureAgentRuntime',
            runtimeApiVersion: 1,
          },
          normalizedModulePath: 'agent/runtime/factory.mjs',
          loadMode: 'immutable-js',
        }],
      },
      contributes: {
        agents: [{
          id: localAgentId,
          title: 'Bundled fixture',
          runtime: { kind: 'custom' },
          primary: 'sessions',
          capabilities: {
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        }],
      },
      ...input.manifestOverrides,
    })),
    'utf8',
  );
  await writeFile(
    join(input.sourceRootPath, 'agent', 'runtime', 'factory.mjs'),
    input.moduleBytes,
    'utf8',
  );
  for (const [relativePath, contents] of Object.entries(input.additionalFiles ?? {})) {
    const path = join(input.sourceRootPath, ...relativePath.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  }
  return {
    paths,
    binding: createAgentSessionRunnerFactoryBinding({
      v: 1,
      pluginId,
      pluginVersion: '1.0.0',
      agentId: localAgentId,
      localAgentId,
      sourceCustody: {
        kind: 'bundled_first_party',
        packagedRuntime: {
          kind: 'pinned_runner_snapshot',
          snapshotId: 'runner-snapshot-a',
        },
      },
      locator: {
        module: './agent/runtime/factory',
        export: 'createFixtureAgentRuntime',
        runtimeApiVersion: 1,
      },
      normalizedModulePath: 'agent/runtime/factory.mjs',
      loadMode: 'immutable-js',
    }),
  };
}

async function prepareDevelopmentFactory(input: Readonly<{
  happyHomeDir: string;
  sourceRootPath: string;
  moduleBytes?: string;
  pluginId?: string;
}>) {
  const pluginId = input.pluginId ?? 'acme.development-runner';
  const localAgentId = 'fixture';
  const paths = resolvePluginStorePaths({ happyHomeDir: input.happyHomeDir });
  await mkdir(join(input.sourceRootPath, '.happier-plugin'), {
    recursive: true,
  });
  await mkdir(join(input.sourceRootPath, 'agent', 'runtime'), {
    recursive: true,
  });
  await writeFile(
    join(input.sourceRootPath, '.happier-plugin', 'plugin.json'),
    JSON.stringify(createPluginManifestV2Fixture({
      id: pluginId,
      contributes: {
        agents: [{
          id: localAgentId,
          title: 'Development fixture',
          runtime: { kind: 'custom' },
          primary: 'sessions',
          capabilities: {
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        }],
      },
    })),
    'utf8',
  );
  await writeFile(
    join(input.sourceRootPath, 'agent', 'runtime', 'factory.mjs'),
    input.moduleBytes
      ?? 'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }',
    'utf8',
  );
  return {
    paths,
    binding: createAgentSessionRunnerFactoryBinding({
      v: 1,
      pluginId,
      pluginVersion: '1.0.0',
      agentId: `${pluginId}/${localAgentId}`,
      localAgentId,
      sourceCustody: {
        kind: 'development',
        registeredRootId: await realpath(input.sourceRootPath),
      },
      locator: {
        module: './agent/runtime/factory',
        export: 'createFixtureAgentRuntime',
        runtimeApiVersion: 1,
      },
      normalizedModulePath: 'agent/runtime/factory.mjs',
      loadMode: 'source-ts',
    }),
  };
}

async function prepareHostDeclarativeBinding(input: Readonly<{
  happyHomeDir: string;
  sourceRootPath: string;
  immutableGenerationId: string;
  agentDefinition: Readonly<Record<string, unknown>>;
  daemonEntry?: boolean;
  competingFactory?: boolean;
}>) {
  const pluginId = 'acme.host-declarative-loader';
  const paths = resolvePluginStorePaths({ happyHomeDir: input.happyHomeDir });
  await mkdir(join(input.sourceRootPath, '.happier-plugin'), {
    recursive: true,
  });
  await writeFile(
    join(input.sourceRootPath, '.happier-plugin', 'plugin.json'),
    JSON.stringify(createPluginManifestV2Fixture({
      id: pluginId,
      entrypoints: input.daemonEntry
        ? { daemon: './daemon.mjs' }
        : undefined,
      contributes: { agents: [input.agentDefinition] },
    })),
    'utf8',
  );
  if (input.daemonEntry) {
    await writeFile(
      join(input.sourceRootPath, 'daemon.mjs'),
      'globalThis.__happier_host_declarative_activation_calls = (globalThis.__happier_host_declarative_activation_calls ?? 0) + 1;\nexport function activate() {}\n',
      'utf8',
    );
  }
  const factoryBytes =
    'globalThis.__happier_host_declarative_factory_module_calls = (globalThis.__happier_host_declarative_factory_module_calls ?? 0) + 1;\nexport function competingFactory() { throw new Error("must not load"); }\n';
  if (input.competingFactory) {
    await writeFile(
      join(input.sourceRootPath, 'runnerFactory.mjs'),
      factoryBytes,
      'utf8',
    );
  }
  const record = await createImmutablePluginGenerationRecordFromSource({
    pluginId,
    sourceRootPath: input.sourceRootPath,
    manifestRelativePath: '.happier-plugin/plugin.json',
    distribution: {
      kind: 'localPath',
      canonicalPath: input.sourceRootPath,
    },
    updatePolicy: 'allowed',
    createdAtMs: 1,
    immutableGenerationId: input.immutableGenerationId,
  });
  const prepared = await prepareImmutablePluginGeneration({
    paths,
    sourceRootPath: input.sourceRootPath,
    record,
  });
  if (input.competingFactory) {
    await persistValidatedAgentSessionRunnerFactories({
      paths,
      record,
      manifestAuthority: 'external',
      factories: [{
        localAgentId: 'fixture',
        locator: {
          module: './runnerFactory',
          export: 'competingFactory',
          runtimeApiVersion: 1,
        },
        normalizedModulePath: 'runnerFactory.mjs',
        loadMode: 'immutable-js',
      }],
    });
  }
  const binding = createHostDeclarativeAcpRunnerBinding({
    kind: 'host_declarative_acp_v1',
    v: 1,
    pluginId,
    pluginVersion: '1.0.0',
    // An installed Agent's routing id is qualified by its owning plugin, so
    // this is the literal id the contribution projection assigns and the
    // generation attestation re-derives. Only `localAgentId` stays manifest-local.
    agentId: 'acme.host-declarative-loader/fixture',
    qualifiedAgentId: `${pluginId}/agents/fixture`,
    localAgentId: 'fixture',
    sourceCustody: {
      kind: 'managed',
      immutableGenerationId: record.immutableGenerationId,
      installSource: 'localPath',
    },
  });
  return { paths, prepared, binding };
}

describe('loadRetainedAgentRuntimeLeaf', () => {
  it('starts the retained Session factory with zero source checks after activation', async () => {
    const tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'happier-retained-no-rechecks-')));
    const activationKey = `__happier_retained_activation_${tempRoot.replace(/[^a-z0-9]/giu, '_')}`;
    const activationObservers = globalThis as typeof globalThis & Record<string, (() => void) | undefined>;
    let leaf: Awaited<ReturnType<typeof loadRetainedAgentRuntimeLeaf>> | undefined;
    let contextFixture: ReturnType<typeof createAcpSessionRuntimeContextFixture> | undefined;
    const agent = { id: 'fixture', title: 'Fixture', runtime: { kind: 'custom' }, primary: 'sessions',
      catalog: { vendorResume: { support: 'experimental' } },
      capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
    } satisfies AgentContribution;
    try {
      const fixture = await prepareBundledFactory({
        happyHomeDir: join(tempRoot, 'home'), sourceRootPath: join(tempRoot, 'source'),
        moduleBytes: [
          'export function createFixtureAgentRuntime() { return { sessions: { open() { return { retainedSession: true }; } } }; }',
          'export function anotherFactory(...args) { return createFixtureAgentRuntime(...args); }',
        ].join('\n'),
        manifestOverrides: { contributes: { agents: [agent] } },
        additionalFiles: { 'daemon.mjs': [
          'import { anotherFactory } from "./agent/runtime/factory.mjs";',
          'export function activate(api) {',
          '  api.agents.register("fixture", anotherFactory, {',
          '    sessionRunnerFactory: { module: "./agent/runtime/factory", export: "anotherFactory", runtimeApiVersion: 1 },',
          '    vendorResumeSupport: { supportsVendorResume: () => true },',
          '  });',
          `  globalThis[${JSON.stringify(activationKey)}]();`,
          '}',
        ].join('\n') },
      });
      // This filesystem boundary selects the retained root; activation and
      // all module loading and Agent registration remain real.
      let presenceReads = 0;
      let readsAtActivation: number | undefined;
      activationObservers[activationKey] = () => { readsAtActivation = presenceReads; };
      leaf = await loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths, binding: fixture.binding,
        resolveBundledPluginRoot: async () => {
          presenceReads++;
          return { rootPath: join(tempRoot, 'source'), cacheIdentity: 'pinned_runner_snapshot:runner-snapshot-a' };
        },
      });
      expect(presenceReads).toBe(1);
      expect(readsAtActivation).toBe(1);
      const signal = new AbortController().signal;
      const plugin = { id: 'acme.fixture', version: '1.0.0' };
      const services = createUnavailablePluginServices();
      contextFixture = createAcpSessionRuntimeContextFixture({ agent, pluginId: plugin.id,
        sessionId: 'retained-session', directory: tempRoot, signal, services,
        protocols: createPublicAcpRuntimeProtocols({ pluginId: plugin.id, agentId: agent.id,
          signal, isCurrent: () => !signal.aborted, services }) });
      const runtime = await leaf.factory({ plugin, agent: { id: agent.id }, signal });
      if (!runtime.sessions) throw new Error('Retained Agent did not provide Sessions');
      expect(await runtime.sessions.open({ kind: 'create', sessionId: 'retained-session', cwd: tempRoot },
        contextFixture.context)).toMatchObject({ retainedSession: true });
      expect(presenceReads - readsAtActivation!).toBe(0);
    } finally {
      delete activationObservers[activationKey];
      await contextFixture?.dispose();
      await leaf?.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('refuses a removed retained generation before importing or starting its Session factory', async () => {
    const tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'happier-retained-removed-')));
    const effectPath = join(tempRoot, 'factory-effects.log');
    try {
      const fixture = await prepareRetainedFactory({
        happyHomeDir: join(tempRoot, 'home'), sourceRootPath: join(tempRoot, 'source'),
        immutableGenerationId: 'retained-removed', modulePath: 'agent/runtime/factory.mjs',
        agentId: 'acme.runner-loader/fixture', loadMode: 'immutable-js',
        moduleBytes: [
          'import { appendFileSync } from "node:fs";',
          `appendFileSync(${JSON.stringify(effectPath)}, "imported\\n");`,
          `export function createFixtureAgentRuntime() { appendFileSync(${JSON.stringify(effectPath)}, "started\\n"); return { sessions: {} }; }`,
        ].join('\n'),
      });
      await rm(fixture.prepared.rootPath, { recursive: true });
      await expect(loadRetainedAgentRuntimeLeaf({ paths: fixture.paths, binding: fixture.binding }))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(effectPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([true, false])('retains runtime input capacity without Connected Accounts or native model discovery (declared=%s)', async declared => {
    const tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'happier-retained-input-capacity-')));
    let leaf: Awaited<ReturnType<typeof loadRetainedAgentRuntimeLeaf>> | undefined;
    try {
      const activationPath = join(tempRoot, 'capacity-activation.log');
      const fixture = await prepareRetainedFactory({
        happyHomeDir: join(tempRoot, 'home'), sourceRootPath: join(tempRoot, 'source'),
        immutableGenerationId: 'retained-input-capacity', modulePath: 'agent/runtime/factory.mjs',
        agentId: 'acme.runner-loader/fixture', loadMode: 'immutable-js',
        moduleBytes: 'export function createFixtureAgentRuntime() { return { sessions: {} }; }',
        additionalFiles: { 'daemon.mjs': [
          'import { appendFileSync } from "node:fs";',
          'import { createFixtureAgentRuntime } from "./agent/runtime/factory.mjs";',
          `export function activate(api) { appendFileSync(${JSON.stringify(activationPath)}, "activated\\n"); api.agents.register("fixture", createFixtureAgentRuntime, {`,
          '  sessionRunnerFactory: { module: "./agent/runtime/factory", export: "createFixtureAgentRuntime", runtimeApiVersion: 1 },',
          ...(declared ? ['  preflightSessionControls: {',
            '    resolveMaxInputUnicodeCharacters: input => input.runtimeDescriptorV1?.agent.backendMode === "acp" ? null : 8192,',
            '    probeModels: () => { throw new Error("Capacity must not probe native models"); },',
            '  },'] : []),
          '}); }',
        ].join('\n') },
      });
      leaf = await loadRetainedAgentRuntimeLeaf({ paths: fixture.paths, binding: fixture.binding });
      await expect(readFile(activationPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const readCapacity = (backendMode: 'appServer' | 'acp') => readAgentRuntimeMaxInputUnicodeCharacters({
        agentId: 'acme.runner-loader/fixture', catalogEntry: leaf!.catalogEntry,
        runtimeDescriptorV1: { v: 1, agentId: 'acme.runner-loader/fixture', agent: { backendMode } },
      });
      await expect(readCapacity('appServer')).resolves.toBe(declared ? 8192 : null);
      await expect(readCapacity('acp')).resolves.toBeNull();
      expect(await readFile(activationPath, 'utf8')).toBe('activated\n');
      await leaf.dispose();
      await expect(readCapacity('appServer')).resolves.toBeNull();
    } finally {
      await leaf?.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
  it('rejects another bundled plugin root inside the retained source repository', async () => {
    const cliRoot = await realpath(join(import.meta.dirname, '../../../..'));
    const siblingRoot = await realpath(join(cliRoot, '../../packages/plugins/codex'));
    await expect(attestRetainedPluginSource({
      paths: resolvePluginStorePaths({ happyHomeDir: join(tmpdir(), 'happier-retained-root-refusal') }),
      pluginId: 'happier.agent.claude', custody: { kind: 'development', registeredRootId: siblingRoot },
      manifestAuthority: 'bundled_first_party', runnerSnapshotIdentity: `path:${cliRoot}`,
    })).rejects.toThrow('does not belong to the runner');
  });

  it.each([
    { kind: 'account_release', pluginId: 'acme.runner-loader', version: '1.0.0', archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
    { kind: 'bundled_first_party', packagedRuntime: { kind: 'source_declaration', packageName: '@acme/runner-loader' } },
  ])('refuses portable custody at the retained Agent load boundary: $kind', async (sourceCustody) => {
    await expect(loadRetainedAgentRuntimeLeaf({
      paths: resolvePluginStorePaths({ happyHomeDir: join(tmpdir(), 'happier-portable-no-machine-root') }),
      binding: { kind: 'host_declarative_acp_v1', v: 1, pluginId: 'acme.runner-loader', pluginVersion: '1.0.0',
        agentId: 'acme.runner-loader/fixture', qualifiedAgentId: 'acme.runner-loader/agents/fixture', localAgentId: 'fixture', sourceCustody },
    })).rejects.toThrow('Machine executable source');
  });

  it('retains experimental resume without Connected Accounts and retires its predicate with the leaf', async () => {
    const tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'happier-retained-resume-')));
    let leaf: Awaited<ReturnType<typeof loadRetainedAgentRuntimeLeaf>> | undefined;
    try {
      const fixture = await prepareRetainedFactory({
        happyHomeDir: join(tempRoot, 'home'), sourceRootPath: join(tempRoot, 'source'),
        immutableGenerationId: 'retained-resume', modulePath: 'agent/runtime/factory.mjs',
        agentId: 'acme.runner-loader/fixture', loadMode: 'immutable-js',
        moduleBytes: 'export function createFixtureAgentRuntime() { return { sessions: {} }; }',
        manifestOverrides: { contributes: { agents: [{
          id: 'fixture', title: 'Fixture', runtime: { kind: 'custom' }, primary: 'sessions',
          catalog: { vendorResume: { support: 'experimental' } },
          capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
        }] } },
        additionalFiles: { 'daemon.mjs': [
          'import { createFixtureAgentRuntime } from "./agent/runtime/factory.mjs";',
          'export function activate(api) { api.agents.register("fixture", createFixtureAgentRuntime, {',
          '  sessionRunnerFactory: { module: "./agent/runtime/factory", export: "createFixtureAgentRuntime", runtimeApiVersion: 1 },',
          '  vendorResumeSupport: { supportsVendorResume: input => input.runtimeDescriptorV1?.agent.backendMode === "resumable" },',
          '}); }',
        ].join('\n') },
      });
      leaf = await loadRetainedAgentRuntimeLeaf({ paths: fixture.paths, binding: fixture.binding });
      const supportsResume = await leaf.catalogEntry?.getVendorResumeSupport?.();
      expect(supportsResume?.({ runtimeDescriptorV1: {
        v: 1, agentId: 'acme.runner-loader/fixture', agent: { backendMode: 'resumable' },
      } })).toBe(true);
      expect(supportsResume?.({})).toBe(false);
      await leaf.dispose();
      expect(supportsResume?.({ runtimeDescriptorV1: {
        v: 1, agentId: 'acme.runner-loader/fixture', agent: { backendMode: 'resumable' },
      } })).toBe(false);
    } finally {
      await leaf?.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('retains executable Connected Account launch facts from its own module generation', async () => {
    const tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'happier-retained-native-home-')));
    try {
      const home = {
        environmentKey: 'FIXTURE_HOME', defaultRelativePath: '.fixture', materializedDirectoryName: 'retained-home',
      };
      const launchUses = {
        requestAuthUses: [{ purpose: 'model_upstream', materialization: {
          kind: 'httpHeaders', origin: 'https://retained.example.test', headerNames: ['authorization'],
        } }],
        fileEnvironmentUses: [{ purpose: 'model_upstream', fileId: 'credentials', environmentKey: 'FIXTURE_CREDENTIALS' }],
        environmentUses: [{ purpose: 'model_upstream', environmentKey: 'FIXTURE_TOKEN' }],
        environmentUnsetUses: [{ purpose: 'model_upstream', environmentKey: 'FIXTURE_AMBIENT_TOKEN' }],
      };
      const fixture = await prepareRetainedFactory({
        happyHomeDir: join(tempRoot, 'home'), sourceRootPath: join(tempRoot, 'source'),
        immutableGenerationId: 'retained-native-home', modulePath: 'agent/runtime/factory.mjs',
        agentId: 'acme.runner-loader/fixture',
        loadMode: 'immutable-js',
        moduleBytes: 'let active = false; export function setActive(value) { active = value; } export function createFixtureAgentRuntime() { return { sessions: {}, retainedCatalogActive: active }; }',
        manifestOverrides: {
          hostAccess: { required: [{ id: 'fixture-env', capability: 'environment',
            reason: 'Read the declared native home and launch environment.',
            scope: { keys: ['FIXTURE_HOME', 'FIXTURE_CREDENTIALS', 'FIXTURE_TOKEN', 'FIXTURE_AMBIENT_TOKEN'] } }], optional: [] },
          contributes: {
            agents: [{ id: 'fixture', title: 'Fixture', runtime: { kind: 'custom' }, primary: 'sessions',
              capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
              connectedAccounts: [{ service: 'login', purpose: 'model_upstream', required: false,
                credentialKinds: ['token'], materializationKinds: ['environment'] }],
            }],
            connectedAccountDescriptors: [{ id: 'login', title: 'Login', authentication: {
              defaultModeId: 'token', modes: [{ id: 'token', title: 'Token', kind: 'manual',
                outcomeReconciliation: 'none', fields: [{ id: 'token', title: 'Token', secret: true,
                  schema: { type: 'string', minLength: 1 } }],
              }],
            } }],
          },
        },
        additionalFiles: {
          'daemon.mjs': [
            'import { createFixtureAgentRuntime, setActive } from "./agent/runtime/factory.mjs";',
            'export function activate(api) {',
            '  setActive(true);',
            '  const unused = async () => { throw new Error("Authentication is outside this fixture"); };',
            '  api.connectedAccounts.register("login", { refresh: unused, revoke: unused, status: unused, materialize: unused,',
            '    authentication: { modes: { token: { kind: "manual", complete: unused } } } });',
            '  api.agents.register("fixture", createFixtureAgentRuntime, {',
            '    sessionRunnerFactory: { module: "./agent/runtime/factory", export: "createFixtureAgentRuntime", runtimeApiVersion: 1 },',
            `    connectedAccountLaunch: { ...${JSON.stringify(launchUses)}, stateSharingDescriptor: {`,
            '      providerSupportStatus: "supported",',
            '      config: { supported: true, modes: ["isolated"], entries: [] },',
            '      state: { supported: true, modes: ["isolated"], entries: [], symlinkUnavailableDegradePolicy: "block_continuity" },',
            '      authIsolation: { mode: "materialized_home", secretEntries: ["auth.json"] },',
            `      nativeHome: ${JSON.stringify(home)},`,
            '    } },',
            '  });',
            '  return () => setActive(false);',
            '}',
          ].join('\n'),
        },
      });
      const leaf = await loadRetainedAgentRuntimeLeaf({ paths: fixture.paths, binding: fixture.binding });
      expect(await leaf.factory({} as never)).toMatchObject({ retainedCatalogActive: false });
      expect(leaf.catalogEntry?.connectedAccountNativeHome).toBeUndefined();
      expect(await leaf.resolveConnectedAccountLaunchCatalogEntry?.()).toMatchObject({
        id: 'acme.runner-loader/fixture', connectedAccountNativeHome: home,
        connectedAccountRequestAuthUses: launchUses.requestAuthUses,
        connectedAccountFileEnvironmentUses: launchUses.fileEnvironmentUses,
        connectedAccountEnvironmentUses: launchUses.environmentUses,
        connectedAccountEnvironmentUnsetUses: launchUses.environmentUnsetUses,
      });
      expect(await leaf.factory({} as never)).toMatchObject({ retainedCatalogActive: true });
      const nativeHomeRoot = join(tempRoot, 'native-home');
      await mkdir(nativeHomeRoot);
      await writeFile(join(nativeHomeRoot, 'auth.json'), '{"fixture":"retained-auth"}');
      const agent = projectManifestAgentContribution({
        definition: { id: 'fixture', title: 'Fixture', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
        provenance: 'external', source: { kind: 'package' }, pluginId: 'acme.runner-loader',
      });
      const nativeHome = await resolveNativeAgentSessionNativeHomeService({
        agent: { ...agent, catalogEntry: leaf.catalogEntry },
        sourceEnvironment: { FIXTURE_HOME: nativeHomeRoot },
      });
      expect(nativeHome).not.toBeNull();
      expect(new TextDecoder().decode((await nativeHome!.readFiles(['auth.json']))['auth.json']))
        .toBe('{"fixture":"retained-auth"}');
      await expect(nativeHome!.readFiles(['undeclared.json'])).rejects.toThrow(
        'connected_service_native_home_credential_file_undeclared',
      );
      await leaf.dispose();
      expect(await leaf.factory({} as never)).toMatchObject({ retainedCatalogActive: false });
      await expect(leaf.resolveConnectedAccountLaunchCatalogEntry?.()).resolves.toBeNull();
      await expect(leaf.catalogEntry?.getConnectedServiceStateSharingDescriptor?.()).resolves.toBeNull();
      await expect(loadRetainedAgentRuntimeLeaf({ paths: fixture.paths,
        binding: { ...fixture.binding, sourceCustody: { ...fixture.binding.sourceCustody,
          kind: 'managed', immutableGenerationId: 'foreign-generation', installSource: 'localPath' } },
      })).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('attests an older pinned runner snapshot after daemon reload and rejects changed custody or unknown source', async () => {
    const tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'happier-retained-older-runner-')));
    const snapshotsDir = join(tempRoot, '.runner-snapshots');
    const stagingRoot = join(snapshotsDir, '.staging');
    const packageRoot = join(stagingRoot, 'node_modules', '@happier-dev', 'plugins-antigravity');
    const pluginFile = join(packageRoot, 'agent.mjs');
    try {
      await mkdir(join(stagingRoot, 'package-dist'), { recursive: true });
      await mkdir(packageRoot, { recursive: true });
      await writeFile(pluginFile, 'export const marker = "original";\n', 'utf8');
      await mkdir(join(packageRoot, '.happier-plugin'), { recursive: true });
      await writeFile(join(packageRoot, '.happier-plugin', 'plugin.json'), '{"contributes":{"resources":[]}}\n', 'utf8');
      const packageNames = ['@happier-dev/plugins-antigravity'];
      const workspaceRuntimeIdentity = readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot({
        runtimeRoot: stagingRoot,
        packageNames,
      }).fingerprint;
      const snapshot = publishPinnedRunnerSnapshotFixture({
        stagingRoot,
        workspaceRuntimeIdentity,
        workspaceRuntimePackages: packageNames,
      });
      const snapshotId = snapshot.snapshotIdentity;
      const oldRoot = snapshot.snapshotRoot;
      expect(explainPinnedRunnerSnapshotUnreadiness(snapshot)).toBeNull();
      const { snapshotRoot: currentRoot } = publishPinnedRunnerSnapshotFixture({
        stagingRoot: join(snapshotsDir, '.current-staging'),
        workspaceRuntimeIdentity: 'd'.repeat(64),
      });
      const unknownSnapshot = publishPinnedRunnerSnapshotFixture({
        stagingRoot: join(snapshotsDir, '.unknown-staging'),
        workspaceRuntimeIdentity: 'c'.repeat(64),
      });
      await rm(unknownSnapshot.snapshotRoot, { recursive: true });
      const input = {
        pluginId: 'happier.agent.antigravity',
        custody: { kind: 'bundled_first_party' as const, packagedRuntime: { kind: 'pinned_runner_snapshot' as const, snapshotId } },
        moduleUrl: pathToFileURL(join(currentRoot, 'package-dist', 'chunk.js')).href,
      };
      await expect(resolveRetainedBundledPluginRoot(input)).resolves.toMatchObject({
        rootPath: join(oldRoot, 'node_modules', '@happier-dev', 'plugins-antigravity'),
      });
      await expect(resolveRetainedBundledPluginRoot({
        ...input,
        moduleUrl: pathToFileURL(join(oldRoot, 'package-dist', 'index.mjs')).href,
      })).resolves.toMatchObject({
        rootPath: join(oldRoot, 'node_modules', '@happier-dev', 'plugins-antigravity'),
      });
      await writeFile(join(oldRoot, '.workspace-runtime-identity'), `${'a'.repeat(64)}\n`, 'utf8');
      await expect(resolveRetainedBundledPluginRoot(input)).rejects.toThrow();
      await writeFile(join(oldRoot, '.workspace-runtime-identity'), `${workspaceRuntimeIdentity}\n`, 'utf8');
      const movedPackageRoot = join(tempRoot, 'moved-plugin');
      await rename(join(oldRoot, 'node_modules', '@happier-dev', 'plugins-antigravity'), movedPackageRoot);
      await symlink(movedPackageRoot, join(oldRoot, 'node_modules', '@happier-dev', 'plugins-antigravity'), 'dir');
      await expect(resolveRetainedBundledPluginRoot(input)).rejects.toThrow();
      await expect(resolveRetainedBundledPluginRoot({
        ...input,
        custody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'pinned_runner_snapshot', snapshotId: unknownSnapshot.snapshotIdentity } },
      })).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('resolves a retained CLI version root after the daemon current alias advances', async () => {
    const homeDir = await realpath(await mkdtemp(join(tmpdir(), 'happier-retained-version-root-')));
    const processEnv = { ...process.env, HAPPIER_HOME_DIR: homeDir };
    const layout = resolveFirstPartyInstallLayout({
      componentId: 'happier-cli',
      channel: 'publicdev',
      processEnv,
    });
    const packageSegments = ['node_modules', '@happier-dev', 'plugins-antigravity'];
    const versionARoot = join(layout.versionsDir, 'version-a');
    const versionBRoot = join(layout.versionsDir, 'version-b');
    const custody = {
      kind: 'bundled_first_party' as const,
      packagedRuntime: {
        kind: 'cli_version_root' as const,
        versionRootId: 'version-a',
      },
    };
    try {
      await mkdir(join(versionARoot, ...packageSegments), { recursive: true });
      await mkdir(join(versionBRoot, ...packageSegments), { recursive: true });
      await writeFile(join(layout.installRoot, 'current.version'), 'version-a\n', 'utf8');

      await expect(resolveRetainedBundledPluginRoot({
        pluginId: 'happier.agent.antigravity',
        custody,
        moduleUrl: pathToFileURL(join(layout.currentPath, 'package-dist', 'chunk.js')).href,
        processEnv,
      })).resolves.toMatchObject({
        rootPath: join(versionARoot, ...packageSegments),
        cacheIdentity: 'cli_version_root:version-a',
      });

      await writeFile(join(layout.installRoot, 'current.version'), 'version-b\n', 'utf8');
      await expect(resolveRetainedBundledPluginRoot({
        pluginId: 'happier.agent.antigravity',
        custody,
        moduleUrl: pathToFileURL(join(layout.currentPath, 'package-dist', 'chunk.js')).href,
        processEnv,
      })).resolves.toMatchObject({
        rootPath: join(versionARoot, ...packageSegments),
        cacheIdentity: 'cli_version_root:version-a',
      });

      await expect(resolveRetainedBundledPluginRoot({
        pluginId: 'happier.agent.antigravity',
        custody,
        moduleUrl: pathToFileURL(join(versionARoot, 'package-dist', 'chunk.js')).href,
        processEnv,
      })).resolves.toMatchObject({
        rootPath: join(versionARoot, ...packageSegments),
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('opens a daemon-attested current development Agent factory without a copied generation', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-runner-development-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-runner-development-source-'),
    );
    try {
      const fixture = await prepareDevelopmentFactory({
        happyHomeDir,
        sourceRootPath,
      });

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
        developmentOccurrenceId: 'occurrence:development-runner:1',
      })).resolves.toEqual({ factory: expect.any(Function), catalogEntry: expect.any(Object), dispose: expect.any(Function) });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('attests the real source-mode Claude declaration with the daemon bootstrap provenance and routing identity', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runner-first-party-source-'));
    let serviceOwner: Awaited<ReturnType<typeof createRunnerManagedServiceInvocationOwner>> | null = null;
    try {
      const contributes = resolveBuiltInContributions();
      const agent = contributes.agents.find((entry) => entry.pluginId === 'happier.agent.claude');
      if (!agent?.identity || !agent.richDefinition || !agent.daemonEntryPath) {
        throw new Error('Real Claude bootstrap declaration is unavailable');
      }
      const resolver = createBundledActivationSourceResolver({
        bundledPackageNames: [agent.daemonEntryPath],
        resolveDevelopmentSourceAuthority: ({ rootPath }) => {
          const authority = bindPluginRuntimeSourceAuthority({
            custody: { kind: 'development', registeredRootId: rootPath },
            resolvedRoot: rootPath,
            observedRevision: 0,
          });
          return authority.kind === 'development' ? authority : null;
        },
      });
      const source = resolver({ pluginId: agent.identity.pluginId, daemonEntryPath: agent.daemonEntryPath });
      if (source?.sourceAuthority?.kind !== 'development') {
        throw new Error('Real Claude source-mode producer did not admit a development root');
      }
      const binding = createAgentSessionRunnerFactoryBinding({
        v: 1,
        pluginId: agent.identity.pluginId,
        pluginVersion: '0.0.0',
        agentId: agent.id,
        localAgentId: agent.identity.localId,
        sourceCustody: { kind: 'development', registeredRootId: source.sourceAuthority.registeredRootId },
        locator: { module: './agent/runtime/factory', export: 'createClaudeAgentRuntime', runtimeApiVersion: 1,
          externalSessionsExport: 'claudeExternalSessionsContribution' },
        normalizedModulePath: 'src/agent/runtime/factory.ts',
        loadMode: 'source-ts',
      });
      const attested = await verifyRunnerAgentBindingAgainstGeneration({
        paths: resolvePluginStorePaths({ happyHomeDir }),
        binding,
        developmentOccurrenceId: 'occurrence:real-source-claude',
      });
      const claim = projectManifestAgentContribution({
        pluginId: binding.pluginId,
        definition: attested.declaredAgent,
        provenance: attested.manifestAuthority === 'bundled_first_party' ? 'first_party' : 'external',
        source: agent.source,
      });
      expect(claim.provenance).toBe(agent.provenance);
      expect(claim.id).toBe(agent.id);
      expect(claim.richDefinition?.definition).toEqual(agent.richDefinition.definition);
      serviceOwner = await createRunnerManagedServiceInvocationOwner({
        paths: resolvePluginStorePaths({ happyHomeDir }),
        retainedAgent: binding,
        developmentOccurrenceId: 'occurrence:real-source-claude',
        authority: {
          happyHomeDir, publicReleaseRing: 'stable', path: join(happyHomeDir, 'authority.json'),
          sessionId: 'session-source-claude',
          runner: { pid: 1, processStartTimeMs: 1, processCommandHash: 'a'.repeat(64),
            snapshotIdentity: 'source:claude-bootstrap' },
          retainedAgent: binding,
        },
      });
      expect(serviceOwner.verifiedAgentDeclaration).toEqual({
        provenance: agent.provenance,
        definition: agent.richDefinition.definition,
      });
      const sdkBarrelImports: string[] = [];
      const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
          const result = nextResolve(specifier, context);
          if (result.url.endsWith('/packages/plugin-sdk/dist/index.js')) sdkBarrelImports.push(result.url);
          return result;
        },
      });
      try {
        await loadVerifiedPluginModule({
          entryPath: join(attested.rootPath, 'src', 'agent', 'runtime', 'factory.ts'),
          loadMode: 'source-ts',
          generationScope: binding,
          cacheKey: `${attested.cacheIdentity}:src/agent/runtime/factory.ts`,
          nativeFileUrlMode: 'canonical',
        });
        expect(sdkBarrelImports).toEqual([]);
      } finally {
        hooks.deregister();
      }
      // The production source loader shares Node's module cache. Constructing a native
      // Session runtime does not need Claude's historical transcript or accounting readers.
      const leaf = await loadRetainedAgentRuntimeLeaf({
        paths: resolvePluginStorePaths({ happyHomeDir }),
        binding,
        developmentOccurrenceId: 'occurrence:real-source-claude',
      });
      try {
        const runtime = await leaf.factory({
          plugin: { id: binding.pluginId, version: binding.pluginVersion },
          agent: { id: binding.localAgentId },
          signal: new AbortController().signal,
        });
        expect(runtime.sessions?.open).toBeTypeOf('function');
        expect(leaf.externalSessions?.readAfterTranscript).toBeTypeOf('function');
        const cache = createRequire(import.meta.url).cache;
        const root = source.sourceAuthority.registeredRootId;
        const historyReaders = [
          'src/agent/surfaces/sessions/external/candidates.ts',
          'src/agent/surfaces/sessions/external/transcript.ts',
          'src/agent/usage/nativeAccounting.ts',
        ];
        expect(historyReaders.filter(reader => cache[join(root, ...reader.split('/'))])).toEqual([]);
      } finally {
        await leaf.dispose();
      }
    } finally {
      await serviceOwner?.owners.dispose();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('does not grant first-party provenance to a different development root using a bundled plugin id', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runner-spoof-home-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-runner-spoof-source-'));
    try {
      const fixture = await prepareDevelopmentFactory({ happyHomeDir, sourceRootPath, pluginId: 'happier.agent.claude' });
      const attested = await verifyRunnerAgentBindingAgainstGeneration({
        ...fixture,
        developmentOccurrenceId: 'occurrence:external-development',
      });
      expect(attested.manifestAuthority).toBe('external');
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('fails closed when the daemon-attested development root no longer exists', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-runner-development-missing-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-runner-development-missing-source-'),
    );
    try {
      const fixture = await prepareDevelopmentFactory({
        happyHomeDir,
        sourceRootPath,
      });
      await rm(sourceRootPath, { recursive: true, force: true });

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
        developmentOccurrenceId: 'occurrence:development-runner:missing',
      })).rejects.toThrow();
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('rejects a development binding without the daemon current-occurrence attestation', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-runner-development-unattested-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-runner-development-unattested-source-'),
    );
    try {
      const fixture = await prepareDevelopmentFactory({
        happyHomeDir,
        sourceRootPath,
      });

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).rejects.toThrow(/daemon-attested current occurrence/iu);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('opens current development source after restart instead of retaining historical bytes', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-runner-development-restart-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-runner-development-restart-source-'),
    );
    try {
      const fixture = await prepareDevelopmentFactory({
        happyHomeDir,
        sourceRootPath,
        moduleBytes:
          'export function createFixtureAgentRuntime() { return { sourceVersion: "before" }; }',
      });
      await writeFile(
        join(sourceRootPath, 'agent', 'runtime', 'factory.mjs'),
        'export function createFixtureAgentRuntime() { return { sourceVersion: "after" }; }',
        'utf8',
      );
      const after = await loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: createAgentSessionRunnerFactoryBinding({
          ...fixture.binding,
          locator: { ...fixture.binding.locator },
        }),
        developmentOccurrenceId: 'occurrence:development-runner:after',
      });

      expect(await after.factory({} as never)).toMatchObject({
        sourceVersion: 'after',
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('loads the retained factory and External Sessions companion from one module namespace without a grant or digest input', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-runner-companion-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-runner-companion-source-'),
    );
    const counterKey = `__happier_runner_companion_${sourceRootPath.replace(/[^a-z0-9]/giu, '_')}`;
    const counters = globalThis as typeof globalThis & Record<string, number | undefined>;
    try {
      const moduleBytes = [
        `const key = ${JSON.stringify(counterKey)};`,
        'globalThis[key] = (globalThis[key] ?? 0) + 1;',
        'export function createFixtureAgentRuntime() {',
        '  return { sessions: { open() { throw new Error("unused"); } } };',
        '}',
        'export const externalSessions = {',
        '  async resolveSource({ source }) { return { ok: true, value: { source } }; },',
        '  async listCandidates() { return { ok: true, value: { candidates: [], nextCursor: null } }; },',
        '  async resolveLinkIdentity({ source, remoteSessionId }) { return { ok: true, value: { source, remoteSessionId, linkData: {} } }; },',
        '  async resolveLinkedIdentity({ source, remoteSessionId, linkData }) { return { ok: true, value: { source, remoteSessionId, linkData } }; },',
        '  async pageTranscript() { return { ok: true, value: { items: [], nextCursor: null } }; },',
        '  async readAfterTranscript() { return { ok: true, value: { outcome: "already_current" } }; },',
        '  ownHelper() { return "trusted helper"; },',
        '};',
        '',
      ].join('\n');
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-runner-companion',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes,
        loadMode: 'immutable-js',
        externalSessionsExport: 'externalSessions',
      });
      const moduleNamespace = await import(pathToFileURL(join(
        fixture.prepared.rootPath,
        'agent/runtime/factory.mjs',
      )).href) as Readonly<Record<string, unknown>>;

      const leaf = await loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      });

      expect(leaf).toMatchObject({
        factory: expect.any(Function),
        externalSessions: expect.any(Object),
      });
      expect(leaf.externalSessions).toBe(moduleNamespace.externalSessions);
      expect(await leaf.externalSessions?.readAfterTranscript({} as never))
        .toEqual({ ok: true, value: { outcome: 'already_current' } });
      expect(counters[counterKey]).toBe(1);
    } finally {
      delete counters[counterKey];
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('rejects an incompatible local-source manifest at initial retained generation admission', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-runner-local-source-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-runner-local-source-source-'),
    );
    try {
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-runner-local-source',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes:
          'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }',
        loadMode: 'immutable-js',
        manifestEngines: { happier: '^99.0.0' },
      });

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).rejects.toThrow('Retained plugin immutable declaration source mismatch');
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('returns a factory-only leaf when the authenticated locator has no companion', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-runner-factory-only-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-runner-factory-only-source-'),
    );
    try {
      const moduleBytes =
        'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }';
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-runner-factory-only',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes,
        loadMode: 'immutable-js',
      });

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).resolves.toEqual({ factory: expect.any(Function), catalogEntry: expect.any(Object), dispose: expect.any(Function) });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('rejects a missing authenticated companion export after one module load', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-runner-missing-companion-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-runner-missing-companion-source-'),
    );
    try {
      const moduleBytes =
        'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }';
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-runner-missing-companion',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes,
        loadMode: 'immutable-js',
        externalSessionsExport: 'externalSessions',
      });

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).rejects.toThrow(/External Sessions companion export is missing/iu);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('keeps host declarative ACP factory-only with no companion authority', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-host-declarative-leaf-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-host-declarative-leaf-source-'),
    );
    try {
      const fixture = await prepareHostDeclarativeBinding({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-host-declarative-leaf',
        agentDefinition: {
          id: 'fixture',
          title: 'Fixture',
          runtime: {
            kind: 'acp',
            transport: { kind: 'tcp', host: '127.0.0.1', port: 4242 },
          },
          primary: 'sessions',
          capabilities: {
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        },
      });

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).resolves.toEqual({ factory: expect.any(Function), catalogEntry: expect.any(Object), dispose: expect.any(Function) });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });
  it('rejects a host declarative ACP binding for a substituted canonical Agent id', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-host-declarative-identity-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-host-declarative-identity-source-'),
    );
    const counters = globalThis as typeof globalThis & {
      __happier_host_declarative_activation_calls?: number;
      __happier_host_declarative_factory_module_calls?: number;
    };
    try {
      const fixture = await prepareHostDeclarativeBinding({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-host-declarative-identity',
        agentDefinition: {
          id: 'fixture',
          title: 'Fixture',
          runtime: {
            kind: 'acp',
            transport: {
              kind: 'tcp',
              host: '127.0.0.1',
              port: 4242,
            },
          },
          primary: 'sessions',
          capabilities: {
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        },
        daemonEntry: true,
      });
      const originalBinding = fixture.binding;
      if (!('kind' in originalBinding)) {
        throw new Error('Expected a host declarative ACP binding');
      }
      const substitutedBinding = createHostDeclarativeAcpRunnerBinding({
        kind: 'host_declarative_acp_v1',
        v: 1,
        pluginId: originalBinding.pluginId,
        pluginVersion: originalBinding.pluginVersion,
        agentId: 'substituted-agent',
        qualifiedAgentId: originalBinding.qualifiedAgentId,
        localAgentId: originalBinding.localAgentId,
        sourceCustody: originalBinding.sourceCustody,
      });

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: substitutedBinding,
      })).rejects.toThrow(/not generation-attested/iu);
      expect(counters.__happier_host_declarative_activation_calls)
        .toBeUndefined();
      expect(counters.__happier_host_declarative_factory_module_calls)
        .toBeUndefined();
    } finally {
      delete counters.__happier_host_declarative_activation_calls;
      delete counters.__happier_host_declarative_factory_module_calls;
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it.each([
    ['a custom runtime kind', {
      id: 'fixture',
      title: 'Fixture',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create'],
          delivery: ['newTurn'],
          cancel: true,
        },
      },
    }],
    ['a non-Session Agent', {
      id: 'fixture',
      title: 'Fixture',
      runtime: { kind: 'custom' },
      primary: 'executionRuns',
      capabilities: {
        executionRuns: {
          open: ['create'],
          checkpoint: true,
          stop: true,
        },
      },
    }],
  ] as const)(
    'rejects a host declarative ACP binding for %s before activation or module load',
    async (label, agentDefinition) => {
      const happyHomeDir = await mkdtemp(
        join(tmpdir(), 'happier-host-declarative-negative-home-'),
      );
      const sourceRootPath = await mkdtemp(
        join(tmpdir(), 'happier-host-declarative-negative-source-'),
      );
      const counters = globalThis as typeof globalThis & {
        __happier_host_declarative_activation_calls?: number;
        __happier_host_declarative_factory_module_calls?: number;
      };
      try {
        const fixture = await prepareHostDeclarativeBinding({
          happyHomeDir,
          sourceRootPath,
          immutableGenerationId:
            `generation-host-declarative-${label.replaceAll(' ', '-')}`,
          agentDefinition,
          daemonEntry: true,
        });

        await expect(loadRetainedAgentRuntimeLeaf({
          paths: fixture.paths,
          binding: fixture.binding,
        })).rejects.toThrow(/ineligible immutable declaration/iu);
        expect(counters.__happier_host_declarative_activation_calls)
          .toBeUndefined();
        expect(counters.__happier_host_declarative_factory_module_calls)
          .toBeUndefined();
      } finally {
        delete counters.__happier_host_declarative_activation_calls;
        delete counters.__happier_host_declarative_factory_module_calls;
        await rm(happyHomeDir, { recursive: true, force: true });
        await rm(sourceRootPath, { recursive: true, force: true });
      }
    },
  );

  it('rejects a competing plugin factory before importing its module', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-host-declarative-conflict-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-host-declarative-conflict-source-'),
    );
    const counters = globalThis as typeof globalThis & {
      __happier_host_declarative_factory_module_calls?: number;
    };
    try {
      const fixture = await prepareHostDeclarativeBinding({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-host-declarative-conflict',
        agentDefinition: {
          id: 'fixture',
          title: 'Fixture',
          runtime: {
            kind: 'acp',
            transport: {
              kind: 'tcp',
              host: '127.0.0.1',
              port: 4242,
            },
          },
          primary: 'sessions',
          capabilities: {
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        },
        competingFactory: true,
      });

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).rejects.toThrow(/conflicts with a plugin factory/iu);
      expect(counters.__happier_host_declarative_factory_module_calls)
        .toBeUndefined();
    } finally {
      delete counters.__happier_host_declarative_factory_module_calls;
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('reuses the activation graph canonical ESM leaf without importing or invoking the activation entry', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-canonical-runner-loader-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-canonical-runner-source-'),
    );
    const counterKey = `__happier_runner_leaf_${sourceRootPath.replace(/[^a-z0-9]/giu, '_')}`;
    const counters = globalThis as typeof globalThis & Record<string, number | undefined>;
    try {
      const moduleBytes = [
        `const key = ${JSON.stringify(counterKey)};`,
        'globalThis[key] = (globalThis[key] ?? 0) + 1;',
        'export function createFixtureAgentRuntime() {',
        '  return { sessions: { open() { throw new Error("unused"); } } };',
        '}',
        '',
      ].join('\n');
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-canonical-runner',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes,
        loadMode: 'immutable-js',
        additionalFiles: {
          'daemon.mjs': [
            'import { createFixtureAgentRuntime } from "./agent/runtime/factory.mjs";',
            'export { createFixtureAgentRuntime as registeredFactory };',
            'export function activate() {',
            '  globalThis.__happier_runner_activate_calls =',
            '    (globalThis.__happier_runner_activate_calls ?? 0) + 1;',
            '}',
            '',
          ].join('\n'),
        },
      });
      const activationNamespace = await import(pathToFileURL(join(
        fixture.prepared.rootPath,
        'daemon.mjs',
      )).href) as Readonly<Record<string, unknown>>;

      const leaf = await loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      });

      expect(leaf.factory).toBe(activationNamespace.registeredFactory);
      expect(counters[counterKey]).toBe(1);
      expect(counters.__happier_runner_activate_calls).toBeUndefined();
    } finally {
      delete counters[counterKey];
      delete counters.__happier_runner_activate_calls;
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('loads bundled first-party bytes from the pinned runner snapshot root without reading the generation store', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-bundled-snapshot-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-bundled-snapshot-source-'),
    );
    try {
      const fixture = await prepareBundledFactory({
        happyHomeDir,
        sourceRootPath,
        moduleBytes:
          'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }',
      });

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
        resolveBundledPluginRoot: async () => ({
          rootPath: sourceRootPath,
          cacheIdentity: 'pinned_runner_snapshot:runner-snapshot-a',
        }),
      })).resolves.toEqual({ factory: expect.any(Function), catalogEntry: expect.any(Object), dispose: expect.any(Function) });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('rejects a retained binding whose factory locator differs from the pinned manifest', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-bundled-drift-home-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-bundled-drift-source-'));
    try {
      const fixture = await prepareBundledFactory({
        happyHomeDir,
        sourceRootPath,
        manifestExport: 'createSnapshotFactory',
        moduleBytes: 'export function createSnapshotFactory() { return { source: "A" }; }',
      });
      await expect(verifyRunnerAgentBindingAgainstGeneration({
        paths: fixture.paths,
        binding: fixture.binding,
        resolveBundledPluginRoot: async () => ({
          rootPath: sourceRootPath,
          cacheIdentity: 'pinned_runner_snapshot:runner-snapshot-a',
        }),
      })).rejects.toThrow('factory');
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('rejects a tampered pinned manifest locator before loading its factory', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-bundled-tamper-home-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-bundled-tamper-source-'));
    try {
      const fixture = await prepareBundledFactory({
        happyHomeDir,
        sourceRootPath,
        manifestModule: './agent/runtime/other',
        moduleBytes: 'export function createFixtureAgentRuntime() { return {}; }',
      });
      await expect(verifyRunnerAgentBindingAgainstGeneration({
        paths: fixture.paths,
        binding: fixture.binding,
        resolveBundledPluginRoot: async () => ({
          rootPath: sourceRootPath,
          cacheIdentity: 'pinned_runner_snapshot:runner-snapshot-a',
        }),
      })).rejects.toMatchObject({ code: 'RETAINED_AGENT_FACTORY_LOCATOR_INVALID' });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('loads an external factory without treating arbitrary exports as host open hooks', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-external-private-spoof-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-external-private-spoof-source-'),
    );
    try {
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-external-unrelated-export',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes: [
          'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }',
          'export { unrelatedHostOpen } from "./spoof.mjs";',
        ].join('\n'),
        loadMode: 'immutable-js',
        additionalFiles: {
          'agent/runtime/spoof.mjs': 'export function unrelatedHostOpen() { throw new Error("must not be called"); }',
        },
      });

      const leaf = await loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      });

      expect(Reflect.has(leaf, 'workflowRunRecordSessionOpen')).toBe(false);
      expect(leaf).toEqual({ factory: expect.any(Function), catalogEntry: expect.any(Object), dispose: expect.any(Function) });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('keeps a bundled Agent on the public factory-only path', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-bundled-non-claude-private-home-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-bundled-non-claude-private-source-'),
    );
    try {
      const fixture = await prepareBundledFactory({
        happyHomeDir,
        sourceRootPath,
        moduleBytes: [
          'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }',
          'export function unrelatedHostOpen() { throw new Error("must not be called"); }',
        ].join('\n'),
      });

      const leaf = await loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
        resolveBundledPluginRoot: async () => ({
          rootPath: sourceRootPath,
          cacheIdentity: 'pinned_runner_snapshot:runner-snapshot-a',
        }),
      });

      expect(Reflect.has(leaf, 'workflowRunRecordSessionOpen')).toBe(false);
      expect(leaf).toEqual({ factory: expect.any(Function), catalogEntry: expect.any(Object), dispose: expect.any(Function) });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('rejects an external immutable generation that spoofs a reserved first-party id', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-external-runner-loader-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-external-runner-source-'),
    );
    try {
      const moduleBytes =
        'export function createFixtureAgentRuntime() { return { sessions: { open() { throw new Error(\"unused\"); } } }; }';
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-external-runner',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes,
        loadMode: 'immutable-js',
        pluginId: 'happier.agent.fixture',
        // The impersonation this rejects is a *published* artifact claiming a
        // first-party id, so the generation has to be minted from a
        // registry-custodied acquisition identity. A local working tree is the
        // maintainer's own dev loop and is exempt by design.
        distribution: {
          kind: 'npm',
          registryOrigin: 'https://registry.example.test',
          packageName: '@acme/happier-agent-fixture',
        },
        // No declared engine range, so the reserved namespace is the only
        // registry-lifecycle rule that can reject this manifest.
        manifestEngines: {},
      });

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).rejects.toThrow(
        'immutable declaration source mismatch',
      );
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('loads only the attested named export from a packed immutable generation', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-packed-runner-loader-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-packed-runner-source-'),
    );
    try {
      const moduleBytes =
        'export function createFixtureAgentRuntime() { return { sessions: { open() { throw new Error(\"unused\"); } } }; }';
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-packed-runner',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes,
        loadMode: 'immutable-js',
      });
      const verified =
        await verifyRunnerAgentBindingAgainstGeneration({
          paths: fixture.paths,
          binding: fixture.binding,
        });

      expect(verified.declaredAgent).toMatchObject({
        id: 'fixture',
        runtime: { kind: 'custom' },
        capabilities: {
          sessions: { open: ['create'] },
        },
      });

      const leaf = await loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      });

      expect(leaf).toEqual({ factory: expect.any(Function), catalogEntry: expect.any(Object), dispose: expect.any(Function) });
      expect(await leaf.factory({
        plugin: {
          id: 'acme.runner-loader',
          version: '1.0.0',
        },
        agent: { id: 'fixture' },
        signal: new AbortController().signal,
      })).toMatchObject({ sessions: { open: expect.any(Function) } });

    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it.each([
    ['wrong immutable generation', {
      sourceCustody: {
        kind: 'managed' as const,
        immutableGenerationId: 'generation-substituted',
        installSource: 'localPath' as const,
      },
    }],
    ['different leaf', {
      locator: {
        module: './agent/runtime/other',
        export: 'createFixtureAgentRuntime',
        runtimeApiVersion: 1 as const,
      },
      normalizedModulePath: 'agent/runtime/other.mjs',
    }],
    ['different export', {
      locator: {
        module: './agent/runtime/factory',
        export: 'otherFactory',
        runtimeApiVersion: 1 as const,
      },
    }],
    ['different External Sessions companion export', {
      locator: {
        module: './agent/runtime/factory',
        export: 'createFixtureAgentRuntime',
        runtimeApiVersion: 1 as const,
        externalSessionsExport: 'otherExternalSessions',
      },
    }],
    ['different normalized path', {
      normalizedModulePath: 'agent/runtime/other.mjs',
    }],
    ['escaped normalized path', {
      normalizedModulePath: '../escaped.mjs',
    }],
  ] as const)(
    'rejects a retained binding for a %s before importing any leaf',
    async (_label, override) => {
      const happyHomeDir = await mkdtemp(
        join(tmpdir(), 'happier-mismatched-runner-loader-'),
      );
      const sourceRootPath = await mkdtemp(
        join(tmpdir(), 'happier-mismatched-runner-source-'),
      );
      try {
        const moduleBytes =
          'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }';
        const fixture = await prepareRetainedFactory({
          happyHomeDir,
          sourceRootPath,
          immutableGenerationId: `generation-mismatched-runner-${_label.replaceAll(' ', '-')}`,
          modulePath: 'agent/runtime/factory.mjs',
          moduleBytes,
          loadMode: 'immutable-js',
        });
        if ('kind' in fixture.binding) {
          throw new Error('Expected a plugin factory binding fixture');
        }
        const binding = createAgentSessionRunnerFactoryBinding({
          ...fixture.binding,
          ...override,
        });

        await expect(loadRetainedAgentRuntimeLeaf({
          paths: fixture.paths,
          binding,
        })).rejects.toThrow();
      } finally {
        await rm(happyHomeDir, { recursive: true, force: true });
        await rm(sourceRootPath, { recursive: true, force: true });
      }
    },
  );

  it('loads a source TypeScript leaf from its retained generation', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-source-runner-loader-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-source-runner-source-'),
    );
    try {
      await mkdir(
        join(sourceRootPath, 'agent', 'runtime'),
        { recursive: true },
      );
      await writeFile(
        join(sourceRootPath, 'agent', 'runtime', 'value.ts'),
        'export const runtimeValue = \"source-v1\";\n',
        'utf8',
      );
      const moduleBytes = [
        'import { runtimeValue } from \"./value.js\";',
        'export function createFixtureAgentRuntime() {',
        '  return { sessions: { open() { throw new Error(runtimeValue); } } };',
        '}',
        '',
      ].join('\n');
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-source-runner',
        modulePath: 'agent/runtime/factory.ts',
        moduleBytes,
        loadMode: 'source-ts',
      });

      const preparations: unknown[] = [];
      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
        onPreparationComplete: (preparation: unknown) => preparations.push(preparation),
      })).resolves.toEqual({ factory: expect.any(Function), catalogEntry: expect.any(Object), dispose: expect.any(Function) });
      expect(preparations).toEqual([{
        startedAtMs: expect.any(Number),
        bindingProofMs: expect.any(Number),
        manifestProjectionMs: expect.any(Number),
        moduleResolutionMs: expect.any(Number),
        moduleLoadMs: expect.any(Number),
        catalogProjectionMs: expect.any(Number),
        loadMode: 'source-ts',
      }]);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('rejects a missing retained leaf', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-missing-runner-loader-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-missing-runner-source-'),
    );
    try {
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-missing-runner',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes:
          'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }',
        loadMode: 'immutable-js',
      });
      await rm(join(
        fixture.prepared.rootPath,
        'agent',
        'runtime',
        'factory.mjs',
      ));

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).rejects.toThrow(/ENOENT|is missing|does not exist/iu);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('rejects an unloadable retained leaf', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-unloadable-runner-loader-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-unloadable-runner-source-'),
    );
    try {
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-unloadable-runner',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes: 'throw new Error("unloadable retained leaf");',
        loadMode: 'immutable-js',
      });

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).rejects.toThrow(/unloadable retained leaf|Failed to load plugin daemon entry/iu);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('rejects a non-regular retained leaf', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-non-regular-runner-loader-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-non-regular-runner-source-'),
    );
    try {
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-non-regular-runner',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes:
          'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }',
        loadMode: 'immutable-js',
      });
      const leaf = join(
        fixture.prepared.rootPath,
        'agent',
        'runtime',
        'factory.mjs',
      );
      await rm(leaf);
      await mkdir(leaf);

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).rejects.toMatchObject({ code: 'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED' });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('loads a trusted symbolic-link leaf without runtime containment attestation', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-escaped-symlink-runner-loader-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-escaped-symlink-runner-source-'),
    );
    try {
      const moduleBytes =
        'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }';
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-escaped-symlink-runner',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes,
        loadMode: 'immutable-js',
      });
      const leaf = join(
        fixture.prepared.rootPath,
        'agent',
        'runtime',
        'factory.mjs',
      );
      const outsideLeaf = join(sourceRootPath, 'outside-factory.mjs');
      await writeFile(outsideLeaf, moduleBytes, 'utf8');
      await rm(leaf);
      await symlink(outsideLeaf, leaf);

      const retained = await loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      });
      try {
        expect(typeof retained.factory).toBe('function');
      } finally {
        await retained.dispose();
      }
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });
});
