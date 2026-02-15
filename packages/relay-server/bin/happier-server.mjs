#!/usr/bin/env node
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir, platform, arch, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { resolveServerReleaseAssets, resolveUiWebReleaseAssets } from '../src/releaseAssets.mjs';
import { resolveRunnerCacheRoot, resolveServerRunnerTarget } from '../src/target.mjs';
import { parseRunnerInvocation } from '../src/runnerConfig.mjs';
import { downloadVerifiedReleaseAssetBundle } from '@happier-dev/release-runtime/verifiedDownload';
import { planArchiveExtraction } from '@happier-dev/release-runtime/extractPlan';
import { fetchGitHubReleaseByTag } from '@happier-dev/release-runtime/github';

const OWNER = 'happier-dev';
const REPO = 'happier';

function fail(msg) {
  process.stderr.write(`[happier-server] ${msg}\n`);
  process.exit(1);
}

function resolveTarget() {
  try {
    return resolveServerRunnerTarget({ platform: platform(), arch: arch() });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

function cacheRoot() {
  return resolveRunnerCacheRoot({ platform: platform(), homedir: homedir(), env: process.env });
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const parsed = parseRunnerInvocation(process.argv.slice(2));
  const { serverTag: tag, uiWebTag, withUiWeb, positionals } = parsed;

  const target = resolveTarget();
  const githubRepo = `${OWNER}/${REPO}`;

  const release = await fetchGitHubReleaseByTag({
    githubRepo,
    tag,
    userAgent: 'happier-server-runner',
    githubToken: String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''),
  });
  const assets = resolveServerReleaseAssets({ release, os: target.os, arch: target.arch });

  const pubkeyPath = new URL('../assets/happier-release.pub', import.meta.url);
  const pubkeyFile = await readFile(pubkeyPath, 'utf-8');

  const tmp = join(tmpdir(), `happier-server-${process.pid}-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  try {
    const cacheDir = join(cacheRoot(), 'happier', 'server', tag, assets.version, `${target.os}-${target.arch}`);
    await mkdir(cacheDir, { recursive: true });
    const artifactStem = `happier-server-v${assets.version}-${target.os}-${target.arch}`;
    const serverDir = join(cacheDir, artifactStem);
    const serverBin = join(serverDir, target.exeName);

    if (!(await pathExists(serverBin))) {
      const downloaded = await downloadVerifiedReleaseAssetBundle({
        bundle: {
          version: assets.version,
          archive: assets.tarball,
          checksums: assets.checksums,
          checksumsSig: assets.checksumsSig,
        },
        destDir: tmp,
        pubkeyFile,
        userAgent: 'happier-server-runner',
      });

      const plan = planArchiveExtraction({
        archiveName: downloaded.archiveName,
        archivePath: downloaded.archivePath,
        destDir: cacheDir,
        os: target.os,
      });

      // Extract archive into cache (archive root contains the artifactStem folder).
      const extract = spawn(plan.command.cmd, plan.command.args, { stdio: 'inherit' });
      await new Promise((resolve, reject) => {
        extract.on('error', reject);
        extract.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${plan.command.cmd} exited with ${code}`))));
      });
    }

    if (!(await pathExists(serverBin))) {
      fail(`Extracted server binary not found at ${serverBin}`);
    }

    const childEnv = { ...process.env };
    if (withUiWeb && !String(process.env.HAPPIER_SERVER_UI_DIR ?? '').trim()) {
      const uiRelease = await fetchGitHubReleaseByTag({
        githubRepo,
        tag: uiWebTag,
        userAgent: 'happier-server-runner',
        githubToken: String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''),
      });
      const uiAssets = resolveUiWebReleaseAssets({ release: uiRelease });
      const uiCacheDir = join(cacheRoot(), 'happier', 'ui-web', uiWebTag, uiAssets.version, 'web-any');
      await mkdir(uiCacheDir, { recursive: true });
      const uiStem = `happier-ui-web-v${uiAssets.version}-web-any`;
      const uiDir = join(uiCacheDir, uiStem);
      const uiIndex = join(uiDir, 'index.html');

      if (!(await pathExists(uiIndex))) {
        const uiDownloaded = await downloadVerifiedReleaseAssetBundle({
          bundle: {
            version: uiAssets.version,
            archive: uiAssets.tarball,
            checksums: uiAssets.checksums,
            checksumsSig: uiAssets.checksumsSig,
          },
          destDir: tmp,
          pubkeyFile,
          userAgent: 'happier-server-runner',
        });

        const uiPlan = planArchiveExtraction({
          archiveName: uiDownloaded.archiveName,
          archivePath: uiDownloaded.archivePath,
          destDir: uiCacheDir,
          os: target.os,
        });

        const extractUi = spawn(uiPlan.command.cmd, uiPlan.command.args, { stdio: 'inherit' });
        await new Promise((resolve, reject) => {
          extractUi.on('error', reject);
          extractUi.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${uiPlan.command.cmd} exited with ${code}`))));
        });
      }

      if (!(await pathExists(uiIndex))) {
        fail(`Extracted ui web bundle not found at ${uiIndex}`);
      }

      childEnv.HAPPIER_SERVER_UI_DIR = uiDir;
    }

    const child = spawn(serverBin, positionals, { stdio: 'inherit', env: childEnv });
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 1);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
