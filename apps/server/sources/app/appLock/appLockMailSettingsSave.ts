import type { AppLockMailSettingsInput } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { encryptAppLockSmtpPassword } from "./appLockMailSettingsStore";

/**
 * Saves the caller's SMTP server for app-lock reset emails. The password is encrypted at rest.
 * Omitting `password` keeps the saved one; an empty password clears it. Idempotent.
 */
export async function appLockMailSettingsSave(ctx: { readonly uid: string }, input: AppLockMailSettingsInput): Promise<void> {
    const passwordData = input.password === undefined
        ? {}
        : { passwordEncrypted: input.password ? encryptAppLockSmtpPassword(ctx.uid, input.password) : null };
    const fields = {
        ...(input.recoveryEmail !== undefined ? { recoveryEmail: input.recoveryEmail } : {}),
        host: input.host,
        port: input.port,
        security: input.security,
        username: input.username,
        fromAddress: input.fromAddress,
    };
    await db.appLockMailSettings.upsert({
        where: { accountId: ctx.uid },
        create: { accountId: ctx.uid, recoveryEmail: input.recoveryEmail ?? null, ...fields, passwordEncrypted: null, ...passwordData },
        update: { ...fields, ...passwordData },
    });
}
