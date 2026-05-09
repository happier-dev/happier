// @ts-check

import { access, chmod, copyFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { delimiter, join, resolve, win32 as pathWin32 } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolvePublishedInstallerAsset,
  resolvePublishedInstallerAssetForTag,
  resolvePublishedInstallerChannelForTag,
} from '../../release/installers/catalog.mjs';
import { normalizePublicReleaseChannel } from '../../release/lib/public-release-rings.mjs';
import { prepareInstallersSmokeLocalBuildAssets } from './installers-smoke-local-build.mjs';

function assertNativePlatform(platform) {
  if (platform !== process.platform) {
    throw new Error(`installers-smoke must run natively on ${platform}; current runner platform is ${process.platform}`);
  }
}

/**
 * @param {'linux' | 'darwin' | 'win32'} platform
 * @param {string} installer
 */
function resolveCliSmokeBinaryName(platform, installer) {
  const baseName = installer.includes('install-dev')
    ? 'hdev'
    : installer.includes('install-preview')
      ? 'hprev'
      : 'happier';
  return platform === 'win32' ? `${baseName}.exe` : baseName;
}

/**
 * @param {{ platform: 'linux' | 'darwin' | 'win32'; source: { kind: string; ref: string } | null; releaseChannel?: string }} params
 */
export function resolveInstallersSmokePlan({ platform, source, releaseChannel }) {
  if (!source) {
    throw new Error('installers-smoke requires --source published-channel|published-tag|local-build');
  }
  const normalizedReleaseChannel = normalizePublicReleaseChannel(releaseChannel ?? '');
  const localBuildChannel = source.kind === 'local-build'
    ? normalizedReleaseChannel
    : source.kind === 'published-channel'
      ? normalizePublicReleaseChannel(source.ref)
      : source.kind === 'published-tag'
        ? resolvePublishedInstallerChannelForTag(source.ref)
        : null;
  const resolved =
    source.kind === 'published-channel'
      ? resolvePublishedInstallerAsset({ platform, channel: source.ref })
      : source.kind === 'published-tag'
        ? resolvePublishedInstallerAssetForTag({ platform, tag: source.ref })
        : source.kind === 'local-build' && localBuildChannel
          ? { tag: null, installer: resolvePublishedInstallerAsset({ platform, channel: localBuildChannel }).installer }
          : null;
  if (!resolved) {
    if (source.kind === 'local-build') {
      throw new Error('installers-smoke local-build requires --release-channel stable|preview|dev');
    }
    throw new Error('installers-smoke currently supports only published-channel, published-tag, or local-build sources');
  }
  const { tag, installer } = resolved;
  return {
    platform,
    tag,
    installer,
    binaryName: resolveCliSmokeBinaryName(platform, installer),
    releaseChannel: /** @type {'stable' | 'preview' | 'publicdev'} */ (localBuildChannel),
    installerEnv: {
      HAPPIER_WITH_DAEMON: '0',
    },
  };
}

/**
 * @param {{ platform: 'linux' | 'darwin' | 'win32'; source: { kind: string; ref: string } | null; releaseChannel?: string }} params
 */
export function resolveInstallersSmokeExecution({ platform, source, releaseChannel }) {
  return {
    type: 'installers-smoke',
    plan: resolveInstallersSmokePlan({ platform, source, releaseChannel }),
  };
}

/**
 * @param {{ platform: 'linux' | 'darwin' | 'win32' }} params
 */
export function resolveInstallersSmokeLifecycleSteps({ platform }) {
  if (platform === 'win32') {
    return ['install', 'version', 'help'];
  }
  return ['install', 'version', 'help', 'check', 'reinstall', 'check', 'uninstall'];
}

/**
 * @param {{
 *   platform: 'linux' | 'darwin' | 'win32';
 *   installDir: string;
 *   requestedBinDir: string;
 *   binaryName: string;
 * }} params
 */
export function resolveInstallersSmokeBinaryPath({ platform, installDir, requestedBinDir, binaryName }) {
  if (platform === 'win32') {
    return pathWin32.join(installDir, 'bin', binaryName);
  }
  return join(requestedBinDir, binaryName);
}

/**
 * @param {{ tag: string; repoSlug: string; token?: string }} params
 */
async function checkGitHubReleaseTagExists({ tag, repoSlug, token }) {
  const url = `https://api.github.com/repos/${repoSlug}/releases/tags/${tag}`;
  const headers = {
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch(url, { headers });
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`failed to probe release tag ${tag}: http ${response.status}`);
  }
  return true;
}

/**
 * @param {string[]} entries
 */
function prependPathEntries(entries) {
  const cleanEntries = entries.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  if (cleanEntries.length === 0) {
    return String(process.env.PATH ?? '');
  }
  return [...cleanEntries, String(process.env.PATH ?? '')].filter(Boolean).join(delimiter);
}

const DEFAULT_INSTALLERS_SMOKE_LIFECYCLE_STEP_TIMEOUT_MS = 300_000;
const WIN32_LOCAL_BUILD_INSTALL_TIMEOUT_MS = 600_000;

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   platform?: 'linux' | 'darwin' | 'win32';
 *   sourceKind?: string;
 *   step?: string;
 * }} params
 */
export function resolveInstallersSmokeLifecycleStepTimeoutMs({
  env = {},
  platform,
  sourceKind,
  step,
}) {
  const raw = String(env.HAPPIER_INSTALLERS_SMOKE_STEP_TIMEOUT_MS ?? '').trim();
  if (!raw) {
    if (platform === 'win32' && sourceKind === 'local-build' && step === 'install') {
      return WIN32_LOCAL_BUILD_INSTALL_TIMEOUT_MS;
    }
    return DEFAULT_INSTALLERS_SMOKE_LIFECYCLE_STEP_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_INSTALLERS_SMOKE_LIFECYCLE_STEP_TIMEOUT_MS;
  return Math.min(1_800_000, Math.max(30_000, parsed));
}

/**
 * @param {{
 *   repoRoot: string;
 *   platform: 'linux' | 'darwin' | 'win32';
 *   source: { kind: string; ref: string } | null;
 *   releaseChannel?: string;
 * }} params
 */
export async function runInstallersSmokeValidation({ repoRoot, platform, source, releaseChannel }) {
  assertNativePlatform(platform);

  const plan = resolveInstallersSmokePlan({ platform, source, releaseChannel });
  const token = String(process.env.GITHUB_TOKEN ?? process.env.HAPPIER_GITHUB_TOKEN ?? '').trim() || undefined;
  if (plan.tag) {
    const repoSlug = String(process.env.GITHUB_REPOSITORY ?? '').trim();
    if (!repoSlug) {
      throw new Error('GITHUB_REPOSITORY is required for published installers-smoke validation');
    }
    const tagExists = await checkGitHubReleaseTagExists({ tag: plan.tag, repoSlug, token });
    if (!tagExists) {
      const skipped = {
        ok: true,
        skipped: true,
        reason: `release tag not found: ${plan.tag}`,
        tag: plan.tag,
        installer: plan.installer,
      };
      console.log(JSON.stringify(skipped, null, 2));
      return skipped;
    }
  }

  const scratch = await mkdtemp(join(tmpdir(), 'happier-installers-smoke-'));
  const installDir = join(scratch, '.happier');
  const requestedBinDir = join(scratch, '.local', 'bin');
  const installerSourcePath = resolve(repoRoot, 'apps', 'website', 'public', plan.installer);
  const installerScratchPath = join(scratch, plan.installer);
  await copyFile(installerSourcePath, installerScratchPath);

  const localBuildAssets = source?.kind === 'local-build'
    ? await prepareInstallersSmokeLocalBuildAssets({
        repoRoot,
        platform,
        releaseChannel: plan.releaseChannel,
      })
    : null;

  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    HAPPIER_GITHUB_TOKEN: token ?? process.env.HAPPIER_GITHUB_TOKEN ?? '',
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: requestedBinDir,
    HAPPIER_CHANNEL: plan.releaseChannel === 'publicdev' ? 'dev' : plan.releaseChannel,
    ...plan.installerEnv,
  };
  if (localBuildAssets) {
    env.HAPPIER_RELEASE_ASSETS_DIR = localBuildAssets.assetsDir;
    env.HAPPIER_MINISIGN_PUBKEY = localBuildAssets.publicKey;
    if (localBuildAssets.installVersion) {
      env.HAPPIER_INSTALL_VERSION = localBuildAssets.installVersion;
    }
    env.PATH = prependPathEntries(localBuildAssets.envPathEntries);
  }

  const lifecycleSteps = resolveInstallersSmokeLifecycleSteps({ platform });

  /**
   * @param {string[]} args
   */
  function runInstaller(args = [], timeoutMs) {
    if (platform === 'win32') {
      execFileSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installerScratchPath, ...args], {
        cwd: repoRoot,
        env,
        stdio: 'inherit',
        timeout: timeoutMs,
      });
      return;
    }

    execFileSync('bash', [installerScratchPath, ...args], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
      timeout: timeoutMs,
    });
  }

  if (platform === 'win32') {
    env.HAPPIER_NO_PATH_UPDATE = env.HAPPIER_NO_PATH_UPDATE ?? '1';
  } else {
    env.HOME = scratch;
    env.HAPPIER_NO_PATH_UPDATE = env.HAPPIER_NO_PATH_UPDATE ?? '1';
    await chmod(installerScratchPath, 0o755);
  }

  const binaryPath = resolveInstallersSmokeBinaryPath({
    platform,
    installDir,
    requestedBinDir,
    binaryName: plan.binaryName,
  });

  try {
    for (const step of lifecycleSteps) {
      const stepTimeoutMs = resolveInstallersSmokeLifecycleStepTimeoutMs({
        env,
        platform,
        sourceKind: source?.kind,
        step,
      });
      if (step === 'install') {
        console.log(`[installers-smoke] step start: ${step} (timeout=${stepTimeoutMs}ms)`);
        runInstaller([], stepTimeoutMs);
        console.log(`[installers-smoke] step done: ${step}`);
        continue;
      }
      if (step === 'check') {
        console.log(`[installers-smoke] step start: ${step} (timeout=${stepTimeoutMs}ms)`);
        runInstaller(['--check'], stepTimeoutMs);
        console.log(`[installers-smoke] step done: ${step}`);
        continue;
      }
      if (step === 'reinstall') {
        console.log(`[installers-smoke] step start: ${step} (timeout=${stepTimeoutMs}ms)`);
        runInstaller(['--reinstall'], stepTimeoutMs);
        console.log(`[installers-smoke] step done: ${step}`);
        continue;
      }
      if (step === 'uninstall') {
        console.log(`[installers-smoke] step start: ${step} (timeout=${stepTimeoutMs}ms)`);
        runInstaller(['--uninstall'], stepTimeoutMs);
        console.log(`[installers-smoke] step done: ${step}`);
        continue;
      }
      if (step === 'version') {
        console.log(`[installers-smoke] step start: ${step} (timeout=${stepTimeoutMs}ms)`);
        execFileSync(binaryPath, ['--version'], {
          cwd: repoRoot,
          env,
          stdio: 'inherit',
          timeout: stepTimeoutMs,
        });
        console.log(`[installers-smoke] step done: ${step}`);
        continue;
      }
      if (step === 'help') {
        console.log(`[installers-smoke] step start: ${step} (timeout=${stepTimeoutMs}ms)`);
        execFileSync(binaryPath, ['--help'], {
          cwd: repoRoot,
          env,
          stdio: 'ignore',
          timeout: stepTimeoutMs,
        });
        console.log(`[installers-smoke] step done: ${step}`);
        continue;
      }
      throw new Error(`Unsupported installers-smoke lifecycle step: ${step}`);
    }

    if (lifecycleSteps.includes('uninstall')) {
      await access(binaryPath)
        .then(() => {
          throw new Error(`installers-smoke expected uninstall to remove ${binaryPath}`);
        })
        .catch((error) => {
          if (/** @type {{ code?: string }} */ (error).code !== 'ENOENT') {
            throw error;
          }
        });
    }

    const result = {
      ok: true,
      skipped: false,
      tag: plan.tag,
      installer: plan.installer,
      binaryPath,
      lifecycleSteps,
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await localBuildAssets?.cleanup();
  }
}
