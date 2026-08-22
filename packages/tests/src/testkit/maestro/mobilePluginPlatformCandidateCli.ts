import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { renderPrismaCompatibleSqliteDatabaseUrl } from '@happier-dev/cli-common/firstPartyRuntime';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';
import {
  resolveSignalExitCode,
  runManagedChildCommand,
} from '../../../../../scripts/testing/process/managedChildLifecycle.mjs';
import type {
  PackedAuthorCandidate,
} from '../../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';

import { startTestDaemon, type StartedDaemon } from '../daemon/daemon';
import { daemonControlPostJson } from '../daemon/controlServerClient';
import { startServerLight } from '../process/serverLight';
import { startUiDevClientMetro } from '../process/uiDevClientMetro';
import { startCliAuthLoginForTerminalConnect } from '../uiE2e/cliTerminalConnect';
import {
  resolveInstalledAndroidDevClientIdentity,
} from '../mobile/androidDevClientRuntimeVersion';
import {
  resolveInstalledIosSimulatorAppBundleIdentity,
} from '../mobile/iosSimulatorAppBundleIdentity';
import {
  decideAuthenticatedPluginInstallReview,
  readPluginInstallReviewRequiredEnvelope,
} from '../pluginPlatform/authenticatedInstallReview';
import {
  startPackedNovelConnectedAccountProvider,
} from '../pluginPlatform/packedNovelConnectedAccountProvider';
import {
  findSensitiveArtifactFiles,
} from '../pluginPlatform/sensitiveArtifactScan';
import {
  preparePackedNovelConnectedAccountDeviceQa,
  preparePluginPlatformCandidateQa,
  resolveReusablePackedCliEntrypoint,
  runPluginPlatformCandidateQaPhases,
} from './pluginPlatformCandidateQa';
import {
  prepareNativeTriageGithubVoiceQa,
  resolveMobilePluginPlatformCandidateQaInput,
  type MobilePluginPlatformQaArtifacts,
} from './mobilePluginPlatformCandidateInput';
import {
  attestPackedInspectorArtifacts,
  preparePackedUcxWebQa,
} from '../pluginPlatform/packedCandidateBrowserQa';
import {
  redactSensitiveMaestroCommandArgsForLog,
  runMobileMaestro,
} from './mobileMaestroRunner';
import {
  appendMobileUcxNativeRowAttestation,
  type MobilePluginPlatformInstalledAppIdentity,
} from './mobilePluginPlatformCandidateAttestation';
import {
  assertMobilePluginCandidateDaemonPreflight,
  buildMobilePluginCandidateDaemonEnv,
} from './mobilePluginPlatformCandidateDaemon';
import { fakeClaudeFixturePath } from '../fakeClaude';

const execFileAsync = promisify(execFile);
const NATIVE_CONTRIBUTION_ID = 'main-native';
const PACKED_NOVEL_DEVICE_ACCOUNT_SECRET =
  'packed-device-account-secret';
const PACKED_NOVEL_DEVICE_ISSUED_CREDENTIAL =
  'device:device-account';
const PACKED_TARGETED_FIXTURE_ROOT = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/plugin-platform/packed-targeted-contribution-projection',
);
const PACKED_TARGETED_CONTRIBUTOR_PLUGIN_ID =
  'examples.packed-targeted-projection-contributor';

type CandidateRegistry = Readonly<{
  origin: string;
  close: () => Promise<void>;
}>;

type CandidateRegistryPackage = Readonly<{
  packageName: string;
  version: string;
  integrity: string;
  tarballPath: string;
  bytes: Uint8Array;
  packageManifest?: Record<string, unknown>;
}>;

type CandidateRunnerModule = Readonly<{
  readPackedPackageManifest: (
    tarballPath: string,
    extractionRoot: string,
  ) => Promise<Record<string, unknown>>;
  startCandidateRegistry: (params: Readonly<{
    packages: readonly CandidateRegistryPackage[];
  }>) => Promise<CandidateRegistry>;
}>;

type NativePluginPlatformQaCandidate = MobilePluginPlatformQaArtifacts &
  Readonly<{
    runId: string;
    sdk: MobilePluginPlatformQaArtifacts['sdk'] & Readonly<{
      tarballPath: string;
    }>;
    pluginUi: MobilePluginPlatformQaArtifacts['pluginUi'] & Readonly<{
      tarballPath: string;
    }>;
    cli: MobilePluginPlatformQaArtifacts['cli'] & Readonly<{
      tarballPath: string;
      entrypoint: string;
    }>;
  }>;

type NativePluginPlatformInspectorArtifacts = Readonly<{
  ios: Awaited<ReturnType<typeof attestPackedInspectorArtifacts>>['platforms']['ios'];
  android: Awaited<ReturnType<typeof attestPackedInspectorArtifacts>>['platforms']['android'];
}>;

type PreparedNativePluginPlatformCandidateQa = Readonly<{
  artifactBasis: 'candidate_manifest';
  candidate: PackedAuthorCandidate;
  cliEntrypoint: string;
  cleanup: () => Promise<void>;
  inspectorArtifacts: NativePluginPlatformInspectorArtifacts;
}>;

type PreparedNativePluginPlatformRowLocalQa = Readonly<{
  artifactBasis: 'row_local_natural';
  candidate: NativePluginPlatformQaCandidate;
  cliEntrypoint: string;
  cleanup: () => Promise<void>;
  inspectorArtifacts: NativePluginPlatformInspectorArtifacts;
}>;

type PreparedNativePluginPlatformQa =
  | PreparedNativePluginPlatformCandidateQa
  | PreparedNativePluginPlatformRowLocalQa;

function requiredEnv(name: string): string {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`Missing required ${name}`);
  return value;
}

function optionalEnv(name: string): string {
  return String(process.env[name] ?? '').trim();
}

async function sha256File(path: string): Promise<string> {
  return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
}

function captureInstalledMobileAppIdentity(input: Readonly<{
  env: NodeJS.ProcessEnv;
  maestroArgs: readonly string[];
  outputDir: string;
}>): MobilePluginPlatformInstalledAppIdentity {
  const platform = String(input.env.HAPPIER_E2E_MOBILE_PLATFORM ?? '').trim();
  const appId = String(input.env.HAPPIER_E2E_MOBILE_APP_ID ?? '').trim();
  if (!appId || (platform !== 'android' && platform !== 'ios')) {
    return {
      kind: 'unavailable',
      reason: 'maestro_command_did_not_expose_a_supported_mobile_target',
    };
  }
  const maestroDeviceId = (() => {
    for (let index = input.maestroArgs.length - 1; index >= 0; index -= 1) {
      const arg = input.maestroArgs[index];
      if (arg?.startsWith('--udid=') || arg?.startsWith('--device=')) {
        return arg.slice(arg.indexOf('=') + 1).trim();
      }
      if (arg === '--udid' || arg === '--device') {
        return String(input.maestroArgs[index + 1] ?? '').trim();
      }
    }
    return '';
  })();
  const platformDeviceId = platform === 'android'
    ? input.env.HAPPIER_E2E_ANDROID_SERIAL ?? input.env.ANDROID_SERIAL
    : input.env.HAPPIER_E2E_IOS_SIMULATOR_UDID;
  const deviceId = maestroDeviceId || String(
    input.env.HAPPIER_E2E_MOBILE_DEVICE_ID ?? platformDeviceId ?? '',
  ).trim();
  const identityEnv = deviceId
    ? { ...input.env, HAPPIER_E2E_MOBILE_DEVICE_ID: deviceId }
    : input.env;
  if (platform === 'android') {
    try {
      const identity = resolveInstalledAndroidDevClientIdentity({
        appId,
        env: identityEnv,
        outputDir: input.outputDir,
      });
      return identity
        ? {
            kind: 'android-base-apk',
            baseApkSha256: identity.baseApkSha256,
            runtimeVersion: identity.runtimeVersion,
          }
        : {
            kind: 'unavailable',
            reason: 'selected_android_base_apk_could_not_be_attested',
          };
    } catch {
      return {
        kind: 'unavailable',
        reason: 'selected_android_base_apk_could_not_be_attested',
      };
    }
  }
  if (!deviceId) {
    return {
      kind: 'unavailable',
      reason: 'selected_ios_simulator_udid_not_exposed_to_maestro_command',
    };
  }
  try {
    const identity = resolveInstalledIosSimulatorAppBundleIdentity({
      appId,
      deviceId,
      env: identityEnv,
    });
    return identity
      ? {
          kind: 'ios-app-bundle-file-set',
          appBundleFileSetSha256: identity.appBundleFileSetSha256,
        }
      : {
          kind: 'unavailable',
          reason: 'selected_ios_app_bundle_could_not_be_attested',
        };
  } catch {
    return {
      kind: 'unavailable',
      reason: 'selected_ios_app_bundle_could_not_be_attested',
    };
  }
}

async function resolveExecutionId(input: Readonly<{
  reusedWorkRoot: string;
  fixtureRoot: string;
}>): Promise<string> {
  if (!input.reusedWorkRoot) {
    return randomUUID().replaceAll('-', '').slice(0, 12);
  }
  const fixtureManifestPath = join(input.fixtureRoot, '.happier-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(fixtureManifestPath, 'utf8')) as { id?: unknown };
  const pluginId = typeof manifest.id === 'string' ? manifest.id.trim() : '';
  const match = /^acme\.native-candidate-([a-z0-9]+)$/u.exec(pluginId);
  if (!match?.[1]) {
    throw new Error(
      `Reusable native candidate fixture has an unexpected plugin id at ${fixtureManifestPath}`,
    );
  }
  return match[1];
}

async function runCandidateCli(input: Readonly<{
  cliEntrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  args: readonly string[];
  allowReviewRequired?: boolean;
}>): Promise<string> {
  let stdout = '';
  try {
    const result = await execFileAsync(
      process.execPath,
      [input.cliEntrypoint, ...input.args],
      {
        cwd: input.cwd,
        env: input.env,
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    stdout = String(result.stdout ?? '').trim();
  } catch (error) {
    if (!input.allowReviewRequired || !error || typeof error !== 'object' || !('stdout' in error)) {
      throw error;
    }
    stdout = String(error.stdout ?? '').trim();
  }
  if (stdout) process.stdout.write(`${stdout}\n`);
  return stdout;
}

function parseCandidateCliJson(stdout: string, label: string): unknown {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Candidate CLI diagnostics can precede the final JSON response.
    }
  }
  throw new Error(`Candidate CLI ${label} omitted a JSON response`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_must_be_an_object`);
  }
  return value as Record<string, unknown>;
}

function replaceExactly(
  source: string,
  search: string,
  replacement: string,
  label: string,
): string {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`packed_targeted_${label}_marker_invalid`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

async function configureNativeFixture(input: Readonly<{
  fixtureRoot: string;
  sdkTarballPath: string;
  version: string;
  repackVersion: string;
  reactVersion: string;
  reactNativeVersion: string;
  containerName: string;
  sentinelId: string;
}>): Promise<void> {
  const packagePath = join(input.fixtureRoot, 'package.json');
  const manifestPath = join(input.fixtureRoot, '.happier-plugin', 'plugin.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
  const pluginManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  packageJson.version = input.version;
  packageJson.dependencies = {
    ...(
      packageJson.dependencies && typeof packageJson.dependencies === 'object'
        ? packageJson.dependencies as Record<string, unknown>
        : {}
    ),
    '@happier-dev/plugin-sdk': `file:${input.sdkTarballPath}`,
    react: input.reactVersion,
    'react-native': input.reactNativeVersion,
  };
  packageJson.devDependencies = {
    ...(
      packageJson.devDependencies && typeof packageJson.devDependencies === 'object'
        ? packageJson.devDependencies as Record<string, unknown>
        : {}
    ),
    '@babel/core': '^7.25.2',
    '@callstack/repack': input.repackVersion,
    '@react-native-community/cli': '20.1.2',
    '@react-native-community/cli-platform-android': '20.1.2',
    '@react-native-community/cli-platform-ios': '20.1.2',
    '@react-native/metro-config': input.reactNativeVersion,
    '@rspack/core': '2.1.3',
    '@swc/helpers': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@swc/helpers'],
    '@types/react': input.reactVersion,
  };
  pluginManifest.version = input.version;
  const contributes = pluginManifest.contributes as {
    ui?: { views?: Array<Record<string, unknown>> };
  };
  const view = contributes.ui?.views?.[0];
  if (!view) throw new Error('Candidate React Native scaffold omitted its declared UI view');
  view.container = 'rightSidebarTab';
  view.target = { kind: 'app' };
  delete view.placement;

  const moduleIdentity = `{
  containerName: '${input.containerName}',
  modulePath: './renderSurface',
  exportName: 'renderSurface',
}`;
  await Promise.all([
    writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8'),
    writeFile(manifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`, 'utf8'),
    writeFile(join(input.fixtureRoot, 'pluginUiBuild.mjs'), `import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';

export default defineBuildConfig({
  projectRoot: '.',
  outDir: 'node_modules/.cache/happier-plugin-ui',
  targets: [{
    rendererId: '${NATIVE_CONTRIBUTION_ID}',
    entry: 'ui/renderSurface.tsx',
    kind: 'reactNative',
    platforms: ['ios', 'android'],
    module: ${moduleIdentity},
  }],
});
`, 'utf8'),
    writeFile(join(input.fixtureRoot, 'rspack.config.mjs'), `import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Repack from '@callstack/repack';
import { createReactNativeRepackResolveOptions } from '@happier-dev/plugin-sdk/ui/build';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const moduleIdentity = ${moduleIdentity};
export default function config(env) {
  const { platform = 'ios', mode = 'production' } = env;
  return {
    mode,
    context: projectRoot,
    entry: {},
    resolve: { ...createReactNativeRepackResolveOptions(Repack.getResolveOptions(platform)) },
    output: {
      uniqueName: moduleIdentity.containerName,
      path: join(projectRoot, 'node_modules', '.cache', 'happier-plugin-ui', 'react-native', '${NATIVE_CONTRIBUTION_ID}', platform),
      publicPath: 'noop:///',
      chunkFilename: '[name].chunk.bundle',
    },
    module: {
      rules: [
        ...Repack.getJsTransformRules({ codegen: { enabled: false } }),
        ...Repack.getAssetTransformRules(),
      ],
    },
    plugins: [
      new Repack.plugins.RepackTargetPlugin(),
      new Repack.plugins.ModuleFederationPlugin({
        name: moduleIdentity.containerName,
        filename: \`\${platform}.bundle\`,
        exposes: { [moduleIdentity.modulePath]: './src/ui/renderSurface.tsx' },
        shared: {
          react: { singleton: true, eager: false, import: false },
          'react-native': { singleton: true, eager: false, import: false },
        },
      }),
    ],
  };
}
`, 'utf8'),
    writeFile(join(input.fixtureRoot, 'react-native.config.cjs'), `module.exports = {
  commands: require('@callstack/repack/commands/rspack'),
};
`, 'utf8'),
    writeFile(join(input.fixtureRoot, 'src', 'ui', 'renderSurface.tsx'), `import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { Pressable, Text, View } from 'react-native';

function CandidateNativeSurface({ context }: Readonly<{ context: RenderContext }>): React.ReactElement {
  const [hostContextReady, setHostContextReady] = React.useState(false);
  const [crashRequested, setCrashRequested] = React.useState(false);
  if (crashRequested) throw new Error('candidate_native_requested_crash');
  React.useEffect(() => {
    let current = true;
    void context.hostApi.context().then(() => {
      if (current) setHostContextReady(true);
    });
    return () => {
      current = false;
    };
  }, [context.hostApi]);

  return (
    <View
      testID="candidate-native-surface"
      accessible
      accessibilityRole="summary"
      accessibilityLabel="Candidate native plugin ${input.version} ${input.sentinelId}"
    >
      <Text testID="${input.sentinelId}">Candidate native plugin ${input.version} ${input.sentinelId}</Text>
      {hostContextReady ? (
        <Text
          testID="candidate-native-host-api-ok"
          accessibilityLiveRegion="polite"
          accessibilityLabel="Candidate native plugin host API connected"
        >
          Host API connected
        </Text>
      ) : (
        <Text testID="candidate-native-host-api-pending" accessibilityLiveRegion="polite">
          Connecting host API
        </Text>
      )}
      <Pressable
        testID="candidate-native-crash-trigger"
        accessibilityRole="button"
        accessibilityLabel="Test plugin failure isolation"
        onPress={() => setCrashRequested(true)}
      >
        <Text>Test failure isolation</Text>
      </Pressable>
    </View>
  );
}

export function renderSurface(context: RenderContext): React.ReactElement {
  return <CandidateNativeSurface context={context} />;
}
`, 'utf8'),
  ]);
}

async function buildNativeFixture(
  fixtureRoot: string,
  cliEntrypoint: string,
  env: NodeJS.ProcessEnv,
  containerName: string,
): Promise<Readonly<{ iosDigest: string; androidDigest: string }>> {
  await runCandidateCli({
    cliEntrypoint,
    cwd: fixtureRoot,
    env,
    args: ['plugins', 'author', 'build', fixtureRoot, '--json'],
  });
  await execFileAsync(
    process.execPath,
    [
      join(
        fixtureRoot,
        'node_modules',
        '@happier-dev',
        'plugin-sdk',
        'dist',
        'ui',
        'build',
        'bin.js',
      ),
      '--project-root',
      fixtureRoot,
    ],
    {
      cwd: fixtureRoot,
      env,
      timeout: 900_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const artifactManifest = JSON.parse(await readFile(
    join(fixtureRoot, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'),
    'utf8',
  )) as { entries?: Array<Record<string, unknown>> };
  const nativeEntry = (platform: 'ios' | 'android'): Record<string, unknown> | null => (
    artifactManifest.entries?.find((entry) => (
      entry.contributionId === NATIVE_CONTRIBUTION_ID
      && entry.platform === platform
      && entry.builtWith
      && typeof entry.builtWith === 'object'
      && (entry.builtWith as { bundler?: unknown }).bundler === 'repack'
      && entry.repack
      && typeof entry.repack === 'object'
      && (entry.repack as { containerName?: unknown }).containerName === containerName
    )) ?? null
  );
  const ios = nativeEntry('ios');
  const android = nativeEntry('android');
  if (!ios || !android || typeof ios.digest !== 'string' || typeof android.digest !== 'string') {
    throw new Error(
      'Exact candidate author build did not emit explicit iOS and Android Re.Pack artifact identities.',
    );
  }
  return { iosDigest: ios.digest, androidDigest: android.digest };
}

async function preparePackedTargetedFixtureProject(input: Readonly<{
  candidate: NativePluginPlatformQaCandidate;
  fixtureName: 'target' | 'contributor';
  projectRoot: string;
  version: string;
  nativeCompatibility: Readonly<{
    reactVersion: string;
    reactNativeVersion: string;
    repackVersion: string;
  }>;
}>): Promise<void> {
  await cp(
    join(PACKED_TARGETED_FIXTURE_ROOT, input.fixtureName),
    input.projectRoot,
    { recursive: true, force: false },
  );
  await cp(
    join(PACKED_TARGETED_FIXTURE_ROOT, 'public-protocol.ts'),
    join(input.projectRoot, 'src', 'protocol.ts'),
    { force: false },
  );

  const packagePath = join(input.projectRoot, 'package.json');
  const packageJson = requireRecord(
    JSON.parse(await readFile(packagePath, 'utf8')),
    `packed_targeted_${input.fixtureName}_package`,
  );
  const dependencies = requireRecord(
    packageJson.dependencies,
    `packed_targeted_${input.fixtureName}_dependencies`,
  );
  const devDependencies = requireRecord(
    packageJson.devDependencies,
    `packed_targeted_${input.fixtureName}_dev_dependencies`,
  );
  await writeFile(packagePath, `${JSON.stringify({
    ...packageJson,
    version: input.version,
    dependencies: {
      ...dependencies,
      '@happier-dev/plugin-sdk': input.candidate.sdk.version,
      ...(input.fixtureName === 'contributor'
        ? {
            '@happier-dev/plugin-ui': input.candidate.pluginUi.version,
            react: input.nativeCompatibility.reactVersion,
            'react-dom': input.nativeCompatibility.reactVersion,
            'react-native': input.nativeCompatibility.reactNativeVersion,
          }
        : {}),
    },
    ...(input.fixtureName === 'contributor'
      ? {
          devDependencies: {
            ...devDependencies,
            '@callstack/repack': input.nativeCompatibility.repackVersion,
            '@types/react': input.nativeCompatibility.reactVersion,
          },
        }
      : {}),
  }, null, 2)}\n`, 'utf8');

  const entryPath = join(input.projectRoot, 'src', 'index.ts');
  await writeFile(entryPath, replaceExactly(
    await readFile(entryPath, 'utf8'),
    "version: '1.0.0',",
    `version: '${input.version}',`,
    `${input.fixtureName}_version`,
  ), 'utf8');

  if (input.fixtureName === 'contributor') {
    const surfacePath = join(input.projectRoot, 'ui', 'providerDetail.native.tsx');
    await writeFile(surfacePath, replaceExactly(
      await readFile(surfacePath, 'utf8'),
      'value="Packed provider detail"',
      `value=${JSON.stringify(`Packed provider detail ${input.version}`)}`,
      'contributor_surface_version',
    ), 'utf8');
  }
}

async function authorAndPackPackedTargetedFixture(input: Readonly<{
  archivePath: string;
  cliEntrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
  registryOrigin: string;
}>): Promise<void> {
  await runCandidateCli({
    cliEntrypoint: input.cliEntrypoint,
    cwd: input.cwd,
    env: input.env,
    args: [
      'plugins',
      'author',
      'install',
      input.projectRoot,
      '--sdk-registry',
      input.registryOrigin,
      '--json',
    ],
  });
  for (const operation of ['typecheck', 'build'] as const) {
    await runCandidateCli({
      cliEntrypoint: input.cliEntrypoint,
      cwd: input.cwd,
      env: input.env,
      args: ['plugins', 'author', operation, input.projectRoot, '--json'],
    });
  }
  await runCandidateCli({
    cliEntrypoint: input.cliEntrypoint,
    cwd: input.cwd,
    env: input.env,
    args: [
      'plugins',
      'pack',
      input.projectRoot,
      '--out',
      input.archivePath,
      '--json',
    ],
  });
  if ((await readFile(input.archivePath)).byteLength === 0) {
    throw new Error('packed_targeted_fixture_archive_empty');
  }
}

async function preparePackedTargetedNativeArchives(input: Readonly<{
  candidate: NativePluginPlatformQaCandidate;
  cliEntrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  workRoot: string;
  nativeCompatibility: Readonly<{
    reactVersion: string;
    reactNativeVersion: string;
    repackVersion: string;
  }>;
}>): Promise<Readonly<{
  targetArchivePath: string;
  contributorV1ArchivePath: string;
  contributorV2ArchivePath: string;
}>> {
  const candidateRunner = await import(
    '../../../scripts/plugin-platform/run-packed-author-ui-compat.mjs'
  ) as unknown as CandidateRunnerModule;
  const [sdkBytes, pluginUiBytes] = await Promise.all([
    readFile(input.candidate.sdk.tarballPath),
    readFile(input.candidate.pluginUi.tarballPath),
  ]);
  const [sdkPackageManifest, pluginUiPackageManifest] = await Promise.all([
    candidateRunner.readPackedPackageManifest(
      input.candidate.sdk.tarballPath,
      join(input.workRoot, 'verify-targeted-sdk'),
    ),
    candidateRunner.readPackedPackageManifest(
      input.candidate.pluginUi.tarballPath,
      join(input.workRoot, 'verify-targeted-plugin-ui'),
    ),
  ]);
  const registry = await candidateRunner.startCandidateRegistry({
    packages: [{
      ...input.candidate.sdk,
      bytes: sdkBytes,
      packageManifest: sdkPackageManifest,
    }, {
      ...input.candidate.pluginUi,
      bytes: pluginUiBytes,
      packageManifest: pluginUiPackageManifest,
    }],
  });
  try {
    const fixtureRoot = join(input.workRoot, 'packed-targeted-projection');
    const targetRoot = join(fixtureRoot, 'target');
    const contributorV1Root = join(fixtureRoot, 'contributor-v1');
    const contributorV2Root = join(fixtureRoot, 'contributor-v2');
    const archiveRoot = join(input.workRoot, 'packed-targeted-archives');
    const targetArchivePath = join(archiveRoot, 'target-v1.tgz');
    const contributorV1ArchivePath = join(archiveRoot, 'contributor-v1.tgz');
    const contributorV2ArchivePath = join(archiveRoot, 'contributor-v2.tgz');
    await mkdir(archiveRoot, { recursive: true });
    await Promise.all([
      preparePackedTargetedFixtureProject({
        candidate: input.candidate,
        fixtureName: 'target',
        projectRoot: targetRoot,
        version: '1.0.0',
        nativeCompatibility: input.nativeCompatibility,
      }),
      preparePackedTargetedFixtureProject({
        candidate: input.candidate,
        fixtureName: 'contributor',
        projectRoot: contributorV1Root,
        version: '1.0.0',
        nativeCompatibility: input.nativeCompatibility,
      }),
      preparePackedTargetedFixtureProject({
        candidate: input.candidate,
        fixtureName: 'contributor',
        projectRoot: contributorV2Root,
        version: '1.0.1',
        nativeCompatibility: input.nativeCompatibility,
      }),
    ]);
    await authorAndPackPackedTargetedFixture({
      archivePath: targetArchivePath,
      cliEntrypoint: input.cliEntrypoint,
      cwd: input.cwd,
      env: input.env,
      projectRoot: targetRoot,
      registryOrigin: registry.origin,
    });
    await authorAndPackPackedTargetedFixture({
      archivePath: contributorV1ArchivePath,
      cliEntrypoint: input.cliEntrypoint,
      cwd: input.cwd,
      env: input.env,
      projectRoot: contributorV1Root,
      registryOrigin: registry.origin,
    });
    await authorAndPackPackedTargetedFixture({
      archivePath: contributorV2ArchivePath,
      cliEntrypoint: input.cliEntrypoint,
      cwd: input.cwd,
      env: input.env,
      projectRoot: contributorV2Root,
      registryOrigin: registry.origin,
    });
    return Object.freeze({
      targetArchivePath,
      contributorV1ArchivePath,
      contributorV2ArchivePath,
    });
  } finally {
    await registry.close();
  }
}

async function prepareRowLocalNativePluginPlatformQa(input: Readonly<{
  workDir: string;
  sdkTarballPath: string;
  pluginUiTarballPath: string;
  cliTarballPath: string;
}>): Promise<PreparedNativePluginPlatformRowLocalQa> {
  // The browser consumer owns direct-artifact verification and private
  // materialization. Native adds only its native Inspector graph check.
  const prepared = await preparePackedUcxWebQa({
    artifactBasis: 'row_local_natural',
    sdkTarballPath: input.sdkTarballPath,
    pluginUiTarballPath: input.pluginUiTarballPath,
    cliTarballPath: input.cliTarballPath,
    materializationRoot: input.workDir,
  });
  try {
    const inspector = await attestPackedInspectorArtifacts({
      cliEntrypoint: prepared.attestation.cliEntrypoint,
    });
    return Object.freeze({
      artifactBasis: 'row_local_natural',
      candidate: prepared.candidate,
      cliEntrypoint: prepared.attestation.cliEntrypoint,
      cleanup: prepared.cleanup,
      inspectorArtifacts: Object.freeze({
        ios: inspector.platforms.ios,
        android: inspector.platforms.android,
      }),
    });
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }
}

async function main(): Promise<void> {
  const qaInput = resolveMobilePluginPlatformCandidateQaInput({
    cwd: process.cwd(),
    env: process.env,
  });
  const reusableCliInstallRoot = optionalEnv(
    'HAPPIER_E2E_PLUGIN_PLATFORM_REUSE_CLI_INSTALL_ROOT',
  );
  const reusedWorkRoot = String(
    process.env.HAPPIER_E2E_PLUGIN_PLATFORM_REUSE_WORK_ROOT ?? '',
  ).trim();
  if (qaInput.artifactBasis === 'row_local_natural' && reusedWorkRoot) {
    throw new Error(
      'Native row-local QA cannot reuse a prior candidate fixture root.',
    );
  }
  const workRoot = reusedWorkRoot
    ? resolvePath(reusedWorkRoot)
    : await mkdtemp(join(tmpdir(), 'happier-plugin-mobile-candidate-'));
  const fixtureRoot = join(workRoot, 'native-plugin');
  const executionId = await resolveExecutionId({ reusedWorkRoot, fixtureRoot });
  const pluginId = `acme.native-candidate-${executionId}`;
  const containerName = `acme_native_candidate_${executionId}_main_native`;
  const sentinelV1 = `candidate-native-${executionId}-v1`;
  const sentinelV2 = `candidate-native-${executionId}-v2`;
  const triageVoiceFakeClaude = Object.freeze({
    executablePath: fakeClaudeFixturePath(),
    scenario: 'voice-current-ui-triage' as const,
    logPath: join(workRoot, `fake-claude-triage-voice-${executionId}.jsonl`),
  });
  const reusedCliEntrypoint = join(
    workRoot,
    'candidate',
    'candidate-cli-install',
    'node_modules',
    '@happier-dev',
    'cli',
    'bin',
    'happier.mjs',
  );
  const reusableCliDeps = reusableCliInstallRoot
    ? {
        deps: {
          materializePackedCli: async (input: Parameters<
            typeof resolveReusablePackedCliEntrypoint
          >[0]) => await resolveReusablePackedCliEntrypoint({
            installRoot: reusableCliInstallRoot,
            cliArtifact: input.cliArtifact,
          }),
        },
    }
    : {};
  const prepared: PreparedNativePluginPlatformQa =
    qaInput.artifactBasis === 'candidate_manifest'
      ? await (async (): Promise<PreparedNativePluginPlatformCandidateQa> => {
          const candidatePrepared = await preparePluginPlatformCandidateQa({
            authorization: requiredEnv(
              'HAPPIER_E2E_PLUGIN_PLATFORM_G5_AUTHORIZATION',
            ),
            candidateManifestPath: qaInput.candidateManifestPath,
            workDir: join(workRoot, 'candidate'),
            ...reusableCliDeps,
            ...(reusedWorkRoot
              ? {
                  deps: {
                    materializePackedCli: async () => reusedCliEntrypoint,
                  },
                }
              : {}),
          });
          return Object.freeze({
            artifactBasis: 'candidate_manifest',
            candidate: candidatePrepared.candidate,
            cliEntrypoint: candidatePrepared.cliEntrypoint,
            cleanup: candidatePrepared.cleanup,
            inspectorArtifacts: candidatePrepared.inspectorArtifacts,
          });
        })()
      : await prepareRowLocalNativePluginPlatformQa({
          workDir: join(workRoot, 'row-local-artifacts'),
          sdkTarballPath: qaInput.sdkTarballPath,
          pluginUiTarballPath: qaInput.pluginUiTarballPath,
          cliTarballPath: qaInput.cliTarballPath,
        });
  try {
  const triageGithubVoice = await prepareNativeTriageGithubVoiceQa({
    artifacts: prepared.candidate,
    handoffManifestPath: qaInput.triageGithubVoiceHandoffManifestPath,
  });
  const packedNovelConnectedAccount = await (async () => {
    if (prepared.artifactBasis !== 'candidate_manifest') return null;
    if (qaInput.artifactBasis !== 'candidate_manifest') {
      throw new Error('native_plugin_platform_candidate_artifact_basis_mismatch');
    }
    return await preparePackedNovelConnectedAccountDeviceQa({
      candidate: prepared.candidate,
      handoffManifestPath: qaInput.packedNovelHandoffManifestPath,
    });
  })();
  const nativeRuntimeIsolation = packedNovelConnectedAccount?.isolation
    ?? Object.freeze({
      root: join(workRoot, 'row-local-runtime'),
      happyHomeDir: join(workRoot, 'row-local-runtime', 'happier-home'),
      databasePath: join(workRoot, 'row-local-runtime', 'server-data', 'server.sqlite'),
    });
  const packedNovelManualToken = packedNovelConnectedAccount
    ? randomUUID()
    : null;
  const mobileMaestroLogsRoot = resolvePath(
    process.cwd(),
    '.project',
    'logs',
    'e2e',
    'mobile-maestro',
  );
  if (packedNovelConnectedAccount) {
    const publicAuthoring = packedNovelConnectedAccount.publicAuthoring;
    if (
      publicAuthoring.pluginId !== 'examples.public-sdk-review-assistant'
      || publicAuthoring.version !== '0.1.0'
      || publicAuthoring.hostedWeb.contributionId !== 'review-web'
      || publicAuthoring.archive.archivePath !== publicAuthoring.archivePath
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(
        publicAuthoring.archive.integrity,
      )
      || !/^[a-f0-9]{64}$/u.test(publicAuthoring.archive.sha256)
      || publicAuthoring.archive.sizeBytes <= 0
      || !/^sha256:[a-f0-9]{64}$/u.test(publicAuthoring.hostedWeb.digest)
      || publicAuthoring.hostedWeb.files.length === 0
    ) {
      throw new Error(
        'Packed public authoring device QA requires the exact hosted-web handoff graph',
      );
    }
    if (
      JSON.stringify(packedNovelConnectedAccount.authenticationModeIds)
        !== JSON.stringify(['manual', 'oauth', 'device'])
    ) {
      throw new Error(
        'Packed novel device QA requires the exact manual/oauth/device descriptor',
      );
    }
  }
  await Promise.all([
    mkdir(nativeRuntimeIsolation.happyHomeDir, {
      recursive: true,
    }),
    mkdir(dirname(nativeRuntimeIsolation.databasePath), {
      recursive: true,
    }),
    ...(packedNovelConnectedAccount
      ? [mkdir(mobileMaestroLogsRoot, { recursive: true })]
      : []),
  ]);
  const archiveV1 = join(workRoot, 'plugin-v1.tgz');
  const archiveV2 = join(workRoot, 'plugin-v2.tgz');
  const lifecycleFixtureArtifacts = await (async (): Promise<unknown> => {
    if (reusedWorkRoot) {
      return {
        reused: true,
        v1ArchiveDigest: await sha256File(archiveV1),
        v2ArchiveDigest: await sha256File(archiveV2),
      };
    }
    const preAuthEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HAPPIER_HOME_DIR: join(workRoot, 'pre-auth-home'),
    };
    await mkdir(preAuthEnv.HAPPIER_HOME_DIR!, { recursive: true });
    await runCandidateCli({
      cliEntrypoint: prepared.cliEntrypoint,
      cwd: workRoot,
      env: preAuthEnv,
      args: [
        'plugins',
        'create',
        fixtureRoot,
        '--id',
        pluginId,
        '--name',
        'Candidate native plugin',
        '--ui',
        'reactNative',
        '--json',
      ],
    });
    await configureNativeFixture({
      fixtureRoot,
      sdkTarballPath: prepared.candidate.sdk.tarballPath,
      version: '1.0.0',
      repackVersion: prepared.inspectorArtifacts.ios.builtWith.version,
      reactVersion: prepared.inspectorArtifacts.ios.compat.react,
      reactNativeVersion: prepared.inspectorArtifacts.ios.compat.reactNative,
      containerName,
      sentinelId: sentinelV1,
    });
    await runCandidateCli({
      cliEntrypoint: prepared.cliEntrypoint,
      cwd: workRoot,
      env: preAuthEnv,
      args: ['plugins', 'author', 'install', fixtureRoot, '--json'],
    });
    const v1NativeArtifacts = await buildNativeFixture(
      fixtureRoot,
      prepared.cliEntrypoint,
      preAuthEnv,
      containerName,
    );
    await runCandidateCli({
      cliEntrypoint: prepared.cliEntrypoint,
      cwd: workRoot,
      env: preAuthEnv,
      args: ['plugins', 'pack', fixtureRoot, '--out', archiveV1, '--json'],
    });
    await configureNativeFixture({
      fixtureRoot,
      sdkTarballPath: prepared.candidate.sdk.tarballPath,
      version: '1.1.0',
      repackVersion: prepared.inspectorArtifacts.ios.builtWith.version,
      reactVersion: prepared.inspectorArtifacts.ios.compat.react,
      reactNativeVersion: prepared.inspectorArtifacts.ios.compat.reactNative,
      containerName,
      sentinelId: sentinelV2,
    });
    const v2NativeArtifacts = await buildNativeFixture(
      fixtureRoot,
      prepared.cliEntrypoint,
      preAuthEnv,
      containerName,
    );
    if (
      v1NativeArtifacts.iosDigest === v2NativeArtifacts.iosDigest
      || v1NativeArtifacts.androidDigest === v2NativeArtifacts.androidDigest
    ) {
      throw new Error('Candidate native fixture update did not replace both platform artifact digests.');
    }
    await runCandidateCli({
      cliEntrypoint: prepared.cliEntrypoint,
      cwd: workRoot,
      env: preAuthEnv,
      args: ['plugins', 'pack', fixtureRoot, '--out', archiveV2, '--json'],
    });
    return { v1: v1NativeArtifacts, v2: v2NativeArtifacts };
  })();
  const packedTargetedArchives = reusedWorkRoot
    ? Object.freeze({
        targetArchivePath: join(workRoot, 'packed-targeted-archives', 'target-v1.tgz'),
        contributorV1ArchivePath: join(
          workRoot,
          'packed-targeted-archives',
          'contributor-v1.tgz',
        ),
        contributorV2ArchivePath: join(
          workRoot,
          'packed-targeted-archives',
          'contributor-v2.tgz',
        ),
      })
    : await preparePackedTargetedNativeArchives({
        candidate: prepared.candidate,
        cliEntrypoint: prepared.cliEntrypoint,
        cwd: workRoot,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: join(workRoot, 'targeted-author-home'),
        },
        workRoot,
        nativeCompatibility: {
          reactVersion: prepared.inspectorArtifacts.ios.compat.react,
          reactNativeVersion: prepared.inspectorArtifacts.ios.compat.reactNative,
          repackVersion: prepared.inspectorArtifacts.ios.builtWith.version,
        },
      });

  const [ucxContributorV1ArchiveSha256, ucxContributorV2ArchiveSha256] =
    await Promise.all([
      sha256File(packedTargetedArchives.contributorV1ArchivePath),
      sha256File(packedTargetedArchives.contributorV2ArchivePath),
    ]);
  let ucxContributorV1AppliedGeneration: string | null = null;
  let ucxContributorV2AppliedGeneration: string | null = null;
  let installedMobileAppIdentity: MobilePluginPlatformInstalledAppIdentity | null = null;

  let packedDaemon: StartedDaemon | null = null;
  let packedDaemonStartCount = 0;
  let packedDaemonConfig: Readonly<{
    testDir: string;
    happyHomeDir: string;
    serverUrl: string;
    webappUrl: string;
  }> | null = null;
  let activeCliEnv: NodeJS.ProcessEnv | null = null;
  const startPackedDaemon = async (): Promise<void> => {
    if (!packedDaemonConfig) {
      throw new Error('Candidate daemon restart requested before isolated runtime configuration');
    }
    const config = packedDaemonConfig;
    activeCliEnv = buildMobilePluginCandidateDaemonEnv({
      baseEnv: {
        ...process.env,
        HAPPIER_FEATURE_VOICE__ENABLED: '1',
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: '0',
      },
      happyHomeDir: config.happyHomeDir,
      serverUrl: config.serverUrl,
      webappUrl: config.webappUrl,
      fakeClaude: triageVoiceFakeClaude,
    });
    const statusStdout = await runCandidateCli({
      cliEntrypoint: prepared.cliEntrypoint,
      cwd: workRoot,
      env: activeCliEnv,
      args: ['daemon', 'status', '--json'],
    });
    const isolatedRelayIdentity = assertMobilePluginCandidateDaemonPreflight({
      expectedServerUrl: config.serverUrl,
      status: parseCandidateCliJson(statusStdout, 'daemon status'),
    });
    process.stdout.write(`${JSON.stringify({
      kind: 'plugin_platform_mobile_daemon_preflight',
      happyHomeDir: config.happyHomeDir,
      ...isolatedRelayIdentity,
    })}\n`);
    packedDaemonStartCount += 1;
    packedDaemon = await startTestDaemon({
      testDir: join(config.testDir, `generation-${packedDaemonStartCount}`),
      happyHomeDir: config.happyHomeDir,
      env: activeCliEnv,
      cliLaunchSpec: {
        command: process.execPath,
        args: [prepared.cliEntrypoint],
        cwd: workRoot,
      },
    });
  };
  const stopPackedDaemon = async (): Promise<void> => {
    const daemon = packedDaemon;
    packedDaemon = null;
    if (!daemon) return;
    await daemon.stop();
  };

  try {
    process.stdout.write(`${JSON.stringify({
      kind: 'plugin_platform_mobile_candidate_attestation',
      artifactBasis: prepared.artifactBasis,
      ...(prepared.artifactBasis === 'candidate_manifest'
        ? { runId: prepared.candidate.runId }
        : {}),
      sdk: prepared.candidate.sdk,
      pluginUi: prepared.candidate.pluginUi,
      cli: prepared.candidate.cli,
      inspectorArtifacts: prepared.inspectorArtifacts,
      lifecycleFixtureArtifacts,
      lifecycleFixtureIdentity: {
        executionId,
        pluginId,
        containerName,
        sentinelV1,
        sentinelV2,
      },
      ...(packedNovelConnectedAccount
        ? {
            packedNovelConnectedAccount: {
              pluginArchivePath:
                packedNovelConnectedAccount.pluginArchivePath,
              service: packedNovelConnectedAccount.service,
              supportedAuthenticationModeIds:
                packedNovelConnectedAccount.authenticationModeIds,
              deviceAcceptanceModeIds: ['manual', 'device'],
              oauthDisposition:
                'browser-only-no-reachable-trusted-device-origin',
              isolation: packedNovelConnectedAccount.isolation,
            },
            publicAuthoring: {
              pluginId: packedNovelConnectedAccount.publicAuthoring.pluginId,
              version: packedNovelConnectedAccount.publicAuthoring.version,
              archivePath:
                packedNovelConnectedAccount.publicAuthoring.archivePath,
              archiveIntegrity:
                packedNovelConnectedAccount.publicAuthoring.archive.integrity,
              hostedWeb: {
                contributionId:
                  packedNovelConnectedAccount.publicAuthoring.hostedWeb.contributionId,
                digest:
                  packedNovelConnectedAccount.publicAuthoring.hostedWeb.digest,
                fileCount:
                  packedNovelConnectedAccount.publicAuthoring.hostedWeb.files.length,
              },
            },
          }
        : {}),
    })}\n`);
    if (process.env.HAPPIER_E2E_PLUGIN_PLATFORM_PREPARE_ONLY === '1') {
      process.stdout.write(`${JSON.stringify({
        kind: 'plugin_platform_mobile_candidate_prepared',
        workRoot,
        archiveV1,
        archiveV2,
      })}\n`);
      return;
    }
    const result = await runMobileMaestro(
      {
        argv: process.argv,
        cwd: process.cwd(),
        env: {
          ...process.env,
          HAPPIER_FEATURE_VOICE__ENABLED: '1',
          HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: '0',
          HAPPIER_E2E_UCX_NATIVE_LOADED_IDENTITY: '1',
        },
      },
      {
        startDevClientMetro: async ({ testDir, extraEnv, port, host }) => {
          const started = await startUiDevClientMetro({
            testDir,
            env: { ...process.env, ...extraEnv },
            port,
            host,
          });
          return {
            baseUrl: started.baseUrl,
            port: started.port,
            stdoutPath: started.stdoutPath,
            stop: started.stop,
          };
        },
        startServerLight: async ({ testDir, extraEnv }) => {
          const started = await startServerLight({
            testDir,
            extraEnv: {
              ...extraEnv,
              DATABASE_URL: renderPrismaCompatibleSqliteDatabaseUrl({
                dbPath: nativeRuntimeIsolation.databasePath,
                platform: process.platform,
                sqlite: { connectionLimit: 4 },
              }),
            },
          });
          return {
            baseUrl: started.baseUrl,
            port: started.port,
            dataDir: started.dataDir,
            stop: started.stop,
          };
        },
        startCliTerminalConnect: async ({
          testDir,
          cliHomeDir,
          serverUrl,
          webappUrl,
          env,
          waitForConnectUrlReady,
        }) => (
          await startCliAuthLoginForTerminalConnect({
            testDir,
            cliHomeDir: nativeRuntimeIsolation.happyHomeDir,
            serverUrl,
            webappUrl,
            env,
            waitForConnectUrlReady,
            cliLaunchSpec: {
              command: process.execPath,
              args: [prepared.cliEntrypoint],
              cwd: workRoot,
            },
          })
        ),
        startTestDaemon: async ({ testDir, happyHomeDir, env }) => {
          packedDaemonConfig = {
            testDir,
            happyHomeDir: nativeRuntimeIsolation.happyHomeDir,
            serverUrl: String(env.HAPPIER_SERVER_URL),
            webappUrl: String(env.HAPPIER_WEBAPP_URL),
          };
          await startPackedDaemon();
          return { stop: stopPackedDaemon };
        },
        runConnectedMachineScenario: async ({ runFlow, serverUrlHost }) => {
          if (!activeCliEnv) throw new Error('Candidate CLI environment was not initialized');
          const runPluginPlatformPhases = async (): Promise<number> => (
            await runPluginPlatformCandidateQaPhases({
              pluginId,
              installArchivePath: archiveV1,
              updateArchivePath: archiveV2,
              targeted: {
                ...packedTargetedArchives,
                contributorPluginId: PACKED_TARGETED_CONTRIBUTOR_PLUGIN_ID,
              },
              triageGithubVoice,
              runFlow: async (flowPath, extraEnv) => await runFlow(flowPath, {
                HAPPIER_E2E_PLUGIN_ID: pluginId,
                HAPPIER_E2E_PLUGIN_TAB_ID: `app-scope-right-sidebar-tab:plugin:${pluginId}:main`,
                HAPPIER_E2E_PLUGIN_SENTINEL_V1: sentinelV1,
                HAPPIER_E2E_PLUGIN_SENTINEL_V2: sentinelV2,
                HAPPIER_E2E_INSPECTOR_IOS_DIGEST: prepared.inspectorArtifacts.ios.artifactDigest,
                HAPPIER_E2E_INSPECTOR_ANDROID_DIGEST: prepared.inspectorArtifacts.android.artifactDigest,
                ...extraEnv,
              }),
              runCli: async (args) => {
                return await runCandidateCli({
                  cliEntrypoint: prepared.cliEntrypoint,
                  cwd: workRoot,
                  env: activeCliEnv!,
                  args,
                  allowReviewRequired: args[0] === 'plugins' && args[1] === 'install',
                });
              },
              requestPluginChange: async (request) => {
                const daemon = packedDaemon;
                if (!daemon) {
                  throw new Error('Targeted plugin trust revocation requested without a live daemon');
                }
                const response = await daemonControlPostJson({
                  port: daemon.state.httpPort,
                  controlToken: daemon.state.controlToken,
                  path: '/plugins/change/request',
                  body: request,
                });
                return response.data;
              },
              decideInstallReview: async ({ pendingChangeId, review }) => {
                const outcome = await decideAuthenticatedPluginInstallReview({
                  cliHomeDir: nativeRuntimeIsolation.happyHomeDir,
                  serverUrl: serverUrlHost,
                  pendingChangeId,
                  optionalSelections: review.optionalHostAccess.map((entry) => ({
                    accessId: entry.id,
                    selected: false,
                  })),
                  confirmPresentUser: async () => true,
                });
                if (
                  outcome.kind !== 'committed'
                  || outcome.pluginId !== review.pluginId
                  || typeof outcome.desiredGeneration !== 'string'
                  || outcome.desiredGeneration.length === 0
                  || outcome.appliedGeneration !== outcome.desiredGeneration
                  || !Array.isArray(outcome.pendingSurfaces)
                ) {
                  throw new Error(
                    `Authenticated present-user install review did not commit and apply ${review.pluginId}: ${JSON.stringify(outcome)}`,
                  );
                }
                if (
                  review.pluginId === PACKED_TARGETED_CONTRIBUTOR_PLUGIN_ID
                  && review.version === '1.0.0'
                  && ucxContributorV1AppliedGeneration === null
                ) {
                  ucxContributorV1AppliedGeneration = outcome.appliedGeneration;
                }
                if (
                  review.pluginId === PACKED_TARGETED_CONTRIBUTOR_PLUGIN_ID
                  && review.version === '1.0.1'
                  && ucxContributorV2AppliedGeneration === null
                ) {
                  ucxContributorV2AppliedGeneration = outcome.appliedGeneration;
                }
              },
              stopDaemon: stopPackedDaemon,
              startDaemon: startPackedDaemon,
            })
          );
          if (!packedNovelConnectedAccount) {
            return await runPluginPlatformPhases();
          }

          const packedNovel = packedNovelConnectedAccount;
          const publicAuthoring = packedNovel.publicAuthoring;
          const packedNovelManualTokenValue = packedNovelManualToken;
          if (!packedNovelManualTokenValue) {
            throw new Error('Candidate packed novel QA omitted its manual token');
          }
          const packedNovelInstallOutput = await runCandidateCli({
            cliEntrypoint: prepared.cliEntrypoint,
            cwd: workRoot,
            env: activeCliEnv,
            args: [
              'plugins',
              'install',
              packedNovel.pluginArchivePath,
              '--json',
            ],
            allowReviewRequired: true,
          });
          const packedNovelInstallReview =
            readPluginInstallReviewRequiredEnvelope(
              parseCandidateCliJson(
                packedNovelInstallOutput,
                'packed novel plugin install',
              ),
            );
          const packedNovelInstallOutcome =
            await decideAuthenticatedPluginInstallReview({
              cliHomeDir: nativeRuntimeIsolation.happyHomeDir,
              serverUrl: serverUrlHost,
              pendingChangeId:
                packedNovelInstallReview.pendingChangeId,
              optionalSelections:
                packedNovelInstallReview.review.optionalHostAccess.map(
                  (entry) => ({
                    accessId: entry.id,
                    selected: false,
                  }),
                ),
              confirmPresentUser: async () => true,
            });
          if (
            packedNovelInstallOutcome.kind !== 'committed'
            || packedNovelInstallOutcome.pluginId !== 'acme.vertical-a'
          ) {
            throw new Error(
              `Packed novel device install did not commit: ${
                JSON.stringify(packedNovelInstallOutcome)
              }`,
            );
          }
          const publicAuthoringInstallOutput = await runCandidateCli({
            cliEntrypoint: prepared.cliEntrypoint,
            cwd: workRoot,
            env: activeCliEnv,
            args: [
              'plugins',
              'install',
              publicAuthoring.archivePath,
              '--json',
            ],
            allowReviewRequired: true,
          });
          const publicAuthoringInstallReview =
            readPluginInstallReviewRequiredEnvelope(
              parseCandidateCliJson(
                publicAuthoringInstallOutput,
                'packed public authoring plugin install',
              ),
            );
          if (
            publicAuthoringInstallReview.review.pluginId
              !== publicAuthoring.pluginId
          ) {
            throw new Error(
              'Packed public authoring device install requested review for the wrong plugin',
            );
          }
          const publicAuthoringInstallOutcome =
            await decideAuthenticatedPluginInstallReview({
              cliHomeDir: nativeRuntimeIsolation.happyHomeDir,
              serverUrl: serverUrlHost,
              pendingChangeId:
                publicAuthoringInstallReview.pendingChangeId,
              optionalSelections:
                publicAuthoringInstallReview.review.optionalHostAccess.map(
                  (entry) => ({
                    accessId: entry.id,
                    selected: false,
                  }),
                ),
              confirmPresentUser: async () => true,
            });
          if (
            publicAuthoringInstallOutcome.kind !== 'committed'
            || publicAuthoringInstallOutcome.pluginId
              !== publicAuthoring.pluginId
            || typeof publicAuthoringInstallOutcome.desiredGeneration !== 'string'
            || publicAuthoringInstallOutcome.appliedGeneration
              !== publicAuthoringInstallOutcome.desiredGeneration
          ) {
            throw new Error(
              `Packed public authoring device install did not commit: ${
                JSON.stringify(publicAuthoringInstallOutcome)
              }`,
            );
          }
          try {
            const packedNovelProvider =
              await startPackedNovelConnectedAccountProvider();
            let packedNovelDeviceFlow: { exitCode: number };
            try {
              packedNovelDeviceFlow = await runFlow(
                'suites/mobile-e2e/flows/plugin-platform-candidate/'
                  + 'packed-novel-manual-device.yaml',
                {
                  HAPPIER_E2E_PACKED_NOVEL_PLUGIN_ID:
                    packedNovel.service.pluginId,
                  HAPPIER_E2E_PACKED_NOVEL_SERVICE_ID:
                    packedNovel.service.localId,
                  HAPPIER_E2E_PACKED_NOVEL_PROVIDER_ORIGIN:
                    packedNovelProvider.origin,
                  HAPPIER_E2E_PACKED_NOVEL_MANUAL_TOKEN:
                    packedNovelManualTokenValue,
                  HAPPIER_E2E_PACKED_NOVEL_ACCOUNT_SECRET:
                    PACKED_NOVEL_DEVICE_ACCOUNT_SECRET,
                },
              );
              if (
                packedNovelDeviceFlow.exitCode === 0
                && packedNovelProvider.requestCount() < 3
              ) {
                throw new Error(
                  'Packed novel manual/device acceptance did not reach '
                    + 'the provider through both completed modes',
                );
              }
            } finally {
              await packedNovelProvider.close();
            }
            if (packedNovelDeviceFlow.exitCode !== 0) {
              return packedNovelDeviceFlow.exitCode;
            }
            return await runPluginPlatformPhases();
          } finally {
            await runCandidateCli({
              cliEntrypoint: prepared.cliEntrypoint,
              cwd: workRoot,
              env: activeCliEnv,
              args: [
                'plugins',
                'uninstall',
                publicAuthoring.pluginId,
                '--json',
              ],
            }).catch(() => undefined);
            await runCandidateCli({
              cliEntrypoint: prepared.cliEntrypoint,
              cwd: workRoot,
              env: activeCliEnv,
              args: [
                'plugins',
                'uninstall',
                packedNovel.service.pluginId,
                '--json',
              ],
            }).catch(() => undefined);
          }
        },
        runMaestro: async ({ cwd, env, maestroBin, args }) => {
          installedMobileAppIdentity ??= captureInstalledMobileAppIdentity({
            env,
            maestroArgs: args,
            outputDir: join(workRoot, 'loaded-host-identity'),
          });
          const logArgs = redactSensitiveMaestroCommandArgsForLog(args, env);
          process.stdout.write(`[tests] starting: ${maestroBin} ${logArgs.join(' ')}\n`);
          const child = await runManagedChildCommand({
            command: maestroBin,
            args,
            spawnOptions: {
              cwd,
              env,
              stdio: 'inherit',
              detached: process.platform !== 'win32',
            },
            cleanupPollMs: 25,
            signalCleanupGraceMs: 0,
            exitCleanupGraceMs: 1_000,
            parentWatchdogPollMs: 1_000,
          });
          if (!child.ok) return { exitCode: 1 };
          return {
            exitCode: typeof child.code === 'number'
              ? child.code
              : resolveSignalExitCode(child.signal),
          };
        },
      },
    );
    const ucxNativeAttestation = await appendMobileUcxNativeRowAttestation({
      manifestPath: result.manifestPath,
      row: {
        sdk: prepared.candidate.sdk,
        pluginUi: prepared.candidate.pluginUi,
        cli: prepared.candidate.cli,
        plugin: {
          id: PACKED_TARGETED_CONTRIBUTOR_PLUGIN_ID,
          v1: {
            version: '1.0.0',
            archiveSha256: ucxContributorV1ArchiveSha256,
            appliedGeneration: ucxContributorV1AppliedGeneration,
          },
          v2: {
            version: '1.0.1',
            archiveSha256: ucxContributorV2ArchiveSha256,
            appliedGeneration: ucxContributorV2AppliedGeneration,
          },
        },
      },
      installedApp: installedMobileAppIdentity ?? {
        kind: 'unavailable',
        reason: 'maestro_process_did_not_start',
      },
      loadedRuntime: result.ucxLoadedNativeRuntime,
    });
    process.stdout.write(`${JSON.stringify({
      kind: 'plugin_platform_mobile_ucx_native_attestation',
      manifestPath: result.manifestPath,
      attestation: ucxNativeAttestation,
    })}\n`);
    process.exitCode = ucxNativeAttestation.status === 'observed'
      ? result.exitCode
      : result.exitCode || 1;
  } finally {
    await stopPackedDaemon().catch(() => undefined);
    if (packedNovelConnectedAccount && packedNovelManualToken) {
      const sensitiveFiles = (
        await Promise.all([
          findSensitiveArtifactFiles({
            rootPath: packedNovelConnectedAccount.isolation.root,
            sensitiveValues: [
              packedNovelManualToken,
              PACKED_NOVEL_DEVICE_ACCOUNT_SECRET,
              PACKED_NOVEL_DEVICE_ISSUED_CREDENTIAL,
            ],
            strict: true,
          }),
          findSensitiveArtifactFiles({
            rootPath: mobileMaestroLogsRoot,
            sensitiveValues: [
              packedNovelManualToken,
              PACKED_NOVEL_DEVICE_ACCOUNT_SECRET,
              PACKED_NOVEL_DEVICE_ISSUED_CREDENTIAL,
            ],
            strict: true,
          }),
        ])
      ).flat();
      if (sensitiveFiles.length > 0) {
        throw new Error(
          'packed_novel_device_sensitive_artifact_leak_detected',
        );
      }
    }
  }
  } finally {
    await prepared.cleanup();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
