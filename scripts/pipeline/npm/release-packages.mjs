// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { resolveWindowsCommandInvocation } from '../lib/windows/resolveWindowsCommandInvocation.mjs';
import { resolvePackedTarball } from './resolvePackedTarball.mjs';
import { resolveCliPublicationBuildSteps } from '../../../apps/cli/scripts/buildPublication.mjs';
import {
  formatPublicReleaseChannel,
  formatPublicReleaseChannelChoices,
  normalizePublicReleaseChannel,
} from '../release/lib/public-release-rings.mjs';
import { resolveRollingPublishVersion } from '../release/lib/rolling-version-allocation.mjs';
import { admitNpmPublication, resolvePublicNpmPackageNames } from '../release/admit-release.mjs';
import { assertCleanWorktree } from '../git/ensure-clean-worktree.mjs';
import { exportPackSandboxTarball } from '../../../apps/stack/scripts/pack.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBool(value, name) {
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
  if (raw === 'auto') return autoValue;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true', 'false', or 'auto' (got: ${value})`);
}

/**
 * @param {string} repoRoot
 * @param {string} rel
 */
function withinRepo(repoRoot, rel) {
  return path.resolve(repoRoot, rel);
}

/**
 * @param {string} version
 */
function normalizeBase(version) {
  const m = String(version ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) fail(`Invalid version: ${version}`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/** @param {string} version */
function normalizePublicSdkPreviewBase(version) {
  const base = normalizeBase(version);
  return base === '0.0.0' ? '0.1.0' : base;
}

/**
 * @param {string} pkgJsonPath
 * @param {string} nextVersion
 * @returns {() => void}
 */
function patchPackageVersion(pkgJsonPath, nextVersion) {
  const raw = fs.readFileSync(pkgJsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  const prevVersion = String(parsed.version ?? '').trim();
  if (!prevVersion) fail(`package.json missing version: ${pkgJsonPath}`);
  parsed.version = nextVersion;
  fs.writeFileSync(pkgJsonPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return () => {
    fs.writeFileSync(pkgJsonPath, raw, 'utf8');
  };
}

/**
 * @param {string} pkgJsonPath
 * @returns {() => void}
 */
function snapshotPackageManifest(pkgJsonPath) {
  const raw = fs.readFileSync(pkgJsonPath, 'utf8');
  return () => {
    fs.writeFileSync(pkgJsonPath, raw, 'utf8');
  };
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string; env?: Record<string, string>; timeoutMs?: number }} [extra]
 * @returns {string}
 */
function run(opts, cmd, args, extra) {
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  const cwd = extra?.cwd ? path.resolve(extra.cwd) : process.cwd();
  if (opts.dryRun) {
    console.log(`[dry-run] (cwd: ${cwd}) ${printable}`);
    return '';
  }

  const env = { ...process.env, ...(extra?.env ?? {}) };
  const invocation = resolveWindowsCommandInvocation({
    command: cmd,
    args,
    env,
    resolveCommandOnPath: true,
  });

  return execFileSync(invocation.command, invocation.args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: extra?.timeoutMs ?? 10 * 60_000,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

/**
 * @param {string} pkgDir
 * @param {{ dryRun: boolean }} opts
 * @returns {{ filename: string; tgzPath: string }}
 */
function npmPack(pkgDir, opts) {
  if (opts.dryRun) {
    return { filename: 'DRY_RUN.tgz', tgzPath: path.join(pkgDir, 'DRY_RUN.tgz') };
  }

  if (pkgDir.endsWith(path.join('apps', 'cli'))) {
    const scriptPath = path.join(pkgDir, 'scripts', 'packTarball.mjs');
    const raw = execFileSync(process.execPath, [scriptPath, '--dest-dir', pkgDir], {
      cwd: pkgDir,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 10 * 60_000,
    }).trim();
    const { filename, tgzPath } = resolvePackedTarball(raw, {
      cwd: pkgDir,
      sourceLabel: 'CLI pack helper',
    });
    if (!tgzPath.endsWith('.tgz') || !fs.existsSync(tgzPath) || !fs.statSync(tgzPath).isFile()) {
      throw new Error(`CLI pack helper did not produce an expected .tgz file (cwd: ${pkgDir}): ${tgzPath}`);
    }
    return { filename, tgzPath };
  }

  const env = { ...process.env };
  const invocation = resolveWindowsCommandInvocation({
    command: 'npm',
    args: ['pack', '--ignore-scripts', '--json', '--loglevel=error'],
    env,
    resolveCommandOnPath: true,
  });
  const raw = execFileSync(invocation.command, invocation.args, {
    cwd: pkgDir,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 10 * 60_000,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  }).trim();

  /** @type {any} */
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch (err) {
    throw new Error(`npm pack --json returned invalid JSON (cwd: ${pkgDir}): ${err}`);
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const filename = typeof entry?.filename === 'string' ? entry.filename.trim() : '';
  if (!filename) {
    throw new Error(`npm pack --json did not return a valid filename (cwd: ${pkgDir})`);
  }
  const tgzPath = path.resolve(pkgDir, filename);
  if (!tgzPath.endsWith('.tgz') || !fs.existsSync(tgzPath) || !fs.statSync(tgzPath).isFile()) {
    throw new Error(`npm pack did not produce an expected .tgz file (cwd: ${pkgDir}): ${tgzPath}`);
  }
  return { filename, tgzPath };
}

/**
 * @param {string} repoRoot
 * @param {string} pkgDir
 * @param {string} outDir
 * @param {string} outName
 * @param {{ dryRun: boolean }} opts
 * @returns {string} absolute path to packed tarball
 */
function packTo(repoRoot, pkgDir, outDir, outName, opts) {
  const absPkgDir = withinRepo(repoRoot, pkgDir);
  const absOutDir = withinRepo(repoRoot, outDir);
  const absOutPath = path.join(absOutDir, outName);

  if (opts.dryRun) {
    console.log(`[dry-run] pack ${pkgDir} -> ${path.relative(repoRoot, absOutPath)}`);
    return absOutPath;
  }

  fs.mkdirSync(absOutDir, { recursive: true });
  const { tgzPath } = npmPack(absPkgDir, opts);
  fs.renameSync(tgzPath, absOutPath);
  return absOutPath;
}

/**
 * @param {string} repoRoot
 * @param {string} channel
 * @param {string} tarballPath
 * @param {{ tag?: string; authorizedSha?: string }} publishOpts
 * @param {{ dryRun: boolean }} opts
 */
function publishTarball(repoRoot, channel, tarballPath, publishOpts, opts) {
  const script = withinRepo(repoRoot, 'scripts/pipeline/npm/publish-tarball.mjs');
  const args = [
    script,
    '--channel', channel,
    '--tarball', tarballPath,
    ...(publishOpts.tag ? ['--tag', publishOpts.tag] : []),
    ...(publishOpts.authorizedSha ? ['--authorized-sha', publishOpts.authorizedSha] : []),
  ];
  if (opts.dryRun) {
    console.log(
      `[dry-run] ${process.execPath} ${path.relative(repoRoot, script)} --channel ${channel} --tarball ${path.relative(repoRoot, tarballPath)}${publishOpts.tag ? ` --tag ${publishOpts.tag}` : ''}`,
    );
    return;
  }
  execFileSync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: 'inherit',
    timeout: 10 * 60_000,
  });
}

/**
 * @param {string} repoRoot
 * @param {string} pkgDir
 */
function readPackageVersion(repoRoot, pkgDir) {
  const pkgJson = withinRepo(repoRoot, path.join(pkgDir, 'package.json'));
  const parsed = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  const version = String(parsed.version ?? '').trim();
  if (!version) fail(`package.json missing version: ${pkgJson}`);
  return version;
}

/** @param {string} repoRoot */
function readCheckedOutSourceSha(repoRoot) {
  return String(execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  })).trim();
}

/**
 * @param {'cli' | 'stack' | 'server' | 'plugin_sdk' | 'sdk'} packageKey
 */
function rollingProductIdForPackage(packageKey) {
  if (packageKey === 'stack') return 'hstack';
  if (packageKey === 'plugin_sdk') return 'plugin_sdk';
  return packageKey;
}

/** @param {string} repoRoot */
function readPluginSdkPairVersion(repoRoot) {
  const pluginSdkVersion = readPackageVersion(repoRoot, 'packages/plugin-sdk');
  const pluginUiVersion = readPackageVersion(repoRoot, 'packages/plugin-ui');
  if (pluginSdkVersion !== pluginUiVersion) {
    fail(`plugin-sdk and plugin-ui must be version-equal (got ${pluginSdkVersion} and ${pluginUiVersion})`);
  }
  return pluginSdkVersion;
}

/** @param {string} repoRoot @param {string} packageRelDir */
function readExpectedPeerDependencies(repoRoot, packageRelDir) {
  const packageJsonPath = withinRepo(repoRoot, path.join(packageRelDir, 'package.json'));
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const peers = manifest.peerDependencies;
  if (peers === undefined) return {};
  if (!peers || typeof peers !== 'object' || Array.isArray(peers)) {
    fail(`package.json peerDependencies must be an object: ${packageJsonPath}`);
  }
  return Object.fromEntries(Object.entries(peers).map(([name, version]) => [name, String(version)]));
}

/** @param {string} packageRelDir @param {string} version @param {Record<string, string>} peers */
function publicSdkPublicationConfig(packageRelDir, version, peers) {
  if (packageRelDir === 'packages/plugin-sdk') {
    return {
      expectedPackageName: '@happier-dev/plugin-sdk',
      requiredFiles: ['API.md', 'api-declarations.md', 'api-surface.json', 'capability-matrix.json'],
      expectedPeerDependencies: peers,
      apiGovernance: { profileId: 'plugin-sdk' },
    };
  }
  if (packageRelDir === 'packages/plugin-ui') {
    return {
      expectedPackageName: '@happier-dev/plugin-ui',
      dependencyVersions: { '@happier-dev/plugin-sdk': version },
      requiredFiles: ['API.md', 'api-declarations.md', 'api-surface.json'],
      expectedPeerDependencies: peers,
      apiGovernance: { profileId: 'plugin-ui' },
    };
  }
  if (packageRelDir === 'packages/sdk') {
    return {
      expectedPackageName: '@happier-dev/sdk',
      requiredFiles: ['API.md', 'api-declarations.md', 'api-surface.json'],
      expectedPeerDependencies: peers,
      apiGovernance: { profileId: 'sdk' },
    };
  }
  fail(`Unknown public SDK package directory: ${packageRelDir}`);
}

/**
 * @param {string} repoRoot
 * @param {'preview' | 'production'} channel
 * @param {string} sdkTarball
 * @param {string} uiTarball
 * @param {{ tag?: string; authorizedSha?: string }} publishOpts
 * @param {{ dryRun: boolean }} opts
 */
function publishPluginSdkPair(repoRoot, channel, sdkTarball, uiTarball, publishOpts, opts) {
  const script = withinRepo(repoRoot, 'scripts/pipeline/npm/publish-plugin-sdk-pair.mjs');
  const args = [
    script,
    '--channel', channel,
    '--sdk-tarball', sdkTarball,
    '--ui-tarball', uiTarball,
    ...(publishOpts.tag ? ['--tag', publishOpts.tag] : []),
    ...(publishOpts.authorizedSha ? ['--authorized-sha', publishOpts.authorizedSha] : []),
    ...(opts.dryRun ? ['--dry-run'] : []),
  ];
  execFileSync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: 'inherit',
    timeout: 15 * 60_000,
  });
}

/**
 * The pack sandbox is the single candidate-byte owner. Validate the exact
 * exported files once, after every selected public package has been packed and
 * before either existing publisher can upload one of them.
 *
 * @param {string} repoRoot
 * @param {Record<string, string>} publicTarballs
 * @param {{ dryRun: boolean }} opts
 */
function runPublicSdkTarballValidationPhase(repoRoot, publicTarballs, opts) {
  const pluginSdkTarball = publicTarballs.plugin_sdk;
  const pluginUiTarball = publicTarballs.plugin_ui;
  const sdkTarball = publicTarballs.sdk;
  if (!pluginSdkTarball && !pluginUiTarball && !sdkTarball) return;
  const script = withinRepo(repoRoot, 'scripts/pipeline/npm/validate-public-sdk-tarballs.mjs');
  const args = [
    script,
    ...(pluginSdkTarball ? ['--plugin-sdk-tarball', pluginSdkTarball] : []),
    ...(pluginUiTarball ? ['--plugin-ui-tarball', pluginUiTarball] : []),
    ...(sdkTarball ? ['--sdk-tarball', sdkTarball] : []),
  ];
  // The phase runs three existing full-consumer proofs. Their individual
  // command ceilings are ten minutes, so the parent must not cancel the
  // combined sequential phase after the ordinary single-package ceiling.
  run(opts, process.execPath, args, { cwd: repoRoot, timeoutMs: 30 * 60_000 });
}

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
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
      'authorized-sha': { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const requestedChannel = String(values.channel ?? '').trim();
  if (!requestedChannel) fail('--channel is required');
  const channelId = normalizePublicReleaseChannel(requestedChannel);
  if (!channelId) {
    fail(
      `--channel must be ${JSON.stringify(formatPublicReleaseChannelChoices({ stableAlias: 'production', preferredOrder: ['dev', 'preview', 'stable'] }))} (got: ${requestedChannel})`,
    );
  }
  const channel = formatPublicReleaseChannel(channelId, { stableAlias: 'production' });

  const publishCli = parseBool(values['publish-cli'], '--publish-cli');
  const publishStack = parseBool(values['publish-stack'], '--publish-stack');
  const publishServer = parseBool(values['publish-server'], '--publish-server');
  const publishPluginSdk = parseBool(values['publish-plugin-sdk'], '--publish-plugin-sdk');
  const publishSdk = parseBool(values['publish-sdk'], '--publish-sdk');
  const runnerDir = String(values['server-runner-dir'] ?? '').trim() || 'packages/relay-server';
  const runTests = resolveAutoBool(values['run-tests'], '--run-tests', process.env.GITHUB_ACTIONS === 'true');
  const mode = String(values.mode ?? '').trim() || 'pack+publish';
  const dryRun = values['dry-run'] === true;
  const explicitVersions = {
    cli: String(values['cli-version'] ?? '').trim(),
    stack: String(values['stack-version'] ?? '').trim(),
    server: String(values['server-version'] ?? '').trim(),
    plugin_sdk: String(values['plugin-sdk-version'] ?? '').trim(),
    sdk: String(values['sdk-version'] ?? '').trim(),
  };
  const authorizedSha = String(values['authorized-sha'] ?? '').trim();

  const opts = { dryRun };
  if (mode !== 'pack' && mode !== 'pack+publish') {
    fail(`--mode must be 'pack' or 'pack+publish' (got: ${mode})`);
  }

  const publicSdkPackageNames = resolvePublicNpmPackageNames({
    pluginSdk: publishPluginSdk,
    sdk: publishSdk,
  });
  if (authorizedSha || (mode === 'pack+publish' && !dryRun)) {
    admitNpmPublication({
      mode,
      dryRun,
      authorizedSha,
      checkedOutSha: authorizedSha ? readCheckedOutSourceSha(repoRoot) : '',
      packageNames: publicSdkPackageNames,
    });
  }
  if (!dryRun && mode === 'pack+publish') {
    assertCleanWorktree({ cwd: repoRoot, allowDirty: false });
  }

  /** @type {Array<{ key: 'cli' | 'stack' | 'server'; dir: string; outDir: string; prepare: () => void; }>} */
  const packages = [];

  if (publishCli) {
    packages.push({
      key: 'cli',
      dir: 'apps/cli',
      outDir: 'dist/release-assets/cli',
      prepare: () => {
        // Canonical publication build: every included generator-owned plugin compiles from
        // current source, the bundled plugin inventory is regenerated from those outputs,
        // and the CLI dist build runs after that regeneration.
        for (const step of resolveCliPublicationBuildSteps({ repoRoot })) {
          run(opts, step.command, step.args, { cwd: step.cwd });
        }
        if (runTests) {
          run(opts, 'yarn', ['prepublishOnly'], { cwd: withinRepo(repoRoot, 'apps/cli') });
        }
        run(opts, process.execPath, ['scripts/bundleWorkspaceDeps.mjs', '--artifact'], { cwd: withinRepo(repoRoot, 'apps/cli') });
      },
    });
  }

  if (publishStack) {
    packages.push({
      key: 'stack',
      dir: 'apps/stack',
      outDir: 'dist/release-assets/stack',
      prepare: () => {
        run(opts, process.execPath, ['scripts/bundleWorkspaceDeps.mjs', '--artifact'], { cwd: withinRepo(repoRoot, 'apps/stack') });
      },
    });
  }

  if (publishServer) {
    packages.push({
      key: 'server',
      dir: runnerDir,
      outDir: 'dist/release-assets/server',
      prepare: () => {
        run(opts, process.execPath, ['scripts/bundleWorkspaceDeps.mjs', '--artifact'], { cwd: withinRepo(repoRoot, runnerDir) });
      },
    });
  }

  const publicSdkPackages = [];
  if (publishPluginSdk) {
    const sourceVersion = readPluginSdkPairVersion(repoRoot);
    const version = channelId === 'stable'
      ? sourceVersion
      : (
          await resolveRollingPublishVersion({
            repoRoot,
            productId: rollingProductIdForPackage('plugin_sdk'),
            channel: channelId,
            baseVersion: normalizePublicSdkPreviewBase(sourceVersion),
            explicitVersion: explicitVersions.plugin_sdk,
            publishSurface: 'npm',
            dryRun,
            env: process.env,
          })
        ).version;
    for (const [key, packageRelDir] of [
      ['plugin_sdk', 'packages/plugin-sdk'],
      ['plugin_ui', 'packages/plugin-ui'],
    ]) {
      const peers = readExpectedPeerDependencies(repoRoot, packageRelDir);
      publicSdkPackages.push({
        key: /** @type {'plugin_sdk' | 'plugin_ui'} */ (key),
        packageRelDir,
        outDir: 'dist/release-assets/plugin-sdk',
        version,
        publication: publicSdkPublicationConfig(packageRelDir, version, peers),
      });
    }
  }
  if (publishSdk) {
    const packageRelDir = 'packages/sdk';
    const sourceVersion = readPackageVersion(repoRoot, packageRelDir);
    const version = channelId === 'stable'
      ? sourceVersion
      : (
          await resolveRollingPublishVersion({
            repoRoot,
            productId: rollingProductIdForPackage('sdk'),
            channel: channelId,
            baseVersion: normalizePublicSdkPreviewBase(sourceVersion),
            explicitVersion: explicitVersions.sdk,
            publishSurface: 'npm',
            dryRun,
            env: process.env,
          })
        ).version;
    publicSdkPackages.push({
      key: 'sdk',
      packageRelDir,
      outDir: 'dist/release-assets/sdk',
      version,
      publication: publicSdkPublicationConfig(packageRelDir, version, readExpectedPeerDependencies(repoRoot, packageRelDir)),
    });
  }


  if (packages.length === 0 && publicSdkPackages.length === 0) {
    fail('At least one npm publication target must be true');
  }

  const publishTarget =
    channelId === 'publicdev'
      ? { channel: 'preview', tag: 'dev' }
      : { channel, tag: '' };

  /** @type {Array<() => void>} */
  const restorePackageManifests = [];
  try {
    for (const pkg of packages) {
      const pkgJsonPath = withinRepo(repoRoot, path.join(pkg.dir, 'package.json'));
      if (!fs.existsSync(pkgJsonPath)) fail(`Expected package.json missing: ${path.relative(repoRoot, pkgJsonPath)}`);
      if (!dryRun) {
        restorePackageManifests.push(snapshotPackageManifest(pkgJsonPath));
      }

      const originalVersion = readPackageVersion(repoRoot, pkg.dir);
      const base = normalizeBase(originalVersion);
      const nextVersion =
        channelId === 'stable'
          ? originalVersion
          : (
              await resolveRollingPublishVersion({
                repoRoot,
                productId: rollingProductIdForPackage(pkg.key),
                channel: channelId,
                baseVersion: base,
                explicitVersion: explicitVersions[pkg.key],
                publishSurface: 'npm',
                dryRun,
                env: process.env,
              })
            ).version;

      console.log(`\n==> ${pkg.dir} (${pkg.key})`);
      console.log(`version: ${originalVersion}${channelId !== 'stable' ? ` -> ${nextVersion}` : ''}`);

      /** @type {null | (() => void)} */
      let restore = null;
      try {
        if (channelId !== 'stable') {
          if (dryRun) {
            console.log(`[dry-run] patch ${path.relative(repoRoot, pkgJsonPath)} version -> ${nextVersion}`);
          } else {
            restore = patchPackageVersion(pkgJsonPath, nextVersion);
          }
        }

        pkg.prepare();

        const outName = `${pkg.key}-${nextVersion}.tgz`;
        const tarballPath = packTo(repoRoot, pkg.dir, pkg.outDir, outName, opts);
        if (mode === 'pack+publish') {
          publishTarball(repoRoot, publishTarget.channel, tarballPath, {
            tag: publishTarget.tag,
            authorizedSha,
          }, opts);
        }
      } finally {
        if (restore) {
          restore();
        }
      }
    }

    /** @type {Record<string, string>} */
    const publicTarballs = {};
    for (const pkg of publicSdkPackages) {
      console.log(`\n==> ${pkg.packageRelDir} (${pkg.key})`);
      console.log(`version: ${pkg.version} (sandbox only)`);
      if (dryRun) {
        console.log(`[dry-run] pack sandbox ${pkg.packageRelDir} -> ${pkg.outDir}`);
        publicTarballs[pkg.key] = path.join(repoRoot, pkg.outDir, `${pkg.key}-${pkg.version}.tgz`);
        continue;
      }
      fs.mkdirSync(withinRepo(repoRoot, pkg.outDir), { recursive: true });
      const metadata = await exportPackSandboxTarball({
        monorepoRoot: repoRoot,
        packageRelDir: pkg.packageRelDir,
        destinationDir: withinRepo(repoRoot, pkg.outDir),
        packageVersion: pkg.version,
        publication: pkg.publication,
        env: process.env,
      });
      publicTarballs[pkg.key] = path.join(withinRepo(repoRoot, pkg.outDir), metadata.tarball.name);
    }

    runPublicSdkTarballValidationPhase(repoRoot, publicTarballs, opts);

    if (mode === 'pack+publish' && publishPluginSdk) {
      publishPluginSdkPair(
        repoRoot,
        publishTarget.channel,
        publicTarballs.plugin_sdk,
        publicTarballs.plugin_ui,
        { tag: publishTarget.tag, authorizedSha },
        opts,
      );
    }
    if (mode === 'pack+publish' && publishSdk) {
      publishTarball(repoRoot, publishTarget.channel, publicTarballs.sdk, {
        tag: publishTarget.tag,
        authorizedSha,
      }, opts);
    }

  } finally {
    for (const restoreManifest of restorePackageManifests.reverse()) {
      restoreManifest();
    }
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
