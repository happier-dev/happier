import { db } from "@/storage/db";
import type { AppLockRecoveryLockRequest } from "@happier-dev/protocol";
import {
    CLEARED_APP_LOCK_CODE,
    appLockCodeCooldownSeconds,
    buildIssuedAppLockCode,
    emailAppLockResetCode,
    type AppLockResult,
} from "./appLockRecoveryCode";
import { loadAppLockRecoveryEmail, loadAppLockSmtpSettings } from "./appLockMailSettingsStore";

/**
 * Public: emails a password-reset code to the recovery address of a lock id, through the owning
 * account's SMTP server. A locked device cannot authenticate, so the unguessable lock id is the
 * only identifier; the code itself only reaches the owner's inbox.
 */
export async function appLockRecoveryRequestResetCode(
    input: AppLockRecoveryLockRequest,
    now: Date = new Date(),
): Promise<AppLockResult<{}>> {
    const record = await db.appLockRecovery.findUnique({ where: { id: input.lockId } });
    if (!record) return { ok: false, error: "not_found" };
    const smtp = await loadAppLockSmtpSettings(record.accountId);
    const recoveryEmail = await loadAppLockRecoveryEmail(record.accountId);
    if (!smtp || !recoveryEmail) return { ok: false, error: "mail_not_configured" };
    const retryAfterSeconds = appLockCodeCooldownSeconds(record, now);
    if (retryAfterSeconds > 0) return { ok: false, error: "cooldown", retryAfterSeconds };

    const issued = buildIssuedAppLockCode(record.id, "reset", now);
    await db.appLockRecovery.update({ where: { id: record.id }, data: issued.data });

    if (!(await emailAppLockResetCode(smtp, recoveryEmail, issued.code))) {
        await db.appLockRecovery.update({
            where: { id: record.id },
            data: { ...CLEARED_APP_LOCK_CODE, codeSentAt: null },
        });
        return { ok: false, error: "email_failed" };
    }
    return { ok: true };
}
