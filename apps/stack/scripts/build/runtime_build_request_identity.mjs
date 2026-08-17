import { collectBuildSourceMetadata } from './collect_build_source_metadata.mjs';
import {
  assertSelectedBuildPrerequisites,
  collectRuntimeComponentSourceFingerprints,
  collectRuntimeBuildToolchainInputs,
  createRuntimeArtifactFingerprint,
} from './runtime_artifact_identity.mjs';
import { createRuntimeSnapshotId } from '../runtime/shared/runtime_snapshot_identity.mjs';

async function resolveDefaultServerSupportArtifactFingerprint(options) {
  const { resolveServerSupportArtifactFingerprint } = await import('./build_server_artifact.mjs');
  return await resolveServerSupportArtifactFingerprint(options);
}

async function resolveDefaultDaemonSupportArtifactFingerprint(options) {
  const { resolveDaemonSupportArtifactFingerprint } = await import('./build_daemon_artifact.mjs');
  return await resolveDaemonSupportArtifactFingerprint(options);
}

export async function resolveRuntimeBuildRequestIdentity({
  rootDir,
  producerStackBaseDir,
  selection,
  env = process.env,
  sourceMetadata: providedSourceMetadata = null,
  collectBuildSourceMetadataImpl = collectBuildSourceMetadata,
  collectRuntimeComponentSourceFingerprintsImpl = collectRuntimeComponentSourceFingerprints,
  collectRuntimeBuildToolchainInputsImpl = collectRuntimeBuildToolchainInputs,
  resolveServerSupportArtifactFingerprintImpl = resolveDefaultServerSupportArtifactFingerprint,
  resolveDaemonSupportArtifactFingerprintImpl = resolveDefaultDaemonSupportArtifactFingerprint,
  assertSelectedBuildPrerequisitesImpl = assertSelectedBuildPrerequisites,
}) {
  assertSelectedBuildPrerequisitesImpl({ selection, env });
  const [sourceMetadata, toolchainInputsByComponent] = await Promise.all([
    providedSourceMetadata ?? collectBuildSourceMetadataImpl({ rootDir, env }),
    collectRuntimeBuildToolchainInputsImpl({ selection, env }),
  ]);
  const [componentSourceFingerprints, serverSupportArtifactFingerprint, daemonSupportArtifactFingerprint] = await Promise.all([
    collectRuntimeComponentSourceFingerprintsImpl({ selection, sourceMetadata }),
    selection.components.server
      ? resolveServerSupportArtifactFingerprintImpl({ rootDir, sourceMetadata, env })
      : null,
    selection.components.daemon
      ? resolveDaemonSupportArtifactFingerprintImpl({ rootDir, sourceMetadata, env })
      : null,
  ]);
  const artifactFingerprints = {};

  if (selection.components.web) {
    artifactFingerprints.web = createRuntimeArtifactFingerprint({
      component: 'web',
      sourceMetadata,
      componentSourceFingerprint: componentSourceFingerprints.web,
      toolchainInputs: toolchainInputsByComponent.web,
      env,
    });
  }

  if (selection.components.server) {
    artifactFingerprints.server = createRuntimeArtifactFingerprint({
      component: 'server',
      sourceMetadata,
      componentSourceFingerprint: componentSourceFingerprints.server,
      supportArtifactFingerprint: serverSupportArtifactFingerprint,
      toolchainInputs: toolchainInputsByComponent.server,
      env,
    });
  }

  if (selection.components.daemon) {
    artifactFingerprints.daemon = createRuntimeArtifactFingerprint({
      component: 'daemon',
      sourceMetadata,
      componentSourceFingerprint: componentSourceFingerprints.daemon,
      supportArtifactFingerprint: daemonSupportArtifactFingerprint,
      toolchainInputs: toolchainInputsByComponent.daemon,
      env,
    });
  }

  return {
    sourceMetadata,
    componentSourceFingerprints,
    supportArtifactFingerprints: {
      ...(serverSupportArtifactFingerprint ? { server: serverSupportArtifactFingerprint } : {}),
      ...(daemonSupportArtifactFingerprint ? { daemon: daemonSupportArtifactFingerprint } : {}),
    },
    artifactFingerprints,
    snapshotId: selection.activateRuntime
      ? createRuntimeSnapshotId({ sourceMetadata, componentFingerprints: artifactFingerprints })
      : null,
  };
}
