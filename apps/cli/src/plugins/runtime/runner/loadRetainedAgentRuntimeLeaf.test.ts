import {
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
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

async function prepareRetainedFactory(input: Readonly<{
  happyHomeDir: string;
  sourceRootPath: string;
  immutableGenerationId: string;
  modulePath: string;
  moduleBytes: string;
  loadMode: 'immutable-js' | 'source-ts';
  pluginId?: string;
  localAgentId?: string;
  manifestAuthority?: 'external' | 'bundled_first_party';
  manifestEngines?: Readonly<Record<string, string>>;
  externalSessionsExport?: string;
  additionalFiles?: Readonly<Record<string, string>>;
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
    updatePolicy: 'manual',
    createdAtMs: 1,
  });
  const record = {
    ...generated,
    immutableGenerationId: input.immutableGenerationId,
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
    manifestAuthority:
      input.manifestAuthority ?? 'external',
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
    agentId: localAgentId,
    localAgentId,
    immutableGenerationId: record.immutableGenerationId,
    locator,
    normalizedModulePath: input.modulePath,
    loadMode: input.loadMode,
  });
  return { paths, prepared, binding };
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
    updatePolicy: 'manual',
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
    immutableGenerationId: record.immutableGenerationId,
  });
  return { paths, prepared, binding };
}

describe('loadRetainedAgentRuntimeLeaf', () => {
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

      expect(leaf).toEqual({
        factory: expect.any(Function),
        externalSessions: expect.any(Object),
      });
      expect(Object.isFrozen(leaf.externalSessions)).toBe(true);
      expect(leaf.externalSessions).not.toBe(moduleNamespace.externalSessions);
      expect(leaf.externalSessions?.resolveSource).not.toBe(
        (moduleNamespace.externalSessions as Record<string, unknown>)
          .resolveSource,
      );
      expect(Object.getOwnPropertyDescriptor(
        leaf.externalSessions,
        'resolveSource',
      )).toMatchObject({
        enumerable: true,
        writable: false,
        configurable: false,
      });
      expect(counters[counterKey]).toBe(1);
    } finally {
      delete counters[counterKey];
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('loads a local-source generation whose manifest declares a range this host does not satisfy', async () => {
    // A `path` installation is admitted under `localSource`, where a
    // pre-release engine placeholder in the author's working tree is the
    // normal dev loop. The runtime leaf re-reads the very same generation
    // bytes, so it must read the same provenance the record was minted with
    // instead of silently falling back to the published-artifact rules.
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
      })).resolves.toEqual({ factory: expect.any(Function) });
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
      })).resolves.toEqual({ factory: expect.any(Function) });
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

  it.each([
    ['missing operation', [
      'export const externalSessions = {',
      '  async resolveSource() {},',
      '  async listCandidates() {},',
      '  async resolveLinkIdentity() {},',
      '  async resolveLinkedIdentity() {},',
      '  async pageTranscript() {},',
      '};',
    ].join('\n')],
    ['extra operation', [
      'export const externalSessions = {',
      '  async resolveSource() {},',
      '  async listCandidates() {},',
      '  async resolveLinkIdentity() {},',
      '  async resolveLinkedIdentity() {},',
      '  async pageTranscript() {},',
      '  async readAfterTranscript() {},',
      '  async followTranscript() {},',
      '};',
    ].join('\n')],
    ['nonfunction operation', [
      'export const externalSessions = {',
      '  resolveSource: 42,',
      '  async listCandidates() {},',
      '  async resolveLinkIdentity() {},',
      '  async resolveLinkedIdentity() {},',
      '  async pageTranscript() {},',
      '  async readAfterTranscript() {},',
      '};',
    ].join('\n')],
    // An accessor-backed operation is deliberately NOT a rejection case: the
    // registration scope captures each declared operation once through
    // ordinary property access and freezes the façade, so a class author's
    // `get readAfterTranscript()` is as static as a data method. That
    // capability is owned and covered by the SDK registration scope
    // ("captures class, prototype, and accessor-backed operations with the
    // author receiver"); rejecting it here would remove an author capability.
  ] as const)(
    'rejects a freshly evaluated companion with a %s before factory or follow effects',
    async (label, companionBytes) => {
      const happyHomeDir = await mkdtemp(
        join(tmpdir(), 'happier-runner-invalid-companion-home-'),
      );
      const sourceRootPath = await mkdtemp(
        join(tmpdir(), 'happier-runner-invalid-companion-source-'),
      );
      try {
        const moduleBytes = [
          'export function createFixtureAgentRuntime() {',
          '  throw new Error("factory effect must not run");',
          '}',
          companionBytes,
          '',
        ].join('\n');
        const fixture = await prepareRetainedFactory({
          happyHomeDir,
          sourceRootPath,
          immutableGenerationId:
            `generation-invalid-companion-${label.replaceAll(' ', '-')}`,
          modulePath: 'agent/runtime/factory.mjs',
          moduleBytes,
          loadMode: 'immutable-js',
          externalSessionsExport: 'externalSessions',
        });

        await expect(loadRetainedAgentRuntimeLeaf({
          paths: fixture.paths,
          binding: fixture.binding,
        })).rejects.toThrow(/Agent External Sessions/iu);
      } finally {
        await rm(happyHomeDir, { recursive: true, force: true });
        await rm(sourceRootPath, { recursive: true, force: true });
      }
    },
  );

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
      })).resolves.toEqual({ factory: expect.any(Function) });
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
        immutableGenerationId: originalBinding.immutableGenerationId,
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

  it('loads a reserved first-party declaration only with bundled validation authority', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-bundled-runner-loader-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-bundled-runner-source-'),
    );
    try {
      const moduleBytes =
        'export function createFixtureAgentRuntime() { return { sessions: { open() { throw new Error(\"unused\"); } } }; }';
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-bundled-runner',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes,
        loadMode: 'immutable-js',
        pluginId: 'happier.agent.fixture',
        manifestAuthority: 'bundled_first_party',
      });

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).resolves.toEqual({ factory: expect.any(Function) });
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
      expect(leaf).toEqual({ factory: expect.any(Function) });
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
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-bundled-factory-only',
        modulePath: 'agent/runtime/factory.mjs',
        moduleBytes: [
          'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }',
          'export function unrelatedHostOpen() { throw new Error("must not be called"); }',
        ].join('\n'),
        loadMode: 'immutable-js',
        pluginId: 'happier.agent.fixture',
        manifestAuthority: 'bundled_first_party',
      });

      const leaf = await loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      });

      expect(Reflect.has(leaf, 'workflowRunRecordSessionOpen')).toBe(false);
      expect(leaf).toEqual({ factory: expect.any(Function) });
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
        manifestAuthority: 'external',
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

      expect(leaf).toEqual({ factory: expect.any(Function) });
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
      immutableGenerationId: 'generation-substituted',
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

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).resolves.toEqual({ factory: expect.any(Function) });
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
      })).rejects.toThrow(/regular file|real immutable file|unexpected inventory entry/iu);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('rejects a symbolic-link leaf even when it resolves inside the generation root', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-symlink-runner-loader-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-symlink-runner-source-'),
    );
    try {
      const moduleBytes =
        'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }';
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-symlink-runner',
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
      const replacement = join(
        fixture.prepared.rootPath,
        'agent',
        'runtime',
        'replacement.mjs',
      );
      await writeFile(replacement, moduleBytes, 'utf8');
      await rm(leaf);
      await symlink(replacement, leaf);

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).rejects.toThrow(
        /symbolic|unexpected inventory entry|substitution/iu,
      );
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('rejects a symbolic-link leaf that resolves outside the generation root', async () => {
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

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).rejects.toThrow(/symbolic link|escapes its immutable generation/iu);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('rejects a retained leaf with an external hardlink alias', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-hardlink-runner-loader-'),
    );
    const sourceRootPath = await mkdtemp(
      join(tmpdir(), 'happier-hardlink-runner-source-'),
    );
    try {
      const fixture = await prepareRetainedFactory({
        happyHomeDir,
        sourceRootPath,
        immutableGenerationId: 'generation-hardlink-runner',
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
      await link(leaf, join(sourceRootPath, 'factory-inode-alias.mjs'));

      await expect(loadRetainedAgentRuntimeLeaf({
        paths: fixture.paths,
        binding: fixture.binding,
      })).rejects.toThrow(/hardlink|inode alias|link count|share a writable inode/iu);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });
});
