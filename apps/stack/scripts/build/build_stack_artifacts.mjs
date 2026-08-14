import { join } from 'node:path';
import { rm } from 'node:fs/promises';

import {
  commandExists,
  resolveBunCommand,
  resolveYarnCommand,
  SERVER_BINARY_DEFAULT_EXTERNALS,
} from '@happier-dev/cli-common/componentArtifacts';

import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { parseArgs } from '../utils/cli/args.mjs';
import { ensureCliBuilt } from '../utils/proc/pm.mjs';
import { createRuntimeFingerprint } from '../runtime/shared/runtime_fingerprint.mjs';
import { resolveStackComponentArtifactDir } from '../runtime/shared/runtime_paths.mjs';
import { artifactPayloadDir } from '../runtime/shared/artifact_manifest.mjs';
import {
  assertBuildSourceMetadataStable,
  collectBuildSourceMetadata,
} from './collect_build_source_metadata.mjs';
import { buildWebArtifact } from './build_web_artifact.mjs';
import { buildDaemonArtifact } from './build_daemon_artifact.mjs';
import { buildServerArtifact } from './build_server_artifact.mjs';
import {
  composeRuntimePublicationResult,
  publishRuntimeSnapshot,
  selectRuntimeSnapshot,
} from './activate_runtime_snapshot.mjs';
import { parseBuildSelection } from './build_targets.mjs';
import { pruneComponentArtifacts, resolveRuntimeRetentionPolicy } from './runtime_retention.mjs';
import { ensureStackRuntimeModePrefer } from '../runtime/shared/ensureStackRuntimeModePrefer.mjs';
import { createRuntimeSnapshotId } from '../runtime/shared/runtime_snapshot_identity.mjs';
import { resolveRuntimeBuildAuthority } from '../runtime/shared/runtime_build_authority.mjs';
import { getStacksStorageRoot } from '../utils/paths/paths.mjs';
import { pathExists } from '../utils/fs/fs.mjs';
import { resolveLatestComponentArtifact } from './resolve_latest_component_artifact.mjs';
import { runCapture } from '../utils/proc/proc.mjs';

function assertNamedStack(env) {
  const stackName = String(env.HAPPIER_STACK_STACK ?? '').trim() || 'main';
  if (stackName === 'main') {
    throw new Error('[build] runtime artifact builds are supported for named consumer stacks only.');
  }
  return stackName;
}

export function assertSelectedBuildPrerequisites({
  selection,
  commandProbe = commandExists,
  env = process.env,
}) {
  const needsServerBinary = Boolean(selection?.components?.server);
  const needsDaemonBinary = Boolean(selection?.components?.daemon);
  if (needsServerBinary || needsDaemonBinary) {
    if (!resolveBunCommand({ commandProbe, processEnv: env })) {
      const targetLabel = needsServerBinary && needsDaemonBinary
        ? 'server and daemon'
        : needsServerBinary
          ? 'server'
          : 'daemon';
      throw new Error(`[build] bun is required before starting ${targetLabel} binary artifact builds.`);
    }
  }
  if (needsDaemonBinary) {
    resolveYarnCommand({ commandProbe });
  }
}

export async function collectRuntimeBuildToolchainInputs({
  selection,
  env = process.env,
  commandProbe = commandExists,
  resolveBunCommandImpl = resolveBunCommand,
  resolveYarnCommandImpl = resolveYarnCommand,
  runCaptureImpl = runCapture,
  nodeVersion = process.version,
}) {
  const nodeInput = `node=${String(nodeVersion ?? '').trim()}`;
  let bunInput = null;
  let yarnInput = null;
  if (selection?.components?.server || selection?.components?.daemon) {
    const bunCommand = resolveBunCommandImpl({ commandProbe, processEnv: env });
    if (!bunCommand) {
      throw new Error('[build] bun is required before collecting runtime build toolchain identity.');
    }
    const bunVersion = String(await runCaptureImpl(bunCommand, ['--version'], {
      env,
      timeoutMs: 10_000,
    })).trim();
    if (!bunVersion) throw new Error('[build] bun returned an empty version while collecting runtime build identity.');
    bunInput = `bun=${bunVersion}`;
  }
  if (selection?.components?.daemon) {
    const yarn = resolveYarnCommandImpl({ commandProbe });
    const yarnVersion = String(await runCaptureImpl(yarn.cmd, [...yarn.args, '--version'], {
      env,
      timeoutMs: 10_000,
    })).trim();
    if (!yarnVersion) throw new Error('[build] Yarn returned an empty version while collecting runtime build identity.');
    yarnInput = `yarn=${yarnVersion}`;
  }
  return {
    web: selection?.components?.web || selection?.components?.server ? [nodeInput] : [],
    server: selection?.components?.server ? [nodeInput, bunInput] : [],
    daemon: selection?.components?.daemon ? [nodeInput, bunInput, yarnInput] : [],
  };
}

export async function ensureArtifactSourceInputsReady({
  selection,
  repoDir,
  env = process.env,
  ensureCliBuiltImpl = ensureCliBuilt,
}) {
  if (!selection?.components?.daemon) {
    return;
  }

  await ensureCliBuiltImpl(join(repoDir, 'apps', 'cli'), {
    buildCli: true,
    quiet: true,
    env,
  });
}

export async function buildSelectedStackArtifacts({
  selection,
  stackBaseDir,
  buildComponent,
  resolveLatestComponentArtifactImpl = resolveLatestComponentArtifact,
}) {
  const artifacts = {};
  if (selection.components.web) {
    artifacts.web = await buildComponent('web', buildWebArtifact);
  }

  if (selection.components.server) {
    const webArtifact = artifacts.web
      ?? await resolveLatestComponentArtifactImpl({
        stackBaseDir,
        component: 'web',
      })
      ?? await buildComponent('web', buildWebArtifact);

    artifacts.web = webArtifact;
    artifacts.server = await buildComponent('server', buildServerArtifact, {
      uiWebDistPath: artifactPayloadDir(webArtifact.artifactDir),
      webArtifactFingerprint: webArtifact.manifest.artifactFingerprint,
    });
  }

  if (selection.components.daemon) {
    artifacts.daemon = await buildComponent('daemon', buildDaemonArtifact);
  }
  return artifacts;
}

export async function buildStackArtifacts({ rootDir, argv = [], env = process.env, authority = null }) {
  const { flags } = parseArgs(argv);
  const selection = parseBuildSelection({ argv });
  const stackName = assertNamedStack(env);
  if (flags.has('--tauri')) {
    throw new Error('[build] tauri artifact builds are not supported in named-stack runtime snapshots.');
  }
  assertSelectedBuildPrerequisites({ selection, env });

  const resolvedAuthority = authority ?? resolveRuntimeBuildAuthority({
    rootDir,
    consumerStackName: stackName,
    env,
  });
  const stackBaseDir = resolvedAuthority.producerStackBaseDir;
  const retentionPolicy = resolveRuntimeRetentionPolicy({ env });
  const toolchainInputsByComponent = await collectRuntimeBuildToolchainInputs({ selection, env });
  const initialSourceMetadata = await collectBuildSourceMetadata({ rootDir, env });
  await ensureArtifactSourceInputsReady({
    selection,
    repoDir: initialSourceMetadata.repoDir,
    env,
  });
  const sourceMetadata = await collectBuildSourceMetadata({ rootDir, env });
  const newlyPublishedArtifactDirs = [];
  const buildComponent = async (component, builder, builderOptions = {}) => {
    const buildInputs = [...(toolchainInputsByComponent[component] ?? [])];
    if (component === 'server') {
      const defaultServerExternals = SERVER_BINARY_DEFAULT_EXTERNALS.join(',');
      buildInputs.push(
        `bunExternals=${String(env.HAPPIER_SERVER_BUN_EXTERNALS ?? defaultServerExternals).trim() || defaultServerExternals}`,
      );
      buildInputs.push(`platform=${process.platform}`);
      buildInputs.push(`arch=${process.arch}`);
      buildInputs.push(`webArtifact=${String(builderOptions.webArtifactFingerprint ?? '').trim()}`);
    }
    if (component === 'daemon') {
      buildInputs.push(`bunExternals=${String(env.HAPPIER_CLI_BUN_EXTERNALS ?? '').trim()}`);
      buildInputs.push(`platform=${process.platform}`);
      buildInputs.push(`arch=${process.arch}`);
    }
    const artifactFingerprint = createRuntimeFingerprint({
      repoDir: sourceMetadata.repoDir,
      commitSha: sourceMetadata.commitSha,
      dirtyHash: sourceMetadata.dirtyHash,
      serverComponent: sourceMetadata.serverComponent,
      dbProvider: sourceMetadata.dbProvider,
      components: [component],
      buildInputs,
    });
    const artifactDir = resolveStackComponentArtifactDir({ stackBaseDir, component, fingerprint: artifactFingerprint });
    const existedBefore = await pathExists(join(artifactDir, 'manifest.json'));
    const artifact = await builder({
      rootDir,
      artifactDir,
      artifactFingerprint,
      sourceMetadata,
      forceRebuild: selection.forceRebuild,
      env,
      ...builderOptions,
    });
    if (!existedBefore) newlyPublishedArtifactDirs.push(artifactDir);
    await pruneComponentArtifacts({
      stackBaseDir,
      component,
      keepCount: retentionPolicy.artifactKeepCount,
    });
    return artifact;
  };

  const artifacts = await buildSelectedStackArtifacts({
    selection,
    stackBaseDir,
    buildComponent,
  });

  const publicationSourceMetadata = await collectBuildSourceMetadata({ rootDir, env });
  try {
    assertBuildSourceMetadataStable({ before: sourceMetadata, after: publicationSourceMetadata });
  } catch (error) {
    await Promise.all(
      newlyPublishedArtifactDirs.map((artifactDir) => rm(artifactDir, { recursive: true, force: true })),
    );
    throw error;
  }

  let runtime = null;
  if (selection.activateRuntime) {
    const componentFingerprints = Object.fromEntries(
      Object.entries(artifacts).map(([component, artifact]) => [
        component,
        artifact?.manifest?.artifactFingerprint ?? '',
      ]),
    );
    const snapshotId = createRuntimeSnapshotId({ sourceMetadata, componentFingerprints });
    const published = await publishRuntimeSnapshot({
      producerStackBaseDir: stackBaseDir,
      snapshotId,
      sourceMetadata,
      artifacts,
      runtimeSnapshotKeepCount: retentionPolicy.runtimeSnapshotKeepCount,
      externalReferenceStorageRoot: getStacksStorageRoot(env),
    });
    await selectRuntimeSnapshot({
      consumerStackBaseDir: stackBaseDir,
      producerStackBaseDir: stackBaseDir,
      producerStackName: resolvedAuthority.producerStackName,
      snapshotId: published.snapshotId,
    });
    const selectedRuntime = await selectRuntimeSnapshot({
      consumerStackBaseDir: resolvedAuthority.consumerStackBaseDir,
      producerStackBaseDir: stackBaseDir,
      producerStackName: resolvedAuthority.producerStackName,
      snapshotId: published.snapshotId,
    });
    runtime = composeRuntimePublicationResult({
      consumerStackName: resolvedAuthority.consumerStackName,
      producerStackName: resolvedAuthority.producerStackName,
      published,
      selectedRuntime,
    });

    const { envPath } = resolveStackEnvPath(stackName, env);
    await ensureStackRuntimeModePrefer({ envPath });
  }

  return {
    ok: true,
    stackName,
    consumerStackName: resolvedAuthority.consumerStackName,
    consumerStackBaseDir: resolvedAuthority.consumerStackBaseDir,
    producerStackName: resolvedAuthority.producerStackName,
    producerStackBaseDir: resolvedAuthority.producerStackBaseDir,
    stackBaseDir,
    snapshotId: runtime?.snapshotId ?? null,
    snapshotPath: runtime?.snapshotPath ?? null,
    reused: runtime?.reused ?? null,
    selected: runtime?.selected ?? false,
    source: sourceMetadata,
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([component, value]) => [
        component,
        {
          artifactDir: value.artifactDir,
          manifest: value.manifest,
        },
      ]),
    ),
    runtime,
  };
}
