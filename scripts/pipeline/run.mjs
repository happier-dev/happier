// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { loadPipelineEnv } from './env/load-pipeline-env.mjs';
import { loadSecrets } from './secrets/load-secrets.mjs';
import { importDotenvIntoKeychainBundle } from './secrets/import-keychain-bundle.mjs';
import { resolveKeychainBundleAccounts } from './secrets/keychain-bundle-accounts.mjs';
import { assertCleanWorktree } from './git/ensure-clean-worktree.mjs';
import { resolveAuthorizedReleaseSource } from './github/resolve-authorized-release-source.mjs';
import { resolveRemoteReleasePlanningRefs } from './release/lib/release-planning-remote-refs.mjs';
import { createAnsiStyle } from './cli/ansi-style.mjs';
import { renderCommandHelp, renderPipelineHelp } from './cli/help.mjs';
import { isDockerChannel } from './docker/docker-channels.mjs';
import {
  allowsBestEffortSubmit,
  formatMobileReleaseEnvironment,
  isMobileReleaseEnvironment,
  MOBILE_RELEASE_ENVIRONMENT_CHOICES,
  MOBILE_RELEASE_PROFILE_CHOICES,
  MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES,
  normalizeMobileReleaseEnvironment,
  normalizeMobileReleaseProfile,
  resolveMobileNativeArtifactRelativePath,
  resolveMobilePipelineDeployEnvironment,
  resolveMobileProfileInputPrefix,
  resolveMobileProfilePrefix,
  supportsMobileApkReleasePublishing,
  supportsMobileNativeSubmit,
} from './expo/mobile-release-environments.mjs';
import { resolveTestflightDistributionConfig } from './expo/testflight-distribution-config.mjs';
import {
  formatPublicReleaseChannel,
  formatPublicReleaseChannelChoices,
  normalizePublicReleaseChannel,
} from './release/lib/public-release-rings.mjs';
import { releaseTargets } from './release/component-registry.mjs';
import { buildPublicReleaseContractV1 } from './release/public-release-contract.mjs';
import { resolveReleaseEnvironmentChannel } from './release/resolve-release-environment-channel.mjs';
import {
  RELEASE_VALIDATION_PROFILE_IDS,
  resolveReleaseValidationProfile,
} from './release-validation/registry.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const ROLLING_RELEASE_CHANNEL_CHOICES = formatPublicReleaseChannelChoices();
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const RELEASE_OPERATION_ID = /^rel_[A-Za-z0-9_-]{8,80}$/;
const RELEASE_NOTES_ID = /^[a-z0-9][a-z0-9._-]*$/;
const TAURI_RELEASE_ENVIRONMENT_CHOICES = formatPublicReleaseChannelChoices({
  stableAlias: 'production',
  preferredOrder: ['dev', 'preview', 'stable'],
});

/**
 * @param {string[]} rawArgv
 */
function parseGlobalCliFlags(rawArgv) {
  /** @type {null | boolean} */
  let colorOverride = null;

  const argv = [];
  for (const arg of rawArgv) {
    if (arg === '--no-color') {
      colorOverride = false;
      continue;
    }
    if (arg === '--color') {
      colorOverride = true;
      continue;
    }
    argv.push(arg);
  }

  const envNoColor = typeof process.env.NO_COLOR === 'string' && process.env.NO_COLOR.length >= 0;
  const enabled =
    colorOverride === true ? true : colorOverride === false ? false : Boolean(process.stdout.isTTY) && !envNoColor;

  return { argv, style: createAnsiStyle({ enabled }) };
}

/**
 * @param {string} v
 * @returns {v is 'production' | 'preview'}
 */
function isDeployEnvironment(v) {
  return v === 'production' || v === 'preview';
}

/**
 * @param {string} v
 * @returns {v is 'dev' | 'production' | 'preview'}
 */
function isReleaseDeployEnvironment(v) {
  return v === 'dev' || v === 'production' || v === 'preview';
}

/**
 * @param {string} action
 * @returns {'dev' | 'preview'}
 */
function resolveReleasePromotionSourceBranch(action) {
  return action === 'release preview to main' || action === 'reset main from preview' ? 'preview' : 'dev';
}

function normalizeTauriReleaseEnvironment(raw) {
  const channel = normalizePublicReleaseChannel(raw);
  if (!channel) return '';
  return channel === 'stable' ? 'production' : channel;
}

/**
 * @param {string} v
 * @returns {v is 'ui' | 'server' | 'website' | 'docs'}
 */
function isDeployComponent(v) {
  return v === 'ui' || v === 'server' || v === 'website' || v === 'docs';
}

/**
 * @param {string} v
 * @returns {v is 'ui' | 'server' | 'website' | 'docs' | 'cli' | 'stack' | 'server_runner'}
 */
function isReleaseTarget(v) {
  return releaseTargets.includes(v);
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function parseCsvList(value) {
  return String(value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBoolString(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

/**
 * @param {string} value
 * @returns {value is import('./expo/mobile-release-environments.mjs').MobileReleaseEnvironment}
 */
function isUiMobileReleaseEnvironment(value) {
  return isMobileReleaseEnvironment(value);
}

/**
 * @param {import('./expo/mobile-release-environments.mjs').MobileReleaseEnvironment} environment
 * @returns {'preview' | 'production'}
 */
function resolveUiMobilePipelineEnvironment(environment) {
  return resolveMobilePipelineDeployEnvironment(environment);
}

/**
 * @param {import('./expo/mobile-release-environments.mjs').MobileReleaseEnvironment} environment
 * @returns {string}
 */
function resolveUiMobileProfilePrefix(environment) {
  return resolveMobileProfilePrefix(environment);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {'auto' | 'prompt' | boolean}
 */
function parseCleanupMode(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto') return 'auto';
  if (raw === 'prompt') return 'prompt';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'auto', 'prompt', 'true' or 'false' (got: ${value})`);
}

/**
 * @param {{ repoRoot: string; filePaths: string[] }} opts
 * @returns {{ candidatesAbs: string[]; skippedUnsafe: string[] }}
 */
function resolveEnvCleanupCandidates(opts) {
  const repoRoot = path.resolve(String(opts.repoRoot ?? ''));
  const allowedBasenames = new Set([
    '.env.pipeline.local',
    '.env.pipeline.preview.local',
    '.env.pipeline.production.local',
  ]);

  /** @type {string[]} */
  const candidatesAbs = [];
  /** @type {string[]} */
  const skippedUnsafe = [];

  for (const input of opts.filePaths ?? []) {
    const raw = String(input ?? '').trim();
    if (!raw) continue;

    const abs = path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
    const base = path.basename(abs);
    if (!allowedBasenames.has(base)) {
      skippedUnsafe.push(raw);
      continue;
    }
    if (!fs.existsSync(abs)) continue;
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile() && !st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    if (!candidatesAbs.includes(abs)) candidatesAbs.push(abs);
  }

  return { candidatesAbs, skippedUnsafe };
}

/**
 * Local operator escape hatch: when `--allow-dirty true` is used, we still require
 * a clean index so pipeline-driven commits can't accidentally include staged changes.
 *
 * @param {{ cwd: string; allowDirty: boolean; dryRun: boolean }} opts
 */
function assertNoStagedChanges(opts) {
  if (opts.dryRun) return;
  if (!opts.allowDirty) return;

  const raw = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: opts.cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim();
  if (!raw) return;

  throw new Error(
    [
      'git index has staged changes; refusing to run release steps that may create commits.',
      'Fix: unstage changes or commit them separately before running the release pipeline.',
      '',
      raw
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => `- ${p}`)
        .join('\n'),
    ].join('\n'),
  );
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {boolean} autoValue
 */
function resolveAutoBool(value, name, autoValue) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto') return autoValue;
  return parseBoolString(raw, name);
}

/**
 * Split wrapper flags (owned by run.mjs) from passthrough args for wrapped scripts.
 * We intentionally avoid node:util parseArgs here because with strict=false it treats unknown flags as booleans,
 * consuming their values and breaking passthrough (e.g. `--channel preview` becomes `channel=true` + positional `preview`).
 *
 * @param {string[]} argv
 * @returns {{
 *   deployEnvironment: 'dev' | 'production' | 'preview';
 *   dryRun: boolean;
 *   secretsSource: 'auto' | 'env' | 'keychain';
 *   keychainService: string;
 *   keychainAccount: string;
 *   passthrough: string[];
 * }}
 */
function splitWrappedReleaseArgs(argv) {
  /** @type {'dev' | 'production' | 'preview'} */
  let deployEnvironment = 'production';
  let dryRun = false;
  /** @type {'auto' | 'env' | 'keychain'} */
  let secretsSource = 'auto';
  let keychainService = 'happier/pipeline';
  let keychainAccount = '';

  /** @type {string[]} */
  const passthrough = [];

  const takeValue = (arg, i) => {
    if (arg.includes('=')) {
      const idx = arg.indexOf('=');
      return { value: arg.slice(idx + 1), nextIndex: i };
    }
    const next = argv[i + 1];
    if (next == null) {
      fail(`Missing value for ${arg}`);
    }
    return { value: next, nextIndex: i + 1 };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? '');

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg.startsWith('--dry-run=')) {
      const { value } = takeValue(arg, i);
      dryRun = parseBoolString(value, '--dry-run');
      continue;
    }

    if (arg === '--deploy-environment' || arg.startsWith('--deploy-environment=')) {
      const { value, nextIndex } = takeValue(arg, i);
      i = nextIndex;
      const v = String(value ?? '').trim();
      if (!isReleaseDeployEnvironment(v)) {
        fail(`--deploy-environment must be 'dev', 'production', or 'preview' (got: ${v || '<empty>'})`);
      }
      deployEnvironment = v;
      continue;
    }

    if (arg === '--secrets-source' || arg.startsWith('--secrets-source=')) {
      const { value, nextIndex } = takeValue(arg, i);
      i = nextIndex;
      const raw = String(value ?? '').trim();
      if (raw === 'auto' || raw === 'env' || raw === 'keychain') {
        secretsSource = raw;
        continue;
      }
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${raw})`);
    }

    if (arg === '--keychain-service' || arg.startsWith('--keychain-service=')) {
      const { value, nextIndex } = takeValue(arg, i);
      i = nextIndex;
      keychainService = String(value ?? '').trim() || 'happier/pipeline';
      continue;
    }

    if (arg === '--keychain-account' || arg.startsWith('--keychain-account=')) {
      const { value, nextIndex } = takeValue(arg, i);
      i = nextIndex;
      keychainAccount = String(value ?? '').trim();
      continue;
    }

    passthrough.push(arg);
  }

  return { deployEnvironment, dryRun, secretsSource, keychainService, keychainAccount, passthrough };
}

function repoRootFromHere() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runDeployWebhooks({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'deploy', 'trigger-webhooks.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runNpmPublishTarball({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runNpmReleasePackages({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'npm', 'release-packages.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runNpmSetPreviewVersions({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'npm', 'set-preview-versions.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runPublishUiWeb({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'release', 'publish-ui-web.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runPublishCliBinaries({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'release', 'publish-cli-binaries.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runPublishHstackBinaries({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'release', 'publish-hstack-binaries.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runChecksPlan({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'checks', 'resolve-checks-plan.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runChecks({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'checks', 'run-checks.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runSmokeCli({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'smoke', 'cli-smoke.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runPublishServerRuntime({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'release', 'publish-server-runtime.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runReleaseResolveBumpPlan({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runReleaseBumpVersionsDev({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'release', 'bump-versions-dev.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runExpoOtaUpdate({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'ota-update.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runExpoNativeBuild({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'native-build.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runExpoSubmit({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'submit.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runExpoDownloadAndroidApk({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'download-android-apk.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runExpoMobileReleaseMeta({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'mobile-release-meta.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runExpoPublishApkRelease({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'publish-apk-release.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runExpoTestflightDistribute({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'testflight-distribute.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runExpoBumpUiVersion({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'bump-ui-version.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runTauriPreparePublishAssets({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'tauri', 'prepare-publish-assets.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runTauriValidateUpdaterPubkey({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'tauri', 'validate-updater-pubkey.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runTauriBuildUpdaterArtifacts({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'tauri', 'build-updater-artifacts.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runTauriBundleCandidate({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'tauri', 'bundle-candidate.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  execFileSync(process.execPath, fullArgs, { cwd: repoRoot, env, stdio: 'inherit' });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runTauriNotarizeMacosArtifacts({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'tauri', 'notarize-macos-artifacts.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runTauriCollectUpdaterArtifacts({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'tauri', 'collect-updater-artifacts.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runTauriSignUpdaterArtifacts({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'tauri', 'sign-updater-artifacts.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  execFileSync(process.execPath, fullArgs, { cwd: repoRoot, env, stdio: 'inherit' });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runTestingCreateAuthCredentials({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'testing', 'create-auth-credentials.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
    return;
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runDockerPublishImages({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'docker', 'publish-images.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runGithubPublishRelease({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'github', 'publish-release.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runGithubAuditReleaseAssets({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'github', 'audit-release-assets.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runGithubCommitAndPush({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'github', 'commit-and-push.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runGithubPromoteBranch({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'github', 'promote-branch.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; args: string[]; dryRun: boolean }} opts
 */
function runGithubPromoteDeployBranch({ repoRoot, env, args, dryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'github', 'promote-deploy-branch.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{
 *   repoRoot: string;
 *   env: Record<string, string>;
 *   scriptFile: string;
 *   args: string[];
 *   dryRun: boolean;
 *   skipExecOnDryRun?: boolean;
 * }} opts
 */
function runReleaseWrappedScript({ repoRoot, env, scriptFile, args, dryRun, skipExecOnDryRun }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'release', scriptFile);
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
    if (skipExecOnDryRun) return;
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env?: Record<string, string>; args: string[]; dryRun: boolean; skipExecOnDryRun?: boolean }} opts
 */
function runReleaseValidate({ repoRoot, env, args, dryRun, skipExecOnDryRun = false }) {
  const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'release-validation', 'validate-release.mjs');
  const fullArgs = [scriptPath, ...args];
  if (dryRun) {
    console.log(`[pipeline] exec: node ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);
    if (skipExecOnDryRun) {
      return;
    }
  }
  execFileSync(process.execPath, fullArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

/**
 * @param {{ repoRoot: string; env: Record<string, string>; scriptRel: string; args: string[] }} opts
 */
function runJsonScript({ repoRoot, env, scriptRel, args }) {
  const out = execFileSync(process.execPath, [path.join(repoRoot, scriptRel), ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).trim();

  try {
    return out ? JSON.parse(out) : {};
  } catch (err) {
    throw new Error(
      [
        `Expected JSON output from: node ${scriptRel} ${args.map((a) => JSON.stringify(a)).join(' ')}`,
        '',
        String(err),
        '',
        'Raw:',
        out,
      ].join('\n'),
    );
  }
}

  async function main() {
  const repoRoot = repoRootFromHere();

  const { argv, style } = parseGlobalCliFlags(process.argv.slice(2));
  const [subcommandRaw, ...rest] = argv;
  const subcommand = String(subcommandRaw ?? '').trim();

  const wantsGlobalHelp = subcommand === '--help' || subcommand === '-h' || subcommand === 'help';
  if (wantsGlobalHelp) {
    const target = subcommand === 'help' ? String(rest[0] ?? '').trim() : '';
    const out = target ? renderCommandHelp({ style, command: target, cliRelPath: 'scripts/pipeline/run.mjs' }) : renderPipelineHelp({ style, cliRelPath: 'scripts/pipeline/run.mjs' });
    process.stdout.write(out);
    process.exit(0);
  }

  const wantsCommandHelp = rest.includes('--help') || rest.includes('-h');
  if (subcommand && wantsCommandHelp) {
    const out = renderCommandHelp({ style, command: subcommand, cliRelPath: 'scripts/pipeline/run.mjs' });
    process.stdout.write(out);
    process.exit(0);
  }

  if (!subcommand) {
    fail(
      [
        'Missing command.',
        '',
        'Run:',
        '  node scripts/pipeline/run.mjs --help',
      ].join('\n'),
    );
  }

        if (
            subcommand !== 'deploy' &&
          subcommand !== 'npm-publish' &&
            subcommand !== 'npm-release' &&
          subcommand !== 'npm-set-preview-versions' &&
          subcommand !== 'publish-ui-web' &&
          subcommand !== 'publish-cli-binaries' &&
          subcommand !== 'publish-hstack-binaries' &&
            subcommand !== 'publish-server-runtime' &&
          subcommand !== 'checks-plan' &&
          subcommand !== 'checks' &&
          subcommand !== 'smoke-cli' &&
            subcommand !== 'release-bump-plan' &&
            subcommand !== 'release-bump-versions-dev' &&
            subcommand !== 'release-sync-installers' &&
          subcommand !== 'release-bump-version' &&
          subcommand !== 'release-build-cli-binaries' &&
        subcommand !== 'release-build-hstack-binaries' &&
        subcommand !== 'release-build-server-binaries' &&
        subcommand !== 'release-prepare-binary-assets' &&
        subcommand !== 'release-publish-manifests' &&
        subcommand !== 'release-contract' &&
        subcommand !== 'release-validate' &&
        subcommand !== 'release-verify-artifacts' &&
        subcommand !== 'release-analyze' &&
        subcommand !== 'release-local-candidates' &&
        subcommand !== 'release-compute-changed-components' &&
        subcommand !== 'release-compute-versioned-component-changes' &&
        subcommand !== 'release-resolve-bump-plan' &&
        subcommand !== 'release-compute-deploy-plan' &&
        subcommand !== 'release-build-ui-web-bundle' &&
        subcommand !== 'expo-ota' &&
        subcommand !== 'expo-native-build' &&
        subcommand !== 'expo-download-apk' &&
      subcommand !== 'expo-mobile-meta' &&
      subcommand !== 'expo-submit' &&
      subcommand !== 'expo-publish-apk-release' &&
      subcommand !== 'expo-testflight-distribute' &&
      subcommand !== 'ui-mobile-release' &&
      subcommand !== 'tauri-prepare-assets' &&
      subcommand !== 'tauri-validate-updater-pubkey' &&
      subcommand !== 'tauri-build-updater-artifacts' &&
      subcommand !== 'tauri-bundle-candidate' &&
      subcommand !== 'tauri-notarize-macos-artifacts' &&
      subcommand !== 'tauri-collect-updater-artifacts' &&
      subcommand !== 'tauri-sign-updater-artifacts' &&
      subcommand !== 'testing-create-auth-credentials' &&
      subcommand !== 'secrets-import' &&
        subcommand !== 'docker-publish' &&
        subcommand !== 'github-publish-release' &&
        subcommand !== 'github-audit-release-assets' &&
        subcommand !== 'github-commit-and-push' &&
        subcommand !== 'promote-branch' &&
          subcommand !== 'promote-deploy-branch' &&
          subcommand !== 'release'
        ) {
            fail(
              [
                `Unsupported subcommand: ${subcommand}`,
                '',
                'Run:',
                '  node scripts/pipeline/run.mjs --help',
              ].join('\n'),
            );
          }

        if (subcommand === 'release-contract') {
          parseArgs({ args: rest, options: {}, allowPositionals: false });
          process.stdout.write(`${JSON.stringify(buildPublicReleaseContractV1())}\n`);
          return;
        }

        if (subcommand === 'smoke-cli') {
          const { values } = parseArgs({
            args: rest,
            options: {
          'package-dir': { type: 'string', default: 'apps/cli' },
          'workspace-name': { type: 'string', default: '@happier-dev/cli' },
          'skip-build': { type: 'string', default: 'false' },
          'dry-run': { type: 'boolean', default: false },
        },
        allowPositionals: false,
      });

      const pkgDir = String(values['package-dir'] ?? '').trim() || 'apps/cli';
      const workspaceName = String(values['workspace-name'] ?? '').trim() || '@happier-dev/cli';
      const skipBuild = String(values['skip-build'] ?? '').trim() || 'false';
      const dryRun = values['dry-run'] === true;

      runSmokeCli({
        repoRoot,
        env: { ...process.env },
        dryRun,
        args: [
          '--package-dir',
          pkgDir,
          '--workspace-name',
          workspaceName,
          '--skip-build',
          skipBuild,
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });
      return;
    }

    if (subcommand === 'checks-plan') {
      const { values } = parseArgs({
        args: rest,
        options: {
          profile: { type: 'string' },
          'custom-checks': { type: 'string', default: '' },
          'github-output': { type: 'string', default: '' },
          'dry-run': { type: 'boolean', default: false },
        },
        allowPositionals: false,
      });

      const profile = String(values.profile ?? '').trim();
      if (!profile) fail('--profile is required (full|fast|none|custom|release-assets)');
      const customChecks = String(values['custom-checks'] ?? '').trim();
      const githubOutput = String(values['github-output'] ?? '').trim();
      const dryRun = values['dry-run'] === true;

      runChecksPlan({
        repoRoot,
        env: { ...process.env },
        dryRun,
        args: [
          '--profile',
          profile,
          ...(customChecks ? ['--custom-checks', customChecks] : []),
          ...(githubOutput ? ['--github-output', githubOutput] : []),
        ],
      });
      return;
    }

    if (subcommand === 'checks') {
      const { values } = parseArgs({
        args: rest,
        options: {
          profile: { type: 'string' },
          'custom-checks': { type: 'string', default: '' },
          'install-deps': { type: 'string', default: 'auto' },
          'dry-run': { type: 'boolean', default: false },
        },
        allowPositionals: false,
      });

      const profile = String(values.profile ?? '').trim();
      if (!profile) fail('--profile is required (full|fast|none|custom|release-assets)');
      const customChecks = String(values['custom-checks'] ?? '').trim();
      const installDeps = String(values['install-deps'] ?? '').trim();
      const dryRun = values['dry-run'] === true;

      runChecks({
        repoRoot,
        env: { ...process.env, HAPPIER_UI_VENDOR_WEB_ASSETS: process.env.HAPPIER_UI_VENDOR_WEB_ASSETS ?? '0' },
        dryRun,
        args: [
          '--profile',
          profile,
          ...(customChecks ? ['--custom-checks', customChecks] : []),
          '--install-deps',
          installDeps || 'auto',
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });
      return;
    }

    if (subcommand === 'deploy') {
      const { values } = parseArgs({
        args: rest,
        options: {
          'deploy-environment': { type: 'string', default: 'production' },
        component: { type: 'string' },
        repository: { type: 'string', default: '' },
        'ref-name': { type: 'string', default: '' },
        sha: { type: 'string', default: '' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const deployEnvironment = String(values['deploy-environment'] ?? '').trim();
    if (!isDeployEnvironment(deployEnvironment)) {
      fail(`--deploy-environment must be 'production' or 'preview' (got: ${deployEnvironment})`);
    }
    const component = String(values.component ?? '').trim();
    if (!isDeployComponent(component)) {
      fail(`--component must be 'ui', 'server', 'website', or 'docs' (got: ${component || '<empty>'})`);
    }

    const { env, sources } = loadPipelineEnv({ repoRoot, deployEnvironment });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
      const { env: mergedEnv, usedKeychain } = loadSecrets({
        baseEnv: env,
        secretsSource,
        keychainService,
        keychainAccount,
      });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

    const repository = String(values.repository ?? '').trim() || String(mergedEnv.GITHUB_REPOSITORY ?? '').trim();
    if (!repository) {
      fail('--repository is required (or set GITHUB_REPOSITORY in env).');
    }

    const refName = String(values['ref-name'] ?? '').trim() || `deploy/${deployEnvironment}/${component}`;
    const sha = String(values.sha ?? '').trim();
    const dryRun = values['dry-run'] === true;

    console.log(`[pipeline] deploy webhooks: env=${deployEnvironment} component=${component} ref=${refName}`);

    runDeployWebhooks({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--environment',
        deployEnvironment,
        '--component',
        component,
        '--repository',
        repository,
        '--ref-name',
        refName,
        ...(sha ? ['--sha', sha] : []),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });

    return;
  }

  if (subcommand === 'npm-set-preview-versions') {
    const { values } = parseArgs({
      args: rest,
      options: {
        'repo-root': { type: 'string', default: '' },
        'publish-cli': { type: 'string', default: 'false' },
        'publish-stack': { type: 'string', default: 'false' },
        'publish-server': { type: 'string', default: 'false' },
        'publish-support': { type: 'string', default: 'false' },
        'publish-plugin-sdk': { type: 'string', default: 'false' },
        'publish-sdk': { type: 'string', default: 'false' },
        'server-runner-dir': { type: 'string', default: 'packages/relay-server' },
        'cli-version': { type: 'string', default: '' },
        'stack-version': { type: 'string', default: '' },
        'server-version': { type: 'string', default: '' },
        'support-version': { type: 'string', default: '' },
        'plugin-sdk-version': { type: 'string', default: '' },
        'sdk-version': { type: 'string', default: '' },
        write: { type: 'string', default: 'true' },
      },
      allowPositionals: false,
    });

    const repoRootOverride = String(values['repo-root'] ?? '').trim();
    const publishCli = String(values['publish-cli'] ?? '').trim() || 'false';
    const publishStack = String(values['publish-stack'] ?? '').trim() || 'false';
    const publishServer = String(values['publish-server'] ?? '').trim() || 'false';
    const publishSupport = String(values['publish-support'] ?? '').trim() || 'false';
    const publishPluginSdk = String(values['publish-plugin-sdk'] ?? '').trim() || 'false';
    const publishSdk = String(values['publish-sdk'] ?? '').trim() || 'false';
    const serverRunnerDir = String(values['server-runner-dir'] ?? '').trim() || 'packages/relay-server';
    const cliVersion = String(values['cli-version'] ?? '').trim();
    const stackVersion = String(values['stack-version'] ?? '').trim();
    const serverVersion = String(values['server-version'] ?? '').trim();
    const supportVersion = String(values['support-version'] ?? '').trim();
    const pluginSdkVersion = String(values['plugin-sdk-version'] ?? '').trim();
    const sdkVersion = String(values['sdk-version'] ?? '').trim();
    const write = String(values.write ?? '').trim() || 'true';

    runNpmSetPreviewVersions({
      repoRoot,
      env: { ...process.env },
      dryRun: false,
      args: [
        ...(repoRootOverride ? ['--repo-root', repoRootOverride] : []),
        '--publish-cli',
        publishCli,
        '--publish-stack',
        publishStack,
        '--publish-server',
        publishServer,
        '--publish-support',
        publishSupport,
        '--publish-plugin-sdk',
        publishPluginSdk,
        '--publish-sdk',
        publishSdk,
        '--server-runner-dir',
        serverRunnerDir,
        ...(cliVersion ? ['--cli-version', cliVersion] : []),
        ...(stackVersion ? ['--stack-version', stackVersion] : []),
        ...(serverVersion ? ['--server-version', serverVersion] : []),
        ...(supportVersion ? ['--support-version', supportVersion] : []),
        ...(pluginSdkVersion ? ['--plugin-sdk-version', pluginSdkVersion] : []),
        ...(sdkVersion ? ['--sdk-version', sdkVersion] : []),
        '--write',
        write,
      ],
    });

    return;
  }

    if (subcommand === 'npm-publish') {
      const { values } = parseArgs({
        args: rest,
        options: {
          channel: { type: 'string' },
          tag: { type: 'string', default: '' },
          tarball: { type: 'string', default: '' },
          'tarball-dir': { type: 'string', default: '' },
          'allow-dirty': { type: 'string', default: 'false' },
          'dry-run': { type: 'boolean', default: false },
          'secrets-source': { type: 'string', default: 'auto' },
          'keychain-service': { type: 'string', default: 'happier/pipeline' },
          'keychain-account': { type: 'string', default: '' },
        },
      allowPositionals: false,
    });

    const channel = String(values.channel ?? '').trim();
    if (!isReleaseDeployEnvironment(channel)) {
      fail(`--channel must be 'dev', 'preview', or 'production' (got: ${channel || '<empty>'})`);
    }

    const { env, sources } = loadPipelineEnv({ repoRoot });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

    const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
    const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
    const { env: mergedEnv, usedKeychain } = loadSecrets({
      baseEnv: env,
      secretsSource,
      keychainService,
      keychainAccount,
    });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

      const tarball = String(values.tarball ?? '').trim();
      const tarballDir = String(values['tarball-dir'] ?? '').trim();
      const tag = String(values.tag ?? '').trim();
      const publishChannel = channel === 'dev' ? 'preview' : channel;
      const publishTag = tag || (channel === 'dev' ? 'dev' : '');
      const allowDirty = parseBoolString(values['allow-dirty'], '--allow-dirty');
      const dryRun = values['dry-run'] === true;
      if (!dryRun) assertCleanWorktree({ cwd: repoRoot, allowDirty });

      console.log(`[pipeline] npm publish: channel=${channel}`);

    runNpmPublishTarball({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--channel',
        publishChannel,
        ...(publishTag ? ['--tag', publishTag] : []),
        ...(tarball ? ['--tarball', tarball] : []),
        ...(tarballDir ? ['--tarball-dir', tarballDir] : []),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });

    return;
  }

    if (subcommand === 'npm-release') {
      const { values } = parseArgs({
        args: rest,
        options: {
          channel: { type: 'string' },
          'publish-cli': { type: 'string', default: 'false' },
          'publish-stack': { type: 'string', default: 'false' },
          'publish-server': { type: 'string', default: 'false' },
          'publish-plugin-sdk': { type: 'string', default: 'false' },
          'publish-sdk': { type: 'string', default: 'false' },
          'server-runner-dir': { type: 'string', default: 'packages/relay-server' },
          'run-tests': { type: 'string', default: 'auto' },
          mode: { type: 'string', default: 'pack+publish' },
          'cli-version': { type: 'string', default: '' },
          'stack-version': { type: 'string', default: '' },
          'server-version': { type: 'string', default: '' },
          'plugin-sdk-version': { type: 'string', default: '' },
          'sdk-version': { type: 'string', default: '' },
          'allow-dirty': { type: 'string', default: 'false' },
          'dry-run': { type: 'boolean', default: false },
          'secrets-source': { type: 'string', default: 'auto' },
          'keychain-service': { type: 'string', default: 'happier/pipeline' },
          'keychain-account': { type: 'string', default: '' },
        },
      allowPositionals: false,
    });

    const channel = String(values.channel ?? '').trim();
    if (!isReleaseDeployEnvironment(channel)) {
      fail(`--channel must be 'dev', 'preview', or 'production' (got: ${channel || '<empty>'})`);
    }

    const { env, sources } = loadPipelineEnv({ repoRoot });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

    const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
    const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
    const { env: mergedEnv, usedKeychain } = loadSecrets({
      baseEnv: env,
      secretsSource,
      keychainService,
      keychainAccount,
    });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

    const publishCli = String(values['publish-cli'] ?? '').trim();
    const publishStack = String(values['publish-stack'] ?? '').trim();
    const publishServer = String(values['publish-server'] ?? '').trim();
    const publishPluginSdk = String(values['publish-plugin-sdk'] ?? '').trim();
    const publishSdk = String(values['publish-sdk'] ?? '').trim();
    const cliVersion = String(values['cli-version'] ?? '').trim();
    const stackVersion = String(values['stack-version'] ?? '').trim();
    const serverVersion = String(values['server-version'] ?? '').trim();
    const pluginSdkVersion = String(values['plugin-sdk-version'] ?? '').trim();
    const sdkVersion = String(values['sdk-version'] ?? '').trim();
    const runnerDir = String(values['server-runner-dir'] ?? '').trim();
    const runTests = String(values['run-tests'] ?? '').trim();
    const mode = String(values.mode ?? '').trim();
    const allowDirty = parseBoolString(values['allow-dirty'], '--allow-dirty');
    const dryRun = values['dry-run'] === true;
    if (!dryRun) assertCleanWorktree({ cwd: repoRoot, allowDirty });

    console.log(`[pipeline] npm release: channel=${channel}`);

    runNpmReleasePackages({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--channel',
        channel,
        ...(publishCli ? ['--publish-cli', publishCli] : []),
        ...(publishStack ? ['--publish-stack', publishStack] : []),
        ...(publishServer ? ['--publish-server', publishServer] : []),
        ...(publishPluginSdk ? ['--publish-plugin-sdk', publishPluginSdk] : []),
        ...(publishSdk ? ['--publish-sdk', publishSdk] : []),
        ...(cliVersion ? ['--cli-version', cliVersion] : []),
        ...(stackVersion ? ['--stack-version', stackVersion] : []),
        ...(serverVersion ? ['--server-version', serverVersion] : []),
        ...(pluginSdkVersion ? ['--plugin-sdk-version', pluginSdkVersion] : []),
        ...(sdkVersion ? ['--sdk-version', sdkVersion] : []),
        ...(runnerDir ? ['--server-runner-dir', runnerDir] : []),
        ...(runTests ? ['--run-tests', runTests] : []),
        ...(mode ? ['--mode', mode] : []),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });

    return;
  }

      if (subcommand === 'publish-ui-web') {
        const { values } = parseArgs({
          args: rest,
          options: {
            channel: { type: 'string' },
          'allow-stable': { type: 'string', default: 'false' },
          'release-message': { type: 'string', default: '' },
          'run-contracts': { type: 'string', default: 'auto' },
          'check-installers': { type: 'string', default: 'true' },
          version: { type: 'string', default: '' },
          'allow-dirty': { type: 'string', default: 'false' },
          'dry-run': { type: 'boolean', default: false },
          'secrets-source': { type: 'string', default: 'auto' },
          'keychain-service': { type: 'string', default: 'happier/pipeline' },
          'keychain-account': { type: 'string', default: '' },
        },
      allowPositionals: false,
    });

    const requestedChannel = String(values.channel ?? '').trim();
    const channel = normalizePublicReleaseChannel(requestedChannel);
    if (!channel) {
      fail(`--channel must be ${JSON.stringify(ROLLING_RELEASE_CHANNEL_CHOICES)} (got: ${requestedChannel || '<empty>'})`);
    }
    const channelArg = formatPublicReleaseChannel(channel);

    const { env, sources } = loadPipelineEnv({ repoRoot });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

    const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
    const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
    const { env: mergedEnv, usedKeychain } = loadSecrets({
      baseEnv: env,
      secretsSource,
      keychainService,
      keychainAccount,
    });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

      const allowStable = String(values['allow-stable'] ?? '').trim();
      const releaseMessage = String(values['release-message'] ?? '').trim();
      const runContracts = String(values['run-contracts'] ?? '').trim();
      const checkInstallers = String(values['check-installers'] ?? '').trim();
      const version = String(values.version ?? '').trim();
      const allowDirty = parseBoolString(values['allow-dirty'], '--allow-dirty');
      const dryRun = values['dry-run'] === true;
      if (!dryRun) assertCleanWorktree({ cwd: repoRoot, allowDirty });

      runPublishUiWeb({
        repoRoot,
        env: mergedEnv,
      dryRun,
      args: [
        '--channel',
        channelArg,
        '--allow-stable',
        allowStable || 'false',
        '--release-message',
        releaseMessage,
        '--run-contracts',
        runContracts || 'auto',
        '--check-installers',
        checkInstallers || 'true',
        ...(version ? ['--version', version] : []),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });

      return;
    }

      if (subcommand === 'publish-cli-binaries') {
        const { values } = parseArgs({
          args: rest,
          options: {
            channel: { type: 'string' },
            'allow-stable': { type: 'string', default: 'false' },
            'release-message': { type: 'string', default: '' },
            'run-contracts': { type: 'string', default: 'auto' },
            'check-installers': { type: 'string', default: 'true' },
            version: { type: 'string', default: '' },
            'prepared-artifacts': { type: 'boolean', default: false },
            'resolve-version-only': { type: 'boolean', default: false },
            'github-output': { type: 'string', default: '' },
            'allow-dirty': { type: 'string', default: 'false' },
            'dry-run': { type: 'boolean', default: false },
            'secrets-source': { type: 'string', default: 'auto' },
            'keychain-service': { type: 'string', default: 'happier/pipeline' },
            'keychain-account': { type: 'string', default: '' },
          },
        allowPositionals: false,
      });

      const requestedChannel = String(values.channel ?? '').trim();
      const channel = normalizePublicReleaseChannel(requestedChannel);
      if (!channel) {
        fail(`--channel must be ${JSON.stringify(ROLLING_RELEASE_CHANNEL_CHOICES)} (got: ${requestedChannel || '<empty>'})`);
      }
      const channelArg = formatPublicReleaseChannel(channel);

      const { env, sources } = loadPipelineEnv({ repoRoot });
      const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
      const secretsSource =
        secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
          ? secretsSourceRaw
          : 'auto';
      if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
        fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
      }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
      const { env: mergedEnv, usedKeychain } = loadSecrets({
        baseEnv: env,
        secretsSource,
        keychainService,
        keychainAccount,
      });
      if (sources.length > 0) {
        console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
        console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
      }
      if (usedKeychain) {
        console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
      }

        const allowStable = String(values['allow-stable'] ?? '').trim();
        const releaseMessage = String(values['release-message'] ?? '').trim();
        const runContracts = String(values['run-contracts'] ?? '').trim();
        const checkInstallers = String(values['check-installers'] ?? '').trim();
        const version = String(values.version ?? '').trim();
        const preparedArtifacts = values['prepared-artifacts'] === true;
        const resolveVersionOnly = values['resolve-version-only'] === true;
        const githubOutput = String(values['github-output'] ?? '').trim();
        const allowDirty = parseBoolString(values['allow-dirty'], '--allow-dirty');
        const dryRun = values['dry-run'] === true;
        if (!dryRun) assertCleanWorktree({ cwd: repoRoot, allowDirty });

        runPublishCliBinaries({
          repoRoot,
          env: mergedEnv,
        dryRun,
        args: [
          '--channel',
          channelArg,
          '--allow-stable',
          allowStable || 'false',
          '--release-message',
          releaseMessage,
          '--run-contracts',
          runContracts || 'auto',
          '--check-installers',
          checkInstallers || 'true',
          ...(version ? ['--version', version] : []),
          ...(preparedArtifacts ? ['--prepared-artifacts'] : []),
          ...(resolveVersionOnly ? ['--resolve-version-only'] : []),
          ...(githubOutput ? ['--github-output', githubOutput] : []),
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });

      return;
    }

      if (subcommand === 'publish-hstack-binaries') {
        const { values } = parseArgs({
          args: rest,
          options: {
            channel: { type: 'string' },
            'allow-stable': { type: 'string', default: 'false' },
            'release-message': { type: 'string', default: '' },
            'run-contracts': { type: 'string', default: 'auto' },
            'check-installers': { type: 'string', default: 'true' },
            version: { type: 'string', default: '' },
            'allow-dirty': { type: 'string', default: 'false' },
            'dry-run': { type: 'boolean', default: false },
            'secrets-source': { type: 'string', default: 'auto' },
            'keychain-service': { type: 'string', default: 'happier/pipeline' },
            'keychain-account': { type: 'string', default: '' },
          },
        allowPositionals: false,
      });

      const requestedChannel = String(values.channel ?? '').trim();
      const channel = normalizePublicReleaseChannel(requestedChannel);
      if (!channel) {
        fail(`--channel must be ${JSON.stringify(ROLLING_RELEASE_CHANNEL_CHOICES)} (got: ${requestedChannel || '<empty>'})`);
      }
      const channelArg = formatPublicReleaseChannel(channel);

      const { env, sources } = loadPipelineEnv({ repoRoot });
      const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
      const secretsSource =
        secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
          ? secretsSourceRaw
          : 'auto';
      if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
        fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
      }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
      const { env: mergedEnv, usedKeychain } = loadSecrets({
        baseEnv: env,
        secretsSource,
        keychainService,
        keychainAccount,
      });
      if (sources.length > 0) {
        console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
        console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
      }
      if (usedKeychain) {
        console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
      }

        const allowStable = String(values['allow-stable'] ?? '').trim();
        const releaseMessage = String(values['release-message'] ?? '').trim();
        const runContracts = String(values['run-contracts'] ?? '').trim();
        const checkInstallers = String(values['check-installers'] ?? '').trim();
        const version = String(values.version ?? '').trim();
        const allowDirty = parseBoolString(values['allow-dirty'], '--allow-dirty');
        const dryRun = values['dry-run'] === true;
        if (!dryRun) assertCleanWorktree({ cwd: repoRoot, allowDirty });

        runPublishHstackBinaries({
          repoRoot,
          env: mergedEnv,
        dryRun,
        args: [
          '--channel',
          channelArg,
          '--allow-stable',
          allowStable || 'false',
          '--release-message',
          releaseMessage,
          '--run-contracts',
          runContracts || 'auto',
          '--check-installers',
          checkInstallers || 'true',
          ...(version ? ['--version', version] : []),
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });

      return;
    }

      if (subcommand === 'publish-server-runtime') {
        const { values } = parseArgs({
          args: rest,
          options: {
            channel: { type: 'string' },
          'allow-stable': { type: 'string', default: 'false' },
          'release-message': { type: 'string', default: '' },
          'run-contracts': { type: 'string', default: 'auto' },
          'check-installers': { type: 'string', default: 'true' },
          version: { type: 'string', default: '' },
          'allow-dirty': { type: 'string', default: 'false' },
          'dry-run': { type: 'boolean', default: false },
          'secrets-source': { type: 'string', default: 'auto' },
          'keychain-service': { type: 'string', default: 'happier/pipeline' },
          'keychain-account': { type: 'string', default: '' },
        },
      allowPositionals: false,
    });

    const requestedChannel = String(values.channel ?? '').trim();
    const channel = normalizePublicReleaseChannel(requestedChannel);
    if (!channel) {
      fail(`--channel must be ${JSON.stringify(ROLLING_RELEASE_CHANNEL_CHOICES)} (got: ${requestedChannel || '<empty>'})`);
    }
    const channelArg = formatPublicReleaseChannel(channel);

    const { env, sources } = loadPipelineEnv({ repoRoot });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
        const { env: mergedEnv, usedKeychain } = loadSecrets({
          baseEnv: env,
          secretsSource,
          keychainService,
          keychainAccount,
        });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

      const allowStable = String(values['allow-stable'] ?? '').trim();
      const releaseMessage = String(values['release-message'] ?? '').trim();
      const runContracts = String(values['run-contracts'] ?? '').trim();
      const checkInstallers = String(values['check-installers'] ?? '').trim();
      const version = String(values.version ?? '').trim();
      const allowDirty = parseBoolString(values['allow-dirty'], '--allow-dirty');
      const dryRun = values['dry-run'] === true;
      if (!dryRun) assertCleanWorktree({ cwd: repoRoot, allowDirty });

      runPublishServerRuntime({
        repoRoot,
        env: mergedEnv,
      dryRun,
      args: [
        '--channel',
        channelArg,
        '--allow-stable',
        allowStable || 'false',
        '--release-message',
        releaseMessage,
        '--run-contracts',
        runContracts || 'auto',
        '--check-installers',
        checkInstallers || 'true',
        ...(version ? ['--version', version] : []),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });

    return;
  }

  if (subcommand === 'release-bump-plan') {
    const { values } = parseArgs({
      args: rest,
      options: {
        environment: { type: 'string' },
        'bump-preset': { type: 'string' },
        'bump-app-override': { type: 'string', default: 'preset' },
        'bump-cli-override': { type: 'string', default: 'preset' },
        'bump-stack-override': { type: 'string', default: 'preset' },
        'bump-plugin-sdk-override': { type: 'string', default: 'preset' },
        'bump-sdk-override': { type: 'string', default: 'preset' },
        'deploy-targets': { type: 'string', default: '' },
        'changed-ui': { type: 'string' },
        'changed-cli': { type: 'string' },
        'changed-stack': { type: 'string' },
        'changed-server': { type: 'string' },
        'changed-website': { type: 'string' },
        'changed-cli-stack-shared': { type: 'string' },
        'changed-shared': { type: 'string' },
        'changed-plugin-sdk': { type: 'string', default: 'false' },
        'changed-sdk': { type: 'string', default: 'false' },
        'versioned-app-changed': { type: 'string', default: '' },
        'versioned-cli-changed': { type: 'string', default: '' },
        'versioned-stack-changed': { type: 'string', default: '' },
        'versioned-server-changed': { type: 'string', default: '' },
        'versioned-plugin-sdk-changed': { type: 'string', default: '' },
        'versioned-sdk-changed': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const environment = String(values.environment ?? '').trim();
    const bumpPreset = String(values['bump-preset'] ?? '').trim();
    if (!environment) fail('--environment is required');
    if (!bumpPreset) fail('--bump-preset is required');

    runReleaseResolveBumpPlan({
      repoRoot,
      env: process.env,
      dryRun: false,
      args: [
        '--environment',
        environment,
        '--bump-preset',
        bumpPreset,
        '--bump-app-override',
        String(values['bump-app-override'] ?? 'preset'),
        '--bump-cli-override',
        String(values['bump-cli-override'] ?? 'preset'),
        '--bump-stack-override',
        String(values['bump-stack-override'] ?? 'preset'),
        '--bump-plugin-sdk-override',
        String(values['bump-plugin-sdk-override'] ?? 'preset'),
        '--bump-sdk-override',
        String(values['bump-sdk-override'] ?? 'preset'),
        '--deploy-targets',
        String(values['deploy-targets'] ?? ''),
        '--changed-ui',
        String(values['changed-ui'] ?? ''),
        '--changed-cli',
        String(values['changed-cli'] ?? ''),
        '--changed-stack',
        String(values['changed-stack'] ?? ''),
        '--changed-server',
        String(values['changed-server'] ?? ''),
        '--changed-website',
        String(values['changed-website'] ?? ''),
        '--changed-cli-stack-shared',
        String(values['changed-cli-stack-shared'] ?? ''),
        '--changed-shared',
        String(values['changed-shared'] ?? ''),
        '--changed-plugin-sdk',
        String(values['changed-plugin-sdk'] ?? 'false'),
        '--changed-sdk',
        String(values['changed-sdk'] ?? 'false'),
        '--versioned-app-changed',
        String(values['versioned-app-changed'] ?? ''),
        '--versioned-cli-changed',
        String(values['versioned-cli-changed'] ?? ''),
        '--versioned-stack-changed',
        String(values['versioned-stack-changed'] ?? ''),
        '--versioned-server-changed',
        String(values['versioned-server-changed'] ?? ''),
        '--versioned-plugin-sdk-changed',
        String(values['versioned-plugin-sdk-changed'] ?? ''),
        '--versioned-sdk-changed',
        String(values['versioned-sdk-changed'] ?? ''),
      ],
    });
    return;
  }

  if (subcommand === 'release-bump-versions-dev') {
    const { values } = parseArgs({
      args: rest,
      options: {
        'bump-app': { type: 'string', default: 'none' },
        'bump-server': { type: 'string', default: 'none' },
        'bump-website': { type: 'string', default: 'none' },
        'bump-cli': { type: 'string', default: 'none' },
        'bump-stack': { type: 'string', default: 'none' },
        'bump-plugin-sdk': { type: 'string', default: 'none' },
        'bump-sdk': { type: 'string', default: 'none' },
        'push-branch': { type: 'string', default: 'dev' },
        'commit-message': { type: 'string', default: '' },
        'dry-run': { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });

    const dryRun = values['dry-run'] === true;
    runReleaseBumpVersionsDev({
      repoRoot,
      env: process.env,
      dryRun,
      args: [
        '--bump-app',
        String(values['bump-app'] ?? 'none'),
        '--bump-server',
        String(values['bump-server'] ?? 'none'),
        '--bump-website',
        String(values['bump-website'] ?? 'none'),
        '--bump-cli',
        String(values['bump-cli'] ?? 'none'),
        '--bump-stack',
        String(values['bump-stack'] ?? 'none'),
        '--bump-plugin-sdk',
        String(values['bump-plugin-sdk'] ?? 'none'),
        '--bump-sdk',
        String(values['bump-sdk'] ?? 'none'),
        '--push-branch',
        String(values['push-branch'] ?? 'dev'),
        '--commit-message',
        String(values['commit-message'] ?? ''),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });
      return;
    }

  if (subcommand === 'release-validate') {
    const {
      dryRun,
      secretsSource,
      keychainService,
      keychainAccount: keychainAccountRaw,
      passthrough,
    } = splitWrappedReleaseArgs(rest);
    const keychainAccount = keychainAccountRaw.trim() || undefined;

    // Validation dry-runs are deterministic source planning. Execute the
    // target-owned planner directly and do not load release credentials merely
    // to describe a profile or suite command.
    if (dryRun) {
      runReleaseValidate({
        repoRoot,
        args: [...passthrough, '--dry-run'],
        dryRun: passthrough.length === 0,
        skipExecOnDryRun: passthrough.length === 0,
      });
      return;
    }

    const { env, sources } = loadPipelineEnv({ repoRoot });
    const { env: mergedEnv, usedKeychain } = loadSecrets({
      baseEnv: env,
      secretsSource,
      keychainService,
      keychainAccount,
    });

    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

    runReleaseValidate({
      repoRoot,
      env: mergedEnv,
      args: passthrough,
      dryRun: false,
    });
    return;
  }

      if (
        subcommand === 'release-sync-installers' ||
        subcommand === 'release-bump-version' ||
        subcommand === 'release-build-cli-binaries' ||
        subcommand === 'release-build-hstack-binaries' ||
        subcommand === 'release-build-server-binaries' ||
        subcommand === 'release-prepare-binary-assets' ||
        subcommand === 'release-publish-manifests' ||
        subcommand === 'release-verify-artifacts' ||
        subcommand === 'release-analyze' ||
        subcommand === 'release-local-candidates' ||
        subcommand === 'release-compute-changed-components' ||
        subcommand === 'release-compute-versioned-component-changes' ||
        subcommand === 'release-resolve-bump-plan' ||
        subcommand === 'release-compute-deploy-plan' ||
        subcommand === 'release-build-ui-web-bundle'
      ) {
        const {
          deployEnvironment,
          dryRun,
          secretsSource,
          keychainService,
          keychainAccount: keychainAccountRaw,
          passthrough,
        } = splitWrappedReleaseArgs(rest);
        const keychainAccount = keychainAccountRaw.trim() || undefined;

        const scriptFile =
          subcommand === 'release-sync-installers'
            ? 'sync-installers.mjs'
          : subcommand === 'release-bump-version'
            ? 'bump-version.mjs'
            : subcommand === 'release-build-cli-binaries'
              ? 'build-cli-binaries.mjs'
              : subcommand === 'release-build-hstack-binaries'
                ? 'build-hstack-binaries.mjs'
                : subcommand === 'release-build-server-binaries'
                  ? 'build-server-binaries.mjs'
                  : subcommand === 'release-prepare-binary-assets'
                    ? 'prepare-binary-assets.mjs'
                  : subcommand === 'release-publish-manifests'
                    ? 'publish-manifests.mjs'
                    : subcommand === 'release-verify-artifacts'
                      ? 'verify-artifacts.mjs'
                      : subcommand === 'release-analyze'
                        ? 'analyze-release-change.mjs'
                      : subcommand === 'release-local-candidates'
                        ? 'execute-local-candidates.mjs'
                      : subcommand === 'release-compute-changed-components'
                        ? 'compute-changed-components.mjs'
                        : subcommand === 'release-compute-versioned-component-changes'
                          ? 'compute-versioned-component-changes.mjs'
                        : subcommand === 'release-resolve-bump-plan'
                          ? 'resolve-bump-plan.mjs'
                          : subcommand === 'release-compute-deploy-plan'
                            ? 'compute-deploy-plan.mjs'
                            : 'build-ui-web-bundle.mjs';

        const scriptArgs =
          subcommand === 'release-compute-deploy-plan' ? ['--deploy-environment', deployEnvironment, ...passthrough] : passthrough;

        if (subcommand === 'release-analyze' || (subcommand === 'release-local-candidates' && dryRun)) {
          runReleaseWrappedScript({
            repoRoot,
            env: process.env,
            scriptFile,
            args: subcommand === 'release-local-candidates' ? [...scriptArgs, '--dry-run'] : scriptArgs,
            dryRun: false,
          });
          return;
        }

        if (dryRun) {
          runReleaseWrappedScript({
            repoRoot,
            env: process.env,
            scriptFile,
            args: scriptArgs,
            dryRun: true,
            skipExecOnDryRun: true,
          });
          return;
        }

        const { env, sources } = loadPipelineEnv({ repoRoot, deployEnvironment });
        const { env: mergedEnv, usedKeychain } = loadSecrets({
          baseEnv: env,
          secretsSource,
          keychainService,
          keychainAccount,
        });
      if (sources.length > 0) {
        console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
        console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
      }
      if (usedKeychain) {
        console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
      }

        runReleaseWrappedScript({
          repoRoot,
          env: mergedEnv,
          scriptFile,
          args: scriptArgs,
          dryRun: false,
        });
        return;
      }

    if (subcommand === 'expo-ota') {
      const { values } = parseArgs({
        args: rest,
        options: {
          environment: { type: 'string' },
          platform: { type: 'string', default: 'all' },
          message: { type: 'string', default: '' },
          'runtime-version': { type: 'string', default: '' },
          interactive: { type: 'string', default: 'auto' },
          'eas-cli-version': { type: 'string', default: '' },
          'dry-run': { type: 'boolean', default: false },
          'secrets-source': { type: 'string', default: 'auto' },
          'keychain-service': { type: 'string', default: 'happier/pipeline' },
          'keychain-account': { type: 'string', default: '' },
        },
        allowPositionals: false,
      });

    const environment = normalizeMobileReleaseEnvironment(values.environment);
    if (!isUiMobileReleaseEnvironment(environment)) {
      fail(`--environment must be ${JSON.stringify(MOBILE_RELEASE_ENVIRONMENT_CHOICES)} (got: ${String(values.environment ?? '').trim() || '<empty>'})`);
    }
    const environmentArg = formatMobileReleaseEnvironment(environment);
    const runtimeVersion = String(values['runtime-version'] ?? '').trim();
    const platform = String(values.platform ?? '').trim().toLowerCase() || 'all';
    if (platform !== 'ios' && platform !== 'android' && platform !== 'all') {
      fail(`--platform must be 'ios', 'android', or 'all' (got: ${platform})`);
    }

    const { env, sources } = loadPipelineEnv({
      repoRoot,
      deployEnvironment: resolveUiMobilePipelineEnvironment(environment),
    });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
        const { env: mergedEnv, usedKeychain } = loadSecrets({
          baseEnv: env,
          secretsSource,
          keychainService,
          keychainAccount,
        });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

    const message = String(values.message ?? '').trim();
    const interactive = String(values.interactive ?? '').trim();
    const easCliVersion = String(values['eas-cli-version'] ?? '').trim();
    const dryRun = values['dry-run'] === true;

    const otaPlatforms = runtimeVersion && platform === 'all' ? ['android', 'ios'] : [platform];
    for (const otaPlatform of otaPlatforms) {
      runExpoOtaUpdate({
        repoRoot,
        env: mergedEnv,
        dryRun,
        args: [
          '--environment',
          environmentArg,
          '--platform',
          otaPlatform,
          ...(runtimeVersion ? ['--runtime-version', runtimeVersion] : []),
          ...(message ? ['--message', message] : []),
          ...(interactive ? ['--interactive', interactive] : []),
          ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });
    }

    return;
  }

    if (subcommand === 'expo-native-build') {
      const { values } = parseArgs({
        args: rest,
        options: {
          platform: { type: 'string' },
          profile: { type: 'string' },
          out: { type: 'string' },
          'build-mode': { type: 'string', default: '' },
          'local-runtime': { type: 'string', default: '' },
          'artifact-out': { type: 'string', default: '' },
          interactive: { type: 'string', default: 'auto' },
          'eas-cli-version': { type: 'string', default: '' },
          'dump-view': { type: 'string', default: 'true' },
          'fingerprint-mode': { type: 'string', default: 'always' },
          wait: { type: 'string', default: '' },
          'dry-run': { type: 'boolean', default: false },
          'secrets-source': { type: 'string', default: 'auto' },
          'keychain-service': { type: 'string', default: 'happier/pipeline' },
          'keychain-account': { type: 'string', default: '' },
        },
        allowPositionals: false,
      });

    const platform = String(values.platform ?? '').trim();
    const profile = String(values.profile ?? '').trim();
    const outPath = String(values.out ?? '').trim();
    if (!platform || !profile || !outPath) {
      fail('--platform, --profile, and --out are required');
    }

    const { env, sources } = loadPipelineEnv({ repoRoot });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
        const { env: mergedEnv, usedKeychain } = loadSecrets({
          baseEnv: env,
          secretsSource,
          keychainService,
          keychainAccount,
        });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

      const easCliVersion = String(values['eas-cli-version'] ?? '').trim();
      const dumpView = String(values['dump-view'] ?? '').trim();
      const fingerprintModeRaw = String(values['fingerprint-mode'] ?? '').trim().toLowerCase() || 'always';
      if (fingerprintModeRaw !== 'always' && fingerprintModeRaw !== 'if-changed') {
        fail(`--fingerprint-mode must be 'always' or 'if-changed' (got: ${values['fingerprint-mode']})`);
      }
      const fingerprintMode = fingerprintModeRaw;
      const waitRaw = String(values.wait ?? '').trim().toLowerCase();
      if (waitRaw && waitRaw !== 'true' && waitRaw !== 'false') {
        fail(`--wait must be 'true' or 'false' (got: ${values.wait})`);
      }
      const buildMode = String(values['build-mode'] ?? '').trim();
      const localRuntime = String(values['local-runtime'] ?? '').trim();
      const artifactOut = String(values['artifact-out'] ?? '').trim();
      const interactive = String(values.interactive ?? '').trim();
      const dryRun = values['dry-run'] === true;

      runExpoNativeBuild({
        repoRoot,
      env: mergedEnv,
      dryRun,
        args: [
          '--platform',
          platform,
          '--profile',
          profile,
          '--out',
          outPath,
          ...(buildMode ? ['--build-mode', buildMode] : []),
          ...(localRuntime ? ['--local-runtime', localRuntime] : []),
          ...(artifactOut ? ['--artifact-out', artifactOut] : []),
          ...(interactive ? ['--interactive', interactive] : []),
          ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
          ...(dumpView ? ['--dump-view', dumpView] : []),
          ...(fingerprintMode !== 'always' ? ['--fingerprint-mode', fingerprintMode] : []),
          ...(waitRaw ? ['--wait', waitRaw] : []),
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });

    return;
  }

    if (subcommand === 'expo-submit') {
      const { values } = parseArgs({
        args: rest,
        options: {
          environment: { type: 'string' },
          platform: { type: 'string' },
          id: { type: 'string', default: '' },
          path: { type: 'string', default: '' },
          profile: { type: 'string', default: '' },
          interactive: { type: 'string', default: 'auto' },
          'eas-cli-version': { type: 'string', default: '' },
          wait: { type: 'string', default: 'true' },
          'dry-run': { type: 'boolean', default: false },
          'secrets-source': { type: 'string', default: 'auto' },
          'keychain-service': { type: 'string', default: 'happier/pipeline' },
          'keychain-account': { type: 'string', default: '' },
        },
        allowPositionals: false,
      });

    const environment = normalizeMobileReleaseEnvironment(values.environment);
    const platform = String(values.platform ?? '').trim();
    if (!environment || !platform) {
      fail('--environment and --platform are required');
    }
    if (!supportsMobileNativeSubmit(environment)) {
      fail(`--environment must be ${JSON.stringify(MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES)} (got: ${String(values.environment ?? '').trim() || '<empty>'})`);
    }
    const environmentArg = formatMobileReleaseEnvironment(environment);
    if (platform !== 'ios' && platform !== 'android' && platform !== 'all') {
      fail(`--platform must be 'ios', 'android', or 'all' (got: ${platform || '<empty>'})`);
    }

    const { env, sources } = loadPipelineEnv({ repoRoot });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
        const { env: mergedEnv, usedKeychain } = loadSecrets({
          baseEnv: env,
          secretsSource,
          keychainService,
          keychainAccount,
        });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

      const easCliVersion = String(values['eas-cli-version'] ?? '').trim();
      const rawProfile = String(values.profile ?? '').trim();
      const profile = normalizeMobileReleaseProfile(rawProfile) || rawProfile;
      const submitPath = String(values.path ?? '').trim();
      const submitId = String(values.id ?? '').trim();
      const interactive = String(values.interactive ?? '').trim();
      const wait = String(values.wait ?? '').trim();
      const dryRun = values['dry-run'] === true;

      runExpoSubmit({
        repoRoot,
      env: mergedEnv,
      dryRun,
        args: [
          '--environment',
          environmentArg,
          '--platform',
          platform,
          ...(submitId ? ['--id', submitId] : []),
          ...(submitPath ? ['--path', submitPath] : []),
          ...(profile ? ['--profile', profile] : []),
          ...(interactive ? ['--interactive', interactive] : []),
          ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
          ...(wait ? ['--wait', wait] : []),
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });

    return;
  }

  if (subcommand === 'expo-testflight-distribute') {
    const { values } = parseArgs({
      args: rest,
      options: {
        environment: { type: 'string' },
        profile: { type: 'string', default: '' },
        'external-groups': { type: 'string', default: '' },
        'build-json': { type: 'string', default: '' },
        'eas-build-id': { type: 'string', default: '' },
        'build-number': { type: 'string', default: '' },
        'app-version': { type: 'string', default: '' },
        'submit-beta-review': { type: 'string', default: 'auto' },
        'wait-processing': { type: 'string', default: 'true' },
        'processing-timeout-seconds': { type: 'string', default: '3600' },
        'eas-cli-version': { type: 'string', default: '' },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
        'dry-run': { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });

    const environment = normalizeMobileReleaseEnvironment(values.environment);
    if (!environment || !supportsMobileNativeSubmit(environment)) {
      fail(`--environment must be ${JSON.stringify(MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES)} (got: ${String(values.environment ?? '').trim() || '<empty>'})`);
    }
    const environmentArg = formatMobileReleaseEnvironment(environment);
    const externalGroups = parseCsvList(values['external-groups']);
    if (externalGroups.length === 0) fail('--external-groups is required');

    const requestedProfile = String(values.profile ?? '').trim();
    const profile = normalizeMobileReleaseProfile(requestedProfile) || requestedProfile || environment;
    const dryRun = values['dry-run'] === true;
    const waitProcessing = parseBoolString(values['wait-processing'], '--wait-processing');
    const submitBetaReview = String(values['submit-beta-review'] ?? '').trim().toLowerCase() || 'auto';
    if (submitBetaReview !== 'auto' && submitBetaReview !== 'true' && submitBetaReview !== 'false') {
      fail(`--submit-beta-review must be 'auto', 'true', or 'false' (got: ${values['submit-beta-review']})`);
    }
    const processingTimeoutSecondsRaw = String(values['processing-timeout-seconds'] ?? '').trim();
    const processingTimeoutSeconds = Number.parseInt(processingTimeoutSecondsRaw || '3600', 10);
    if (!Number.isFinite(processingTimeoutSeconds) || processingTimeoutSeconds <= 0) {
      fail(`--processing-timeout-seconds must be a positive integer (got: ${values['processing-timeout-seconds']})`);
    }

    const deployEnvironment = resolveUiMobilePipelineEnvironment(environment);
    const { env, sources } = loadPipelineEnv({
      repoRoot,
      deployEnvironment,
    });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

    const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
    const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
    const { env: mergedEnv, usedKeychain } = loadSecrets({
      baseEnv: env,
      secretsSource,
      keychainService,
      keychainAccount,
      deployEnvironment,
    });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log("[pipeline] loaded secrets from Keychain service 'happier/pipeline'");
    }

    runExpoTestflightDistribute({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--environment',
        environmentArg,
        '--profile',
        profile,
        '--external-groups',
        externalGroups.join(','),
        ...(String(values['build-json'] ?? '').trim() ? ['--build-json', String(values['build-json'] ?? '').trim()] : []),
        ...(String(values['eas-build-id'] ?? '').trim() ? ['--eas-build-id', String(values['eas-build-id'] ?? '').trim()] : []),
        ...(String(values['build-number'] ?? '').trim() ? ['--build-number', String(values['build-number'] ?? '').trim()] : []),
        ...(String(values['app-version'] ?? '').trim() ? ['--app-version', String(values['app-version'] ?? '').trim()] : []),
        '--submit-beta-review',
        submitBetaReview,
        '--wait-processing',
        waitProcessing ? 'true' : 'false',
        '--processing-timeout-seconds',
        String(processingTimeoutSeconds),
        ...(String(values['eas-cli-version'] ?? '').trim() ? ['--eas-cli-version', String(values['eas-cli-version'] ?? '').trim()] : []),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });

    return;
  }

  if (subcommand === 'expo-download-apk') {
    const { values } = parseArgs({
      args: rest,
      options: {
        environment: { type: 'string' },
        'build-json': { type: 'string', default: '/tmp/eas_build.json' },
        'eas-cli-version': { type: 'string', default: '' },
        'out-dir': { type: 'string', default: 'dist/ui-mobile' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const environment = normalizeMobileReleaseEnvironment(values.environment);
    if (!isUiMobileReleaseEnvironment(environment)) {
      fail(`--environment must be ${JSON.stringify(MOBILE_RELEASE_ENVIRONMENT_CHOICES)} (got: ${String(values.environment ?? '').trim() || '<empty>'})`);
    }
    const environmentArg = formatMobileReleaseEnvironment(environment);

    const { env, sources } = loadPipelineEnv({
      repoRoot,
      deployEnvironment: resolveUiMobilePipelineEnvironment(environment),
    });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
        const { env: mergedEnv, usedKeychain } = loadSecrets({
          baseEnv: env,
          secretsSource,
          keychainService,
          keychainAccount,
        });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

    const buildJson = String(values['build-json'] ?? '').trim();
    const easCliVersion = String(values['eas-cli-version'] ?? '').trim();
    const outDir = String(values['out-dir'] ?? '').trim();
    const dryRun = values['dry-run'] === true;

    runExpoDownloadAndroidApk({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--environment',
        environmentArg,
        ...(buildJson ? ['--build-json', buildJson] : []),
        ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
        ...(outDir ? ['--out-dir', outDir] : []),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });

    return;
  }

  if (subcommand === 'expo-mobile-meta') {
    const { values } = parseArgs({
      args: rest,
      options: {
        environment: { type: 'string' },
        'download-ok': { type: 'string', default: 'false' },
        'app-version': { type: 'string', default: '' },
        'out-json': { type: 'string', default: '' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const environment = normalizeMobileReleaseEnvironment(values.environment);
    if (!isUiMobileReleaseEnvironment(environment)) {
      fail(`--environment must be ${JSON.stringify(MOBILE_RELEASE_ENVIRONMENT_CHOICES)} (got: ${String(values.environment ?? '').trim() || '<empty>'})`);
    }
    const environmentArg = formatMobileReleaseEnvironment(environment);
    const downloadOk = String(values['download-ok'] ?? '').trim();
    const appVersion = String(values['app-version'] ?? '').trim();
    const outJson = String(values['out-json'] ?? '').trim();
    const dryRun = values['dry-run'] === true;

    const { env, sources } = loadPipelineEnv({ repoRoot });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

    const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
    const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
    const { env: mergedEnv, usedKeychain } = loadSecrets({
      baseEnv: env,
      secretsSource,
      keychainService,
      keychainAccount,
    });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

    runExpoMobileReleaseMeta({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--environment',
        environmentArg,
        '--download-ok',
        downloadOk || 'false',
        ...(appVersion ? ['--app-version', appVersion] : []),
        ...(outJson ? ['--out-json', outJson] : []),
      ],
    });

    return;
  }

  if (subcommand === 'expo-publish-apk-release') {
    const { values } = parseArgs({
      args: rest,
      options: {
        environment: { type: 'string' },
        'apk-path': { type: 'string' },
        'retry-version': { type: 'string', default: '' },
        'target-sha': { type: 'string' },
        'release-message': { type: 'string', default: '' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const environment = normalizeMobileReleaseEnvironment(values.environment);
    if (!isUiMobileReleaseEnvironment(environment)) {
      fail(`--environment must be ${JSON.stringify(MOBILE_RELEASE_ENVIRONMENT_CHOICES)} (got: ${String(values.environment ?? '').trim() || '<empty>'})`);
    }
    const environmentArg = formatMobileReleaseEnvironment(environment);

    const apkPath = String(values['apk-path'] ?? '').trim();
    const retryVersion = String(values['retry-version'] ?? '').trim();
    const targetSha = String(values['target-sha'] ?? '').trim();
    if (!apkPath && !retryVersion) fail('--apk-path is required unless --retry-version is supplied');
    if (apkPath && retryVersion) fail('--apk-path and --retry-version cannot be used together');
    if (!targetSha) fail('--target-sha is required');

    const releaseMessage = String(values['release-message'] ?? '').trim();
    const dryRun = values['dry-run'] === true;

    const { env, sources } = loadPipelineEnv({ repoRoot });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

    const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
    const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
    const { env: mergedEnv, usedKeychain } = loadSecrets({
      baseEnv: env,
      secretsSource,
      keychainService,
      keychainAccount,
    });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

    runExpoPublishApkRelease({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--environment',
        environmentArg,
        ...(apkPath ? ['--apk-path', apkPath] : []),
        ...(retryVersion ? ['--retry-version', retryVersion] : []),
        '--target-sha',
        targetSha,
        ...(releaseMessage ? ['--release-message', releaseMessage] : []),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });

    return;
  }

  if (subcommand === 'ui-mobile-release') {
    const { values } = parseArgs({
      args: rest,
      options: {
        environment: { type: 'string' },
        action: { type: 'string' },
        platform: { type: 'string' },
        profile: { type: 'string', default: '' },
        'publish-apk-release': { type: 'string', default: 'auto' },
        'native-build-mode': { type: 'string', default: 'cloud' },
        'native-local-runtime': { type: 'string', default: 'host' },
        'build-json': { type: 'string', default: '/tmp/eas_build.json' },
        'out-dir': { type: 'string', default: 'dist/ui-mobile' },
        interactive: { type: 'string', default: 'auto' },
        'eas-cli-version': { type: 'string', default: '' },
        'dump-view': { type: 'string', default: 'true' },
        'fingerprint-mode': { type: 'string', default: 'always' },
        'preflight-only': { type: 'boolean', default: false },
        'release-message': { type: 'string', default: '' },
        'runtime-version': { type: 'string', default: '' },
        'ui-version-bump': { type: 'string', default: '' },
        'ui-version': { type: 'string', default: '' },
        'allow-dirty': { type: 'string', default: 'false' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const environment = normalizeMobileReleaseEnvironment(values.environment);
    if (!isUiMobileReleaseEnvironment(environment)) {
      fail(`--environment must be ${JSON.stringify(MOBILE_RELEASE_ENVIRONMENT_CHOICES)} (got: ${String(values.environment ?? '').trim() || '<empty>'})`);
    }
    const environmentArg = formatMobileReleaseEnvironment(environment);

    const action = String(values.action ?? '').trim();
    if (!action) fail('--action is required');
    if (action !== 'native' && action !== 'native_submit' && action !== 'ota') {
      fail(`--action must be 'native', 'native_submit', or 'ota' (got: ${action})`);
    }

    const platform = String(values.platform ?? '').trim();
    if (!platform) fail('--platform is required');
    if (platform !== 'ios' && platform !== 'android' && platform !== 'all') {
      fail(`--platform must be 'ios', 'android', or 'all' (got: ${platform})`);
    }

    const rawProfile = String(values.profile ?? '').trim();
    const profile = normalizeMobileReleaseProfile(rawProfile) || rawProfile;
    if ((action === 'native' || action === 'native_submit') && !profile) {
      fail('--profile is required for native actions');
    }
    if (action === 'native_submit' && !supportsMobileNativeSubmit(environment)) {
      fail(`--action 'native_submit' is supported only for --environment ${JSON.stringify(MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES)}.`);
    }
    if (action === 'native' || action === 'native_submit') {
      const expectedPrefix = resolveUiMobileProfilePrefix(environment);
      const expectedPrefixLabel = resolveMobileProfileInputPrefix(environment);
      if (!profile.startsWith(expectedPrefix)) {
        fail(`--profile must start with '${expectedPrefixLabel}' for --environment '${environmentArg}' (got: ${rawProfile || '<empty>'}).`);
      }
    }

    const publishApkReleaseMode = String(values['publish-apk-release'] ?? '').trim().toLowerCase() || 'auto';
    if (publishApkReleaseMode !== 'auto' && publishApkReleaseMode !== 'true' && publishApkReleaseMode !== 'false') {
      fail(`--publish-apk-release must be 'auto', 'true', or 'false' (got: ${values['publish-apk-release']})`);
    }

    const buildJson = String(values['build-json'] ?? '').trim() || '/tmp/eas_build.json';
    const outDir = String(values['out-dir'] ?? '').trim() || 'dist/ui-mobile';
    const interactive = String(values.interactive ?? '').trim();
    const easCliVersion = String(values['eas-cli-version'] ?? '').trim();
    const dumpView = String(values['dump-view'] ?? '').trim();
    const fingerprintModeRaw = String(values['fingerprint-mode'] ?? '').trim().toLowerCase() || 'always';
    if (fingerprintModeRaw !== 'always' && fingerprintModeRaw !== 'if-changed') {
      fail(`--fingerprint-mode must be 'always' or 'if-changed' (got: ${values['fingerprint-mode']})`);
    }
    /** @type {'always' | 'if-changed'} */
    const fingerprintMode = fingerprintModeRaw;
    const releaseMessage = String(values['release-message'] ?? '').trim();
    const runtimeVersion = String(values['runtime-version'] ?? '').trim();

    const uiVersionBump = String(values['ui-version-bump'] ?? '').trim().toLowerCase();
    const uiVersion = String(values['ui-version'] ?? '').trim();
    const allowDirty = parseBoolString(values['allow-dirty'], '--allow-dirty');

    if (uiVersionBump && uiVersion) {
      fail('Pass only one of --ui-version or --ui-version-bump (not both).');
    }
    if (uiVersionBump && uiVersionBump !== 'patch' && uiVersionBump !== 'minor' && uiVersionBump !== 'major') {
      fail(`--ui-version-bump must be 'patch', 'minor', or 'major' (got: ${values['ui-version-bump']})`);
    }
    if ((uiVersionBump || uiVersion) && environment !== 'production') {
      fail('--ui-version / --ui-version-bump is supported only for --environment production.');
    }
    if (runtimeVersion && action !== 'ota') {
      fail('--runtime-version is supported only for --action ota.');
    }

    const nativeBuildModeRaw = String(values['native-build-mode'] ?? '').trim().toLowerCase() || 'cloud';
    if (nativeBuildModeRaw !== 'cloud' && nativeBuildModeRaw !== 'local') {
      fail(`--native-build-mode must be 'cloud' or 'local' (got: ${nativeBuildModeRaw})`);
    }
    /** @type {'cloud' | 'local'} */
    const nativeBuildMode = nativeBuildModeRaw;
    const nativeLocalRuntimeRaw = String(values['native-local-runtime'] ?? '').trim().toLowerCase() || 'host';
    if (nativeLocalRuntimeRaw !== 'host' && nativeLocalRuntimeRaw !== 'dagger') {
      fail(`--native-local-runtime must be 'host' or 'dagger' (got: ${nativeLocalRuntimeRaw})`);
    }
    /** @type {'host' | 'dagger'} */
    const nativeLocalRuntime = nativeLocalRuntimeRaw;
    const dryRun = values['dry-run'] === true;
    const preflightOnly = values['preflight-only'] === true;
    if (preflightOnly && action !== 'native_submit') {
      fail('--preflight-only is supported only for --action native_submit.');
    }

    const { env, sources } = loadPipelineEnv({
      repoRoot,
      deployEnvironment: resolveUiMobilePipelineEnvironment(environment),
    });

    if (uiVersionBump || uiVersion) {
      if (!dryRun) assertCleanWorktree({ cwd: repoRoot, allowDirty });
      runExpoBumpUiVersion({
        repoRoot,
        env,
        dryRun,
        args: [
          ...(uiVersionBump ? ['--bump', uiVersionBump] : []),
          ...(uiVersion ? ['--version', uiVersion] : []),
          '--package-json',
          'apps/ui/package.json',
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });
    }
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

    const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
    const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
    const { env: mergedEnv, usedKeychain } = loadSecrets({
      baseEnv: env,
      secretsSource,
      keychainService,
      keychainAccount,
    });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

      if (preflightOnly) {
        const shouldHandleIos = platform === 'ios' || platform === 'all';
        if (!shouldHandleIos) {
          console.log('[pipeline] ui-mobile release: no iOS TestFlight configuration to validate.');
          return;
        }
        const testflightDistribution = resolveTestflightDistributionConfig({
          environment,
          env: mergedEnv,
        });
        if (!testflightDistribution.enabled) {
          console.log('[pipeline] ui-mobile release: TestFlight external distribution is not configured.');
          return;
        }
        runExpoTestflightDistribute({
          repoRoot,
          env: mergedEnv,
          dryRun,
          args: [
            '--environment',
            environmentArg,
            '--external-groups',
            testflightDistribution.externalGroups,
            '--validate-groups-only',
            ...(dryRun ? ['--dry-run'] : []),
          ],
        });
        return;
      }

      console.log(`[pipeline] ui-mobile release: environment=${environmentArg} action=${action} platform=${platform}`);

      if (action === 'ota') {
        const otaPlatforms = platform === 'all' ? ['android', 'ios'] : [platform];
        for (const otaPlatform of otaPlatforms) {
          runExpoOtaUpdate({
            repoRoot,
            env: mergedEnv,
            dryRun,
            args: [
              '--environment',
              environmentArg,
              '--platform',
              otaPlatform,
              ...(runtimeVersion ? ['--runtime-version', runtimeVersion] : []),
              ...(interactive ? ['--interactive', interactive] : []),
              ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
              ...(dryRun ? ['--dry-run'] : []),
            ],
          });
        }
        return;
      }

      const buildPlatforms = nativeBuildMode === 'local' && platform === 'all' ? ['android', 'ios'] : [platform];

      /**
       * @param {string} p
       */
      function buildJsonForPlatform(p) {
        if (buildPlatforms.length <= 1) return buildJson;
        const suffix = `.${p}.json`;
        if (buildJson.endsWith('.json')) return buildJson.slice(0, -'.json'.length) + suffix;
        return buildJson + suffix;
      }

      /**
       * @param {string} p
       * @param {string} appVersion
       */
      function localArtifactOutForPlatform(p, appVersion) {
        return resolveMobileNativeArtifactRelativePath({
          environment,
          platform: /** @type {'ios' | 'android'} */ (p),
          appVersion,
          outDir,
          profile,
        });
      }

      // Resolve appVersion early for local build output paths and for production APK naming.
      let appVersion = '';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', 'ui', 'package.json'), 'utf8'));
        appVersion = String(pkg?.version ?? '').trim();
      } catch {
        appVersion = '';
      }

      const shouldHandleAndroid = platform === 'android' || platform === 'all';
      const shouldDownloadAndroidApk = shouldHandleAndroid && profile.endsWith('-apk');
      const supportsApkReleasePublishing = supportsMobileApkReleasePublishing(environment);
      if (publishApkReleaseMode === 'true' && !supportsApkReleasePublishing) {
        fail(`--publish-apk-release true is supported only for --environment ${JSON.stringify(MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES)}.`);
      }
      const shouldPublishApkRelease =
        publishApkReleaseMode === 'true'
          ? true
          : publishApkReleaseMode === 'false'
            ? false
            : supportsApkReleasePublishing &&
              (nativeBuildMode === 'local'
                ? shouldHandleAndroid && localArtifactOutForPlatform('android', appVersion || '0.0.0').endsWith('.apk')
                : shouldDownloadAndroidApk);

      if (nativeBuildMode === 'local') {
        if (nativeLocalRuntime === 'dagger' && platform !== 'android') {
          fail("--native-local-runtime 'dagger' currently supports only --platform android.");
        }
        if (platform !== 'android' && platform !== 'ios' && platform !== 'all') {
          fail(`--platform must be 'ios', 'android', or 'all' (got: ${platform})`);
        }
        if (!appVersion && environment === 'production') {
          fail('Unable to resolve apps/ui version to compute production build output path.');
        }

        for (const p of buildPlatforms) {
          if (p === 'all') continue;
          runExpoNativeBuild({
            repoRoot,
            env: mergedEnv,
            dryRun,
            args: [
              '--platform',
              p,
              '--profile',
              profile,
              '--out',
              buildJsonForPlatform(p),
              '--build-mode',
              'local',
              ...(nativeLocalRuntime !== 'host' ? ['--local-runtime', nativeLocalRuntime] : []),
              '--artifact-out',
              localArtifactOutForPlatform(p, appVersion || '0.0.0'),
              ...(interactive ? ['--interactive', interactive] : []),
              ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
              ...(dumpView ? ['--dump-view', dumpView] : []),
              ...(fingerprintMode !== 'always' ? ['--fingerprint-mode', fingerprintMode] : []),
              ...(dryRun ? ['--dry-run'] : []),
            ],
          });
        }
      } else {
        const waitForCloudBuild = action !== 'native_submit';
        runExpoNativeBuild({
          repoRoot,
          env: mergedEnv,
          dryRun,
          args: [
            '--platform',
            platform,
            '--profile',
            profile,
            '--out',
            buildJson,
            '--wait',
            waitForCloudBuild ? 'true' : 'false',
            ...(interactive ? ['--interactive', interactive] : []),
            ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
            ...(dumpView ? ['--dump-view', dumpView] : []),
            ...(fingerprintMode !== 'always' ? ['--fingerprint-mode', fingerprintMode] : []),
            ...(dryRun ? ['--dry-run'] : []),
          ],
        });
      }

      /** @type {{ android: boolean; ios: boolean; skipped: boolean }} */
      const cloudBuildPresence = { android: false, ios: false, skipped: false };
      if (nativeBuildMode === 'cloud' && !dryRun) {
        const abs = path.isAbsolute(buildJson) ? buildJson : path.join(repoRoot, buildJson);
        try {
          if (abs && fs.existsSync(abs)) {
            const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
            if (parsed && typeof parsed === 'object' && parsed.skipped === true) {
              cloudBuildPresence.skipped = true;
            } else {
              const list = Array.isArray(parsed) ? parsed : [parsed];
              for (const item of list) {
                const platRaw = item?.platform ? String(item.platform).trim() : '';
                const plat = platRaw.toLowerCase() === 'ios' || platRaw.toUpperCase() === 'IOS'
                  ? 'ios'
                  : platRaw.toLowerCase() === 'android' || platRaw.toUpperCase() === 'ANDROID'
                    ? 'android'
                    : platRaw.toLowerCase();
                const id = item?.id ? String(item.id).trim() : '';
                if (!id) continue;
                if (plat === 'ios') cloudBuildPresence.ios = true;
                if (plat === 'android') cloudBuildPresence.android = true;
              }
            }
          }
        } catch {
          // If buildJson cannot be parsed, downstream steps will fail naturally.
        }
      }
      if (!dryRun && cloudBuildPresence.skipped) {
        console.log('[pipeline] ui-mobile release: skipped native build (fingerprint unchanged).');
        return;
      }

      let apkPath = '';
      if (shouldDownloadAndroidApk) {
        if (!dryRun && nativeBuildMode === 'cloud' && !cloudBuildPresence.android) {
          console.log('[pipeline] ui-mobile release: skipping APK download (no Android build was scheduled).');
        } else {
        if (nativeBuildMode === 'local') {
          apkPath = localArtifactOutForPlatform('android', appVersion || '0.0.0');
          if (!apkPath.endsWith('.apk')) {
            fail('Android APK workflows require an *-apk EAS profile (internalpreview-apk, dev-apk, preview-apk, or production-apk).');
          }
        } else {
          runExpoDownloadAndroidApk({
            repoRoot,
            env: mergedEnv,
            dryRun,
            args: [
              '--environment',
              environmentArg,
              ...(buildJson ? ['--build-json', buildJson] : []),
              ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
              ...(outDir ? ['--out-dir', outDir] : []),
              ...(dryRun ? ['--dry-run'] : []),
            ],
          });

          if (environment === 'production' && !appVersion) {
            fail('Unable to resolve apps/ui version to compute production APK path.');
          }

          apkPath =
            resolveMobileNativeArtifactRelativePath({
              environment,
              platform: 'android',
              appVersion,
              outDir,
              profile,
            });
        }
        }
      }

      if (shouldPublishApkRelease) {
        if (!dryRun && nativeBuildMode === 'cloud' && !cloudBuildPresence.android) {
          console.log('[pipeline] ui-mobile release: skipping APK GitHub release publish (no Android build was scheduled).');
        } else {
        if (!apkPath.endsWith('.apk')) {
          fail('Android APK release publishing requires a downloaded or locally-built APK artifact.');
        }

        const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repoRoot,
          env: mergedEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      }).trim();
      if (!sha) fail('Unable to resolve git sha (git rev-parse HEAD).');

      runExpoPublishApkRelease({
        repoRoot,
        env: mergedEnv,
        dryRun,
        args: [
          '--environment',
          environmentArg,
          '--apk-path',
          apkPath,
          '--target-sha',
          sha,
          ...(releaseMessage ? ['--release-message', releaseMessage] : []),
          ...(dryRun ? ['--dry-run'] : []),
          ],
        });
      }
      }

      if (action === 'native_submit') {
        if (nativeBuildMode === 'local') {
          const toSubmit = platform === 'all' ? ['android', 'ios'] : [platform];
          for (const p of toSubmit) {
            const rel = localArtifactOutForPlatform(p, appVersion || '0.0.0');
            runExpoSubmit({
              repoRoot,
              env: mergedEnv,
              dryRun,
              args: [
                '--environment',
                environmentArg,
                '--platform',
                p,
                '--path',
                rel,
                '--wait',
                'false',
                ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
                ...(dryRun ? ['--dry-run'] : []),
              ],
            });
          }
        } else {
          /**
           * When we just scheduled a cloud build, `eas submit --latest` can pick up an unrelated older build.
           * Prefer submitting the explicit build ids written by `expo native-build --out <build-json>`.
           *
           * @returns {{ ios?: string; android?: string }}
           */
          function tryResolveCloudBuildIds() {
            if (!buildJson) return {};
            const abs = path.isAbsolute(buildJson) ? buildJson : path.join(repoRoot, buildJson);
            try {
              if (!fs.existsSync(abs)) return {};
              const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
              const list = Array.isArray(parsed) ? parsed : [parsed];
              /** @type {{ ios?: string; android?: string }} */
              const out = {};
              for (const item of list) {
                const id = item?.id ? String(item.id) : '';
                const platRaw = item?.platform ? String(item.platform).trim() : '';
                const platUpper = platRaw.toUpperCase();
                const plat =
                  platUpper === 'IOS'
                    ? 'ios'
                    : platUpper === 'ANDROID'
                      ? 'android'
                      : platRaw.toLowerCase();
                if (!id) continue;
                if (plat === 'ios' && !out.ios) out.ios = id;
                if (plat === 'android' && !out.android) out.android = id;
              }
              return out;
            } catch {
              return {};
            }
          }

          const buildIds = tryResolveCloudBuildIds();
          const toSubmit = platform === 'all' ? ['android', 'ios'] : [platform];
          for (const p of toSubmit) {
            const explicitId = p === 'ios' ? buildIds.ios : p === 'android' ? buildIds.android : '';
            if (!explicitId) {
              console.log(`[pipeline] ui-mobile release: skipping ${p} submit (no build id in build-json).`);
              continue;
            }
            runExpoSubmit({
              repoRoot,
              env: mergedEnv,
              dryRun,
              args: [
                '--environment',
                environmentArg,
                '--platform',
                p,
                ...(explicitId ? ['--id', explicitId] : []),
                '--wait',
                'false',
                ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
                ...(dryRun ? ['--dry-run'] : []),
              ],
            });
        }
      }

      if (platform === 'ios' || platform === 'all') {
        const testflightDistributionConfig = resolveTestflightDistributionConfig({ environment, env: mergedEnv });
        if (!testflightDistributionConfig.enabled) {
          console.log('[pipeline] ui-mobile release: skipping TestFlight distribution (no external groups configured).');
        } else if (!dryRun && nativeBuildMode === 'cloud' && !cloudBuildPresence.ios) {
          console.log('[pipeline] ui-mobile release: skipping TestFlight distribution (no iOS build was scheduled).');
        } else {
          runExpoTestflightDistribute({
            repoRoot,
            env: mergedEnv,
            dryRun,
            args: [
              '--environment',
              environmentArg,
              '--profile',
              profile,
              '--external-groups',
              testflightDistributionConfig.externalGroups,
              '--build-json',
              buildJsonForPlatform('ios'),
              '--submit-beta-review',
              testflightDistributionConfig.submitBetaReview,
              '--wait-processing',
              testflightDistributionConfig.waitProcessing ? 'true' : 'false',
              '--processing-timeout-seconds',
              String(testflightDistributionConfig.processingTimeoutSeconds),
              ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
              ...(dryRun ? ['--dry-run'] : []),
            ],
          });
        }
      }
      }

      return;
      }

    if (subcommand === 'tauri-validate-updater-pubkey') {
      const { values } = parseArgs({
        args: rest,
        options: {
          'config-path': { type: 'string', default: '' },
          'dry-run': { type: 'boolean', default: false },
        },
        allowPositionals: false,
      });

      const configPath = String(values['config-path'] ?? '').trim();
      if (!configPath) fail('--config-path is required');
      const dryRun = values['dry-run'] === true;

      runTauriValidateUpdaterPubkey({
        repoRoot,
        env: { ...process.env },
        dryRun,
        args: [
          '--config-path',
          configPath,
        ],
      });

      return;
    }

      if (subcommand === 'tauri-prepare-assets') {
        const { values } = parseArgs({
        args: rest,
        options: {
          environment: { type: 'string' },
        repo: { type: 'string' },
        'ui-version': { type: 'string' },
        'artifacts-dir': { type: 'string', default: 'dist/tauri/updates' },
        'publish-dir': { type: 'string', default: 'dist/tauri/publish' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const requestedEnvironment = String(values.environment ?? '').trim();
    const environment = normalizeTauriReleaseEnvironment(requestedEnvironment);
    if (!environment) {
      fail(`--environment must be ${JSON.stringify(TAURI_RELEASE_ENVIRONMENT_CHOICES)} (got: ${requestedEnvironment || '<empty>'})`);
    }
    const environmentArg = environment === 'publicdev' ? 'dev' : environment;
    const repo = String(values.repo ?? '').trim();
    const uiVersion = String(values['ui-version'] ?? '').trim();
    if (!repo) fail('--repo is required');
    if (!uiVersion) fail('--ui-version is required');

    const artifactsDir = String(values['artifacts-dir'] ?? '').trim();
    const publishDir = String(values['publish-dir'] ?? '').trim();
    const dryRun = values['dry-run'] === true;

    const { env, sources } = loadPipelineEnv({ repoRoot });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

    const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
    const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
    const { env: mergedEnv, usedKeychain } = loadSecrets({
      baseEnv: env,
      secretsSource,
      keychainService,
      keychainAccount,
    });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

    runTauriPreparePublishAssets({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--environment',
        environmentArg,
        '--ui-version',
        uiVersion,
        '--repo',
        repo,
        ...(artifactsDir ? ['--artifacts-dir', artifactsDir] : []),
        ...(publishDir ? ['--publish-dir', publishDir] : []),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });

      return;
    }

    if (subcommand === 'tauri-bundle-candidate') {
      const { values } = parseArgs({
        args: rest,
        options: {
          mode: { type: 'string' },
          'platform-key': { type: 'string' },
          'source-sha': { type: 'string', default: '' },
          'expected-source-sha': { type: 'string', default: '' },
          environment: { type: 'string', default: '' },
          'expected-environment': { type: 'string', default: '' },
          'ui-version': { type: 'string', default: '' },
          'expected-ui-version': { type: 'string', default: '' },
          'build-version': { type: 'string', default: '' },
          'expected-build-version': { type: 'string', default: '' },
          'tauri-target': { type: 'string', default: '' },
          'ui-dir': { type: 'string', default: 'apps/ui' },
          'out-dir': { type: 'string', default: '' },
          'candidate-dir': { type: 'string', default: '' },
        },
        allowPositionals: false,
      });
      const args = [];
      for (const [name, value] of Object.entries(values)) {
        if (value !== undefined && value !== '') args.push(`--${name}`, String(value));
      }
      runTauriBundleCandidate({ repoRoot, env: { ...process.env }, args, dryRun: false });
      return;
    }

    if (subcommand === 'tauri-build-updater-artifacts') {
      const { values } = parseArgs({
        args: rest,
        options: {
          environment: { type: 'string' },
          'build-version': { type: 'string', default: '' },
          'tauri-target': { type: 'string', default: '' },
          'ui-dir': { type: 'string', default: 'apps/ui' },
          'no-bundle': { type: 'boolean', default: false },
          'bundle-only': { type: 'boolean', default: false },
          'dry-run': { type: 'boolean', default: false },
          'secrets-source': { type: 'string', default: 'auto' },
          'keychain-service': { type: 'string', default: 'happier/pipeline' },
          'keychain-account': { type: 'string', default: '' },
        },
        allowPositionals: false,
      });

      const requestedEnvironment = String(values.environment ?? '').trim();
      const environment = normalizeTauriReleaseEnvironment(requestedEnvironment);
      if (!environment) {
        fail(`--environment must be ${JSON.stringify(TAURI_RELEASE_ENVIRONMENT_CHOICES)} (got: ${requestedEnvironment || '<empty>'})`);
      }
      const environmentArg = environment === 'publicdev' ? 'dev' : environment;

      const buildVersion = String(values['build-version'] ?? '').trim();
      const tauriTarget = String(values['tauri-target'] ?? '').trim();
      const uiDir = String(values['ui-dir'] ?? '').trim() || 'apps/ui';
      const noBundle = values['no-bundle'] === true;
      const bundleOnly = values['bundle-only'] === true;
      const dryRun = values['dry-run'] === true;

      const { env, sources } = loadPipelineEnv({ repoRoot });
      const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
      const secretsSource =
        secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
          ? secretsSourceRaw
          : 'auto';
      if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
        fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
      }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
        const { env: mergedEnv, usedKeychain } = loadSecrets({
          baseEnv: env,
          secretsSource,
          keychainService,
          keychainAccount,
        });
      if (sources.length > 0) {
        console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
        console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
      }
      if (usedKeychain) {
        console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
      }

      runTauriBuildUpdaterArtifacts({
        repoRoot,
        env: mergedEnv,
        dryRun,
        args: [
          '--environment',
          environmentArg,
          ...(buildVersion ? ['--build-version', buildVersion] : []),
          ...(tauriTarget ? ['--tauri-target', tauriTarget] : []),
          ...(uiDir ? ['--ui-dir', uiDir] : []),
          ...(noBundle ? ['--no-bundle'] : []),
          ...(bundleOnly ? ['--bundle-only'] : []),
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });

      return;
    }

    if (subcommand === 'tauri-notarize-macos-artifacts') {
      const { values } = parseArgs({
        args: rest,
        options: {
          'ui-dir': { type: 'string', default: 'apps/ui' },
          'tauri-target': { type: 'string', default: '' },
          'dry-run': { type: 'boolean', default: false },
          'secrets-source': { type: 'string', default: 'auto' },
          'keychain-service': { type: 'string', default: 'happier/pipeline' },
          'keychain-account': { type: 'string', default: '' },
        },
        allowPositionals: false,
      });

      const uiDir = String(values['ui-dir'] ?? '').trim() || 'apps/ui';
      const tauriTarget = String(values['tauri-target'] ?? '').trim();
      const dryRun = values['dry-run'] === true;

      const { env, sources } = loadPipelineEnv({ repoRoot });
      const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
      const secretsSource =
        secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
          ? secretsSourceRaw
          : 'auto';
      if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
        fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
      }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
          const { env: mergedEnv, usedKeychain } = loadSecrets({
            baseEnv: env,
            secretsSource,
            keychainService,
            keychainAccount,
          });
      if (sources.length > 0) {
        console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
        console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
      }
      if (usedKeychain) {
        console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
      }

      runTauriNotarizeMacosArtifacts({
        repoRoot,
        env: mergedEnv,
        dryRun,
        args: [
          ...(uiDir ? ['--ui-dir', uiDir] : []),
          ...(tauriTarget ? ['--tauri-target', tauriTarget] : []),
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });

      return;
    }

    if (subcommand === 'tauri-sign-updater-artifacts') {
      const { values } = parseArgs({ args: rest, options: { 'ui-dir': { type: 'string', default: 'apps/ui' }, 'tauri-target': { type: 'string', default: '' } }, allowPositionals: false });
      const uiDir = String(values['ui-dir'] ?? '').trim() || 'apps/ui';
      const tauriTarget = String(values['tauri-target'] ?? '').trim();
      runTauriSignUpdaterArtifacts({ repoRoot, env: { ...process.env }, dryRun: false, args: ['--ui-dir', uiDir, ...(tauriTarget ? ['--tauri-target', tauriTarget] : [])] });
      return;
    }

    if (subcommand === 'tauri-collect-updater-artifacts') {
      const { values } = parseArgs({
        args: rest,
        options: {
          environment: { type: 'string' },
          'platform-key': { type: 'string' },
          'ui-version': { type: 'string' },
          'tauri-target': { type: 'string', default: '' },
          'ui-dir': { type: 'string', default: 'apps/ui' },
          'dry-run': { type: 'boolean', default: false },
        },
        allowPositionals: false,
      });

      const requestedEnvironment = String(values.environment ?? '').trim();
      const environment = normalizeTauriReleaseEnvironment(requestedEnvironment);
      if (!environment) {
        fail(`--environment must be ${JSON.stringify(TAURI_RELEASE_ENVIRONMENT_CHOICES)} (got: ${requestedEnvironment || '<empty>'})`);
      }
      const environmentArg = environment === 'publicdev' ? 'dev' : environment;

      const platformKey = String(values['platform-key'] ?? '').trim();
      const uiVersion = String(values['ui-version'] ?? '').trim();
      const tauriTarget = String(values['tauri-target'] ?? '').trim();
      const uiDir = String(values['ui-dir'] ?? '').trim() || 'apps/ui';
      const dryRun = values['dry-run'] === true;

      runTauriCollectUpdaterArtifacts({
        repoRoot,
        env: { ...process.env },
        dryRun,
        args: [
          '--environment',
          environmentArg,
          '--platform-key',
          platformKey,
          '--ui-version',
          uiVersion,
          ...(tauriTarget ? ['--tauri-target', tauriTarget] : []),
          ...(uiDir ? ['--ui-dir', uiDir] : []),
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });

      return;
    }

    if (subcommand === 'testing-create-auth-credentials') {
      const { values } = parseArgs({
        args: rest,
        options: {
          'server-url': { type: 'string', default: '' },
          'home-dir': { type: 'string', default: '' },
          'active-server-id': { type: 'string', default: '' },
          'secret-base64': { type: 'string', default: '' },
          'dry-run': { type: 'boolean', default: false },
        },
        allowPositionals: false,
      });

      const serverUrl = String(values['server-url'] ?? '').trim();
      const homeDir = String(values['home-dir'] ?? '').trim();
      const activeServerId = String(values['active-server-id'] ?? '').trim();
      const secretBase64 = String(values['secret-base64'] ?? '').trim();
      const dryRun = values['dry-run'] === true;

      runTestingCreateAuthCredentials({
        repoRoot,
        env: { ...process.env },
        dryRun,
        args: [
          ...(serverUrl ? ['--server-url', serverUrl] : []),
          ...(homeDir ? ['--home-dir', homeDir] : []),
          ...(activeServerId ? ['--active-server-id', activeServerId] : []),
          ...(secretBase64 ? ['--secret-base64', secretBase64] : []),
        ],
      });

      return;
    }

      if (subcommand === 'secrets-import') {
        const { values } = parseArgs({
          args: rest,
          options: {
            'env-files': { type: 'string', default: '' },
            env: { type: 'string', default: '' },
            'keychain-service': { type: 'string', default: 'happier/pipeline' },
            'keychain-account': { type: 'string', default: '' },
            'only-missing': { type: 'string', default: 'false' },
            'ignore-missing': { type: 'string', default: 'true' },
            'cleanup-env-files': { type: 'string', default: 'auto' },
            verbose: { type: 'string', default: 'false' },
            'dry-run': { type: 'boolean', default: false },
          },
          allowPositionals: false,
        });

        const envFilesRaw = String(values['env-files'] ?? '').trim();
        const envRaw = String(values.env ?? '').trim();
        const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
        const keychainAccount = String(values['keychain-account'] ?? '').trim() || '';
        const onlyMissing = parseBoolString(values['only-missing'], '--only-missing');
        const ignoreMissing = parseBoolString(values['ignore-missing'], '--ignore-missing');
        const cleanupEnvFiles = parseCleanupMode(values['cleanup-env-files'], '--cleanup-env-files');
        const verbose = parseBoolString(values.verbose, '--verbose');
        const dryRun = values['dry-run'] === true;

        /** @type {('production'|'preview')[]} */
        let envTargets = [];
        if (envRaw) {
          const parts = parseCsvList(envRaw);
          for (const env of parts) {
            if (!isDeployEnvironment(env)) {
              fail(`--env must be 'preview' or 'production' (got: ${env || '<empty>'})`);
            }
            envTargets.push(env);
          }
        } else if (!envFilesRaw) {
          // Default behavior: when importing from standard repo env files, import all env overlays.
          envTargets = ['preview', 'production'];
        }

        const wantsEnvBundles = envTargets.length > 0;

        const envFilesList = envFilesRaw ? parseCsvList(envFilesRaw) : [];
        const envFileMatch = (filePath) => {
          const base = path.basename(String(filePath ?? '').trim());
          if (base === '.env.pipeline.production.local') return 'production';
          if (base === '.env.pipeline.preview.local') return 'preview';
          return '';
        };

        const baseEnvFiles = envFilesList.filter((f) => !envFileMatch(f));
        const baseFiles = baseEnvFiles.length > 0 ? baseEnvFiles : envFilesRaw ? ['.env.pipeline.local'] : ['.env.pipeline.local'];
        /** @type {string[]} */
        const cleanupFileInputs = [...baseFiles];

        const { baseAccount } = resolveKeychainBundleAccounts({ accountPrefix: keychainAccount || undefined });
        console.log(
          `[pipeline] keychain import: service=${keychainService} account=${baseAccount} (base bundle)`,
        );

        /**
         * @param {ReturnType<typeof importDotenvIntoKeychainBundle>} result
         * @param {string} label
         */
        const logResult = (result, label) => {
          if (result.missingSources.length > 0) {
            console.log(`[pipeline] keychain import: ${label}: skipped missing env files: ${result.missingSources.join(', ')}`);
          }
          console.log(
            [
              `[pipeline] keychain import: ${label}: sources=${result.sources.length} imported_keys=${result.importedKeys}`,
              `[pipeline] keychain import: ${label}: added=${result.added.length} updated=${result.updated.length} skipped=${result.skipped.length} unchanged=${result.unchanged}`,
              `[pipeline] keychain import: ${label}: ${result.wrote ? 'WROTE' : 'NOOP'} (dry_run=${dryRun})`,
            ].join('\n'),
          );
          if (verbose) {
            const lines = [];
            if (result.added.length > 0) lines.push(`added: ${result.added.join(', ')}`);
            if (result.updated.length > 0) lines.push(`updated: ${result.updated.join(', ')}`);
            if (result.skipped.length > 0) lines.push(`skipped: ${result.skipped.join(', ')}`);
            if (lines.length > 0) console.log(`[pipeline] keychain import details (${label}):\n${lines.map((l) => `- ${l}`).join('\n')}`);
          }
        };

        const baseResult = importDotenvIntoKeychainBundle({
          repoRoot,
          envFiles: baseFiles,
          keychainService,
          keychainAccount: baseAccount,
          onlyMissing,
          ignoreMissing,
          dryRun,
        });
        logResult(baseResult, 'base');

        if (wantsEnvBundles) {
          for (const deployEnvironment of envTargets) {
            const { envAccount } = resolveKeychainBundleAccounts({
              accountPrefix: keychainAccount || undefined,
              deployEnvironment,
            });
            const envFilesFromList = envFilesList.filter((f) => envFileMatch(f) === deployEnvironment);
            const envFiles = envFilesFromList.length > 0 ? envFilesFromList : [`.env.pipeline.${deployEnvironment}.local`];
            cleanupFileInputs.push(...envFiles);

            console.log(
              `[pipeline] keychain import: service=${keychainService} account=${envAccount} (env bundle: ${deployEnvironment})`,
            );
            const envResult = importDotenvIntoKeychainBundle({
              repoRoot,
              envFiles,
              keychainService,
              keychainAccount: envAccount || undefined,
              onlyMissing,
              ignoreMissing,
              dryRun,
            });
            logResult(envResult, deployEnvironment);
          }
        }

        // Optional cleanup: remove imported env files from disk (operator convenience).
        if (dryRun) return;

        const isTty = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
        const isCi = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
        const interactive = isTty && !isCi;

        const { candidatesAbs, skippedUnsafe } = resolveEnvCleanupCandidates({
          repoRoot,
          filePaths: cleanupFileInputs,
        });

        if (skippedUnsafe.length > 0) {
          console.log(`[pipeline] keychain import: cleanup: skipped unsafe files: ${skippedUnsafe.join(', ')}`);
        }

        if (candidatesAbs.length === 0) return;

        /** @type {boolean} */
        let shouldDelete = false;
        if (cleanupEnvFiles === true) {
          shouldDelete = true;
        } else if (cleanupEnvFiles === false) {
          shouldDelete = false;
        } else if (cleanupEnvFiles === 'prompt' || cleanupEnvFiles === 'auto') {
          if (!interactive) {
            if (cleanupEnvFiles === 'prompt') {
              fail('--cleanup-env-files=prompt requires an interactive TTY. Use --cleanup-env-files=true or false.');
            }
            return;
          }

          console.log('[pipeline] keychain import: cleanup: candidates:');
          for (const abs of candidatesAbs) {
            console.log(`- ${path.relative(repoRoot, abs)}`);
          }
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = String(await rl.question('Remove these env files from disk? (y/N) ')).trim().toLowerCase();
            shouldDelete = answer === 'y' || answer === 'yes';
          } finally {
            rl.close();
          }
        }

        if (!shouldDelete) return;

        for (const abs of candidatesAbs) {
          try {
            fs.unlinkSync(abs);
            console.log(`[pipeline] removed env file: ${path.relative(repoRoot, abs)}`);
          } catch (err) {
            console.log(`[pipeline] warning: failed to remove env file: ${path.relative(repoRoot, abs)}`);
            console.log(String(err));
          }
        }

        return;
      }

      if (subcommand === 'docker-publish') {
        const { values } = parseArgs({
          args: rest,
          options: {
          channel: { type: 'string' },
          registries: { type: 'string', default: '' },
          'source-ref': { type: 'string', default: '' },
          sha: { type: 'string', default: '' },
          'push-latest': { type: 'string', default: 'true' },
          'build-relay': { type: 'string', default: 'true' },
          'build-dev-box': { type: 'string', default: 'true' },
          'allow-dirty': { type: 'string', default: 'false' },
          'dry-run': { type: 'boolean', default: false },
          'secrets-source': { type: 'string', default: 'auto' },
          'keychain-service': { type: 'string', default: 'happier/pipeline' },
          'keychain-account': { type: 'string', default: '' },
        },
      allowPositionals: false,
    });

    const channel = String(values.channel ?? '').trim();
    if (!isDockerChannel(channel)) {
      fail(`--channel must be 'stable', 'preview', or 'dev' (got: ${channel || '<empty>'})`);
    }

    const { env, sources } = loadPipelineEnv({ repoRoot });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
        const { env: mergedEnv, usedKeychain } = loadSecrets({
          baseEnv: env,
          secretsSource,
          keychainService,
          keychainAccount,
        });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

    const sha = String(values.sha ?? '').trim();
      const sourceRef = String(values['source-ref'] ?? '').trim();
      const registries = String(values.registries ?? '').trim();
      const pushLatest = String(values['push-latest'] ?? '').trim();
      const buildRelay = String(values['build-relay'] ?? '').trim();
      const buildDevBox = String(values['build-dev-box'] ?? '').trim();
      const allowDirty = parseBoolString(values['allow-dirty'], '--allow-dirty');
      const dryRun = values['dry-run'] === true;
      if (!dryRun) assertCleanWorktree({ cwd: repoRoot, allowDirty });

      console.log(`[pipeline] docker publish: channel=${channel}`);

    runDockerPublishImages({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--channel',
        channel,
        ...(registries ? ['--registries', registries] : []),
        ...(sourceRef ? ['--source-ref', sourceRef] : []),
        ...(sha ? ['--sha', sha] : []),
        ...(pushLatest ? ['--push-latest', pushLatest] : []),
        ...(buildRelay ? ['--build-relay', buildRelay] : []),
        ...(buildDevBox ? ['--build-dev-box', buildDevBox] : []),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });

      return;
    }

      if (subcommand === 'github-audit-release-assets') {
        const { values } = parseArgs({
          args: rest,
          options: {
            tag: { type: 'string' },
          kind: { type: 'string' },
          version: { type: 'string', default: '' },
          targets: { type: 'string', default: '' },
          repo: { type: 'string', default: '' },
          'assets-json': { type: 'string', default: '' },
          'dry-run': { type: 'boolean', default: false },
        },
        allowPositionals: false,
      });

      const tag = String(values.tag ?? '').trim();
      const kind = String(values.kind ?? '').trim();
      if (!tag) fail('--tag is required');
      if (!kind) fail('--kind is required');

      const version = String(values.version ?? '').trim();
      const targets = String(values.targets ?? '').trim();
      const repo = String(values.repo ?? '').trim();
      const assetsJson = String(values['assets-json'] ?? '').trim();
      const dryRun = values['dry-run'] === true;

      runGithubAuditReleaseAssets({
        repoRoot,
        env: { ...process.env },
        dryRun,
        args: [
          '--tag',
          tag,
          '--kind',
          kind,
          ...(version ? ['--version', version] : []),
          ...(targets ? ['--targets', targets] : []),
          ...(repo ? ['--repo', repo] : []),
          ...(assetsJson ? ['--assets-json', assetsJson] : []),
        ],
      });

        return;
      }

      if (subcommand === 'github-commit-and-push') {
        const { values } = parseArgs({
          args: rest,
          options: {
            paths: { type: 'string', default: '' },
            'allow-missing': { type: 'string', default: 'false' },
            message: { type: 'string', default: '' },
            'author-name': { type: 'string', default: '' },
            'author-email': { type: 'string', default: '' },
            remote: { type: 'string', default: '' },
            'push-ref': { type: 'string', default: '' },
            'push-mode': { type: 'string', default: '' },
            'allow-dirty': { type: 'string', default: 'false' },
            'dry-run': { type: 'boolean', default: false },
          },
          allowPositionals: false,
        });

        const paths = String(values.paths ?? '').trim();
        const allowMissing = String(values['allow-missing'] ?? '').trim() || 'false';
        const message = String(values.message ?? '').trim();
        const authorName = String(values['author-name'] ?? '').trim();
        const authorEmail = String(values['author-email'] ?? '').trim();
        const remote = String(values.remote ?? '').trim();
        const pushRef = String(values['push-ref'] ?? '').trim();
        const pushMode = String(values['push-mode'] ?? '').trim();
        const allowDirty = parseBoolString(values['allow-dirty'], '--allow-dirty');
        const dryRun = values['dry-run'] === true;
        if (!dryRun) assertCleanWorktree({ cwd: repoRoot, allowDirty });

        runGithubCommitAndPush({
          repoRoot,
          env: { ...process.env },
          dryRun,
          args: [
            ...(paths ? ['--paths', paths] : []),
            ...(allowMissing ? ['--allow-missing', allowMissing] : []),
            ...(message ? ['--message', message] : []),
            ...(authorName ? ['--author-name', authorName] : []),
            ...(authorEmail ? ['--author-email', authorEmail] : []),
            ...(remote ? ['--remote', remote] : []),
            ...(pushRef ? ['--push-ref', pushRef] : []),
            ...(pushMode ? ['--push-mode', pushMode] : []),
            ...(dryRun ? ['--dry-run'] : []),
          ],
        });

        return;
      }

      if (subcommand === 'github-publish-release') {
        const { values } = parseArgs({
          args: rest,
          options: {
            tag: { type: 'string' },
          title: { type: 'string' },
          'target-sha': { type: 'string' },
          prerelease: { type: 'string' },
          'rolling-tag': { type: 'string' },
          'generate-notes': { type: 'string' },
          notes: { type: 'string', default: '' },
          assets: { type: 'string', default: '' },
          'assets-dir': { type: 'string', default: '' },
          clobber: { type: 'string', default: 'true' },
          'prune-assets': { type: 'string', default: 'false' },
          'release-message': { type: 'string', default: '' },
          'allow-dirty': { type: 'string', default: 'false' },
          'dry-run': { type: 'boolean', default: false },
          'max-commits': { type: 'string', default: '200' },
          'secrets-source': { type: 'string', default: 'auto' },
          'keychain-service': { type: 'string', default: 'happier/pipeline' },
          'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const tag = String(values.tag ?? '').trim();
    const title = String(values.title ?? '').trim();
    const sha = String(values['target-sha'] ?? '').trim();
    if (!tag) fail('--tag is required');
    if (!title) fail('--title is required');
    if (!sha) fail('--target-sha is required');

    const { env, sources } = loadPipelineEnv({ repoRoot });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
        const { env: mergedEnv, usedKeychain } = loadSecrets({
          baseEnv: env,
          secretsSource,
          keychainService,
          keychainAccount,
        });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
      if (usedKeychain) {
        console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
      }

      const dryRun = values['dry-run'] === true;
      const allowDirty = parseBoolString(values['allow-dirty'], '--allow-dirty');
      if (!dryRun) assertCleanWorktree({ cwd: repoRoot, allowDirty });
      console.log(`[pipeline] github release: tag=${tag}`);

    runGithubPublishRelease({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--tag',
        tag,
        '--title',
        title,
        '--target-sha',
        sha,
        '--prerelease',
        String(values.prerelease ?? ''),
        '--rolling-tag',
        String(values['rolling-tag'] ?? ''),
        '--generate-notes',
        String(values['generate-notes'] ?? ''),
        '--notes',
        String(values.notes ?? ''),
        '--assets',
        String(values.assets ?? ''),
        '--assets-dir',
        String(values['assets-dir'] ?? ''),
        '--clobber',
        String(values.clobber ?? ''),
        '--prune-assets',
        String(values['prune-assets'] ?? ''),
        '--release-message',
        String(values['release-message'] ?? ''),
        '--max-commits',
        String(values['max-commits'] ?? ''),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });

    return;
  }

    if (subcommand === 'promote-branch') {
      const { values } = parseArgs({
        args: rest,
        options: {
          source: { type: 'string' },
          'source-sha': { type: 'string', default: '' },
          target: { type: 'string' },
          mode: { type: 'string' },
          confirm: { type: 'string', default: '' },
          'allow-reset': { type: 'string', default: 'false' },
          'summary-file': { type: 'string', default: '' },
          'allow-dirty': { type: 'string', default: 'false' },
          'dry-run': { type: 'boolean', default: false },
          'secrets-source': { type: 'string', default: 'auto' },
          'keychain-service': { type: 'string', default: 'happier/pipeline' },
          'keychain-account': { type: 'string', default: '' },
        },
      allowPositionals: false,
    });

    const source = String(values.source ?? '').trim();
    const sourceSha = String(values['source-sha'] ?? '').trim();
    const target = String(values.target ?? '').trim();
      const mode = String(values.mode ?? '').trim();
      const confirm = String(values.confirm ?? '').trim();
      const allowReset = String(values['allow-reset'] ?? '').trim();
      const summaryFile = String(values['summary-file'] ?? '').trim();
      const allowDirty = parseBoolString(values['allow-dirty'], '--allow-dirty');
      const dryRun = values['dry-run'] === true;
      if (!dryRun) assertCleanWorktree({ cwd: repoRoot, allowDirty });

      if (!source || !target || !mode) {
        fail('--source, --target, and --mode are required');
      }
      if (sourceSha && !FULL_GIT_SHA.test(sourceSha)) {
        fail('--source-sha must be a full 40-character lowercase Git commit SHA.');
      }
      if (!dryRun && !sourceSha) {
        fail('--source-sha is required unless --dry-run is set.');
      }

    const { env, sources } = loadPipelineEnv({ repoRoot });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
        const { env: mergedEnv, usedKeychain } = loadSecrets({
          baseEnv: env,
          secretsSource,
          keychainService,
          keychainAccount,
        });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

    console.log(`[pipeline] promote branch: ${source} -> ${target}`);

    runGithubPromoteBranch({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--source',
        source,
        ...(sourceSha ? ['--source-sha', sourceSha] : []),
        '--target',
        target,
        '--mode',
        mode,
        '--allow-reset',
        allowReset || 'false',
        '--confirm',
        confirm,
        ...(summaryFile ? ['--summary-file', summaryFile] : []),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });

    return;
  }

      if (subcommand === 'promote-deploy-branch') {
        const { values } = parseArgs({
          args: rest,
          options: {
            'deploy-environment': { type: 'string' },
            component: { type: 'string' },
            'source-ref': { type: 'string', default: '' },
            sha: { type: 'string', default: '' },
            'summary-file': { type: 'string', default: '' },
            'allow-dirty': { type: 'string', default: 'false' },
            'dry-run': { type: 'boolean', default: false },
            'secrets-source': { type: 'string', default: 'auto' },
            'keychain-service': { type: 'string', default: 'happier/pipeline' },
            'keychain-account': { type: 'string', default: '' },
          },
        allowPositionals: false,
      });

    const deployEnvironment = String(values['deploy-environment'] ?? '').trim();
    if (!isDeployEnvironment(deployEnvironment)) {
      fail(`--deploy-environment must be 'production' or 'preview' (got: ${deployEnvironment || '<empty>'})`);
    }
    const component = String(values.component ?? '').trim();
    if (!isDeployComponent(component)) {
      fail(`--component must be 'ui', 'server', 'website', or 'docs' (got: ${component || '<empty>'})`);
    }

    const { env, sources } = loadPipelineEnv({ repoRoot, deployEnvironment });
    const secretsSourceRaw = String(values['secrets-source'] ?? '').trim();
    const secretsSource =
      secretsSourceRaw === 'auto' || secretsSourceRaw === 'env' || secretsSourceRaw === 'keychain'
        ? secretsSourceRaw
        : 'auto';
    if (secretsSourceRaw && secretsSource !== secretsSourceRaw) {
      fail(`--secrets-source must be 'auto', 'env', or 'keychain' (got: ${secretsSourceRaw})`);
    }

      const keychainService = String(values['keychain-service'] ?? '').trim() || 'happier/pipeline';
      const keychainAccount = String(values['keychain-account'] ?? '').trim() || undefined;
          const { env: mergedEnv, usedKeychain } = loadSecrets({
            baseEnv: env,
            secretsSource,
            keychainService,
            keychainAccount,
          });
    if (sources.length > 0) {
      console.log(`[pipeline] using env sources: ${sources.join(', ')}`);
      console.log('[pipeline] warning: env-file mode is for fast local iteration; prefer Keychain bundle for long-term use.');
    }
    if (usedKeychain) {
      console.log(`[pipeline] loaded secrets from Keychain service '${keychainService}'`);
    }

        const sourceRef = String(values['source-ref'] ?? '').trim();
        const sha = String(values.sha ?? '').trim();
        const summaryFile = String(values['summary-file'] ?? '').trim();
        const allowDirty = parseBoolString(values['allow-dirty'], '--allow-dirty');
        const dryRun = values['dry-run'] === true;
        if (!dryRun) assertCleanWorktree({ cwd: repoRoot, allowDirty });

      const deployBranch = `deploy/${deployEnvironment}/${component}`;
      console.log(`[pipeline] promote deploy branch: ${deployBranch} <= ${sourceRef || sha}`);

      runGithubPromoteDeployBranch({
        repoRoot,
        env: mergedEnv,
        dryRun,
        args: [
          '--deploy-environment',
          deployEnvironment,
          '--component',
          component,
          ...(sourceRef ? ['--source-ref', sourceRef] : []),
          ...(sha ? ['--sha', sha] : []),
          ...(summaryFile ? ['--summary-file', summaryFile] : []),
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });

    return;
  }

        if (subcommand === 'release') {
          const { values } = parseArgs({
            args: rest,
            options: {
              confirm: { type: 'string' },
              repository: { type: 'string' },
              'deploy-environment': { type: 'string', default: 'preview' },
              'deploy-targets': { type: 'string', default: 'ui,server,website,docs' },
              'release-profile': { type: 'string', default: '' },
              'force-deploy': { type: 'string', default: 'false' },
              bump: { type: 'string', default: 'none' },
              'ui-expo-action': { type: 'string', default: 'none' },
              'desktop-mode': { type: 'string', default: 'none' },
              'source-sha': { type: 'string', default: '' },
              'workflow-control-sha': { type: 'string', default: '' },
              'operation-id': { type: 'string', default: '' },
              'attempt-id': { type: 'string', default: 'attempt_1' },
              'release-notes-id': { type: 'string', default: '' },
              'resume-run-id': { type: 'string', default: '' },
              'qualified-v4-activation-approval': { type: 'string', default: 'false' },
              'allow-dirty': { type: 'string', default: 'false' },
              'dry-run': { type: 'boolean', default: false },
              json: { type: 'boolean', default: false },
            },
            allowPositionals: false,
          });

          const action = String(values.confirm ?? '').trim();
          if (!action) fail('--confirm is required (e.g. "release dev to preview")');
          if (
            action !== 'release dev to dev' &&
            action !== 'release dev to preview' &&
            action !== 'release preview to main' &&
            action !== 'reset main from preview' &&
            action !== 'release dev to main' &&
            action !== 'reset main from dev'
          ) {
            fail(`Unsupported --confirm action: ${action}`);
          }

          const repository = String(values.repository ?? '').trim();
          if (!repository) fail('--repository is required (e.g. happier-dev/happier)');

          const deployEnvironment = String(values['deploy-environment'] ?? '').trim();
          if (!isReleaseDeployEnvironment(deployEnvironment)) {
            fail(`--deploy-environment must be 'dev', 'production', or 'preview' (got: ${deployEnvironment || '<empty>'})`);
          }
          if (deployEnvironment === 'dev' && action !== 'release dev to dev') {
            fail('Confirmation mismatch for dev releases. Expected: "release dev to dev"');
          }
          if (deployEnvironment === 'preview' && action !== 'release dev to preview') {
            fail('Confirmation mismatch for preview releases. Expected: "release dev to preview"');
          }
          if (deployEnvironment === 'production' && (action === 'release dev to dev' || action === 'release dev to preview')) {
            fail(
              'Confirmation mismatch for production releases. Expected: "release preview to main", "reset main from preview", "release dev to main", or "reset main from dev"',
            );
          }

          const dryRun = values['dry-run'] === true;
          const jsonOutput = values.json === true;
          const authorizedPromotionSourceSha = String(values['source-sha'] ?? '').trim();
          const workflowControlSha = String(values['workflow-control-sha'] ?? '').trim();
          const operationId = String(values['operation-id'] ?? '').trim();
          const attemptId = String(values['attempt-id'] ?? '').trim();
          const releaseNotesId = String(values['release-notes-id'] ?? '').trim();
          const resumeRunId = String(values['resume-run-id'] ?? '');
          const qualifiedV4ActivationApproval = parseBoolString(
            values['qualified-v4-activation-approval'],
            '--qualified-v4-activation-approval',
          );
          const promotionSourceBranch = resolveReleasePromotionSourceBranch(action);
          if (jsonOutput && !dryRun) {
            fail('--json is supported only with --dry-run.');
          }
          if (jsonOutput && !operationId) {
            fail('--operation-id is required with --dry-run --json.');
          }
          if (operationId && !RELEASE_OPERATION_ID.test(operationId)) {
            fail('--operation-id must match rel_ followed by 8-80 ASCII letters, digits, underscores, or hyphens.');
          }
          if (!/^attempt_[1-9][0-9]*$/u.test(attemptId)) {
            fail('--attempt-id must match attempt_<positive integer>.');
          }
          if (authorizedPromotionSourceSha && !FULL_GIT_SHA.test(authorizedPromotionSourceSha)) {
            fail('--source-sha must be a full 40-character lowercase Git commit SHA.');
          }
          if (workflowControlSha && !FULL_GIT_SHA.test(workflowControlSha)) {
            fail('--workflow-control-sha must be a full 40-character lowercase Git commit SHA.');
          }
          if (resumeRunId && !/^[1-9][0-9]*$/u.test(resumeRunId)) {
            fail('--resume-run-id must be a positive GitHub Actions run ID.');
          }
          const requestedReleaseProfile = String(values['release-profile'] ?? '').trim();
          const releaseProfileId = requestedReleaseProfile || (deployEnvironment === 'production' ? 'stable' : 'integrated');
          const releaseProfile = resolveReleaseValidationProfile(releaseProfileId);
          if (!releaseProfile) {
            fail(`--release-profile must be one of ${JSON.stringify(RELEASE_VALIDATION_PROFILE_IDS)} (got: ${releaseProfileId})`);
          }
          if (!dryRun && (!releaseProfile.normalRelease || !releaseProfile.checksProfile)) {
            fail(`--release-profile ${releaseProfile.id} is manual certification and cannot be used for normal dispatch`);
          }

          const deployTargets = parseCsvList(String(values['deploy-targets'] ?? ''));
          if (deployTargets.length === 0) {
            fail('--deploy-targets must not be empty');
          }
          for (const t of deployTargets) {
            if (!isReleaseTarget(t)) {
              fail(
                `--deploy-targets contains unsupported target '${t}' (supported: ${releaseTargets.join(',')})`,
              );
            }
          }
          const forceDeploy = parseBoolString(values['force-deploy'], '--force-deploy');
          const bumpPreset = String(values.bump ?? '').trim() || 'none';

          const uiExpoAction = String(values['ui-expo-action'] ?? '').trim() || 'none';
          const desktopMode = String(values['desktop-mode'] ?? '').trim() || 'none';

          if (!['none', 'patch', 'minor', 'major'].includes(bumpPreset)) {
            fail(`--bump must be one of: none, patch, minor, major (got: ${bumpPreset})`);
          }
          if (bumpPreset !== 'none') {
            fail(
              'Final exact-SHA release promotion requires --bump none. Release candidates must be materialized: commit CHANGELOG and version changes, resolve the resulting exact source SHA, then dispatch with --bump none.',
            );
          }
          if ((deployEnvironment !== 'dev' || jsonOutput) && !releaseNotesId) {
            fail('--release-notes-id is required for normal preview/production release dispatch.');
          }
          if (releaseNotesId && !RELEASE_NOTES_ID.test(releaseNotesId)) {
            fail('--release-notes-id must contain only lowercase letters, digits, dots, underscores, or hyphens.');
          }
          if (!['none', 'ota', 'native', 'native_submit'].includes(uiExpoAction)) {
            fail(`--ui-expo-action must be one of: none, ota, native, native_submit (got: ${uiExpoAction})`);
          }
          if (!['none', 'build_only', 'build_and_publish'].includes(desktopMode)) {
            fail(`--desktop-mode must be one of: none, build_only, build_and_publish (got: ${desktopMode})`);
          }

          const allowDirty = parseBoolString(values['allow-dirty'], '--allow-dirty');
          if (!dryRun) assertCleanWorktree({ cwd: repoRoot, allowDirty });
          assertNoStagedChanges({ cwd: repoRoot, allowDirty, dryRun });

          const resolvePromotionSource = () =>
            resolveAuthorizedReleaseSource({
              repoRoot,
              remoteUrl: 'origin',
              // A resumed attempt deliberately keeps the previously approved candidate
              // while newer trusted workflow-control code may live on dev. The origin
              // release status rebinds this exact SHA inside the hosted resolver.
              sourceRef: resumeRunId && authorizedPromotionSourceSha
                ? authorizedPromotionSourceSha
                : `refs/heads/${promotionSourceBranch}`,
              authorizedSha: authorizedPromotionSourceSha,
            });

          if (jsonOutput) {
            const promotionSource = await resolvePromotionSource();
            process.stdout.write(
              `${JSON.stringify({
                kind: 'happier.release-dispatch-plan.v3',
                schemaVersion: 3,
                sourceBranch: promotionSourceBranch,
                authorizedPromotionSourceSha: promotionSource.sha,
                effectiveDeployTargets: deployTargets,
                validationProfile: releaseProfile.id,
                operationId,
                releaseNotesId,
                ...(resumeRunId ? { resumeRunId } : {}),
                approvals: { qualifiedV4Activation: qualifiedV4ActivationApproval },
              })}\n`,
            );
            return;
          }

          if (!dryRun) {
            if (deployEnvironment === 'dev') {
              fail('Privileged dev publication is hosted by nightly-dev.yml; the local release command does not publish dev directly.');
            }
            if (!authorizedPromotionSourceSha) {
              fail('--source-sha is required when dispatching a hosted release.');
            }
            const promotionSource = await resolvePromotionSource();
            const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
              cwd: repoRoot,
              env: process.env,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 10_000,
            }).trim();
            if (!/(^|\/)(dev|upstream-dev)$/.test(currentBranch)) {
              fail(`Local release dispatch expects branch 'dev' or '*\\/upstream-dev' (current: ${currentBranch}).`);
            }
            execFileSync('gh', [
              'workflow', 'run', 'release.yml',
              '--repo', repository,
              '--ref', 'dev',
              '-f', 'dry_run=false',
              '-f', `validation_profile=${releaseProfile.id}`,
              '-f', `environment=${deployEnvironment}`,
              '-f', `deploy_targets=${deployTargets.join(',')}`,
              '-f', `force_deploy=${forceDeploy}`,
              '-f', `ui_expo_action=${uiExpoAction}`,
              '-f', `desktop_mode=${desktopMode}`,
              '-f', `bump=${bumpPreset}`,
              '-f', `confirm=${action}`,
              '-f', `authorized_promotion_source_sha=${promotionSource.sha}`,
              '-f', `release_notes_id=${releaseNotesId}`,
              '-f', `qualified_v4_activation_approval=${qualifiedV4ActivationApproval}`,
              ...(workflowControlSha ? ['-f', `workflow_control_sha=${workflowControlSha}`] : []),
              ...(operationId ? ['-f', `hmaint_operation_id=${operationId}`] : []),
              ...(operationId ? ['-f', `hmaint_attempt_id=${attemptId}`] : []),
              ...(resumeRunId ? ['-f', `resume_run_id=${resumeRunId}`] : []),
            ], {
              cwd: repoRoot,
              env: process.env,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 30_000,
            });
            console.log(`[pipeline] dispatched hosted release workflow for ${deployEnvironment}; privileged release writes run only in GitHub Actions.`);
            return;
          }

          console.log(`[pipeline] release: environment=${deployEnvironment} confirm=${action}`);

          const releaseRing = resolveReleaseEnvironmentChannel(deployEnvironment);

          if (releaseRing.rollingVersionPrefix) {
            // Ensure all rolling release steps have the same local sequence seed.
            // Locally we synthesize the missing run vars; in GitHub Actions we rely on the provided ones.
            const runNumberRaw = String(process.env.GITHUB_RUN_NUMBER ?? '').trim();
            const runNumber = runNumberRaw || String(Math.floor(Date.now() / 1000));

            console.log(`[pipeline] rolling version suffix: ${releaseRing.rollingVersionPrefix}.${runNumber}`);
          }

            // Plan: compute changed components (main..dev) and resolve bump/publish plan.
            console.log('[pipeline] release: resolving remote planning identities without updating local refs');
            const remotePlanningRefs = resolveRemoteReleasePlanningRefs({
              repoRoot,
              branchNames: ['main', 'dev', 'preview'],
              tagPrefixes: ['cli-v', 'stack-v', 'server-v', 'ui-web-v', 'plugin-sdk-v', 'sdk-v'],
            });

            const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
              cwd: repoRoot,
              env: process.env,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 10_000,
            }).trim();
            const isDevLikeLocalBranch = /(^|\/)(dev|upstream-dev)$/.test(currentBranch);
            if (!isDevLikeLocalBranch) {
              fail(`Local release expects to run from branch 'dev' or '*\\/upstream-dev' (current: ${currentBranch}).`);
            }

          const devSha = remotePlanningRefs.branches.dev;
          const mainSha = remotePlanningRefs.branches.main;
          const previewSha = remotePlanningRefs.branches.preview;
          const remotePromotionSourceSha = remotePlanningRefs.branches[promotionSourceBranch];
          if (authorizedPromotionSourceSha && authorizedPromotionSourceSha !== remotePromotionSourceSha) {
            fail(
              `Source branch '${promotionSourceBranch}' no longer resolves to authorized SHA '${authorizedPromotionSourceSha}' (currently '${remotePromotionSourceSha}').`,
            );
          }

          const planHeadSha =
            action === 'release preview to main' || action === 'reset main from preview' ? previewSha : devSha;

          const changedRaw = runJsonScript({
            repoRoot,
            env: { ...process.env },
            scriptRel: 'scripts/pipeline/release/compute-changed-components.mjs',
            args: ['--base', mainSha, '--head', planHeadSha],
          });

          const changed = {
            changed_ui: String(changedRaw?.changed_ui ?? '').trim() === 'true',
            changed_cli: String(changedRaw?.changed_cli ?? '').trim() === 'true',
            changed_server: String(changedRaw?.changed_server ?? '').trim() === 'true',
            changed_website: String(changedRaw?.changed_website ?? '').trim() === 'true',
            changed_docs: String(changedRaw?.changed_docs ?? '').trim() === 'true',
            changed_cli_stack_shared: String(changedRaw?.changed_cli_stack_shared ?? '').trim() === 'true',
            changed_shared: String(changedRaw?.changed_shared ?? '').trim() === 'true',
            changed_stack: String(changedRaw?.changed_stack ?? '').trim() === 'true',
            changed_plugin_sdk: String(changedRaw?.changed_plugin_sdk ?? '').trim() === 'true',
            changed_sdk: String(changedRaw?.changed_sdk ?? '').trim() === 'true',
          };

          const versionedChangedRaw = runJsonScript({
            repoRoot,
            env: { ...process.env },
            scriptRel: 'scripts/pipeline/release/compute-versioned-component-changes.mjs',
            args: [
              '--environment',
              deployEnvironment,
              '--head',
              planHeadSha,
              '--tag-refs-json',
              JSON.stringify(remotePlanningRefs.tags),
            ],
          });

          const versionedChanged = {
            changed_app: String(versionedChangedRaw?.changed_app ?? '').trim() === 'true',
            changed_cli: String(versionedChangedRaw?.changed_cli ?? '').trim() === 'true',
            changed_stack: String(versionedChangedRaw?.changed_stack ?? '').trim() === 'true',
            changed_server: String(versionedChangedRaw?.changed_server ?? '').trim() === 'true',
            changed_plugin_sdk: String(versionedChangedRaw?.changed_plugin_sdk ?? '').trim() === 'true',
            changed_sdk: String(versionedChangedRaw?.changed_sdk ?? '').trim() === 'true',
            app_baseline_tag: String(versionedChangedRaw?.app_baseline_tag ?? '').trim(),
            cli_baseline_tag: String(versionedChangedRaw?.cli_baseline_tag ?? '').trim(),
            stack_baseline_tag: String(versionedChangedRaw?.stack_baseline_tag ?? '').trim(),
            server_baseline_tag: String(versionedChangedRaw?.server_baseline_tag ?? '').trim(),
            plugin_sdk_baseline_tag: String(versionedChangedRaw?.plugin_sdk_baseline_tag ?? '').trim(),
            sdk_baseline_tag: String(versionedChangedRaw?.sdk_baseline_tag ?? '').trim(),
          };

          const bumpPlanRaw = runJsonScript({
            repoRoot,
            env: { ...process.env },
            scriptRel: 'scripts/pipeline/release/resolve-bump-plan.mjs',
            args: [
              '--environment',
              deployEnvironment,
              '--bump-preset',
              bumpPreset,
              '--bump-app-override',
              'preset',
              '--bump-cli-override',
              'preset',
              '--bump-stack-override',
              'preset',
              '--bump-plugin-sdk-override',
              'preset',
              '--bump-sdk-override',
              'preset',
              '--deploy-targets',
              deployTargets.join(','),
              '--changed-ui',
              changed.changed_ui ? 'true' : 'false',
              '--changed-cli',
              changed.changed_cli ? 'true' : 'false',
              '--changed-stack',
              changed.changed_stack ? 'true' : 'false',
              '--changed-server',
              changed.changed_server ? 'true' : 'false',
              '--changed-website',
              changed.changed_website ? 'true' : 'false',
              '--changed-cli-stack-shared',
              changed.changed_cli_stack_shared ? 'true' : 'false',
              '--changed-shared',
              changed.changed_shared ? 'true' : 'false',
              '--changed-plugin-sdk',
              changed.changed_plugin_sdk ? 'true' : 'false',
              '--changed-sdk',
              changed.changed_sdk ? 'true' : 'false',
              '--versioned-app-changed',
              versionedChanged.changed_app ? 'true' : 'false',
              '--versioned-cli-changed',
              versionedChanged.changed_cli ? 'true' : 'false',
              '--versioned-stack-changed',
              versionedChanged.changed_stack ? 'true' : 'false',
              '--versioned-server-changed',
              versionedChanged.changed_server ? 'true' : 'false',
              '--versioned-plugin-sdk-changed',
              versionedChanged.changed_plugin_sdk ? 'true' : 'false',
              '--versioned-sdk-changed',
              versionedChanged.changed_sdk ? 'true' : 'false',
            ],
          });

          const bumpPlan = {
            bump_app: String(bumpPlanRaw?.bump_app ?? 'none'),
            bump_cli: String(bumpPlanRaw?.bump_cli ?? 'none'),
            bump_stack: String(bumpPlanRaw?.bump_stack ?? 'none'),
            bump_server: String(bumpPlanRaw?.bump_server ?? 'none'),
            bump_website: String(bumpPlanRaw?.bump_website ?? 'none'),
            bump_plugin_sdk: String(bumpPlanRaw?.bump_plugin_sdk ?? 'none'),
            bump_sdk: String(bumpPlanRaw?.bump_sdk ?? 'none'),
            should_bump: String(bumpPlanRaw?.should_bump ?? '').trim() === 'true',
            publish_cli: String(bumpPlanRaw?.publish_cli ?? '').trim() === 'true',
            publish_stack: String(bumpPlanRaw?.publish_stack ?? '').trim() === 'true',
            publish_server: String(bumpPlanRaw?.publish_server ?? '').trim() === 'true',
            publish_plugin_sdk: String(bumpPlanRaw?.publish_plugin_sdk ?? '').trim() === 'true',
            publish_sdk: String(bumpPlanRaw?.publish_sdk ?? '').trim() === 'true',
          };

          console.log('[pipeline] release plan: changed components (main..dev)');
          for (const [k, v] of Object.entries(changed)) {
            console.log(`- ${k.replace(/^changed_/, '')}: ${v}`);
          }
          console.log('[pipeline] release plan: versioned components since latest release tags');
          console.log(`- app: ${versionedChanged.changed_app} (baseline=${versionedChanged.app_baseline_tag || 'none'})`);
          console.log(`- cli: ${versionedChanged.changed_cli} (baseline=${versionedChanged.cli_baseline_tag || 'none'})`);
          console.log(`- stack: ${versionedChanged.changed_stack} (baseline=${versionedChanged.stack_baseline_tag || 'none'})`);
          console.log(`- server: ${versionedChanged.changed_server} (baseline=${versionedChanged.server_baseline_tag || 'none'})`);
          console.log(`- plugin SDK pair: ${versionedChanged.changed_plugin_sdk} (baseline=${versionedChanged.plugin_sdk_baseline_tag || 'none'})`);
          console.log(`- SDK: ${versionedChanged.changed_sdk} (baseline=${versionedChanged.sdk_baseline_tag || 'none'})`);
          console.log('[pipeline] release plan: bump/publish');
          console.log(
            `- bump_app=${bumpPlan.bump_app} bump_server=${bumpPlan.bump_server} bump_website=${bumpPlan.bump_website} bump_cli=${bumpPlan.bump_cli} bump_stack=${bumpPlan.bump_stack} bump_plugin_sdk=${bumpPlan.bump_plugin_sdk} bump_sdk=${bumpPlan.bump_sdk}`,
          );
          console.log(
            `- publish_cli=${bumpPlan.publish_cli} publish_stack=${bumpPlan.publish_stack} publish_server=${bumpPlan.publish_server} publish_plugin_sdk=${bumpPlan.publish_plugin_sdk} publish_sdk=${bumpPlan.publish_sdk}`,
          );

          /**
           * @param {string} sourceRef
           */
          const computeDeployPlan = (sourceRef) =>
            runJsonScript({
              repoRoot,
              env: { ...process.env },
              scriptRel: 'scripts/pipeline/release/compute-deploy-plan.mjs',
              args: [
                '--deploy-environment',
                deployEnvironment,
                '--source-ref',
                sourceRef,
                '--force-deploy',
                forceDeploy ? 'true' : 'false',
                '--deploy-ui',
                deployEnvironment === 'production' && deployTargets.includes('ui') ? 'true' : 'false',
                '--deploy-server',
                deployTargets.includes('server') ? 'true' : 'false',
                '--deploy-website',
                deployTargets.includes('website') ? 'true' : 'false',
                '--deploy-docs',
                deployTargets.includes('docs') ? 'true' : 'false',
              ],
            });

          if (dryRun) {
            const deployPlan =
              deployEnvironment === 'dev'
                ? {
                    deploy_ui: { needed: false },
                    deploy_server: { needed: false },
                    deploy_website: { needed: false },
                    deploy_docs: { needed: false },
                  }
                : computeDeployPlan(releaseRing.sourceRef);
            console.log('[pipeline] release plan: deploy facts');
            for (const [component, plan] of Object.entries(deployPlan)) {
              console.log(`- ${component.replace(/^deploy_/, '')}: needed=${String(plan?.needed === true)}`);
            }
            if (deployEnvironment === 'dev') {
              console.log('[pipeline] dry-run: hosted dispatch is owned by nightly-dev.yml');
            } else {
              console.log('[pipeline] dry-run: hosted dispatch inputs');
              console.log('- workflow: release.yml');
            }
            console.log(`- environment: ${deployEnvironment}`);
            console.log(`- promotion_source_branch: ${promotionSourceBranch}`);
            console.log(`- authorized_promotion_source_sha: ${remotePromotionSourceSha}`);
            console.log(`- deploy_targets: ${deployTargets.join(',')}`);
            console.log(`- release_profile: ${releaseProfile.id}`);
            console.log(`- checks_profile: ${releaseProfile.checksProfile ?? 'manual'}`);
            console.log(`- force_deploy: ${forceDeploy}`);
            console.log(`- ui_expo_action: ${uiExpoAction}`);
            console.log(`- desktop_mode: ${desktopMode}`);
            console.log(`- bump: ${bumpPreset}`);
            console.log(`- confirm: ${action}`);
            return;
          }

        }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
