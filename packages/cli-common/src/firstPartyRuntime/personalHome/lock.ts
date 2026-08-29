import { hostname } from 'node:os';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type PersonalHomeOperationKind = 'backup'|'restore'|'erase'|'relocate'|'uninstall'|'upgrade';
export class PersonalHomeOperationError extends Error { constructor(public readonly code: 'operation_in_progress'|'ambiguous_stale_lock', message: string) { super(message); this.name = 'PersonalHomeOperationError'; } }
type LockRecord = { pid:number; host:string; startedAt:string; operation:PersonalHomeOperationKind };
const lockPath = (dataDir:string) => resolve(dataDir, '.operations', 'lock');
async function ownerAlive(r: LockRecord): Promise<boolean|null> {
  if (r.host !== hostname()) return null;
  try { process.kill(r.pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
}
export async function acquirePersonalHomeOperationLock(dataDir:string, operation:PersonalHomeOperationKind): Promise<()=>Promise<void>> {
  const path = lockPath(dataDir); await mkdir(dirname(path), {recursive:true});
  const record: LockRecord = {pid:process.pid, host:hostname(), startedAt:new Date().toISOString(), operation};
  try { const h = await open(path, 'wx', 0o600); await h.writeFile(JSON.stringify(record)); await h.close(); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    let existing: LockRecord; try { existing = JSON.parse(await readFile(path, 'utf8')) as LockRecord; } catch { throw new PersonalHomeOperationError('ambiguous_stale_lock', 'Unable to inspect operation lock'); }
    const alive = await ownerAlive(existing); if (alive !== false) throw new PersonalHomeOperationError(alive === null ? 'ambiguous_stale_lock' : 'operation_in_progress', 'Personal Home operation is already in progress');
    await unlink(path); return acquirePersonalHomeOperationLock(dataDir, operation);
  }
  return async () => { try { const current = JSON.parse(await readFile(path, 'utf8')) as LockRecord; if (current.pid === process.pid && current.host === hostname()) await unlink(path); } catch { /* lock already gone */ } };
}
export async function withPersonalHomeOperationLock<T>(dataDir:string, operation:PersonalHomeOperationKind, fn:()=>Promise<T>):Promise<T> { const release = await acquirePersonalHomeOperationLock(dataDir, operation); try { return await fn(); } finally { await release(); } }
export function normalizePersonalHomeLockOrder(dataDirs:string[]): string[] { return [...dataDirs].map((path: string): string => resolve(path)).sort((a,b)=>a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase())); }
