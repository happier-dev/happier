// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import {
  loadPackedAuthorCandidateManifest,
} from '../../../../packages/tests/scripts/plugin-platform/run-packed-author-ui-compat.mjs';

/**
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {string[]} entries
 */
function prependPathEntries(baseEnv, entries) {
  const next = { ...baseEnv };
  const cleanEntries = entries.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  if (cleanEntries.length === 0) {
    return next;
  }
  next.PATH = [...cleanEntries, String(baseEnv.PATH ?? '')].filter(Boolean).join(delimiter);
  return next;
}

function minisignAvailable(env) {
  const probe = spawnSync('minisign', ['-v'], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return probe.status === 0;
}

/**
 * @param {{ repoRoot: string; scratchDir: string; baseEnv?: NodeJS.ProcessEnv }} params
 */
function resolveSigningEnv({ repoRoot, scratchDir, baseEnv = process.env }) {
  if (minisignAvailable(baseEnv)) {
    return { env: { ...baseEnv }, keyPathEntries: [] };
  }
  const bootstrapPath = resolve(repoRoot, '.github', 'actions', 'bootstrap-minisign', 'bootstrap-minisign.sh');
  const bootstrapStdout = execFileSync('bash', [bootstrapPath], {
    cwd: repoRoot,
    env: {
      ...baseEnv,
      // The local-build helper needs the bootstrapped bin dir immediately.
      // Force the script into its stdout-returning mode instead of depending
      // on GitHub Actions' $GITHUB_PATH side-effect file contract.
      GITHUB_PATH: '',
      RUNNER_TEMP: scratchDir,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const minisignDir = String(bootstrapStdout ?? '').trim();
  if (!minisignDir) {
    throw new Error('installers-smoke local-build bootstrap did not return a minisign binary directory');
  }
  const env = prependPathEntries(baseEnv, [minisignDir]);
  if (!minisignAvailable(env)) {
    throw new Error(`installers-smoke local-build could not execute minisign after bootstrap: ${minisignDir}`);
  }
  return {
    env,
    keyPathEntries: [minisignDir],
  };
}

export const resolveSigningEnvForTests = resolveSigningEnv;

/**
 * @param {{ repoRoot: string; baseEnv?: NodeJS.ProcessEnv }} params
 */
export async function prepareReleaseValidationMinisignEnv({
  repoRoot,
  baseEnv = process.env,
}) {
  const scratchDir = await mkdtemp(join(tmpdir(), 'happier-release-validation-minisign-'));
  try {
    const signing = resolveSigningEnv({ repoRoot, scratchDir, baseEnv });
    return {
      ...signing,
      async cleanup() {
        await rm(scratchDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(scratchDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * @param {{
 *   repoRoot: string;
 *   platform: 'linux' | 'darwin' | 'win32';
 *   candidateManifestPath: string;
 * }} params
 */
export async function prepareInstallersSmokeCandidateAssets({
  repoRoot,
  platform,
  candidateManifestPath,
}) {
  const signing = await prepareReleaseValidationMinisignEnv({ repoRoot });
  try {
    const manifestPath = resolve(repoRoot, candidateManifestPath);
    const candidate = await loadPackedAuthorCandidateManifest(
      ['--candidate', manifestPath],
      { cwd: repoRoot },
    );
    if (!candidate.standaloneCli?.signature) {
      throw new Error('installers-smoke exact candidate requires a bound minisign signature');
    }
    const targetOs = platform === 'win32' ? 'windows' : platform;
    const target = candidate.standaloneCli.archives.find(
      (artifact) => artifact.os === targetOs && artifact.arch === process.arch,
    );
    if (!target) {
      throw new Error(
        `installers-smoke candidate does not contain native target ${targetOs}-${process.arch}`,
      );
    }
    const assetsDir = dirname(target.archivePath);
    const boundAssetPaths = [
      ...candidate.standaloneCli.archives.map((artifact) => artifact.archivePath),
      candidate.standaloneCli.checksums.filePath,
      candidate.standaloneCli.signature.filePath,
    ];
    if (boundAssetPaths.some((artifactPath) => dirname(artifactPath) !== assetsDir)) {
      throw new Error('installers-smoke candidate native matrix must share one assets directory');
    }
    return {
      assetsDir,
      installVersion: candidate.cli.version,
      installerPath: platform === 'win32'
        ? candidate.installers.powershell.filePath
        : candidate.installers.shell.filePath,
      publicKey: await readFile(candidate.installers.publicKey.filePath, 'utf8'),
      envPathEntries: signing.keyPathEntries,
      async cleanup() {
        await signing.cleanup();
      },
    };
  } catch (error) {
    await signing.cleanup();
    throw error;
  }
}
