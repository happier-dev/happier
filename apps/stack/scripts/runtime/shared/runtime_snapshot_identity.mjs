import { createRuntimeFingerprint } from './runtime_fingerprint.mjs';

export function createRuntimeSnapshotId({
  sourceMetadata,
  componentFingerprints,
  platform = process.platform,
  arch = process.arch,
  buildInputs = [],
} = {}) {
  const components = Object.entries(componentFingerprints ?? {})
    .map(([component, artifactFingerprint]) => [
      String(component ?? '').trim(),
      String(artifactFingerprint ?? '').trim(),
    ])
    .filter(([component, artifactFingerprint]) => component && artifactFingerprint)
    .sort(([left], [right]) => left.localeCompare(right));

  return createRuntimeFingerprint({
    serverComponent: sourceMetadata?.serverComponent,
    dbProvider: sourceMetadata?.dbProvider,
    components: ['runtime-snapshot'],
    buildInputs: [
      `platform=${String(platform ?? '').trim()}`,
      `arch=${String(arch ?? '').trim()}`,
      ...components.map(([component, artifactFingerprint]) => `${component}=${artifactFingerprint}`),
      ...(Array.isArray(buildInputs) ? buildInputs : []),
    ],
  });
}

export function createRuntimeSnapshotSourceMetadata({ sourceMetadata, snapshotId } = {}) {
  const sourceFingerprint = String(sourceMetadata?.sourceFingerprint ?? '').trim();
  const normalizedSnapshotId = String(snapshotId ?? '').trim();
  if (!normalizedSnapshotId) {
    throw new Error('[runtime] snapshot source metadata requires a snapshot identity.');
  }
  return {
    ...(sourceMetadata && typeof sourceMetadata === 'object' ? sourceMetadata : {}),
    ...(sourceFingerprint ? { buildSourceFingerprint: sourceFingerprint } : {}),
    sourceFingerprint: normalizedSnapshotId,
  };
}
