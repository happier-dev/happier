import type { AppLockResult } from "./appLockRecoveryCode";
import { sendAppLockEmail } from "./appLockRecoveryCode";
import { loadAppLockRecoveryEmail, loadAppLockSmtpSettings } from "./appLockMailSettingsStore";

/** Sends a test email with the caller's saved SMTP settings so they can confirm reset emails arrive. */
export async function appLockMailSettingsSendTest(
    ctx: { readonly uid: string },
): Promise<AppLockResult<{}>> {
    const smtp = await loadAppLockSmtpSettings(ctx.uid);
    const to = await loadAppLockRecoveryEmail(ctx.uid);
    if (!smtp || !to) return { ok: false, error: "mail_not_configured" };
    const sent = await sendAppLockEmail(smtp, {
        to,
        subject: "Happier app lock: test email",
        text: "This is a test from your Happier relay. Password reset codes for the app lock will arrive like this.\n",
    }, "test");
    return sent ? { ok: true } : { ok: false, error: "email_failed" };
}
