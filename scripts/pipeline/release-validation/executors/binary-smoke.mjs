// @ts-check

import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  extractArchivePayloadToDirectory,
} from '@happier-dev/release-runtime/archiveExtraction';
import {
  loadPackedAuthorCandidateManifest,
} from '../../../../packages/tests/scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import {
  prepareReleaseValidationMinisignEnv,
} from './installers-smoke-local-build.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const HOST_PAYLOAD_SMOKE_TIMEOUT_MS = 120_000;

export function resolveCandidateHostPayloadSmokeInput(
  candidate,
  {
    platform = process.platform,
    arch = process.arch,
  } = {},
) {
  const os = platform === 'win32' ? 'windows' : platform;
  const target = `${os}-${arch}`;
  const archive = candidate?.standaloneCli?.archives?.find(
    (artifact) => artifact.os === os && artifact.arch === arch,
  );
  if (!archive) {
    throw new Error(`binary-smoke candidate does not contain native target ${target}`);
  }
  const notarizationEvidence = os === 'darwin'
    ? candidate.standaloneCli.notarization?.find((record) => record.target === target)
        ?.evidence ?? null
    : null;
  if (os === 'darwin' && !notarizationEvidence) {
    throw new Error(`binary-smoke candidate is missing notarization evidence for ${target}`);
  }
  return {
    archivePath: archive.archivePath,
    archiveName: basename(archive.archivePath),
    notarizationEvidence,
    target,
  };
}

export async function runCandidateHostPayloadSmoke(
  {
    archivePath,
    archiveName,
    notarizationEvidence,
    target,
    env = process.env,
  },
  {
    execFileSyncImpl = execFileSync,
    extractArchivePayloadToDirectoryImpl = extractArchivePayloadToDirectory,
  } = {},
) {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-candidate-host-smoke-'));
  try {
    await extractArchivePayloadToDirectoryImpl({
      archivePath,
      archiveName,
      extractDir: scratch,
    });
    const payloadName = archiveName.slice(0, -'.tar.gz'.length);
    const payloadRoot = join(scratch, payloadName);
    const payloadStats = await lstat(payloadRoot);
    if (payloadStats.isSymbolicLink() || !payloadStats.isDirectory()) {
      throw new Error(`binary-smoke candidate payload root is invalid for ${target}`);
    }
    const voiceRuntimeLoader = join(
      payloadRoot,
      'scripts',
      'runtime',
      'loadVoiceInferenceRuntime.mjs',
    );
    const loaderStats = await lstat(voiceRuntimeLoader);
    if (loaderStats.isSymbolicLink() || !loaderStats.isFile()) {
      throw new Error(`binary-smoke candidate Voice runtime loader is invalid for ${target}`);
    }
    execFileSyncImpl(process.execPath, [voiceRuntimeLoader], {
      cwd: payloadRoot,
      env,
      stdio: 'inherit',
      timeout: HOST_PAYLOAD_SMOKE_TIMEOUT_MS,
    });
    if (target.startsWith('darwin-')) {
      execFileSyncImpl(
        process.execPath,
        [
          resolve(
            REPO_ROOT,
            'scripts',
            'pipeline',
            'release',
            'notarize-standalone-binary.mjs',
          ),
          '--verify-evidence',
          '--payload',
          payloadRoot,
          '--evidence',
          notarizationEvidence.filePath,
        ],
        {
          cwd: REPO_ROOT,
          env,
          stdio: 'inherit',
          timeout: HOST_PAYLOAD_SMOKE_TIMEOUT_MS,
        },
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * @param {{ repoRoot: string; platform: 'linux' | 'darwin' | 'win32'; source: { kind: string; ref: string } | null }} params
 */
export function resolveBinarySmokeExecution({ repoRoot, platform, source }) {
  void platform;
  if (!source || source.kind !== 'local-build') {
    throw new Error('binary-smoke currently supports only --source local-build');
  }
  return {
    type: 'command',
    command: process.execPath,
    args: [
      fileURLToPath(import.meta.url),
      '--candidate',
      resolve(repoRoot, source.ref),
    ],
    cwd: repoRoot,
  };
}

/**
 * @param {{ repoRoot: string; platform: 'linux' | 'darwin' | 'win32'; source: { kind: string; ref: string } | null }} params
 */
export function runBinarySmokeValidation({ repoRoot, platform, source }) {
  if (platform !== process.platform) {
    throw new Error(
      `binary-smoke must run natively for ${platform}; current platform is ${process.platform}`,
    );
  }
  const execution = resolveBinarySmokeExecution({ repoRoot, platform, source });
  execFileSync(execution.command, execution.args, {
    cwd: execution.cwd,
    stdio: 'inherit',
  });
}

/**
 * @param {string} candidateManifestPath
 * @param {{
 *   loadCandidateImpl?: (manifestPath: string) => Promise<any>;
 *   prepareMinisignEnvImpl?: (params: { repoRoot: string }) => Promise<{
 *     env: NodeJS.ProcessEnv;
 *     cleanup: () => Promise<void>;
 *   }>;
 *   execFileSyncImpl?: typeof execFileSync;
 *   runCandidateHostPayloadSmokeImpl?: typeof runCandidateHostPayloadSmoke;
 * }} [dependencies]
 */
export async function runCandidateBinarySmoke(
  candidateManifestPath,
  {
    loadCandidateImpl = async (manifestPath) => loadPackedAuthorCandidateManifest(
      ['--candidate', manifestPath],
      { cwd: REPO_ROOT },
    ),
    prepareMinisignEnvImpl = prepareReleaseValidationMinisignEnv,
    execFileSyncImpl = execFileSync,
    runCandidateHostPayloadSmokeImpl = runCandidateHostPayloadSmoke,
  } = {},
) {
  const manifestPath = resolve(candidateManifestPath);
  const candidate = await loadCandidateImpl(manifestPath);
  if (!candidate.standaloneCli?.signature) {
    throw new Error('binary-smoke exact candidate requires a bound minisign signature');
  }
  const hostPayload = resolveCandidateHostPayloadSmokeInput(candidate);
  const artifactsDir = dirname(candidate.standaloneCli.archives[0].archivePath);
  const boundAssetPaths = [
    ...candidate.standaloneCli.archives.map((artifact) => artifact.archivePath),
    candidate.standaloneCli.checksums.filePath,
    candidate.standaloneCli.signature.filePath,
  ];
  if (boundAssetPaths.some((artifactPath) => dirname(artifactPath) !== artifactsDir)) {
    throw new Error('binary-smoke candidate native matrix must share one assets directory');
  }
  const minisign = await prepareMinisignEnvImpl({ repoRoot: REPO_ROOT });
  try {
    execFileSyncImpl(
      process.execPath,
      [
        resolve(REPO_ROOT, 'scripts', 'pipeline', 'release', 'verify-artifacts.mjs'),
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        candidate.standaloneCli.checksums.filePath,
        '--public-key',
        candidate.installers.publicKey.filePath,
      ],
      {
        cwd: REPO_ROOT,
        env: minisign.env,
        stdio: 'inherit',
      },
    );
    await runCandidateHostPayloadSmokeImpl({
      ...hostPayload,
      env: minisign.env,
    });
  } finally {
    await minisign.cleanup();
  }
}

const isMain =
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const candidateIndex = process.argv.indexOf('--candidate');
  const candidateManifestPath = candidateIndex >= 0 ? process.argv[candidateIndex + 1] : null;
  if (!candidateManifestPath || candidateManifestPath.startsWith('--')) {
    throw new Error('binary-smoke requires --candidate <candidate-manifest.json>');
  }
  await runCandidateBinarySmoke(candidateManifestPath);
}
