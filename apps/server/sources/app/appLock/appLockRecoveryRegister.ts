import { db } from "@/storage/db";
import type { AppLockRecoveryRegisterRequest } from "@happier-dev/protocol";
import type { AppLockResult } from "./appLockRecoveryCode";

/**
 * Stores the recovery escrow for a device lock id owned by the caller. The account must have mail
 * settings, otherwise a forgotten password could never be reset (`mail_not_configured`).
 *
 * Idempotent: retrying replaces the account-wide recovery email and the device escrow. A lock id
 * that belongs to another account is reported as `not_found`.
 */
export async function appLockRecoveryRegister(
    ctx: { readonly uid: string },
    input: AppLockRecoveryRegisterRequest,
): Promise<AppLockResult<{}>> {
    const mailSettings = await db.appLockMailSettings.findUnique({ where: { accountId: ctx.uid }, select: { accountId: true } });
    if (!mailSettings) return { ok: false, error: "mail_not_configured" };

    const existing = await db.appLockRecovery.findUnique({ where: { id: input.lockId }, select: { accountId: true } });
    if (existing && existing.accountId !== ctx.uid) return { ok: false, error: "not_found" };

    await db.$transaction(async (tx) => {
        await tx.appLockMailSettings.update({ where: { accountId: ctx.uid }, data: { recoveryEmail: input.email } });
        await tx.appLockRecovery.upsert({
            where: { id: input.lockId },
            create: { id: input.lockId, accountId: ctx.uid, email: input.email, recoveryKey: input.recoveryKey },
            update: { email: input.email, recoveryKey: input.recoveryKey },
        });
    });
    return { ok: true };
}
