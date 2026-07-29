import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';

import { renderPrismaCompatibleSqliteDatabaseUrl } from '@happier-dev/cli-common/firstPartyRuntime';

import { startTestDaemon, type StartedDaemon } from '../daemon/daemon';
import { startServerLight } from '../process/serverLight';
import { startUiDevClientMetro } from '../process/uiDevClientMetro';
import { startCliAuthLoginForTerminalConnect } from '../uiE2e/cliTerminalConnect';
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
  redactSensitiveMaestroCommandArgsForLog,
  runMobileMaestro,
} from './mobileMaestroRunner';
import {
  assertMobilePluginCandidateDaemonPreflight,
  buildMobilePluginCandidateDaemonEnv,
} from './mobilePluginPlatformCandidateDaemon';
import { runManagedChildCommand, resolveSignalExitCode } from '../../../scripts/managedChildLifecycle.mjs';

const execFileAsync = promisify(execFile);
const NATIVE_CONTRIBUTION_ID = 'main-native';
const PACKED_NOVEL_DEVICE_ACCOUNT_SECRET =
  'packed-device-account-secret';
const PACKED_NOVEL_DEVICE_ISSUED_CREDENTIAL =
  'device:device-account';

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
    '@swc/helpers': '0.5.23',
    '@types/react': input.reactVersion,
  };
  pluginManifest.version = input.version;
  const contributes = pluginManifest.contributes as {
    ui?: { views?: Array<Record<string, unknown>> };
  };
  const view = contributes.ui?.views?.[0];
  if (!view) throw new Error('Candidate React Native scaffold omitted its declared UI view');
  view.placement = 'app.rightSidebarTab';

  const moduleIdentity = `{
  containerName: '${input.containerName}',
  modulePath: './renderSurface',
  exportName: 'renderSurface',
}`;
  await Promise.all([
    writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8'),
    writeFile(manifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`, 'utf8'),
    writeFile(join(input.fixtureRoot, 'pluginUiBuild.mjs'), `import { definePluginUiBuildConfig } from '@happier-dev/plugin-sdk/ui/build';

export default definePluginUiBuildConfig({
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

const projectRoot = dirname(fileURLToPath(import.meta.url));
const moduleIdentity = ${moduleIdentity};
export default function config(env) {
  const { platform = 'ios', mode = 'production' } = env;
  return {
    mode,
    context: projectRoot,
    entry: {},
    resolve: { ...Repack.getResolveOptions(platform) },
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
        filename: \`\${platform}.bundle.js\`,
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
import type { PluginUiRenderContext } from '@happier-dev/plugin-sdk/ui';
import { Pressable, Text, View } from 'react-native';

function CandidateNativeSurface({ context }: Readonly<{ context: PluginUiRenderContext }>): React.ReactElement {
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

export function renderSurface(context: PluginUiRenderContext): React.ReactElement {
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

async function main(): Promise<void> {
  const candidateManifestPath = requiredEnv('HAPPIER_E2E_PLUGIN_PLATFORM_CANDIDATE');
  const reusableCliInstallRoot = optionalEnv(
    'HAPPIER_E2E_PLUGIN_PLATFORM_REUSE_CLI_INSTALL_ROOT',
  );
  const reusedWorkRoot = String(
    process.env.HAPPIER_E2E_PLUGIN_PLATFORM_REUSE_WORK_ROOT ?? '',
  ).trim();
  const workRoot = reusedWorkRoot
    ? resolvePath(reusedWorkRoot)
    : await mkdtemp(join(tmpdir(), 'happier-plugin-mobile-candidate-'));
  const fixtureRoot = join(workRoot, 'native-plugin');
  const executionId = await resolveExecutionId({ reusedWorkRoot, fixtureRoot });
  const pluginId = `acme.native-candidate-${executionId}`;
  const containerName = `acme_native_candidate_${executionId}_main_native`;
  const sentinelV1 = `candidate-native-${executionId}-v1`;
  const sentinelV2 = `candidate-native-${executionId}-v2`;
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
  const prepared = await preparePluginPlatformCandidateQa({
    authorization: requiredEnv('HAPPIER_E2E_PLUGIN_PLATFORM_G5_AUTHORIZATION'),
    candidateManifestPath,
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
  const packedNovelConnectedAccount =
    await preparePackedNovelConnectedAccountDeviceQa({
      candidate: prepared.candidate,
      handoffManifestPath: requiredEnv(
        'HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST',
      ),
    });
  const packedNovelManualToken = randomUUID();
  const mobileMaestroLogsRoot = resolvePath(
    process.cwd(),
    '.project',
    'logs',
    'e2e',
    'mobile-maestro',
  );
  if (
    JSON.stringify(packedNovelConnectedAccount.authenticationModeIds)
      !== JSON.stringify(['manual', 'oauth', 'device'])
  ) {
    throw new Error(
      'Packed novel device QA requires the exact manual/oauth/device descriptor',
    );
  }
  await Promise.all([
    mkdir(packedNovelConnectedAccount.isolation.happyHomeDir, {
      recursive: true,
    }),
    mkdir(dirname(packedNovelConnectedAccount.isolation.databasePath), {
      recursive: true,
    }),
    mkdir(mobileMaestroLogsRoot, { recursive: true }),
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
        'scaffold',
        fixtureRoot,
        '--id',
        pluginId,
        '--name',
        'Candidate native plugin',
        '--ui',
        'reactNative',
        '--sdk-version',
        prepared.candidate.sdk.version,
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
      baseEnv: process.env,
      happyHomeDir: config.happyHomeDir,
      serverUrl: config.serverUrl,
      webappUrl: config.webappUrl,
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
      runId: prepared.candidate.runId,
      sdk: prepared.candidate.sdk,
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
      { argv: process.argv, cwd: process.cwd(), env: process.env },
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
                dbPath:
                  packedNovelConnectedAccount.isolation.databasePath,
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
            cliHomeDir:
              packedNovelConnectedAccount.isolation.happyHomeDir,
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
            happyHomeDir:
              packedNovelConnectedAccount.isolation.happyHomeDir,
            serverUrl: String(env.HAPPIER_SERVER_URL),
            webappUrl: String(env.HAPPIER_WEBAPP_URL),
          };
          await startPackedDaemon();
          return { stop: stopPackedDaemon };
        },
        runConnectedMachineScenario: async ({ runFlow, serverUrlHost }) => {
          if (!activeCliEnv) throw new Error('Candidate CLI environment was not initialized');
          const packedNovelInstallOutput = await runCandidateCli({
            cliEntrypoint: prepared.cliEntrypoint,
            cwd: workRoot,
            env: activeCliEnv,
            args: [
              'plugins',
              'install',
              packedNovelConnectedAccount.pluginArchivePath,
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
              cliHomeDir:
                packedNovelConnectedAccount.isolation.happyHomeDir,
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
                    packedNovelConnectedAccount.service.pluginId,
                  HAPPIER_E2E_PACKED_NOVEL_SERVICE_ID:
                    packedNovelConnectedAccount.service.localId,
                  HAPPIER_E2E_PACKED_NOVEL_PROVIDER_ORIGIN:
                    packedNovelProvider.origin,
                  HAPPIER_E2E_PACKED_NOVEL_MANUAL_TOKEN:
                    packedNovelManualToken,
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
            return await runPluginPlatformCandidateQaPhases({
              pluginId,
              installArchivePath: archiveV1,
              updateArchivePath: archiveV2,
              runFlow: async (flowPath) => await runFlow(flowPath, {
                HAPPIER_E2E_PLUGIN_ID: pluginId,
                HAPPIER_E2E_PLUGIN_TAB_ID: `app-scope-right-sidebar-tab:plugin:${pluginId}:main`,
                HAPPIER_E2E_PLUGIN_SENTINEL_V1: sentinelV1,
                HAPPIER_E2E_PLUGIN_SENTINEL_V2: sentinelV2,
                HAPPIER_E2E_INSPECTOR_IOS_DIGEST: prepared.inspectorArtifacts.ios.artifactDigest,
                HAPPIER_E2E_INSPECTOR_ANDROID_DIGEST: prepared.inspectorArtifacts.android.artifactDigest,
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
              decideInstallReview: async ({ pendingChangeId, review }) => {
                const outcome = await decideAuthenticatedPluginInstallReview({
                  cliHomeDir:
                    packedNovelConnectedAccount.isolation.happyHomeDir,
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
              },
              stopDaemon: stopPackedDaemon,
              startDaemon: startPackedDaemon,
            });
          } finally {
            await runCandidateCli({
              cliEntrypoint: prepared.cliEntrypoint,
              cwd: workRoot,
              env: activeCliEnv,
              args: [
                'plugins',
                'uninstall',
                packedNovelConnectedAccount.service.pluginId,
                '--json',
              ],
            }).catch(() => undefined);
          }
        },
        runMaestro: async ({ cwd, env, maestroBin, args }) => {
          const logArgs = redactSensitiveMaestroCommandArgsForLog(args, env);
          process.stdout.write(`[tests] starting: ${maestroBin} ${logArgs.join(' ')}\n`);
          const child = await runManagedChildCommand({
            command: maestroBin,
            args,
            spawnOptions: { cwd, env, stdio: 'inherit', detached: process.platform !== 'win32' },
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
    process.exitCode = result.exitCode;
  } finally {
    await stopPackedDaemon().catch(() => undefined);
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

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
