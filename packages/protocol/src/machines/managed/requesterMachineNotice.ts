import { z } from 'zod/mini';

import { ACCOUNT_JSON_KV_PREFIXES } from '../../account/accountJsonKv.js';

export const REQUESTER_MACHINE_NOTICE_PREFIX = ACCOUNT_JSON_KV_PREFIXES.workspace + 'requester-machine-notice:v1:';
export const requesterMachineNoticeKey = (machineId: string): string => REQUESTER_MACHINE_NOTICE_PREFIX + machineId;

export const requesterMachineNoticeEnglish = {
    runsOn: ({ owner, machine }: { owner: string; machine: string }) => `Runs on ${owner}’s ${machine}`,
    runsOnSomeoneElses: ({ machine }: { machine: string }) => `Runs on someone else’s ${machine}`,
    toldOnce: 'Your Happier sign-in is stored on this machine while you work on it. Anyone with terminal or agent access could use your account and see your sessions’ files there.',
};

// Object rows mark a pending notice. Discard all fields, including old owner text.
const PendingNoticeSchema = z.object({});
type CompareAndSet = (value: true | Record<string, never>, version: number) => Promise<
    Readonly<{ success: true }> | Readonly<{ success: false; value: unknown; version: number }>
>;

/** A new Account row is either immediately claimed by a presenter or left for the app by its Agent. */
export async function recordRequesterMachineNotice(compareAndSet: CompareAndSet, pending = false): Promise<boolean> {
    const result = await compareAndSet(pending ? {} : true, -1);
    if (pending) return false;
    if (result.success) return true;
    return await claimPendingRequesterMachineNotice(compareAndSet, result);
}

/** Only one app window or CLI can claim an outstanding notice. */
export async function claimPendingRequesterMachineNotice(
    compareAndSet: CompareAndSet,
    row: Readonly<{ value: unknown; version: number }>,
): Promise<boolean> {
    if (!PendingNoticeSchema.safeParse(row.value).success) return false;
    return (await compareAndSet(true, row.version)).success;
}
