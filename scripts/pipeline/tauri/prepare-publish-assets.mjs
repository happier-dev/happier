// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  formatPublicReleaseChannel,
  formatPublicReleaseChannelChoices,
  normalizePublicReleaseChannel,
} from '../release/lib/public-release-rings.mjs';

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
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string; stdio?: 'inherit' | 'pipe'; env?: Record<string, string> }} [extra]
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
    timeout: 30 * 60_000,
  });
}

/**
 * @param {string} repoRoot
 * @param {string} fromDir
 * @param {string} toDir
 * @param {{ dryRun: boolean }} opts
 */
function copyDir(repoRoot, fromDir, toDir, opts) {
  const src = path.resolve(repoRoot, fromDir);
  const dst = path.resolve(repoRoot, toDir);
  if (opts.dryRun) {
    console.log(`[dry-run] copy dir: ${path.relative(repoRoot, src)} -> ${path.relative(repoRoot, dst)}`);
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

/**
 * @param {string} repoRoot
 * @param {string} fromFile
 * @param {string} toFile
 * @param {{ dryRun: boolean }} opts
 */
function copyFile(repoRoot, fromFile, toFile, opts) {
  const src = path.resolve(repoRoot, fromFile);
  const dst = path.resolve(repoRoot, toFile);
  if (opts.dryRun) {
    console.log(`[dry-run] copy file: ${path.relative(repoRoot, src)} -> ${path.relative(repoRoot, dst)}`);
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/**
 * @param {string} uiVersion
 */
function normalizeBaseVersion(uiVersion) {
  const m = String(uiVersion ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) fail(`Invalid ui version: ${uiVersion}`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/**
 * @param {string} uiVersion
 * @param {'preview' | 'publicdev'} environment
 */
function computeRollingVersion(uiVersion, environment) {
  const base = normalizeBaseVersion(uiVersion);
  const runNumberRaw = Number(process.env.GITHUB_RUN_NUMBER ?? '');
  const runNumber = Number.isFinite(runNumberRaw) ? Math.max(0, Math.floor(runNumberRaw)) : Math.floor(Date.now() / 1000);
  const suffix = environment === 'publicdev' ? 'dev' : 'preview';
  return `${base}-${suffix}.${runNumber}`;
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      'ui-version': { type: 'string' },
      repo: { type: 'string' },
      'artifacts-dir': { type: 'string', default: 'dist/tauri/updates' },
      'publish-dir': { type: 'string', default: 'dist/tauri/publish' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const requestedEnvironment = String(values.environment ?? '').trim();
  if (!requestedEnvironment) fail('--environment is required');
  const normalizedChannel = normalizePublicReleaseChannel(requestedEnvironment);
  const environment = normalizedChannel === 'stable' ? 'production' : normalizedChannel;
  if (!environment) {
    fail(
      `--environment must be ${JSON.stringify(
        formatPublicReleaseChannelChoices({ stableAlias: 'production', preferredOrder: ['dev', 'preview', 'stable'] })
      )} (got: ${requestedEnvironment})`
    );
  }

  const uiVersion = String(values['ui-version'] ?? '').trim();
  if (!uiVersion) fail('--ui-version is required');
  const repo = String(values.repo ?? '').trim();
  if (!repo) fail('--repo is required (owner/repo)');

  const artifactsDir = String(values['artifacts-dir'] ?? '').trim() || 'dist/tauri/updates';
  const publishDir = String(values['publish-dir'] ?? '').trim() || 'dist/tauri/publish';
  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  const version = environment === 'production' ? uiVersion : computeRollingVersion(uiVersion, /** @type {'preview' | 'publicdev'} */ (environment));
  const releaseTag =
    environment === 'preview' ? 'ui-desktop-preview' : environment === 'publicdev' ? 'ui-desktop-dev' : `ui-desktop-v${uiVersion}`;
  const notes =
    environment === 'preview'
      ? 'Rolling preview build.'
      : environment === 'publicdev'
        ? 'Rolling dev build.'
        : 'See the UI release notes for details.';
  const pubDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  console.log(
    `[pipeline] tauri publish assets: env=${formatPublicReleaseChannel(environment === 'production' ? 'stable' : environment, { stableAlias: 'production' })} ui_version=${uiVersion} version=${version} release_tag=${releaseTag}`
  );

  const latestJsonRel = path.join(publishDir, 'latest.json');

  run(
    opts,
    process.execPath,
    [
      'apps/ui/tools/tauri/make-latest-json.mjs',
      '--channel',
      environment,
      '--version',
      version,
      '--pub-date',
      pubDate,
      '--notes',
      notes,
      '--repo',
      repo,
      '--release-tag',
      releaseTag,
      '--artifacts-dir',
      artifactsDir,
      '--out',
      latestJsonRel,
    ],
    { cwd: repoRoot },
  );

  // Assemble per-release payloads (folder names intentionally stable and public).
  // These are uploaded to GitHub Releases.
  const previewDir = path.join(publishDir, 'ui-desktop-preview');
  const publicdevDir = path.join(publishDir, 'ui-desktop-dev');
  const versionedDir = path.join(publishDir, 'ui-desktop-v');
  const stableDir = path.join(publishDir, 'ui-desktop-stable');

  if (environment === 'preview') {
    copyFile(repoRoot, latestJsonRel, path.join(previewDir, 'latest.json'), opts);
    copyDir(repoRoot, artifactsDir, previewDir, opts);
  } else if (environment === 'publicdev') {
    copyFile(repoRoot, latestJsonRel, path.join(publicdevDir, 'latest.json'), opts);
    copyDir(repoRoot, artifactsDir, publicdevDir, opts);
  } else {
    copyFile(repoRoot, latestJsonRel, path.join(stableDir, 'latest.json'), opts);
    copyDir(repoRoot, artifactsDir, versionedDir, opts);
  }
}

main();
