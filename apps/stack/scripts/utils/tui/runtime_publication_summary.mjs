function normalizePhase(value) {
  const phase = String(value ?? '').trim();
  return ['current', 'stale', 'publishing', 'failed'].includes(phase) ? phase : '';
}

function formatError(value) {
  const error = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return error ? ` (${error.slice(0, 240)})` : '';
}

export function formatTuiRuntimePublicationSummaryLines(runtimeState) {
  const publication = runtimeState?.runtimePublication;
  const phase = normalizePhase(publication?.phase);
  if (!phase) return [];

  const lines = ['runtime publication:', `  phase: ${phase}`];
  const snapshotId = String(publication?.currentSnapshotId ?? '').trim();
  if (snapshotId) lines.push(`  currentSnapshot: ${snapshotId}`);
  const components = publication?.components && typeof publication.components === 'object'
    ? publication.components
    : {};
  for (const name of ['server', 'daemon', 'web']) {
    const component = components[name];
    const componentPhase = normalizePhase(component?.phase);
    if (!componentPhase) continue;
    lines.push(`  ${name}: ${componentPhase}${formatError(component?.error)}`);
  }
  return lines;
}
