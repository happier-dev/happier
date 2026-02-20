// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { stageRepoForDagger } from './stage-repo-for-dagger.mjs';
import { rewriteEasLocalBuildArtifactPath } from './rewrite-eas-local-build-artifact-path.mjs';
import { assertDockerCanRunLinuxAmd64 } from '../docker/assert-docker-can-run-linux-amd64.mjs';
import { createEasLocalBuildEnv } from './eas-local-build-env.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {Record<string, string | undefined>} base
 * @returns {Record<string, string>}
 */
function withUtf8LocaleDefaults(base) {
  const env = { ...base };
  // CocoaPods and some Ruby tooling can crash when locale is unset (ASCII-8BIT).
  // Default to a UTF-8 locale when not explicitly configured.
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  if (!env.LC_ALL) env.LC_ALL = env.LANG;
  return env;
}

/**
 * @param {string} cmd
 * @param {Record<string, string>} env
 * @returns {boolean}
 */
function commandExists(cmd, env) {
  try {
    execFileSync('bash', ['-lc', `command -v ${JSON.stringify(cmd)} >/dev/null 2>&1`], {
      env,
      stdio: 'ignore',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * EAS expects the project to be inside a git repository, even for local builds.
 * When staging outside the working tree, we create a lightweight repo so EAS can proceed
 * without mutating the real checkout.
 *
 * @param {{ repoDir: string; env: Record<string, string>; dryRun: boolean }} opts
 */
function ensureStagedGitRepo({ repoDir, env, dryRun }) {
  const gitDir = path.join(repoDir, '.git');
  if (fs.existsSync(gitDir)) return;

  if (dryRun) {
    console.log(`[dry-run] (cwd: ${repoDir}) git init`);
    return;
  }

  execFileSync('git', ['init', '-q'], { cwd: repoDir, env, stdio: 'ignore', timeout: 60_000 });
  execFileSync('git', ['config', 'user.email', 'pipeline@local'], { cwd: repoDir, env, stdio: 'ignore', timeout: 10_000 });
  execFileSync('git', ['config', 'user.name', 'Happier Pipeline'], { cwd: repoDir, env, stdio: 'ignore', timeout: 10_000 });
  // Avoid `git add -A` on a staged monorepo (can be extremely slow) — EAS only needs a repo + a commit.
  execFileSync('git', ['commit', '--allow-empty', '-m', 'eas local build', '--no-gpg-sign'], {
    cwd: repoDir,
    env,
    stdio: 'ignore',
    timeout: 60_000,
  });
}

/**
 * EAS runs `npx expo config` before it installs dependencies in the local build working dir,
 * and custom config plugins often require workspace dependencies to be present.
 *
 * When staging outside the working tree, we symlink the real monorepo `node_modules` so
 * expo config evaluation can resolve dependencies without doing a full install into the stage.
 *
 * @param {{ repoRoot: string; stagedRepoDir: string; dryRun: boolean }} opts
 */
function maybeLinkNodeModulesIntoStage({ repoRoot, stagedRepoDir, dryRun }) {
  const links = [
    { src: path.join(repoRoot, 'node_modules'), dest: path.join(stagedRepoDir, 'node_modules') },
    {
      src: path.join(repoRoot, 'apps', 'ui', 'node_modules'),
      dest: path.join(stagedRepoDir, 'apps', 'ui', 'node_modules'),
    },
  ];

  for (const link of links) {
    if (fs.existsSync(link.dest)) continue;
    if (!fs.existsSync(link.src)) {
      fail(`[pipeline] Missing node_modules at ${link.src}. Run 'yarn install' before running EAS local builds.`);
    }
    if (dryRun) {
      console.log(`[dry-run] ln -s ${link.src} ${link.dest}`);
      continue;
    }
    fs.mkdirSync(path.dirname(link.dest), { recursive: true });
    fs.symlinkSync(link.src, link.dest, 'dir');
  }
}

/**
 * @param {string} outputPath
 * @param {unknown} value
 */
function writeJson(outputPath, value) {
  if (!outputPath) return;
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string; env?: Record<string, string>; stdio?: 'inherit' | 'pipe'; timeoutMs?: number }} [extra]
 * @returns {string}
 */
function run(opts, cmd, args, extra) {
  const cwd = extra?.cwd ? path.resolve(extra.cwd) : process.cwd();
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] (cwd: ${cwd}) ${printable}`);
    return '';
  }

  return execFileSync(cmd, args, {
    cwd,
    env: { ...process.env, ...(extra?.env ?? {}) },
    encoding: 'utf8',
    stdio: extra?.stdio ?? 'inherit',
    // Android local builds (especially inside Dagger) can exceed an hour on real projects.
    timeout: extra?.timeoutMs ?? 4 * 60 * 60_000,
  });
}

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      platform: { type: 'string' },
      profile: { type: 'string' },
      out: { type: 'string' },
      'build-mode': { type: 'string', default: 'cloud' },
      'local-runtime': { type: 'string', default: 'host' },
      'artifact-out': { type: 'string', default: '' },
      'eas-cli-version': { type: 'string', default: '' },
      'dump-view': { type: 'string', default: 'true' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const platform = String(values.platform ?? '').trim();
  const profile = String(values.profile ?? '').trim();
  const outPath = String(values.out ?? '').trim();
  if (!platform) fail('--platform is required');
  if (!profile) fail('--profile is required');
  if (!outPath) fail('--out is required');
  if (platform !== 'ios' && platform !== 'android' && platform !== 'all') {
    fail(`--platform must be 'ios', 'android', or 'all' (got: ${platform})`);
  }

  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  const buildModeRaw = String(values['build-mode'] ?? '').trim().toLowerCase() || 'cloud';
  if (buildModeRaw !== 'cloud' && buildModeRaw !== 'local') {
    fail(`--build-mode must be 'cloud' or 'local' (got: ${values['build-mode']})`);
  }
  const buildMode = /** @type {'cloud' | 'local'} */ (buildModeRaw);

  const localRuntimeRaw = String(values['local-runtime'] ?? '').trim().toLowerCase() || 'host';
  if (localRuntimeRaw !== 'host' && localRuntimeRaw !== 'dagger') {
    fail(`--local-runtime must be 'host' or 'dagger' (got: ${values['local-runtime']})`);
  }
  const localRuntime = /** @type {'host' | 'dagger'} */ (localRuntimeRaw);

  const isCi = String(process.env.CI ?? '').trim().toLowerCase() === 'true' || String(process.env.GITHUB_ACTIONS ?? '').trim() === 'true';
  const expoToken = String(process.env.EXPO_TOKEN ?? '').trim();
  if ((buildMode === 'cloud' || localRuntime === 'dagger' || isCi) && !expoToken) {
    fail('EXPO_TOKEN is required for Expo native builds.');
  }

  const dumpView = parseBool(values['dump-view'], '--dump-view');
  const easCliVersion =
    String(values['eas-cli-version'] ?? '').trim() || String(process.env.EAS_CLI_VERSION ?? '').trim() || '18.0.1';

  console.log(
    `[pipeline] expo native build: mode=${buildMode}${buildMode === 'local' ? ` runtime=${localRuntime}` : ''} platform=${platform} profile=${profile}`,
  );

  const uiDir = path.join(repoRoot, 'apps', 'ui');
  const artifactOut = String(values['artifact-out'] ?? '').trim();

  if (buildMode === 'local') {
    if (platform === 'all') {
      fail("--platform 'all' is not supported in --build-mode local (build per-platform instead).");
    }
    if (!artifactOut) {
      fail('--artifact-out is required when --build-mode local');
    }

	    if (localRuntime === 'dagger') {
	      if (platform !== 'android') {
	        fail("--local-runtime dagger is currently supported only for --platform android.");
	      }
	      if (!dryRun) {
	        assertDockerCanRunLinuxAmd64();
	      }

	      const outAbs = path.resolve(repoRoot, outPath);
	      const artifactAbs = path.resolve(repoRoot, artifactOut);
      const outJsonName = path.basename(outAbs);
      const artifactName = path.basename(artifactAbs);
      if (!outJsonName || outJsonName === '.' || outJsonName === '..') fail(`Invalid --out path: ${outAbs}`);
      if (!artifactName || artifactName === '.' || artifactName === '..') fail(`Invalid --artifact-out path: ${artifactAbs}`);
      const exportDirAbs = path.dirname(artifactAbs);
      const exportedOutJsonAbs = path.join(exportDirAbs, outJsonName);

      const staged = dryRun ? null : stageRepoForDagger({ repoRoot });
      const daggerRepoArg = dryRun ? '.' : staged?.stagedRepoDir;

      try {
        if (!dryRun) {
          fs.mkdirSync(exportDirAbs, { recursive: true });
        }

        run(
          opts,
          'dagger',
          [
            '--progress',
            'plain',
            '-m',
            './dagger',
            'call',
            '-o',
            exportDirAbs,
            'expo-android-local-build',
            '--repo',
            String(daggerRepoArg),
            '--profile',
            profile,
            '--artifact-name',
            artifactName,
            '--out-json-name',
            outJsonName,
            '--expo-token',
            'env://EXPO_TOKEN',
            '--eas-cli-version',
            easCliVersion,
          ],
          { cwd: repoRoot, stdio: 'inherit' },
        );
      } finally {
        if (staged) {
          staged.cleanup();
        }
      }

	      if (!dryRun) {
	        if (!fs.existsSync(artifactAbs)) fail(`Missing build artifact at: ${artifactAbs}`);
	        if (!fs.existsSync(exportedOutJsonAbs)) {
	          // The module always exports metadata next to the artifact, then we copy it into place.
	          fail(`Missing build metadata json at: ${exportedOutJsonAbs}`);
	        }

	        // The metadata JSON produced inside the container points at container-local paths (e.g. `/tmp/...`).
	        // Rewrite it to reference the exported host artifact path so follow-up steps can read it.
	        const exportedJson = fs.readFileSync(exportedOutJsonAbs, 'utf8');
	        const rewritten = rewriteEasLocalBuildArtifactPath({ rawJson: exportedJson, artifactPath: artifactAbs });
	        fs.mkdirSync(path.dirname(outAbs), { recursive: true });
	        fs.writeFileSync(outAbs, rewritten, 'utf8');
	        if (exportedOutJsonAbs !== outAbs) {
	          try {
	            fs.rmSync(exportedOutJsonAbs, { force: true });
	          } catch {
	            // best-effort cleanup only
	          }
	        }

	        if (!fs.existsSync(outAbs)) fail(`Missing build metadata json at: ${outAbs}`);
	        const size = fs.statSync(artifactAbs).size;
	        if (size < 1_000_000) fail(`Build artifact is unexpectedly small (${size} bytes): ${artifactAbs}`);
	        // Ensure JSON is parseable.
        JSON.parse(fs.readFileSync(outAbs, 'utf8'));
      }
      return;
    }

    const absOut = path.resolve(repoRoot, artifactOut);
    if (!dryRun) fs.mkdirSync(path.dirname(absOut), { recursive: true });

    const baseEnv = /** @type {Record<string, string>} */ ({ ...process.env });
    const buildEnvBase = withUtf8LocaleDefaults(baseEnv);
    const buildEnv = createEasLocalBuildEnv({ baseEnv: buildEnvBase, platform });
    if (platform === 'ios') {
      // CocoaPods on macOS can crash when locale is `C`/`C.UTF-8` even if the terminal locale is set.
      // Force a known UTF-8 locale for the local build subprocess tree.
      buildEnv.LANG = 'en_US.UTF-8';
      buildEnv.LC_ALL = 'en_US.UTF-8';
    }

    if (platform === 'ios') {
      if (!commandExists('fastlane', buildEnv)) {
        fail(
          [
            'fastlane is required for local iOS builds (EAS local build uses fastlane under the hood).',
            'Install it once:',
            '  brew install fastlane',
            'Or ensure `fastlane` is available on PATH.',
          ].join('\n'),
        );
      }
      if (!commandExists('pod', buildEnv)) {
        fail(
          [
            'cocoapods is required for local iOS builds (pod install).',
            'Install it once:',
            '  brew install cocoapods',
            'Or ensure `pod` is available on PATH.',
          ].join('\n'),
        );
      }
    }

    // Stage the repo for EAS local builds so:
    // - autoIncrement/build-number changes don't touch the real working tree
    // - git ignorecase/casing and dirty-tree checks don't block local iteration
    // - local-only files like `.env*` don't leak into build contexts
    const staged = dryRun ? null : stageRepoForDagger({ repoRoot });
    const effectiveRepoDir = dryRun ? repoRoot : staged?.stagedRepoDir ?? repoRoot;
    const effectiveUiDir = path.join(effectiveRepoDir, 'apps', 'ui');

    const pipelineInteractive =
      String(process.env.PIPELINE_INTERACTIVE ?? '').trim() === '1' ||
      String(process.env.PIPELINE_INTERACTIVE ?? '').trim().toLowerCase() === 'true';
    const localNonInteractive = isCi || !pipelineInteractive;

    try {
      if (staged && effectiveRepoDir !== repoRoot) {
        maybeLinkNodeModulesIntoStage({ repoRoot, stagedRepoDir: effectiveRepoDir, dryRun });
      }
      ensureStagedGitRepo({ repoDir: effectiveRepoDir, env: buildEnv, dryRun });
      const localArgs = [
        '--yes',
        `eas-cli@${easCliVersion}`,
        'build',
        '--platform',
        platform,
        '--profile',
        profile,
        '--local',
        '--output',
        absOut,
        ...(localNonInteractive ? ['--non-interactive'] : []),
      ];
      run(
        opts,
        'npx',
        localArgs,
        { cwd: effectiveUiDir, env: buildEnv, stdio: 'inherit' },
      );
    } finally {
      if (staged) staged.cleanup();
    }

    if (!dryRun) {
      if (!fs.existsSync(absOut)) {
        fail(`Missing EAS local build output at: ${absOut}`);
      }
      const size = fs.statSync(absOut).size;
      if (size < 1_000_000) {
        fail(`EAS local build output is unexpectedly small (${size} bytes): ${absOut}`);
      }
    }

    writeJson(outPath, {
      mode: 'local',
      platform,
      profile,
      artifactPath: absOut,
    });

    return;
  }

  const easJson = run(
    opts,
    'npx',
    ['--yes', `eas-cli@${easCliVersion}`, 'build', '--platform', platform, '--profile', profile, '--non-interactive', '--json'],
    { cwd: uiDir, stdio: 'pipe' },
  ).trim();

  if (!dryRun) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, `${easJson}\n`, 'utf8');

    /** @type {any} */
    const parsed = JSON.parse(easJson);
    const builds = Array.isArray(parsed) ? parsed : [parsed];

    console.log('EAS builds created by this run:');
    for (const build of builds) {
      const id = build?.id ?? build?.buildId ?? null;
      const status = build?.status ?? null;
      const detailsUrl =
        build?.buildDetailsPageUrl ||
        build?.buildDetailsUrl ||
        build?.detailsUrl ||
        build?.url ||
        null;
      console.log(`- ${String(build?.platform ?? 'unknown')}: ${String(status ?? 'unknown')}${id ? ` (${id})` : ''}${detailsUrl ? ` ${detailsUrl}` : ''}`);
    }

    const ids = builds.map((b) => b?.id ?? b?.buildId ?? null).filter(Boolean);
    if (dumpView && ids.length > 0) {
      for (const id of ids) {
        console.log(`::group::eas build:view ${id}`);
        const viewJson = run(
          opts,
          'npx',
          ['--yes', `eas-cli@${easCliVersion}`, 'build:view', String(id), '--json'],
          { cwd: uiDir, stdio: 'pipe', timeoutMs: 5 * 60_000 },
        ).trim();
        const viewParsed = JSON.parse(viewJson);
        const build = Array.isArray(viewParsed) ? viewParsed[0] : viewParsed;
        const error =
          build?.error?.message ||
          build?.error?.errors?.[0]?.message ||
          (typeof build?.error === 'string' ? build.error : null) ||
          null;
        const out = {
          id: build?.id ?? null,
          platform: build?.platform ?? null,
          status: build?.status ?? null,
          detailsUrl: build?.buildDetailsPageUrl || build?.buildDetailsUrl || build?.detailsUrl || null,
          error,
          logs: build?.logs?.url || build?.logUrl || null,
          artifacts: build?.artifacts ?? null,
        };
        console.log(JSON.stringify(out, null, 2));
        console.log('');
        console.log('eas build:view (human output):');
        run(opts, 'npx', ['--yes', `eas-cli@${easCliVersion}`, 'build:view', String(id)], { cwd: uiDir, timeoutMs: 5 * 60_000 });
        console.log('::endgroup::');
      }
    }
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
