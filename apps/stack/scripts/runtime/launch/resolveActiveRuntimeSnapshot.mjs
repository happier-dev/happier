import { inspectActiveRuntimeSnapshot } from './inspectActiveRuntimeSnapshot.mjs';

export async function resolveActiveRuntimeSnapshot({ mode = 'source', stackBaseDir }) {
  if (mode === 'source') {
    return null;
  }

  const inspection = await inspectActiveRuntimeSnapshot({ stackBaseDir });
  if (inspection.snapshot) {
    return inspection.snapshot;
  }
  if (mode === 'prefer') {
    return null;
  }
  if (inspection.missing) {
    throw new Error('[runtime] missing active runtime snapshot for this stack.');
  }
  throw new Error(inspection.errors[0] ?? '[runtime] invalid active runtime snapshot.');
}
