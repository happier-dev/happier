import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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

test('normal-surface source generation compiles every retained type and behavior-consumes runtime values', () => {
  assert.equal(
    typeof probeHarness.renderNormalSurfaceProbeSource,
    'function',
    'the packed consumer must generate its source from the canonical normal-surface contract',
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
      { name: 'RootTypeOnly', runtime: false },
      { name: 'PluginError', runtime: true },
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
    /ui_host_bootstrap_missing/u,
  );
  assert.doesNotMatch(
    source,
    /runtime0\.RootTypeOnly/u,
    'type-only declarations must not be required at runtime',
  );
  assert.match(source, /normal-surface:contract-ok/u);
  assert.doesNotMatch(source, /normal-surface:4:2/u);
  assert.throws(
    () => probeHarness.renderNormalSurfaceProbeSource({
      '.': [{ name: 'UnexpectedRuntimeValue', runtime: true }],
    }),
    /runtime export lacks a behavior consumer: @happier-dev\/plugin-sdk:UnexpectedRuntimeValue/u,
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

test('canonical SDK contract drives the exact eight supported paths', async () => {
  assert.equal(typeof probeHarness.readCanonicalNormalSurfaceContract, 'function');
  const contract = await probeHarness.readCanonicalNormalSurfaceContract();

  assert.deepEqual(Object.keys(contract.allowlist), [
    '.',
    './manifest',
    './runtime',
    './agent-runtime',
    './ui',
    './ui/client',
    './ui/build',
    './testing',
  ]);
  for (const names of Object.values(contract.allowlist)) {
    assert.ok(names.length > 0, 'every supported path must name its retained public contracts');
  }
  assert.equal(contract.allowlist['./manifest'].includes('PluginToolContributionV2'), false);
  assert.equal(contract.allowlist['./manifest'].includes('PluginAgentAcpTransport'), false);
  assert.equal(contract.allowlist['./runtime'].includes('PluginActivationApi'), false);
});

test('packed consumers read the normal surface from a retained non-test contract owner', async () => {
  const source = await readFile(new URL('./run-probes.mjs', import.meta.url), 'utf8');

  assert.match(
    source,
    /src['"], ['"]normalSurfaceContract\.ts['"]/u,
    'the packed probe must consume the retained SDK contract owner',
  );
  assert.doesNotMatch(
    source,
    /normalSurfaceContract\.test\.ts/u,
    'a test file cannot be the packed probe oracle',
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

test('packed negative consumer rejects every retired Agent runtime V1 alias', () => {
  assert.equal(typeof probeHarness.renderNegativeTypeProbeSource, 'function');
  const source = probeHarness.renderNegativeTypeProbeSource();

  for (const [entrypoint, name] of [
    ['runtime', 'RuntimeCoreV1'],
    ['agent-runtime', 'AcpSessionRuntimeV1'],
    ['agent-runtime', 'AgentRuntimeV1'],
  ]) {
    assert.ok(
      source.includes(
        `import type { ${name} } from "@happier-dev/plugin-sdk/${entrypoint}";`,
      ),
      `${name} must remain an explicit packed negative import`,
    );
  }
});

test('packed negative consumer rejects removed host-private runtime services and DTOs', () => {
  assert.equal(typeof probeHarness.renderNegativeTypeProbeSource, 'function');
  const source = probeHarness.renderNegativeTypeProbeSource();

  for (const name of [
    'PluginExternalSessionCandidate',
    'PluginExternalSessionRef',
    'PluginExternalSessionsService',
    'PluginExternalTranscriptFollowEvent',
    'PluginExternalTranscriptFollowResult',
    'PluginExternalTranscriptItem',
    'PluginProjectsService',
  ]) {
    assert.ok(
      source.includes(
        `import type { ${name} } from "@happier-dev/plugin-sdk/runtime";`,
      ),
      `${name} must remain an explicit packed negative import`,
    );
  }
});

test('Vite consumer compiles against the retained UI render-surface contract', async () => {
  const source = await readFile(new URL('./run-probes.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /import type \{ PluginUiRenderSurface \} from "@happier-dev\/plugin-sdk\/ui";/u,
  );
  assert.doesNotMatch(
    source,
    /import type \{ PluginUiSurfaceModule \} from "@happier-dev\/plugin-sdk\/ui";/u,
  );
});

test('packed declaration classification distinguishes runtime values from type-only exports', async () => {
  assert.equal(typeof probeHarness.classifyPackedNormalSurface, 'function');
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-classifier-'));
  try {
    await mkdir(join(fixtureRoot, 'dist'), { recursive: true });
    await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify({
      type: 'module',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
      },
    }));
    await writeFile(join(fixtureRoot, 'dist/index.d.ts'), [
      'export type ConstrainedGenericType<K extends "a" | "b"> = Readonly<{ kind: K }>;',
      'export type GenericType<T> = Readonly<{ value: T }>;',
      "export type PluginProtocolClientKind = 'jsonRpc' | 'jsonStream';",
      'export type PluginProtocolClientSpecByKind<K extends PluginProtocolClientKind> = Readonly<{ kind: K }>;',
      'export interface PluginProtocolClientHandle<K extends PluginProtocolClientKind = PluginProtocolClientKind> {',
      '  readonly kind: K;',
      '}',
      'export type TypeOnly = Readonly<{ value: string }>;',
      'export declare const RuntimeValue: Readonly<{ value: string }>;',
      '',
    ].join('\n'));

    assert.deepEqual(
      await probeHarness.classifyPackedNormalSurface(fixtureRoot, {
        '.': [
          'ConstrainedGenericType',
          'GenericType',
          'PluginProtocolClientHandle',
          'PluginProtocolClientKind',
          'PluginProtocolClientSpecByKind',
          'RuntimeValue',
          'TypeOnly',
        ],
      }),
      {
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
        ],
      },
    );
    await assert.rejects(
      probeHarness.classifyPackedNormalSurface(fixtureRoot, {
        '.': ['MissingExport'],
      }),
      /Packed normal surface mismatch for \.: missing MissingExport/u,
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
