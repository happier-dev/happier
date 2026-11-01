import type { MachineSetupStepObservationV1 } from './index.js';
import { readLocalAccount, type NativeRun } from './nativeSystemBackend.js';

/** Account membership is not the kernel credential set retained by systemd --user. */
export async function observeNativeUserManagerGroups(stepId: string, username: string, run: NativeRun): Promise<MachineSetupStepObservationV1> {
    const facts: MachineSetupStepObservationV1['facts'] = { requiredFact: 'userManagerGroups', username };
    const result = (status: MachineSetupStepObservationV1['status']): MachineSetupStepObservationV1 => ({ stepId, status, facts,
        ...(status === 'unavailable' || status === 'unsupported' ? { reason: 'required_fact_unavailable' } : {}) });
    const account = await readLocalAccount(run, 'passwd', username);
    if (!account) return result('unavailable');
    const uid = Number(account[2]), gid = Number(account[3]);
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0) return result('unavailable');
    const ids = (text: string): number[] | undefined => {
        const values = text.trim().split(/\s+/u);
        if (!values.length || values.some(value => !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))) return;
        return [...new Set(values.map(Number))].sort((left, right) => left - right);
    };
    const expected = await run('id', ['-G', '--', username], { LC_ALL: 'C' });
    const expectedIds = expected.code === 0 ? ids(expected.stdout) : undefined;
    if (!expectedIds || !expectedIds.includes(gid)) return result('unavailable');
    const unit = `user@${uid}.service`;
    Object.assign(facts, { uid, gid, unit, expectedGroupIds: expectedIds });
    const manager = await run('systemctl', ['show', '--property=MainPID', '--property=ActiveState', '--', unit], { LC_ALL: 'C' });
    if (manager.errorCode === 'ENOENT') return result('unsupported');
    const pidText = /^MainPID=(\d+)$/mu.exec(manager.stdout)?.[1];
    const state = /^ActiveState=([^\r\n]+)$/mu.exec(manager.stdout)?.[1];
    if (manager.code !== 0 || pidText === undefined || !state || !Number.isSafeInteger(Number(pidText))) return result('unavailable');
    // Linger may have queued startup already. The canonical synchronous restart
    // settles that job before verification; an in-flight PID is not ready proof.
    if (state === 'activating') return result('drifted');
    if (pidText === '0' && (state === 'inactive' || state === 'failed')) return result('drifted');
    if (state !== 'active' || Number(pidText) <= 0) return result('unavailable');
    const status = await run('cat', [`/proc/${Number(pidText)}/status`], { LC_ALL: 'C' });
    if (status.code !== 0) return result('unavailable');
    const uids = /^Uid:\s+([^\r\n]+)$/mu.exec(status.stdout)?.[1]?.trim().split(/\s+/u);
    const gids = /^Gid:\s+([^\r\n]+)$/mu.exec(status.stdout)?.[1]?.trim().split(/\s+/u);
    const groups = /^Groups:[ \t]*([^\r\n]*)$/mu.exec(status.stdout)?.[1];
    if (uids?.length !== 4 || uids.some(value => value !== String(uid)) || gids?.length !== 4
        || gids.some(value => value !== String(gid)) || groups === undefined) return result('unavailable');
    const actualIds = ids(`${gid} ${groups}`);
    if (!actualIds) return result('unavailable');
    Object.assign(facts, { pid: Number(pidText), actualGroupIds: actualIds });
    return result(actualIds.length === expectedIds.length && actualIds.every((value, index) => value === expectedIds[index]) ? 'satisfied' : 'drifted');
}
