import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

// A database container belongs to the harness process that started it. `docker run --rm`
// plus the harness's own signal cleanup cannot remove it when that process is killed
// outright (2026-11-18: 23 `happier-test-postgres-*` containers on nl3, up to 36 h old).
// Each container carries its owner's identity; the next harness start removes the
// containers whose owner is gone.
export const EXTENDED_DB_OWNER_LABEL = 'happier.extended-db.owner';

function processStartTicks(pid) {
  if (process.platform !== 'linux') return '';
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
  } catch {
    return null;
  }
}

/** host:pid:start-ticks (start ticks only where the OS exposes them). */
export function extendedDbOwnerToken(pid = process.pid) {
  return `${hostname()}:${pid}:${processStartTicks(pid) ?? ''}`;
}

/** Whether the process a token names is still the same running process on this host.
 * Another host's token is never judged here. */
export function isExtendedDbOwnerAlive(token) {
  const match = /^(.*):(\d+):(\d*)$/u.exec(String(token ?? ''));
  if (!match) return true;
  const [, host, pidText, start] = match;
  if (host !== hostname()) return true;
  const pid = Number(pidText);
  try { process.kill(pid, 0); }
  catch (error) { if (error?.code !== 'EPERM') return false; }
  if (!start) return true;
  return processStartTicks(pid) === start;
}

/** Container ids from `docker ps -a --format '{{.ID}} {{.Label "<label>"}}'` rows whose owner is gone. */
export function selectOrphanedExtendedDbContainers(rows, isOwnerAlive = isExtendedDbOwnerAlive) {
  return String(rows ?? '').split('\n').map(line => line.trim()).filter(Boolean)
    .map(line => { const space = line.indexOf(' '); return space < 0 ? [line, ''] : [line.slice(0, space), line.slice(space + 1).trim()]; })
    .filter(([id, owner]) => /^[a-f0-9]{12,64}$/u.test(id) && owner && !isOwnerAlive(owner))
    .map(([id]) => id);
}
