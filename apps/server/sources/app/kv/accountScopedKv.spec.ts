import { describe, expect, it } from "vitest";

import {
    AccountScopedKvReservedKeyError,
    assertPublicGenericKvKey,
    buildPluginAccountStoragePhysicalKey,
    buildPluginDeclarativeSettingsPhysicalKey,
    classifyAccountScopedKvKey,
} from "./accountScopedKv";

describe("AccountScopedKv namespace classifier", () => {
    it("derives the two typed plugin rows without exposing either as public KV", () => {
        const accountStorageKey = buildPluginAccountStoragePhysicalKey(
            "example.tasks",
        );
        const settingsKey = buildPluginDeclarativeSettingsPhysicalKey(
            "example.tasks",
        );

        expect(classifyAccountScopedKvKey(accountStorageKey)).toEqual({
            kind: "pluginAccountStorage",
            pluginId: "example.tasks",
        });
        expect(classifyAccountScopedKvKey(settingsKey)).toEqual({
            kind: "pluginDeclarativeSettings",
            pluginId: "example.tasks",
        });
        expect(() => assertPublicGenericKvKey(accountStorageKey)).toThrow(
            AccountScopedKvReservedKeyError,
        );
        expect(() => assertPublicGenericKvKey(settingsKey)).toThrow(
            AccountScopedKvReservedKeyError,
        );
    });

    it("keeps Todo and nonreserved generic KV in their existing public domains", () => {
        expect(classifyAccountScopedKvKey("todo.index")).toEqual({
            kind: "todo",
            keyKind: "index",
        });
        expect(classifyAccountScopedKvKey("todo.item-1")).toEqual({
            kind: "todo",
            keyKind: "item",
        });
        expect(classifyAccountScopedKvKey("settings.theme")).toEqual({
            kind: "generic",
        });
        expect(() => assertPublicGenericKvKey("settings.theme")).not.toThrow();
    });

    it("fails closed for malformed reserved rows rather than treating them as generic KV", () => {
        const malformed = "@happier/account/plugin-storage/v1/not/a/plugin/id";

        expect(classifyAccountScopedKvKey(malformed)).toEqual({
            kind: "reservedUnknown",
        });
        expect(() => assertPublicGenericKvKey(malformed)).toThrow(
            AccountScopedKvReservedKeyError,
        );
    });
});
