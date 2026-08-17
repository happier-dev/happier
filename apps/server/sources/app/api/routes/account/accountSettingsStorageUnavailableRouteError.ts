import { z } from "zod";

import { PlainAccountSettingsStorageUnavailableError } from "@/app/encryption/accountSettingsStorage";

export const AccountSettingsStorageUnavailableResponseSchema = z.object({
    error: z.literal("account_settings_storage_unavailable"),
}).strict();

type AccountSettingsStorageUnavailableRouteError = Readonly<{
    statusCode: 503;
    body: Readonly<{ error: "account_settings_storage_unavailable" }>;
}>;

export function resolveAccountSettingsStorageUnavailableRouteError(
    error: unknown,
): AccountSettingsStorageUnavailableRouteError | null {
    if (!(error instanceof PlainAccountSettingsStorageUnavailableError)) {
        return null;
    }
    return {
        statusCode: 503,
        body: { error: "account_settings_storage_unavailable" },
    };
}
