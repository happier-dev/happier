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
 * @param {{ cwd?: string; env?: Record<string, string> }} [extra]
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
    timeout: 10 * 60_000,
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
 * @param {{ tag?: string }} publishOpts
 * @param {{ dryRun: boolean }} opts
 */
function publishTarball(repoRoot, channel, tarballPath, publishOpts, opts) {
  const script = withinRepo(repoRoot, 'scripts/pipeline/npm/publish-tarball.mjs');
  const args = [script, '--channel', channel, '--tarball', tarballPath, ...(publishOpts.tag ? ['--tag', publishOpts.tag] : [])];
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

/**
 * @param {'cli' | 'stack' | 'server'} packageKey
 */
function rollingProductIdForPackage(packageKey) {
  return packageKey === 'stack' ? 'hstack' : packageKey;
}

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      channel: { type: 'string' },
      'publish-cli': { type: 'string', default: 'false' },
      'publish-stack': { type: 'string', default: 'false' },
      'publish-server': { type: 'string', default: 'false' },
      'server-runner-dir': { type: 'string', default: 'packages/relay-server' },
      'run-tests': { type: 'string', default: 'auto' },
      mode: { type: 'string', default: 'pack+publish' },
      'cli-version': { type: 'string', default: '' },
      'stack-version': { type: 'string', default: '' },
      'server-version': { type: 'string', default: '' },
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
  const runnerDir = String(values['server-runner-dir'] ?? '').trim() || 'packages/relay-server';
  const runTests = resolveAutoBool(values['run-tests'], '--run-tests', process.env.GITHUB_ACTIONS === 'true');
  const mode = String(values.mode ?? '').trim() || 'pack+publish';
  const dryRun = values['dry-run'] === true;
  const explicitVersions = {
    cli: String(values['cli-version'] ?? '').trim(),
    stack: String(values['stack-version'] ?? '').trim(),
    server: String(values['server-version'] ?? '').trim(),
  };

  const opts = { dryRun };
  if (mode !== 'pack' && mode !== 'pack+publish') {
    fail(`--mode must be 'pack' or 'pack+publish' (got: ${mode})`);
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

  if (packages.length === 0) {
    fail('At least one of --publish-cli/--publish-stack/--publish-server must be true');
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
          publishTarball(repoRoot, publishTarget.channel, tarballPath, { tag: publishTarget.tag }, opts);
        }
      } finally {
        if (restore) {
          restore();
        }
      }
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
