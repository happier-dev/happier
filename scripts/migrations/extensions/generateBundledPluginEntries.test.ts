import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sanitizeBundledPackageJson } from '@happier-dev/cli-common/workspaces';
import {
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from '../../../packages/cli-common/workspaceBundleLock.mjs';

import {
  pluginPackageNameToPackageId,
  readBundledPluginPackageNames,
} from './bundledPluginMembership.ts';
import { main as generateBundledPluginEntries } from './generateBundledPluginEntries.ts';

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function runGeneratorCliWithEnv(
  repoRoot: string,
  mode: 'write' | 'check',
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const generatorPath = fileURLToPath(new URL('./generateBundledPluginEntries.ts', import.meta.url));
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', generatorPath, '--root', repoRoot, '--mode', mode],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error(`generator CLI timed out while reentering inherited workspace lock: ${stderr}`));
    }, 30_000);

    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && signal === null) {
        resolveRun();
        return;
      }
      rejectRun(new Error(
        `generator CLI failed while reentering inherited workspace lock: code=${String(code)} signal=${String(signal)} ${stderr}`,
      ));
    });
  });
}

const MUTABLE_GENERATOR_WORKSPACE_IMPORTS = Object.freeze([
  '@happier-dev/agents',
  '@happier-dev/cli-common/workspaces',
  '@happier-dev/protocol',
] as const);

function createGeneratorImportProbeLoader(loaderPath: string): void {
  writeFileSync(
    loaderPath,
    [
      "const workspaceSpecifiers = new Set(JSON.parse(process.env.HAPPIER_GENERATOR_IMPORT_PROBE_SPECIFIERS ?? '[]'));",
      '',
      'export async function resolve(specifier, context, nextResolve) {',
      '  if (!workspaceSpecifiers.has(specifier)) return nextResolve(specifier, context);',
      '  const resolved = await nextResolve(specifier, context);',
      '  const wrapperSource = [',
      '    "import { appendFileSync } from \'node:fs\';",',
      '    `appendFileSync(process.env.HAPPIER_GENERATOR_IMPORT_PROBE_MARKER, ${JSON.stringify(`workspace:${specifier}\\n`)}, "utf8");`,',
      '    `export * from ${JSON.stringify(resolved.url)};`,',
      '  ].join("\\n");',
      '  return {',
      '    url: `data:text/javascript;base64,${Buffer.from(wrapperSource).toString("base64")}`,',
      '    shortCircuit: true,',
      '  };',
      '}',
      '',
      'export async function load(url, context, nextLoad) {',
      '  const loaded = await nextLoad(url, context);',
      '  if (url !== process.env.HAPPIER_GENERATOR_IMPORT_PROBE_ENTRY_URL) return loaded;',
      '  const source = typeof loaded.source === "string"',
      '    ? loaded.source',
      '    : Buffer.from(loaded.source).toString("utf8");',
      '  return {',
      '    ...loaded,',
      '    source: [',
      '      "import { appendFileSync as appendGeneratorImportProbeMarker } from \'node:fs\';",',
      '      "appendGeneratorImportProbeMarker(process.env.HAPPIER_GENERATOR_IMPORT_PROBE_MARKER, \'entry\\\\n\', \'utf8\');",',
      '      source,',
      '    ].join("\\n"),',
      '  };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function waitForGeneratorImportProbeEntry(markerPath: string, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(markerPath) && readFileSync(markerPath, 'utf8').includes('entry\n')) return;
    await delay(25);
  }
  throw new Error(`${label} did not evaluate the generator entry within 15 seconds`);
}

function startGeneratorImportProbe(input: Readonly<{
  invocation: 'direct' | 'programmatic';
  loaderPath: string;
  markerPath: string;
  programmaticProbePath: string;
  repoRoot: string;
}>): Readonly<{
  child: ReturnType<typeof spawn>;
  completion: Promise<void>;
}> {
  const generatorPath = fileURLToPath(new URL('./generateBundledPluginEntries.ts', import.meta.url));
  const generatorUrl = pathToFileURL(generatorPath).href;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HAPPIER_GENERATOR_IMPORT_PROBE_ENTRY_URL: generatorUrl,
    HAPPIER_GENERATOR_IMPORT_PROBE_MARKER: input.markerPath,
    HAPPIER_GENERATOR_IMPORT_PROBE_ROOT: input.repoRoot,
    HAPPIER_GENERATOR_IMPORT_PROBE_SPECIFIERS: JSON.stringify(MUTABLE_GENERATOR_WORKSPACE_IMPORTS),
    HAPPIER_GENERATOR_IMPORT_PROBE_TARGET_URL: generatorUrl,
  };
  delete env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;

  const child = spawn(
    process.execPath,
    input.invocation === 'direct'
      ? [
          '--experimental-strip-types',
          '--experimental-loader',
          input.loaderPath,
          generatorPath,
          '--root',
          input.repoRoot,
          '--mode',
          'write',
        ]
      : [
          '--experimental-strip-types',
          '--experimental-loader',
          input.loaderPath,
          input.programmaticProbePath,
        ],
    {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  const completion = new Promise<void>((resolveCompletion, rejectCompletion) => {
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectCompletion(new Error(`${input.invocation} generator import probe timed out: ${stderr}`));
    }, 30_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectCompletion(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && signal === null) {
        resolveCompletion();
        return;
      }
      rejectCompletion(new Error(
        `${input.invocation} generator import probe failed: code=${String(code)} signal=${String(signal)} ${stderr}`,
      ));
    });
  });
  return { child, completion };
}

function readGeneratedAgentBlock(output: string, agentId: string, nextAgentId?: string): string {
  const startMarker = `"${agentId}": Object.freeze((`;
  const start = output.indexOf(startMarker);
  assert.notEqual(start, -1, `expected generated ${agentId} block`);
  if (!nextAgentId) return output.slice(start);

  const end = output.indexOf(`\n  "${nextAgentId}": Object.freeze((`, start + startMarker.length);
  assert.notEqual(end, -1, `expected generated ${nextAgentId} block after ${agentId}`);
  return output.slice(start, end);
}

function readGeneratedAgentIdsOutput(repoRoot: string): string {
  const agentIdsOutPath = resolve(repoRoot, 'packages/agents/src/generated/agentIds.ts');
  assert.equal(existsSync(agentIdsOutPath), true, 'expected generated agent id output');
  return readFileSync(agentIdsOutPath, 'utf8');
}

function readGeneratedProtocolAgentProviderIdsOutput(repoRoot: string): string {
  const agentIdsOutPath = resolve(repoRoot, 'packages/protocol/src/generated/providers/agentProviderIdsV1.ts');
  assert.equal(existsSync(agentIdsOutPath), true, 'expected generated protocol agent provider id output');
  return readFileSync(agentIdsOutPath, 'utf8');
}

function readGeneratedSessionControlAdaptersOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'packages/agents/src/generated/sessionControlAdapters.ts');
  assert.equal(existsSync(outPath), true, 'expected generated session-control adapter output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedRuntimeDescriptorReadersOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'packages/agents/src/generated/runtimeDescriptorReaders.ts');
  assert.equal(existsSync(outPath), true, 'expected generated runtime descriptor reader output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedProtocolRuntimeDescriptorContributionsOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'packages/protocol/src/agents/generated/runtime/descriptorContributionsV1.ts');
  assert.equal(existsSync(outPath), true, 'expected generated protocol runtime descriptor contribution output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedProtocolRuntimeDescriptorModuleOutput(repoRoot: string, agentId: string): string {
  const outPath = resolve(repoRoot, `packages/protocol/src/agents/generated/runtime/descriptors/${agentId}.ts`);
  assert.equal(existsSync(outPath), true, `expected generated protocol runtime descriptor module for ${agentId}`);
  return readFileSync(outPath, 'utf8');
}

function readGeneratedProtocolBuiltInBackendProfilesOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'packages/protocol/src/agents/generated/profiles/builtInBackendProfiles.ts');
  assert.equal(existsSync(outPath), true, 'expected generated protocol built-in backend profiles output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedProtocolMemoryDefaultsOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'packages/protocol/src/agents/generated/memory/defaults.ts');
  assert.equal(existsSync(outPath), true, 'expected generated protocol memory defaults output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedProtocolExternalSessionSourcesOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'packages/protocol/src/agents/generated/externalSession/sources.ts');
  assert.equal(existsSync(outPath), true, 'expected generated protocol external-session sources output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedPromptAssetPluginDescriptorsOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'apps/cli/src/prompts/assets/generated/pluginDescriptors.ts');
  assert.equal(existsSync(outPath), true, 'expected generated prompt asset plugin descriptor output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedUiVoiceEntriesOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts');
  assert.equal(existsSync(outPath), true, 'expected generated UI voice entries output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedUiVoiceRuntimeEntriesOutput(
  repoRoot: string,
  platform: 'web' | 'ios' | 'android',
): string {
  const suffix = platform === 'web' ? '' : `.${platform}`;
  const outPath = resolve(
    repoRoot,
    `apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries${suffix}.ts`,
  );
  assert.equal(
    existsSync(outPath),
    true,
    `expected generated ${platform} UI voice runtime entries output`,
  );
  return readFileSync(outPath, 'utf8');
}

function readGeneratedStringArray(output: string, symbol: string): readonly string[] {
  const match = output.match(new RegExp(`export const ${symbol} = Object\\.freeze\\(\\[([\\s\\S]*?)\\] as const\\);`));
  assert.ok(match, `expected generated ${symbol} array`);
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
}

function assertNoExecutableUiProjectionImports(
  output: string,
  opts: { allowPluginUiBehaviorImports?: boolean } = {},
): void {
  if (opts.allowPluginUiBehaviorImports !== true) {
    assert.doesNotMatch(output, /@happier-dev\/plugins-[^'"]+\/ui/);
  }
  assert.doesNotMatch(output, /@\/agents\/providers\/(?:codex|claude|opencode|gemini|pi|ohMyPi|kiro|auggie|kimi|kilo|copilot|cursor)\//);
  assert.doesNotMatch(output, /from '\.\/bundled\/(?:codex|claude|opencode|gemini|pi|ohMyPi|kiro|auggie|kimi|kilo|copilot|cursor)\//);
}

test('serializes generator discovery, check, and writes through the workspace bundle lock', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-bundled-generator-lock-'));
  const packageRoot = resolve(repoRoot, 'packages/plugins/descriptor');
  const manifestPath = resolve(packageRoot, 'src/manifest.ts');
  const generatedPath = resolve(
    repoRoot,
    'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts',
  );
  const lockPath = resolveWorkspaceBundleLockPath(repoRoot);

  let releaseOwner: (() => void) | undefined;
  let ownerPromise: Promise<void> | undefined;
  let invocationPromise: Promise<unknown> | undefined;

  try {
    writeJson(resolve(packageRoot, 'package.json'), {
      name: '@happier-dev/plugins-descriptor',
      version: '1.2.3',
    });
    mkdirSync(resolve(packageRoot, 'src'), { recursive: true });
    writeFileSync(
      manifestPath,
      pluginManifestSource({
        id: 'happier.fixture.descriptor',
        packageVersion: '1.2.3',
        daemon: false,
      }),
      'utf8',
    );
    writeGeneratorOutputScaffold(repoRoot);

    const baselineStartedAt = Date.now();
    await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
    const baselineDurationMs = Date.now() - baselineStartedAt;
    const observationMs = Math.max(250, Math.min(2_000, baselineDurationMs * 4));
    const baselineOutput = readFileSync(generatedPath, 'utf8');

    let signalOwnerAcquired: (() => void) | undefined;
    const ownerAcquired = new Promise<void>((resolveAcquired) => {
      signalOwnerAcquired = resolveAcquired;
    });
    let releaseWriteOwner!: () => void;
    const holdOwner = new Promise<void>((resolveOwner) => {
      releaseWriteOwner = resolveOwner;
      releaseOwner = resolveOwner;
    });
    ownerPromise = withWorkspaceBundleLock(
      async () => {
        signalOwnerAcquired?.();
        await holdOwner;
      },
      { lockPath },
    );
    await ownerAcquired;

    writeJson(resolve(packageRoot, 'package.json'), {
      name: '@happier-dev/plugins-descriptor',
      version: '2.0.0',
    });
    writeFileSync(
      manifestPath,
      pluginManifestSource({
        id: 'happier.fixture.descriptor',
        packageVersion: '2.0.0',
        daemon: false,
      }),
      'utf8',
    );

    let writeSettled = false;
    invocationPromise = generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write'])
      .finally(() => {
        writeSettled = true;
      });
    await delay(observationMs);

    assert.equal(writeSettled, false, 'write invocation must wait for the live workspace owner');
    assert.equal(
      readFileSync(generatedPath, 'utf8'),
      baselineOutput,
      'write invocation must not mutate generated output while another owner holds the lock',
    );

    releaseWriteOwner();
    releaseOwner = undefined;
    await ownerPromise;
    ownerPromise = undefined;
    await invocationPromise;
    invocationPromise = undefined;
    const updatedOutput = readFileSync(generatedPath, 'utf8');
    assert.notEqual(updatedOutput, baselineOutput);

    signalOwnerAcquired = undefined;
    const checkOwnerAcquired = new Promise<void>((resolveAcquired) => {
      signalOwnerAcquired = resolveAcquired;
    });
    let releaseCheckOwner!: () => void;
    const holdCheckOwner = new Promise<void>((resolveOwner) => {
      releaseCheckOwner = resolveOwner;
      releaseOwner = resolveOwner;
    });
    ownerPromise = withWorkspaceBundleLock(
      async () => {
        signalOwnerAcquired?.();
        await holdCheckOwner;
      },
      { lockPath },
    );
    await checkOwnerAcquired;

    writeJson(resolve(packageRoot, 'package.json'), {
      name: '@happier-dev/plugins-descriptor',
      version: '3.0.0',
    });
    writeFileSync(
      manifestPath,
      pluginManifestSource({
        id: 'happier.fixture.descriptor',
        packageVersion: '3.0.0',
        daemon: false,
      }),
      'utf8',
    );

    let checkSettled = false;
    const checkInvocationPromise = generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check'])
      .then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      )
      .finally(() => {
        checkSettled = true;
      });
    invocationPromise = checkInvocationPromise;
    await delay(observationMs);

    assert.equal(checkSettled, false, 'check invocation must wait for the live workspace owner');

    releaseCheckOwner();
    releaseOwner = undefined;
    await ownerPromise;
    ownerPromise = undefined;
    const checkResult = await checkInvocationPromise;
    invocationPromise = undefined;
    assert.equal(checkResult.status, 'rejected');
    assert.match(String(checkResult.error), /generated output differs/u);

    await withWorkspaceBundleLock(
      async ({ heldLockValue }) => {
        await runGeneratorCliWithEnv(repoRoot, 'write', {
          ...process.env,
          HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
        });
      },
      { lockPath },
    );
    assert.match(readFileSync(generatedPath, 'utf8'), /3\.0\.0/u);
  } finally {
    releaseOwner?.();
    await Promise.allSettled([
      ...(ownerPromise ? [ownerPromise] : []),
      ...(invocationPromise ? [invocationPromise] : []),
    ]);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('does not evaluate mutable workspace modules before direct or programmatic main acquires the root lock', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-bundled-generator-import-lock-'));
  const packageRoot = resolve(repoRoot, 'packages/plugins/descriptor');
  const loaderPath = resolve(repoRoot, 'generator-import-probe-loader.mjs');
  const programmaticProbePath = resolve(repoRoot, 'generator-programmatic-probe.mjs');
  const directMarkerPath = resolve(repoRoot, 'direct-import-probe.log');
  const programmaticMarkerPath = resolve(repoRoot, 'programmatic-import-probe.log');
  const generatedPath = resolve(
    repoRoot,
    'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts',
  );
  const lockPath = resolveWorkspaceBundleLockPath(repoRoot);

  let releaseOwner: (() => void) | undefined;
  let ownerPromise: Promise<void> | undefined;
  const probes: Array<ReturnType<typeof startGeneratorImportProbe>> = [];

  try {
    writeJson(resolve(packageRoot, 'package.json'), {
      name: '@happier-dev/plugins-descriptor',
      version: '1.2.3',
    });
    mkdirSync(resolve(packageRoot, 'src'), { recursive: true });
    writeFileSync(
      resolve(packageRoot, 'src/manifest.ts'),
      pluginManifestSource({
        id: 'happier.fixture.descriptor',
        packageVersion: '1.2.3',
        daemon: false,
      }),
      'utf8',
    );
    writeGeneratorOutputScaffold(repoRoot);
    createGeneratorImportProbeLoader(loaderPath);
    writeFileSync(
      programmaticProbePath,
      [
        'const { main } = await import(process.env.HAPPIER_GENERATOR_IMPORT_PROBE_TARGET_URL);',
        'await main([',
        '  "--root",',
        '  process.env.HAPPIER_GENERATOR_IMPORT_PROBE_ROOT,',
        '  "--mode",',
        '  "write",',
        ']);',
        '',
      ].join('\n'),
      'utf8',
    );

    let signalOwnerAcquired: (() => void) | undefined;
    const ownerAcquired = new Promise<void>((resolveAcquired) => {
      signalOwnerAcquired = resolveAcquired;
    });
    let releaseImportProbeOwner!: () => void;
    const holdOwner = new Promise<void>((resolveOwner) => {
      releaseImportProbeOwner = resolveOwner;
      releaseOwner = resolveOwner;
    });
    ownerPromise = withWorkspaceBundleLock(
      async () => {
        signalOwnerAcquired?.();
        await holdOwner;
      },
      { lockPath },
    );
    await ownerAcquired;

    probes.push(
      startGeneratorImportProbe({
        invocation: 'direct',
        loaderPath,
        markerPath: directMarkerPath,
        programmaticProbePath,
        repoRoot,
      }),
      startGeneratorImportProbe({
        invocation: 'programmatic',
        loaderPath,
        markerPath: programmaticMarkerPath,
        programmaticProbePath,
        repoRoot,
      }),
    );
    await Promise.all([
      waitForGeneratorImportProbeEntry(directMarkerPath, 'direct CLI'),
      waitForGeneratorImportProbeEntry(programmaticMarkerPath, 'programmatic main'),
    ]);

    for (const [index, markerPath] of [directMarkerPath, programmaticMarkerPath].entries()) {
      const invocation = index === 0 ? 'direct CLI' : 'programmatic main';
      const marker = readFileSync(markerPath, 'utf8');
      assert.doesNotMatch(
        marker,
        /^workspace:/mu,
        `${invocation} must not evaluate mutable workspace modules while another owner holds the root lock`,
      );
      assert.equal(probes[index].child.exitCode, null, `${invocation} must wait for the root lock owner`);
    }
    assert.equal(existsSync(generatedPath), false);

    releaseImportProbeOwner();
    releaseOwner = undefined;
    await ownerPromise;
    ownerPromise = undefined;
    await Promise.all(probes.map((probe) => probe.completion));

    for (const markerPath of [directMarkerPath, programmaticMarkerPath]) {
      const marker = readFileSync(markerPath, 'utf8');
      const markerLines = new Set(marker.trim().split('\n'));
      for (const specifier of MUTABLE_GENERATOR_WORKSPACE_IMPORTS) {
        assert.equal(
          markerLines.has(`workspace:${specifier}`),
          true,
          `expected mutable workspace import after releasing the root lock: ${specifier}`,
        );
      }
    }
    assert.equal(existsSync(generatedPath), true);
  } finally {
    releaseOwner?.();
    for (const probe of probes) {
      if (probe.child.exitCode === null) probe.child.kill('SIGKILL');
    }
    await Promise.allSettled([
      ...(ownerPromise ? [ownerPromise] : []),
      ...probes.map((probe) => probe.completion),
    ]);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('keeps first-party Agent UI descriptors generator-private behind narrow behavior exports', () => {
  const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const agentPackages = [
    'antigravity',
    'auggie',
    'claude',
    'codex',
    'copilot',
    'gemini',
    'grok',
    'kilo',
    'kimi',
    'kiro',
    'opencode',
    'pi',
  ] as const;
  const behaviorPackages = new Set(['auggie', 'claude', 'codex', 'pi']);

  for (const packageId of agentPackages) {
    const packageJson = JSON.parse(readFileSync(
      resolve(sourceRoot, 'packages/plugins', packageId, 'package.json'),
      'utf8',
    )) as Readonly<{ exports?: Readonly<Record<string, unknown>> }>;
    const packageRoot = readFileSync(
      resolve(sourceRoot, 'packages/plugins', packageId, 'src/index.ts'),
      'utf8',
    );
    assert.equal(packageJson.exports?.['./ui'], undefined, `${packageId} must not expose a broad UI barrel`);
    assert.doesNotMatch(packageRoot, /ui\/(?:index|descriptor)/u, `${packageId} root must not expose UI descriptors`);
    assert.equal(
      packageJson.exports?.['./ui/behavior'] !== undefined,
      behaviorPackages.has(packageId),
      `${packageId} behavior export mismatch`,
    );
  }

  const cursorRoot = readFileSync(resolve(sourceRoot, 'packages/plugins/cursor/src/index.ts'), 'utf8');
  assert.doesNotMatch(cursorRoot, /ui\/descriptor/u);

  const generatedBehaviorProjection = readFileSync(
    resolve(sourceRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts'),
    'utf8',
  );
  assert.doesNotMatch(generatedBehaviorProjection, /plugins-[^'"]+\/ui['"]/u);
  assert.match(generatedBehaviorProjection, /plugins-auggie\/ui\/behavior/u);
});

test('keeps every bundled first-party manifest behind an inert package subpath', () => {
  const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));

  for (const packageName of readBundledPluginPackageNames(sourceRoot)) {
    const packageId = pluginPackageNameToPackageId(packageName);
    const packageJson = JSON.parse(readFileSync(
      resolve(sourceRoot, 'packages/plugins', packageId, 'package.json'),
      'utf8',
    )) as Readonly<{ exports?: Readonly<Record<string, unknown>> }>;

    assert.deepEqual(
      packageJson.exports?.['./manifest'],
      {
        types: './dist/manifest.d.ts',
        default: './dist/manifest.js',
      },
      `${packageName} must expose its cold manifest without evaluating the package root`,
    );
  }
});

test('keeps Kiro UI projection facts descriptor-owned instead of hardcoded in the generator', () => {
  const source = readFileSync(new URL('./generateBundledPluginEntries.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /renderKiroGeneratedUiProjectionLines/);
  assert.doesNotMatch(source, /agentId:\s*'kiro'[^}]+renderLines/u);
});

test('keeps bundled Agent connected-service labels and CLI glyphs descriptor-owned', () => {
  const source = readFileSync(new URL('./generateBundledPluginEntries.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /AGENT_CONNECTED_SERVICE_LABEL_BY_TOKEN_ID/);
  assert.doesNotMatch(source, /AGENT_CLI_GLYPH_BY_TOKEN_ID/);
});

test('keeps every first-party Agent on strict manifest CLI metadata', () => {
  const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const firstPartyAgentPackages = [
    'antigravity',
    'auggie',
    'claude',
    'codex',
    'copilot',
    'cursor',
    'gemini',
    'grok',
    'kilo',
    'kimi',
    'kiro',
    'ohmypi',
    'opencode',
    'pi',
    'qwen',
    'review-coderabbit',
    'review-deepsec',
  ] as const;

  for (const packageId of firstPartyAgentPackages) {
    const manifest = readFileSync(
      resolve(sourceRoot, 'packages/plugins', packageId, 'src/manifest.ts'),
      'utf8',
    );
    const definition = readFileSync(
      resolve(sourceRoot, 'packages/plugins', packageId, 'src/agent/definition.ts'),
      'utf8',
    );
    assert.match(manifest, /\bcli:\s*\{/u, `${packageId} must author strict manifest CLI metadata`);
    assert.doesNotMatch(
      definition,
      /\b(?:agentCliRuntime|authProbeConfig|localCli):/u,
      `${packageId} must not retain legacy CLI/auth source authority`,
    );
  }
});

test('emits only bundled locators and structured trusted bindings into the CLI registry artifact', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ws1-bundled-binding-only-'));
  writeJson(resolve(repoRoot, 'packages/plugins/descriptor/package.json'), {
    name: '@happier-dev/plugins-descriptor',
    version: '1.2.3',
  });
  mkdirSync(resolve(repoRoot, 'packages/plugins/descriptor/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/descriptor/src/manifest.ts'),
    pluginManifestSource({ id: 'happier.fixture.descriptor', daemon: false }),
    'utf8',
  );
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const output = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(output, /BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS/);
  assert.doesNotMatch(output, /\\\\n/);
  assert.match(output, /BUNDLED_FIRST_PARTY_IMPLEMENTATION_BINDINGS/);
  assert.match(output, /pluginId:\s*"happier\.fixture\.descriptor"/);
  assert.match(output, /manifest:\s*DESCRIPTOR_PLUGIN_MANIFEST/);
  assert.match(output, /daemonEntryPath:\s*null/);
  assert.doesNotMatch(output, /activationEvents/);
  assert.doesNotMatch(output, /BUNDLED_FIRST_PARTY_(?:AGENT|PROVIDER|SCM|MCP|CONNECTED|INSTALLABLE|EXECUTION_RUN).*CONTRIBUTIONS/);
});

test('generates complete built-in legacy Connected Account compatibility from plugin-owned declarations', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-connected-account-compatibility-'));
  const exactPeerOperations = [
    'account_list',
    'credential_read',
    'one_shot_materialization',
  ] as const;
  const revisionedPeerOperations = [
    'account_list',
    'credential_read',
    'credential_write',
    'credential_delete',
    'credential_health',
    'refresh_lease',
    'one_shot_materialization',
    'quota_read',
    'quota_refresh',
    'quota_poll',
    'provider_account_usage_write',
  ] as const;
  const writePlugin = (
    packageId: string,
    pluginId: string,
    descriptors: readonly Readonly<{
      legacyServiceId: string;
      id: string;
      defaultModeId: string;
      modeByCredentialKind: Readonly<
        Partial<Record<'oauth' | 'token', string>>
      >;
      unsupportedModeByCredentialKind?: Readonly<
        Partial<Record<'oauth' | 'token', string>>
      >;
      peerOperations: Readonly<{
        exactV0_2_1: readonly string[];
        revisionedV2V3: readonly string[];
      }>;
      exactV0_2_1ReaderQuotaProjection: boolean;
    }>[],
  ): void => {
    writeJson(resolve(repoRoot, `packages/plugins/${packageId}/package.json`), {
      name: `@happier-dev/plugins-${packageId}`,
      version: '1.2.3',
      ...(packageId === 'openai'
        ? {
            type: 'module',
            exports: {
              './ui/voice': {
                types: './dist/ui/voice/index.d.ts',
                default: './dist/ui/voice/index.js',
              },
            },
          }
        : {}),
    });
    mkdirSync(resolve(repoRoot, `packages/plugins/${packageId}/src`), { recursive: true });
    writeFileSync(
      resolve(repoRoot, `packages/plugins/${packageId}/src/manifest.ts`),
      pluginManifestSource({
        id: pluginId,
        daemon: false,
        contributes: `{
          connectedAccountDescriptors: ${JSON.stringify(descriptors.map((descriptor) => ({
            id: descriptor.id,
            title: descriptor.id,
            authentication: {
              defaultModeId: descriptor.defaultModeId,
              modes: [...new Set([
                descriptor.defaultModeId,
                ...Object.values(descriptor.modeByCredentialKind),
              ])].map((modeId) => ({
                id: modeId,
                kind: 'manual',
                outcomeReconciliation: 'none',
                fields: [{
                  id: 'token',
                  title: 'Token',
                  schema: { type: 'string', minLength: 1 },
                  secret: true,
                }],
              })),
            },
          })))}
        }`,
      }),
      'utf8',
    );
    mkdirSync(
      resolve(repoRoot, `packages/plugins/${packageId}/src/connectedAccounts`),
      { recursive: true },
    );
    writeFileSync(
      resolve(
        repoRoot,
        `packages/plugins/${packageId}/src/connectedAccounts/builtInLegacyCompatibility.ts`,
      ),
      [
        'export const BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY = Object.freeze(',
        `${JSON.stringify(descriptors.map((descriptor) => ({
          legacyServiceId: descriptor.legacyServiceId,
          serviceLocalId: descriptor.id,
          peerOperations: descriptor.peerOperations,
          exactV0_2_1ReaderQuotaProjection:
            descriptor.exactV0_2_1ReaderQuotaProjection,
          defaultAuthenticationModeId: descriptor.defaultModeId,
          authenticationModeByCredentialKind:
            descriptor.modeByCredentialKind,
          ...(descriptor.unsupportedModeByCredentialKind
            ? {
                unsupportedAuthenticationModeByCredentialKind:
                  descriptor.unsupportedModeByCredentialKind,
              }
            : {}),
        })), null, 2)} as const,`,
        ');',
        '',
      ].join('\n'),
      'utf8',
    );
    if (packageId === 'openai') {
      writeLoadableBundledVoiceFixture(repoRoot, 'openai', 'compatibility');
      linkLoadableBundledVoiceFixtures(repoRoot);
    }
  };
  writePlugin('legacy-codex', 'happier.agent.codex', [
    {
      legacyServiceId: 'openai-codex',
      id: 'openai-codex',
      defaultModeId: 'oauth',
      modeByCredentialKind: { oauth: 'oauth' },
      peerOperations: {
        exactV0_2_1: exactPeerOperations,
        revisionedV2V3: [
          ...revisionedPeerOperations,
          'oauth_refresh',
          'request_auth',
          'recovery_credit_consume',
        ],
      },
      exactV0_2_1ReaderQuotaProjection: true,
    },
  ]);
  writePlugin('openai', 'happier.voice.openai', [
    {
      legacyServiceId: 'openai',
      id: 'openai',
      defaultModeId: 'api-key',
      modeByCredentialKind: { token: 'api-key' },
      peerOperations: {
        exactV0_2_1: exactPeerOperations,
        revisionedV2V3: revisionedPeerOperations,
      },
      exactV0_2_1ReaderQuotaProjection: true,
    },
  ]);
  writePlugin('claude', 'happier.agent.claude', [
    {
      legacyServiceId: 'claude-subscription',
      id: 'claude-subscription',
      defaultModeId: 'setup-token',
      modeByCredentialKind: {
        oauth: 'oauth',
        token: 'setup-token',
      },
      peerOperations: {
        exactV0_2_1: exactPeerOperations,
        revisionedV2V3: [
          ...revisionedPeerOperations,
          'oauth_refresh',
          'request_auth',
        ],
      },
      exactV0_2_1ReaderQuotaProjection: true,
    },
    {
      legacyServiceId: 'anthropic',
      id: 'anthropic',
      defaultModeId: 'api-key',
      modeByCredentialKind: { token: 'api-key' },
      peerOperations: {
        exactV0_2_1: exactPeerOperations,
        revisionedV2V3: revisionedPeerOperations,
      },
      exactV0_2_1ReaderQuotaProjection: true,
    },
  ]);
  writePlugin('gemini', 'happier.agent.gemini', [
    {
      legacyServiceId: 'gemini',
      id: 'gemini-account',
      defaultModeId: 'api-key',
      modeByCredentialKind: { token: 'api-key' },
      peerOperations: {
        exactV0_2_1: exactPeerOperations,
        revisionedV2V3: revisionedPeerOperations,
      },
      exactV0_2_1ReaderQuotaProjection: true,
      unsupportedModeByCredentialKind: {
        oauth: 'legacy-oauth-unsupported',
      },
    },
  ]);
  writePlugin('scm-github', 'happier.scm.hosting.github', [
    {
      legacyServiceId: 'github',
      id: 'github-account',
      defaultModeId: 'fine-grained-pat',
      modeByCredentialKind: { token: 'fine-grained-pat' },
      peerOperations: {
        exactV0_2_1: [],
        revisionedV2V3: revisionedPeerOperations,
      },
      exactV0_2_1ReaderQuotaProjection: false,
    },
  ]);
  writePlugin('scm-bitbucket', 'happier.scm.hosting.bitbucket', [
    {
      legacyServiceId: 'bitbucket',
      id: 'bitbucket-account',
      defaultModeId: 'manual',
      modeByCredentialKind: { token: 'manual' },
      peerOperations: {
        exactV0_2_1: [],
        revisionedV2V3: [],
      },
      exactV0_2_1ReaderQuotaProjection: false,
    },
  ]);
  writeGeneratorOutputScaffold(repoRoot);
  mkdirSync(
    resolve(repoRoot, 'apps/server/sources/app/api/routes/connect/qualifiedConnectedAccounts'),
    { recursive: true },
  );
  writeFileSync(
    resolve(
      repoRoot,
      'apps/server/sources/app/api/routes/connect/qualifiedConnectedAccounts/identity.ts',
    ),
    '// Consumes generated built-in legacy Connected Account compatibility.\n',
    'utf8',
  );

  const outputPath = resolve(
    repoRoot,
    'packages/protocol/src/connect/generatedBuiltInLegacyConnectedAccountCompatibility.ts',
  );
  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
  const output = readFileSync(outputPath, 'utf8');
  assert.match(
    output,
    /export type BuiltInLegacyConnectedAccountOperation =[\s\S]*\| "account_list"[\s\S]*\| "provider_account_usage_write"[\s\S]*export type BuiltInLegacyConnectedAccountCompatibility/u,
  );
  assert.match(output, /"openai-codex": Object\.freeze\(\{/u);
  assert.match(output, /pluginId: "happier\.agent\.codex"/u);
  assert.match(
    output,
    /"openai-codex": Object\.freeze\(\{[\s\S]*exactV0_2_1: Object\.freeze\(\["account_list","credential_read","one_shot_materialization"\] as const\)[\s\S]*revisionedV2V3: Object\.freeze\(\[[^\]]*"oauth_refresh"[\s\S]*"request_auth"[\s\S]*exactV0_2_1ReaderQuotaProjection: true/u,
  );
  assert.match(
    output,
    /"claude-subscription": Object\.freeze\(\{[\s\S]*defaultAuthenticationModeId: "setup-token"[\s\S]*oauth: "oauth"[\s\S]*token: "setup-token"/u,
  );
  assert.match(
    output,
    /"gemini": Object\.freeze\(\{[\s\S]*localId: "gemini-account"[\s\S]*token: "api-key"[\s\S]*oauth: "legacy-oauth-unsupported"/u,
  );
  assert.match(output, /"github": Object\.freeze\(\{[\s\S]*pluginId: "happier\.scm\.hosting\.github"/u);
  assert.match(
    output,
    /"github": Object\.freeze\(\{[\s\S]*exactV0_2_1: Object\.freeze\(\[\] as const\)[\s\S]*revisionedV2V3: Object\.freeze\(\[[^\]]*"one_shot_materialization"[\s\S]*"provider_account_usage_write"[\s\S]*exactV0_2_1ReaderQuotaProjection: false/u,
  );
  assert.match(
    output,
    /"bitbucket": Object\.freeze\(\{[\s\S]*defaultAuthenticationModeId: "manual"[\s\S]*token: "manual"/u,
  );
  assert.match(
    output,
    /server-v0\.2\.1 at 4913c1e533c872a0712ba1c25b3104fd470aacc2/u,
  );
  assert.match(
    output,
    /cli-v0\.2\.1 at b1d15a8a9c241737d1ca9b167459901e6259173a/u,
  );
  assert.match(
    output,
    /prospective Remote at e67f3751f1ab5dc13e40a583a28f3962111154aa[\s\S]*legacy GitHub credential producer/u,
  );
  assert.match(
    output,
    /Dev preactivation at(?:\s|\*)*877ee97a0df346a1daaa541632dc42643d533120[\s\S]*persisted Bitbucket credentials/u,
  );
  assert.match(
    output,
    /Remove this compatibility projection only after exact 0\.2\.1 support ends[\s\S]*persisted legacy rows/u,
  );
  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']);

  writeFileSync(outputPath, '// stale generated projection\n', 'utf8');
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs.*generatedBuiltInLegacyConnectedAccountCompatibility\.ts/iu,
  );
  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']);

  writePlugin('gemini', 'happier.agent.gemini', [{
    legacyServiceId: 'gemini',
    id: 'gemini-account',
    defaultModeId: 'api-key',
    modeByCredentialKind: {
      oauth: 'api-key',
      token: 'api-key',
    },
    unsupportedModeByCredentialKind: {
      oauth: 'legacy-oauth-unsupported',
    },
      peerOperations: {
        exactV0_2_1: exactPeerOperations,
        revisionedV2V3: revisionedPeerOperations,
      },
      exactV0_2_1ReaderQuotaProjection: true,
  }]);
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /invalid built-in legacy Connected Account compatibility entry/iu,
  );

  writePlugin('gemini', 'happier.agent.gemini', [{
    legacyServiceId: 'gemini',
    id: 'gemini-account',
    defaultModeId: 'api-key',
    modeByCredentialKind: {
      token: 'legacy-oauth-unsupported',
    },
    unsupportedModeByCredentialKind: {
      oauth: 'legacy-oauth-unsupported',
    },
      peerOperations: {
        exactV0_2_1: exactPeerOperations,
        revisionedV2V3: revisionedPeerOperations,
      },
      exactV0_2_1ReaderQuotaProjection: true,
  }]);
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /must not expose an unsupported legacy sentinel as a declared authentication mode/iu,
  );

  writePlugin('gemini', 'happier.agent.gemini', [{
    legacyServiceId: 'gemini',
    id: 'gemini-account',
    defaultModeId: 'api-key',
    modeByCredentialKind: { token: 'api-key' },
    unsupportedModeByCredentialKind: {
      oauth: 'legacy-oauth-unsupported',
    },
      peerOperations: {
        exactV0_2_1: exactPeerOperations,
        revisionedV2V3: revisionedPeerOperations,
      },
      exactV0_2_1ReaderQuotaProjection: true,
  }]);
  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']);

  rmSync(resolve(repoRoot, 'packages/plugins/scm-bitbucket'), {
    recursive: true,
    force: true,
  });
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /missing built-in legacy Connected Account compatibility.*bitbucket/iu,
  );
});

test('binds bundled resource artifact identity to exact package bytes rather than package version', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ws6-bundled-resource-artifact-'));
  const packageRoot = resolve(repoRoot, 'packages/plugins/resource-owner');
  const sourcePackageJson = {
    name: '@happier-dev/plugins-resource-owner',
    version: '1.2.3',
    type: 'module',
    main: './dist/index.js',
    files: ['dist', 'resources', 'package.json'],
    scripts: { build: 'must not be shipped' },
    dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
  };
  writeJson(resolve(packageRoot, 'package.json'), sourcePackageJson);
  mkdirSync(resolve(packageRoot, 'src'), { recursive: true });
  writeFileSync(
    resolve(packageRoot, 'src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.fixture.resource-owner',
      daemon: true,
      contributes: '{ resources: [{ id: "prompt", kind: "prompt", path: "./resources/prompt.md", contentType: "text/markdown" }] }',
    }),
    'utf8',
  );
  mkdirSync(resolve(packageRoot, 'dist'), { recursive: true });
  mkdirSync(resolve(packageRoot, 'resources'), { recursive: true });
  writeFileSync(resolve(packageRoot, 'dist/Z.js'), 'export const upper = true;\n', 'utf8');
  writeFileSync(resolve(packageRoot, 'dist/a.js'), 'export const lower = true;\n', 'utf8');
  writeFileSync(resolve(packageRoot, 'dist/index.js'), 'export const activate = () => undefined;\n', 'utf8');
  writeFileSync(resolve(packageRoot, 'dist/.tsbuildinfo'), 'first compiler cache\n', 'utf8');
  writeFileSync(resolve(packageRoot, 'resources/prompt.md'), 'first prompt\n', 'utf8');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
  const first = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts'),
    'utf8',
  );
  const firstGeneration = first.match(/"?immutableGenerationId"?:\s*"([^"]+)"/)?.[1];
  assert.ok(firstGeneration, 'expected an immutable bundled generation identity');
  const firstManifestDigest = first.match(/"manifestDigest":\s*"([^"]+)"/)?.[1];
  assert.match(firstManifestDigest ?? '', /^sha256:[a-f0-9]{64}$/u);
  assert.match(first, /"?relativePath"?:\s*"resources\/prompt\.md"/);
  assert.match(first, /"?relativePath"?:\s*"dist\/index\.js"/);
  assert.match(first, /"?relativePath"?:\s*"package\.json"/);
  assert.doesNotMatch(first, /\.tsbuildinfo/);
  const installedPackageJsonBytes = `${JSON.stringify(sanitizeBundledPackageJson(sourcePackageJson), null, 2)}\n`;
  const installedPackageJsonDigest = `sha256:${createHash('sha256').update(installedPackageJsonBytes).digest('hex')}`;
  assert.match(first, new RegExp(`"digest":\\s*"${installedPackageJsonDigest}"[\\s\\S]*"relativePath":\\s*"package\\.json"`, 'u'));
  assert.deepEqual(
    [...first.matchAll(/"relativePath":\s*"([^"]+)"/gu)].map((match) => match[1]).slice(0, 5),
    ['dist/Z.js', 'dist/a.js', 'dist/index.js', 'package.json', 'resources/prompt.md'],
  );

  const firstLocators = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  const locatorManifestDigest = firstLocators.match(/manifestDigest:\s*"([^"]+)"/)?.[1];
  assert.equal(locatorManifestDigest, firstManifestDigest);
  const firstPackageDigest = first.match(/"packageDigest":\s*"([^"]+)"/)?.[1];
  assert.ok(firstPackageDigest);
  assert.match(firstLocators, new RegExp(`resolvedDigest:\\s*"${firstPackageDigest}"`, 'u'));

  writeFileSync(resolve(packageRoot, 'dist/.tsbuildinfo'), 'second compiler cache\n', 'utf8');
  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
  const afterCompilerCacheChange = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts'),
    'utf8',
  );
  assert.equal(afterCompilerCacheChange, first);

  writeFileSync(resolve(packageRoot, 'resources/prompt.md'), 'second prompt\n', 'utf8');
  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
  const second = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts'),
    'utf8',
  );
  const secondGeneration = second.match(/"?immutableGenerationId"?:\s*"([^"]+)"/)?.[1];
  assert.ok(secondGeneration, 'expected a replacement immutable bundled generation identity');
  assert.notEqual(secondGeneration, firstGeneration);

  writeJson(resolve(packageRoot, 'package.json'), {
    name: '@happier-dev/plugins-resource-owner',
    version: '1.2.3',
    type: 'module',
    main: './dist/index.js',
    exports: { '.': { default: './dist/index.js' } },
    files: ['dist', 'package.json'],
  });
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /artifact omits resource 'resources\/prompt\.md'/u,
  );

  writeFileSync(resolve(packageRoot, 'dist/other.js'), 'export const activate = () => undefined;\n', 'utf8');
  writeJson(resolve(packageRoot, 'package.json'), {
    name: '@happier-dev/plugins-resource-owner',
    version: '1.2.3',
    type: 'module',
    main: './dist/index.js',
    exports: { '.': { default: './dist/other.js' } },
    files: ['dist', 'resources', 'package.json'],
  });
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /package root export.*daemon entry|daemon entry.*package root export/iu,
  );
});

function pluginManifestSource(input: Readonly<{
  id: string;
  packageVersion?: string;
  agentId?: string;
  capabilities?: readonly string[];
  contributes?: string;
  daemon?: boolean;
}>): string {
  const declaredFamilies = Array.from(new Set((input.capabilities ?? []).map((capability) => {
    if (capability === 'backends') return 'agents';
    if (capability === 'installables') return 'managedDependencies';
    return capability;
  })));
  const agentId = input.agentId ?? input.id.split('.').at(-1) ?? input.id;
  const contributes = input.contributes ?? (declaredFamilies.includes('agents')
    ? [
      '{',
      '  agents: [{',
      `    id: ${JSON.stringify(agentId)},`,
      `    title: ${JSON.stringify(`${agentId} runtime`)},`,
      '    runtime: { kind: "custom" },',
      '    cli: {',
      `      displayName: ${JSON.stringify(`${agentId} CLI`)},`,
      `      executable: { binaryName: ${JSON.stringify(agentId)}, sourcePreference: "system-first" },`,
      '      install: { managed: null, manual: { kind: "none" } },',
      '      auth: {',
      '        support: "unsupported",',
      '        probe: { parser: "none", backgroundChecks: "manual_only", statusArgs: null },',
      '        loginLaunches: [],',
      '      },',
      '    },',
      '    primary: "sessions",',
      '    capabilities: {',
      '      sessions: {',
      '        open: ["create", "resume"],',
      '        delivery: ["newTurn"],',
      '        cancel: true,',
      '      },',
      '      executionRuns: {',
      '        open: ["create", "resume"],',
      '        checkpoint: true,',
      '        stop: true,',
      '      },',
      '    },',
      '  }],',
      '}',
    ].join('\n')
    : '{}');
  return [
    'export const PLUGIN_MANIFEST = Object.freeze({',
    '  schemaVersion: 2,',
    `  id: ${JSON.stringify(input.id)},`,
    `  version: ${JSON.stringify(input.packageVersion ?? '0.0.0')},`,
    `  displayName: ${JSON.stringify(input.id)},`,
    '  description: "Test plugin manifest.",',
    '  engines: { happier: "^0.0.0" },',
    '  runtime: { apiVersion: 1 },',
    ...(input.daemon === false ? [] : ['  entrypoints: { daemon: "./dist/index.js" },']),
    '  hostAccess: { required: [], optional: [] },',
    `  contributes: ${contributes},`,
    '});',
    '',
  ].join('\n');
}

function writeBundledVoicePluginFixture(
  repoRoot: string,
  packageId: 'elevenlabs' | 'google' | 'openai' | 'xai' | string,
  options: Readonly<{
    manifestId?: string;
    manifestContributes?: string;
    packageVersion?: string;
    exports?: Record<string, unknown>;
    reservationOnly?: boolean;
    phase?: string;
  }> = {},
): void {
  const packageName = `@happier-dev/plugins-${packageId}`;
  const defaultVoiceContributes = packageId === 'google'
    ? '{ voiceProviders: [{ id: "speech", title: "Google Voice Speech", kind: "speech", roles: ["dictation_stt", "conversation_stt", "conversation_tts"], platforms: ["web", "ios", "android"], capabilities: { readiness: { requirements: ["credential"] } } }] }'
    : packageId === 'elevenlabs' || packageId === 'openai' || packageId === 'xai'
      ? `{ voiceProviders: [{ id: ${JSON.stringify(
          packageId === 'elevenlabs'
            ? 'realtime-elevenlabs'
            : packageId === 'openai'
              ? 'realtime-openai'
              : 'realtime-grok',
        )}, title: "Fixture Voice", kind: "conversation", roles: ["conversation_stt", "conversation_tts", "realtime_conversation", "turn_control"], platforms: ["web"], capabilities: { readiness: { requirements: [] }, turn: { cancelResponse: false, bargeIn: false } }, client: { artifactId: "voice-ui", modulePath: "./ui/voice", exportName: "activate" } }] }`
      : '{}';
  writeJson(resolve(repoRoot, `packages/plugins/${packageId}/package.json`), {
    name: packageName,
    version: options.packageVersion ?? '0.0.0',
    type: 'module',
    exports: options.exports ?? {
      './ui/voice': {
        types: './dist/ui/voice/index.d.ts',
        'react-native': './dist/ui/voice/index.native.js',
        default: './dist/ui/voice/index.js',
      },
    },
    ...(options.reservationOnly
      ? { happier: { pluginScaffold: { shipping: 'reservation_only' } } }
      : {}),
  });
  mkdirSync(resolve(repoRoot, `packages/plugins/${packageId}/src`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${packageId}/src/manifest.ts`),
    pluginManifestSource({
      id: options.manifestId ?? `happier.voice.${packageId}`,
      packageVersion: options.packageVersion,
      contributes: options.manifestContributes ?? defaultVoiceContributes,
    }),
    'utf8',
  );

  if (!options.reservationOnly
    && (packageId === 'elevenlabs' || packageId === 'google' || packageId === 'openai' || packageId === 'xai')) {
    writeLoadableBundledVoiceFixture(repoRoot, packageId, options.phase ?? 'initial');
  }
}

function writeLoadableBundledVoiceFixture(
  repoRoot: string,
  packageId: 'elevenlabs' | 'google' | 'openai' | 'xai',
  phase: string,
): void {
  const distRoot = resolve(repoRoot, `packages/plugins/${packageId}/dist`);
  mkdirSync(resolve(distRoot, 'ui/voice'), { recursive: true });
  const nativeProviderId = packageId === 'elevenlabs'
    ? 'realtime_elevenlabs'
    : packageId === 'openai'
      ? 'realtime_openai'
      : packageId === 'xai'
        ? 'realtime_grok'
        : null;
  writeFileSync(
    resolve(distRoot, 'ui/voice/index.native.js'),
    packageId === 'google'
      ? [
          `export const FIXTURE_PHASE = ${JSON.stringify(phase)};`,
          'const internal = Object.freeze({ createSettingsSpec(providerId) { return Object.freeze({ providerId }); } });',
          'export const BUNDLED_VOICE_UI_ENTRIES = Object.freeze([',
          '  { kind: "voice.speech-engine.v1", pluginId: "happier.voice.google", providerId: "google_gemini", role: "stt", settingsSectionId: "voice.stt.google_gemini", roles: ["dictation_stt", "conversation_stt"], requirements: ["execution_machine", "credential", "runtime"], internal },',
          '  { kind: "voice.speech-engine.v1", pluginId: "happier.voice.google", providerId: "google_cloud", role: "tts", settingsSectionId: "voice.tts.google_cloud", roles: ["conversation_tts"], requirements: ["execution_machine", "credential", "runtime"], internal },',
          ']);',
          '',
        ].join('\n')
      : [
          `export const FIXTURE_PHASE = ${JSON.stringify(phase)};`,
          `const providerId = ${JSON.stringify(nativeProviderId)};`,
          'const internal = Object.freeze({ fixtureState: () => Object.freeze({ phase: FIXTURE_PHASE }) });',
          'export const BUNDLED_VOICE_UI_ENTRIES = Object.freeze([{',
          `  kind: "voice.conversation-provider.v1", pluginId: ${JSON.stringify(`happier.voice.${packageId}`)}, providerId,`,
          '  settingsSectionId: `voice.provider.${providerId}`, roles: ["conversation_stt", "conversation_tts", "realtime_conversation", "turn_control"],',
          '  requirements: [], supportedPlatforms: ["web"], internal,',
          '}]);',
          '',
        ].join('\n'),
    'utf8',
  );
  const conversationRuntimeLines = (
    localId: string,
    requirements: readonly string[],
  ): readonly string[] => [
    `const declaration = Object.freeze({ id: ${JSON.stringify(localId)}, title: "Fixture Voice", kind: "conversation", roles: ["conversation_stt", "conversation_tts", "realtime_conversation", "turn_control"], platforms: ["web"], capabilities: { readiness: { requirements: ${JSON.stringify(requirements)} }, turn: { cancelResponse: false, bargeIn: false } }, client: { artifactId: "voice-ui", modulePath: "./ui/voice", exportName: "activate" } });`,
    'function createRuntimeRegistration() {',
    '  const fixtureRuntimeId = `${FIXTURE_PHASE}:${++runtimeSequence}`;',
    '  liveRuntimeIds.add(fixtureRuntimeId);',
    '  let disposed = false;',
    '  return Object.freeze({',
    '    protocol: Object.freeze({ async prepare() { return {}; }, decodeControl() { return null; }, encodeTurnControl() { return []; } }),',
    '    async createConnection() { throw new Error("fixture connection must not be created during composition"); },',
    '    encodeToolResults() { return []; }, encodeToolContinuation() { return {}; },',
    '    encodeContextUpdate() { return []; }, encodeTextTurn() { return []; },',
    '    async dispose() { if (!disposed) { disposed = true; liveRuntimeIds.delete(fixtureRuntimeId); } },',
    '  });',
    '}',
    `export function activate(api) { api.voiceProviders.register(${JSON.stringify(localId)}, createRuntimeRegistration()); }`,
  ];
  if (packageId === 'elevenlabs') {
    writeFileSync(resolve(distRoot, 'ui/voice/index.js'), [
      `export const FIXTURE_PHASE = ${JSON.stringify(phase)};`,
      'let runtimeSequence = 0;',
      'const liveRuntimeIds = new Set();',
      ...conversationRuntimeLines('realtime-elevenlabs', []),
      'const providerSettings = Object.freeze({',
      '  schemaVersion: 1, defaultConfig: {}, defaultLegacyConfig: {}, legacyDefaultSelection: false,',
      '  parseConfig(value) { return value && typeof value === "object" ? value : null; },',
      '  migrateLegacy(value) { return value && typeof value === "object" ? { config: value, root: {} } : null; },',
      '});',
      'const internal = Object.freeze({',
      '  providerSettings,',
      '  fixtureState() { return Object.freeze({ phase: FIXTURE_PHASE, liveRuntimeIds: Object.freeze([...liveRuntimeIds]) }); },',
      '});',
      'export const BUNDLED_VOICE_UI_ENTRIES = Object.freeze([{',
      '  kind: "voice.conversation-provider.v1", pluginId: "happier.voice.elevenlabs", providerId: "realtime_elevenlabs",',
      '  settingsSectionId: "voice.provider.realtime_elevenlabs", roles: ["conversation_stt", "conversation_tts", "realtime_conversation", "turn_control"],',
      '  requirements: [], supportedPlatforms: ["web"],',
      '  projectSettings() { return { status: "ready", modeId: null }; }, declaration, internal,',
      '}]);',
      'export const BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES = BUNDLED_VOICE_UI_ENTRIES;',
      '',
    ].join('\n'), 'utf8');
    return;
  }

  if (packageId === 'openai' || packageId === 'xai') {
    const providerId = packageId === 'openai' ? 'realtime_openai' : 'realtime_grok';
    writeFileSync(resolve(distRoot, 'ui/voice/index.js'), [
      `export const FIXTURE_PHASE = ${JSON.stringify(phase)};`,
      `const providerId = ${JSON.stringify(providerId)};`,
      'let runtimeSequence = 0;',
      'const liveRuntimeIds = new Set();',
      ...conversationRuntimeLines(
        packageId === 'openai' ? 'realtime-openai' : 'realtime-grok',
        [],
      ),
      'const providerSettings = Object.freeze({',
      '  schemaVersion: 1, defaultConfig: { phase: FIXTURE_PHASE }, defaultLegacyConfig: { phase: FIXTURE_PHASE }, legacyDefaultSelection: false,',
      '  parseConfig(value) { return value && typeof value === "object" ? value : null; },',
      '  migrateLegacy(value) { return value && typeof value === "object" ? { config: value, root: {} } : null; },',
      '});',
      'const internal = Object.freeze({',
      '  providerSettings,',
      '  fixtureState() { return Object.freeze({ phase: FIXTURE_PHASE, liveRuntimeIds: Object.freeze([...liveRuntimeIds]) }); },',
      '});',
      'export const BUNDLED_VOICE_UI_ENTRIES = Object.freeze([{',
      `  kind: "voice.conversation-provider.v1", pluginId: ${JSON.stringify(`happier.voice.${packageId}`)}, providerId,`,
      '  settingsSectionId: `voice.provider.${providerId}`, roles: ["conversation_stt", "conversation_tts", "realtime_conversation", "turn_control"],',
      '  requirements: ["execution_machine", "credential"], supportedPlatforms: ["web"],',
      '  projectSettings(envelope) { return envelope?.schemaVersion === 1 && envelope.config && typeof envelope.config === "object"',
      '    ? { status: "ready", modeId: "byo" } : { status: "invalid", modeId: null }; }, declaration, internal,',
      '}]);',
      'export const BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES = BUNDLED_VOICE_UI_ENTRIES;',
      '',
    ].join('\n'), 'utf8');
    return;
  }

  writeFileSync(resolve(distRoot, 'ui/voice/index.js'), [
    `export const FIXTURE_PHASE = ${JSON.stringify(phase)};`,
    'const createSettingsSpec = (providerId) => Object.freeze({',
    '  kind: "voice.internal.speech-settings.v1", providerId, role: providerId === "google_gemini" ? "stt" : "tts", schemaVersion: 2,',
    '  titleKey: "fixture.title", subtitleKey: "fixture.subtitle", detailKey: "fixture.detail", iconName: "key",',
    '  credential: { kind: "api_key", titleKey: "fixture.credential", promptTitleKey: "fixture.prompt", promptBodyKey: "fixture.body", androidRestricted: false, androidRestrictedBodyKey: null },',
    '  fields: [], runtime: {}, defaultConfig: { phase: FIXTURE_PHASE },',
    '  parseConfig(value) { return value && typeof value === "object" ? value : null; },',
    '  parseLegacyConfig(value) { return value && typeof value === "object" ? value : null; },',
    '  readLegacySecret() { return null; }, migrateLegacy(value) { return value && typeof value === "object" ? value : null; },',
    '  classifyLegacyCredential() { return "importable"; }, test: null,',
    '});',
    'const internal = Object.freeze({ createSettingsSpec, fixtureState: () => Object.freeze({ phase: FIXTURE_PHASE }) });',
    'export const BUNDLED_VOICE_UI_ENTRIES = Object.freeze([',
    '  { kind: "voice.speech-engine.v1", pluginId: "happier.voice.google", providerId: "google_gemini", role: "stt", settingsSectionId: "voice.stt.google_gemini", roles: ["dictation_stt", "conversation_stt"], requirements: ["execution_machine", "credential", "runtime"], internal },',
    '  { kind: "voice.speech-engine.v1", pluginId: "happier.voice.google", providerId: "google_cloud", role: "tts", settingsSectionId: "voice.tts.google_cloud", roles: ["conversation_tts"], requirements: ["execution_machine", "credential", "runtime"], internal },',
    ']);',
    'export const BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES = Object.freeze([]);',
    '',
  ].join('\n'), 'utf8');
}

function linkLoadableBundledVoiceFixtures(repoRoot: string): void {
  const scopeRoot = resolve(repoRoot, 'node_modules/@happier-dev');
  mkdirSync(scopeRoot, { recursive: true });
  for (const packageId of ['elevenlabs', 'google', 'openai', 'xai'] as const) {
    const linkPath = resolve(scopeRoot, `plugins-${packageId}`);
    const packagePath = resolve(repoRoot, `packages/plugins/${packageId}`);
    if (existsSync(packagePath) && !existsSync(linkPath)) symlinkSync(packagePath, linkPath, 'dir');
  }
}

function runBundledVoiceCompositionProbes(
  repoRoot: string,
  expected: Readonly<{
    elevenlabs: string | null;
    google: string | null;
    openai: string | null;
    xai: string | null;
    disabled: 'elevenlabs' | 'google' | 'openai' | 'xai' | null;
    selectedProviderId: 'realtime_elevenlabs' | 'google_gemini' | 'realtime_openai' | 'realtime_grok';
    persistedEnvelope: Readonly<{ schemaVersion: 1; config: Readonly<Record<string, unknown>> }>;
  }>,
): void {
  const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const uiProbePath = resolve(repoRoot, 'voice-ui-composition-probe.test.ts');
  const uiProbeConfigPath = resolve(repoRoot, 'voice-ui-composition-probe.vitest.config.mjs');
  const speechClientStubPath = resolve(repoRoot, 'voice-bundled-speech-client-stub.ts');
  const speechPlaybackStubPath = resolve(repoRoot, 'voice-speech-playback-stub.ts');
  const expoUpdatesStubPath = resolve(repoRoot, 'voice-expo-updates-stub.ts');
  const unistylesStubPath = resolve(repoRoot, 'voice-unistyles-stub.ts');
  const generatedUiUrl = pathToFileURL(resolve(repoRoot, 'apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts')).href;
  const generatedRuntimeUrl = pathToFileURL(resolve(repoRoot, 'apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ts')).href;
  const moduleUrl = (relativePath: string) => pathToFileURL(resolve(sourceRoot, relativePath)).href;
  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/voice/registry/bundledConversationRuntimeEntries.ts'),
    [
      `export { createBundledConversationRuntimeEntries } from ${JSON.stringify(moduleUrl('apps/ui/sources/voice/registry/bundledConversationRuntimeEntries.ts'))};`,
      `export type { BundledConversationRuntimeEntry } from ${JSON.stringify(moduleUrl('apps/ui/sources/voice/registry/bundledConversationRuntimeEntries.ts'))};`,
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(uiProbePath, [
    'import { test } from "vitest";',
    `import * as generatedVoiceUiModule from ${JSON.stringify(generatedUiUrl)};`,
    `import * as generatedVoiceRuntimeModule from ${JSON.stringify(generatedRuntimeUrl)};`,
    `import * as conversationComposerModule from ${JSON.stringify(moduleUrl('apps/ui/sources/voice/registry/bundledConversationRuntimes.ts'))};`,
    `import * as conversationRuntimeHostModule from ${JSON.stringify(moduleUrl('apps/ui/sources/voice/registry/bundledConversationRuntimeHost.ts'))};`,
    `import * as providerRegistryModule from ${JSON.stringify(moduleUrl('apps/ui/sources/voice/registry/providerRegistry.ts'))};`,
    `import * as readinessModule from ${JSON.stringify(moduleUrl('apps/ui/sources/voice/registry/readiness.ts'))};`,
    `import * as speechDescriptorModule from ${JSON.stringify(moduleUrl('apps/ui/sources/voice/settings/panels/bundledSpeech/descriptor.ts'))};`,
    `import * as speechRuntimeModule from ${JSON.stringify(moduleUrl('apps/ui/sources/voice/runtime/bundledSpeech/bundledSpeechRuntime.ts'))};`,
    'const BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES = generatedVoiceUiModule.BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES ?? generatedVoiceUiModule.default?.BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES;',
    'const BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES = generatedVoiceRuntimeModule.BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES ?? generatedVoiceRuntimeModule.default?.BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES;',
    'const createBundledConversationRuntimes = conversationComposerModule.createBundledConversationRuntimes ?? conversationComposerModule.default?.createBundledConversationRuntimes;',
    'const createBundledConversationRuntimeHostLease = conversationRuntimeHostModule.createBundledConversationRuntimeHostLease ?? conversationRuntimeHostModule.default?.createBundledConversationRuntimeHostLease;',
    'const createVoiceProviderRegistry = providerRegistryModule.createVoiceProviderRegistry ?? providerRegistryModule.default?.createVoiceProviderRegistry;',
    'const resolveVoiceRoleReadiness = readinessModule.resolveVoiceRoleReadiness ?? readinessModule.default?.resolveVoiceRoleReadiness;',
    'const projectVoiceProviderSettings = providerRegistryModule.projectVoiceProviderSettings ?? providerRegistryModule.default?.projectVoiceProviderSettings;',
    'const readBundledSpeechSettingsDescriptorFromEntry = speechDescriptorModule.readBundledSpeechSettingsDescriptorFromEntry ?? speechDescriptorModule.default?.readBundledSpeechSettingsDescriptorFromEntry;',
    'const createBundledSpeechRuntime = speechRuntimeModule.createBundledSpeechRuntime ?? speechRuntimeModule.default?.createBundledSpeechRuntime;',
    'test("fresh production UI voice composition", async () => {',
    'const expected = JSON.parse(process.env.HAPPIER_VOICE_FIXTURE_EXPECTED);',
    'const registry = createVoiceProviderRegistry({ bundled: BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES });',
    'const ids = registry.list().map((entry) => entry.providerId).sort();',
    'const expectedIds = [',
    '  ...(expected.elevenlabs ? ["realtime_elevenlabs"] : []),',
    '  ...(expected.google ? ["google_cloud", "google_gemini"] : []),',
    '  ...(expected.openai ? ["realtime_openai"] : []),',
    '  ...(expected.xai ? ["realtime_grok"] : []),',
    '].sort();',
    'if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) throw new Error(`UI registry mismatch: ${JSON.stringify(ids)}`);',
    'const facts = { settings: "ready", executionMachine: "ready", credential: "ready", runtime: "ready", model: "ready", endpoint: "ready", serverFeature: "ready" };',
    'for (const [providerId, role, phase] of [["realtime_elevenlabs", "realtime_conversation", expected.elevenlabs], ["google_gemini", "dictation_stt", expected.google], ["google_cloud", "conversation_tts", expected.google], ["realtime_openai", "realtime_conversation", expected.openai], ["realtime_grok", "realtime_conversation", expected.xai]]) {',
    '  const shouldExist = Boolean(phase);',
    '  const readiness = resolveVoiceRoleReadiness({ registry, role, providerId, platform: "web", facts });',
    '  if (shouldExist && readiness.status !== "ready") throw new Error(`expected ready ${providerId}: ${JSON.stringify(readiness)}`);',
    '  if (!shouldExist && readiness.code !== "contribution_unavailable") throw new Error(`expected unavailable ${providerId}: ${JSON.stringify(readiness)}`);',
    '}',
    'for (const [providerId, phase] of [["realtime_elevenlabs", expected.elevenlabs], ["realtime_openai", expected.openai], ["realtime_grok", expected.xai]]) {',
    '  const settingsEntry = registry.get(providerId);',
    '  const settingsProjection = settingsEntry ? projectVoiceProviderSettings(settingsEntry, expected.persistedEnvelope) : null;',
    '  if (Boolean(settingsProjection?.status === "ready") !== Boolean(phase)) throw new Error(`conversation settings composition mismatch: ${providerId}`);',
    '}',
    'for (const providerId of ["google_gemini", "google_cloud"]) {',
    '  const entry = registry.get(providerId);',
    '  const descriptor = readBundledSpeechSettingsDescriptorFromEntry(providerId, entry);',
    '  if (expected.google) {',
    '    if (!descriptor || descriptor.defaultConfig.phase !== expected.google || !descriptor.parseConfig({ phase: expected.google })) throw new Error(`Google UI runtime descriptor mismatch: ${providerId}; descriptor=${JSON.stringify(descriptor)}; raw=${JSON.stringify(entry?.internal?.createSettingsSpec?.(providerId))}`);',
    '  } else if (descriptor !== null) throw new Error(`disabled Google descriptor survived: ${providerId}`);',
    '}',
    'const persistedBefore = JSON.stringify(expected.persistedEnvelope);',
    'const selectedEntry = registry.get(expected.selectedProviderId);',
    'if (expected.disabled && selectedEntry !== null) throw new Error("disabled selected provider remained executable");',
    'if (!expected.disabled && !selectedEntry) throw new Error("selected provider did not restore");',
    'if (!expected.disabled && expected.selectedProviderId === "google_gemini") {',
    '  const descriptor = readBundledSpeechSettingsDescriptorFromEntry(expected.selectedProviderId, selectedEntry);',
    '  if (!descriptor || JSON.stringify(descriptor.parseConfig(expected.persistedEnvelope.config)) !== JSON.stringify(expected.persistedEnvelope.config)) throw new Error("persisted Google config did not restore");',
    '} else if (!expected.disabled) {',
    '  const projection = projectVoiceProviderSettings(selectedEntry, expected.persistedEnvelope);',
    '  if (projection?.status !== "ready") throw new Error("persisted conversation settings did not restore");',
    '}',
    'if (JSON.stringify(expected.persistedEnvelope) !== persistedBefore) throw new Error("persisted settings mutated during composition");',
    'const createSpeechHarness = () => {',
    '  const calls = [];',
    '  const client = {',
    '    async transcribe(params) { calls.push({ kind: "transcribe", providerId: params.entry.providerId }); return expected.google ?? "unexpected-disabled-transcribe"; },',
    '    async synthesize(params) { calls.push({ kind: "synthesize", providerId: params.entry.providerId }); return { bytes: new Uint8Array([1]), mimeType: "audio/wav" }; },',
    '  };',
    '  const plays = [];',
    '  const runtime = createBundledSpeechRuntime({ registry, client, platformOs: "ios", play: async (params) => { plays.push(params.bytes.byteLength); } });',
    '  return { runtime, calls, plays };',
    '};',
    'const firstSpeech = createSpeechHarness(); const secondSpeech = createSpeechHarness();',
    'if (firstSpeech.runtime === secondSpeech.runtime) throw new Error("Google UI speech runtime identity was reused");',
    'if (expected.google) {',
    '  const firstText = await firstSpeech.runtime.transcribeRecordedAudio("google_gemini", { uri: "file:///fixture.wav", providerConfig: { model: "fixture-model", language: "en" }, fallbackLanguage: null });',
    '  await firstSpeech.runtime.speak("google_cloud", { text: "fixture", providerConfig: { voiceName: "fixture-voice", format: "wav" }, registerPlaybackStopper: () => () => {} });',
    '  const secondText = await secondSpeech.runtime.transcribeRecordedAudio("google_gemini", { uri: "file:///fixture.wav", providerConfig: { model: "fixture-model", language: "en" }, fallbackLanguage: null });',
    '  await secondSpeech.runtime.speak("google_cloud", { text: "fixture", providerConfig: { voiceName: "fixture-voice", format: "wav" }, registerPlaybackStopper: () => () => {} });',
    '  if (firstText !== expected.google || secondText !== expected.google) throw new Error("stale Google UI speech runtime identity");',
    '  if (JSON.stringify(firstSpeech.calls) !== JSON.stringify([{ kind: "transcribe", providerId: "google_gemini" }, { kind: "synthesize", providerId: "google_cloud" }])) throw new Error("first Google UI runtime retained or skipped calls");',
    '  if (JSON.stringify(secondSpeech.calls) !== JSON.stringify(firstSpeech.calls) || firstSpeech.plays.length !== 1 || secondSpeech.plays.length !== 1) throw new Error("Google UI runtime state leaked across compositions");',
    '} else {',
    '  const sttError = await firstSpeech.runtime.transcribeRecordedAudio("google_gemini", { uri: "file:///fixture.wav", providerConfig: { model: "fixture-model" }, fallbackLanguage: null }).then(() => null, (error) => error);',
    '  const ttsError = await firstSpeech.runtime.speak("google_cloud", { text: "fixture", providerConfig: { voiceName: "fixture-voice" }, registerPlaybackStopper: () => () => {} }).then(() => null, (error) => error);',
    '  if (sttError?.code !== "provider_unavailable" || ttsError?.code !== "provider_unavailable") throw new Error("disabled Google UI runtime did not fail closed");',
    '  if (firstSpeech.calls.length !== 0 || firstSpeech.plays.length !== 0) throw new Error("disabled Google UI runtime reached a retained client or playback owner");',
    '}',
    'const expectedConversationProviders = [["realtime_elevenlabs", expected.elevenlabs], ["realtime_openai", expected.openai], ["realtime_grok", expected.xai]].filter(([, phase]) => Boolean(phase));',
    'const firstHostLease = createBundledConversationRuntimeHostLease();',
    'const first = createBundledConversationRuntimes({ bundledEntries: BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES, host: firstHostLease.host });',
    'if (first.length !== expectedConversationProviders.length) throw new Error("first conversation composition mismatch");',
    'const firstAdapters = new Map();',
    'for (const [providerId, phase] of expectedConversationProviders) {',
    '  const firstRuntime = first.find((runtime) => runtime.adapter.id === providerId);',
    '  if (!firstRuntime) throw new Error(`first runtime missing: ${providerId}`);',
    '  firstAdapters.set(providerId, firstRuntime.adapter);',
    '  const internal = registry.get(providerId)?.internal;',
    '  if (!internal || internal.fixtureState().phase !== phase || internal.fixtureState().liveRuntimeIds.length !== 1) throw new Error(`runtime state did not reflect first composition: ${providerId}`);',
    '}',
    'const secondHostLease = createBundledConversationRuntimeHostLease();',
    'const second = createBundledConversationRuntimes({ bundledEntries: BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES, host: secondHostLease.host });',
    'if (second.length !== expectedConversationProviders.length) throw new Error("second conversation composition mismatch");',
    'for (const [providerId, phase] of expectedConversationProviders) {',
    '  const secondRuntime = second.find((runtime) => runtime.adapter.id === providerId);',
    '  const internal = registry.get(providerId)?.internal;',
    '  if (!secondRuntime || secondRuntime.adapter === firstAdapters.get(providerId)) throw new Error(`runtime identity was reused or missing: ${providerId}`);',
    '  if (!internal || internal.fixtureState().phase !== phase || internal.fixtureState().liveRuntimeIds.length !== 2) throw new Error(`runtime state did not reflect live replacement composition: ${providerId}`);',
    '}',
    'firstHostLease.revoke();',
    'await Promise.all(first.map(async (runtime) => await runtime.dispose()));',
    'for (const [providerId] of expectedConversationProviders) { if (registry.get(providerId)?.internal?.fixtureState().liveRuntimeIds.length !== 1) throw new Error(`late first-generation disposal disturbed replacement: ${providerId}`); }',
    'secondHostLease.revoke();',
    'await Promise.all(second.map(async (runtime) => await runtime.dispose()));',
    'for (const [providerId] of expectedConversationProviders) { if (registry.get(providerId)?.internal?.fixtureState().liveRuntimeIds.length !== 0) throw new Error(`second runtime state leaked after disposal: ${providerId}`); }',
    '});',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(speechClientStubPath, [
    'const unavailable = async () => { throw new Error("physical proof must inject the speech client boundary"); };',
    'export const bundledSpeechDaemonClient = Object.freeze({ transcribe: unavailable, synthesize: unavailable });',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(speechPlaybackStubPath, [
    'export const playAudioBytesWithStopper = async () => { throw new Error("physical proof must inject the playback boundary"); };',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(expoUpdatesStubPath, [
    'export const useUpdates = () => Object.freeze({ currentlyRunning: {}, isChecking: false, isDownloading: false, isRestarting: false, isStartupProcedureRunning: false, isUpdateAvailable: false, isUpdatePending: false, restartCount: 0 });',
    'export const checkForUpdateAsync = async () => Object.freeze({ isAvailable: false });',
    'export const fetchUpdateAsync = async () => {};',
    'export const reloadAsync = async () => {};',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(unistylesStubPath, [
    `import { createUnistylesRuntime } from ${JSON.stringify(moduleUrl('apps/ui/sources/dev/testkit/runtime/unistylesRuntime.ts'))};`,
    'const runtime = await createUnistylesRuntime();',
    'export const StyleSheet = runtime.StyleSheet;',
    'export const UnistylesRuntime = runtime.UnistylesRuntime;',
    'export const useUnistyles = runtime.useUnistyles;',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(uiProbeConfigPath, [
    `const uiSources = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources'))};`,
    `const reactNativeStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/reactNativeStub.ts'))};`,
    `const reactNativeInternalStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/reactNativeInternalStub.ts'))};`,
    `const reactNativeVirtualizedListsStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/reactNativeVirtualizedListsStub.ts'))};`,
    `const reactNativeMmkvStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/reactNativeMmkvStub.ts'))};`,
    `const expoVectorIconsStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoVectorIconsStub.ts'))};`,
    `const posthogReactNativeStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/posthogReactNativeStub.tsx'))};`,
    `const sentryReactNativeStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/sentryReactNativeStub.ts'))};`,
    `const rnEncryptionStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/rnEncryptionStub.ts'))};`,
    `const reactNativeKeyboardControllerStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/reactNativeKeyboardControllerStub.ts'))};`,
    `const reactNativeReanimatedStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/reactNativeReanimatedStub.ts'))};`,
    `const expoModulesCoreStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoModulesCoreStub.ts'))};`,
    `const expoStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoStub.ts'))};`,
    `const expoConstantsStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoConstantsStub.ts'))};`,
    `const expoAudioStub = ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoAudioStub.ts'))};`,
    `const speechClientStub = ${JSON.stringify(speechClientStubPath)};`,
    `const speechPlaybackStub = ${JSON.stringify(speechPlaybackStubPath)};`,
    `const expoUpdatesStub = ${JSON.stringify(expoUpdatesStubPath)};`,
    `const unistylesStub = ${JSON.stringify(unistylesStubPath)};`,
    'export default {',
    `  root: ${JSON.stringify(repoRoot)},`,
    '  define: { __DEV__: true },',
    '  resolve: { alias: [',
    '    { find: /^@\\/voice\\/credentials\\/bundledSpeechClient$/, replacement: speechClientStub },',
    '    { find: /^@\\/voice\\/output\\/playAudioBytesWithStopper$/, replacement: speechPlaybackStub },',
    '    { find: /^react-native$/, replacement: reactNativeStub },',
    '    { find: /^react-native\\//, replacement: reactNativeInternalStub },',
    '    { find: /^@react-native\\/virtualized-lists(?:\\/.*)?$/, replacement: reactNativeVirtualizedListsStub },',
    '    { find: /^react-native-mmkv$/, replacement: reactNativeMmkvStub },',
    '    { find: /^react-native-unistyles$/, replacement: unistylesStub },',
    '    { find: /^@expo\\/vector-icons(?:\\/.*)?$/, replacement: expoVectorIconsStub },',
    '    { find: /^posthog-react-native$/, replacement: posthogReactNativeStub },',
    '    { find: /^@sentry\\/react-native$/, replacement: sentryReactNativeStub },',
    '    { find: /^rn-encryption$/, replacement: rnEncryptionStub },',
    '    { find: /^react-native-keyboard-controller(?:\\/.*)?$/, replacement: reactNativeKeyboardControllerStub },',
    '    { find: /^react-native-reanimated(?:\\/.*)?$/, replacement: reactNativeReanimatedStub },',
    `    { find: /^react-native-safe-area-context$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/reactNativeSafeAreaContextStub.ts'))} },`,
    `    { find: /^react-native-gesture-handler$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/reactNativeGestureHandlerStub.ts'))} },`,
    `    { find: /^react-native-webview$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/reactNativeWebviewStub.ts'))} },`,
    `    { find: /^react-native-device-info$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/reactNativeDeviceInfoStub.ts'))} },`,
    `    { find: /^react-native-purchases$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/reactNativePurchasesStub.ts'))} },`,
    `    { find: /^react-native-purchases-ui$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/reactNativePurchasesUiStub.ts'))} },`,
    `    { find: /^expo-router\\/drawer$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoRouterDrawerStub.ts'))} },`,
    `    { find: /^expo-router(?:\\/.*)?$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoRouterStub.ts'))} },`,
    `    { find: /^expo-localization$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoLocalizationStub.ts'))} },`,
    `    { find: /^expo-video$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoVideoStub.ts'))} },`,
    `    { find: /^expo-notifications$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoNotificationsStub.ts'))} },`,
    `    { find: /^expo-task-manager$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoTaskManagerStub.ts'))} },`,
    `    { find: /^expo-speech$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoSpeechStub.ts'))} },`,
    `    { find: /^expo-speech-recognition$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoSpeechRecognitionStub.ts'))} },`,
    `    { find: /^expo-clipboard$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoClipboardStub.ts'))} },`,
    `    { find: /^expo-linear-gradient$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoLinearGradientStub.ts'))} },`,
    `    { find: /^expo-camera$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/dev/expoCameraStub.ts'))} },`,
    `    { find: /^@\\/platform\\/cryptoRandom$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/platform/cryptoRandom.node.ts'))} },`,
    `    { find: /^@\\/platform\\/hmacSha512$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/platform/hmacSha512.node.ts'))} },`,
    `    { find: /^@\\/platform\\/randomUUID$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/platform/randomUUID.node.ts'))} },`,
    `    { find: /^@\\/platform\\/digest$/, replacement: ${JSON.stringify(resolve(sourceRoot, 'apps/ui/sources/platform/digest.node.ts'))} },`,
    '    { find: /^expo-modules-core(?:\\/.*)?$/, replacement: expoModulesCoreStub },',
    '    { find: /^expo$/, replacement: expoStub },',
    '    { find: /^expo-updates$/, replacement: expoUpdatesStub },',
    '    { find: /^expo-constants$/, replacement: expoConstantsStub },',
    '    { find: /^expo-audio$/, replacement: expoAudioStub },',
    '    { find: /^@\\//, replacement: `${uiSources}/` },',
    '  ] },',
    '  test: { environment: "node", include: ["voice-ui-composition-probe.test.ts"], pool: "forks", poolOptions: { forks: { minForks: 1, maxForks: 1 } } },',
    '};',
    '',
  ].join('\n'), 'utf8');

  const expectedJson = JSON.stringify(expected);
  const nativePackages = [
    expected.elevenlabs ? 'elevenlabs' : null,
    expected.google ? 'google' : null,
    expected.openai ? 'openai' : null,
    expected.xai ? 'xai' : null,
  ].filter((packageId): packageId is string => packageId !== null);
  const nativeProbe = spawnSync(
    process.execPath,
    [
      '--conditions=react-native',
      '--input-type=module',
      '--eval',
      [
        'const packages = JSON.parse(process.env.HAPPIER_VOICE_NATIVE_PACKAGES);',
        'for (const packageId of packages) {',
        '  const module = await import(`@happier-dev/plugins-${packageId}/ui/voice`);',
        '  if (!Array.isArray(module.BUNDLED_VOICE_UI_ENTRIES) || module.BUNDLED_VOICE_UI_ENTRIES.length === 0) throw new Error(`missing native metadata: ${packageId}`);',
        '  if ("activate" in module) throw new Error(`native executable activation leaked: ${packageId}`);',
        '}',
      ].join('\n'),
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HAPPIER_VOICE_NATIVE_PACKAGES: JSON.stringify(nativePackages),
      },
    },
  );
  assert.equal(nativeProbe.status, 0, `native metadata composition probe failed: ${nativeProbe.stderr}`);
  const probes = [
    {
      name: 'UI',
      args: [resolve(sourceRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', uiProbeConfigPath],
    },
  ];
  for (const probe of probes) {
    const result = spawnSync(process.execPath, probe.args, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HAPPIER_VOICE_FIXTURE_EXPECTED: expectedJson },
    });
    assert.equal(result.status, 0, `${probe.name} composition probe failed: ${result.stderr}`);
  }
}

function writeGeneratorOutputScaffold(repoRoot: string, uiSource?: string): void {
  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    uiSource ?? 'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.sessionAgentBehaviors.ts'),
    'export const BUNDLED_CANONICAL_AGENT_SESSION_BEHAVIORS = Object.freeze({});\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.agentSettings.ts'),
    'export const BUNDLED_AGENT_SETTINGS_PLUGINS = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers.ts'),
    'export const BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );
}

function requiredVoiceExportsForFixture(pluginPackageId: string): Record<string, unknown> {
  return pluginPackageId === 'codex'
    ? {
        exports: {
          './ui/voice': {
            types: './dist/ui/voice/index.d.ts',
            default: './dist/ui/voice/index.js',
          },
        },
      }
    : {};
}

function writeAgentPluginFixture(repoRoot: string, pluginPackageId: string, agentId = pluginPackageId): void {
  writeJson(resolve(repoRoot, `packages/plugins/${pluginPackageId}/package.json`), {
    name: `@happier-dev/plugins-${pluginPackageId}`,
    version: '0.0.0',
    ...requiredVoiceExportsForFixture(pluginPackageId),
  });
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/manifest.ts`),
    pluginManifestSource({
      id: `happier.agent.${pluginPackageId}`,
      agentId,
      capabilities: ['agents'],
      contributes: `{
        agents: [{
          id: ${JSON.stringify(agentId)},
          title: ${JSON.stringify(`${agentId} runtime`)},
          runtime: { kind: "custom" },
          cli: {
            displayName: ${JSON.stringify(`${agentId} CLI`)},
            executable: { binaryName: ${JSON.stringify(agentId)}, sourcePreference: "system-first" },
            install: { managed: null, manual: { kind: "none" } },
            auth: {
              support: "unsupported",
              probe: { parser: "none", backgroundChecks: "manual_only", statusArgs: null },
              loginLaunches: [],
            },
          },
          primary: "sessions",
          capabilities: {
            sessions: { open: ["create"], delivery: ["newTurn"], cancel: true },
          },
        }],
      }`,
    }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/agent`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/agent/definition.ts`),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      `  id: ${JSON.stringify(agentId)},`,
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
}

function writeInstallablePluginFixture(
  repoRoot: string,
  pluginPackageId: string,
  installableId: string,
): void {
  writeJson(resolve(repoRoot, `packages/plugins/${pluginPackageId}/package.json`), {
    name: `@happier-dev/plugins-${pluginPackageId}`,
    version: '0.0.0',
  });
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/manifest.ts`),
    pluginManifestSource({
      id: `happier.installables.${pluginPackageId}`,
      capabilities: [],
      contributes: `{
        managedDependencies: [{
          id: ${JSON.stringify(installableId)},
          title: ${JSON.stringify(installableId)},
          description: "Test installable.",
          sources: [{ kind: "system", executableNames: [${JSON.stringify(installableId)}] }],
          executable: ${JSON.stringify(installableId)},
        }],
      }`,
    }),
    'utf8',
  );
}

function writeOpenCodeAgentPluginFixture(repoRoot: string): void {
  writeAgentPluginFixture(repoRoot, 'opencode');
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/opencode/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "opencode",',
      '  commandSurface: {',
      '    rootHelpLabel: "happier opencode",',
      '    rootHelpDescription: "Start OpenCode mode",',
      '    allowTmux: true,',
      '  },',
      '  runtimeContributions: {',
      '    agentCatalogEntry: { importName: "OPENCODE_AGENT_RUNTIME_CONTRIBUTION", source: "./agent/contributions/runtime" },',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/opencode/src/agent/contributions'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/opencode/src/agent/contributions/runtime.ts'),
    'export const OPENCODE_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({ agentId: "opencode" });\n',
    'utf8',
  );
}

function writeProviderContributionPluginFixture(
  repoRoot: string,
  options: Readonly<{ includeVerification?: boolean }> = {},
): void {
  writeJson(resolve(repoRoot, 'packages/plugins/gateway/package.json'), {
    name: '@happier-dev/plugins-gateway',
    version: '0.0.0',
  });
  mkdirSync(resolve(repoRoot, 'packages/plugins/gateway/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/gateway/src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.provider.gateway',
      contributes: `{
        providers: [{
          v: 1,
          id: "gateway",
          name: "Gateway",
          kind: "cloud",
          endpointTemplates: [{
            id: "responses",
            protocol: "openai-responses",
            baseUrl: "https://gateway.example/v1",
            capabilities: { streaming: "unknown", toolRoundTrips: "unknown", statefulResponses: "unknown", reasoningControls: "unknown" },
          }],
          catalog: { source: "manual", manualModelPolicy: "allowed" },
        }, {
          v: 1,
          id: "gateway-secondary",
          name: "Gateway Secondary",
          kind: "cloud",
          endpointTemplates: [{
            id: "chat",
            protocol: "openai-chat",
            baseUrl: "https://secondary.gateway.example/v1",
            capabilities: { streaming: "unknown", toolRoundTrips: "unknown", statefulResponses: "unknown", reasoningControls: "unknown" },
          }],
          catalog: { source: "manual", manualModelPolicy: "allowed" },
        }],
      }`,
    }),
    'utf8',
  );
  if (options.includeVerification === false) return;
  const verificationDirectory = resolve(repoRoot, 'packages/plugins/gateway/src/provider/verification');
  mkdirSync(verificationDirectory, { recursive: true });
  for (const contribution of [
    { id: 'gateway', endpointId: 'responses' },
    { id: 'gateway-secondary', endpointId: 'chat' },
  ]) {
    writeJson(resolve(verificationDirectory, `${contribution.id}.json`), {
      v: 1,
      contributionKey: `happier.provider.gateway/${contribution.id}`,
      reviewedAt: '2026-07-12',
      sources: [{
        id: 'fixture-contract',
        kind: 'official-doc',
        url: 'https://example.com/provider-contract',
        accessedAt: '2026-07-12',
        revision: 'fixture-v1',
      }],
      facts: [
        { path: 'catalog.source', sourceIds: ['fixture-contract'], status: 'verified' },
        { path: `endpointTemplates.${contribution.endpointId}.baseUrl`, sourceIds: ['fixture-contract'], status: 'verified' },
        { path: `endpointTemplates.${contribution.endpointId}.protocol`, sourceIds: ['fixture-contract'], status: 'verified' },
        { path: 'kind', sourceIds: ['fixture-contract'], status: 'verified' },
      ],
    });
  }
}

test('generateBundledPluginEntries rejects a bundled Provider without field-path verification', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-provider-verification-missing-'));
  writeProviderContributionPluginFixture(repoRoot, { includeVerification: false });
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Missing Provider verification record 'happier\.provider\.gateway\/gateway'/,
  );
});

function writeAntigravityCanonicalBackendFixture(repoRoot: string): void {
  writeJson(resolve(repoRoot, 'packages/plugins/antigravity/package.json'), {
    name: '@happier-dev/plugins-antigravity',
    version: '0.0.0',
  });
  mkdirSync(resolve(repoRoot, 'packages/plugins/antigravity/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/antigravity/src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.agent.antigravity',
      capabilities: ['agents'],
      contributes: `{
        agents: [
          {
            id: "antigravity",
            title: "Antigravity",
            runtime: { kind: "custom" },
            cli: {
              displayName: "Antigravity CLI",
              executable: { binaryName: "agy", sourcePreference: "system-first" },
              install: { managed: null, manual: { kind: "vendor_recipe" } },
              auth: {
                support: "unsupported",
                probe: { parser: "none", backgroundChecks: "manual_only", statusArgs: null },
                loginLaunches: [],
              },
            },
            primary: "sessions",
            capabilities: {
              surfaces: ["terminal"],
              sessions: { open: ["create"], delivery: ["newTurn"], cancel: true },
              executionRuns: { open: ["create"], checkpoint: false, stop: true },
            },
          },
        ],
      }`,
    }),
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/antigravity/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "antigravity",',
      '  core: {',
      '    id: "antigravity",',
      '    backendDefinition: false,',
      '    cliSubcommand: "antigravity",',
      '    detectKey: "agy",',
      '    flavorAliases: ["agy"],',
      '    resume: { vendorResume: "supported", vendorResumeIdField: "antigravitySessionId" },',
      '    sessionStorage: { direct: false, persisted: true },',
      '    handoff: { vendorStateTransfer: "unsupported" },',
      '    localControl: { supported: true, topology: "exclusive", attachStrategy: "terminal_host" },',
      '    tools: { delivery: "shell_bridge", support: "experimental" },',
      '  },',
      '  settingsBackendId: "antigravity",',
      '  ownedBackendIds: ["antigravity"],',
      '  enablementCompatibilityBackendIds: ["antigravity-localharness", "antigravity-terminal"],',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeUiDescriptorFixture(repoRoot, 'antigravity', 'ANTIGRAVITY_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'happier.agent.antigravity',
    agentId: 'antigravity',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.antigravity',
      subtitleKey: 'profiles.aiBackend.antigravitySubtitleExperimental',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: true },
      connectedService: { serviceId: null, labelKey: 'agentInput.agent.antigravity', connectRoute: null },
      flavorAliases: ['agy'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: { uiVendorResumeIdLabelKey: null, uiVendorResumeIdCopiedKey: null },
      localControl: true,
      runtimeInput: { inFlightSteerSupported: false },
      toolRendering: { hideUnknownToolsByDefault: false },
      picker: {
        iconName: 'rocket-outline',
        cliGlyph: 'AG',
        cliGlyphScale: 1,
        profileCompatibilityGlyphScale: 1,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'antigravity' },
    },
    settings: {},
    behavior: {},
    session: {},
    message: {},
    components: { slots: [] },
    assets: { svgIcon: { assetId: 'antigravity' } },
  });
}

function writeUiDescriptorFixture(
  repoRoot: string,
  pluginPackageId: string,
  exportName: string,
  descriptor: Record<string, unknown>,
): void {
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/ui`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/ui/descriptor.ts`),
    [
      `export const ${exportName} = Object.freeze(${JSON.stringify(descriptor, null, 2)});`,
      '',
    ].join('\n'),
    'utf8',
  );
}

function writeUiBehaviorOverrideFixture(
  repoRoot: string,
  pluginPackageId: string,
  agentId = pluginPackageId,
): void {
  const exportName = `${agentId
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()}_UI_BEHAVIOR_OVERRIDE`;
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/ui`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/ui/uiBehavior.ts`),
    [
      `export const ${exportName} = Object.freeze({`,
      `  debug: { providerMarker: ${JSON.stringify(agentId)} },`,
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
}

function writeCursorUiDescriptorFixture(repoRoot: string): void {
  writeUiDescriptorFixture(repoRoot, 'cursor', 'CURSOR_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'cursor',
    agentId: 'cursor',
    version: 1,
    display: {
      nameKey: 'test.cursor.descriptorName',
      subtitleKey: 'test.cursor.descriptorSubtitle',
      permissionModeI18nPrefix: 'test.cursor.permissionMode',
      availability: { experimental: false },
      connectedService: { serviceId: null, labelKey: 'test.cursor.descriptorName', connectRoute: null },
      flavorAliases: ['descriptor-cursor'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: {
        uiVendorResumeIdLabelKey: 'test.cursor.resumeId',
        uiVendorResumeIdCopiedKey: 'test.cursor.resumeCopied',
      },
      localControl: true,
      runtimeInput: { inFlightSteerSupported: true },
      toolRendering: { hideUnknownToolsByDefault: false },
      picker: {
        iconName: 'descriptor-icon',
        iconScale: 0.7,
        cliGlyph: 'C•',
        cliGlyphScale: 0.8,
        profileCompatibilityGlyphScale: 0.9,
      },
      avatarOverlay: { circleScale: 0.4, iconScaleRatio: 0.25 },
      icon: { assetId: 'cursor' },
    },
    settings: {},
    behavior: {
      guidance: { includeInSessionGettingStartedCliExamples: true },
      mcpServers: { supportsDetectedConfigScan: true },
      permissions: {
        footer: {
          usePermissionUpdates: false,
          forceReadOnlyAfterStop: false,
          supportsExecPolicyAmendment: true,
          stopHandling: 'denyOnly',
        },
      },
      workState: {
        editableGoals: {
          agentId: 'codex',
          modeValues: ['acp', 'appServer'],
          activeModeValues: ['appServer'],
          activeWhenNoPersistedMode: true,
          aliases: {
            mcp: 'appServer',
            mcp_resume: 'acp',
          },
          modeCandidates: [
            {
              path: ['runtimeDescriptorV1', 'provider', 'providerExtra', 'runtimeHandle', 'backendMode'],
              required: { path: ['runtimeDescriptorV1', 'providerId'], equals: 'codex' },
            },
            {
              path: ['runtimeDescriptorV1', 'provider', 'backendMode'],
              required: { path: ['runtimeDescriptorV1', 'providerId'], equals: 'codex' },
            },
            {
              path: ['agentRuntimeDescriptorV1', 'provider', 'providerExtra', 'runtimeHandle', 'backendMode'],
              required: { path: ['agentRuntimeDescriptorV1', 'providerId'], equals: 'codex' },
            },
            {
              path: ['agentRuntimeDescriptorV1', 'provider', 'backendMode'],
              required: { path: ['agentRuntimeDescriptorV1', 'providerId'], equals: 'codex' },
            },
            { path: ['codexRuntimeDescriptorV1', 'backendMode'] },
            { path: ['affinity', 'backendMode'] },
            { path: ['codexBackendMode'] },
            { path: ['directSessionV1', 'codexBackendMode'] },
            {
              path: ['externalSessionV1', 'codexBackendMode'],
              required: { path: ['externalSessionV1', 'providerId'], equals: 'codex' },
            },
          ],
          persistedGoalSnapshot: {
            path: ['sessionWorkStateV1'],
            itemKind: 'goal',
            providerFields: ['agentId', 'backendId'],
          },
        },
      },
      resume: {
        experimentSwitches: [
          {
            id: 'resumeAcp',
            when: {
              kind: 'settingEquals',
              settingKey: 'codexBackendMode',
              value: 'acp',
              aliases: {
                mcp: 'appServer',
                mcp_resume: 'acp',
              },
            },
          },
        ],
      },
      newSession: {
        relevantInstallableDeps: [
          {
            keys: ['codex-acp'],
            when: {
              all: [
                { kind: 'experimentsEnabled' },
                {
                  any: [
                    {
                      kind: 'settingEquals',
                      settingKey: 'codexBackendMode',
                      value: 'acp',
                      aliases: {
                        mcp: 'appServer',
                        mcp_resume: 'acp',
                      },
                    },
                    {
                      kind: 'settingTrue',
                      settingKey: 'experimentalCodexAcp',
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      payload: {
        sessionExtras: {
          agentId: 'codex',
          outputKey: 'codexBackendMode',
          values: ['acp', 'appServer'],
          aliases: {
            mcp: 'appServer',
            mcp_resume: 'acp',
          },
          settingsCandidates: [
            { path: ['codexBackendMode'] },
            { path: ['experimentalCodexAcp'], valueWhenTrue: 'acp' },
          ],
          metadataCandidates: [
            {
              path: ['runtimeDescriptorV1', 'provider', 'providerExtra', 'runtimeHandle', 'backendMode'],
              required: { path: ['runtimeDescriptorV1', 'providerId'], equals: 'codex' },
            },
            {
              path: ['runtimeDescriptorV1', 'provider', 'backendMode'],
              required: { path: ['runtimeDescriptorV1', 'providerId'], equals: 'codex' },
            },
            {
              path: ['agentRuntimeDescriptorV1', 'provider', 'providerExtra', 'runtimeHandle', 'backendMode'],
              required: { path: ['agentRuntimeDescriptorV1', 'providerId'], equals: 'codex' },
            },
            {
              path: ['agentRuntimeDescriptorV1', 'provider', 'backendMode'],
              required: { path: ['agentRuntimeDescriptorV1', 'providerId'], equals: 'codex' },
            },
            { path: ['codexRuntimeDescriptorV1', 'backendMode'] },
            { path: ['affinity', 'backendMode'] },
            { path: ['codexBackendMode'] },
            { path: ['directSessionV1', 'codexBackendMode'] },
            {
              path: ['externalSessionV1', 'codexBackendMode'],
              required: { path: ['externalSessionV1', 'providerId'], equals: 'codex' },
            },
          ],
        },
      },
    },
    session: {},
    message: {},
    components: {
      slots: [
        {
          id: 'claude.subagentLaunchCards',
          slot: 'sessionSubagents.launchCards',
          componentId: 'firstParty.claude.subagentLaunchCards',
          props: {
            teamIds: {
              kind: 'subagentGroupKeys',
              subagentKinds: ['agent_team_member'],
            },
          },
        },
        {
          id: 'claude.teammateDetailsTab',
          slot: 'sessionSubagents.teammateDetailsTab',
          componentId: 'firstParty.claude.teammateDetailsTab',
          resourceKind: 'claudeSubagentLauncher',
          iconName: 'people',
          tab: {
            keyPrefix: 'claude-subagent-launcher',
            titleKey: 'session.subagents.panel.launchTeammateAction',
            subtitleKey: 'session.subagents.panel.launchClaudeTeamsSubtitle',
          },
        },
      ],
    },
    assets: { svgIcon: { assetId: 'cursor' } },
  });
}

function writeClaudeUiDescriptorFixture(repoRoot: string): void {
  writeUiDescriptorFixture(repoRoot, 'claude', 'CLAUDE_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'claude',
    agentId: 'claude',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.claude',
      subtitleKey: 'profiles.aiBackend.claudeSubtitle',
      permissionModeI18nPrefix: 'agentInput.permissionMode',
      availability: { experimental: false },
      connectedService: {
        serviceId: 'anthropic',
        labelKey: 'agentInput.agent.claude',
        connectRoute: '/(app)/settings/connect/claude',
      },
      flavorAliases: ['claude'],
      permissions: { modeGroup: 'claude', promptProtocol: 'claude' },
      sessionModes: {
        staticOptions: [
          { id: 'default', nameKey: 'agentInput.mode.build', descriptionKey: 'agentInput.mode.buildDescription' },
          { id: 'plan', nameKey: 'agentInput.mode.plan', descriptionKey: 'agentInput.mode.planDescription' },
        ],
      },
      resume: {
        uiVendorResumeIdLabelKey: 'sessionInfo.claudeCodeSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.claudeCodeSessionIdCopied',
      },
      localControl: true,
      toolRendering: { hideUnknownToolsByDefault: false },
      picker: {
        iconName: 'sparkles-outline',
        cliGlyph: '✳︎',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.14,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'claude' },
    },
    behavior: { descriptorId: 'claude.uiBehavior.v1' },
    session: {
      providerBehaviorDescriptorId: 'claude.sessionProviderBehavior.v1',
      visibleMessages: {
        kind: 'session.visibleMessages.v1',
        subagentKinds: ['agent_team_member'],
        fallbackToolNames: ['Agent', 'Task'],
        excludeJsonEventTypes: ['idle_notification', 'shutdown_approved'],
      },
    },
    message: {
      metaOverrides: [
        {
          id: 'reasoning-effort',
          targetKey: 'reasoningEffort',
          value: {
            kind: 'sessionConfigOptionOverride',
            key: 'reasoning_effort',
          },
          normalize: 'trimLowercase',
        },
      ],
    },
    components: {
      slots: [
        {
          id: 'claude.subagentLaunchCards',
          slot: 'sessionSubagents.launchCards',
          componentId: 'firstParty.claude.subagentLaunchCards',
          props: {
            teamIds: {
              kind: 'subagentGroupKeys',
              subagentKinds: ['agent_team_member'],
            },
          },
        },
        {
          id: 'claude.teammateDetailsTab',
          slot: 'sessionSubagents.teammateDetailsTab',
          componentId: 'firstParty.claude.teammateDetailsTab',
          resourceKind: 'claudeSubagentLauncher',
          iconName: 'people',
          tab: {
            keyPrefix: 'claude-subagent-launcher',
            titleKey: 'session.subagents.panel.launchTeammateAction',
            subtitleKey: 'session.subagents.panel.launchClaudeTeamsSubtitle',
          },
        },
      ],
    },
    assets: { svgIcon: { assetId: 'claude' } },
  });
}

function writeOpenCodeUiDescriptorFixture(repoRoot: string): void {
  writeUiDescriptorFixture(repoRoot, 'opencode', 'OPENCODE_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'opencode',
    agentId: 'opencode',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.opencode',
      subtitleKey: 'profiles.aiBackend.opencodeSubtitle',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: false },
      connectedService: { serviceId: null, labelKey: 'agentInput.agent.opencode', connectRoute: null },
      flavorAliases: ['opencode', 'open-code'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: {
        uiVendorResumeIdLabelKey: 'sessionInfo.opencodeSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.opencodeSessionIdCopied',
      },
      localControl: true,
      toolRendering: { hideUnknownToolsByDefault: false },
      picker: {
        iconName: 'code-slash-outline',
        iconScale: 0.9,
        cliGlyph: '</>',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'opencode' },
    },
    behavior: {
      descriptorId: 'opencode.uiBehavior.v1',
      guidance: { includeInSessionGettingStartedCliExamples: true },
      mcpServers: { supportsDetectedConfigScan: true },
      externalSessions: {
        supportsBackgroundFollow: false,
        browse: {
          order: 30,
          sourceOptions: [
            {
              key: 'opencode:default',
              labelKey: 'externalSessions.browseSourceOpenCodeDefault',
              source: { kind: 'opencodeServer' },
            },
          ],
          compatibleSource: {
            sourceKind: 'opencodeServer',
            optionalFields: ['baseUrl', 'directory'],
          },
        },
      },
      payload: {
        environmentVariables: {
          agentId: 'opencode',
          backendMode: {
            envKey: 'HAPPIER_OPENCODE_BACKEND_MODE',
            settingKey: 'opencodeBackendMode',
            legacyMetadataKey: 'opencodeBackendMode',
            runtimeDescriptorField: 'backendMode',
            defaultValue: 'server',
            values: ['server', 'acp'],
          },
          serverBaseUrl: {
            envKey: 'HAPPIER_OPENCODE_SERVER_URL',
            explicitEnvKey: 'HAPPIER_OPENCODE_SERVER_URL_EXPLICIT',
            settingKey: 'opencodeServerBaseUrl',
            byServerIdSettingKey: 'opencodeServerBaseUrlByServerIdV1',
            legacyMetadataKey: 'opencodeServerBaseUrl',
            legacyExplicitMetadataKey: 'opencodeServerBaseUrlExplicit',
            runtimeDescriptorField: 'serverBaseUrl',
            runtimeDescriptorExplicitField: 'serverBaseUrlExplicit',
            allowedProtocols: ['http:', 'https:'],
            rejectCredentials: true,
            httpLoopbackOnly: true,
            originOnly: true,
          },
        },
      },
    },
    session: {},
    message: {},
    components: { slots: [] },
    assets: {
      svgIcon: {
        assetId: 'opencode',
        viewBox: '0 0 240 300',
        paths: [
          {
            fillToken: 'text.primary',
            fillRule: 'evenodd',
            clipRule: 'evenodd',
            d: 'M0 0H240V300H0V0ZM60 60H180V240H60V60Z',
          },
          {
            fillToken: 'text.primary',
            fillOpacity: 0.25,
            d: 'M60 120H180V240H60V120Z',
          },
        ],
      },
    },
  });
}

function writeAuggieUiDescriptorFixture(repoRoot: string): void {
  writeUiDescriptorFixture(repoRoot, 'auggie', 'AUGGIE_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'auggie',
    agentId: 'auggie',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.auggie',
      subtitleKey: 'profiles.aiBackend.auggieSubtitle',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: true },
      connectedService: { serviceId: null, labelKey: 'agentInput.agent.auggie', connectRoute: null },
      flavorAliases: ['auggie'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: {
        uiVendorResumeIdLabelKey: 'sessionInfo.auggieSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.auggieSessionIdCopied',
      },
      toolRendering: { hideUnknownToolsByDefault: false },
      picker: {
        iconName: 'sparkles',
        iconScale: 1.15,
        cliGlyph: 'A',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'auggie' },
    },
    behavior: { descriptorId: 'auggie.uiBehavior.v1' },
    session: {},
    message: {},
    components: {
      slots: [
        {
          id: 'auggie.allowIndexingChip',
          slot: 'newSession.agentInputExtraActionChips',
          componentId: 'firstParty.auggie.allowIndexingChip',
          props: { optionStateKey: 'allowIndexing' },
        },
      ],
    },
    assets: { svgIcon: { assetId: 'auggie' } },
  });
}

function writeKimiUiDescriptorFixture(repoRoot: string): void {
  writeUiDescriptorFixture(repoRoot, 'kimi', 'KIMI_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'kimi',
    agentId: 'kimi',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.kimi',
      subtitleKey: 'profiles.aiBackend.kimiSubtitleExperimental',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: true },
      connectedService: { serviceId: null, labelKey: 'agentInput.agent.kimi', connectRoute: null },
      flavorAliases: ['kimi', 'kimi-cli'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: {
        uiVendorResumeIdLabelKey: 'sessionInfo.kimiSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.kimiSessionIdCopied',
      },
      toolRendering: { hideUnknownToolsByDefault: true },
      picker: {
        iconName: 'code-slash-outline',
        cliGlyph: 'K',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'kimi' },
    },
    behavior: {},
    session: {},
    message: {},
    components: { slots: [] },
    assets: { svgIcon: { assetId: 'kimi' } },
  });
}

function writeCodexUiDescriptorFixture(repoRoot: string): void {
  writeUiDescriptorFixture(repoRoot, 'codex', 'CODEX_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'codex',
    agentId: 'codex',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.codex',
      subtitleKey: 'profiles.aiBackend.codexSubtitle',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: false },
      connectedService: { serviceId: 'openai', labelKey: 'agentInput.agent.codex', connectRoute: null },
      flavorAliases: ['codex', 'codex-acp', 'codex-mcp', 'openai', 'gpt'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: {
        uiVendorResumeIdLabelKey: 'sessionInfo.codexSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.codexSessionIdCopied',
      },
      localControl: true,
      toolRendering: { hideUnknownToolsByDefault: false },
      picker: {
        iconName: 'terminal-outline',
        cliGlyph: '꩜',
        cliGlyphScale: 0.92,
        profileCompatibilityGlyphScale: 0.82,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'codex' },
    },
    settings: {},
    behavior: {},
    session: {},
    message: {},
    components: { slots: [] },
    assets: { svgIcon: { assetId: 'codex' } },
  });
}

function writePiUiDescriptorFixture(repoRoot: string): void {
  writeUiDescriptorFixture(repoRoot, 'pi', 'PI_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'pi',
    agentId: 'pi',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.pi',
      subtitleKey: 'profiles.aiBackend.piSubtitleExperimental',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: true },
      connectedService: { serviceId: null, labelKey: 'agentInput.agent.pi', connectRoute: null },
      flavorAliases: ['pi'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      runtimeInput: { inFlightSteerSupported: true },
      resume: {
        uiVendorResumeIdLabelKey: 'sessionInfo.piSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.piSessionIdCopied',
      },
      toolRendering: { hideUnknownToolsByDefault: true },
      picker: {
        iconName: 'code-slash-outline',
        iconScale: 0.9,
        cliGlyph: 'PI',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'pi' },
    },
    behavior: { descriptorId: 'pi.uiBehavior.v1' },
    session: {},
    message: {},
    components: { slots: [] },
    assets: { svgIcon: { assetId: 'pi' } },
  });
}

function writeOhMyPiUiDescriptorFixture(repoRoot: string, pluginPackageId = 'ohmypi'): void {
  writeUiDescriptorFixture(repoRoot, pluginPackageId, 'OH_MY_PI_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'ohmypi',
    agentId: 'ohMyPi',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.ohMyPi',
      subtitleKey: 'profiles.aiBackend.ohMyPiSubtitleExperimental',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: true },
      connectedService: { serviceId: null, labelKey: 'agentInput.agent.ohMyPi', connectRoute: null },
      flavorAliases: ['ohMyPi', 'oh-my-pi', 'omp'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: { uiVendorResumeIdLabelKey: null, uiVendorResumeIdCopiedKey: null },
      toolRendering: { hideUnknownToolsByDefault: false },
      picker: {
        iconName: 'planet-outline',
        iconScale: 0.9,
        cliGlyph: 'OMP',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'ohMyPi' },
    },
    settings: {},
    behavior: {},
    session: {},
    message: {},
    components: { slots: [] },
    assets: { svgIcon: { assetId: 'ohMyPi' } },
  });
}

function writePiContributionPluginFixture(repoRoot: string): void {
  writeJson(resolve(repoRoot, 'packages/plugins/pi/package.json'), {
    name: '@happier-dev/plugins-pi',
    version: '0.0.0',
  });
  mkdirSync(resolve(repoRoot, 'packages/plugins/pi/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/pi/src/manifest.ts'),
    pluginManifestSource({ id: 'happier.agent.pi', capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/pi/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/pi/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "pi",',
      '  runtimeContributions: {',
      '    sessionControlAdapter: { kind: "runtimeDescriptorResumeId", providerId: "pi", absolutePathField: "sessionFile", fallbackField: "providerSessionId" },',
      '    runtimeDescriptorReader: { kind: "providerSessionId", providerId: "pi", runtimeHandle: "providerSessionId" },',
      '    protocolRuntimeDescriptor: { kind: "providerRuntimeDescriptorV1", providerId: "pi", source: "./protocol/runtimeDescriptorV1", buildFunction: "buildPiAgentRuntimeDescriptorV1", canonicalReader: "readCanonicalPiAgentRuntimeDescriptorV1" },',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/pi/src/protocol'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/pi/src/protocol/runtimeDescriptorV1.ts'),
    [
      'export type PiAgentRuntimeDescriptorV1 = Readonly<{ agentId: "pi" }>;',
      'export type CanonicalPiAgentRuntimeDescriptorV1 = Readonly<{ agentId: "pi" }>;',
      'export function buildPiAgentRuntimeDescriptorV1(): PiAgentRuntimeDescriptorV1 { return { agentId: "pi" }; }',
      'export function readCanonicalPiAgentRuntimeDescriptorV1(): CanonicalPiAgentRuntimeDescriptorV1 { return { agentId: "pi" }; }',
      '',
    ].join('\n'),
    'utf8',
  );
  writePiUiDescriptorFixture(repoRoot);
}

function writeRuntimeContributionPluginFixture(
  repoRoot: string,
  pluginPackageId: string,
  agentId: string,
  runtimeContributions: readonly string[],
): void {
  writeJson(resolve(repoRoot, `packages/plugins/${pluginPackageId}/package.json`), {
    name: `@happier-dev/plugins-${pluginPackageId}`,
    version: '0.0.0',
    ...requiredVoiceExportsForFixture(pluginPackageId),
  });
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/manifest.ts`),
    pluginManifestSource({ id: `happier.agent.${pluginPackageId}`, capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/agent`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/agent/definition.ts`),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      `  id: ${JSON.stringify(agentId)},`,
      '  runtimeContributions: {',
      ...runtimeContributions.map((line) => `    ${line}`),
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  if (runtimeContributions.some((line) => line.includes('protocolRuntimeDescriptor'))) {
    const runtimeDescriptorSourceByAgentId: Record<string, string> = {
      codex: [
        'export type CodexAgentRuntimeDescriptorV1 = Readonly<{ agentId: "codex" }>;',
        'export type CanonicalCodexAgentRuntimeDescriptorV1 = Readonly<{ agentId: "codex" }>;',
        'export function buildCodexAgentRuntimeDescriptorV1(): CodexAgentRuntimeDescriptorV1 { return { agentId: "codex" }; }',
        'export function readCanonicalCodexAgentRuntimeDescriptorV1(): CanonicalCodexAgentRuntimeDescriptorV1 { return { agentId: "codex" }; }',
        '',
      ].join('\n'),
      opencode: [
        'export type OpenCodeAgentRuntimeDescriptorV1 = Readonly<{ agentId: "opencode" }>;',
        'export type CanonicalOpenCodeAgentRuntimeDescriptorV1 = Readonly<{ agentId: "opencode" }>;',
        'export function buildOpenCodeAgentRuntimeDescriptorV1(): OpenCodeAgentRuntimeDescriptorV1 { return { agentId: "opencode" }; }',
        'export function readCanonicalOpenCodeAgentRuntimeDescriptorV1(): CanonicalOpenCodeAgentRuntimeDescriptorV1 { return { agentId: "opencode" }; }',
        '',
      ].join('\n'),
      pi: [
        'export type PiAgentRuntimeDescriptorV1 = Readonly<{ agentId: "pi" }>;',
        'export type CanonicalPiAgentRuntimeDescriptorV1 = Readonly<{ agentId: "pi" }>;',
        'export function buildPiAgentRuntimeDescriptorV1(): PiAgentRuntimeDescriptorV1 { return { agentId: "pi" }; }',
        'export function readCanonicalPiAgentRuntimeDescriptorV1(): CanonicalPiAgentRuntimeDescriptorV1 { return { agentId: "pi" }; }',
        '',
      ].join('\n'),
    };
    const source = runtimeDescriptorSourceByAgentId[agentId];
    if (source) {
      mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/protocol`), { recursive: true });
      writeFileSync(
        resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/protocol/runtimeDescriptorV1.ts`),
        source,
        'utf8',
      );
    }
  }
}

function writeManifestOwnedExternalSessionSourceFixture(
  repoRoot: string,
  pluginPackageId: string,
  agentId: string,
  sourceDeclaration: string,
): void {
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/manifest.ts`),
    pluginManifestSource({
      id: `happier.agent.${pluginPackageId}`,
      capabilities: ['agents'],
      contributes: [
        '{',
        '  agents: [{',
        `    id: ${JSON.stringify(agentId)},`,
        '    title: "Test agent",',
        '    runtime: { kind: "custom" },',
        '    cli: {',
        `      displayName: ${JSON.stringify(`${agentId} CLI`)},`,
        `      executable: { binaryName: ${JSON.stringify(agentId)}, sourcePreference: "system-first" },`,
        '      install: { managed: null, manual: { kind: "none" } },',
        '      auth: {',
        '        support: "unsupported",',
        '        probe: { parser: "none", backgroundChecks: "manual_only", statusArgs: null },',
        '        loginLaunches: [],',
        '      },',
        '    },',
        '    primary: "sessions",',
        '    capabilities: {',
        '      surfaces: ["externalSessions"],',
        '      sessions: { open: ["create"], delivery: ["newTurn"], cancel: true },',
        '    },',
        '    surfaces: {',
        '      externalSession: {',
        `        sources: [${sourceDeclaration}],`,
        '      },',
        '    },',
        '  }],',
        '}',
      ].join('\n'),
    }),
    'utf8',
  );
}

function writeProtocolProjectionFixture(
  repoRoot: string,
  pluginPackageId: string,
  fileName: string,
  sourceLines: readonly string[],
): void {
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/protocol`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/protocol/${fileName}.ts`),
    `${sourceLines.join('\n')}\n`,
    'utf8',
  );
}

test('generateBundledPluginEntries writes deterministic bundled plugin contribution outputs', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-'));

  writeJson(resolve(repoRoot, 'packages/plugins/claude/package.json'), {
    name: '@happier-dev/plugins-claude',
    version: '0.0.0',
  });
  writeJson(resolve(repoRoot, 'packages/plugins/codex/package.json'), {
    name: '@happier-dev/plugins-codex',
    version: '0.0.0',
    exports: {
      './ui/voice': {
        types: './dist/ui/voice/index.d.ts',
        default: './dist/ui/voice/index.js',
      },
    },
  });
  writeAgentPluginFixture(repoRoot, 'cursor');
  writeCursorUiDescriptorFixture(repoRoot);
  writeAgentPluginFixture(repoRoot, 'auggie');
  writeAuggieUiDescriptorFixture(repoRoot);
  writeUiBehaviorOverrideFixture(repoRoot, 'auggie');
  writeAgentPluginFixture(repoRoot, 'kimi');
  writeKimiUiDescriptorFixture(repoRoot);
  writeAgentPluginFixture(repoRoot, 'pi');
  writePiUiDescriptorFixture(repoRoot);
  writeUiBehaviorOverrideFixture(repoRoot, 'pi');

  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/manifest.ts'),
    pluginManifestSource({ id: 'happier.agent.claude', capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "claude",',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src/agent/contributions'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/agent/contributions/runtime.ts'),
    [
      'export const CLAUDE_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({',
      '  agentId: "claude",',
      '  connectedServices: { serviceIds: ["claude-subscription"] },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeClaudeUiDescriptorFixture(repoRoot);
  writeUiBehaviorOverrideFixture(repoRoot, 'claude');

  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/manifest.ts'),
    pluginManifestSource({ id: 'happier.agent.codex', capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "codex",',
      '  runtimeContributions: {',
      '    agentCatalogEntry: { importName: "CODEX_AGENT_RUNTIME_CONTRIBUTION", source: "./agent/contributions/runtime" },',
      '  },',
      '  commandPolicy: {',
      '    daemonAutostartDefault: "preferLocalTui",',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src/agent/contributions'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/agent/contributions/runtime.ts'),
    [
      'export const CODEX_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({',
      '  agentId: "codex",',
      '  externalSessions: {',
      '    createCandidateHostAdapter: () => ({ agentId: "codex", listViaChildHost: async () => ({ candidates: [], nextCursor: null }) }),',
      '    createTranscriptStoreAdapter: () => ({ agentId: "codex" }),',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeCodexUiDescriptorFixture(repoRoot);
  writeUiBehaviorOverrideFixture(repoRoot, 'codex');
  writeProviderContributionPluginFixture(repoRoot);

  writeGeneratorOutputScaffold(
    repoRoot,
    [
      'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);',
      'export const SOME_OTHER_EXPORT = 123;',
      '',
    ].join('\n'),
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_IMPLEMENTATION_BINDINGS/);
  assert.match(cliOut, /createPluginContributionIdentity/);
  assert.doesNotMatch(cliOut, /BUNDLED_FIRST_PARTY_AGENT_CONTRIBUTIONS/);
  assert.doesNotMatch(cliOut, /BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS/);
  assert.doesNotMatch(cliOut, /BUNDLED_FIRST_PARTY_AGENT_RUNTIME_CONTRIBUTIONS/);
  assert.doesNotMatch(cliOut, /BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS/);
  assert.match(cliOut, /import \{ CLAUDE_AGENT_RUNTIME_CONTRIBUTION \} from '@happier-dev\/plugins-claude\/agent\/contributions\/runtime';/);
  assert.doesNotMatch(cliOut, /@\/session\/external\/hostAdapters\/codex/);
  assert.doesNotMatch(cliOut, /CODEX_EXTERNAL_SESSION_CREATE_CANDIDATE_HOST_ADAPTER/);
  assert.doesNotMatch(cliOut, /CODEX_EXTERNAL_SESSION_CREATE_TRANSCRIPT_STORE_ADAPTER/);
  assert.doesNotMatch(cliOut, /@\/backends\/codex/);
  assert.doesNotMatch(cliOut, /from '@happier-dev\/agents'/);
  assert.doesNotMatch(cliOut, /getAllAgentDefinitionContracts|getAllBackendCatalogDefinitions|getAgentCatalogDefinition|getProviderCliRuntimeSpec/);
  assert.doesNotMatch(cliOut, /AgentCliRuntimeDescriptor/);
  assert.doesNotMatch(cliOut, /BUNDLED_FIRST_PARTY_AGENT_CLI_RUNTIME_SPECS_BY_ID/);
  assert.doesNotMatch(cliOut, /runtimeSpec:/);
  assert.match(
    cliOut,
    /implementation:\s*createAgentRuntimeCatalogEntryHooks\(\{[\s\S]*contribution:\s*CODEX_AGENT_RUNTIME_CONTRIBUTION,/,
  );
  assert.doesNotMatch(cliOut, /systemTools:/);
  assert.match(
    cliOut,
    /sourceSpec:\s*Object\.freeze\(\{[\s\S]*kind:\s*'bundled'/,
  );
  assert.doesNotMatch(cliOut, /BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS/);
  assert.match(cliOut, /@happier-dev\/plugins-claude/);
  assert.match(cliOut, /@happier-dev\/plugins-codex/);
  assert.ok(
    cliOut.indexOf('@happier-dev/plugins-claude') < cliOut.indexOf('@happier-dev/plugins-codex'),
    'expected lexical order',
  );

  const uiOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );
  assert.doesNotMatch(uiOut, /SOME_OTHER_EXPORT/);
  assert.doesNotMatch(uiOut, /maintained in-place/);
  assert.match(uiOut, /This file is emitted by:/);
  assert.match(uiOut, /BUNDLED_CANONICAL_AGENTS_CORE/);
  assert.match(uiOut, /BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES/);
  assert.match(
    uiOut,
    /ohMyPi:\s*Object\.freeze\(\{\s*pluginId:\s*"happier\.agent\.ohmypi",\s*localId:\s*"ohmypi",/,
  );
  assertNoExecutableUiProjectionImports(uiOut);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/auggie\/core/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/auggie\/ui/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/qwen\/core/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/qwen\/ui/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/kimi\/core/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/kimi\/ui/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/cursor\/core/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/cursor\/ui/);
  assert.match(uiOut, /const CURSOR_CORE: AgentCoreConfig/);
  assert.match(uiOut, /runtimeInput:\s*\{\s*inFlightSteerSupported:\s*true,\s*\}/);
  assert.match(uiOut, /cursor:\s*CURSOR_CORE/);
  assert.match(uiOut, /cursor:\s*CURSOR_UI/);
  assert.match(uiOut, /const AUGGIE_CORE: AgentCoreConfig/);
  assert.match(uiOut, /auggie:\s*AUGGIE_CORE/);
  assert.match(uiOut, /auggie:\s*AUGGIE_UI/);
  assert.match(uiOut, /const QWEN_CORE: AgentCoreConfig/);
  assert.match(uiOut, /hideUnknownToolsByDefault:\s*true/);
  assert.match(uiOut, /qwen:\s*QWEN_CORE/);
  assert.match(uiOut, /qwen:\s*QWEN_UI/);
  assert.match(uiOut, /const KIMI_CORE: AgentCoreConfig/);
  assert.match(uiOut, /kimi:\s*KIMI_CORE/);
  assert.match(uiOut, /kimi:\s*KIMI_UI/);

  const uiBehaviorOverridesOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts'),
    'utf8',
  );
  assertNoExecutableUiProjectionImports(uiBehaviorOverridesOut, { allowPluginUiBehaviorImports: true });
  assert.match(uiBehaviorOverridesOut, /BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES/);
  assert.match(uiBehaviorOverridesOut, /BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS/);
  assert.match(uiBehaviorOverridesOut, /@happier-dev\/plugins-auggie\/ui/);
  assert.match(uiBehaviorOverridesOut, /@happier-dev\/plugins-claude\/ui/);
  assert.match(uiBehaviorOverridesOut, /@happier-dev\/plugins-codex\/ui/);
  assert.match(uiBehaviorOverridesOut, /@happier-dev\/plugins-pi\/ui/);
  assert.match(uiBehaviorOverridesOut, /auggie:\s*AUGGIE_UI_BEHAVIOR_OVERRIDE/);
  assert.match(uiBehaviorOverridesOut, /claude:\s*CLAUDE_UI_BEHAVIOR_OVERRIDE/);
  assert.match(uiBehaviorOverridesOut, /codex:\s*CODEX_UI_BEHAVIOR_OVERRIDE/);
  assert.match(uiBehaviorOverridesOut, /pi:\s*PI_UI_BEHAVIOR_OVERRIDE/);
  assert.match(uiBehaviorOverridesOut, /claude\.uiBehavior\.v1/);
  assert.match(uiBehaviorOverridesOut, /auggie\.uiBehavior\.v1/);
  assert.match(uiBehaviorOverridesOut, /firstParty\.auggie\.allowIndexingChip/);
  assert.match(uiBehaviorOverridesOut, /resumeAcp/);
  assert.match(uiBehaviorOverridesOut, /codex-acp/);
  assert.match(uiBehaviorOverridesOut, /metaOverrides/);
  assert.match(uiBehaviorOverridesOut, /reasoning_effort/);
  assert.doesNotMatch(uiBehaviorOverridesOut, /codex\.uiBehavior\.v1/);

  const sessionAgentBehaviorsOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.sessionAgentBehaviors.ts'),
    'utf8',
  );
  assertNoExecutableUiProjectionImports(sessionAgentBehaviorsOut);
  assert.match(sessionAgentBehaviorsOut, /BUNDLED_CANONICAL_AGENT_SESSION_BEHAVIORS/);
  assert.match(sessionAgentBehaviorsOut, /BUNDLED_CANONICAL_AGENT_SESSION_BEHAVIOR_DESCRIPTORS/);
  assert.match(sessionAgentBehaviorsOut, /claude\.sessionProviderBehavior\.v1/);

  assert.equal(
    existsSync(resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.agentSettings.ts')),
    false,
    'the retired UI Agent-settings registry must not be generated',
  );
  assert.equal(
    existsSync(resolve(repoRoot, 'packages/agents/src/agentSettings/generated/bundledAgentSettings.ts')),
    false,
    'the retired host Agent-settings registry must not be generated',
  );

  const visibleMessageResolversOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers.ts'),
    'utf8',
  );
  assertNoExecutableUiProjectionImports(visibleMessageResolversOut);
  assert.match(visibleMessageResolversOut, /BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY/);
  assert.match(visibleMessageResolversOut, /BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_DESCRIPTORS/);
  assert.match(visibleMessageResolversOut, /session\.visibleMessages\.v1/);
  assert.match(visibleMessageResolversOut, /idle_notification/);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.match(agentsOut, /BUNDLED_AGENT_DEFINITION_IDS/);
  assert.match(agentsOut, /BUNDLED_AGENT_DEFINITIONS_BY_ID/);
  assert.match(agentsOut, /\bbundledAgentDefinitions\b/);
  assert.match(agentsOut, /"claude":\s*Object\.freeze\(\(\{/);
  assert.match(agentsOut, /\}\) as const\),\n\s+"codex":/);
  assert.match(agentsOut, /"claude":\s*Object\.freeze\(/);
  assert.match(agentsOut, /"codex":\s*Object\.freeze\(/);
  assert.match(agentsOut, /"id":\s*"claude"/);
  assert.match(agentsOut, /"id":\s*"codex"/);
  const claudeBlock = readGeneratedAgentBlock(agentsOut, 'claude', 'codex');
  const codexBlock = readGeneratedAgentBlock(agentsOut, 'codex', 'cursor');
  const cursorBlock = readGeneratedAgentBlock(agentsOut, 'cursor');
  assert.match(claudeBlock, /"cli":/);
  assert.doesNotMatch(claudeBlock, /"(?:agentCliRuntime|authProbeConfig|localCli|providerCliRuntime)":/);
  assert.match(codexBlock, /"cli":/);
  assert.doesNotMatch(codexBlock, /"(?:agentCliRuntime|authProbeConfig|localCli|providerCliRuntime)":/);
  assert.match(cursorBlock, /"cli":/);
  assert.doesNotMatch(cursorBlock, /"(?:agentCliRuntime|authProbeConfig|localCli|providerCliRuntime)":/);

  const agentIdsOut = readGeneratedAgentIdsOutput(repoRoot);
  assert.match(agentIdsOut, /export const AGENT_IDS/);
  assert.match(agentIdsOut, /export type AgentId/);
  assert.match(agentIdsOut, /export function isAgentId/);
  const agentIds = readGeneratedStringArray(agentIdsOut, 'AGENT_IDS');
  assert.ok(agentIds.includes('gemini'));
  assert.ok(agentIds.includes('auggie'));
  assert.ok(agentIds.includes('copilot'));
  assert.ok(
    agentIds.indexOf('claude') < agentIds.indexOf('codex')
      && agentIds.indexOf('codex') < agentIds.indexOf('cursor'),
    'expected generated ids to follow canonical runtime order',
  );

  const protocolAgentProviderIdsOut = readGeneratedProtocolAgentProviderIdsOutput(repoRoot);
  assert.match(protocolAgentProviderIdsOut, /GENERATED FILE CONTRACT \(A\.X-agent-ids-codegen\)/);
  assert.match(protocolAgentProviderIdsOut, /export const AGENT_PROVIDER_IDS_V1/);
  assert.match(protocolAgentProviderIdsOut, /export const AgentProviderIdV1Schema/);
  assert.deepEqual(readGeneratedStringArray(protocolAgentProviderIdsOut, 'AGENT_PROVIDER_IDS_V1'), [
    'claude',
    'codex',
    'opencode',
    'antigravity',
    'pi',
    'ohMyPi',
  ]);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
});

test('generateBundledPluginEntries check mode rejects generated agent provider id drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-agent-ids-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const agentIdsOutPath = resolve(repoRoot, 'packages/agents/src/generated/agentIds.ts');
  writeFileSync(agentIdsOutPath, 'export const AGENT_IDS = Object.freeze([]);\n', 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*agentIds\.ts/,
  );
});

test('generateBundledPluginEntries check mode rejects protocol agent provider id drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-protocol-agent-ids-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const agentIdsOutPath = resolve(repoRoot, 'packages/protocol/src/generated/providers/agentProviderIdsV1.ts');
  writeFileSync(agentIdsOutPath, 'export const AGENT_PROVIDER_IDS_V1 = Object.freeze([] as const);\n', 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*agentProviderIdsV1\.ts/,
  );
});

test('generateBundledPluginEntries check mode rejects stale runtime descriptor reader imports', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-runtime-descriptor-readers-check-'));
  const opencodeGeneratedReader = '{ agentId: "opencode", backendModeKey: "backendMode", runtimeKind: { aliases: [{ input: "server", runtimeKind: "server" }] }, fields: [{ key: "backendMode", kind: "runtimeKind", runtimeHandle: "whenPresent" }, { key: "providerSessionId", kind: "trimmedString", runtimeHandle: "whenPresent" }] }';
  writeRuntimeContributionPluginFixture(repoRoot, 'opencode', 'opencode', [
    `runtimeDescriptorReader: { kind: "providerRuntimeDescriptorReader", providerId: "opencode", source: "./agent/identity/runtimeDescriptor", exportName: "readOpenCodeSessionMetadataRuntimeDescriptor", generatedReader: ${opencodeGeneratedReader} },`,
  ]);
  writeOpenCodeUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const runtimeDescriptorReadersOutPath = resolve(repoRoot, 'packages/agents/src/generated/runtimeDescriptorReaders.ts');
  writeFileSync(
    runtimeDescriptorReadersOutPath,
    [
      '/**',
      ' * GENERATED FILE CONTRACT (A.16y.3-provider-session-control-and-runtime-descriptor-projections)',
      ' *',
      ' * This file is emitted by:',
      ' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`',
      ' */',
      '',
      "import { readOpenCodeSessionMetadataRuntimeDescriptor } from '../providers/opencode/readSessionMetadataRuntimeDescriptor.js';",
      "import type { RuntimeDescriptorReaderMap } from '../runtime/identity/runtimeDescriptorTypes.js';",
      '',
      "export const GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS = ['opencode'] as const;",
      'export type GeneratedRuntimeDescriptorReaderProviderId =',
      '  (typeof GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS)[number];',
      '',
      'export const GENERATED_RUNTIME_DESCRIPTOR_READERS: Readonly<Pick<RuntimeDescriptorReaderMap, GeneratedRuntimeDescriptorReaderProviderId>> = Object.freeze({',
      '  opencode: readOpenCodeSessionMetadataRuntimeDescriptor,',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*runtimeDescriptorReaders\.ts/,
  );
});

test('generateBundledPluginEntries emits runtime contribution seams into package-local generated artifacts', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-pi-runtime-contributions-'));
  const codexGeneratedReader = '{ agentId: "codex", backendModeKey: "backendMode", runtimeKind: { aliases: [{ input: "appServer", runtimeKind: "appServer" }] }, fields: [{ key: "backendMode", kind: "runtimeKind", runtimeHandle: "whenPresent" }, { key: "providerSessionId", kind: "trimmedString", runtimeHandle: "whenPresent" }] }';
  const opencodeGeneratedReader = '{ agentId: "opencode", backendModeKey: "backendMode", runtimeKind: { aliases: [{ input: "server", runtimeKind: "server" }] }, fields: [{ key: "backendMode", kind: "runtimeKind", runtimeHandle: "whenPresent" }, { key: "providerSessionId", kind: "trimmedString", runtimeHandle: "whenPresent" }] }';
  writeRuntimeContributionPluginFixture(repoRoot, 'codex', 'codex', [
    `sessionControlAdapter: { kind: "providerSessionControlAdapter", providerId: "codex", source: "./agent/surfaces/sessions/controls/adapter", exportName: "CODEX_SESSION_CONTROL_ADAPTER", generatedAdapter: { agentId: "codex", runtimeDescriptor: ${codexGeneratedReader} } },`,
    `runtimeDescriptorReader: { kind: "providerRuntimeDescriptorReader", providerId: "codex", source: "./agent/identity/runtimeDescriptor", exportName: "readCodexSessionMetadataRuntimeDescriptor", generatedReader: ${codexGeneratedReader} },`,
    'protocolRuntimeDescriptor: { kind: "providerRuntimeDescriptorV1", providerId: "codex", source: "./protocol/runtimeDescriptorV1", buildFunction: "buildCodexAgentRuntimeDescriptorV1", canonicalReader: "readCanonicalCodexAgentRuntimeDescriptorV1" },',
  ]);
  writeRuntimeContributionPluginFixture(repoRoot, 'opencode', 'opencode', [
    `sessionControlAdapter: { kind: "providerSessionControlAdapter", providerId: "opencode", source: "./agent/surfaces/sessions/controls/adapter", exportName: "OPENCODE_SESSION_CONTROL_ADAPTER", generatedAdapter: { agentId: "opencode", runtimeDescriptor: ${opencodeGeneratedReader} } },`,
    `runtimeDescriptorReader: { kind: "providerRuntimeDescriptorReader", providerId: "opencode", source: "./agent/identity/runtimeDescriptor", exportName: "readOpenCodeSessionMetadataRuntimeDescriptor", generatedReader: ${opencodeGeneratedReader} },`,
    'protocolRuntimeDescriptor: { kind: "providerRuntimeDescriptorV1", providerId: "opencode", source: "./protocol/runtimeDescriptorV1", buildFunction: "buildOpenCodeAgentRuntimeDescriptorV1", canonicalReader: "readCanonicalOpenCodeAgentRuntimeDescriptorV1" },',
  ]);
  writeCodexUiDescriptorFixture(repoRoot);
  writeOpenCodeUiDescriptorFixture(repoRoot);
  writePiContributionPluginFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const sessionControlAdaptersOut = readGeneratedSessionControlAdaptersOutput(repoRoot);
  assert.match(sessionControlAdaptersOut, /GENERATED FILE CONTRACT \(A\.16y\.3-provider-session-control-and-runtime-descriptor-projections\)/);
  assert.doesNotMatch(sessionControlAdaptersOut, /E\.10-pi-runtime-contribution-seam/);
  assert.match(sessionControlAdaptersOut, /GENERATED_PROVIDER_SESSION_CONTROL_ADAPTERS/);
  assert.match(sessionControlAdaptersOut, /createGeneratedRuntimeProjectionSessionControlAdapter/);
  assert.doesNotMatch(sessionControlAdaptersOut, /@happier-dev\/plugins-/);
  assert.doesNotMatch(sessionControlAdaptersOut, /\.\.\/providers\/(?:codex|opencode)\//);
  assert.match(sessionControlAdaptersOut, /CODEX_GENERATED_SESSION_CONTROL_ADAPTER/);
  assert.match(sessionControlAdaptersOut, /OPENCODE_GENERATED_SESSION_CONTROL_ADAPTER/);
  assert.match(sessionControlAdaptersOut, /codex: CODEX_GENERATED_SESSION_CONTROL_ADAPTER,/);
  assert.match(sessionControlAdaptersOut, /opencode: OPENCODE_GENERATED_SESSION_CONTROL_ADAPTER,/);
  assert.match(sessionControlAdaptersOut, /providerId:\s*'pi'/);
  assert.match(sessionControlAdaptersOut, /absolutePathField:\s*'sessionFile'/);
  assert.doesNotMatch(sessionControlAdaptersOut, /PI_SESSION_CONTROL_ADAPTER/);

  const runtimeDescriptorReadersOut = readGeneratedRuntimeDescriptorReadersOutput(repoRoot);
  assert.match(runtimeDescriptorReadersOut, /GENERATED FILE CONTRACT \(A\.16y\.3-provider-session-control-and-runtime-descriptor-projections\)/);
  assert.doesNotMatch(runtimeDescriptorReadersOut, /E\.10-pi-runtime-contribution-seam/);
  assert.match(runtimeDescriptorReadersOut, /GENERATED_RUNTIME_DESCRIPTOR_READERS/);
  assert.match(runtimeDescriptorReadersOut, /createGeneratedRuntimeDescriptorReader/);
  assert.doesNotMatch(runtimeDescriptorReadersOut, /@happier-dev\/plugins-/);
  assert.doesNotMatch(runtimeDescriptorReadersOut, /\.\.\/providers\/(?:codex|opencode)\//);
  assert.match(runtimeDescriptorReadersOut, /CODEX_GENERATED_RUNTIME_DESCRIPTOR_READER/);
  assert.match(runtimeDescriptorReadersOut, /OPENCODE_GENERATED_RUNTIME_DESCRIPTOR_READER/);
  assert.match(runtimeDescriptorReadersOut, /codex: CODEX_GENERATED_RUNTIME_DESCRIPTOR_READER,/);
  assert.match(runtimeDescriptorReadersOut, /opencode: OPENCODE_GENERATED_RUNTIME_DESCRIPTOR_READER,/);
  assert.match(runtimeDescriptorReadersOut, /providerId:\s*'pi'/);
  assert.match(runtimeDescriptorReadersOut, /runtimeHandle:\s*'providerSessionId'/);
  assert.doesNotMatch(runtimeDescriptorReadersOut, /readPiSessionMetadataRuntimeDescriptor/);

  const protocolRuntimeDescriptorContributionsOut = readGeneratedProtocolRuntimeDescriptorContributionsOutput(repoRoot);
  assert.match(protocolRuntimeDescriptorContributionsOut, /GENERATED FILE CONTRACT \(A\.16y\.3-provider-session-control-and-runtime-descriptor-projections\)/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /GENERATED FILE CONTRACT \(A\.16y\.6-runtime-descriptor-protocol-abi-codegen\)/);
  assert.doesNotMatch(protocolRuntimeDescriptorContributionsOut, /E\.10-pi-runtime-contribution-seam/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /import \{[\s\S]*buildCodexAgentRuntimeDescriptorV1[\s\S]*\} from '\.\/descriptors\/codex\.js';/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /import \{[\s\S]*buildOpenCodeAgentRuntimeDescriptorV1[\s\S]*\} from '\.\/descriptors\/opencode\.js';/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /import \{[\s\S]*buildPiAgentRuntimeDescriptorV1[\s\S]*\} from '\.\/descriptors\/pi\.js';/);
  assert.doesNotMatch(protocolRuntimeDescriptorContributionsOut, /\.\/(?:codex|opencode|pi)\/runtimeDescriptorV1\.js/);
  assert.doesNotMatch(protocolRuntimeDescriptorContributionsOut, /@happier-dev\/plugins-/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /agentId:\s*'pi'/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /readCanonicalPiAgentRuntimeDescriptorV1/);
  assert.doesNotMatch(protocolRuntimeDescriptorContributionsOut, /hardcoded Codex/);

  const codexRuntimeDescriptorOut = readGeneratedProtocolRuntimeDescriptorModuleOutput(repoRoot, 'codex');
  assert.match(codexRuntimeDescriptorOut, /buildCodexAgentRuntimeDescriptorV1/);
  assert.match(codexRuntimeDescriptorOut, /readCanonicalCodexAgentRuntimeDescriptorV1/);
  assert.doesNotMatch(codexRuntimeDescriptorOut, /@happier-dev\/plugins-/);

  const openCodeRuntimeDescriptorOut = readGeneratedProtocolRuntimeDescriptorModuleOutput(repoRoot, 'opencode');
  assert.match(openCodeRuntimeDescriptorOut, /buildOpenCodeAgentRuntimeDescriptorV1/);
  assert.match(openCodeRuntimeDescriptorOut, /readCanonicalOpenCodeAgentRuntimeDescriptorV1/);
  assert.doesNotMatch(openCodeRuntimeDescriptorOut, /@happier-dev\/plugins-/);

  const piRuntimeDescriptorOut = readGeneratedProtocolRuntimeDescriptorModuleOutput(repoRoot, 'pi');
  assert.match(piRuntimeDescriptorOut, /buildPiAgentRuntimeDescriptorV1/);
  assert.match(piRuntimeDescriptorOut, /readCanonicalPiAgentRuntimeDescriptorV1/);
  assert.doesNotMatch(piRuntimeDescriptorOut, /@happier-dev\/plugins-/);

  const promptAssetPluginDescriptorsOut = readGeneratedPromptAssetPluginDescriptorsOutput(repoRoot);
  assert.match(promptAssetPluginDescriptorsOut, /BUNDLED_FIRST_PARTY_PLUGIN_PROMPT_ASSET_DESCRIPTORS/);
  assert.doesNotMatch(promptAssetPluginDescriptorsOut, /@happier-dev\/plugins-claude\/agent';/);
  assert.doesNotMatch(promptAssetPluginDescriptorsOut, /@happier-dev\/plugins-copilot';/);
  assert.doesNotMatch(promptAssetPluginDescriptorsOut, /@\/backends\/gemini\/promptAssets/);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']);

  const codexRuntimeDescriptorOutPath = resolve(repoRoot, 'packages/protocol/src/agents/generated/runtime/descriptors/codex.ts');
  writeFileSync(codexRuntimeDescriptorOutPath, 'export const stale = true;\n', 'utf8');
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generated\/runtime\/descriptors\/codex\.ts/,
  );
});

test('generateBundledPluginEntries emits protocol provider defaults and external-session sources', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-protocol-provider-defaults-'));
  writeRuntimeContributionPluginFixture(repoRoot, 'claude', 'claude', [
    'protocolBuiltInBackendProfiles: { kind: "providerBuiltInBackendProfilesV1", providerId: "claude", source: "./protocol/profiles", exportName: "CLAUDE_BUILT_IN_BACKEND_PROFILES" },',
    'protocolMemoryDefaults: { kind: "providerMemoryDefaultsV1", providerId: "claude", source: "./protocol/memory", exportName: "CLAUDE_MEMORY_DEFAULTS" },',
  ]);
  writeRuntimeContributionPluginFixture(repoRoot, 'codex', 'codex', [
    'protocolBuiltInBackendProfiles: { kind: "providerBuiltInBackendProfilesV1", providerId: "codex", source: "./protocol/profiles", exportName: "CODEX_BUILT_IN_BACKEND_PROFILES" },',
  ]);
  writeRuntimeContributionPluginFixture(repoRoot, 'ohmypi', 'ohMyPi', []);
  writeManifestOwnedExternalSessionSourceFixture(repoRoot, 'claude', 'claude', [
    '{',
    '  sourceKind: "claudeConfig",',
    '  schema: {',
    '    passthrough: true,',
    '    fields: [',
    '      { name: "kind", kind: "literal", value: "claudeConfig" },',
    '      { name: "configDir", kind: "string", min: 1, max: 10000, nullish: true },',
    '      { name: "projectId", kind: "string", min: 1, max: 2000, nullish: true },',
    '    ],',
    '  },',
    '  key: {',
    '    segments: [',
    '      { kind: "literal", value: "claudeConfig" },',
    '      { kind: "field", field: "configDir" },',
    '      { kind: "field", field: "projectId" },',
    '    ],',
    '  },',
    '}',
  ].join('\n'));
  writeManifestOwnedExternalSessionSourceFixture(repoRoot, 'codex', 'codex', [
    '{',
    '  sourceKind: "codexHome",',
    '  schema: {',
    '    passthrough: true,',
    '    fields: [',
    '      { name: "kind", kind: "literal", value: "codexHome" },',
    '      { name: "home", kind: "enum", values: ["user", "connectedService"] },',
    '      { name: "homePath", kind: "string", min: 1, optional: true },',
    '      { name: "connectedServiceId", kind: "string", min: 1, optional: true },',
    '      { name: "connectedServiceProfileId", kind: "string", min: 1, optional: true },',
    '      { name: "connectedServiceGroupId", kind: "string", min: 1, optional: true },',
    '    ],',
    '    refinements: [',
    '      { kind: "requiresWhenEquals", field: "connectedServiceId", when: { field: "home", equals: "connectedService" } },',
    '      { kind: "forbidsWhenEquals", fields: ["connectedServiceId", "connectedServiceProfileId", "connectedServiceGroupId"], when: { field: "home", equals: "user" } },',
    '    ],',
    '  },',
    '  key: {',
    '    segments: [',
    '      { kind: "literal", value: "codexHome" },',
    '      { kind: "homeMode", field: "home" },',
    '      { kind: "conditionalField", field: "connectedServiceId", when: { field: "home", equals: "connectedService" } },',
    '      { kind: "connectedServiceScope", groupField: "connectedServiceGroupId", profileField: "connectedServiceProfileId", when: { field: "home", equals: "connectedService" } },',
    '      { kind: "field", field: "homePath" },',
    '    ],',
    '  },',
    '}',
  ].join('\n'));
  writeManifestOwnedExternalSessionSourceFixture(repoRoot, 'ohmypi', 'ohmypi', [
    '{',
    '  sourceKind: "ohMyPiAgentDir",',
    '  schema: { fields: [{ name: "kind", kind: "literal", value: "ohMyPiAgentDir" }] },',
    '  key: { segments: [{ kind: "literal", value: "ohMyPiAgentDir" }] },',
    '}',
  ].join('\n'));
  writeProtocolProjectionFixture(repoRoot, 'claude', 'profiles', [
    'export const CLAUDE_BUILT_IN_BACKEND_PROFILES = Object.freeze([',
    '  {',
    '    id: "anthropic",',
    '    name: "Anthropic (Default)",',
    '    authMode: "machineLogin",',
    '    requiresMachineLoginTargetKey: "agent:claude",',
    '    environmentVariables: [],',
    '    envVarRequirements: [],',
    '    defaultPermissionModeByTargetKey: { "agent:claude": "default" },',
    '    defaultPermissionModeByAgent: {},',
    '    defaultPersistenceModeByTargetKey: {},',
    '    defaultPersistenceModeByAgent: {},',
    '    compatibilityByTargetKey: { "agent:claude": true, "agent:codex": false },',
    '    compatibility: {},',
    '    isBuiltIn: true,',
    '    defaultEnabled: true,',
    '    createdAt: 0,',
    '    updatedAt: 0,',
    '    version: "1.0.0",',
    '  },',
    ']);',
  ]);
  writeProtocolProjectionFixture(repoRoot, 'claude', 'memory', [
    'export const CLAUDE_MEMORY_DEFAULTS = Object.freeze({',
    '  summarizerBackendId: "claude",',
    '});',
  ]);
  writeProtocolProjectionFixture(repoRoot, 'codex', 'profiles', [
    'export const CODEX_BUILT_IN_BACKEND_PROFILES = Object.freeze([',
    '  {',
    '    id: "codex",',
    '    name: "Codex (Default)",',
    '    authMode: "machineLogin",',
    '    requiresMachineLoginTargetKey: "agent:codex",',
    '    environmentVariables: [],',
    '    envVarRequirements: [],',
    '    defaultPermissionModeByTargetKey: { "agent:codex": "default" },',
    '    defaultPermissionModeByAgent: {},',
    '    defaultPersistenceModeByTargetKey: {},',
    '    defaultPersistenceModeByAgent: {},',
    '    compatibilityByTargetKey: { "agent:claude": false, "agent:codex": true },',
    '    compatibility: {},',
    '    isBuiltIn: true,',
    '    defaultEnabled: true,',
    '    createdAt: 0,',
    '    updatedAt: 0,',
    '    version: "1.0.0",',
    '  },',
    ']);',
  ]);
  writeCodexUiDescriptorFixture(repoRoot);
  writeClaudeUiDescriptorFixture(repoRoot);
  writeOhMyPiUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const profilesOut = readGeneratedProtocolBuiltInBackendProfilesOutput(repoRoot);
  assert.match(profilesOut, /GENERATED FILE CONTRACT \(A\.16y\.7-protocol-provider-default-and-source-projection\)/);
  assert.match(profilesOut, /GENERATED_BUILT_IN_BACKEND_PROFILES/);
  assert.match(profilesOut, /"id":\s*"anthropic"/);
  assert.match(profilesOut, /"id":\s*"codex"/);
  assert.doesNotMatch(profilesOut, /@happier-dev\/plugins-/);
  assert.doesNotMatch(profilesOut, /providers\/(?:claude|codex)\/builtInBackendProfiles/);

  const memoryOut = readGeneratedProtocolMemoryDefaultsOutput(repoRoot);
  assert.match(memoryOut, /GENERATED_MEMORY_SUMMARIZER_BACKEND_ID = 'claude'/);
  assert.doesNotMatch(memoryOut, /@happier-dev\/plugins-/);
  assert.doesNotMatch(memoryOut, /providers\/claude\/memoryDefaults/);

  const externalSessionOut = readGeneratedProtocolExternalSessionSourcesOutput(repoRoot);
  assert.match(externalSessionOut, /GENERATED_EXTERNAL_SESSIONS_SOURCE_DECLARATIONS/);
  assert.match(externalSessionOut, /"sourceKind":\s*"claudeConfig"/);
  assert.match(externalSessionOut, /"sourceKind":\s*"codexHome"/);
  assert.match(externalSessionOut, /"agentId":\s*"ohMyPi"/);
  assert.doesNotMatch(externalSessionOut, /"agentId":\s*"ohmypi"/);
  assert.doesNotMatch(externalSessionOut, /from 'zod'/);
  assert.doesNotMatch(externalSessionOut, /function resolve/);
  assert.doesNotMatch(externalSessionOut, /sourceSchema:/);
  assert.doesNotMatch(externalSessionOut, /@happier-dev\/plugins-/);
  assert.doesNotMatch(externalSessionOut, /providers\/(?:claude|codex)\/externalSessions/);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']);

  const externalSessionOutPath = resolve(repoRoot, 'packages/protocol/src/agents/generated/externalSession/sources.ts');
  writeFileSync(externalSessionOutPath, 'export const stale = true;\n', 'utf8');
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generated\/externalSession\/sources\.ts/,
  );
});

test('generateBundledPluginEntries requires first-party protocol runtime descriptor sources', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-require-protocol-runtime-source-'));
  writeRuntimeContributionPluginFixture(repoRoot, 'codex', 'codex', [
    'protocolRuntimeDescriptor: { kind: "providerRuntimeDescriptorV1", providerId: "codex", buildFunction: "buildCodexAgentRuntimeDescriptorV1", canonicalReader: "readCanonicalCodexAgentRuntimeDescriptorV1" },',
  ]);
  writeCodexUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /protocolRuntimeDescriptor\.source/,
  );
});

test('generateBundledPluginEntries rejects external-session sources declared outside agent manifest surfaces', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-reject-runtime-external-source-'));
  writeRuntimeContributionPluginFixture(repoRoot, 'codex', 'codex', [
    'protocolExternalSessionSource: { kind: "providerExternalSessionSourceV1", providerId: "codex", source: "./protocol/externalSession", exportName: "CODEX_EXTERNAL_SESSION_SOURCE" },',
  ]);
  writeProtocolProjectionFixture(repoRoot, 'codex', 'externalSession', [
    'export const CODEX_EXTERNAL_SESSION_SOURCE = Object.freeze({',
    '  agentId: "codex",',
    '  sourceKind: "codexHome",',
    '  schema: { fields: [{ name: "kind", kind: "literal", value: "codexHome" }] },',
    '  key: { segments: [{ kind: "literal", value: "codexHome" }] },',
    '});',
  ]);
  writeCodexUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /protocolExternalSessionSource.*manifest\.contributes\.agents\[\]\.surfaces\.externalSession\.sources\[\]/s,
  );
});

test('generateBundledPluginEntries rejects non-hermetic protocol runtime descriptor imports', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-reject-protocol-runtime-imports-'));
  writeRuntimeContributionPluginFixture(repoRoot, 'codex', 'codex', [
    'protocolRuntimeDescriptor: { kind: "providerRuntimeDescriptorV1", providerId: "codex", source: "./protocol/runtimeDescriptorV1", buildFunction: "buildCodexAgentRuntimeDescriptorV1", canonicalReader: "readCanonicalCodexAgentRuntimeDescriptorV1" },',
  ]);
  writeCodexUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  const descriptorPath = resolve(repoRoot, 'packages/plugins/codex/src/protocol/runtimeDescriptorV1.ts');
  const descriptorBody = [
    'export type CodexAgentRuntimeDescriptorV1 = Readonly<{ agentId: "codex" }>;',
    'export type CanonicalCodexAgentRuntimeDescriptorV1 = Readonly<{ agentId: "codex" }>;',
    'export function buildCodexAgentRuntimeDescriptorV1(): CodexAgentRuntimeDescriptorV1 { return { agentId: "codex" }; }',
    'export function readCanonicalCodexAgentRuntimeDescriptorV1(): CanonicalCodexAgentRuntimeDescriptorV1 { return { agentId: "codex" }; }',
    '',
  ].join('\n');

  writeFileSync(descriptorPath, `import './shared.js';\n${descriptorBody}`, 'utf8');
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /generated protocol modules cannot preserve relative imports/,
  );

  writeFileSync(
    descriptorPath,
    `const pluginDescriptorImport = import('@happier-dev/plugins-codex/protocol/runtimeDescriptorV1');\n${descriptorBody}`,
    'utf8',
  );
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /generated protocol module would import forbidden @happier-dev\/plugins-codex\/protocol\/runtimeDescriptorV1/,
  );
});

test('generateBundledPluginEntries rejects first-party providerCliRuntime source contracts', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-reject-provider-cli-runtime-'));
  writeAgentPluginFixture(repoRoot, 'codex');
  writeCodexUiDescriptorFixture(repoRoot);
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "codex",',
      '  providerCliRuntime: {',
      '    id: "codex",',
      '    title: "codex CLI",',
      '    binaryName: "codex",',
      '    sourcePreferenceDefault: "system-first",',
      '    managedInstall: null,',
      '    manualInstallKind: "none",',
      '    manualInstallRecipes: null,',
      '    acceptsJavaScriptFileOverride: false,',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeClaudeUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /AGENT_DEFINITION\.providerCliRuntime.*contributes\.agents\[\]\.cli/i,
  );
});

test('generateBundledPluginEntries derives bundled CLI runtime facts from native Agent metadata', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-native-agent-cli-metadata-'));
  writeAgentPluginFixture(repoRoot, 'nativefixture');
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/nativefixture/src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.agent.nativefixture',
      capabilities: ['agents'],
      contributes: `{
        agents: [{
          id: "nativefixture",
          title: { key: "agent.nativefixture.title", fallback: "Native Fixture" },
          runtime: { kind: "custom" },
          cli: {
            displayName: "Native Fixture CLI",
            executable: {
              binaryName: "nativefixture",
              alternativeBinaryNames: ["nativefixture-cli"],
              alternativeBinaryFallbackEnabledEnvVar: "NATIVEFIXTURE_CLI_FALLBACK",
              knownUserBinDirSuffixes: [".nativefixture/bin"],
              sourcePreference: "system-first",
            },
            install: {
              managed: null,
              manual: { kind: "vendor_recipe", recipes: { linux: [{ cmd: "sh", args: ["install-nativefixture"] }] } },
              recommendationOrder: 7,
              guideUrl: "https://example.test/nativefixture/install",
              docsUrl: "https://example.test/nativefixture/docs",
            },
            auth: {
              support: "login_terminal",
              machineLoginKey: "nativefixture-account",
              probe: { parser: "unknown", backgroundChecks: "safe", statusArgs: null },
              loginLaunches: [
                { kind: "primary", args: ["login"] },
                { kind: "device_code", args: ["login", "--device"] },
              ],
            },
          },
          primary: "sessions",
          capabilities: { sessions: { open: ["create"], delivery: ["newTurn"], cancel: true } },
        }],
      }`,
    }),
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/nativefixture/src/agent/definition.ts'),
    'export const AGENT_DEFINITION = Object.freeze({ id: "nativefixture" });\n',
    'utf8',
  );
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const agentsOut = readFileSync(resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'), 'utf8');
  assert.match(agentsOut, /"cli":\s*\{/);
  assert.match(agentsOut, /"displayName":\s*"Native Fixture CLI"/);
  assert.match(agentsOut, /"binaryName":\s*"nativefixture"/);
  assert.match(agentsOut, /"alternativeBinaryNames":\s*\[\s*"nativefixture-cli"\s*\]/);
  assert.match(agentsOut, /"alternativeBinaryFallbackEnabledEnvVar":\s*"NATIVEFIXTURE_CLI_FALLBACK"/);
  assert.match(agentsOut, /"manual":\s*\{\s*"kind":\s*"vendor_recipe"/);
  assert.match(agentsOut, /"recommendationOrder":\s*7/);
  assert.match(agentsOut, /"guideUrl":\s*"https:\/\/example\.test\/nativefixture\/install"/);
  assert.match(agentsOut, /"machineLoginKey":\s*"nativefixture-account"/);
  assert.match(agentsOut, /"loginLaunches":\s*\[[\s\S]*"kind":\s*"primary"[\s\S]*"kind":\s*"device_code"/);
  assert.doesNotMatch(agentsOut, /"(?:agentCliRuntime|authProbeConfig|localCli|providerCliRuntime)":/);
});

test('generateBundledPluginEntries rejects legacy CLI/auth source authority beside native metadata', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-native-agent-cli-split-brain-'));
  writeAgentPluginFixture(repoRoot, 'nativefixture');
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/nativefixture/src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.agent.nativefixture',
      capabilities: ['agents'],
      contributes: `{
        agents: [{
          id: "nativefixture",
          title: "Native Fixture",
          runtime: { kind: "custom" },
          cli: {
            executable: { binaryName: "nativefixture", sourcePreference: "system-first" },
            install: { managed: null, manual: { kind: "none" } },
            auth: {
              support: "unsupported",
              probe: { parser: "none", backgroundChecks: "manual_only", statusArgs: null },
              loginLaunches: [],
            },
          },
          primary: "sessions",
          capabilities: { sessions: { open: ["create"], delivery: ["newTurn"], cancel: true } },
        }],
      }`,
    }),
    'utf8',
  );
  writeGeneratorOutputScaffold(repoRoot);
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/nativefixture/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "nativefixture",',
      '  agentCliRuntime: { id: "nativefixture" },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /AGENT_DEFINITION\.agentCliRuntime.*contributes\.agents\[\]\.cli/i,
  );
});

test('generateBundledPluginEntries emits manifest-declared plugin UI translations as a closed key set', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-plugin-ui-translations-'));
  writeAgentPluginFixture(repoRoot, 'cursor');
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/cursor/src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.agent.cursor',
      capabilities: ['agents'],
      contributes: `{
        agents: [{
          id: "cursor",
          title: { key: "plugin.fixture.name", fallback: "Fixture Agent" },
          description: { key: "plugin.fixture.subtitle", fallback: "Fixture subtitle" },
          runtime: { kind: "custom" },
          cli: {
            displayName: "Cursor CLI",
            executable: { binaryName: "cursor", sourcePreference: "system-first" },
            install: { managed: null, manual: { kind: "none" } },
            auth: {
              support: "unsupported",
              probe: { parser: "none", backgroundChecks: "manual_only", statusArgs: null },
              loginLaunches: [],
            },
          },
          primary: "sessions",
          capabilities: { sessions: { open: ["create"], delivery: ["newTurn"], cancel: true } },
        }],
        ui: { translations: [{
          locale: "en",
          messages: {
            "plugin.fixture.name": "Fixture Agent",
            "plugin.fixture.subtitle": "Fixture subtitle",
            "plugin.fixture.resumeId": "Fixture session ID",
            "plugin.fixture.resumeCopied": "Fixture session ID copied",
          },
        }] },
      }`,
    }),
    'utf8',
  );
  writeCursorUiDescriptorFixture(repoRoot);
  const descriptorPath = resolve(repoRoot, 'packages/plugins/cursor/src/ui/descriptor.ts');
  writeFileSync(
    descriptorPath,
    readFileSync(descriptorPath, 'utf8')
      .replaceAll('test.cursor.descriptorName', 'plugin.fixture.name')
      .replaceAll('test.cursor.descriptorSubtitle', 'plugin.fixture.subtitle')
      .replaceAll('test.cursor.resumeId', 'plugin.fixture.resumeId')
      .replaceAll('test.cursor.resumeCopied', 'plugin.fixture.resumeCopied'),
    'utf8',
  );
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const translationsOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/text/bundledPluginTranslations.generated.ts'),
    'utf8',
  );
  assert.match(translationsOut, /export type BundledPluginTranslationKey/);
  assert.match(translationsOut, /"plugin\.fixture\.name": "Fixture Agent"/);
  assert.match(translationsOut, /"plugin\.fixture\.resumeCopied": "Fixture session ID copied"/);
  assert.doesNotMatch(translationsOut, /plugin\.fixture\.undeclared/);
});

test('generateBundledPluginEntries emits narrow plugin prompt asset adapter descriptors and checks drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-prompt-assets-check-'));
  writeAgentPluginFixture(repoRoot, 'claude');
  writeClaudeUiDescriptorFixture(repoRoot);
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src/agent/promptAssets'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/agent/promptAssets/index.ts'),
    [
      'export const PLUGIN_PROMPT_ASSET_DESCRIPTORS = Object.freeze([',
      '  {',
      '    adapterKind: "skillMd",',
      '    assetTypeId: "claude.skill",',
      '    providerId: "claude",',
      '    title: "Claude skills",',
      '    description: "Claude skill bundles.",',
      '    projectRootPath: [".claude", "skills"],',
      '    projectRootDisplayPath: ".claude/skills",',
      '    userRootPath: [".claude", "skills"],',
      '    userRootDisplayPath: "~/.claude/skills",',
      '  },',
      ']);',
      '',
    ].join('\n'),
    'utf8',
  );
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const promptAssetDescriptorsOut = readGeneratedPromptAssetPluginDescriptorsOutput(repoRoot);
  assert.match(promptAssetDescriptorsOut, /BUNDLED_FIRST_PARTY_PLUGIN_PROMPT_ASSET_DESCRIPTORS/);
  assert.match(promptAssetDescriptorsOut, /PluginPromptAssetAdapterDescriptor/);
  assert.match(
    promptAssetDescriptorsOut,
    /from '@happier-dev\/plugins-claude\/agent\/promptAssets';/,
  );
  assert.doesNotMatch(promptAssetDescriptorsOut, /@happier-dev\/plugins-claude\/agent';/);

  const promptAssetDescriptorsOutPath = resolve(repoRoot, 'apps/cli/src/prompts/assets/generated/pluginDescriptors.ts');
  writeFileSync(promptAssetDescriptorsOutPath, 'export const BUNDLED_FIRST_PARTY_PLUGIN_PROMPT_ASSET_DESCRIPTORS = Object.freeze([]);\n', 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*pluginDescriptors\.ts/,
  );
});

test('generateBundledPluginEntries check mode rejects UI generated entry drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-ui-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const uiOutPath = resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts');
  writeFileSync(uiOutPath, `${readFileSync(uiOutPath, 'utf8')}// drift\n`, 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generatedBundledPluginEntries\.ts/,
  );
});

test('generateBundledPluginEntries check mode rejects UI behavior override drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-ui-overrides-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const uiOverridesOutPath = resolve(
    repoRoot,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts',
  );
  writeFileSync(uiOverridesOutPath, `${readFileSync(uiOverridesOutPath, 'utf8')}// drift\n`, 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generatedBundledPluginEntries\.uiBehaviorOverrides\.ts/,
  );
});

test('generateBundledPluginEntries check mode rejects session provider behavior drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-session-provider-behaviors-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const sessionAgentBehaviorsOutPath = resolve(
    repoRoot,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.sessionAgentBehaviors.ts',
  );
  writeFileSync(sessionAgentBehaviorsOutPath, `${readFileSync(sessionAgentBehaviorsOutPath, 'utf8')}// drift\n`, 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generatedBundledPluginEntries\.sessionAgentBehaviors\.ts/,
  );
});

test('generateBundledPluginEntries check mode rejects a retired Agent-settings generated registry', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-agent-settings-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const agentSettingsOutPath = resolve(
    repoRoot,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.agentSettings.ts',
  );
  writeFileSync(agentSettingsOutPath, 'export const staleAgentSettingsRegistry = true;\n', 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /retired generated output still exists: .*generatedBundledPluginEntries\.agentSettings\.ts/,
  );
});

test('generateBundledPluginEntries removes separate Agent-settings outputs instead of deriving from Agent UI descriptors', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-agent-settings-sdk-generate-'));
  writeAgentPluginFixture(repoRoot, 'opencode');
  writeOpenCodeUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);
  const hostAgentSettingsOutPath = resolve(
    repoRoot,
    'packages/agents/src/agentSettings/generated/bundledAgentSettings.ts',
  );
  mkdirSync(resolve(hostAgentSettingsOutPath, '..'), { recursive: true });
  writeFileSync(hostAgentSettingsOutPath, 'export const staleHostAgentSettingsRegistry = true;\n', 'utf8');

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  assert.equal(
    existsSync(resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.agentSettings.ts')),
    false,
    'the UI must consume daemon-projected settings instead of a generated Agent-settings registry',
  );
  assert.equal(
    existsSync(hostAgentSettingsOutPath),
    false,
    'the host must consume the canonical settings contribution projection instead of a generated Agent-settings registry',
  );

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  const opencodeBlock = readGeneratedAgentBlock(agentsOut, 'opencode');
  assert.doesNotMatch(opencodeBlock, /"agentSettings":/);
  assert.doesNotMatch(opencodeBlock, /"providerSettings":/);
});

test('generateBundledPluginEntries check mode rejects visible message resolver drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-visible-messages-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const visibleResolversOutPath = resolve(
    repoRoot,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers.ts',
  );
  writeFileSync(visibleResolversOutPath, `${readFileSync(visibleResolversOutPath, 'utf8')}// drift\n`, 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generatedBundledPluginEntries\.visibleMessageResolvers\.ts/,
  );
});

test('generateBundledPluginEntries renders Cursor UI projection from the plugin descriptor', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-ui-descriptor-'));
  writeAgentPluginFixture(repoRoot, 'cursor');
  writeCursorUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const uiOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );

  assert.match(uiOut, /displayNameKey:\s*'test\.cursor\.descriptorName'/);
  assert.match(uiOut, /subtitleKey:\s*'test\.cursor\.descriptorSubtitle'/);
  assert.match(uiOut, /uiConnectedService:\s*\{ serviceId: null, labelKey: 'test\.cursor\.descriptorName', connectRoute: null \}/);
  assert.match(uiOut, /flavorAliases:\s*\['descriptor-cursor'\]/);
  assert.match(uiOut, /hideUnknownToolsByDefault:\s*false/);
  assert.match(uiOut, /agentPickerIconName:\s*'descriptor-icon'/);
  assert.match(uiOut, /pickerIconScale:\s*0\.7/);
  assert.match(uiOut, /cliGlyph:\s*'C•'/);
});

test('generateBundledPluginEntries rejects a connected-service label key that bypasses the descriptor name key', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-ui-label-key-owner-'));
  writeAgentPluginFixture(repoRoot, 'cursor');
  writeCursorUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  const descriptorPath = resolve(repoRoot, 'packages/plugins/cursor/src/ui/descriptor.ts');
  writeFileSync(
    descriptorPath,
    readFileSync(descriptorPath, 'utf8').replace(
      '"labelKey": "test.cursor.descriptorName"',
      '"labelKey": "plugin.fixture.undeclared"',
    ),
    'utf8',
  );

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /connectedService\.labelKey.*display\.nameKey/,
  );
});

test('generateBundledPluginEntries accepts a connected-service label key owned by the same plugin English translations', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-ui-label-key-translation-'));
  writeAgentPluginFixture(repoRoot, 'cursor');
  writeCursorUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  const descriptorPath = resolve(repoRoot, 'packages/plugins/cursor/src/ui/descriptor.ts');
  writeFileSync(
    descriptorPath,
    readFileSync(descriptorPath, 'utf8').replace(
      '"labelKey": "test.cursor.descriptorName"',
      '"labelKey": "plugin.fixture.connectedServiceLabel"',
    ),
    'utf8',
  );
  const manifestPath = resolve(repoRoot, 'packages/plugins/cursor/src/manifest.ts');
  writeFileSync(
    manifestPath,
    readFileSync(manifestPath, 'utf8').replace(
      '\n},\n});',
      '\n  ui: { translations: [{ locale: "en", messages: { "plugin.fixture.connectedServiceLabel": "Cursor Service" } }] },\n},\n});',
    ),
    'utf8',
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const uiOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );
  const translationsOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/text/bundledPluginTranslations.generated.ts'),
    'utf8',
  );
  assert.match(uiOut, /labelKey: 'plugin\.fixture\.connectedServiceLabel'/);
  assert.match(translationsOut, /"plugin\.fixture\.connectedServiceLabel": "Cursor Service"/);
});

test('generateBundledPluginEntries bounds descriptor-owned CLI glyphs', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-ui-cli-glyph-bound-'));
  writeAgentPluginFixture(repoRoot, 'cursor');
  writeCursorUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  const descriptorPath = resolve(repoRoot, 'packages/plugins/cursor/src/ui/descriptor.ts');
  writeFileSync(
    descriptorPath,
    readFileSync(descriptorPath, 'utf8').replace('"cliGlyph": "C•"', '"cliGlyph": "123456789"'),
    'utf8',
  );

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /cliGlyph.*1 to 8 Unicode code points/,
  );
});

test('generateBundledPluginEntries prefers extracted plugin UI descriptors over legacy provider imports', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-ui-descriptor-legacy-'));
  writeAgentPluginFixture(repoRoot, 'claude');
  writeClaudeUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const uiOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );

  assert.doesNotMatch(uiOut, /@\/agents\/providers\/claude\/core/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/claude\/ui/);
  assert.match(uiOut, /const CLAUDE_CORE: AgentCoreConfig/);
  assert.match(
    uiOut,
    /uiConnectedService:\s*\{ serviceId: 'anthropic', labelKey: 'agentInput\.agent\.claude', connectRoute: '\/\(app\)\/settings\/connect\/claude' \}/,
  );
  assert.match(uiOut, /staticOptions:\s*\[/);
  assert.match(uiOut, /id:\s*'plan'/);
  assert.match(uiOut, /descriptionKey:\s*'agentInput\.mode\.planDescription'/);
  assert.match(uiOut, /claude:\s*CLAUDE_CORE/);
  assert.match(uiOut, /claude:\s*CLAUDE_UI/);
});

test('generateBundledPluginEntries rejects missing OpenCode plugin UI descriptor instead of falling back to legacy provider imports', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-opencode-ui-no-legacy-'));
  writeAgentPluginFixture(repoRoot, 'opencode');
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Missing UI core projection source for opencode/,
  );
});

test('generateBundledPluginEntries rejects missing Pi plugin UI descriptor instead of falling back to legacy provider imports', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-pi-ui-no-legacy-'));
  writeAgentPluginFixture(repoRoot, 'pi');
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Missing UI core projection source for pi/,
  );
});

test('generateBundledPluginEntries rejects executable UI projection import descriptors', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-ui-import-source-reject-'));
  writeAgentPluginFixture(repoRoot, 'opencode');
  mkdirSync(resolve(repoRoot, 'packages/plugins/opencode/src/ui'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/opencode/src/ui/descriptor.ts'),
    [
      'export const OPENCODE_UI_DESCRIPTOR = Object.freeze({',
      '  agentId: "opencode",',
      '  core: {',
      '    displayNameKey: "agentInput.agent.opencode",',
      '    subtitleKey: "profiles.aiBackend.opencodeSubtitle",',
      '    permissionModeI18nPrefix: "agentInput.codexPermissionMode",',
      '    availability: { experimental: false },',
      '    uiConnectedService: { serviceId: null, label: "OpenCode", connectRoute: null },',
      '    flavorAliases: ["opencode"],',
      '    permissions: { modeGroup: "codexLike", promptProtocol: "codexDecision" },',
      '    resume: { uiVendorResumeIdLabelKey: null, uiVendorResumeIdCopiedKey: null },',
      '    toolRendering: { hideUnknownToolsByDefault: false },',
      '    ui: { agentPickerIconName: "code-slash-outline", cliGlyphScale: 1.0, profileCompatibilityGlyphScale: 1.0 },',
      '  },',
      '  ui: {',
      '    svgIconKey: "opencode",',
      '    avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },',
      '    cliGlyph: "</>",',
      '  },',
      '  projection: {',
      '    agentSettings: { importName: "OPENCODE_AGENT_SETTINGS_PLUGIN", source: "./settings" },',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /projection import descriptors are not allowed/i,
  );
});

test('generateBundledPluginEntries keeps OpenCode UI projections on exported/package surfaces', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-opencode-ui-projection-'));
  writeOpenCodeAgentPluginFixture(repoRoot);
  writeOpenCodeUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /import \{ OPENCODE_AGENT_RUNTIME_CONTRIBUTION \} from '@happier-dev\/plugins-opencode\/agent\/contributions\/runtime';/);
  assert.match(cliOut, /import \{ PLUGIN_MANIFEST as OPENCODE_PLUGIN_MANIFEST \} from '@happier-dev\/plugins-opencode';/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_IMPLEMENTATION_BINDINGS/);
  assert.match(cliOut, /contribution:\s*OPENCODE_AGENT_RUNTIME_CONTRIBUTION/);
  assert.doesNotMatch(cliOut, /rootHelpLabel:|rootHelpDescription:|allowTmux:/);
  assert.doesNotMatch(cliOut, /\.\/bundled\/opencode/);

  const uiBehaviorOverridesOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts'),
    'utf8',
  );
  assertNoExecutableUiProjectionImports(uiBehaviorOverridesOut, { allowPluginUiBehaviorImports: true });
  assert.match(uiBehaviorOverridesOut, /BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS/);
  assert.match(uiBehaviorOverridesOut, /opencode\.uiBehavior\.v1/);
  assert.match(uiBehaviorOverridesOut, /HAPPIER_OPENCODE_SERVER_URL/);
  assert.match(uiBehaviorOverridesOut, /opencodeServerBaseUrlByServerIdV1/);

  const uiOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );
  assertNoExecutableUiProjectionImports(uiOut);
  assert.match(uiOut, /import type \{ AgentIconSvgXmlResolver, AgentUiConfig \} from '\.\/registryUi';/);
  assert.match(uiOut, /const OPENCODE_SVG_ICON_XML: AgentIconSvgXmlResolver = \(theme\): string => createGeneratedSvgIconXml\(/);
  assert.match(uiOut, /fill="\$\{theme\.colors\.text\.primary\}"/);
  assert.match(uiOut, /svgIconXml:\s*OPENCODE_SVG_ICON_XML,/);
  assert.doesNotMatch(uiOut, /AGENT_LOGO_SVG_XML\.opencode/);

  assert.equal(
    existsSync(resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.agentSettings.ts')),
    false,
    'OpenCode settings must flow through canonical manifest settings projection',
  );
});

test('generateBundledPluginEntries rejects first-party runtime contribution package root sources', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-runtime-root-source-'));
  writeAgentPluginFixture(repoRoot, 'opencode');
  writeOpenCodeUiDescriptorFixture(repoRoot);
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/opencode/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "opencode",',
      '  runtimeContributions: {',
      '    agentCatalogEntry: { importName: "OPENCODE_AGENT_RUNTIME_CONTRIBUTION", source: "." },',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/opencode/src/index.ts'),
    'export const OPENCODE_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({ agentId: "opencode" });\n',
    'utf8',
  );
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /runtime projection source.*must use a narrow .\/agent\/contributions\/runtime entrypoint/i,
  );
});

test('generateBundledPluginEntries rejects short bundled plugin owner ids', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-short-id-'));

  writeJson(resolve(repoRoot, 'packages/plugins/codex/package.json'), {
    name: '@happier-dev/plugins-codex',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/manifest.ts'),
    pluginManifestSource({ id: 'codex', capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/agent/definition.ts'),
    'export const AGENT_DEFINITION = Object.freeze({ id: \"codex\" });\n',
    'utf8',
  );

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Plugin id must use a lower-case dot-delimited owner namespace/i,
  );
});

test('generateBundledPluginEntries skips reservation-only plugin packages', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-skip-'));

  writeJson(resolve(repoRoot, 'packages/plugins/claude/package.json'), {
    name: '@happier-dev/plugins-claude',
    version: '0.0.0',
  });
  writeJson(resolve(repoRoot, 'packages/plugins/placeholder/package.json'), {
    name: '@happier-dev/plugins-placeholder',
    version: '0.0.0',
    happier: {
      extensionScaffold: {
        shipping: 'reservation_only',
        plannedStage: 'E.99',
      },
    },
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/manifest.ts'),
    pluginManifestSource({ id: 'happier.agent.claude', capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "claude",',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeClaudeUiDescriptorFixture(repoRoot);

  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /@happier-dev\/plugins-claude/);
  assert.doesNotMatch(cliOut, /@happier-dev\/plugins-placeholder/);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.match(agentsOut, /"claude":\s*Object\.freeze\(/);
  assert.doesNotMatch(agentsOut, /placeholder/);

  const agentIdsOut = readGeneratedAgentIdsOutput(repoRoot);
  assert.match(agentIdsOut, /'claude'/);
  assert.doesNotMatch(agentIdsOut, /placeholder/);
});

test('generateBundledPluginEntries projects non-agent plugin packages without agent definitions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-non-agent-'));

  writeJson(resolve(repoRoot, 'packages/plugins/scm-github/package.json'), {
    name: '@happier-dev/plugins-scm-github',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/scm-github/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/scm-github/src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.scm.hosting.github',
      capabilities: ['scmHostingProviders'],
      contributes: '{ scmHostingProviders: [{ id: "github", title: "GitHub", kind: "github", capabilities: ["detect"] }] }',
    }),
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /@happier-dev\/plugins-scm-github/);
  assert.match(cliOut, /"pluginId":\s*"happier\.scm\.hosting\.github"/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS/);
  assert.doesNotMatch(cliOut, /BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS/);
  assert.doesNotMatch(cliOut, /definition:\s*Object\.freeze\(\{/);
  assert.doesNotMatch(cliOut, /"agentId":\s*"scm-github"/);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.doesNotMatch(agentsOut, /scm-github/);

  const agentIdsOut = readGeneratedAgentIdsOutput(repoRoot);
  assert.doesNotMatch(agentIdsOut, /scm-github/);
});

test('generateBundledPluginEntries emits host-private managed Provider facets through implementation bindings', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-managed-provider-overlay-'));
  writeProviderContributionPluginFixture(repoRoot);
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/gateway/src/managed.ts'),
    [
      'export const MANAGED_PROVIDER_IMPLEMENTATION = Object.freeze({',
      '  v: 1,',
      '  providerLocalId: "gateway",',
      '  facet: {',
      '    managedEndpoint: {',
      '      localService: {',
      '        id: "gateway",',
      '        launch: { kind: "packaged-runtime-binary", directorySegments: ["tools", "unpacked"], executableBaseName: "gateway-managed", privateConfigPathFlag: "--config" },',
      '        launchMode: { kind: "assignAndInject", portPolicy: { kind: "allocated" } },',
      '        hostPolicy: { kind: "loopback" },',
      '        name: { strategy: "fixed", name: "Gateway" },',
      '        healthCheck: { kind: "http", path: "/healthz" },',
      '        restart: { kind: "never" },',
      '        cleanup: { staleAfterMs: 60000 },',
      '      },',
      '      protocols: ["openai-chat", "openai-responses"],',
      '    },',
      '    connectedAccounts: [{',
      '      purpose: "upstream",',
      '      service: { pluginId: "happier.connected-account.example", localId: "example" },',
      '      required: true,',
      '    }],',
      '  },',
      '});',
      'export const MANAGED_PROVIDER_RUNTIME_ADAPTER = Object.freeze({',
      '  v: 1,',
      '  catalogSource: Object.freeze({',
      '    kind: "transientModelEndpoint",',
      '    contractVersion: "happier.test.gateway-managed/v1",',
      '    sdkVersion: "v1.2.3",',
      '  }),',
      '  prepare: async () => ({ ok: true }),',
      '  resolveAgentEndpoint: () => "http://127.0.0.1:1234/v1",',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /registrationFamily:\s*'providers'/);
  assert.match(cliOut, /pluginId:\s*"happier\.provider\.gateway"[\s\S]*localId:\s*"gateway"/u);
  assert.match(cliOut, /implementationOwnerId:\s*"happier\.provider\.gateway\/gateway"/);
  assert.match(
    cliOut,
    /import \{ MANAGED_PROVIDER_RUNTIME_ADAPTER as GATEWAY_MANAGED_PROVIDER_RUNTIME_ADAPTER \} from '@happier-dev\/plugins-gateway';/,
  );
  assert.match(cliOut, /runtimeAdapter:\s*GATEWAY_MANAGED_PROVIDER_RUNTIME_ADAPTER/);
  assert.match(cliOut, /"executableBaseName":\s*"gateway-managed"/);
  assert.match(cliOut, /"purpose":\s*"upstream"/);
  assert.doesNotMatch(cliOut, /from ['"]@happier-dev\/plugins-gateway\/managed['"]/);
});

test('generateBundledPluginEntries write mode syncs both CLI plugin shipping declarations before projecting', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-membership-'));

  writeJson(resolve(repoRoot, 'packages/plugins/scm-github/package.json'), {
    name: '@happier-dev/plugins-scm-github',
    version: '0.0.0',
  });
  mkdirSync(resolve(repoRoot, 'packages/plugins/scm-github/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/scm-github/src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.scm.hosting.github',
      capabilities: ['scmHostingProviders'],
      contributes: '{ scmHostingProviders: [{ id: "github", title: "GitHub", kind: "github", capabilities: ["detect"] }] }',
    }),
    'utf8',
  );
  writeJson(resolve(repoRoot, 'apps/cli/package.json'), {
    name: '@happier-dev/cli',
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
    bundledDependencies: ['@happier-dev/protocol'],
  });
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliPackageJson = JSON.parse(readFileSync(resolve(repoRoot, 'apps/cli/package.json'), 'utf8')) as {
    bundledDependencies?: unknown;
    dependencies?: Record<string, string>;
  };
  const bundledDependencies = Array.isArray(cliPackageJson.bundledDependencies)
    ? cliPackageJson.bundledDependencies.map(String)
    : [];
  assert.deepEqual(bundledDependencies, [
    '@happier-dev/protocol',
    '@happier-dev/plugins-scm-github',
  ]);
  assert.equal(cliPackageJson.dependencies?.['@happier-dev/plugins-scm-github'], '0.0.0');

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /@happier-dev\/plugins-scm-github/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS/);
  assert.doesNotMatch(cliOut, /BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS/);
});

test('generateBundledPluginEntries projects review-only agent runtime contributions from agent definitions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-review-agent-runtime-'));

  writeJson(resolve(repoRoot, 'packages/plugins/review-coderabbit/package.json'), {
    name: '@happier-dev/plugins-review-coderabbit',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/review-coderabbit/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/review-coderabbit/src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.review.coderabbit',
      capabilities: ['agents', 'executionRunProfiles'],
      contributes: [
        '{',
        '  agents: [{',
        '    id: "coderabbit",',
        '    title: "CodeRabbit",',
        '    runtime: { kind: "custom" },',
        '    cli: {',
        '      displayName: "CodeRabbit CLI",',
        '      executable: { binaryName: "coderabbit", sourcePreference: "system-first" },',
        '      install: { managed: null, manual: { kind: "none" } },',
        '      auth: {',
        '        support: "status_only",',
        '        probe: { parser: "unknown", backgroundChecks: "safe", statusArgs: null },',
        '        loginLaunches: [],',
        '      },',
        '    },',
        '    primary: "executionRuns",',
        '    capabilities: {',
        '      executionRuns: { open: ["create"], checkpoint: false, stop: true },',
        '    },',
        '  }],',
        '}',
      ].join('\n'),
    }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/review-coderabbit/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/review-coderabbit/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "coderabbit",',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeUiDescriptorFixture(repoRoot, 'review-coderabbit', 'CODERABBIT_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'review-coderabbit',
    agentId: 'coderabbit',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.coderabbit',
      subtitleKey: 'profiles.aiBackend.coderabbitSubtitleExperimental',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: true },
      connectedService: {
        serviceId: null,
        labelKey: 'agentInput.agent.coderabbit',
        connectRoute: null,
      },
      flavorAliases: ['coderabbit'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: { uiVendorResumeIdLabelKey: null, uiVendorResumeIdCopiedKey: null },
      toolRendering: { hideUnknownToolsByDefault: true },
      picker: {
        iconName: 'git-pull-request-outline',
        cliGlyph: 'CR',
        cliGlyphScale: 0.9,
        profileCompatibilityGlyphScale: 0.9,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: null },
    },
    settings: {},
    behavior: {},
    session: {},
    message: {},
    components: { slots: [] },
    assets: {},
  });

  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /@happier-dev\/plugins-review-coderabbit/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS/);
  assert.match(cliOut, /pluginId:\s*"happier\.review\.coderabbit"/);
  assert.doesNotMatch(cliOut, /BUNDLED_FIRST_PARTY_PLUGIN_AGENT_RUNTIME_CONTRIBUTIONS/);
  assert.doesNotMatch(cliOut, /directCommentWrite|BUNDLED_FIRST_PARTY_EXECUTION_RUN_PROFILE_CONTRIBUTIONS|coderabbit\.review/);
  assert.doesNotMatch(cliOut, /"agentId":\s*"review-coderabbit"/);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.match(agentsOut, /coderabbit/);

  const agentIdsOut = readGeneratedAgentIdsOutput(repoRoot);
  assert.match(agentIdsOut, /coderabbit/);
});

test('generateBundledPluginEntries projects native Agent ownership and compatibility aliases deterministically', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-antigravity-generate-owned-backends-'));

  writeAntigravityCanonicalBackendFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const manifestSource = readFileSync(
    resolve(repoRoot, 'packages/plugins/antigravity/src/manifest.ts'),
    'utf8',
  );
  assert.match(manifestSource, /primary:\s*"sessions"/);
  assert.doesNotMatch(manifestSource, /settingsBackendId|ownedBackendIds|enablementCompatibilityBackendIds/);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  const antigravityBlock = readGeneratedAgentBlock(agentsOut, 'antigravity');
  assert.match(antigravityBlock, /"backendDefinition":\s*false/);
  assert.match(
    antigravityBlock,
    /"resume":\s*\{\s*"vendorResume":\s*"supported",\s*"vendorResumeIdField":\s*"antigravitySessionId"\s*\}/,
  );
  assert.match(antigravityBlock, /"settingsBackendId":\s*"antigravity"/);
  assert.match(antigravityBlock, /"ownedBackendIds":\s*\[\s*"antigravity"\s*\]/);
  assert.match(
    antigravityBlock,
    /"enablementCompatibilityBackendIds":\s*\[\s*"antigravity-localharness",\s*"antigravity-terminal"\s*\]/,
  );

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PLUGIN_METADATA/);
  assert.match(cliOut, /"agentId":\s*"antigravity"/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS/);
  assert.match(
    cliOut,
    /import \{ PLUGIN_MANIFEST as ANTIGRAVITY_PLUGIN_MANIFEST \} from ['"]@happier-dev\/plugins-antigravity\/manifest['"];/,
  );
  assert.doesNotMatch(
    cliOut,
    /import \{ PLUGIN_MANIFEST as ANTIGRAVITY_PLUGIN_MANIFEST \} from ['"]@happier-dev\/plugins-antigravity['"];/,
  );
  assert.doesNotMatch(cliOut, /"binaryName":\s*"agy"|BUNDLED_FIRST_PARTY_AGENT_CONTRIBUTIONS|ownedBackendIds|enablementCompatibilityBackendIds|terminalRuntime\.launch/);
});

test('generateBundledPluginEntries keeps executable Agent facts in implementation bindings', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-provider-support-overlay-'));
  writeAgentPluginFixture(repoRoot, 'claude');
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "claude",',
      '  runtimeContributions: {',
      '    agentCatalogEntry: { importName: "CLAUDE_AGENT_RUNTIME_CONTRIBUTION", source: "./agent/contributions/runtime" },',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src/agent/contributions'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/agent/contributions/runtime.ts'),
    'export const CLAUDE_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({ agentId: "claude" });\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.agent.claude',
      capabilities: ['agents'],
      contributes: `{
        agents: [{
          id: "claude",
          title: "Claude declarative manifest title",
          runtime: { kind: "custom" },
          cli: {
            displayName: "Claude CLI",
            executable: { binaryName: "claude", sourcePreference: "system-first" },
            install: { managed: null, manual: { kind: "none" } },
            auth: {
              support: "unsupported",
              probe: { parser: "none", backgroundChecks: "manual_only", statusArgs: null },
              loginLaunches: [],
            },
          },
          primary: "sessions",
          capabilities: {
            surfaces: ["terminal"],
            sessions: { open: ["create"], delivery: ["newTurn"], cancel: true },
            executionRuns: { open: ["create"], checkpoint: true, stop: true },
          },
          providerRequirements: {
            acceptsProtocols: ["anthropic"],
            required: { streaming: true, toolRoundTrips: true },
            credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
            authIsolation: {
              suppressConnectedServiceIds: ["anthropic"],
              ownedEnvKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
            },
            materialization: "spawnEnv",
            applyPolicy: "restart_session",
            supportsFreeformModelIds: true,
          },
        }],
        systemTools: [{ id: "macos-security", title: "macOS Keychain security", executableNames: ["security"] }],
      }`,
    }),
    'utf8',
  );
  writeClaudeUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOutPath = resolve(
    repoRoot,
    'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts',
  );
  const cliOut = readFileSync(cliOutPath, 'utf8');
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_IMPLEMENTATION_BINDINGS/);
  assert.match(cliOut, /implementationOwnerId:\s*"claude"/);
  assert.match(cliOut, /contribution:\s*CLAUDE_AGENT_RUNTIME_CONTRIBUTION/);
  assert.match(cliOut, /systemTools:\s*CLAUDE_PLUGIN_MANIFEST\.contributes\.systemTools/);
  assert.doesNotMatch(cliOut, /BUNDLED_FIRST_PARTY_AGENT_CONTRIBUTIONS/);
  assert.doesNotMatch(cliOut, /"ownedBackendIds"|"providerSupport"|"providerRequirements"/);

  const uiOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );
  assert.match(
    uiOut,
    /providerOwnedEnvironmentKeys:\s*\['ANTHROPIC_API_KEY',\s*'ANTHROPIC_BASE_URL'\]/,
  );

  writeFileSync(
    cliOutPath,
    cliOut.replace('implementationOwnerId: "claude"', 'implementationOwnerId: "claude-drift"'),
    'utf8',
  );
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs.*generatedBundledPlugins\.ts/i,
  );
});

test('generateBundledPluginEntries rejects duplicate AGENT_DEFINITION ids', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-agent-id-duplicate-'));
  writeAgentPluginFixture(repoRoot, 'left', 'shared-agent');
  writeAgentPluginFixture(repoRoot, 'right', 'shared-agent');
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Duplicate bundled agent provider id 'shared-agent'/,
  );
});

test('generateBundledPluginEntries scopes managed-dependency local ids to their plugin owners', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-installable-id-duplicate-'));
  writeInstallablePluginFixture(repoRoot, 'left-installable', 'shared-tool');
  writeInstallablePluginFixture(repoRoot, 'right-installable', 'shared-tool');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /pluginId:\s*"happier\.installables\.left-installable"/);
  assert.match(cliOut, /pluginId:\s*"happier\.installables\.right-installable"/);
});

test('generateBundledPluginEntries projects bundled SCM backend and installable contributions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-scm-backend-'));

  writeJson(resolve(repoRoot, 'packages/plugins/scm-sapling/package.json'), {
    name: '@happier-dev/plugins-scm-sapling',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/scm-sapling/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/scm-sapling/src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.scm.backend.sapling',
      contributes: `{
        managedDependencies: [{
          id: "sapling-cli",
          title: "Sapling",
          description: "Sapling source control CLI.",
          sources: [{ kind: "system", executableNames: ["sl"], versionArguments: ["--version"] }],
          executable: "sl",
        }],
        scmBackends: [{
          id: "sapling",
          title: "Sapling",
          description: "Sapling local source control backend.",
          kind: "sapling",
          capabilities: ["detect", "fetch", "status", "diff", "commit", "push"],
        }],
      }`,
    }),
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS/);
  assert.doesNotMatch(cliOut, /BUNDLED_FIRST_PARTY_SCM_BACKEND_CONTRIBUTIONS|BUNDLED_FIRST_PARTY_INSTALLABLE_CONTRIBUTIONS/);
  assert.match(cliOut, /pluginId:\s*"happier\.scm\.backend\.sapling"/);
  assert.doesNotMatch(cliOut, /"dep\.sapling"/);
});

test('generateBundledPluginEntries rejects malformed bundled SCM provider contributions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-invalid-scm-'));

  writeJson(resolve(repoRoot, 'packages/plugins/scm-github/package.json'), {
    name: '@happier-dev/plugins-scm-github',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/scm-github/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/scm-github/src/manifest.ts'),
    [
      'export const PLUGIN_MANIFEST = Object.freeze({',
      '  schemaVersion: 2,',
      '  id: "happier.scm.hosting.github",',
      '  version: "0.0.0",',
      '  displayName: "GitHub SCM hosting provider",',
      '  description: "Detects GitHub remotes.",',
      '  engines: { happier: "^0.0.0" },',
      '  runtime: { apiVersion: 1 },',
      '  uses: ["scmHostingProviders"],',
      '  entrypoints: { main: "./dist/index.js" },',
      '  permissions: { required: [], optional: [] },',
      '  contributes: { scmHostingProviders: [{ id: "scm.github", kind: "github", displayName: "GitHub", baseUrl: "not-a-url" }] },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await assert.rejects(
    () => generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Invalid PLUGIN_MANIFEST/,
  );
});

test('generateBundledPluginEntries fails for agent-capable plugin packages without agent definitions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-missing-definition-'));

  writeJson(resolve(repoRoot, 'packages/plugins/placeholder/package.json'), {
    name: '@happier-dev/plugins-placeholder',
    version: '0.0.0',
  });
  mkdirSync(resolve(repoRoot, 'packages/plugins/placeholder/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/placeholder/src/manifest.ts'),
    pluginManifestSource({ id: 'happier.agent.placeholder', capabilities: ['agents'] }),
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await assert.rejects(
    () => generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Missing required agent definition/,
  );
});

test('generateBundledPluginEntries uses AGENT_DEFINITION.id as the runtime agent id', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-runtime-id-'));

  writeJson(resolve(repoRoot, 'packages/plugins/ohmypi/package.json'), {
    name: '@happier-dev/plugins-ohmypi',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/ohmypi/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/ohmypi/src/manifest.ts'),
    pluginManifestSource({ id: 'happier.agent.ohmypi', agentId: 'ohmypi', capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/ohmypi/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/ohmypi/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "ohMyPi",',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeOhMyPiUiDescriptorFixture(repoRoot);

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.match(agentsOut, /"ohMyPi":\s*Object\.freeze\(/);
  assert.match(agentsOut, /"id":\s*"ohMyPi"/);
  assert.doesNotMatch(agentsOut, /"ohmypi":\s*Object\.freeze\(/);

  const agentIdsOut = readGeneratedAgentIdsOutput(repoRoot);
  assert.match(agentIdsOut, /'ohMyPi'/);
  assert.doesNotMatch(agentIdsOut, /'ohmypi'/);
});

test('generateBundledPluginEntries projects only reserved first-party voice package exports by process boundary', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-'));
  for (const packageId of ['elevenlabs', 'google', 'openai', 'xai']) {
    writeBundledVoicePluginFixture(repoRoot, packageId, packageId === 'xai'
      ? {
          manifestContributes: '{ voiceProviders: [{ id: "realtime-grok", title: "xAI Grok Voice", kind: "conversation", roles: ["conversation_stt", "conversation_tts", "realtime_conversation", "turn_control"], platforms: ["web"], capabilities: { readiness: { requirements: ["credential"] }, turn: { cancelResponse: true, bargeIn: true } }, client: { artifactId: "voice-runtime-web", modulePath: "./voiceRuntime", exportName: "activate" } }] }',
        }
      : packageId === 'google'
        ? {
            packageVersion: '1.2.3',
            manifestContributes: '{ voiceProviders: [{ id: "speech", title: "Google Voice Speech", kind: "speech", roles: ["dictation_stt", "conversation_stt", "conversation_tts"], platforms: ["web", "ios", "android"], capabilities: { readiness: { requirements: ["credential"] } } }] }',
          }
        : {});
  }
  writeJson(resolve(repoRoot, 'apps/ui/package.json'), {
    name: '@happier-dev/ui',
    dependencies: { '@happier-dev/protocol': '0.0.0' },
  });
  writeJson(resolve(repoRoot, 'apps/cli/package.json'), {
    name: '@happier-dev/cli',
    dependencies: { '@happier-dev/protocol': '0.0.0' },
    bundledDependencies: ['@happier-dev/protocol'],
  });
  writeGeneratorOutputScaffold(repoRoot);

  // These files deliberately throw if evaluated. Voice projection discovery must be static.
  for (const packageId of ['elevenlabs', 'google', 'openai', 'xai']) {
    mkdirSync(resolve(repoRoot, `packages/plugins/${packageId}/src/ui/voice`), { recursive: true });
    writeFileSync(resolve(repoRoot, `packages/plugins/${packageId}/src/ui/voice/index.ts`), 'throw new Error("must not execute UI voice export");\n', 'utf8');
  }

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const uiOut = readGeneratedUiVoiceEntriesOutput(repoRoot);
  const webRuntimeOut = readGeneratedUiVoiceRuntimeEntriesOutput(repoRoot, 'web');
  const iosRuntimeOut = readGeneratedUiVoiceRuntimeEntriesOutput(repoRoot, 'ios');
  const androidRuntimeOut = readGeneratedUiVoiceRuntimeEntriesOutput(repoRoot, 'android');
  assert.match(uiOut, /GENERATED FILE CONTRACT \(VOICE-FIRST-PARTY-PROJECTION\)/);
  assert.match(uiOut, /BUNDLED_VOICE_UI_ENTRIES as ELEVENLABS_BUNDLED_VOICE_UI_ENTRIES/);
  assert.match(uiOut, /@happier-dev\/plugins-elevenlabs\/ui\/voice/);
  assert.match(uiOut, /BUNDLED_VOICE_UI_ENTRIES as GOOGLE_BUNDLED_VOICE_UI_ENTRIES/);
  assert.match(uiOut, /@happier-dev\/plugins-google\/ui\/voice/);
  assert.match(uiOut, /BUNDLED_VOICE_UI_ENTRIES as OPENAI_BUNDLED_VOICE_UI_ENTRIES/);
  assert.match(uiOut, /@happier-dev\/plugins-openai\/ui\/voice/);
  assert.match(uiOut, /BUNDLED_VOICE_UI_ENTRIES as XAI_BUNDLED_VOICE_UI_ENTRIES/);
  assert.doesNotMatch(uiOut, /activate as/);
  assert.doesNotMatch(uiOut, /BUNDLED_VOICE_PROVIDER_ACTIVATION_ENTRIES/);
  assert.doesNotMatch(uiOut, /BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES as XAI_BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES/);
  assert.doesNotMatch(uiOut, /BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES/);
  assert.doesNotMatch(uiOut, /createBundledConversationRuntimeEntries/);
  for (const executablePackagePrefix of ['ELEVENLABS', 'OPENAI', 'XAI']) {
    assert.match(
      webRuntimeOut,
      new RegExp(
        `BUNDLED_VOICE_UI_ENTRIES as ${executablePackagePrefix}_BUNDLED_VOICE_UI_ENTRIES, activate as ${executablePackagePrefix}_BUNDLED_VOICE_ACTIVATE`,
      ),
    );
    assert.match(
      webRuntimeOut,
      new RegExp(
        `const ${executablePackagePrefix}_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries\\(\\s*${executablePackagePrefix}_BUNDLED_VOICE_UI_ENTRIES,\\s*${executablePackagePrefix}_BUNDLED_VOICE_ACTIVATE,\\s*\\);`,
      ),
    );
    assert.match(
      webRuntimeOut,
      new RegExp(`\\.\\.\\.${executablePackagePrefix}_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,`),
    );
  }
  assert.doesNotMatch(webRuntimeOut, /activate as GOOGLE_BUNDLED_VOICE_ACTIVATE/);
  assert.doesNotMatch(webRuntimeOut, /CODEX_BUNDLED_VOICE_ACTIVATE/);
  assert.match(webRuntimeOut, /BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES/);
  for (const nativeRuntimeOut of [iosRuntimeOut, androidRuntimeOut]) {
    assert.doesNotMatch(nativeRuntimeOut, /@happier-dev\/plugins-/);
    assert.doesNotMatch(nativeRuntimeOut, /activate as/);
    assert.match(
      nativeRuntimeOut,
      /BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES = Object\.freeze\(\[\s*\]\)/,
    );
  }
  assert.match(uiOut, /@happier-dev\/plugins-xai\/ui\/voice/);
  assert.doesNotMatch(uiOut, /\/agent\/voice/);
  assert.match(uiOut, /BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES/);
  assert.deepEqual(
    ['elevenlabs', 'google', 'openai', 'xai'].map((packageId) => uiOut.indexOf(`plugins-${packageId}/ui/voice`)),
    [...['elevenlabs', 'google', 'openai', 'xai'].map((packageId) => uiOut.indexOf(`plugins-${packageId}/ui/voice`))]
      .sort((left, right) => left - right),
  );

  const uiPackage = JSON.parse(readFileSync(resolve(repoRoot, 'apps/ui/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(uiPackage.dependencies?.['@happier-dev/plugins-elevenlabs'], '0.0.0');
  assert.equal(uiPackage.dependencies?.['@happier-dev/plugins-google'], '1.2.3');
  assert.equal(uiPackage.dependencies?.['@happier-dev/plugins-openai'], '0.0.0');
  assert.equal(uiPackage.dependencies?.['@happier-dev/plugins-xai'], '0.0.0');

  const cliPackage = JSON.parse(readFileSync(resolve(repoRoot, 'apps/cli/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  for (const packageId of ['elevenlabs', 'google', 'openai', 'xai']) {
    assert.equal(
      cliPackage.dependencies?.[`@happier-dev/plugins-${packageId}`],
      '0.0.0',
      'CLI plugin membership must remain owned by bundledPluginMembership.ts',
    );
  }

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']);
  const firstUiOut = readGeneratedUiVoiceEntriesOutput(repoRoot);
  const firstRuntimeOuts = (['web', 'ios', 'android'] as const).map(
    (platform) => readGeneratedUiVoiceRuntimeEntriesOutput(repoRoot, platform),
  );
  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
  assert.equal(readGeneratedUiVoiceEntriesOutput(repoRoot), firstUiOut);
  assert.deepEqual(
    (['web', 'ios', 'android'] as const).map(
      (platform) => readGeneratedUiVoiceRuntimeEntriesOutput(repoRoot, platform),
    ),
    firstRuntimeOuts,
  );
});

test('generateBundledPluginEntries independently disables, removes, and re-enables executable UI and CLI voice composition', async () => {
  const packageIds = ['elevenlabs', 'google', 'openai', 'xai'] as const;
  type VoicePackageId = typeof packageIds[number];
  const providerIdByPackage = Object.freeze({
    elevenlabs: 'realtime_elevenlabs',
    google: 'google_gemini',
    openai: 'realtime_openai',
    xai: 'realtime_grok',
  } as const);
  const persistedEnvelopeFor = (packageId: VoicePackageId) => Object.freeze({
    schemaVersion: 1 as const,
    config: Object.freeze({
      owner: packageId,
      selection: `persisted-${providerIdByPackage[packageId]}`,
      nested: Object.freeze({ preserved: true, ordinal: packageIds.indexOf(packageId) }),
    }),
  });
  const expectedFor = (
    phases: Readonly<Record<VoicePackageId, string | null>>,
    selectedPackageId: VoicePackageId,
    disabled: VoicePackageId | null,
    persistedEnvelope = persistedEnvelopeFor(selectedPackageId),
  ) => ({
    ...phases,
    disabled,
    selectedProviderId: providerIdByPackage[selectedPackageId],
    persistedEnvelope,
  });
  const phasesFor = (event: string, absent: VoicePackageId | null = null): Record<VoicePackageId, string | null> => ({
    elevenlabs: absent === 'elevenlabs' ? null : `${event}-elevenlabs`,
    google: absent === 'google' ? null : `${event}-google`,
    openai: absent === 'openai' ? null : `${event}-openai`,
    xai: absent === 'xai' ? null : `${event}-xai`,
  });
  const writePresentFixtures = (phases: Readonly<Record<VoicePackageId, string | null>>) => {
    for (const packageId of packageIds) {
      const phase = phases[packageId];
      if (phase) writeBundledVoicePluginFixture(repoRoot, packageId, { phase });
    }
  };
  const assertPackageMembership = (absentPackageId: VoicePackageId) => {
    const uiOut = readGeneratedUiVoiceEntriesOutput(repoRoot);
    assert.doesNotMatch(uiOut, new RegExp(`@happier-dev/plugins-${absentPackageId}`));
    for (const packageId of packageIds) {
      if (packageId === absentPackageId) continue;
      assert.match(uiOut, new RegExp(`@happier-dev/plugins-${packageId}/ui/voice`));
    }
    for (const app of ['ui', 'cli']) {
      const pkg = JSON.parse(readFileSync(resolve(repoRoot, `apps/${app}/package.json`), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      assert.equal(pkg.dependencies?.[`@happier-dev/plugins-${absentPackageId}`], undefined);
      for (const packageId of packageIds) {
        if (packageId !== absentPackageId) assert.equal(pkg.dependencies?.[`@happier-dev/plugins-${packageId}`], '0.0.0');
      }
    }
    const cliPkg = JSON.parse(readFileSync(resolve(repoRoot, 'apps/cli/package.json'), 'utf8')) as {
      bundledDependencies?: string[];
    };
    assert.equal(cliPkg.bundledDependencies?.includes(`@happier-dev/plugins-${absentPackageId}`), false);
    for (const packageId of packageIds) {
      if (packageId !== absentPackageId) assert.equal(cliPkg.bundledDependencies?.includes(`@happier-dev/plugins-${packageId}`), true);
    }
  };

  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-disable-'));
  const initialPhases = phasesFor('initial');
  writePresentFixtures(initialPhases);
  writeJson(resolve(repoRoot, 'package.json'), { type: 'module' });
  writeJson(resolve(repoRoot, 'apps/ui/package.json'), { name: '@happier-dev/ui', dependencies: {} });
  writeJson(resolve(repoRoot, 'apps/cli/package.json'), { name: '@happier-dev/cli', dependencies: {}, bundledDependencies: [] });
  writeGeneratorOutputScaffold(repoRoot);
  linkLoadableBundledVoiceFixtures(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
  for (const packageId of packageIds) {
    assert.match(readGeneratedUiVoiceEntriesOutput(repoRoot), new RegExp(`@happier-dev/plugins-${packageId}/ui/voice`));
  }
  runBundledVoiceCompositionProbes(repoRoot, expectedFor(initialPhases, 'elevenlabs', null));

  for (const disabledPackageId of packageIds) {
    const persistedEnvelope = persistedEnvelopeFor(disabledPackageId);
    const disabledPhases = phasesFor(`${disabledPackageId}-disabled`, disabledPackageId);
    writeBundledVoicePluginFixture(repoRoot, disabledPackageId, { reservationOnly: true });
    writePresentFixtures(disabledPhases);
    await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
    assertPackageMembership(disabledPackageId);
    runBundledVoiceCompositionProbes(
      repoRoot,
      expectedFor(disabledPhases, disabledPackageId, disabledPackageId, persistedEnvelope),
    );

    const reEnabledPhases = phasesFor(`${disabledPackageId}-re-enabled`);
    writePresentFixtures(reEnabledPhases);
    await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
    runBundledVoiceCompositionProbes(
      repoRoot,
      expectedFor(reEnabledPhases, disabledPackageId, null, persistedEnvelope),
    );
  }

  for (const removedPackageId of packageIds) {
    const persistedEnvelope = persistedEnvelopeFor(removedPackageId);
    const removedPhases = phasesFor(`${removedPackageId}-removed`, removedPackageId);
    rmSync(resolve(repoRoot, `packages/plugins/${removedPackageId}`), { recursive: true, force: true });
    writePresentFixtures(removedPhases);
    await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
    assertPackageMembership(removedPackageId);
    runBundledVoiceCompositionProbes(
      repoRoot,
      expectedFor(removedPhases, removedPackageId, removedPackageId, persistedEnvelope),
    );

    const recreatedPhases = phasesFor(`${removedPackageId}-recreated`);
    writePresentFixtures(recreatedPhases);
    await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
    runBundledVoiceCompositionProbes(
      repoRoot,
      expectedFor(recreatedPhases, removedPackageId, null, persistedEnvelope),
    );
  }

  const removedRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-removed-'));
  writeJson(resolve(removedRoot, 'apps/ui/package.json'), {
    name: '@happier-dev/ui',
    dependencies: { '@happier-dev/plugins-google': '0.0.0' },
  });
  writeJson(resolve(removedRoot, 'apps/cli/package.json'), {
    name: '@happier-dev/cli',
    dependencies: { '@happier-dev/plugins-google': '0.0.0' },
    bundledDependencies: ['@happier-dev/plugins-google'],
  });
  writeGeneratorOutputScaffold(removedRoot);
  await generateBundledPluginEntries(['--root', removedRoot, '--mode', 'write']);
  assert.match(readGeneratedUiVoiceEntriesOutput(removedRoot), /Object\.freeze\(\[\]\)/);
  for (const app of ['ui', 'cli']) {
    const pkg = JSON.parse(readFileSync(resolve(removedRoot, `apps/${app}/package.json`), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    assert.equal(pkg.dependencies?.['@happier-dev/plugins-google'], undefined);
  }
});

test('generateBundledPluginEntries rejects unreserved or mismatched first-party voice identities', async () => {
  const unknownRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-unknown-'));
  writeBundledVoicePluginFixture(unknownRoot, 'rogue', { manifestId: 'happier.voice.rogue' });
  writeGeneratorOutputScaffold(unknownRoot);
  await assert.rejects(
    generateBundledPluginEntries(['--root', unknownRoot, '--mode', 'write']),
    /Unreserved first-party voice plugin identity 'happier\.voice\.rogue'/,
  );

  const stolenRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-stolen-'));
  writeBundledVoicePluginFixture(stolenRoot, 'rogue', { manifestId: 'happier.voice.google' });
  writeGeneratorOutputScaffold(stolenRoot);
  await assert.rejects(
    generateBundledPluginEntries(['--root', stolenRoot, '--mode', 'write']),
    /Reserved first-party voice plugin identity 'happier\.voice\.google' belongs to package 'google'/,
  );

  const mismatchedRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-mismatched-owner-'));
  writeBundledVoicePluginFixture(mismatchedRoot, 'google', { manifestId: 'happier.voice.xai' });
  writeGeneratorOutputScaffold(mismatchedRoot);
  await assert.rejects(
    generateBundledPluginEntries(['--root', mismatchedRoot, '--mode', 'write']),
    /Bundled first-party voice package 'google' must use plugin identity 'happier\.voice\.google', got 'happier\.voice\.xai'/,
  );
});

test('generateBundledPluginEntries validates voice trust before mutating host package membership', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-atomic-reject-'));
  writeBundledVoicePluginFixture(repoRoot, 'rogue', { manifestId: 'happier.voice.rogue' });
  writeJson(resolve(repoRoot, 'apps/ui/package.json'), {
    name: '@happier-dev/ui',
    dependencies: { '@happier-dev/protocol': '0.0.0' },
  });
  writeJson(resolve(repoRoot, 'apps/cli/package.json'), {
    name: '@happier-dev/cli',
    dependencies: { '@happier-dev/protocol': '0.0.0' },
    bundledDependencies: ['@happier-dev/protocol'],
  });
  writeGeneratorOutputScaffold(repoRoot);

  const uiPackageJsonPath = resolve(repoRoot, 'apps/ui/package.json');
  const cliPackageJsonPath = resolve(repoRoot, 'apps/cli/package.json');
  const beforeUiPackageJson = readFileSync(uiPackageJsonPath, 'utf8');
  const beforeCliPackageJson = readFileSync(cliPackageJsonPath, 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Unreserved first-party voice plugin identity 'happier\.voice\.rogue'/,
  );

  assert.equal(readFileSync(uiPackageJsonPath, 'utf8'), beforeUiPackageJson);
  assert.equal(readFileSync(cliPackageJsonPath, 'utf8'), beforeCliPackageJson);
  assert.equal(
    existsSync(resolve(repoRoot, 'apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts')),
    false,
  );
  assert.equal(
    existsSync(resolve(repoRoot, 'apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ios.ts')),
    false,
  );
  assert.equal(
    existsSync(resolve(
      repoRoot,
      'apps/cli/src/plugins/projection/registry/sources/generatedBundledVoiceEntries.ts',
    )),
    false,
  );
});

test('generateBundledPluginEntries statically rejects executable first-party voice manifests without running them', () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-executable-manifest-'));
  writeBundledVoicePluginFixture(repoRoot, 'google');
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/google/src/manifest.ts'),
    [
      'process.exit(73);',
      pluginManifestSource({ id: 'happier.voice.google' }),
    ].join('\n'),
    'utf8',
  );
  writeJson(resolve(repoRoot, 'apps/ui/package.json'), { name: '@happier-dev/ui', dependencies: {} });
  writeJson(resolve(repoRoot, 'apps/cli/package.json'), {
    name: '@happier-dev/cli',
    dependencies: {},
    bundledDependencies: [],
  });
  writeGeneratorOutputScaffold(repoRoot);

  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('./generateBundledPluginEntries.ts', import.meta.url)),
      '--root',
      repoRoot,
      '--mode',
      'write',
    ],
    { encoding: 'utf8' },
  );

  assert.notEqual(result.status, 73, 'voice manifest code must never execute during discovery');
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /first-party voice manifest must contain only the static PLUGIN_MANIFEST export/,
  );
});

test('generateBundledPluginEntries isolates executable non-voice manifest exits from voice projection generation', () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-isolated-module-exit-'));
  writeJson(resolve(repoRoot, 'packages/plugins/rogue/package.json'), {
    name: '@happier-dev/plugins-rogue',
    version: '0.0.0',
  });
  mkdirSync(resolve(repoRoot, 'packages/plugins/rogue/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/rogue/src/manifest.ts'),
    [
      "if (!process.execArgv.includes('--max-old-space-size=2048')) process.exit(75);",
      "process.stderr.write('isolated module stderr sentinel\\n');",
      'process.exit(74);',
      pluginManifestSource({ id: 'happier.test.rogue' }),
    ].join('\n'),
    'utf8',
  );
  writeJson(resolve(repoRoot, 'apps/ui/package.json'), { name: '@happier-dev/ui', dependencies: {} });
  writeJson(resolve(repoRoot, 'apps/cli/package.json'), {
    name: '@happier-dev/cli',
    dependencies: {},
    bundledDependencies: [],
  });
  writeGeneratorOutputScaffold(repoRoot);

  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('./generateBundledPluginEntries.ts', import.meta.url)),
      '--root',
      repoRoot,
      '--mode',
      'write',
    ],
    { encoding: 'utf8' },
  );

  assert.notEqual(result.status, 74, 'inspected module exits must not terminate the generator process directly');
  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Failed to inspect TypeScript module .*packages\/plugins\/rogue\/src\/manifest\.ts: isolated module stderr sentinel/,
  );
});

test('generateBundledPluginEntries rejects missing or malformed fixed voice package exports', async () => {
  const missingRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-missing-export-'));
  writeBundledVoicePluginFixture(missingRoot, 'google', { exports: {} });
  writeGeneratorOutputScaffold(missingRoot);
  await assert.rejects(
    generateBundledPluginEntries(['--root', missingRoot, '--mode', 'write']),
    /Missing required bundled voice export '@happier-dev\/plugins-google\/ui\/voice'/,
  );

  const malformedRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-malformed-export-'));
  writeBundledVoicePluginFixture(malformedRoot, 'google', {
    exports: {
      './ui/voice': './src/ui/voice/index.ts',
    },
  });
  writeGeneratorOutputScaffold(malformedRoot);
  await assert.rejects(
    generateBundledPluginEntries(['--root', malformedRoot, '--mode', 'write']),
    /Invalid bundled voice export '@happier-dev\/plugins-google\/ui\/voice': expected typed built artifact export/,
  );

  const wrongBoundaryRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-wrong-boundary-export-'));
  writeBundledVoicePluginFixture(wrongBoundaryRoot, 'google', {
    exports: {
      './ui/voice': {
        types: './dist/agent/voice/index.d.ts',
        default: './dist/agent/voice/index.js',
      },
    },
  });
  writeGeneratorOutputScaffold(wrongBoundaryRoot);
  await assert.rejects(
    generateBundledPluginEntries(['--root', wrongBoundaryRoot, '--mode', 'write']),
    /Invalid bundled voice export '@happier-dev\/plugins-google\/ui\/voice': expected typed built artifact export/,
  );

  const traversalRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-traversal-export-'));
  writeBundledVoicePluginFixture(traversalRoot, 'google', {
    exports: {
      './ui/voice': {
        types: './dist/ui/voice/index.d.ts',
        default: './dist/ui/voice/../../agent/voice/index.js',
      },
    },
  });
  writeGeneratorOutputScaffold(traversalRoot);
  await assert.rejects(
    generateBundledPluginEntries(['--root', traversalRoot, '--mode', 'write']),
    /Invalid bundled voice export '@happier-dev\/plugins-google\/ui\/voice': expected typed built artifact export/,
  );

  const shadowedNativeRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-shadowed-native-export-'));
  writeBundledVoicePluginFixture(shadowedNativeRoot, 'google', {
    exports: {
      './ui/voice': {
        types: './dist/ui/voice/index.d.ts',
        default: './dist/ui/voice/index.js',
        'react-native': './dist/ui/voice/index.native.js',
      },
    },
  });
  writeGeneratorOutputScaffold(shadowedNativeRoot);
  await assert.rejects(
    generateBundledPluginEntries(['--root', shadowedNativeRoot, '--mode', 'write']),
    /Invalid bundled voice export '@happier-dev\/plugins-google\/ui\/voice': expected ordered conditions types, react-native, default/,
  );

});

test('generateBundledPluginEntries check mode rejects voice projection and dependency drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-voice-projection-drift-'));
  writeBundledVoicePluginFixture(repoRoot, 'xai');
  writeJson(resolve(repoRoot, 'apps/ui/package.json'), { name: '@happier-dev/ui', dependencies: {} });
  writeJson(resolve(repoRoot, 'apps/cli/package.json'), { name: '@happier-dev/cli', dependencies: {}, bundledDependencies: [] });
  writeGeneratorOutputScaffold(repoRoot);
  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts'),
    'export const stale = true;\n',
    'utf8',
  );
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generatedBundledVoiceEntries\.ts/,
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ios.ts'),
    'export const stale = true;\n',
    'utf8',
  );
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generatedBundledVoiceRuntimeEntries\.ios\.ts/,
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
  const uiPkgPath = resolve(repoRoot, 'apps/ui/package.json');
  const uiPkg = JSON.parse(readFileSync(uiPkgPath, 'utf8')) as Record<string, unknown>;
  uiPkg.dependencies = {};
  writeJson(uiPkgPath, uiPkg);
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /apps\/ui voice plugin dependencies are out of sync/,
  );
});
