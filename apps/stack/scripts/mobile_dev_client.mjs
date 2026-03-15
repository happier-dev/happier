import './utils/env/env.mjs';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getFlagValue } from './utils/cli/arg_values.mjs';
import { run } from './utils/proc/proc.mjs';
import { getHappyStacksHomeDir, getRepoDir, getRootDir } from './utils/paths/paths.mjs';
import { banner, cmd, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, yellow } from './utils/ui/ansi.mjs';

import { commandExists } from './utils/proc/commands.mjs';
import { buildMobileDevClientInstallInvocation } from './utils/mobile/dev_client_install_invocation.mjs';
import { resolveDevClientPlatformAndDevice } from './utils/mobile/dev_client_autopick.mjs';
import { resolveAndroidDevClientInstallStrategy } from './utils/mobile/dev_client_android_strategy.mjs';

function resolveAbsPathFromRepoRoot(repoRoot, rawPath) {
  const p = String(rawPath ?? '').trim();
  if (!p) return '';
  if (isAbsolute(p)) return p;
  // Basic Windows drive-letter absolute support.
  if (/^[A-Za-z]:[\\/]/.test(p)) return p;
  return join(repoRoot, p);
}

function resolveAndroidDevClientCachedApkPath({ env } = {}) {
  const home = getHappyStacksHomeDir(env ?? process.env);
  return join(home, 'mobile-dev-client', 'android', 'happier-dev-client-android.apk');
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags }) || flags.has('--help') || argv.length === 0) {
    printResult({
      json,
      data: {
        flags: [
          '--platform=ios|android',
          '--device=<id-or-name>',
          '--scheme=<url-scheme>',
          '--bundle-id=<bundle-id>',
          '--app-name=<name>',
          '--port=<port>',
          '--reuse',
          '--apk=<path>',
          '--clean',
          '--configuration=Debug|Release',
          '--json',
        ],
      },
      text: [
        banner('mobile-dev-client', { subtitle: 'Install the shared dev-client app (one-time).' }),
        '',
        sectionTitle('usage:'),
        `  ${cyan('hstack mobile-dev-client')} --install [--platform=ios|android] [--device=...] [--scheme=...] [--bundle-id=...] [--app-name=...] [--port=...] [--clean] [--configuration=Debug|Release] [--json]`,
        '',
        sectionTitle('notes:'),
        `- Installs a dedicated ${cyan('hstack Dev')} Expo dev-client app on your phone.`,
        `- This app is intended to be ${cyan('reused across stacks')} (no per-stack installs).`,
        `- If you install with a custom ${cyan('--scheme')}, set ${cyan('HAPPIER_STACK_DEV_CLIENT_SCHEME')} to the same value so QR links open the right app.`,
        `- iOS requires ${yellow('Xcode')} + ${yellow('CocoaPods')} (macOS).`,
      ].join('\n'),
    });
    return;
  }

  if (!flags.has('--install')) {
    printResult({
      json,
      data: { ok: false, error: 'missing_install_flag' },
      text: `${yellow('!')} missing ${cyan('--install')}. Run: ${cmd('hstack mobile-dev-client --help')}`,
    });
    process.exit(1);
  }

  const rootDir = getRootDir(import.meta.url);
  const repoRoot = getRepoDir(rootDir, process.env);
  const platformArg = getFlagValue({ argv, kv, flag: '--platform' });
  const deviceArg = getFlagValue({ argv, kv, flag: '--device' });
  const wantsReuseApk = flags.has('--reuse');
  const apkArg = getFlagValue({ argv, kv, flag: '--apk' });

  const isTestStub = String(process.env.HSTACK_MOBILE_DEV_CLIENT_TEST_STUB ?? '').trim() === '1';

  const resolved = await resolveDevClientPlatformAndDevice({
    platformArg,
    deviceArg,
    env: process.env,
    cwd: repoRoot,
  });

  if (resolved.kind === 'ambiguous') {
    if (isTestStub) {
      printResult({
        json: true,
        data: {
          ok: false,
          error: 'ambiguous_platform',
          androidSerial: resolved.androidSerial,
          iosIdentifier: resolved.iosIdentifier,
        },
      });
      return;
    }
    printResult({
      json,
      data: { ok: false, error: 'ambiguous_platform' },
      text:
        `[mobile-dev-client] Both Android + iOS USB devices are connected.\n` +
        `Pass ${cyan('--platform=android')} or ${cyan('--platform=ios')} to disambiguate.`,
    });
    process.exit(1);
  }

  const platform = resolved.platform;
  const argvWithAutopick = [...argv];
  if (!platformArg) {
    argvWithAutopick.push(`--platform=${platform}`);
  }
  if (!deviceArg && resolved.device) {
    argvWithAutopick.push(`--device=${resolved.device}`);
  }

  const invocation = buildMobileDevClientInstallInvocation({ rootDir, argv: argvWithAutopick, baseEnv: process.env });

  /** @type {{ platform: string; strategy: string; steps: Array<{ cmd: string; args: string[]; cwd: string; env: Record<string, string | undefined> }> }} */
  const plan = { platform, strategy: platform === 'android' ? 'unknown' : 'ios', steps: [] };

  if (platform === 'android') {
    const defaultApkAbs = join(repoRoot, 'dist', 'ui-mobile', 'happier-dev-client-android.apk');
    const cachedApkAbs = resolveAndroidDevClientCachedApkPath({ env: process.env });
    const requestedApkAbs = apkArg ? resolveAbsPathFromRepoRoot(repoRoot, apkArg) : '';
    const reuseApkAbs = (() => {
      if (requestedApkAbs) return requestedApkAbs;
      if (existsSync(defaultApkAbs)) return defaultApkAbs;
      if (existsSync(cachedApkAbs)) return cachedApkAbs;
      return defaultApkAbs;
    })();

    if (wantsReuseApk || requestedApkAbs) {
      const hasAdb = await commandExists('adb', { cwd: repoRoot, env: process.env, timeoutMs: 5_000 });
      const hasApk = Boolean(reuseApkAbs) && existsSync(reuseApkAbs);

      if (!hasApk || !hasAdb) {
        const missing = [];
        if (!hasApk) missing.push('apk');
        if (!hasAdb) missing.push('adb');

        if (isTestStub) {
          printResult({
            json: true,
            data: { ok: false, platform, strategy: 'reuse_apk', missing, steps: [] },
          });
          return;
        }

        printResult({
          json,
          data: { ok: false, error: 'android_reuse_missing', missing },
          text:
            `[mobile-dev-client] Cannot reuse an existing APK.\n` +
            `Missing: ${missing.join(', ')}\n` +
            `Looked for APK at: ${cyan(defaultApkAbs)}\n` +
            `Or cached at: ${cyan(cachedApkAbs)}\n` +
            `Tip: run without ${cyan('--reuse')} to rebuild.`,
        });
        process.exit(1);
      }

      plan.strategy = 'reuse_apk';
      plan.steps.push({
        cmd: 'adb',
        args: ['install', '-r', reuseApkAbs],
        cwd: repoRoot,
        env: {
          ...process.env,
          ...(invocation.device ? { ANDROID_SERIAL: invocation.device } : {}),
        },
      });
    } else {
    const strategy = await resolveAndroidDevClientInstallStrategy({ env: process.env, cwd: repoRoot });
    plan.strategy = strategy.kind;

    if (strategy.kind === 'expo_run_android') {
      plan.steps.push({ cmd: process.execPath, args: invocation.nodeArgs, cwd: rootDir, env: invocation.env });
    } else if (strategy.kind === 'eas_local_dagger') {
      const artifactOutRel = 'dist/ui-mobile/happier-dev-client-android.apk';
      const outJsonRel = 'dist/ui-mobile/eas_build_dev_client_android.json';
      const pipelineScript = `${repoRoot}/scripts/pipeline/run.mjs`;

      plan.steps.push({
        cmd: process.execPath,
        args: [
          pipelineScript,
          'expo-native-build',
          '--platform',
          'android',
          '--profile',
          'development',
          '--out',
          outJsonRel,
          '--build-mode',
          'local',
          '--local-runtime',
          'dagger',
          '--artifact-out',
          artifactOutRel,
          '--secrets-source',
          'auto',
          '--keychain-service',
          'happier/pipeline',
        ],
        cwd: repoRoot,
        env: invocation.env,
      });

      const copyArtifactScript = join(rootDir, 'scripts', 'utils', 'mobile', 'copy_artifact.mjs');
      const artifactAbs = join(repoRoot, artifactOutRel);
      plan.steps.push({
        cmd: process.execPath,
        args: [copyArtifactScript, '--from', artifactAbs, '--to', cachedApkAbs],
        cwd: repoRoot,
        env: process.env,
      });

      const hasAdb = await commandExists('adb', { cwd: repoRoot, env: process.env, timeoutMs: 5_000 });
      if (hasAdb) {
        plan.steps.push({
          cmd: 'adb',
          args: ['install', '-r', cachedApkAbs],
          cwd: repoRoot,
          env: {
            ...process.env,
            ...(invocation.device ? { ANDROID_SERIAL: invocation.device } : {}),
          },
        });
      }
    } else {
      // Fail closed: keep behavior explicit when nothing is configured.
      if (isTestStub) {
        printResult({
          json: true,
          data: { ok: false, platform, strategy: strategy.kind, missing: strategy.missing, steps: [] },
        });
        return;
      }
      printResult({
        json,
        data: { ok: false, error: 'android_prereqs_missing', missing: strategy.missing },
        text:
          `[mobile-dev-client] Android tooling not configured.\n` +
          `- To build/install on host: set ANDROID_HOME or ANDROID_SDK_ROOT and ensure adb+java are on PATH.\n` +
          `- To use the pipeline fallback: ensure docker+dagger are on PATH, and provide Expo auth via EXPO_TOKEN or Keychain bundle (service 'happier/pipeline').\n` +
          `Missing: ${strategy.missing.join(', ')}`,
      });
      process.exit(1);
    }
    }
  } else {
    plan.steps.push({ cmd: process.execPath, args: invocation.nodeArgs, cwd: rootDir, env: invocation.env });
  }

  if (isTestStub) {
    const steps = plan.steps.map((s) => ({ cmd: s.cmd, args: s.args, cwd: s.cwd }));
    printResult({ json: true, data: { ok: true, platform: plan.platform, strategy: plan.strategy, steps } });
    return;
  }

  if (plan.steps.length === 0) {
    throw new Error('[mobile-dev-client] internal error: empty plan');
  }

  for (const step of plan.steps) {
    await run(step.cmd, step.args, { cwd: step.cwd, env: step.env });
  }

  if (json) {
    printResult({ json, data: { ok: true, installed: true, identity: invocation.identity, platform, strategy: plan.strategy } });
  }
}

main().catch((err) => {
  console.error('[mobile-dev-client] failed:', err);
  process.exit(1);
});
