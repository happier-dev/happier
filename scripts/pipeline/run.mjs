// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadPipelineEnv } from './env/load-pipeline-env.mjs';
import { loadSecrets } from './secrets/load-secrets.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
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
  return isDeployComponent(v) || v === 'cli' || v === 'stack' || v === 'server_runner';
}

/**
 * @param {string} v
 * @returns {v is 'stable' | 'preview'}
 */
function isDockerChannel(v) {
  return v === 'stable' || v === 'preview';
}

/**
 * @param {string} v
 * @returns {v is 'stable' | 'preview'}
 */
function isRollingReleaseChannel(v) {
  return v === 'stable' || v === 'preview';
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
 * @param {unknown} value
 * @param {string} name
 * @param {boolean} autoValue
 */
function resolveAutoBool(value, name, autoValue) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto') return autoValue;
  return parseBoolString(raw, name);
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

function main() {
  const repoRoot = repoRootFromHere();

  const [subcommandRaw, ...rest] = process.argv.slice(2);
  const subcommand = String(subcommandRaw ?? '').trim();
	  if (!subcommand) {
	    fail(
	      'Usage: node scripts/pipeline/run.mjs <deploy|npm-publish|npm-release|publish-ui-web|publish-server-runtime|release-bump-plan|release-bump-versions-dev|release-sync-installers|release-bump-version|release-build-cli-binaries|release-build-hstack-binaries|release-build-server-binaries|release-publish-manifests|release-verify-artifacts|release-compute-changed-components|release-resolve-bump-plan|release-compute-deploy-plan|release-build-ui-web-bundle|expo-ota|expo-native-build|expo-download-apk|expo-mobile-meta|expo-submit|expo-publish-apk-release|ui-mobile-release|tauri-prepare-assets|docker-publish|github-publish-release|promote-branch|promote-deploy-branch|release> [args...]',
	    );
	  }

  if (
    subcommand !== 'deploy' &&
    subcommand !== 'npm-publish' &&
    subcommand !== 'npm-release' &&
    subcommand !== 'publish-ui-web' &&
	    subcommand !== 'publish-server-runtime' &&
	    subcommand !== 'release-bump-plan' &&
	    subcommand !== 'release-bump-versions-dev' &&
	    subcommand !== 'release-sync-installers' &&
	    subcommand !== 'release-bump-version' &&
	    subcommand !== 'release-build-cli-binaries' &&
	    subcommand !== 'release-build-hstack-binaries' &&
	    subcommand !== 'release-build-server-binaries' &&
	    subcommand !== 'release-publish-manifests' &&
	    subcommand !== 'release-verify-artifacts' &&
	    subcommand !== 'release-compute-changed-components' &&
	    subcommand !== 'release-resolve-bump-plan' &&
	    subcommand !== 'release-compute-deploy-plan' &&
	    subcommand !== 'release-build-ui-web-bundle' &&
	    subcommand !== 'expo-ota' &&
	    subcommand !== 'expo-native-build' &&
	    subcommand !== 'expo-download-apk' &&
    subcommand !== 'expo-mobile-meta' &&
    subcommand !== 'expo-submit' &&
    subcommand !== 'expo-publish-apk-release' &&
    subcommand !== 'ui-mobile-release' &&
    subcommand !== 'tauri-prepare-assets' &&
    subcommand !== 'docker-publish' &&
    subcommand !== 'github-publish-release' &&
    subcommand !== 'promote-branch' &&
    subcommand !== 'promote-deploy-branch' &&
    subcommand !== 'release'
  ) {
    fail(`Unsupported subcommand: ${subcommand}`);
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

  if (subcommand === 'npm-publish') {
    const { values } = parseArgs({
      args: rest,
      options: {
        channel: { type: 'string' },
        tag: { type: 'string', default: '' },
        tarball: { type: 'string', default: '' },
        'tarball-dir': { type: 'string', default: '' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const channel = String(values.channel ?? '').trim();
    if (!isDeployEnvironment(channel)) {
      fail(`--channel must be 'production' or 'preview' (got: ${channel || '<empty>'})`);
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
    const dryRun = values['dry-run'] === true;

    console.log(`[pipeline] npm publish: channel=${channel}`);

    runNpmPublishTarball({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--channel',
        channel,
        ...(tag ? ['--tag', tag] : []),
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
        'server-runner-dir': { type: 'string', default: 'packages/relay-server' },
        'run-tests': { type: 'string', default: 'true' },
        mode: { type: 'string', default: 'pack+publish' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const channel = String(values.channel ?? '').trim();
    if (!isDeployEnvironment(channel)) {
      fail(`--channel must be 'production' or 'preview' (got: ${channel || '<empty>'})`);
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
    const runnerDir = String(values['server-runner-dir'] ?? '').trim();
    const runTests = String(values['run-tests'] ?? '').trim();
    const mode = String(values.mode ?? '').trim();
    const dryRun = values['dry-run'] === true;

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
        'run-contracts': { type: 'string', default: 'true' },
        'check-installers': { type: 'string', default: 'true' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const channel = String(values.channel ?? '').trim();
    if (!isRollingReleaseChannel(channel)) {
      fail(`--channel must be 'stable' or 'preview' (got: ${channel || '<empty>'})`);
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

    const allowStable = String(values['allow-stable'] ?? '').trim();
    const releaseMessage = String(values['release-message'] ?? '').trim();
    const runContracts = String(values['run-contracts'] ?? '').trim();
    const checkInstallers = String(values['check-installers'] ?? '').trim();
    const dryRun = values['dry-run'] === true;

    runPublishUiWeb({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--channel',
        channel,
        '--allow-stable',
        allowStable || 'false',
        '--release-message',
        releaseMessage,
        '--run-contracts',
        runContracts || 'true',
        '--check-installers',
        checkInstallers || 'true',
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
        'run-contracts': { type: 'string', default: 'true' },
        'check-installers': { type: 'string', default: 'true' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const channel = String(values.channel ?? '').trim();
    if (!isRollingReleaseChannel(channel)) {
      fail(`--channel must be 'stable' or 'preview' (got: ${channel || '<empty>'})`);
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

    const allowStable = String(values['allow-stable'] ?? '').trim();
    const releaseMessage = String(values['release-message'] ?? '').trim();
    const runContracts = String(values['run-contracts'] ?? '').trim();
    const checkInstallers = String(values['check-installers'] ?? '').trim();
    const dryRun = values['dry-run'] === true;

    runPublishServerRuntime({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--channel',
        channel,
        '--allow-stable',
        allowStable || 'false',
        '--release-message',
        releaseMessage,
        '--run-contracts',
        runContracts || 'true',
        '--check-installers',
        checkInstallers || 'true',
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
        'deploy-targets': { type: 'string', default: '' },
        'changed-ui': { type: 'string' },
        'changed-cli': { type: 'string' },
        'changed-stack': { type: 'string' },
        'changed-server': { type: 'string' },
        'changed-website': { type: 'string' },
        'changed-shared': { type: 'string' },
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
        '--changed-shared',
        String(values['changed-shared'] ?? ''),
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
        '--push-branch',
        String(values['push-branch'] ?? 'dev'),
        '--commit-message',
        String(values['commit-message'] ?? ''),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });
	    return;
	  }

	  if (
	    subcommand === 'release-sync-installers' ||
	    subcommand === 'release-bump-version' ||
	    subcommand === 'release-build-cli-binaries' ||
	    subcommand === 'release-build-hstack-binaries' ||
	    subcommand === 'release-build-server-binaries' ||
	    subcommand === 'release-publish-manifests' ||
	    subcommand === 'release-verify-artifacts' ||
	    subcommand === 'release-compute-changed-components' ||
	    subcommand === 'release-resolve-bump-plan' ||
	    subcommand === 'release-compute-deploy-plan' ||
	    subcommand === 'release-build-ui-web-bundle'
	  ) {
	    const { values, positionals } = parseArgs({
	      args: rest,
	      options: {
	        'deploy-environment': { type: 'string', default: 'production' },
	        'dry-run': { type: 'boolean', default: false },
	        'secrets-source': { type: 'string', default: 'auto' },
	        'keychain-service': { type: 'string', default: 'happier/pipeline' },
	        'keychain-account': { type: 'string', default: '' },
	      },
	      allowPositionals: true,
	      strict: false,
	    });

	    const deployEnvironment = String(values['deploy-environment'] ?? '').trim() || 'production';
	    if (!isDeployEnvironment(deployEnvironment)) {
	      fail(`--deploy-environment must be 'production' or 'preview' (got: ${deployEnvironment || '<empty>'})`);
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
	    const dryRun = values['dry-run'] === true;

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
	                : subcommand === 'release-publish-manifests'
	                  ? 'publish-manifests.mjs'
	                  : subcommand === 'release-verify-artifacts'
	                    ? 'verify-artifacts.mjs'
	                    : subcommand === 'release-compute-changed-components'
	                      ? 'compute-changed-components.mjs'
	                      : subcommand === 'release-resolve-bump-plan'
	                        ? 'resolve-bump-plan.mjs'
	                        : subcommand === 'release-compute-deploy-plan'
	                          ? 'compute-deploy-plan.mjs'
	                          : 'build-ui-web-bundle.mjs';

	    if (dryRun) {
	      runReleaseWrappedScript({
	        repoRoot,
	        env: process.env,
	        scriptFile,
	        args: positionals,
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
	      args: positionals,
	      dryRun: false,
	    });
	    return;
	  }

	  if (subcommand === 'expo-ota') {
	    const { values } = parseArgs({
	      args: rest,
	      options: {
	        environment: { type: 'string' },
        message: { type: 'string', default: '' },
        'eas-cli-version': { type: 'string', default: '' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const environment = String(values.environment ?? '').trim();
    if (environment !== 'preview' && environment !== 'production') {
      fail(`--environment must be 'preview' or 'production' (got: ${environment || '<empty>'})`);
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

    const message = String(values.message ?? '').trim();
    const easCliVersion = String(values['eas-cli-version'] ?? '').trim();
    const dryRun = values['dry-run'] === true;

    runExpoOtaUpdate({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--environment',
        environment,
        ...(message ? ['--message', message] : []),
        ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
        ...(dryRun ? ['--dry-run'] : []),
      ],
    });

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
	        'eas-cli-version': { type: 'string', default: '' },
	        'dump-view': { type: 'string', default: 'true' },
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
	    const buildMode = String(values['build-mode'] ?? '').trim();
	    const localRuntime = String(values['local-runtime'] ?? '').trim();
	    const artifactOut = String(values['artifact-out'] ?? '').trim();
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
	        ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
	        ...(dumpView ? ['--dump-view', dumpView] : []),
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
	        path: { type: 'string', default: '' },
	        profile: { type: 'string', default: '' },
	        'eas-cli-version': { type: 'string', default: '' },
	        'dry-run': { type: 'boolean', default: false },
	        'secrets-source': { type: 'string', default: 'auto' },
	        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const environment = String(values.environment ?? '').trim();
    const platform = String(values.platform ?? '').trim();
    if (!environment || !platform) {
      fail('--environment and --platform are required');
    }
    if (environment !== 'preview' && environment !== 'production') {
      fail(`--environment must be 'preview' or 'production' (got: ${environment || '<empty>'})`);
    }
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
	    const profile = String(values.profile ?? '').trim();
	    const submitPath = String(values.path ?? '').trim();
	    const dryRun = values['dry-run'] === true;

	    runExpoSubmit({
	      repoRoot,
      env: mergedEnv,
      dryRun,
	      args: [
	        '--environment',
	        environment,
	        '--platform',
	        platform,
	        ...(submitPath ? ['--path', submitPath] : []),
	        ...(profile ? ['--profile', profile] : []),
	        ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
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

    const environment = String(values.environment ?? '').trim();
    if (environment !== 'preview' && environment !== 'production') {
      fail(`--environment must be 'preview' or 'production' (got: ${environment || '<empty>'})`);
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
        environment,
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

    const environment = String(values.environment ?? '').trim();
    if (environment !== 'preview' && environment !== 'production') {
      fail(`--environment must be 'preview' or 'production' (got: ${environment || '<empty>'})`);
    }
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
        environment,
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
        'target-sha': { type: 'string' },
        'release-message': { type: 'string', default: '' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const environment = String(values.environment ?? '').trim();
    if (environment !== 'preview' && environment !== 'production') {
      fail(`--environment must be 'preview' or 'production' (got: ${environment || '<empty>'})`);
    }

    const apkPath = String(values['apk-path'] ?? '').trim();
    const targetSha = String(values['target-sha'] ?? '').trim();
    if (!apkPath) fail('--apk-path is required');
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
        environment,
        '--apk-path',
        apkPath,
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
	        'eas-cli-version': { type: 'string', default: '' },
	        'dump-view': { type: 'string', default: '' },
	        'release-message': { type: 'string', default: '' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const environment = String(values.environment ?? '').trim();
    if (environment !== 'preview' && environment !== 'production') {
      fail(`--environment must be 'preview' or 'production' (got: ${environment || '<empty>'})`);
    }

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

    const profile = String(values.profile ?? '').trim();
    if ((action === 'native' || action === 'native_submit') && !profile) {
      fail('--profile is required for native actions');
    }
    const publishApkReleaseMode = String(values['publish-apk-release'] ?? '').trim().toLowerCase() || 'auto';
    if (publishApkReleaseMode !== 'auto' && publishApkReleaseMode !== 'true' && publishApkReleaseMode !== 'false') {
      fail(`--publish-apk-release must be 'auto', 'true', or 'false' (got: ${values['publish-apk-release']})`);
    }

	    const buildJson = String(values['build-json'] ?? '').trim() || '/tmp/eas_build.json';
	    const outDir = String(values['out-dir'] ?? '').trim() || 'dist/ui-mobile';
	    const easCliVersion = String(values['eas-cli-version'] ?? '').trim();
	    const dumpView = String(values['dump-view'] ?? '').trim();
	    const releaseMessage = String(values['release-message'] ?? '').trim();
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

	    const { env, sources } = loadPipelineEnv({ repoRoot, deployEnvironment: environment });
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

	    console.log(`[pipeline] ui-mobile release: environment=${environment} action=${action} platform=${platform}`);

	    if (action === 'ota') {
      runExpoOtaUpdate({
        repoRoot,
        env: mergedEnv,
        dryRun,
        args: [
          '--environment',
          environment,
          ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });
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
	      let ext = 'ipa';
	      if (p === 'android') {
	        ext = profile.endsWith('-apk') ? 'apk' : 'aab';
	      }
	      const base =
	        environment === 'production'
	          ? `happier-production-${p}-v${appVersion}.${ext}`
	          : `happier-preview-${p}.${ext}`;
	      return path.join(outDir, base);
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
	    const shouldPublishApkRelease =
	      publishApkReleaseMode === 'true'
	        ? true
	        : publishApkReleaseMode === 'false'
	          ? false
	          : nativeBuildMode === 'local'
	            ? shouldHandleAndroid && localArtifactOutForPlatform('android', appVersion || '0.0.0').endsWith('.apk')
	            : shouldHandleAndroid && profile.endsWith('-apk');

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
	            ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
	            ...(dumpView ? ['--dump-view', dumpView] : []),
	            ...(dryRun ? ['--dry-run'] : []),
	          ],
	        });
	      }
	    } else {
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
	          ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
	          ...(dumpView ? ['--dump-view', dumpView] : []),
	          ...(dryRun ? ['--dry-run'] : []),
	        ],
	      });
	    }

	    if (shouldPublishApkRelease) {
	      let apkPath = '';
	      if (nativeBuildMode === 'local') {
	        apkPath = localArtifactOutForPlatform('android', appVersion || '0.0.0');
	        if (!apkPath.endsWith('.apk')) {
	          fail('Android APK release publishing requires an *-apk EAS profile (preview-apk or production-apk).');
	        }
	      } else {
	        if (!profile.endsWith('-apk')) {
	          fail('Android APK release publishing requires an *-apk EAS profile (preview-apk or production-apk).');
	        }
	        runExpoDownloadAndroidApk({
	          repoRoot,
	          env: mergedEnv,
	          dryRun,
	          args: [
	            '--environment',
	            environment,
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
	          environment === 'preview'
	            ? path.join(outDir, 'happier-preview-android.apk')
	            : path.join(outDir, `happier-production-android-v${appVersion}.apk`);
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
          environment,
          '--apk-path',
          apkPath,
          '--target-sha',
          sha,
          ...(releaseMessage ? ['--release-message', releaseMessage] : []),
          ...(dryRun ? ['--dry-run'] : []),
	        ],
	      });
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
	              environment,
	              '--platform',
	              p,
	              '--path',
	              rel,
	              ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
	              ...(dryRun ? ['--dry-run'] : []),
	            ],
	          });
	        }
	      } else {
	        runExpoSubmit({
	          repoRoot,
	          env: mergedEnv,
	          dryRun,
	          args: [
	            '--environment',
	            environment,
	            '--platform',
	            platform,
	            ...(easCliVersion ? ['--eas-cli-version', easCliVersion] : []),
	            ...(dryRun ? ['--dry-run'] : []),
	          ],
	        });
	      }
	    }

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

    const environment = String(values.environment ?? '').trim();
    if (environment !== 'preview' && environment !== 'production') {
      fail(`--environment must be 'preview' or 'production' (got: ${environment || '<empty>'})`);
    }
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
        environment,
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

  if (subcommand === 'docker-publish') {
    const { values } = parseArgs({
      args: rest,
      options: {
        channel: { type: 'string' },
        sha: { type: 'string', default: '' },
        'push-latest': { type: 'string', default: 'true' },
        'build-relay': { type: 'string', default: 'true' },
        'build-devcontainer': { type: 'string', default: 'true' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const channel = String(values.channel ?? '').trim();
    if (!isDockerChannel(channel)) {
      fail(`--channel must be 'stable' or 'preview' (got: ${channel || '<empty>'})`);
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
    const pushLatest = String(values['push-latest'] ?? '').trim();
    const buildRelay = String(values['build-relay'] ?? '').trim();
    const buildDevcontainer = String(values['build-devcontainer'] ?? '').trim();
    const dryRun = values['dry-run'] === true;

    console.log(`[pipeline] docker publish: channel=${channel}`);

    runDockerPublishImages({
      repoRoot,
      env: mergedEnv,
      dryRun,
      args: [
        '--channel',
        channel,
        ...(sha ? ['--sha', sha] : []),
        ...(pushLatest ? ['--push-latest', pushLatest] : []),
        ...(buildRelay ? ['--build-relay', buildRelay] : []),
        ...(buildDevcontainer ? ['--build-devcontainer', buildDevcontainer] : []),
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
        target: { type: 'string' },
        mode: { type: 'string' },
        confirm: { type: 'string', default: '' },
        'allow-reset': { type: 'string', default: 'false' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const source = String(values.source ?? '').trim();
    const target = String(values.target ?? '').trim();
    const mode = String(values.mode ?? '').trim();
    const confirm = String(values.confirm ?? '').trim();
    const allowReset = String(values['allow-reset'] ?? '').trim();
    const dryRun = values['dry-run'] === true;

    if (!source || !target || !mode) {
      fail('--source, --target, and --mode are required');
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
        '--target',
        target,
        '--mode',
        mode,
        '--allow-reset',
        allowReset || 'false',
        '--confirm',
        confirm,
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
    const dryRun = values['dry-run'] === true;

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
        'deploy-environment': { type: 'string', default: 'production' },
        'deploy-targets': { type: 'string', default: 'ui,server,website,docs' },
        'publish-docker': { type: 'string', default: 'auto' },
        'publish-ui-web': { type: 'string', default: 'auto' },
        'publish-server-runtime': { type: 'string', default: 'auto' },
        'release-message': { type: 'string', default: '' },
        'npm-targets': { type: 'string', default: '' },
        'npm-mode': { type: 'string', default: 'pack+publish' },
        'npm-run-tests': { type: 'string', default: 'true' },
        'npm-server-runner-dir': { type: 'string', default: 'packages/relay-server' },
        'dry-run': { type: 'boolean', default: false },
        'secrets-source': { type: 'string', default: 'auto' },
        'keychain-service': { type: 'string', default: 'happier/pipeline' },
        'keychain-account': { type: 'string', default: '' },
      },
      allowPositionals: false,
    });

    const action = String(values.confirm ?? '').trim();
    if (!action) {
      fail('--confirm is required (e.g. "release preview from dev")');
    }
    if (action !== 'release preview from dev' && action !== 'release dev to main' && action !== 'reset main from dev') {
      fail(`Unsupported --confirm action: ${action}`);
    }

    const repository = String(values.repository ?? '').trim();
    if (!repository) {
      fail('--repository is required (e.g. happier-dev/happier)');
    }

    const deployEnvironment = String(values['deploy-environment'] ?? '').trim();
    if (!isDeployEnvironment(deployEnvironment)) {
      fail(`--deploy-environment must be 'production' or 'preview' (got: ${deployEnvironment || '<empty>'})`);
    }

    const deployTargets = parseCsvList(String(values['deploy-targets'] ?? ''));
    if (deployTargets.length === 0) {
      fail('--deploy-targets must not be empty');
    }
    for (const t of deployTargets) {
      if (!isReleaseTarget(t)) {
        fail(`--deploy-targets contains unsupported target '${t}' (supported: ui,server,website,docs,cli,stack,server_runner)`);
      }
    }

    const dryRun = values['dry-run'] === true;

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

    console.log(`[pipeline] release: action=${action}`);

    const releaseChannel = action === 'release preview from dev' ? 'preview' : 'production';
    const releaseMessage = String(values['release-message'] ?? '').trim();

    let sourceRef = 'dev';
    if (action === 'release dev to main') {
      console.log('[pipeline] promote main from dev');
      runGithubPromoteBranch({
        repoRoot,
        env: mergedEnv,
        dryRun,
        args: [
          '--source',
          'dev',
          '--target',
          'main',
          '--mode',
          'fast_forward',
          '--allow-reset',
          'false',
          '--confirm',
          'promote main from dev',
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });
      sourceRef = 'main';
    } else if (action === 'reset main from dev') {
      console.log('[pipeline] reset main from dev');
      runGithubPromoteBranch({
        repoRoot,
        env: mergedEnv,
        dryRun,
        args: [
          '--source',
          'dev',
          '--target',
          'main',
          '--mode',
          'reset',
          '--allow-reset',
          'true',
          '--confirm',
          'reset main from dev',
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });
      sourceRef = 'main';
    }

    const npmTargetsExplicit = parseCsvList(String(values['npm-targets'] ?? ''));
    const npmTargetsDerived = [
      ...(deployTargets.includes('cli') ? ['cli'] : []),
      ...(deployTargets.includes('stack') ? ['stack'] : []),
      ...(deployTargets.includes('server_runner') ? ['server'] : []),
    ];
    const npmTargets = npmTargetsExplicit.length > 0 ? npmTargetsExplicit : npmTargetsDerived;
    const npmMode = String(values['npm-mode'] ?? '').trim() || 'pack+publish';
    const npmRunTests = String(values['npm-run-tests'] ?? '').trim() || 'true';
    const npmServerRunnerDir = String(values['npm-server-runner-dir'] ?? '').trim() || 'packages/relay-server';
    if (npmMode !== 'pack' && npmMode !== 'pack+publish') {
      fail(`--npm-mode must be 'pack' or 'pack+publish' (got: ${npmMode})`);
    }
    for (const t of npmTargets) {
      if (t !== 'cli' && t !== 'stack' && t !== 'server') {
        fail(`--npm-targets contains unsupported target '${t}' (supported: cli, stack, server)`);
      }
    }

    if (npmTargets.length > 0) {
      const publishCli = npmTargets.includes('cli') ? 'true' : 'false';
      const publishStack = npmTargets.includes('stack') ? 'true' : 'false';
      const publishServer = npmTargets.includes('server') ? 'true' : 'false';
      console.log(`[pipeline] release: npm channel=${releaseChannel} targets=${npmTargets.join(',')}`);

      runNpmReleasePackages({
        repoRoot,
        env: mergedEnv,
        dryRun,
        args: [
          '--channel',
          releaseChannel,
          '--publish-cli',
          publishCli,
          '--publish-stack',
          publishStack,
          '--publish-server',
          publishServer,
          '--server-runner-dir',
          npmServerRunnerDir,
          '--run-tests',
          npmRunTests,
          '--mode',
          npmMode,
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });
    }

    const publishDocker = resolveAutoBool(values['publish-docker'], '--publish-docker', releaseChannel === 'preview');
    const publishUiWeb = resolveAutoBool(
      values['publish-ui-web'],
      '--publish-ui-web',
      releaseChannel === 'preview' && deployTargets.includes('ui'),
    );
    const publishServerRuntime = resolveAutoBool(
      values['publish-server-runtime'],
      '--publish-server-runtime',
      releaseChannel === 'preview' && deployTargets.includes('server_runner'),
    );

    if (releaseChannel === 'preview' && publishUiWeb) {
      console.log('[pipeline] release: publish ui-web rolling release (preview)');
      runPublishUiWeb({
        repoRoot,
        env: mergedEnv,
        dryRun,
        args: [
          '--channel',
          'preview',
          '--allow-stable',
          'false',
          '--release-message',
          releaseMessage,
          '--run-contracts',
          'true',
          '--check-installers',
          'true',
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });
    }

    if (releaseChannel === 'preview' && publishServerRuntime) {
      console.log('[pipeline] release: publish server-runtime rolling release (preview)');
      runPublishServerRuntime({
        repoRoot,
        env: mergedEnv,
        dryRun,
        args: [
          '--channel',
          'preview',
          '--allow-stable',
          'false',
          '--release-message',
          releaseMessage,
          '--run-contracts',
          'true',
          '--check-installers',
          'true',
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });
    }

    if (releaseChannel === 'preview' && publishDocker) {
      console.log('[pipeline] release: publish docker images (preview)');
      console.log('[pipeline] docker publish: channel=preview');
      runDockerPublishImages({
        repoRoot,
        env: mergedEnv,
        dryRun,
        args: [
          '--channel',
          'preview',
          '--push-latest',
          'true',
          '--build-relay',
          'true',
          '--build-devcontainer',
          'true',
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });
    }

    const deployComponents = deployTargets.filter((t) => isDeployComponent(t));
    for (const component of deployComponents) {
      const refName = `deploy/${deployEnvironment}/${component}`;
      console.log(`[pipeline] promote deploy branch: ${refName} <= ${sourceRef}`);

      runGithubPromoteDeployBranch({
        repoRoot,
        env: mergedEnv,
        dryRun,
        args: [
          '--deploy-environment',
          deployEnvironment,
          '--component',
          component,
          '--source-ref',
          sourceRef,
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });

      console.log(`[pipeline] trigger deploy webhooks: ${component}`);
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
          ...(dryRun ? ['--sha', '0123456789abcdef0123456789abcdef01234567'] : []),
          ...(dryRun ? ['--dry-run'] : []),
        ],
      });
    }

    return;
  }
}

main();
