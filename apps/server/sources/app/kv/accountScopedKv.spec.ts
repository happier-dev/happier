import { describe, expect, it } from "vitest";
import { buildProjectAccountRowPhysicalKeyV1, type ProjectAccountRowKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import {
    AccountScopedKvReservedKeyError,
    assertPublicGenericKvKey,
    buildPluginAccountStoragePhysicalKey,
    buildPluginDeclarativeSettingsPhysicalKey,
    classifyAccountScopedKvKey,
    decodeAccountScopedKvJson,
} from "./accountScopedKv";

describe("AccountScopedKv namespace classifier", () => {
    it('admits only the canonical singleton Remote host, Notification and connected metadata catalog addresses', () => {
        for (const [namespace, kind] of [
            ['remote-hosts', 'accountRemoteHosts'],
            ['notification-channels', 'accountNotificationChannels'],
            ['connected-presentation', 'accountConnectedPresentation'],
            ['connected-acknowledgements', 'accountConnectedAcknowledgements'],
        ]) {
            const prefix = `@happier/account/${namespace}/v1/`;
            expect(classifyAccountScopedKvKey(`${prefix}catalog`)).toEqual({ kind });
            expect(() => assertPublicGenericKvKey(`${prefix}catalog`)).toThrow(AccountScopedKvReservedKeyError);
            expect(classifyAccountScopedKvKey(`${prefix}catalog/other`)).toEqual({ kind: 'reservedUnknown' });
            expect(classifyAccountScopedKvKey(`${prefix}host-id`)).toEqual({ kind: 'reservedUnknown' });
        }
    });
    it('reserves the qualified private Project rows and singleton graph from public KV', () => {
        const keys: ProjectAccountRowKeyV1[] = [
            { kind: 'workspace-ref', serverId: 'home/a', id: 'workspace-a' },
            { kind: 'relationship-graph' },
            { kind: 'project-organization', serverId: 'home/a', projectKey: 'project-a' },
        ];
        for (const key of keys) {
            const physicalKey = buildProjectAccountRowPhysicalKeyV1(key);
            expect(classifyAccountScopedKvKey(physicalKey)).toEqual({ kind: 'accountProjectRow', key });
            expect(() => assertPublicGenericKvKey(physicalKey)).toThrow(AccountScopedKvReservedKeyError);
        }
        expect(classifyAccountScopedKvKey('@happier/account/project-rows/v1/ref/home/a/workspace-a')).toEqual({ kind: 'reservedUnknown' });
    });
    it("addresses canonical Profile identities and the separate reference tombstone privately", () => {
        expect(classifyAccountScopedKvKey("@happier/account/profiles/v1/profile-a")).toEqual({ kind: "accountProfile", profileId: "profile-a" });
        expect(classifyAccountScopedKvKey("@happier/account/profile-reference-guard/v1")).toEqual({ kind: "accountProfileReferenceGuard" });
        expect(classifyAccountScopedKvKey("@happier/account/profile-transfer/v1")).toEqual({ kind: "accountProfileTransfer" });
        expect(() => assertPublicGenericKvKey("@happier/account/profile-transfer/v1")).toThrow(AccountScopedKvReservedKeyError);
        expect(classifyAccountScopedKvKey("@happier/account/profiles/v1/a%2Fb")).toEqual({ kind: "accountProfile", profileId: "a/b" });
        expect(classifyAccountScopedKvKey("@happier/account/profiles/v1/a/b")).toEqual({ kind: "reservedUnknown" });
        expect(() => assertPublicGenericKvKey("@happier/account/profiles/v1/profile-a")).toThrow(AccountScopedKvReservedKeyError);
    });
    it("excludes authoring-memory rows and overlapping prefixes from generic KV", async () => {
        const { assertPublicGenericKvPrefix } = await import("./accountScopedKv");
        const key = "@happier/account/authoring-memory/v1/lastUsedProfile";
        expect(() => assertPublicGenericKvKey(key)).toThrow(AccountScopedKvReservedKeyError);
        expect(() => assertPublicGenericKvPrefix("@happier/account/authoring-memory/v1/")).toThrow(AccountScopedKvReservedKeyError);
        expect(() => assertPublicGenericKvPrefix("@happier")).toThrow(AccountScopedKvReservedKeyError);
    });
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

    it("does not normalize a byte-order mark into an unsupported stored JSON representation", () => {
        expect(() => decodeAccountScopedKvJson(Uint8Array.from([
            0xef,
            0xbb,
            0xbf,
            0x7b,
            0x7d,
        ]))).toThrow();
    });
});
