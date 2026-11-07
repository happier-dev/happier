import type { AppLockMailSecurity, AppLockMailSettings } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { decryptString, encryptString } from "@/modules/encrypt";
import type { SmtpSettings } from "@/modules/mail/sendMail";

function smtpPasswordKeyPath(accountId: string): string[] {
    return ["user", accountId, "appLock", "smtp", "password"];
}

export function encryptAppLockSmtpPassword(accountId: string, password: string): Uint8Array<ArrayBuffer> {
    return encryptString(smtpPasswordKeyPath(accountId), password) as Uint8Array<ArrayBuffer>;
}

function toSecurity(value: string): AppLockMailSecurity {
    return value === "tls" || value === "starttls" ? value : "none";
}

/** The account's SMTP settings with the password decrypted, for sending. */
export async function loadAppLockSmtpSettings(accountId: string): Promise<SmtpSettings | null> {
    const row = await db.appLockMailSettings.findUnique({ where: { accountId } });
    if (!row) return null;
    return {
        host: row.host,
        port: row.port,
        security: toSecurity(row.security),
        username: row.username,
        password: row.passwordEncrypted
            ? decryptString(smtpPasswordKeyPath(accountId), new Uint8Array(row.passwordEncrypted))
            : null,
        fromAddress: row.fromAddress,
    };
}

/** The account-wide recipient shared by every device's app-lock recovery flow. */
export async function loadAppLockRecoveryEmail(accountId: string): Promise<string | null> {
    const row = await db.appLockMailSettings.findUnique({ where: { accountId }, select: { recoveryEmail: true } });
    return row?.recoveryEmail ?? null;
}

/** The account's SMTP settings as shown to clients: never includes the password. */
export async function loadAppLockMailSettingsForClient(accountId: string): Promise<AppLockMailSettings | null> {
    const row = await db.appLockMailSettings.findUnique({ where: { accountId } });
    if (!row) return null;
    return {
        recoveryEmail: row.recoveryEmail,
        host: row.host,
        port: row.port,
        security: toSecurity(row.security),
        username: row.username,
        fromAddress: row.fromAddress,
        hasPassword: row.passwordEncrypted !== null && row.passwordEncrypted.length > 0,
    };
}
