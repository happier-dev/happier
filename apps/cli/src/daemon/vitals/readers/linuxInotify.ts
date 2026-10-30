import { readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

const errorCode = (error: unknown) => error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
const permissionDenied = (code: unknown) => code === 'EACCES' || code === 'EPERM';

/** A demand-only, best-effort walk: churn is normal; a known permission gap is not a complete count. */
export async function readLinuxInotifyWatches(root: string | undefined, max: number): Promise<NonNullable<MachineVitalsSampleV1['limits']>['inotify']> {
    const uid = process.getuid?.();
    if (uid === undefined) return undefined;
    const at = (path: string) => root ? join(root, path) : path;
    let processes: string[];
    try { processes = await readdir(at('/proc')); }
    catch (error) { if (permissionDenied(errorCode(error))) return undefined; throw error; }
    let used = 0;
    for (const pid of processes.filter(name => /^\d+$/u.test(name))) {
        let status: string;
        try { status = await readFile(at(`/proc/${pid}/status`), 'utf8'); }
        catch (error) {
            if (errorCode(error) === 'ENOENT') continue;
            if (permissionDenied(errorCode(error))) return undefined;
            throw error;
        }
        const owner = /^Uid:\s+(\d+)/mu.exec(status);
        if (!owner) return undefined;
        if (Number(owner[1]) !== uid) continue;
        let descriptors: string[];
        try { descriptors = await readdir(at(`/proc/${pid}/fd`)); }
        catch (error) {
            if (errorCode(error) === 'ENOENT') continue;
            if (permissionDenied(errorCode(error))) return undefined;
            throw error;
        }
        for (const fd of descriptors) {
            let target: string;
            try { target = await readlink(at(`/proc/${pid}/fd/${fd}`)); }
            catch (error) {
                if (errorCode(error) === 'ENOENT') continue;
                if (permissionDenied(errorCode(error))) return undefined;
                throw error;
            }
            if (target !== 'anon_inode:inotify') continue;
            let info: string;
            try { info = await readFile(at(`/proc/${pid}/fdinfo/${fd}`), 'utf8'); }
            catch (error) {
                if (errorCode(error) === 'ENOENT') continue;
                if (permissionDenied(errorCode(error))) return undefined;
                throw error;
            }
            for (const _watch of info.matchAll(/^inotify wd:/gmu)) used++;
        }
    }
    return { used, max };
}
