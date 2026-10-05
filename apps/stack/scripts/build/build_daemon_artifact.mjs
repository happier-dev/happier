import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import {
  buildCliBinaryArtifactCodePayload,
  buildCliBinaryArtifactSupportPayload,
  CLI_BINARY_TARGETS,
  readCliBinaryArtifactSupportIdentity,
  resolveCurrentBinaryTarget,
  writeCliBinaryArtifactRuntimeAssetBuildManifest,
} from '@happier-dev/cli-common/componentArtifacts';
import { withWorkspaceBundleLock } from '@happier-dev/cli-common/workspaceBundleLock';
import { resolveWorkspaceBundlesFromPackageJson } from '@happier-dev/cli-common/workspaces';

import { readWorkspacePackageInputFingerprint } from '../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { resolveBundledPluginGeneratorInputPaths } from '../../../cli/scripts/build-owned/bundledPlugins/authoringInputs.mjs';
import { createWorkspaceBuildWaitNotifier } from '../utils/proc/workspaceBuildWaitNotifier.mjs';

import {
  artifactPayloadDir,
  readArtifactManifest,
  readReusableArtifactManifest,
  validateArtifactManifest,
  writeArtifactManifest,
} from '../runtime/shared/artifact_manifest.mjs';
import { resolveStackComponentArtifactDir } from '../runtime/shared/runtime_paths.mjs';
import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import { runCapture } from '../utils/proc/proc.mjs';

import { assertDaemonSupportPayload, DAEMON_SUPPORT_DIRECTORIES } from '../runtime/shared/daemon_support_payload.mjs';

function readDaemonSupportWorkspaceRuntimeIdentity(manifest) {
  const workspaceRuntimeIdentity = String(manifest?.daemonWorkspaceRuntimeIdentity ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(workspaceRuntimeIdentity)) {
    throw new Error('[build] daemon support artifact is missing its staged workspace runtime identity.');
  }
  return workspaceRuntimeIdentity;
}

function resolveDaemonArtifactRepoDir({ rootDir, sourceMetadata }) {
  return String(sourceMetadata?.repoDir ?? rootDir ?? '').trim();
}

export function readDaemonWorkspaceSourceFingerprint({ repoDir, stalePackages = [] }) {
  const hash = createHash('sha256');
  hash.update('happier:daemon-workspace-source:v1\0');
  const bundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot: repoDir,
    hostPackageDir: join(repoDir, 'apps', 'cli'),
  });
  for (const { packageName, srcDir } of bundles) {
    hash.update(`${packageName}\0${readWorkspacePackageInputFingerprint({
      packageDir: srcDir,
      includeShippedFiles: true,
      excludeGeneratedPluginManifest: true,
    })}\0`);
  }
  // Packaged plugin resources are derived from the single publisher and its
  // build-owned helpers. Reuse the source input owner so renderer-only edits
  // invalidate support too, while tests and generated outputs stay excluded.
  for (const input of resolveBundledPluginGeneratorInputPaths({ repoDir })) {
    const relativeInput = relative(join(repoDir, 'apps', 'cli'), input).replaceAll('\\', '/');
    if (relativeInput !== 'scripts/build-owned/generateBundledPluginEntries.ts') hash.update(`${relativeInput}\0`);
    hash.update(readFileSync(input));
  }
  if (stalePackages.length) hash.update(`qa-last-green\0${JSON.stringify(stalePackages
    .map(({ packageName, outputIdentity }) => ({ packageName, outputIdentity }))
    .sort((a, b) => a.packageName.localeCompare(b.packageName)))}`);
  return hash.digest('hex');
}

export async function readDaemonSupportGoVersion({
  repoDir,
  env = process.env,
  runCaptureImpl = runCapture,
} = {}) {
  const version = String(await runCaptureImpl('go', ['version'], {
    cwd: repoDir,
    env,
    timeoutMs: 10_000,
  })).trim();
  if (!version) {
    throw new Error('[build] Go returned an empty version while collecting daemon support identity.');
  }
  return version;
}

/**
 * This is intentionally the daemon owner’s narrow support identity. E5 uses
 * only the resulting fingerprint when it composes a daemon code identity.
 */
export async function resolveDaemonSupportArtifactFingerprint({
  rootDir,
  sourceMetadata,
  workspaceSourceFingerprint,
  env = process.env,
  runCaptureImpl = runCapture,
  resolveCurrentBinaryTargetImpl = resolveCurrentBinaryTarget,
  readCliBinaryArtifactSupportIdentityImpl = readCliBinaryArtifactSupportIdentity,
  readDaemonWorkspaceSourceFingerprintImpl = readDaemonWorkspaceSourceFingerprint,
} = {}) {
  const repoDir = resolveDaemonArtifactRepoDir({ rootDir, sourceMetadata });
  if (!repoDir) throw new Error('[build] daemon support identity requires a repository directory.');
  const target = resolveCurrentBinaryTargetImpl({ availableTargets: CLI_BINARY_TARGETS });
  const goVersion = await readDaemonSupportGoVersion({
    repoDir,
    env,
    runCaptureImpl,
  });
  const identity = readCliBinaryArtifactSupportIdentityImpl({
    repoRoot: repoDir,
    target,
    goVersion,
    workspaceSourceFingerprint: workspaceSourceFingerprint
      ?? readDaemonWorkspaceSourceFingerprintImpl({ repoDir }),
  });
  const fingerprint = String(identity?.fingerprint ?? '').trim();
  if (!fingerprint) throw new Error('[build] daemon support identity did not produce a fingerprint.');
  return fingerprint;
}

/**
 * Code artifacts intentionally contain only daemon code. These links are
 * created in an unpublished temporary artifact directory, so replacing them
 * cannot perturb an already selected runtime. Windows uses directory junctions
 * because unprivileged symlink creation is not a portable assumption there.
 */
export async function linkDaemonSupportPayload({
  codePayloadDir,
  supportPayloadDir,
  platform = process.platform,
  mkdirImpl = mkdir,
  rmImpl = rm,
  symlinkImpl = symlink,
} = {}) {
  await mkdirImpl(codePayloadDir, { recursive: true });
  for (const name of DAEMON_SUPPORT_DIRECTORIES) {
    const linkPath = join(codePayloadDir, name);
    await rmImpl(linkPath, { recursive: true, force: true });
    await symlinkImpl(
      platform === 'win32' ? join(supportPayloadDir, name) : relative(dirname(linkPath), join(supportPayloadDir, name)),
      linkPath,
      platform === 'win32' ? 'junction' : 'dir',
    );
  }
}

async function buildDaemonSupportArtifact({
  stackBaseDir,
  supportArtifactFingerprint,
  sourceMetadata,
  workspaceSourceFingerprint,
  expectedWorkspaceRuntimeIdentity,
  target,
  env,
  runCaptureImpl,
  buildDaemonSupportArtifactPayloadImpl,
}) {
  const artifactDir = resolveStackComponentArtifactDir({
    stackBaseDir,
    component: 'daemon-support',
    fingerprint: supportArtifactFingerprint,
  });
  const supportLockPath = `${artifactDir}.lock`;
  return await withWorkspaceBundleLock(async () => {
    // Every caller rechecks from inside the per-support immutable-artifact
    // lock. Different daemon code identities can therefore race safely while
    // still sharing exactly one stable support publication.
    const existing = await readReusableArtifactManifest({
      artifactDir,
      artifactFingerprint: supportArtifactFingerprint,
    });
    if (existing) {
      if (existing.component !== 'daemon-support') {
        throw new Error('[build] daemon support artifact fingerprint collides with another component.');
      }
      const payloadDir = artifactPayloadDir(artifactDir);
      await assertDaemonSupportPayload({ supportPayloadDir: payloadDir });
      return {
        artifactDir,
        manifest: existing,
        payloadDir,
        workspaceRuntimeIdentity: readDaemonSupportWorkspaceRuntimeIdentity(existing),
      };
    }

    const repoDir = resolveDaemonArtifactRepoDir({ rootDir: null, sourceMetadata });
    const goVersion = await readDaemonSupportGoVersion({
      repoDir,
      env,
      runCaptureImpl,
    });
    await buildIntoTempThenReplace(artifactDir, async (tmpArtifactDir) => {
      const payloadDir = artifactPayloadDir(tmpArtifactDir);
      const built = await buildDaemonSupportArtifactPayloadImpl({
        repoRoot: repoDir,
        payloadDir,
        target,
        env,
        supportArtifactFingerprint,
        goVersion,
        workspaceSourceFingerprint,
        expectedWorkspaceRuntimeIdentity,
      });
      await writeArtifactManifest({
        artifactDir: tmpArtifactDir,
        manifest: {
          version: 1,
          component: 'daemon-support',
          target: { platform: process.platform, arch: process.arch },
          artifactFingerprint: supportArtifactFingerprint,
          sourceFingerprint: sourceMetadata.sourceFingerprint,
          createdAt: sourceMetadata.builtAt,
          source: sourceMetadata,
          payloadDir: 'payload',
          entrypoint: built.entrypoint,
          daemonWorkspaceRuntimeIdentity: built.workspaceRuntimeIdentity,
        },
      });
    });

    const manifest = await readArtifactManifest({ artifactDir });
    const payloadDir = artifactPayloadDir(artifactDir);
    await assertDaemonSupportPayload({ supportPayloadDir: payloadDir });
    return {
      artifactDir,
      manifest,
      payloadDir,
      workspaceRuntimeIdentity: readDaemonSupportWorkspaceRuntimeIdentity(manifest),
    };
  }, {
    lockPath: supportLockPath,
    errorLabel: 'daemon support artifact build lock',
    onWait: createWorkspaceBuildWaitNotifier({ env, label: 'daemon support artifact build', kind: 'lock' }),
  });
}

export async function buildDaemonArtifact({
  rootDir,
  stackBaseDir,
  artifactDir,
  artifactFingerprint,
  supportArtifactFingerprint,
  sourceMetadata,
  stalePackages = [],
  preparedWorkspacePublication,
  requiredCliDistInputFingerprint,
  workspaceSourceFingerprint,
  forceRebuild = false,
  env = process.env,
  resolveDaemonSupportArtifactFingerprintImpl = resolveDaemonSupportArtifactFingerprint,
  buildDaemonSupportArtifactPayloadImpl = buildCliBinaryArtifactSupportPayload,
  buildCliBinaryArtifactPayloadImpl = buildCliBinaryArtifactCodePayload,
  writeCliBinaryArtifactRuntimeAssetBuildManifestImpl = writeCliBinaryArtifactRuntimeAssetBuildManifest,
  runCaptureImpl = runCapture,
}) {
  void forceRebuild;
  const existing = await readReusableArtifactManifest({ artifactDir, artifactFingerprint });
  // Existing pre-split artifacts have no reference and remain valid legacy
  // self-contained artifacts until normal retention removes them. Reusing one
  // must not require either the current producer store or a current support
  // identity: both may have disappeared after an upgrade.
  if (existing && existing.daemonSupportArtifactFingerprint == null) {
    return { artifactDir, manifest: existing };
  }

  const resolvedStackBaseDir = String(stackBaseDir ?? '').trim();
  if (!resolvedStackBaseDir) {
    throw new Error('[build] daemon runtime artifact requires its producer artifact store path.');
  }
  const repoDir = resolveDaemonArtifactRepoDir({ rootDir, sourceMetadata });
  const resolvedSupportArtifactFingerprint = String(
    supportArtifactFingerprint
      ?? await resolveDaemonSupportArtifactFingerprintImpl({ rootDir, sourceMetadata, workspaceSourceFingerprint, env }),
  ).trim();
  if (!resolvedSupportArtifactFingerprint) {
    throw new Error('[build] daemon runtime artifact requires a daemon support identity.');
  }

  if (existing) {
    if (existing.daemonSupportArtifactFingerprint === resolvedSupportArtifactFingerprint) {
      return { artifactDir, manifest: existing };
    }
    throw new Error(
      '[build] immutable daemon artifact fingerprint is already bound to a different support artifact.',
    );
  }

  // Payload damage does not release an immutable artifact's recorded binding.
  const recorded = validateArtifactManifest(await readArtifactManifest({ artifactDir })).manifest;
  if (recorded?.artifactFingerprint === artifactFingerprint
    && recorded.daemonSupportArtifactFingerprint != null
    && recorded.daemonSupportArtifactFingerprint !== resolvedSupportArtifactFingerprint) {
    throw new Error('[build] immutable daemon artifact fingerprint is already bound to a different support artifact.');
  }

  const target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS });
  const externals = String(env.HAPPIER_CLI_BUN_EXTERNALS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  await buildIntoTempThenReplace(artifactDir, async (tmpArtifactDir) => {
    const payloadDir = artifactPayloadDir(tmpArtifactDir);
    // Publish or repair support through its existing owner before compiling
    // code; both must consume the same prepared workspace frame.
    const supportArtifact = await buildDaemonSupportArtifact({
      stackBaseDir: resolvedStackBaseDir,
      supportArtifactFingerprint: resolvedSupportArtifactFingerprint,
      sourceMetadata,
      workspaceSourceFingerprint,
      expectedWorkspaceRuntimeIdentity: preparedWorkspacePublication?.workspaceRuntimeIdentity,
      target,
      env,
      runCaptureImpl,
      buildDaemonSupportArtifactPayloadImpl,
    });
    const built = await buildCliBinaryArtifactPayloadImpl({
      repoRoot: repoDir,
      payloadDir,
      target,
      externals,
      env,
      preparedWorkspacePublication,
      requiredCliDistInputFingerprint,
    });
    if (preparedWorkspacePublication
      && built.workspaceRuntimeIdentity !== preparedWorkspacePublication.workspaceRuntimeIdentity) {
      throw new Error(
        '[component-artifacts] daemon code does not match its prepared workspace runtime frame; restart the phase '
        + `(expected ${preparedWorkspacePublication.workspaceRuntimeIdentity}, found ${built.workspaceRuntimeIdentity})`,
      );
    }
    await linkDaemonSupportPayload({
      codePayloadDir: payloadDir,
      supportPayloadDir: supportArtifact.payloadDir,
    });
    writeCliBinaryArtifactRuntimeAssetBuildManifestImpl({
      payloadDir,
      relativePath: built.runtimeAssetRelativePath,
      workspaceRuntimeIdentity: supportArtifact.workspaceRuntimeIdentity,
    });
    await writeArtifactManifest({
      artifactDir: tmpArtifactDir,
      manifest: {
        version: 1,
        component: 'daemon',
        target: { platform: process.platform, arch: process.arch },
        artifactFingerprint,
        daemonSupportArtifactFingerprint: resolvedSupportArtifactFingerprint,
        sourceFingerprint: sourceMetadata.sourceFingerprint,
        createdAt: sourceMetadata.builtAt,
        source: sourceMetadata,
        ...(stalePackages.length ? { stalePackages } : {}),
        payloadDir: 'payload',
        entrypoint: built.entrypoint,
      },
    });
  });

  const manifest = await readArtifactManifest({ artifactDir });
  return { artifactDir, manifest };
}
