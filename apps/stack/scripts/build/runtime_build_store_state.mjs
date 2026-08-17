import { readReusableArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';
import { inspectActiveRuntimeSnapshot } from '../runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { resolveStackComponentArtifactDir } from '../runtime/shared/runtime_paths.mjs';
import { resolveLatestComponentArtifact } from './resolve_latest_component_artifact.mjs';

function selectedArtifactComponents(selection) {
  return ['web', 'server', 'daemon'].filter((component) => selection?.components?.[component]);
}

async function resolveArtifactByFingerprint({ stackBaseDir, component, artifactFingerprint }) {
  const fingerprint = String(artifactFingerprint ?? '').trim();
  if (!fingerprint) return null;
  const artifactDir = resolveStackComponentArtifactDir({
    stackBaseDir,
    component,
    fingerprint,
  });
  const manifest = await readReusableArtifactManifest({ artifactDir, artifactFingerprint: fingerprint });
  return manifest ? { artifactDir, manifest } : null;
}

async function resolveResultArtifacts({
  producerStackBaseDir,
  selection,
  manifest = null,
}) {
  const artifacts = {};
  for (const component of selectedArtifactComponents(selection)) {
    const artifactFingerprint = manifest?.components?.[component]?.artifactFingerprint;
    const artifact = await resolveArtifactByFingerprint({
      stackBaseDir: producerStackBaseDir,
      component,
      artifactFingerprint,
    });
    if (!artifact) return null;
    artifacts[component] = artifact;
  }

  return artifacts;
}

async function resolveLatestResultArtifacts({ producerStackBaseDir, selection }) {
  const artifacts = {};
  for (const component of selectedArtifactComponents(selection)) {
    const artifact = await resolveLatestComponentArtifact({
      stackBaseDir: producerStackBaseDir,
      component,
    });
    if (!artifact) return null;
    artifacts[component] = artifact;
  }
  return artifacts;
}

function collectArtifactFingerprints(artifacts) {
  return Object.fromEntries(Object.entries(artifacts ?? {}).map(([component, artifact]) => [
    component,
    artifact?.manifest?.artifactFingerprint ?? null,
  ]));
}

function collectSnapshotArtifactFingerprints(manifest) {
  return Object.fromEntries(['web', 'server', 'daemon'].map((component) => [
    component,
    manifest?.components?.[component]?.artifactFingerprint ?? null,
  ]));
}

function requestedComponentsAreCompatible({
  selection,
  baselineStoreState,
  artifactFingerprints,
  expectedArtifactFingerprints,
}) {
  if (!baselineStoreState || typeof baselineStoreState !== 'object') return false;
  const requestedComponents = selectedArtifactComponents(selection);
  if (requestedComponents.length === 0) return false;
  return requestedComponents.every((component) => {
    const currentFingerprint = String(artifactFingerprints?.[component] ?? '').trim();
    if (!currentFingerprint) return false;
    const baselineFingerprint = String(
      baselineStoreState?.artifactFingerprints?.[component] ?? '',
    ).trim();
    const expectedFingerprint = String(expectedArtifactFingerprints?.[component] ?? '').trim();
    return currentFingerprint !== baselineFingerprint
      || (expectedFingerprint && currentFingerprint === expectedFingerprint);
  });
}

export async function captureRuntimeBuildStoreState({ authority, selection }) {
  if (selection.activateRuntime) {
    const inspection = await inspectActiveRuntimeSnapshot({
      stackBaseDir: authority.producerStackBaseDir,
    });
    return {
      snapshotId: inspection.valid ? inspection.snapshot?.snapshotId ?? null : null,
      artifactFingerprints: inspection.valid
        ? collectSnapshotArtifactFingerprints(inspection.manifest)
        : {},
    };
  }

  const artifacts = await resolveLatestResultArtifacts({
    producerStackBaseDir: authority.producerStackBaseDir,
    selection,
  });
  return {
    snapshotId: null,
    artifactFingerprints: collectArtifactFingerprints(artifacts),
  };
}

export async function resolveCompletedRuntimeBuildAfterWait({
  authority,
  selection,
  baselineStoreState = null,
  expectedArtifactFingerprints = {},
  selectRuntimeSnapshotImpl,
  selectConsumer = true,
}) {
  if (selection.activateRuntime) {
    const inspection = await inspectActiveRuntimeSnapshot({
      stackBaseDir: authority.producerStackBaseDir,
    });
    if (!inspection.valid || !inspection.snapshot || !inspection.manifest) return null;
    const artifactFingerprints = collectSnapshotArtifactFingerprints(inspection.manifest);
    if (!requestedComponentsAreCompatible({
      selection,
      baselineStoreState,
      artifactFingerprints,
      expectedArtifactFingerprints,
    })) return null;
    const artifacts = await resolveResultArtifacts({
      producerStackBaseDir: authority.producerStackBaseDir,
      selection,
      manifest: inspection.manifest,
    });
    if (!artifacts) return null;

    const runtime = selectConsumer
      ? await (async () => {
          const selectRuntime = selectRuntimeSnapshotImpl
            ?? (await import('./activate_runtime_snapshot.mjs')).selectRuntimeSnapshot;
          const selectedRuntime = await selectRuntime({
            consumerStackBaseDir: authority.consumerStackBaseDir,
            producerStackBaseDir: authority.producerStackBaseDir,
            producerStackName: authority.producerStackName,
            snapshotId: inspection.snapshot.snapshotId,
          });
          return {
            consumerStackName: authority.consumerStackName,
            producerStackName: authority.producerStackName,
            snapshotId: selectedRuntime.snapshotId,
            snapshotPath: selectedRuntime.snapshotPath,
            currentPath: selectedRuntime.currentPath,
            reused: true,
            selected: true,
          };
        })()
      : {
          consumerStackName: authority.consumerStackName,
          producerStackName: authority.producerStackName,
          snapshotId: inspection.snapshot.snapshotId,
          snapshotPath: inspection.snapshot.snapshotPath,
          currentPath: null,
          reused: true,
          selected: false,
        };
    return {
      ok: true,
      stackName: authority.consumerStackName,
      consumerStackName: authority.consumerStackName,
      consumerStackBaseDir: authority.consumerStackBaseDir,
      producerStackName: authority.producerStackName,
      producerStackBaseDir: authority.producerStackBaseDir,
      stackBaseDir: authority.producerStackBaseDir,
      snapshotId: runtime.snapshotId,
      snapshotPath: runtime.snapshotPath,
      reused: true,
      selected: selectConsumer,
      source: inspection.manifest.source ?? {},
      artifacts,
      runtime,
    };
  }

  const artifacts = await resolveLatestResultArtifacts({
    producerStackBaseDir: authority.producerStackBaseDir,
    selection,
  });
  if (!artifacts) return null;
  if (!requestedComponentsAreCompatible({
    selection,
    baselineStoreState,
    artifactFingerprints: collectArtifactFingerprints(artifacts),
    expectedArtifactFingerprints,
  })) return null;
  const source = Object.values(artifacts).find(Boolean)?.manifest?.source ?? {};
  return {
    ok: true,
    stackName: authority.consumerStackName,
    consumerStackName: authority.consumerStackName,
    consumerStackBaseDir: authority.consumerStackBaseDir,
    producerStackName: authority.producerStackName,
    producerStackBaseDir: authority.producerStackBaseDir,
    stackBaseDir: authority.producerStackBaseDir,
    snapshotId: null,
    snapshotPath: null,
    reused: true,
    selected: false,
    source,
    artifacts,
    runtime: null,
  };
}
