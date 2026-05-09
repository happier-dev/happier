// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { loadCliCommonDistModule } from '../../../ensureCliCommonDistModule.mjs';

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
 * @param {string} raw
 */
function parseTrailingJsonObject(raw) {
  const value = String(raw ?? '').trim();
  const lastObjectStart = value.lastIndexOf('\n{');
  const candidate = lastObjectStart >= 0 ? value.slice(lastObjectStart + 1) : value;
  return JSON.parse(candidate);
}

export const parseTrailingJsonObjectForTests = parseTrailingJsonObject;

/**
 * @param {{ version?: unknown; artifacts?: unknown }} buildOutput
 * @returns {string | null}
 */
function resolveLocalBuildInstallVersion(buildOutput) {
  const explicit = String(buildOutput?.version ?? '').trim();
  if (explicit.length > 0) {
    return explicit;
  }
  const artifacts = Array.isArray(buildOutput?.artifacts) ? buildOutput.artifacts : [];
  for (const artifact of artifacts) {
    const name = String(artifact ?? '');
    const match = name.match(/^.+-v(.+)-(linux|darwin|win32)-[^-]+[.]tar[.]gz$/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export const resolveLocalBuildInstallVersionForTests = resolveLocalBuildInstallVersion;
const LOCAL_BUILD_TIMEOUT_MS = 20 * 60_000;

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
 * @param {{ repoRoot: string; platform: 'linux' | 'darwin' | 'win32'; releaseChannel: 'stable' | 'preview' | 'publicdev' }} params
 */
export async function prepareInstallersSmokeLocalBuildAssets({ repoRoot, platform, releaseChannel }) {
  const scratchDir = await mkdtemp(join(tmpdir(), 'happier-installers-local-build-'));
  const { env: signingEnv, keyPathEntries } = resolveSigningEnv({ repoRoot, scratchDir });
  const componentArtifacts = await loadCliCommonDistModule({
    repoRoot,
    subpath: 'componentArtifacts',
  });
  const target = componentArtifacts.resolveCurrentBinaryTarget({
    availableTargets: componentArtifacts.CLI_BINARY_TARGETS,
    platform,
    arch: process.arch,
  });
  const targetId = `${target.os}-${target.arch}`;

  const keyDir = join(scratchDir, 'minisign');
  await mkdir(keyDir, { recursive: true });
  const publicKeyPath = join(keyDir, 'installers-smoke.pub');
  const secretKeyPath = join(keyDir, 'installers-smoke.key');
  execFileSync('minisign', ['-G', '-p', publicKeyPath, '-s', secretKeyPath, '-W'], {
    cwd: repoRoot,
    env: signingEnv,
    stdio: 'ignore',
  });

  const rawOutput = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'build-cli-binaries.mjs'),
      '--channel',
      releaseChannel === 'publicdev' ? 'dev' : releaseChannel,
      '--targets',
      targetId,
    ],
    {
      cwd: repoRoot,
      env: {
        ...signingEnv,
        CI: '1',
        MINISIGN_SECRET_KEY: secretKeyPath,
        HAPPIER_RELEASE_PARENT_TIMEOUT_MS: String(LOCAL_BUILD_TIMEOUT_MS),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: LOCAL_BUILD_TIMEOUT_MS,
    },
  );

  /** @type {{ version?: string; outDir: string; artifacts: string[]; checksums: string; signature: string | null }} */
  const buildOutput = parseTrailingJsonObject(rawOutput);
  if (!buildOutput.signature) {
    throw new Error('installers-smoke local-build expected build-cli-binaries to produce a minisign signature');
  }
  const installVersion = resolveLocalBuildInstallVersion(buildOutput);

  const assetsDir = join(scratchDir, 'release-assets');
  await mkdir(assetsDir, { recursive: true });
  const generatedPaths = [
    ...buildOutput.artifacts.map((artifactName) => resolve(buildOutput.outDir, artifactName)),
    resolve(buildOutput.checksums),
    resolve(buildOutput.signature),
  ];
  for (const sourcePath of generatedPaths) {
    await copyFile(sourcePath, join(assetsDir, sourcePath.split(/[\\/]/).pop() ?? 'asset'));
  }

  const publicKey = await readFile(publicKeyPath, 'utf8');

  return {
    assetsDir,
    installVersion,
    publicKey,
    envPathEntries: keyPathEntries,
    async cleanup() {
      await Promise.allSettled(generatedPaths.map((path) => rm(path, { force: true })));
      await rm(scratchDir, { recursive: true, force: true });
    },
  };
}
