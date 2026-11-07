import { db } from "@/storage/db";
import type { AppLockRecoveryCodeRequest } from "@happier-dev/protocol";
import { appLockRecoveryConsumeCode } from "./appLockRecoveryConsumeCode";
import type { AppLockResult } from "./appLockRecoveryCode";

/**
 * Public: trades a valid password-reset code for the lock id's recovery key. The code is single
 * use and the attempt budget is enforced by `appLockRecoveryConsumeCode`.
 */
export async function appLockRecoveryRedeem(
    input: AppLockRecoveryCodeRequest,
    now: Date = new Date(),
): Promise<AppLockResult<{ readonly recoveryKey: string }>> {
    const record = await db.appLockRecovery.findUnique({ where: { id: input.lockId } });
    if (!record) return { ok: false, error: "not_found" };
    const verdict = await appLockRecoveryConsumeCode(record, "reset", input.code, now);
    return verdict === "ok" ? { ok: true, recoveryKey: record.recoveryKey } : { ok: false, error: verdict };
}
