import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MachineSetupStepObservationV1 } from './index.js';
import { readLocalAccount, type NativeRun } from './nativeSystemBackend.js';
import { parsePosixAcl, posixAclEntryAllows } from './posixAcl.js';

function missing(error: unknown): boolean {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

/** A finite prerequisite for the reviewed group step; it never reads log messages. */
export async function observeNativeJournalReadGroup(stepId: string, group: string, run: NativeRun): Promise<MachineSetupStepObservationV1> {
    const facts: MachineSetupStepObservationV1['facts'] = { requiredFact: 'journalReadGroup', group };
    const result = (status: MachineSetupStepObservationV1['status']): MachineSetupStepObservationV1 => ({ stepId, status,
        ...(status !== 'satisfied' ? { reason: 'required_fact_unavailable' } : {}), facts });
    const account = await readLocalAccount(run, 'group', group);
    if (!account) return result('unsupported');
    const gid = Number(account[2]);
    if (!Number.isSafeInteger(gid)) return result('unavailable');
    let machineId: string;
    try { machineId = (await readFile('/etc/machine-id')).toString('utf8').trim(); }
    catch (error) { if (missing(error)) return result('unsupported'); throw error; }
    if (!/^[a-f0-9]{32}$/.test(machineId)) return result('unavailable');
    const paths = new Map<string, { gid: number; directory: boolean }>();
    let files = 0;
    for (const root of ['/run/log/journal', '/var/log/journal']) {
        const directory = join(root, machineId);
        let entries: string[];
        try { entries = await readdir(directory); }
        catch (error) { if (missing(error)) continue; throw error; }
        for (const name of entries.sort()) {
            if (!/^system(?:@[^/]+)?\.journal$/.test(name)) continue;
            const path = join(directory, name), stat = await lstat(path);
            if (stat.isSymbolicLink() || !stat.isFile()) return result('unsupported');
            paths.set(path, { gid: stat.gid, directory: false }); files++;
            for (let parent = directory; ; parent = dirname(parent)) {
                if (!paths.has(parent)) {
                    const ancestor = await lstat(parent);
                    if (ancestor.isSymbolicLink() || !ancestor.isDirectory()) return result('unsupported');
                    paths.set(parent, { gid: ancestor.gid, directory: true });
                }
                if (parent === dirname(parent)) break;
            }
        }
    }
    if (!files) return result('unsupported');
    // One native metadata read for the demanded files and their shared ancestors.
    // stat's group bits alone are only the mask when a named ACL is present.
    const acl = await run('getfacl', ['-n', '-p', '--', ...paths.keys()], { LC_ALL: 'C' });
    if (acl.errorCode === 'ENOENT') return result('unsupported');
    if (acl.code !== 0) return result('unavailable');
    const sections = new Map<string, string[]>();
    for (const section of acl.stdout.split(/\n\s*\n/)) {
        if (!section.trim()) continue;
        const path = /^# file: (.+)$/m.exec(section)?.[1];
        if (!path || !paths.has(path) || sections.has(path)) return result('unavailable');
        sections.set(path, parsePosixAcl(section));
    }
    for (const [path, stat] of paths) {
        const lines = sections.get(path);
        if (!lines || !lines.some(line => /^user::[r-][w-][x-]$/.test(line))
            || !lines.some(line => /^group::[r-][w-][x-]$/.test(line))
            || !lines.some(line => /^other::[r-][w-][x-]$/.test(line))
            || lines.some(line => /^(?:user|group):\d+:/.test(line)) && !lines.some(line => /^mask::[r-][w-][x-]$/.test(line))) return result('unavailable');
        const permission = stat.directory ? 'x' : 'r';
        const groupMatch = stat.gid === gid || lines.some(line => line.startsWith(`group:${gid}:`));
        const allowed = stat.gid === gid && posixAclEntryAllows(lines, 'group::', permission)
            || posixAclEntryAllows(lines, `group:${gid}:`, permission);
        // A matching but restrictive group cannot fall through to other::.
        if (!allowed && (!stat.directory || groupMatch || !lines.some(line => /^other::[r-][w-]x$/.test(line)))) return result('unsupported');
    }
    facts.gid = gid;
    facts.systemJournalFiles = files;
    return result('satisfied');
}
