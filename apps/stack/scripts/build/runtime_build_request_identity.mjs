import { collectBuildSourceMetadata } from './collect_build_source_metadata.mjs';
import {
  assertSelectedBuildPrerequisites,
  collectRuntimeComponentSourceFingerprints,
  collectRuntimeBuildToolchainInputs,
  createRuntimeArtifactFingerprint,
} from './runtime_artifact_identity.mjs';
import { createRuntimeSnapshotId } from '../runtime/shared/runtime_snapshot_identity.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectWorkspaceQaStalePackages, resolveWorkspaceBuildMode } from '../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

async function resolveDefaultServerSupportArtifactFingerprint(options) {
  const { resolveServerSupportArtifactFingerprint } = await import('./build_server_artifact.mjs');
  return await resolveServerSupportArtifactFingerprint(options);
}

async function resolveDefaultDaemonSupportArtifactFingerprint(options) {
  const { resolveDaemonSupportArtifactFingerprint } = await import('./build_daemon_artifact.mjs');
  return await resolveDaemonSupportArtifactFingerprint(options);
}

async function resolveDefaultDaemonWorkspaceSourceFingerprint({ repoDir, stalePackages }) {
  const { readDaemonWorkspaceSourceFingerprint } = await import('./build_daemon_artifact.mjs');
  return readDaemonWorkspaceSourceFingerprint({ repoDir, stalePackages });
}

export async function resolveRuntimeBuildRequestIdentity({
  rootDir,
  producerStackBaseDir,
  selection,
  target = { platform: process.platform, arch: process.arch },
  env = process.env,
  sourceMetadata: providedSourceMetadata = null,
  collectBuildSourceMetadataImpl = collectBuildSourceMetadata,
  collectRuntimeComponentSourceFingerprintsImpl = collectRuntimeComponentSourceFingerprints,
  collectRuntimeBuildToolchainInputsImpl = collectRuntimeBuildToolchainInputs,
  resolveServerSupportArtifactFingerprintImpl = resolveDefaultServerSupportArtifactFingerprint,
  resolveDaemonSupportArtifactFingerprintImpl = resolveDefaultDaemonSupportArtifactFingerprint,
  resolveDaemonWorkspaceSourceFingerprintImpl = resolveDefaultDaemonWorkspaceSourceFingerprint,
  assertSelectedBuildPrerequisitesImpl = assertSelectedBuildPrerequisites,
}) {
  assertSelectedBuildPrerequisitesImpl({ selection, env });
  const [sourceMetadata, toolchainInputsByComponent] = await Promise.all([
    providedSourceMetadata ?? collectBuildSourceMetadataImpl({ rootDir, env }),
    collectRuntimeBuildToolchainInputsImpl({ selection, env }),
  ]);
  // Server support admission can build cold workspace outputs or record QA
  // fallback. Read staleness and the remaining identities after that admission.
  const serverSupportArtifactFingerprint = selection.components.server
    ? await resolveServerSupportArtifactFingerprintImpl({ rootDir, sourceMetadata, env, target })
    : null;
  const stalePackagesByComponent = {};
  if (resolveWorkspaceBuildMode({ env }) === 'qa-runtime') {
    for (const component of ['web', 'server', 'daemon']) {
      if (!selection.components[component]) continue;
      const packagePath = join(sourceMetadata.repoDir, 'apps', component === 'web' ? 'ui' : component === 'daemon' ? 'cli' : 'server', 'package.json');
      if (!existsSync(packagePath)) continue;
      const host = JSON.parse(readFileSync(packagePath, 'utf8'));
      stalePackagesByComponent[component] = await inspectWorkspaceQaStalePackages(sourceMetadata.repoDir, [host.name]);
    }
  }
  const daemonWorkspaceSourceFingerprint = selection.components.daemon
    ? await resolveDaemonWorkspaceSourceFingerprintImpl({ repoDir: sourceMetadata.repoDir, stalePackages: stalePackagesByComponent.daemon })
    : null;
  const [componentSourceFingerprints, daemonSupportArtifactFingerprint] = await Promise.all([
    collectRuntimeComponentSourceFingerprintsImpl({ selection, sourceMetadata }),
    selection.components.daemon
      ? resolveDaemonSupportArtifactFingerprintImpl({
          rootDir, sourceMetadata, env, target, workspaceSourceFingerprint: daemonWorkspaceSourceFingerprint,
        })
      : null,
  ]);
  const artifactFingerprints = {};

  if (selection.components.web) {
    artifactFingerprints.web = createRuntimeArtifactFingerprint({
      component: 'web',
      platform: target.platform,
      arch: target.arch,
      sourceMetadata,
      componentSourceFingerprint: componentSourceFingerprints.web,
      toolchainInputs: toolchainInputsByComponent.web,
      env,
      stalePackages: stalePackagesByComponent.web,
    });
  }

  if (selection.components.server) {
    artifactFingerprints.server = createRuntimeArtifactFingerprint({
      component: 'server',
      platform: target.platform,
      arch: target.arch,
      sourceMetadata,
      componentSourceFingerprint: componentSourceFingerprints.server,
      supportArtifactFingerprint: serverSupportArtifactFingerprint,
      toolchainInputs: toolchainInputsByComponent.server,
      env,
      stalePackages: stalePackagesByComponent.server,
    });
  }

  if (selection.components.daemon) {
    artifactFingerprints.daemon = createRuntimeArtifactFingerprint({
      component: 'daemon',
      platform: target.platform,
      arch: target.arch,
      sourceMetadata,
      componentSourceFingerprint: componentSourceFingerprints.daemon,
      supportArtifactFingerprint: daemonSupportArtifactFingerprint,
      toolchainInputs: toolchainInputsByComponent.daemon,
      env,
      stalePackages: stalePackagesByComponent.daemon,
    });
  }

  return {
    sourceMetadata,
    stalePackagesByComponent,
    componentSourceFingerprints,
    daemonWorkspaceSourceFingerprint,
    supportArtifactFingerprints: {
      ...(serverSupportArtifactFingerprint ? { server: serverSupportArtifactFingerprint } : {}),
      ...(daemonSupportArtifactFingerprint ? { daemon: daemonSupportArtifactFingerprint } : {}),
    },
    artifactFingerprints,
    snapshotId: selection.activateRuntime
      ? createRuntimeSnapshotId({ sourceMetadata, componentFingerprints: artifactFingerprints, ...target })
      : null,
  };
}
