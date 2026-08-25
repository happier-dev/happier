import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import ts from 'typescript';

import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import * as probeHarness from './run-probes.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const { runCommand } = probeHarness;

function spawnResult({ status, signal, error }) {
  return {
    pid: 123,
    output: [null, '', ''],
    stdout: '',
    stderr: '',
    status,
    signal,
    ...(error ? { error } : {}),
  };
}

function readImportSpecifiers(source) {
  const sourceFile = ts.createSourceFile(
    'packed-negative-probe.ts',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const specifiers = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.add(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function createSyntheticInventory(
  authorSymbols = [['InventoryOnlyName', 'type']],
) {
  return {
    schemaVersion: 1,
    entrypoints: [
      {
        specifier: '.',
        sourceModule: 'src/index.ts',
        visibility: 'author',
        realm: 'any',
        conditions: { types: './dist/index.d.ts', default: './dist/index.js' },
      },
      {
        specifier: './host/registration',
        sourceModule: 'src/host/registration/index.ts',
        visibility: 'host',
        realm: 'any',
        conditions: {
          types: './dist/host/registration/index.d.ts',
          browser: './dist/host/registration/index.js',
          'react-native': './dist/host/registration/index.js',
          default: './dist/host/registration/index.js',
        },
      },
      {
        specifier: './host/fs/json-owner-file-lock',
        sourceModule: 'src/host/fs/jsonOwnerFileLock.ts',
        visibility: 'host',
        realm: 'daemon',
        conditions: {
          types: './dist/host/fs/jsonOwnerFileLock.d.ts',
          default: './dist/host/fs/jsonOwnerFileLock.js',
        },
      },
    ],
    symbols: [
      ...authorSymbols.map(([exportName, kind]) => ({
        specifier: '.',
        exportName,
        kind,
        sourceModule: 'src/contracts.ts',
        sourceExport: exportName,
        realm: 'any',
      })),
      ...[
        ['createPluginRegistrationScope', 'value'],
        ['PluginRegistrationRight', 'type'],
        ['PluginAgentRuntimeRegistration', 'type'],
        ['PluginRuntimeRegistration', 'type'],
      ].map(([exportName, kind]) => ({
        specifier: './host/registration',
        exportName,
        kind,
        sourceModule: 'src/host/registration/contract.ts',
        sourceExport: exportName,
        realm: 'any',
      })),
      ...[
        'reclaimJsonOwnerFileLockSnapshot',
        'withJsonOwnerFileLock',
      ].map((exportName) => ({
        specifier: './host/fs/json-owner-file-lock',
        exportName,
        kind: 'value',
        sourceModule: 'src/host/fs/jsonOwnerFileLockContract.ts',
        sourceExport: exportName,
        realm: 'daemon',
      })),
    ],
  };
}

async function writeSyntheticPackedSdk(
  fixtureRoot,
  contract,
  {
    authorDeclaration = 'export type InventoryOnlyName = string;\n',
    registrationDeclaration = [
      'export declare function createPluginRegistrationScope(): unknown;',
      'export interface PluginRegistrationRight {}',
      'export interface PluginAgentRuntimeRegistration {}',
      'export interface PluginRuntimeRegistration {}',
      '',
    ].join('\n'),
    fileLockDeclaration = [
      'export declare function reclaimJsonOwnerFileLockSnapshot(): void;',
      'export declare function withJsonOwnerFileLock(): void;',
      '',
    ].join('\n'),
  } = {},
) {
  await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify({
    type: 'module',
    exports: Object.fromEntries(contract.inventory.entrypoints.map((entrypoint) => [
      entrypoint.specifier,
      entrypoint.conditions,
    ])),
  }));
  for (const [relativePath, declaration] of [
    ['dist/index.d.ts', authorDeclaration],
    ['dist/host/registration/index.d.ts', registrationDeclaration],
    ['dist/host/fs/jsonOwnerFileLock.d.ts', fileLockDeclaration],
  ]) {
    if (declaration === null) continue;
    const targetPath = join(fixtureRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, declaration);
  }
}

test('NodeNext consumer config fixes its source root for the repository TypeScript compiler', () => {
  assert.equal(
    typeof probeHarness.buildNodeNextTsconfig,
    'function',
    'packed NodeNext generation must expose its canonical tsconfig contract',
  );

  const config = probeHarness.buildNodeNextTsconfig();
  assert.equal(config.compilerOptions.rootDir, 'src');
  assert.deepEqual(config.compilerOptions.types, ['node']);
  assert.deepEqual(config.include, ['src/**/*.ts']);
});

test('normal-surface source generation compiles types, resolves values, and behavior-consumes representative values', () => {
  assert.equal(
    typeof probeHarness.renderNormalSurfaceProbeSource,
    'function',
    'the packed consumer must generate its source from the canonical SDK inventory',
  );

  const source = probeHarness.renderNormalSurfaceProbeSource({
    '.': [
      {
        name: 'ConstrainedGenericType',
        runtime: false,
        typeArguments: ['"a" | "b"'],
      },
      {
        name: 'GenericType',
        runtime: false,
        typeArguments: ['unknown'],
      },
      {
        name: 'OpaqueDescriptor',
        runtime: false,
        opaqueReason: 'The public contract intentionally leaves this descriptor opaque.',
      },
      { name: 'RootTypeOnly', runtime: false },
      { name: 'PluginError', runtime: true },
      { name: 'definePlugin', runtime: true },
    ],
    './actions': [
      { name: 'getActionSpec', runtime: true },
    ],
    './protocol': [
      { name: 'defineProtocolObject', runtime: true },
    ],
    './secrets': [
      { name: 'SecretStringV1Schema', runtime: true },
    ],
    './sessions/external': [
      { name: 'ExternalSessionAgentIdSchema', runtime: true },
    ],
    './ui/client': [
      { name: 'UiClientTypeOnly', runtime: false },
      { name: 'createPluginUiHostApiClient', runtime: true },
    ],
    './runtime': [
      {
        name: 'PluginConnectedAccountAuthenticationModeRuntime',
        runtime: false,
      },
    ],
    './testing': [
      { name: 'createPluginTestkit', runtime: true },
    ],
  });

  assert.match(
    source,
    /import type \{[^}]*RootTypeOnly[^}]*\} from "@happier-dev\/plugin-sdk";/u,
  );
  assert.match(
    source,
    /import \* as runtime0 from "@happier-dev\/plugin-sdk";/u,
  );
  assert.match(
    source,
    /import type \{ UiClientTypeOnly \} from "@happier-dev\/plugin-sdk\/ui\/client";/u,
  );
  assert.match(
    source,
    /__IsConcrete<RootTypeOnly>/u,
  );
  assert.match(
    source,
    /__IsConcrete<ConstrainedGenericType<"a" \| "b">>/u,
  );
  assert.match(
    source,
    /__IsConcrete<GenericType<unknown>>/u,
  );
  assert.match(
    source,
    /__IsUnknown<OpaqueDescriptor>/u,
    'intentionally opaque public descriptors must remain exactly unknown instead of weakening all type checks',
  );
  assert.doesNotMatch(
    source,
    /__IsConcrete<OpaqueDescriptor>/u,
  );
  assert.match(
    source,
    /satisfies PluginConnectedAccountAuthenticationModeRuntime/u,
    'the packed consumer must separately author a reusable Connected Account authentication mode',
  );
  assert.match(
    source,
    /__IsConcrete<typeof runtime0\.PluginError>/u,
  );
  assert.match(
    source,
    /new runtime0\.PluginError/u,
  );
  assert.match(
    source,
    /runtime0\.definePlugin\(\{/u,
    'the packed external consumer must invoke the final root definePlugin export',
  );
  assert.match(
    source,
    /__definedPlugin\d+\.manifest\.displayName !== "com\.example\.packed-consumer"/u,
    'the packed external consumer must exercise canonical manifest projection',
  );
  assert.match(
    source,
    /typeof __definedPlugin\d+\.activate !== "function"/u,
    'the packed external consumer must exercise the named activation ABI',
  );
  assert.match(
    source,
    /\.defineProtocolObject\(\{\}, \{ policy: "closed" \}\)/u,
    'the packed external consumer must compose an executable protocol schema',
  );
  assert.match(
    source,
    /\.getActionSpec\("session\.open"\)/u,
    'the packed external consumer must exercise the canonical ActionSpec lookup',
  );
  assert.match(
    source,
    /\.SecretStringV1Schema\.parse\(\{/u,
    'the packed external consumer must exercise the public secret schema',
  );
  assert.match(
    source,
    /\.ExternalSessionAgentIdSchema\.safeParse\(" packed-consumer-agent "\)/u,
    'the packed external consumer must exercise exact External Session Agent-id validation',
  );
  assert.match(
    source,
    /ui_host_bootstrap_missing/u,
  );
  assert.match(
    source,
    /createPluginTestkit\(/u,
    'the packed external consumer must exercise the public testkit constructor',
  );
  assert.doesNotMatch(
    source,
    /engines:\s*\{\s*happier:/u,
    'the packed external consumer must not synthesize engines.happier from toolchain metadata',
  );
  assert.doesNotMatch(
    source,
    /runtime0\.RootTypeOnly/u,
    'type-only declarations must not be required at runtime',
  );
  assert.match(source, /normal-surface:contract-ok/u);
  assert.doesNotMatch(source, /normal-surface:4:2/u);
  const genericSource = probeHarness.renderNormalSurfaceProbeSource({
    '.': [{ name: 'InventoryClassifiedRuntimeValue', runtime: true }],
  });
  assert.match(
    genericSource,
    /runtime0\.InventoryClassifiedRuntimeValue === undefined/u,
    'inventory-classified runtime values without bespoke behavior still require packed resolution',
  );

  assert.equal(
    typeof probeHarness.renderRuntimeBehaviorConsumer,
    'function',
    'the generated generic resolution guard must be directly testable',
  );
  const executeGenericResolutionGuard = new Function(
    'runtimeValue',
    probeHarness.renderRuntimeBehaviorConsumer(
      '@happier-dev/plugin-sdk:InventoryClassifiedRuntimeValue',
      'runtimeValue',
      0,
    ).join('\n'),
  );
  assert.doesNotThrow(() => executeGenericResolutionGuard(() => 'resolved'));
  assert.throws(
    () => executeGenericResolutionGuard(undefined),
    /Packed runtime export failed to resolve: @happier-dev\/plugin-sdk:InventoryClassifiedRuntimeValue/u,
  );
});

test('Re.Pack singleton probe checks excluded compiler runtime without widening the SDK record', () => {
  const source = probeHarness.renderNormalSurfaceProbeSource({
    './ui/build': [{
      name: 'createReactNativeRepackSharedModules',
      runtime: true,
    }],
  });

  assert.match(
    source,
    /\(__repackShared0 as Readonly<Record<string, unknown>>\)\["react\/compiler-runtime"\] !== undefined/u,
  );
  assert.doesNotMatch(
    source,
    /__repackShared0\["react\/compiler-runtime"\] !== undefined/u,
  );
});

test('canonical SDK inventory is the packed probe package-graph input', async () => {
  assert.equal(typeof probeHarness.readCanonicalAuthorSurfaceInventory, 'function');
  const contract = await probeHarness.readCanonicalAuthorSurfaceInventory();

  for (const entrypoint of contract.inventory.entrypoints) {
    if (entrypoint.visibility !== 'author') continue;
    assert.ok(
      contract.inventory.symbols.some((symbol) => symbol.specifier === entrypoint.specifier),
      `author path ${entrypoint.specifier} must name its retained public contracts`,
    );
  }
});

test('canonical SDK inventory reader preserves author and host fixture rows', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-contract-'));
  const fixturePath = join(fixtureRoot, 'api-surface.json');
  try {
    const expectedInventory = createSyntheticInventory();
    await writeFile(fixturePath, JSON.stringify(expectedInventory));
    const contract = await probeHarness.readCanonicalAuthorSurfaceInventory(fixturePath);
    assert.deepEqual(
      contract.inventory,
      expectedInventory,
    );
    assert.deepEqual(Object.keys(contract), ['inventory']);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('packed consumers read the package graph only from the tracked inventory', async () => {
  const source = await readFile(new URL('./run-probes.mjs', import.meta.url), 'utf8');

  assert.match(
    source,
    /api-surface\.json/u,
    'the packed probe must consume the tracked SDK inventory',
  );
  assert.doesNotMatch(
    source,
    /normalSurfaceContract\.ts/u,
    'the packed probe cannot consume a parallel source registry',
  );
});

test('packed negative consumer keeps the V1 context fixture harness off the normal testing path', () => {
  assert.equal(typeof probeHarness.renderNegativeTypeProbeSource, 'function');
  const source = probeHarness.renderNegativeTypeProbeSource();

  for (const name of [
    'createPluginContextV1Fixture',
    'PluginContextFixtureLogV1',
    'PluginContextFixtureOptionsV1',
    'PluginContextFixtureRecordsV1',
    'PluginContextFixtureServicesV1',
    'PluginContextFixtureV1',
  ]) {
    assert.match(
      source,
      new RegExp(`import type \\{ ${name} \\} from "@happier-dev/plugin-sdk/testing";`, 'u'),
    );
  }
});

test('packed negative consumer makes retired legacy runtime entrypoints explicit path tombstones', () => {
  assert.equal(typeof probeHarness.renderNegativeTypeProbeSource, 'function');
  const source = probeHarness.renderNegativeTypeProbeSource();

  for (const entrypoint of ['runtime', 'agent-runtime']) {
    assert.ok(
      source.includes(
        `from "@happier-dev/plugin-sdk/${entrypoint}";`,
      ),
      `${entrypoint} must remain an explicit packed path tombstone`,
    );
  }
});

test('packed negative consumer rejects retired symbols through their real retained entrypoints', () => {
  assert.equal(typeof probeHarness.renderNegativeTypeProbeSource, 'function');
  const source = probeHarness.renderNegativeTypeProbeSource();

  for (const [entrypoint, name] of [
    ['', 'PluginActivationApi'],
    ['agents/runtime', 'RuntimeCoreV1'],
    ['agents/runtime', 'AcpSessionRuntimeV1'],
    ['agents/runtime', 'AgentRuntimeV1'],
    ['agents/runtime', 'AgentSessionAuthService'],
    ['sessions/external', 'PluginExternalSessionCandidate'],
    ['sessions/external', 'PluginExternalSessionRef'],
    ['sessions/external', 'PluginExternalSessionsService'],
    ['sessions/external', 'PluginExternalTranscriptFollowEvent'],
    ['sessions/external', 'PluginExternalTranscriptFollowResult'],
    ['sessions/external', 'PluginExternalTranscriptItem'],
    ['sessions/external', 'PluginProjectsService'],
  ]) {
    assert.ok(
      source.includes(
        `import type { ${name} } from "@happier-dev/plugin-sdk${entrypoint ? `/${entrypoint}` : ''}";`,
      ),
      `${name} must remain an explicit packed negative import`,
    );
  }
});

test('packed negative consumer does not mislabel retained normal exports as retired', () => {
  assert.equal(typeof probeHarness.renderNegativeTypeProbeSource, 'function');
  const source = probeHarness.renderNegativeTypeProbeSource();

  for (const name of [
    'PluginLoopbackWebSocketClientSpec',
    'PluginLoopbackWebSocketHandshake',
    'PluginLoopbackWebSocketHeader',
    'PluginProtocolClientKind',
    'AgentAccountUsageService',
    'AgentConfigurationScalar',
    'AgentRuntimeRegistrationOptions',
    'AgentRuntimeSurfaces',
    'AgentSessionMcpTransport',
    'AgentTerminalLaunchRequest',
    'PluginUiArtifactPlatform',
    'PluginUiBuildConfig',
    'PluginUiBuildTarget',
  ]) {
    assert.equal(
      source.includes(`import type { ${name} }`),
      false,
      `${name} is retained through the current normal surface`,
    );
  }
});

test('packed negative consumers do not reject approved final author paths', () => {
  assert.equal(typeof probeHarness.renderNegativeRuntimeProbeSource, 'function');
  const typeSource = probeHarness.renderNegativeTypeProbeSource();
  const runtimeSource = probeHarness.renderNegativeRuntimeProbeSource();
  const typeSpecifiers = readImportSpecifiers(typeSource);
  const runtimeSpecifiers = readImportSpecifiers(runtimeSource);

  for (const subpath of [
    'agents',
    'events',
    'hooks',
    'mcp',
    'reviews',
    'scm',
    'sessions',
  ]) {
    const specifier = `@happier-dev/plugin-sdk/${subpath}`;
    assert.equal(typeSpecifiers.has(specifier), false, specifier);
    assert.equal(runtimeSpecifiers.has(specifier), false, specifier);
  }

  assert.equal(
    typeSpecifiers.has('@happier-dev/plugin-sdk/agents/runtime'),
    true,
    'the retained child entrypoint remains a valid negative-symbol probe source',
  );
  const injectedRetiredParent = `${typeSource}\nimport type { RemovedAgentsParent } from "@happier-dev/plugin-sdk/agents";\n`;
  assert.equal(
    readImportSpecifiers(injectedRetiredParent).has('@happier-dev/plugin-sdk/agents'),
    true,
    'an exact retired parent import remains distinguishable from its retained child entrypoint',
  );

  for (const name of [
    'ReactNativeWebViteBuildPresetInput',
    'PluginTestkit',
    'PluginTestkitRegistration',
  ]) {
    assert.equal(
      typeSource.includes(`import type { ${name} }`),
      false,
      `${name} is an approved final author export`,
    );
  }
});

test('Vite consumer compiles against the retained UI render-surface contract', async () => {
  const source = await readFile(new URL('./run-probes.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /import \{ defineBuildConfig \} from "@happier-dev\/plugin-sdk\/ui\/build";/u,
  );
  assert.match(
    source,
    /import type \{ RenderSurface \} from "@happier-dev\/plugin-sdk\/ui";/u,
  );
  assert.doesNotMatch(
    source,
    /import type \{ PluginUiSurfaceModule \} from "@happier-dev\/plugin-sdk\/ui";/u,
  );
  assert.doesNotMatch(source, /PluginUiRenderSurface/u);
  assert.doesNotMatch(source, /definePluginUiBuildConfig/u);
});

test('packed declaration classifier uses representative generic inputs and named opaque descriptors', () => {
  assert.deepEqual(
    [...probeHarness.PACKED_GENERIC_TYPE_ARGUMENTS],
    [
      ['.:PluginProtocolClientHandle', ["'jsonRpc'"]],
      ['.:PluginProtocolClientSpecByKind', ["'jsonRpc'"]],
      [
        '.:UiSurfaceAppPageDefinitionFor',
        [
          "Readonly<{ id: 'packed-app-page'; container: 'appPage' }>",
          'UiSurfaceRendererDefinition',
        ],
      ],
      [
        '.:UiSurfaceDetailedDefinitionFor',
        [
          "Readonly<{ id: 'packed-detail'; container: 'detailsPanel'; target: 'session' }>",
          'UiSurfaceRendererDefinition',
        ],
      ],
      ['./contributions:PublicContributionProtocol', ['ContributionProtocol']],
      [
        './contributions:RequiredSurfaceRoles',
        ["Readonly<{ primary: ContributionSurfaceDefinition & Readonly<{ required: true }> }>"],
      ],
      ['./protocol:ProtocolSchemaInput', ['ProtocolComposableSchema<string, number>']],
      ['./protocol:ProtocolSchemaOutput', ['ProtocolComposableSchema<string, number>']],
    ],
    'generic declaration utilities need valid representative inputs; unknown fallback inputs do not prove closure',
  );
  assert.deepEqual(
    [...probeHarness.PACKED_OPAQUE_TYPE_EXPORTS],
    [
      [
        './browser:BrowserAvailabilityDescriptor',
        'Browser availability is intentionally opaque at the public SDK boundary.',
      ],
      [
        './manifest:PluginAvailabilityDescriptor',
        'Plugin availability is intentionally opaque at the public SDK boundary.',
      ],
    ],
    'only the two explicitly opaque availability descriptors may use unknown assertions',
  );
});

test('packed runtime consumers track the current manifest literal and Vite plugin tuple', () => {
  const testkitSource = probeHarness.renderRuntimeBehaviorConsumer(
    '@happier-dev/plugin-sdk/testing:createPluginTestkit',
    'createPluginTestkit',
    0,
  ).join('\n');
  assert.match(
    testkitSource,
    /runtime: \{ apiVersion: Number\(__publicToolchain0\.framework\.runtime\) as 1 \}/u,
    'the manifest API version must come from the generated public toolchain without widening its literal type',
  );
  assert.match(
    testkitSource,
    /PUBLIC_TOOLCHAIN_COMPATIBILITY_V1/u,
    'the probe must consume the generated public toolchain packet',
  );
  assert.doesNotMatch(testkitSource, /runtime: \{ apiVersion: 1 \}/u);
  assert.doesNotMatch(testkitSource, /framework\.runtime !== "1"/u);

  const viteSource = probeHarness.renderRuntimeBehaviorConsumer(
    '@happier-dev/plugin-sdk/ui/build:createReactNativeWebVitePlugins',
    'createReactNativeWebVitePlugins',
    0,
  ).join('\n');
  assert.match(viteSource, /__vitePlugins0\.length !== 2/u);
  assert.match(viteSource, /__vitePlugins0\[1\]\.name !== "happier-plugin-ui-package-instance"/u);
  assert.match(viteSource, /__vitePlugins0\[1\]\.enforce !== "post"/u);
  assert.doesNotMatch(viteSource, /__vitePlugins0\.length !== 1/u);
});

test('packed declaration classification distinguishes runtime values from type-only exports', async () => {
  assert.equal(typeof probeHarness.classifyPackedNormalSurface, 'function');
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-classifier-'));
  try {
    const expectedSymbols = [
      ['ConstrainedGenericType', 'type'],
      ['DefaultedGenericType', 'type'],
      ['GenericType', 'type'],
      ['PluginProtocolClientHandle', 'type'],
      ['PluginProtocolClientKind', 'type'],
      ['PluginProtocolClientSpecByKind', 'type'],
      ['RuntimeValue', 'value'],
      ['TypeOnly', 'type'],
      ['TypeOnlyDeclaredClass', 'type'],
    ];
    const inventoryPath = join(fixtureRoot, 'api-surface.json');
    await writeFile(inventoryPath, JSON.stringify(createSyntheticInventory(expectedSymbols)));
    const contract = await probeHarness.readCanonicalAuthorSurfaceInventory(inventoryPath);
    await writeSyntheticPackedSdk(fixtureRoot, contract, {
      authorDeclaration: [
        'export type ConstrainedGenericType<K extends "a" | "b"> = Readonly<{ kind: K }>;',
        'export type DefaultedGenericType<T extends { readonly value: string } = { readonly value: string }> = Readonly<{ value: T }>;',
        'export type GenericType<T> = Readonly<{ value: T }>;',
        "export type PluginProtocolClientKind = 'jsonRpc' | 'jsonStream';",
        'export type PluginProtocolClientSpecByKind<K extends PluginProtocolClientKind> = Readonly<{ kind: K }>;',
        'export interface PluginProtocolClientHandle<K extends PluginProtocolClientKind = PluginProtocolClientKind> {',
        '  readonly kind: K;',
        '}',
        'export type TypeOnly = Readonly<{ value: string }>;',
        "export type { TypeOnlyDeclaredClass } from './opaque.js';",
        'export declare const RuntimeValue: Readonly<{ value: string }>;',
        '',
      ].join('\n'),
    });
    await writeFile(
      join(fixtureRoot, 'dist', 'opaque.d.ts'),
      [
        'export declare abstract class TypeOnlyDeclaredClass<T = string> {',
        '  protected readonly opaque: T;',
        '}',
        '',
      ].join('\n'),
    );
    await writeFile(join(fixtureRoot, 'dist', 'opaque.js'), 'export {};\n');

    assert.deepEqual(
      await probeHarness.classifyPackedNormalSurface(fixtureRoot, contract),
      {
        '.': [
          {
            name: 'ConstrainedGenericType',
            runtime: false,
            typeArguments: ['"a" | "b"'],
          },
          {
            name: 'DefaultedGenericType',
            runtime: false,
          },
          {
            name: 'GenericType',
            runtime: false,
            typeArguments: ['unknown'],
          },
          {
            name: 'PluginProtocolClientHandle',
            runtime: false,
            typeArguments: ["'jsonRpc'"],
          },
          {
            name: 'PluginProtocolClientKind',
            runtime: false,
          },
          {
            name: 'PluginProtocolClientSpecByKind',
            runtime: false,
            typeArguments: ["'jsonRpc'"],
          },
          { name: 'RuntimeValue', runtime: true },
          { name: 'TypeOnly', runtime: false },
          { name: 'TypeOnlyDeclaredClass', runtime: false },
        ],
      },
    );
    await writeFile(join(fixtureRoot, 'dist/index.d.ts'), 'export type MissingExport = string;\n');
    await assert.rejects(
      probeHarness.classifyPackedNormalSurface(fixtureRoot, contract),
      /Packed normal surface mismatch for \.: missing ConstrainedGenericType/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('packed declaration classification requires every host declaration and exact host exports', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-host-declaration-'));
  const inventoryPath = join(fixtureRoot, 'api-surface.json');
  try {
    await writeFile(inventoryPath, JSON.stringify(createSyntheticInventory()));
    const contract = await probeHarness.readCanonicalAuthorSurfaceInventory(inventoryPath);
    await writeSyntheticPackedSdk(fixtureRoot, contract, { fileLockDeclaration: null });
    await assert.rejects(
      probeHarness.classifyPackedNormalSurface(fixtureRoot, contract),
      /Packed SDK declaration is missing for \.\/host\/fs\/json-owner-file-lock/u,
    );

    await writeSyntheticPackedSdk(fixtureRoot, contract, {
      fileLockDeclaration: 'export declare function reclaimJsonOwnerFileLockSnapshot(): void;\n',
    });
    await assert.rejects(
      probeHarness.classifyPackedNormalSurface(fixtureRoot, contract),
      /Packed normal surface mismatch for \.\/host\/fs\/json-owner-file-lock: missing withJsonOwnerFileLock/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('packed declaration classification rejects wrong host symbol kind', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-host-kind-'));
  const inventoryPath = join(fixtureRoot, 'api-surface.json');
  try {
    await writeFile(inventoryPath, JSON.stringify(createSyntheticInventory()));
    const contract = await probeHarness.readCanonicalAuthorSurfaceInventory(inventoryPath);
    await writeSyntheticPackedSdk(fixtureRoot, contract, {
      registrationDeclaration: [
        'export type createPluginRegistrationScope = () => unknown;',
        'export interface PluginRegistrationRight {}',
        'export interface PluginAgentRuntimeRegistration {}',
        'export interface PluginRuntimeRegistration {}',
        '',
      ].join('\n'),
    });
    await assert.rejects(
      probeHarness.classifyPackedNormalSurface(fixtureRoot, contract),
      /Packed SDK export kind mismatch for \.\/host\/registration:createPluginRegistrationScope: expected value, received type/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('packed declaration classification rejects wrong author symbol kind', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-author-kind-'));
  const inventoryPath = join(fixtureRoot, 'api-surface.json');
  try {
    await writeFile(inventoryPath, JSON.stringify(createSyntheticInventory()));
    const contract = await probeHarness.readCanonicalAuthorSurfaceInventory(inventoryPath);
    await writeSyntheticPackedSdk(fixtureRoot, contract, {
      authorDeclaration: 'export declare const InventoryOnlyName: string;\n',
    });
    await assert.rejects(
      probeHarness.classifyPackedNormalSurface(fixtureRoot, contract),
      /Packed SDK export kind mismatch for \.:InventoryOnlyName: expected type, received value/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('packed package graph rejects extra entrypoints and wrong conditions before author probes', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-package-graph-'));
  const inventoryPath = join(fixtureRoot, 'api-surface.json');
  try {
    await writeFile(inventoryPath, JSON.stringify(createSyntheticInventory()));
    const contract = await probeHarness.readCanonicalAuthorSurfaceInventory(inventoryPath);
    const canonicalExports = Object.fromEntries(
      contract.inventory.entrypoints.map((entrypoint) => [
        entrypoint.specifier,
        entrypoint.conditions,
      ]),
    );

    await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify({
      type: 'module',
      exports: {
        ...canonicalExports,
        './unexpected': {
          types: './dist/unexpected.d.ts',
          default: './dist/unexpected.js',
        },
      },
    }));
    await assert.rejects(
      probeHarness.classifyPackedNormalSurface(fixtureRoot, contract),
      /Packed SDK package export graph mismatch/u,
    );

    await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify({
      type: 'module',
      exports: {
        ...canonicalExports,
        '.': {
          ...canonicalExports['.'],
          default: './dist/wrong-index.js',
        },
      },
    }));
    await assert.rejects(
      probeHarness.classifyPackedNormalSurface(fixtureRoot, contract),
      /Packed SDK package export graph mismatch/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('packed SDK requires publication-ready package metadata before accepting its API surface', async () => {
  assert.equal(
    typeof probeHarness.assertPackedPublishReadyPackageMetadata,
    'function',
    'the external packed consumer must reject pre-publication SDK package metadata',
  );

  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-package-metadata-'));
  const packageJsonPath = join(fixtureRoot, 'package.json');
  try {
    await writeFile(packageJsonPath, JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      version: '1.0.0',
      private: false,
    }));
    await assert.doesNotReject(
      probeHarness.assertPackedPublishReadyPackageMetadata(fixtureRoot),
    );

    await writeFile(packageJsonPath, JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      private: false,
    }));
    await assert.rejects(
      probeHarness.assertPackedPublishReadyPackageMetadata(fixtureRoot),
      /Packed SDK package must not use placeholder version 0\.0\.0 at publication readiness/u,
    );

    await writeFile(packageJsonPath, JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      version: '1.0.0',
      private: true,
    }));
    await assert.rejects(
      probeHarness.assertPackedPublishReadyPackageMetadata(fixtureRoot),
      /Packed SDK package must not remain private at publication readiness/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('NodeNext compile uses the repository native TypeScript invocation in the consumer cwd', () => {
  assert.equal(
    typeof probeHarness.runNodeNextTypecheck,
    'function',
    'packed NodeNext compilation must expose its canonical compiler boundary',
  );

  const consumerDir = join(repoRoot, '.project', 'tmp', 'plugin-sdk-consumer-test');
  const canonicalInvocation = resolveTypeScriptCliInvocation({
    repoRoot,
    workspaceDir: consumerDir,
    processExecPath: process.execPath,
  });
  let observed;

  probeHarness.runNodeNextTypecheck(consumerDir, {
    spawnSyncImpl(command, args, options) {
      observed = { command, args, options };
      return spawnResult({ status: 0, signal: null });
    },
  });

  assert.equal(observed.command, canonicalInvocation.command);
  assert.deepEqual(observed.args, [
    ...canonicalInvocation.argsPrefix,
    '-p',
    'tsconfig.json',
  ]);
  assert.equal(observed.options.cwd, consumerDir);
  assert.equal(observed.options.timeout, 120_000);
  assert.equal(observed.options.encoding, 'utf8');
  assert.equal(observed.options.env.CI, '1');
  assert.equal(observed.options.env.npm_config_ignore_scripts, 'false');

  const compilerEntrypoint = observed.args[0].replaceAll('\\', '/');
  assert.match(compilerEntrypoint, /\/node_modules\/@typescript\/native\//u);
  assert.doesNotMatch(compilerEntrypoint, /\/node_modules\/typescript\/(?:bin|lib)\/tsc/u);
});

test('npm stages use the Windows-safe command shim without changing their arguments', () => {
  let observed;

  runCommand('npm', ['pack', '--silent'], {
    stage: 'npm-pack',
    platform: 'win32',
    comspec: 'C:\\Windows\\System32\\cmd.exe',
    env: { npm_execpath: '' },
    spawnSyncImpl(command, args, options) {
      observed = { command, args, options };
      return spawnResult({ status: 0, signal: null });
    },
  });

  assert.equal(observed.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(observed.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(observed.args[3], /npm\.cmd/u);
  assert.match(observed.args[3], /pack/u);
  assert.match(observed.args[3], /--silent/u);
  assert.equal(observed.options.windowsVerbatimArguments, true);
});

test('npm stages cannot inherit a prepack lifecycle-script bypass', () => {
  let observedEnv;

  runCommand('npm', ['pack'], {
    stage: 'npm-pack',
    env: {
      npm_config_ignore_scripts: 'true',
      NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    },
    spawnSyncImpl(_command, _args, options) {
      observedEnv = options.env;
      return spawnResult({ status: 0, signal: null });
    },
  });

  assert.equal(observedEnv.npm_config_ignore_scripts, 'false');
  assert.deepEqual(
    Object.keys(observedEnv).filter((key) => key.toLowerCase() === 'npm_config_ignore_scripts'),
    ['npm_config_ignore_scripts'],
  );
});

test('failed commands report bounded stage and process outcome truth', () => {
  const timeoutError = Object.assign(new Error('credential-value-must-not-appear'), {
    code: 'ETIMEDOUT',
  });
  const cases = [
    {
      name: 'timeout',
      result: spawnResult({ status: null, signal: 'SIGTERM', error: timeoutError }),
      expected: {
        status: 'null',
        signal: 'SIGTERM',
        timedOut: 'true',
        error: 'ETIMEDOUT',
      },
    },
    {
      name: 'nonzero exit',
      result: spawnResult({ status: 7, signal: null }),
      expected: {
        status: '7',
        signal: 'null',
        timedOut: 'false',
        error: 'none',
      },
    },
    {
      name: 'signal termination',
      result: spawnResult({ status: null, signal: 'SIGKILL' }),
      expected: {
        status: 'null',
        signal: 'SIGKILL',
        timedOut: 'false',
        error: 'none',
      },
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => runCommand('npm', ['pack'], {
        stage: 'npm-pack',
        spawnSyncImpl: () => fixture.result,
      }),
      (error) => {
        assert.equal(error instanceof Error, true, fixture.name);
        assert.match(error.message, /^Command failed at stage: npm-pack$/mu, fixture.name);
        assert.match(error.message, new RegExp(`^status: ${fixture.expected.status}$`, 'mu'), fixture.name);
        assert.match(error.message, new RegExp(`^signal: ${fixture.expected.signal}$`, 'mu'), fixture.name);
        assert.match(error.message, new RegExp(`^timedOut: ${fixture.expected.timedOut}$`, 'mu'), fixture.name);
        assert.match(error.message, new RegExp(`^error: ${fixture.expected.error}$`, 'mu'), fixture.name);
        assert.doesNotMatch(error.message, /credential-value-must-not-appear/u, fixture.name);
        return true;
      },
    );
  }
});
