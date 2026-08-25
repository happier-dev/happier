import { access, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildCliBinaryArtifactCodePayload,
  buildCliBinaryArtifactSupportPayload,
  CLI_BINARY_TARGETS,
  readCliBinaryArtifactSupportIdentity,
  resolveCurrentBinaryTarget,
  writeCliBinaryArtifactRuntimeAssetBuildManifest,
} from '@happier-dev/cli-common/componentArtifacts';
import { withWorkspaceBundleLock } from '@happier-dev/cli-common/workspaceBundleLock';

import {
  artifactPayloadDir,
  readArtifactManifest,
  readReusableArtifactManifest,
  writeArtifactManifest,
} from '../runtime/shared/artifact_manifest.mjs';
import { resolveStackComponentArtifactDir } from '../runtime/shared/runtime_paths.mjs';
import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import { runCapture } from '../utils/proc/proc.mjs';

const DAEMON_SUPPORT_DIRECTORIES = Object.freeze(['node_modules', 'tools', 'scripts']);

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
  env = process.env,
  runCaptureImpl = runCapture,
  resolveCurrentBinaryTargetImpl = resolveCurrentBinaryTarget,
  readCliBinaryArtifactSupportIdentityImpl = readCliBinaryArtifactSupportIdentity,
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
  });
  const fingerprint = String(identity?.fingerprint ?? '').trim();
  if (!fingerprint) throw new Error('[build] daemon support identity did not produce a fingerprint.');
  return fingerprint;
}

async function assertDaemonSupportPayload({ supportPayloadDir }) {
  await Promise.all(DAEMON_SUPPORT_DIRECTORIES.map(async (name) => {
    try {
      await access(join(supportPayloadDir, name));
    } catch {
      throw new Error(`[build] daemon support artifact is incomplete: missing ${name}.`);
    }
  }));
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
      join(supportPayloadDir, name),
      linkPath,
      platform === 'win32' ? 'junction' : 'dir',
    );
  }
}

async function buildDaemonSupportArtifact({
  stackBaseDir,
  supportArtifactFingerprint,
  sourceMetadata,
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
      });
      await writeArtifactManifest({
        artifactDir: tmpArtifactDir,
        manifest: {
          version: 1,
          component: 'daemon-support',
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
  });
}

export async function buildDaemonArtifact({
  rootDir,
  stackBaseDir,
  artifactDir,
  artifactFingerprint,
  supportArtifactFingerprint,
  sourceMetadata,
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
      ?? await resolveDaemonSupportArtifactFingerprintImpl({ rootDir, sourceMetadata, env }),
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

  const target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS });
  const externals = String(env.HAPPIER_CLI_BUN_EXTERNALS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  await buildIntoTempThenReplace(artifactDir, async (tmpArtifactDir) => {
    const payloadDir = artifactPayloadDir(tmpArtifactDir);
    const built = await buildCliBinaryArtifactPayloadImpl({
      repoRoot: repoDir,
      payloadDir,
      target,
      externals,
      env,
    });
    const currentSupportArtifactFingerprint = String(
      await resolveDaemonSupportArtifactFingerprintImpl({ rootDir, sourceMetadata, env }),
    ).trim();
    if (currentSupportArtifactFingerprint !== resolvedSupportArtifactFingerprint) {
      throw new Error(
        '[component-artifacts] daemon support publication changed before staging '
        + `(expected ${resolvedSupportArtifactFingerprint}, found ${currentSupportArtifactFingerprint})`,
      );
    }
    const supportArtifact = await buildDaemonSupportArtifact({
      stackBaseDir: resolvedStackBaseDir,
      supportArtifactFingerprint: resolvedSupportArtifactFingerprint,
      sourceMetadata,
      target,
      env,
      runCaptureImpl,
      buildDaemonSupportArtifactPayloadImpl,
    });
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
        artifactFingerprint,
        daemonSupportArtifactFingerprint: resolvedSupportArtifactFingerprint,
        sourceFingerprint: sourceMetadata.sourceFingerprint,
        createdAt: sourceMetadata.builtAt,
        source: sourceMetadata,
        payloadDir: 'payload',
        entrypoint: built.entrypoint,
      },
    });
  });

  const manifest = await readArtifactManifest({ artifactDir });
  return { artifactDir, manifest };
}
