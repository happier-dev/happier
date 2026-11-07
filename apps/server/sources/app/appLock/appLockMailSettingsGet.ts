import type { AppLockMailSettings } from "@happier-dev/protocol";
import { loadAppLockMailSettingsForClient } from "./appLockMailSettingsStore";

/** Returns the caller's app-lock mail settings without the SMTP password, or null when unset. */
export async function appLockMailSettingsGet(ctx: { readonly uid: string }): Promise<AppLockMailSettings | null> {
    return await loadAppLockMailSettingsForClient(ctx.uid);
}
