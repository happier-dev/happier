import { access, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { artifactPayloadDir, readArtifactManifest, readReusableArtifactManifest, writeArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';
import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import {
  buildServerBinaryArtifactPayload,
  buildServerRuntimeSupportPayload,
  readServerRuntimeSupportIdentity,
  resolveCurrentBinaryTarget,
  resolveBunCommand,
  resolveServerRuntimeSupportBuildDbProviders,
  resolveServerRuntimeSupportEntries,
  resolveServerRuntimeSupportToolIdentityEntries,
  SERVER_BINARY_DEFAULT_EXTERNALS,
  SERVER_BINARY_TARGETS,
} from '@happier-dev/cli-common/componentArtifacts';
import { withWorkspaceBundleLock } from '@happier-dev/cli-common/workspaceBundleLock';
import { runCapture } from '../utils/proc/proc.mjs';

const SERVER_RUNTIME_SUPPORT_ENTRYPOINT = '.happier-server-support.json';
const SERVER_RUNTIME_SUPPORT_DIRECTORIES = Object.freeze(['generated', 'prisma', 'node_modules']);

function resolveServerRuntimeSupportDirectories(serverComponent) {
  return serverComponent === 'happier-server'
    ? [...SERVER_RUNTIME_SUPPORT_DIRECTORIES, 'runtime']
    : SERVER_RUNTIME_SUPPORT_DIRECTORIES;
}

function requireArtifactFingerprint(value, label) {
  const fingerprint = String(value ?? '').trim();
  if (!fingerprint || fingerprint === '.' || fingerprint === '..' || /[\\/\u0000]/.test(fingerprint)) {
    throw new Error(`[build] ${label} must be a non-empty artifact fingerprint.`);
  }
  return fingerprint;
}

async function readServerRuntimeSupportToolInputs({ serverComponent, env }) {
  if (serverComponent !== 'happier-server') return [];
  const bunCommand = resolveBunCommand({ processEnv: env });
  if (!bunCommand) {
    throw new Error('[build] Bun is required to collect full-server Prisma migration support identity.');
  }
  const bunVersion = String(await runCapture(bunCommand, ['--version'], {
    env,
    timeoutMs: 10_000,
  })).trim();
  if (!bunVersion) {
    throw new Error('[build] Bun returned an empty version while collecting full-server Prisma migration support identity.');
  }
  return [`bun=${bunVersion}`];
}

/**
 * This is the server owner's exact support closure: generated Prisma files,
 * native/runtime dependencies, and the target they run on. It intentionally
 * does not create a store object or publish code, so identity calculation can
 * precede managed server-code fingerprinting.
 */
export async function resolveServerRuntimeSupportInputs({
  rootDir,
  sourceMetadata,
  env = process.env,
}) {
  void rootDir;
  const serverComponent = sourceMetadata?.serverComponent;
  if (serverComponent !== 'happier-server' && serverComponent !== 'happier-server-light') {
    throw new Error('[build] server runtime support requires a recognized server component.');
  }
  const target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS });
  const buildDbProviders = resolveServerRuntimeSupportBuildDbProviders({
    serverComponent,
    env,
  });
  const entries = await resolveServerRuntimeSupportEntries({
    repoRoot: sourceMetadata.repoDir,
    target,
    serverComponent,
    buildDbProviders,
    env,
  });
  const [toolIdentityEntries, toolInputs] = await Promise.all([
    resolveServerRuntimeSupportToolIdentityEntries({
      repoRoot: sourceMetadata.repoDir,
      serverComponent,
    }),
    readServerRuntimeSupportToolInputs({ serverComponent, env }),
  ]);
  const identity = await readServerRuntimeSupportIdentity({
    entries,
    toolIdentityEntries,
    toolInputs,
    target,
    serverComponent,
    buildDbProviders,
  });
  return {
    ...identity,
    entries,
    toolIdentityEntries,
    toolInputs,
    target,
    serverComponent,
    buildDbProviders,
  };
}

/**
 * E5 consumes this pure pre-publication owner query when deriving a managed
 * server-code identity. It reads/prepares existing server sidecar inputs but
 * never writes an artifact-store object.
 */
export async function resolveServerSupportArtifactFingerprint({
  rootDir,
  sourceMetadata,
  env = process.env,
  resolveServerRuntimeSupportInputsImpl = resolveServerRuntimeSupportInputs,
}) {
  const supportInputs = await resolveServerRuntimeSupportInputsImpl({
    rootDir,
    sourceMetadata,
    env,
  });
  return requireArtifactFingerprint(supportInputs?.fingerprint, 'server runtime support identity');
}

export function resolveServerSupportArtifactDir({ artifactDir, supportArtifactFingerprint }) {
  const fingerprint = requireArtifactFingerprint(supportArtifactFingerprint, 'server runtime support identity');
  return join(dirname(dirname(artifactDir)), 'server-support', fingerprint);
}

async function readReusableServerSupportArtifact({ artifactDir, artifactFingerprint }) {
  const manifest = await readReusableArtifactManifest({ artifactDir, artifactFingerprint });
  if (!manifest) return null;
  if (manifest.component !== 'server-support') {
    throw new Error(`[build] server runtime support artifact has the wrong component: ${artifactDir}`);
  }
  return manifest;
}

async function assertServerRuntimeSupportPayload({ supportPayloadDir, serverComponent }) {
  await Promise.all(resolveServerRuntimeSupportDirectories(serverComponent).map(async (name) => {
    try {
      await access(join(supportPayloadDir, name));
    } catch {
      throw new Error(`[build] server runtime support artifact is incomplete: missing ${name}.`);
    }
  }));
}

/**
 * New managed code artifacts remain directly launchable while their large
 * Prisma/native trees stay in the immutable server-support object. The links
 * are created only inside the unpublished code-artifact staging directory;
 * Windows uses junctions because ordinary symlink creation is not portable.
 */
export async function linkServerRuntimeSupportPayload({
  codePayloadDir,
  supportPayloadDir,
  serverComponent = 'happier-server-light',
  platform = process.platform,
  mkdirImpl = mkdir,
  rmImpl = rm,
  symlinkImpl = symlink,
} = {}) {
  await mkdirImpl(codePayloadDir, { recursive: true });
  for (const name of resolveServerRuntimeSupportDirectories(serverComponent)) {
    const linkPath = join(codePayloadDir, name);
    await rmImpl(linkPath, { recursive: true, force: true });
    await symlinkImpl(
      join(supportPayloadDir, name),
      linkPath,
      platform === 'win32' ? 'junction' : 'dir',
    );
  }
}

async function publishServerRuntimeSupportArtifact({
  supportArtifactDir,
  supportArtifactFingerprint,
  sourceMetadata,
  env,
  resolveServerRuntimeSupportInputsImpl = resolveServerRuntimeSupportInputs,
  buildServerRuntimeSupportPayloadImpl = buildServerRuntimeSupportPayload,
  withWorkspaceBundleLockImpl = withWorkspaceBundleLock,
}) {
  return await withWorkspaceBundleLockImpl(async () => {
    const existing = await readReusableServerSupportArtifact({
      artifactDir: supportArtifactDir,
      artifactFingerprint: supportArtifactFingerprint,
    });
    if (existing) {
      const payloadDir = artifactPayloadDir(supportArtifactDir);
      await assertServerRuntimeSupportPayload({
        supportPayloadDir: payloadDir,
        serverComponent: sourceMetadata.serverComponent,
      });
      return { artifactDir: supportArtifactDir, manifest: existing, payloadDir };
    }

    const supportInputs = await resolveServerRuntimeSupportInputsImpl({
      rootDir: sourceMetadata.repoDir,
      sourceMetadata,
      env,
    });
    const observedFingerprint = requireArtifactFingerprint(
      supportInputs?.fingerprint,
      'server runtime support identity',
    );
    if (observedFingerprint !== supportArtifactFingerprint) {
      throw new Error(
        '[build] server runtime support inputs changed while publishing; recompute the server artifact identity and retry.',
      );
    }

    await buildIntoTempThenReplace(supportArtifactDir, async (tmpArtifactDir) => {
      const payloadDir = artifactPayloadDir(tmpArtifactDir);
      await buildServerRuntimeSupportPayloadImpl({
        repoRoot: sourceMetadata.repoDir,
        payloadDir,
        entries: supportInputs.entries,
        target: supportInputs.target,
        buildDbProviders: supportInputs.buildDbProviders,
        serverComponent: supportInputs.serverComponent,
        env,
      });
      // Support artifacts are immutable. Re-read the same owner closure after
      // staging so a concurrent Prisma/native/tool update cannot publish
      // bytes under the fingerprint that existed before the copy began.
      const stagedSupportInputs = await resolveServerRuntimeSupportInputsImpl({
        rootDir: sourceMetadata.repoDir,
        sourceMetadata,
        env,
      });
      const stagedFingerprint = requireArtifactFingerprint(
        stagedSupportInputs?.fingerprint,
        'server runtime support identity',
      );
      if (stagedFingerprint !== supportArtifactFingerprint) {
        throw new Error(
          '[build] server runtime support inputs changed while staging; recompute the server artifact identity and retry.',
        );
      }
      await writeFile(join(payloadDir, SERVER_RUNTIME_SUPPORT_ENTRYPOINT), JSON.stringify({
        version: 1,
        artifactFingerprint: supportArtifactFingerprint,
        entryCount: supportInputs.entryCount,
      }), 'utf8');
      await writeArtifactManifest({
        artifactDir: tmpArtifactDir,
        manifest: {
          version: 1,
          component: 'server-support',
          artifactFingerprint: supportArtifactFingerprint,
          sourceFingerprint: supportArtifactFingerprint,
          createdAt: sourceMetadata.builtAt,
          source: sourceMetadata,
          payloadDir: 'payload',
          entrypoint: SERVER_RUNTIME_SUPPORT_ENTRYPOINT,
        },
      });
    });

    const manifest = await readArtifactManifest({ artifactDir: supportArtifactDir });
    const payloadDir = artifactPayloadDir(supportArtifactDir);
    await assertServerRuntimeSupportPayload({
      supportPayloadDir: payloadDir,
      serverComponent: supportInputs.serverComponent,
    });
    return { artifactDir: supportArtifactDir, manifest, payloadDir };
  }, {
    lockPath: `${supportArtifactDir}.lock`,
    errorLabel: 'server runtime support artifact lock',
  });
}

export async function buildServerArtifact({
  rootDir,
  artifactDir,
  artifactFingerprint,
  sourceMetadata,
  forceRebuild = false,
  env = process.env,
  supportArtifactFingerprint,
  resolveServerSupportArtifactFingerprintImpl = resolveServerSupportArtifactFingerprint,
  resolveServerRuntimeSupportInputsImpl = resolveServerRuntimeSupportInputs,
  buildServerRuntimeSupportPayloadImpl = buildServerRuntimeSupportPayload,
  withWorkspaceBundleLockImpl = withWorkspaceBundleLock,
  buildServerBinaryArtifactPayloadImpl = buildServerBinaryArtifactPayload,
}) {
  void forceRebuild;
  const existing = await readReusableArtifactManifest({ artifactDir, artifactFingerprint });
  if (existing) {
    if (existing.component !== 'server') {
      throw new Error('[build] server artifact fingerprint collides with another component.');
    }
    // Pre-split artifacts contain their Prisma/native support in their own
    // payload. They stay launchable without asking a newer producer to resolve
    // or publish support that did not exist when they were created.
    if (existing.serverSupportArtifactFingerprint == null) {
      return { artifactDir, manifest: existing };
    }
  }

  const observedSupportArtifactFingerprint = await resolveServerSupportArtifactFingerprintImpl({
    rootDir,
    sourceMetadata,
    env,
  });
  const resolvedSupportArtifactFingerprint = requireArtifactFingerprint(
    supportArtifactFingerprint ?? observedSupportArtifactFingerprint,
    'server runtime support identity',
  );
  if (
    supportArtifactFingerprint != null
    && resolvedSupportArtifactFingerprint
      !== requireArtifactFingerprint(observedSupportArtifactFingerprint, 'server runtime support identity')
  ) {
    throw new Error('[build] server runtime support inputs changed; recompute the server artifact identity and retry.');
  }

  if (existing) {
    if (existing.serverSupportArtifactFingerprint === resolvedSupportArtifactFingerprint) {
      return { artifactDir, manifest: existing };
    }
    throw new Error(
      '[build] immutable server artifact fingerprint is already bound to a different support artifact.',
    );
  }

  const supportArtifactDir = resolveServerSupportArtifactDir({
    artifactDir,
    supportArtifactFingerprint: resolvedSupportArtifactFingerprint,
  });
  const supportArtifact = await publishServerRuntimeSupportArtifact({
    supportArtifactDir,
    supportArtifactFingerprint: resolvedSupportArtifactFingerprint,
    sourceMetadata,
    env,
    resolveServerRuntimeSupportInputsImpl,
    buildServerRuntimeSupportPayloadImpl,
    withWorkspaceBundleLockImpl,
  });

  if (supportArtifact.manifest?.component !== 'server-support') {
    throw new Error(`[build] server runtime support artifact is invalid: ${supportArtifactDir}`);
  }
  const supportServerComponent = sourceMetadata?.serverComponent;
  await assertServerRuntimeSupportPayload({
    supportPayloadDir: supportArtifact.payloadDir,
    serverComponent: supportServerComponent,
  });

  const serverComponent = sourceMetadata?.serverComponent;
  if (serverComponent !== 'happier-server' && serverComponent !== 'happier-server-light') {
    throw new Error('[build] managed server artifact requires a recognized server component.');
  }
  const target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS });
  const buildDbProviders = resolveServerRuntimeSupportBuildDbProviders({ serverComponent, env });
  const externals = String(
    env.HAPPIER_SERVER_BUN_EXTERNALS ?? SERVER_BINARY_DEFAULT_EXTERNALS.join(','),
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const serverEntrypoint = join(
    sourceMetadata.repoDir,
    'apps',
    'server',
    'sources',
    serverComponent === 'happier-server' ? 'main.ts' : 'main.light.ts',
  );

  await buildIntoTempThenReplace(artifactDir, async (tmpArtifactDir) => {
    const payloadDir = artifactPayloadDir(tmpArtifactDir);
    const built = await buildServerBinaryArtifactPayloadImpl({
      repoRoot: sourceMetadata.repoDir,
      payloadDir,
      includeRuntimeSupport: false,
      target,
      serverComponent,
      entrypoint: serverEntrypoint,
      externals,
      buildDbProviders,
      env,
    });
    await linkServerRuntimeSupportPayload({
      codePayloadDir: payloadDir,
      supportPayloadDir: supportArtifact.payloadDir,
      serverComponent,
    });

    await writeArtifactManifest({
      artifactDir: tmpArtifactDir,
      manifest: {
        version: 1,
        component: 'server',
        artifactFingerprint,
        serverSupportArtifactFingerprint: resolvedSupportArtifactFingerprint,
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
