import './utils/env/env.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { run, runCapture, spawnProc } from './utils/proc/proc.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir } from './utils/paths/paths.mjs';
import { ensureDepsInstalled, pmExecBin, pmSpawnBin, requireDir } from './utils/proc/pm.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths } from './utils/expo/expo.mjs';
import { resolveServerPortFromEnv, resolveServerUrls } from './utils/server/urls.mjs';
import { resolveMobileExpoConfig } from './utils/mobile/config.mjs';
import { resolveStackContext } from './utils/stack/context.mjs';
import { expoExec } from './utils/expo/command.mjs';
import { ensureDevExpoServer } from './utils/dev/expo_dev.mjs';
import { resolveMobileReachableServerUrl } from './utils/server/mobile_api_url.mjs';
import { patchIosXcodeProjectsForSigningAndIdentity, resolveIosAppXcodeProjects } from './utils/mobile/ios_xcodeproj_patch.mjs';

/**
 * Mobile dev helper for the embedded `components/happy` Expo app.
 *
 * Goals:
 * - Avoid editing upstream config files in-place.
 * - Ensure the QR/deeplink opens the *dev build* even if the App Store app is installed.
 *
 * Usage:
 *   happys mobile
 *   happys mobile --host=lan
 *   happys mobile --scheme=dev.happier.app.dev
  *   happys mobile --no-metro
 *   happys mobile --run-ios --device="Your iPhone"
 */

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const restart = flags.has('--restart');

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: {
        flags: [
          '--host=lan|localhost|tunnel',
          '--port=8081',
          '--scheme=<url-scheme>',
          '--ios-bundle-id=<bundle-id>',
          '--ios-app-name=<name>',
          '--app-env=development|production',
          '--prebuild [--platform=ios|all] [--clean]',
          '--run-ios [--device=<id-or-name>] [--configuration=Debug|Release]',
          '--metro / --no-metro',
          '--restart',
          '--no-signing-fix',
        ],
        json: true,
      },
      text: [
        '[mobile] usage:',
        '  happys mobile [--host=lan|localhost|tunnel] [--port=8081] [--scheme=...] [--json]',
        '  happys mobile --restart   # force-restart Metro for this stack/worktree',
        '  happys mobile --run-ios [--device=...] [--configuration=Debug|Release]',
        '  happys mobile --prebuild [--platform=ios|all] [--clean]',
        '  happys mobile --no-metro   # just build/install (if --run-ios) without starting Metro',
        '',
        'Notes:',
        '- This script is designed to avoid editing upstream `components/happy` config in-place.',
        '- If you explicitly set HAPPY_STACKS_SERVER_URL (legacy: HAPPY_LOCAL_SERVER_URL), it bakes that URL into the app via EXPO_PUBLIC_HAPPY_SERVER_URL.',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const happyDir = getComponentDir(rootDir, 'happy');
  await requireDir('happy', happyDir);
  await ensureDepsInstalled(happyDir, 'happy');

  // Happy monorepo layouts (historical):
  // - legacy: <happyDir>/expo-app (split-repo era)
  // - current: <happyDir>/packages/app (monorepo packages/)
  //
  // `happys mobile` should operate on the Expo project root, not the monorepo root.
  const packagesAppDir = join(happyDir, 'packages', 'app');
  const legacyExpoAppDir = join(happyDir, 'expo-app');
  const uiDir = existsSync(join(packagesAppDir, 'app.config.js'))
    ? packagesAppDir
    : existsSync(join(legacyExpoAppDir, 'package.json'))
      ? legacyExpoAppDir
      : happyDir;

  async function readXcdeviceList() {
    if (process.platform !== 'darwin') {
      return [];
    }
    const raw = await runCapture('xcrun', ['xcdevice', 'list'], { cwd: happyDir, env: process.env });
    const start = raw.indexOf('[');
    const jsonText = start >= 0 ? raw.slice(start) : raw;
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed : [];
  }

  // Default to the existing dev bundle identifier, which is also registered as a URL scheme
  // (Info.plist includes `dev.happier.app.dev`), so iOS will open the dev build instead of the App Store app.
  const appEnv = process.env.APP_ENV ?? kv.get('--app-env') ?? 'development';
  const host = kv.get('--host') ?? process.env.HAPPY_STACKS_MOBILE_HOST ?? process.env.HAPPY_LOCAL_MOBILE_HOST ?? 'lan';
  const portRaw = kv.get('--port') ?? process.env.HAPPY_STACKS_MOBILE_PORT ?? process.env.HAPPY_LOCAL_MOBILE_PORT ?? '8081';
  // Default behavior:
  // - `happys mobile` starts Metro and keeps running.
  // - `happys mobile --run-ios` / `happys mobile:ios` just builds/installs and exits (unless --metro is provided).
  const shouldStartMetro =
    flags.has('--metro') ||
    (!flags.has('--no-metro') && !flags.has('--run-ios') && !flags.has('--prebuild'));

  const env = {
    ...process.env,
    APP_ENV: appEnv,
  };

  const cfgBase = resolveMobileExpoConfig({ env });
  const iosAppName = (kv.get('--ios-app-name') ?? cfgBase.iosAppName ?? '').toString();
  const iosBundleId = (kv.get('--ios-bundle-id') ?? cfgBase.iosBundleId ?? '').toString();
  const scheme = (kv.get('--scheme') ?? cfgBase.scheme ?? iosBundleId).toString();

  const autostart = getDefaultAutostartPaths();
  const stackCtx = resolveStackContext({ env, autostart });
  const { stackMode, runtimeStatePath, stackName, envPath } = stackCtx;

  // Ensure the built iOS app registers the same scheme we use for dev-client QR links.
  // (Happy app reads EXPO_APP_SCHEME in app.config.js; default remains unchanged when unset.)
  env.EXPO_APP_SCHEME = scheme;
  // Ensure the app display name + bundle id are consistent with what we install.
  // (app.config.js keeps upstream defaults unless these are explicitly set.)
  if (iosAppName && iosAppName.trim()) {
    env.EXPO_APP_NAME = iosAppName.trim();
  }
  if (iosBundleId && iosBundleId.trim()) {
    env.EXPO_APP_BUNDLE_ID = iosBundleId.trim();
  }

  // Always isolate Expo home + TMPDIR to avoid cross-worktree cache pollution (and to keep sandbox runs contained).
  const expoPaths = getExpoStatePaths({
    baseDir: autostart.baseDir,
    kind: 'expo-dev',
    projectDir: uiDir,
    stateFileName: 'expo.state.json',
  });
  await ensureExpoIsolationEnv({
    env,
    stateDir: expoPaths.stateDir,
    expoHomeDir: expoPaths.expoHomeDir,
    tmpDir: expoPaths.tmpDir,
  });

  // Allow happy-stacks to define the default server URL baked into the app bundle.
  // This is read by the app via `process.env.EXPO_PUBLIC_HAPPY_SERVER_URL`.
  const serverPort = resolveServerPortFromEnv({ env, defaultPort: 3005 });
  const allowEnableTailscale =
    !stackMode || stackName === 'main' || (env.HAPPY_STACKS_TAILSCALE_SERVE ?? env.HAPPY_LOCAL_TAILSCALE_SERVE ?? '0').toString().trim() === '1';
  const resolvedUrls = await resolveServerUrls({ env, serverPort, allowEnable: allowEnableTailscale });
  if (resolvedUrls.publicServerUrl && !env.EXPO_PUBLIC_HAPPY_SERVER_URL) {
    env.EXPO_PUBLIC_HAPPY_SERVER_URL = resolvedUrls.publicServerUrl;
  }
  if (env.EXPO_PUBLIC_HAPPY_SERVER_URL) {
    env.EXPO_PUBLIC_HAPPY_SERVER_URL = resolveMobileReachableServerUrl({
      env,
      serverUrl: env.EXPO_PUBLIC_HAPPY_SERVER_URL,
      serverPort,
    });
  }

  if (json) {
    printResult({
      json,
      data: {
        ok: true,
        uiDir,
        appEnv,
        iosAppName,
        iosBundleId,
        scheme,
        host,
        port: portRaw,
        shouldPrebuild: flags.has('--prebuild'),
        shouldRunIos: flags.has('--run-ios'),
        shouldStartMetro,
        expoPublicHappyServerUrl: env.EXPO_PUBLIC_HAPPY_SERVER_URL ?? '',
      },
    });
    return;
  }

  const shouldPrebuild = flags.has('--prebuild');
  if (shouldPrebuild) {
    const platform = kv.get('--platform') ?? 'ios';
    const shouldClean = flags.has('--clean');
    // Prebuild can fail during `pod install` if deployment target mismatches.
    // We skip installs, patch deployment target + RN build mode, then run `pod install` ourselves.
    const prebuildArgs = ['prebuild', '--no-install', '--platform', platform];
    if (shouldClean) {
      prebuildArgs.push('--clean');
    }
    // Run Expo from the monorepo deps (runnerDir=happyDir), but target the Expo project (projectDir=uiDir).
    await expoExec({ dir: happyDir, projectDir: uiDir, args: prebuildArgs, env, ensureDepsLabel: 'happy' });

    // Always patch iOS props if iOS was generated.
    if (platform === 'ios' || platform === 'all') {
      const fs = await import('node:fs/promises');
      const podPropsPath = `${uiDir}/ios/Podfile.properties.json`;
      try {
        const raw = await fs.readFile(podPropsPath, 'utf-8');
        const json = JSON.parse(raw);
        json['ios.deploymentTarget'] = '16.0';
        json['ios.buildReactNativeFromSource'] = 'true';
        await fs.writeFile(podPropsPath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
      } catch {
        // ignore if path missing (platform != ios)
      }

      const iosProjects = await resolveIosAppXcodeProjects({ uiDir });
      for (const project of iosProjects) {
        try {
          const raw = await fs.readFile(project.pbxprojPath, 'utf-8');
          const next = raw.replaceAll('IPHONEOS_DEPLOYMENT_TARGET = 15.1;', 'IPHONEOS_DEPLOYMENT_TARGET = 16.0;');
          if (next !== raw) {
            await fs.writeFile(project.pbxprojPath, next, 'utf-8');
          }
        } catch {
          // ignore missing/invalid pbxproj; Expo will surface actionable errors if needed
        }
      }

      // Ensure CocoaPods doesn't crash due to locale issues.
      env.LANG = env.LANG ?? 'en_US.UTF-8';
      env.LC_ALL = env.LC_ALL ?? 'en_US.UTF-8';

      // Help Node module resolution during `pod install` in Yarn workspace layouts:
      // some deps are hoisted to repo root while `react-native` is not, so Node invocations
      // from hoisted packages can fail to resolve `react-native/package.json`.
      const appNodeModulesDir = join(uiDir, 'node_modules');
      if (existsSync(appNodeModulesDir)) {
        const delim = process.platform === 'win32' ? ';' : ':';
        env.NODE_PATH = env.NODE_PATH ? `${appNodeModulesDir}${delim}${env.NODE_PATH}` : appNodeModulesDir;
      }

      // CocoaPods repo state can be stale on first runs; `--repo-update` fixes missing specs.
      const podCmd = shouldClean ? 'cd ios && pod install --repo-update' : 'cd ios && pod install';
      await run('sh', ['-lc', podCmd], { cwd: uiDir, env });
    }
  }

  if (flags.has('--run-ios')) {
    let device = kv.get('--device') ?? '';
    let resolvedDevice = null;
    if (process.platform === 'darwin') {
      try {
        const list = await readXcdeviceList();
        resolvedDevice = device
          ? list.find((d) => d && (d.identifier === device || d.name === device)) ?? null
          : null;
      } catch {
        resolvedDevice = null;
      }
    }

    if (!device && process.platform === 'darwin') {
      // Auto-pick a connected physical iPhone/iPad if available.
      // This avoids needing to know the exact "Your iPhone" string.
      try {
        const list = await readXcdeviceList();
        const firstConnectedIosDevice = Array.isArray(list)
          ? list.find(
              (d) =>
                d &&
                d.platform === 'com.apple.platform.iphoneos' &&
                d.interface === 'usb' &&
                (d.available === true || d.available === 'YES') &&
                typeof d.identifier === 'string' &&
                d.identifier.length > 0
            )
          : null;
        if (firstConnectedIosDevice?.identifier) {
          device = firstConnectedIosDevice.identifier;
          resolvedDevice = firstConnectedIosDevice;
          // eslint-disable-next-line no-console
          console.log(`[mobile] using connected device: ${firstConnectedIosDevice.name} (${device})`);
        }
      } catch {
        // ignore and let Expo choose
      }
    }

    const isPhysicalIosDevice =
      resolvedDevice?.platform === 'com.apple.platform.iphoneos' && resolvedDevice?.simulator === false;

    const shouldPatchXcodeProject = isPhysicalIosDevice || !!iosAppName;
    if (shouldPatchXcodeProject && !flags.has('--no-signing-fix')) {
      // Expo CLI only passes `-allowProvisioningUpdates` when it *needs* to configure signing.
      // If the pbxproj already has a DEVELOPMENT_TEAM set but no local provisioning profile exists yet,
      // xcodebuild fails with:
      //   "Automatic signing is disabled ... pass -allowProvisioningUpdates"
      //
      // We force Expo CLI to go through its signing configuration path by clearing any pre-existing
      // team/profile identifiers, so it will re-set the team and include the provisioning flags.
      await patchIosXcodeProjectsForSigningAndIdentity({ uiDir, iosBundleId, iosAppName });
    }

    const configuration = kv.get('--configuration') ?? 'Debug';
    const args = ['run:ios', '--no-bundler', '--no-build-cache', '--configuration', configuration];
    if (device) {
      args.push('-d', device);
    }
    // Ensure CocoaPods doesn't crash due to locale issues.
    env.LANG = env.LANG ?? 'en_US.UTF-8';
    env.LC_ALL = env.LC_ALL ?? 'en_US.UTF-8';
    await expoExec({ dir: happyDir, projectDir: uiDir, args, env, ensureDepsLabel: 'happy' });
  }

  if (!shouldStartMetro) {
    return;
  }

  // Unify Expo: one Expo dev server per stack/worktree. If dev mode already started Expo, we reuse it.
  // If Expo is already running without dev-client enabled, we fail closed (no second Expo).
  env.HAPPY_STACKS_EXPO_HOST = host;
  env.HAPPY_LOCAL_EXPO_HOST = host;
  env.HAPPY_STACKS_MOBILE_HOST = host;
  env.HAPPY_LOCAL_MOBILE_HOST = host;
  env.HAPPY_STACKS_MOBILE_SCHEME = scheme;
  env.HAPPY_LOCAL_MOBILE_SCHEME = scheme;
  env.HAPPY_STACKS_EXPO_DEV_PORT = String(portRaw);
  env.HAPPY_LOCAL_EXPO_DEV_PORT = String(portRaw);

  const children = [];
  await ensureDevExpoServer({
    startUi: false,
    startMobile: true,
    uiDir: happyDir,
    expoProjectDir: uiDir,
    autostart,
    baseEnv: env,
    apiServerUrl: env.EXPO_PUBLIC_HAPPY_SERVER_URL ?? '',
    restart,
    stackMode,
    runtimeStatePath,
    stackName,
    envPath,
    children,
  });

  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[mobile] failed:', err);
  process.exit(1);
});
