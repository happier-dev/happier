import { describe, expect, it } from "vitest";

import {
    ACCOUNT_SETTINGS_HISTORY_LIMIT_ENV,
    MAX_ACCOUNT_SETTINGS_HISTORY_LIMIT,
    resolveAccountSettingsHistoryLimitFromEnv,
} from "./accountSettingsHistoryConfig";

describe("resolveAccountSettingsHistoryLimitFromEnv", () => {
    it("allows zero to disable account settings history", () => {
        expect(resolveAccountSettingsHistoryLimitFromEnv({
            [ACCOUNT_SETTINGS_HISTORY_LIMIT_ENV]: "0",
        })).toBe(0);
    });

    it("clamps oversized account settings history limits to the documented maximum", () => {
        expect(resolveAccountSettingsHistoryLimitFromEnv({
            [ACCOUNT_SETTINGS_HISTORY_LIMIT_ENV]: String(MAX_ACCOUNT_SETTINGS_HISTORY_LIMIT + 1),
        })).toBe(MAX_ACCOUNT_SETTINGS_HISTORY_LIMIT);
    });
});
