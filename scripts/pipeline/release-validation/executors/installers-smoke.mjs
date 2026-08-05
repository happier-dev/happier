// @ts-check

import { access, chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { delimiter, join, resolve, win32 as pathWin32 } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';

import {
  resolvePublishedInstallerAsset,
  resolvePublishedInstallerAssetForTag,
  resolvePublishedInstallerChannelForTag,
} from '../../release/installers/catalog.mjs';
import { normalizePublicReleaseChannel } from '../../release/lib/public-release-rings.mjs';
import { prepareInstallersSmokeCandidateAssets } from './installers-smoke-local-build.mjs';

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
  if (source.kind === 'local-build' && localBuildChannel !== 'publicdev') {
    throw new Error('installers-smoke exact local candidate requires --release-channel dev');
  }
  const { tag, installer } = resolved;
  return {
    platform,
    tag,
    installer,
    binaryName: resolveCliSmokeBinaryName(platform, installer),
    releaseChannel: /** @type {'stable' | 'preview' | 'publicdev'} */ (localBuildChannel),
    ...(source.kind === 'local-build'
      ? { candidateManifestPath: source.ref }
      : {}),
    installerEnv: {
      HAPPIER_WITH_DAEMON: '0',
    },
  };
}

/**
 * @param {{
 *   platform: 'linux' | 'darwin' | 'win32';
 *   source: { kind: string; ref: string } | null;
 *   update?: {
 *     from: { kind: string; ref: string };
 *     to: { kind: string; ref: string };
 *   } | null;
 *   releaseChannel?: string;
 *   payloadPublicationAdmission?: {
 *     status?: string;
 *     exactPayloadReversionAllowed?: boolean;
 *   };
 * }} params
 */
export function resolveInstallersSmokeExecution({
  platform,
  source,
  update = null,
  releaseChannel,
  payloadPublicationAdmission,
}) {
  return {
    type: 'installers-smoke',
    plan: update
      ? resolveInstallersSmokeUpdatePlan({
          platform,
          update,
          releaseChannel,
          payloadPublicationAdmission,
        })
      : resolveInstallersSmokePlan({ platform, source, releaseChannel }),
  };
}

/**
 * @param {{ platform: 'linux' | 'darwin' | 'win32' }} params
 */
export function resolveInstallersSmokeLifecycleSteps({ platform }) {
  if (platform === 'win32') {
    return ['install', 'version', 'help', 'reinstall'];
  }
  return [
    'install',
    'version',
    'help',
    'check',
    'reinstall',
    'check',
    'uninstall',
  ];
}

/**
 * @param {{ platform: 'linux' | 'darwin' | 'win32' }} params
 */
export function resolveInstallersSmokeUpdateLifecycleSteps({ platform }) {
  const common = [
    'predecessor-install',
    'predecessor-version',
    'candidate-update',
    'candidate-version',
    'previous-payload-reversion',
    'previous-payload-version',
    'candidate-reinstall',
    'candidate-version',
  ];
  return platform === 'win32'
    ? common
    : [...common, 'check', 'uninstall'];
}

/**
 * @param {{
 *   platform: 'linux' | 'darwin' | 'win32';
 *   update: {
 *     from: { kind: string; ref: string };
 *     to: { kind: string; ref: string };
 *   };
 *   releaseChannel?: string;
 *   payloadPublicationAdmission?: {
 *     status?: string;
 *     exactPayloadReversionAllowed?: boolean;
 *   };
 * }} params
 */
export function resolveInstallersSmokeUpdatePlan({
  platform,
  update,
  releaseChannel,
  payloadPublicationAdmission,
}) {
  if (
    payloadPublicationAdmission?.status !== 'pre-activation'
    || payloadPublicationAdmission?.exactPayloadReversionAllowed !== true
  ) {
    throw new Error(
      'installers-smoke may schedule pre-activation exact-payload reversion only; ' +
      'old-server, old-daemon, and loaded-runtime rollback are never scheduled',
    );
  }
  const predecessorChannel = update?.from?.kind === 'published-channel'
    ? normalizePublicReleaseChannel(update.from.ref)
    : null;
  if (
    update?.from?.kind !== 'published-channel'
    || predecessorChannel !== 'publicdev'
    || update?.to?.kind !== 'local-build'
  ) {
    throw new Error(
      'installers-smoke update payload reversion requires a published-channel dev predecessor and exact local candidate',
    );
  }
  return {
    mode: 'update-payload-reversion',
    from: resolveInstallersSmokePlan({
      platform,
      source: { ...update.from, ref: predecessorChannel },
    }),
    to: resolveInstallersSmokePlan({
      platform,
      source: update.to,
      releaseChannel,
    }),
    lifecycleSteps: resolveInstallersSmokeUpdateLifecycleSteps({ platform }),
  };
}

/**
 * @param {{
 *   baseEnv: NodeJS.ProcessEnv;
 *   platform: 'linux' | 'darwin' | 'win32';
 *   step: string;
 * }} params
 */
export function resolveInstallersSmokeStepEnv({ baseEnv, platform, step }) {
  if (step === 'previous-payload-reversion') {
    return {
      ...baseEnv,
      HAPPIER_INSTALLER_ACTION: 'payload-reversion',
    };
  }
  if (
    platform === 'win32'
    && (step === 'reinstall' || step === 'candidate-reinstall')
  ) {
    return {
      ...baseEnv,
      HAPPIER_INSTALLER_ACTION: 'reinstall',
    };
  }
  return baseEnv;
}

/**
 * @param {{
 *   candidateEnv: NodeJS.ProcessEnv;
 *   predecessorPlan: {
 *     releaseChannel: 'stable' | 'preview' | 'publicdev';
 *     installerEnv: NodeJS.ProcessEnv;
 *   };
 * }} params
 */
export function resolveInstallersSmokePredecessorEnv({
  candidateEnv,
  predecessorPlan,
}) {
  const predecessorEnv = {
    ...candidateEnv,
    HAPPIER_CHANNEL: predecessorPlan.releaseChannel === 'publicdev'
      ? 'dev'
      : predecessorPlan.releaseChannel,
    ...predecessorPlan.installerEnv,
  };
  delete predecessorEnv.HAPPIER_RELEASE_ASSETS_DIR;
  delete predecessorEnv.HAPPIER_MINISIGN_PUBKEY;
  delete predecessorEnv.HAPPIER_INSTALL_VERSION;
  return predecessorEnv;
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
 * @param {{
 *   installerPath: string;
 *   installerArgs?: string[];
 *   env?: NodeJS.ProcessEnv;
 *   commandResolver?: (command: string) => string | null;
 * }} params
 */
export function resolveInstallersSmokePowerShellInvocation({
  installerPath,
  installerArgs = [],
  env = process.env,
  commandResolver = (command) => resolveWindowsCommandOnPath(command, env),
}) {
  let command = null;
  for (const candidate of ['pwsh.exe', 'powershell.exe']) {
    command = commandResolver(candidate);
    if (command) break;
  }
  if (!command) {
    throw new Error('installers-smoke requires PowerShell (pwsh or Windows PowerShell powershell.exe)');
  }
  return {
    command,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installerPath, ...installerArgs],
  };
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
export async function runInstallersSmokeValidation({
  repoRoot,
  platform,
  source,
  update = null,
  releaseChannel,
  payloadPublicationAdmission,
}) {
  assertNativePlatform(platform);

  const updatePlan = update
    ? resolveInstallersSmokeUpdatePlan({
        platform,
        update,
        releaseChannel,
        payloadPublicationAdmission,
      })
    : null;
  const plan = updatePlan?.to
    ?? resolveInstallersSmokePlan({ platform, source, releaseChannel });
  const predecessorPlan = updatePlan?.from ?? null;
  const token = String(process.env.GITHUB_TOKEN ?? process.env.HAPPIER_GITHUB_TOKEN ?? '').trim() || undefined;
  for (const taggedPlan of [predecessorPlan, plan].filter((candidate) => candidate?.tag)) {
    const repoSlug = String(process.env.GITHUB_REPOSITORY ?? '').trim();
    if (!repoSlug) {
      throw new Error('GITHUB_REPOSITORY is required for published installers-smoke validation');
    }
    const tagExists = await checkGitHubReleaseTagExists({
      tag: taggedPlan.tag,
      repoSlug,
      token,
    });
    if (!tagExists) {
      const skipped = {
        ok: true,
        skipped: true,
        reason: `release tag not found: ${taggedPlan.tag}`,
        tag: taggedPlan.tag,
        installer: taggedPlan.installer,
      };
      console.log(JSON.stringify(skipped, null, 2));
      return skipped;
    }
  }

  const scratch = await mkdtemp(join(tmpdir(), 'happier-installers-smoke-'));
  const installDir = join(scratch, '.happier');
  const requestedBinDir = join(scratch, '.local', 'bin');
  const candidateSource = update?.to ?? source;
  let localBuildAssets = null;
  try {
    localBuildAssets = candidateSource?.kind === 'local-build'
      ? await prepareInstallersSmokeCandidateAssets({
          repoRoot,
          platform,
          candidateManifestPath: candidateSource.ref,
        })
      : null;
  const installerSourcePath = localBuildAssets?.installerPath
    ?? resolve(repoRoot, 'apps', 'website', 'public', plan.installer);
  const installerScratchPath = join(scratch, `candidate-${plan.installer}`);
  await copyFile(installerSourcePath, installerScratchPath);
  const predecessorInstallerScratchPath = predecessorPlan
    ? join(scratch, `predecessor-${predecessorPlan.installer}`)
    : null;
  if (predecessorPlan && predecessorInstallerScratchPath) {
    await copyFile(
      resolve(repoRoot, 'apps', 'website', 'public', predecessorPlan.installer),
      predecessorInstallerScratchPath,
    );
  }

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
  const lifecycleSteps = updatePlan?.lifecycleSteps
    ?? resolveInstallersSmokeLifecycleSteps({ platform });

  /**
   * @param {string} selectedInstallerPath
   * @param {string[]} args
   * @param {number} timeoutMs
   * @param {NodeJS.ProcessEnv} [stepEnv]
   */
  function runInstaller(selectedInstallerPath, args = [], timeoutMs, stepEnv = env) {
    if (platform === 'win32') {
      const invocation = resolveInstallersSmokePowerShellInvocation({
        installerPath: selectedInstallerPath,
        installerArgs: args,
        env: stepEnv,
      });
      execFileSync(invocation.command, invocation.args, {
        cwd: repoRoot,
        env: stepEnv,
        stdio: 'inherit',
        timeout: timeoutMs,
      });
      return;
    }

    execFileSync('bash', [selectedInstallerPath, ...args], {
      cwd: repoRoot,
      env: stepEnv,
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
    if (predecessorInstallerScratchPath) {
      await chmod(predecessorInstallerScratchPath, 0o755);
    }
  }
  const predecessorEnv = predecessorPlan
    ? resolveInstallersSmokePredecessorEnv({
        candidateEnv: env,
        predecessorPlan,
      })
    : null;

  const binaryPath = resolveInstallersSmokeBinaryPath({
    platform,
    installDir,
    requestedBinDir,
    binaryName: plan.binaryName,
  });

    if (updatePlan) {
      if (!predecessorInstallerScratchPath || !predecessorEnv) {
        throw new Error('installers-smoke update predecessor was not prepared');
      }
      const stepTimeout = (step, sourceKind) => resolveInstallersSmokeLifecycleStepTimeoutMs({
        env,
        platform,
        sourceKind,
        step,
      });
      const readInstalledVersion = (step, stepEnv) => {
        const timeoutMs = stepTimeout(step, 'local-build');
        const output = execFileSync(binaryPath, ['--version'], {
          cwd: repoRoot,
          env: stepEnv,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
          timeout: timeoutMs,
        });
        return String(output ?? '').trim();
      };
      runInstaller(
        predecessorInstallerScratchPath,
        [],
        stepTimeout('predecessor-install', 'published-channel'),
        predecessorEnv,
      );
      const predecessorVersionOutput = readInstalledVersion(
        'predecessor-version',
        predecessorEnv,
      );
      runInstaller(
        installerScratchPath,
        [],
        stepTimeout('candidate-update', 'local-build'),
        env,
      );
      const candidateVersionOutput = readInstalledVersion('candidate-version', env);
      if (
        predecessorVersionOutput === candidateVersionOutput
        || !candidateVersionOutput.includes(String(localBuildAssets?.installVersion ?? ''))
      ) {
        throw new Error(
          'installers-smoke candidate update did not load the exact distinct candidate version',
        );
      }
      runInstaller(
        installerScratchPath,
        [],
        stepTimeout('previous-payload-reversion', 'local-build'),
        resolveInstallersSmokeStepEnv({
          baseEnv: env,
          platform,
          step: 'previous-payload-reversion',
        }),
      );
      const previousPayloadVersionOutput = readInstalledVersion(
        'previous-payload-version',
        env,
      );
      if (previousPayloadVersionOutput !== predecessorVersionOutput) {
        throw new Error(
          'installers-smoke payload reversion did not select the exact predecessor payload',
        );
      }
      runInstaller(
        installerScratchPath,
        platform === 'win32' ? [] : ['--reinstall'],
        stepTimeout('candidate-reinstall', 'local-build'),
        resolveInstallersSmokeStepEnv({
          baseEnv: env,
          platform,
          step: 'candidate-reinstall',
        }),
      );
      const reinstalledCandidateVersionOutput = readInstalledVersion(
        'candidate-version',
        env,
      );
      if (reinstalledCandidateVersionOutput !== candidateVersionOutput) {
        throw new Error(
          'installers-smoke candidate reinstall did not restore the exact candidate version',
        );
      }
      if (platform !== 'win32') {
        runInstaller(
          installerScratchPath,
          ['--check'],
          stepTimeout('check', 'local-build'),
          env,
        );
        runInstaller(
          installerScratchPath,
          ['--uninstall'],
          stepTimeout('uninstall', 'local-build'),
          env,
        );
      }
      const result = {
        ok: true,
        skipped: false,
        mode: 'update-payload-reversion',
        predecessorTag: predecessorPlan?.tag ?? null,
        candidateManifestPath: plan.candidateManifestPath,
        binaryPath,
        lifecycleSteps,
        versionEvidence: {
          predecessor: predecessorVersionOutput,
          candidate: candidateVersionOutput,
          previousPayload: previousPayloadVersionOutput,
          reinstalledCandidate: reinstalledCandidateVersionOutput,
        },
      };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }

    for (const step of lifecycleSteps) {
      const stepTimeoutMs = resolveInstallersSmokeLifecycleStepTimeoutMs({
        env,
        platform,
        sourceKind: source?.kind,
        step,
      });
      if (step === 'install') {
        console.log(`[installers-smoke] step start: ${step} (timeout=${stepTimeoutMs}ms)`);
        runInstaller(installerScratchPath, [], stepTimeoutMs);
        console.log(`[installers-smoke] step done: ${step}`);
        continue;
      }
      if (step === 'check') {
        console.log(`[installers-smoke] step start: ${step} (timeout=${stepTimeoutMs}ms)`);
        runInstaller(installerScratchPath, ['--check'], stepTimeoutMs);
        console.log(`[installers-smoke] step done: ${step}`);
        continue;
      }
      if (step === 'reinstall') {
        console.log(`[installers-smoke] step start: ${step} (timeout=${stepTimeoutMs}ms)`);
        runInstaller(
          installerScratchPath,
          platform === 'win32' ? [] : ['--reinstall'],
          stepTimeoutMs,
          resolveInstallersSmokeStepEnv({
            baseEnv: env,
            platform,
            step,
          }),
        );
        console.log(`[installers-smoke] step done: ${step}`);
        continue;
      }
      if (step === 'uninstall') {
        console.log(`[installers-smoke] step start: ${step} (timeout=${stepTimeoutMs}ms)`);
        runInstaller(installerScratchPath, ['--uninstall'], stepTimeoutMs);
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
    await Promise.allSettled([
      localBuildAssets?.cleanup(),
      rm(scratch, { recursive: true, force: true }),
    ]);
  }
}
