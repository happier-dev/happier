import { existsSync } from 'node:fs';

export function readCliDistIntegrity(distEntrypoint) {
  const entry = String(distEntrypoint ?? '').trim();
  if (!entry) {
    return { ok: false, reason: 'missing_dist_entrypoint' };
  }
  if (!existsSync(entry)) {
    return { ok: false, reason: `missing:${entry}` };
  }
  return { ok: true, reason: 'exists' };
}
