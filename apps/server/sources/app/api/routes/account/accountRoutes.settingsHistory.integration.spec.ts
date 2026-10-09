import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyKit from "privacy-kit";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSavedSecretResourceInTx } from "@/app/account/savedSecrets/savedSecretResourceService";
import { deriveSavedSecretImportResourceIdV1, readSavedSecretTransferSourceV1,
    promoteLegacyInferenceSavedSecretReferenceV1 } from "@happier-dev/protocol/account/settings/savedSecretMutationOwner";
import { formatSharedSavedSecretRefV1 } from "@happier-dev/protocol/account/settings/savedSecretReferenceV1";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { currentAccountStoredContentCompatibilityHeaders } from "../../testkit/accountStoredContentCompatibility";
import { accountRoutes } from "./accountRoutes";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { sealProfileTransferContentV1, type ProfileTransferContentV1 } from "@happier-dev/protocol/profiles/profileTransferV1";
import { storePlainAccountSettingsDbValue } from "@/app/encryption/accountSettingsStorage";
import { encodeAccountScopedKvJson, PROFILE_TRANSFER_ACCOUNT_KV_KEY } from "@/app/kv/accountScopedKv";
import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1, sealMcpServerCatalogContentV1 } from "@happier-dev/protocol/mcp/servers/serverRowsV1";
import { ACP_CATALOG_ACCOUNT_ROW_KEY_V1, sealAcpCatalogContentV1 } from "@happier-dev/protocol/acp/catalog/catalogRowsV1";
import { PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1, DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    sealProviderConnectionsContentV1 } from "@happier-dev/protocol/providers/connections/connectionRowsV1";
import { buildConnectedAccountCatalogPhysicalKeyV1, sealConnectedAccountCatalogContentV1 } from "@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1";
import { emptyConnectedAccountCatalogRecordV1 } from "@happier-dev/protocol/connect/connectedAccountCatalogV1";
import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1, sealNotificationChannelCatalogContentV1 } from "@happier-dev/protocol/account/settings/notificationChannelRecordV1";
import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1,
    sealConnectedPresentationContentV1, sealConnectedAcknowledgementsContentV1 } from "@happier-dev/protocol/connect/connectedAccountPresentationRowsV1";

const encryptedContent = (value: string) => ({ t: "encrypted" as const, c: value });

/** Seed exact control revisions using the incumbent wire-to-physical KV codec. */
function controlDbValue(control: ProfileTransferContentV1) {
    const encoded = encodeAccountScopedKvJson(control);
    if (encoded === null) throw new Error("Profile control fixture could not be encoded");
    return new Uint8Array(privacyKit.decodeBase64(encoded));
}

describe("accountRoutes (/v2/account/settings/history) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-settings-history-", initAuth: false,
            initEncrypt: true });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("normalizes the cleanup-created snapshot by exact content CAS and refuses a concurrent writer", async () => {
        const previous = { t: "plain" as const, v: { profiles: [{ id: "legacy-profile" }],
            preferredLanguage: "de", futureLatest: true } };
        const cleaned = { t: "plain" as const, v: { preferredLanguage: "de", futureLatest: true } };
        const account = await db.account.create({
            data: { encryptionMode: "plain", settings: JSON.stringify(previous), settingsVersion: 1 },
        });
        await withAuthenticatedTestApp((app) => accountRoutes(app as any), async (app) => {
            const headers = { "x-test-user-id": account.id, ...currentAccountStoredContentCompatibilityHeaders };
            expect((await app.inject({ method: "POST", url: "/v2/account/settings", headers,
                payload: { content: cleaned, expectedVersion: 1, expectedProfileTransferRevision: "absent" } })).json())
                .toEqual({ success: true, version: 2 });
            await db.userKVStore.create({ data: { accountId: account.id, key: PROFILE_TRANSFER_ACCOUNT_KV_KEY,
                version: 1, value: controlDbValue({ t: "plain", v: {
                    v: 1, phase: "active", sourceSettingsVersion: 1, migratedLogicalRevision: 1,
                    inventory: [{ kind: "account_row", id: "legacy-profile", revision: 1 }],
                } }) } });
            const mutation = { expectedSettingsVersion: 2,
                expectedProfileTransferRevision: 1,
                expectedEncryptionCurrentness: { mode: "plain", signingKeyFingerprint: null, contentKeyFingerprint: null },
                expectedContent: previous,
                operation: { kind: "normalize", removedRoots: ["profiles", "secretBindingsByProfileId"],
                    transferredProfileIds: ["legacy-profile"], content: cleaned } };
            expect((await app.inject({ method: "POST", url: "/v2/account/settings/history/1/mutate", headers,
                payload: { ...mutation, operation: { ...mutation.operation, transferredProfileIds: [] } } })).json())
                .toEqual({ status: "invalid_content" });
            const result = await app.inject({ method: "POST", url: "/v2/account/settings/history/1/mutate", headers, payload: mutation });
            expect(result.statusCode).toBe(200);
            expect(result.json()).toEqual({ status: "applied" });
            expect((await app.inject({ method: "GET", url: "/v2/account/settings/history/1", headers })).json().content).toEqual(cleaned);
            // A second exact-content mutation cannot replace newer normalized history.
            expect((await app.inject({ method: "POST", url: "/v2/account/settings/history/1/mutate", headers, payload: mutation })).json()).toEqual({ status: "conflict" });
            expect((await app.inject({ method: "POST", url: "/v2/account/settings", headers,
                payload: { content: { t: "plain", v: { preferredLanguage: "fr" } }, expectedVersion: 2,
                    expectedProfileTransferRevision: 1 } })).json()).toEqual({ success: true, version: 3 });
            expect((await app.inject({ method: "POST", url: "/v2/account/settings/history/1/mutate", headers,
                payload: { ...mutation, expectedContent: cleaned, operation: { kind: "purge" } } })).json()).toEqual({ status: "conflict" });
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id, version: 1 } })).toBe(1);
        });
    });

    it("preserves recorded E2EE mode and purges only the explicitly addressed exact version", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain", settingsVersion: 4 } });
        await db.userKVStore.create({ data: { accountId: account.id, key: PROFILE_TRANSFER_ACCOUNT_KV_KEY, version: 1,
            value: controlDbValue({ t: "plain", v: { v: 1, phase: "active", sourceSettingsVersion: 3,
                migratedLogicalRevision: 1, inventory: [{ kind: "account_row", id: "custom", revision: 1 }] } }) } });
        await db.accountSettingsSnapshot.createMany({ data: [1, 2].map((version) => ({
            accountId: account.id, version, encryptionMode: "e2ee", contentKind: "encrypted", settingsDbValue: `locked-${version}`,
        })) });
        await withAuthenticatedTestApp((app) => accountRoutes(app as any), async (app) => {
            const headers = { "x-test-user-id": account.id };
            const exact = { expectedSettingsVersion: 4,
                expectedProfileTransferRevision: 1,
                expectedEncryptionCurrentness: { mode: "plain", signingKeyFingerprint: null, contentKeyFingerprint: null },
                expectedContent: encryptedContent("locked-1") };
            const bad = await app.inject({ method: "POST", url: "/v2/account/settings/history/1/mutate", headers,
                payload: { ...exact, operation: { kind: "normalize", removedRoots: ["profiles", "secretBindingsByProfileId"],
                    transferredProfileIds: ["custom"], content: { t: "plain", v: {} } } } });
            expect(bad.statusCode).toBe(200);
            expect(bad.json()).toEqual({ status: "invalid_content" });
            expect((await app.inject({ method: "POST", url: "/v2/account/settings/history/1/mutate", headers,
                payload: { ...exact, operation: { kind: "normalize", removedRoots: ["profiles", "secretBindingsByProfileId"],
                    transferredProfileIds: ["custom"], content: encryptedContent("normalized-1") } } })).json()).toEqual({ status: "applied" });
            expect((await app.inject({ method: "POST", url: "/v2/account/settings/history/2/mutate", headers,
                payload: { ...exact, expectedContent: encryptedContent("locked-2"), operation: { kind: "purge" } } })).json()).toEqual({ status: "applied" });
            const retained = await db.accountSettingsSnapshot.findMany({ where: { accountId: account.id } });
            expect(retained.map(({ version, settingsDbValue, encryptionMode }) => ({ version, settingsDbValue, encryptionMode })))
                .toEqual([{ version: 1, settingsDbValue: "normalized-1", encryptionMode: "e2ee" }]);
        });
    });

    it("normalizes only Resource-proved SavedSecret items and refuses stale destination proof", async () => {
        const migrated = { id: "legacy-secret", name: "Old", kind: "apiKey", encryptedValue: {
            _isSecretValue: true, value: "old-fixture-credential" }, createdAt: 1, updatedAt: 1 };
        const untransferred = { ...migrated, id: "not-migrated" };
        const unknown = { ...migrated, future: true };
        const previous = { t: "plain", v: { secrets: [migrated, untransferred, unknown], preferredLanguage: "de" } };
        const candidate = { t: "plain", v: { secrets: [untransferred, unknown], preferredLanguage: "de" } };
        const account = await db.account.create({ data: { encryptionMode: "plain", settingsVersion: 2 } });
        const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: account.id,
            source: { kind: "personal-saved-secret", secretId: migrated.id } });
        await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: account.id, resourceId, displayName: "Token",
            kind: "token", encryptionMode: "plain", storedContent: { t: "plain", v: {
                v: 1, name: "Token", kind: "token", value: "current-fixture-credential" } } }));
        await db.accountSettingsSnapshot.create({ data: { accountId: account.id, version: 1,
            encryptionMode: "plain", contentKind: "plain", settingsDbValue: storePlainAccountSettingsDbValue({
                accountId: account.id, content: { t: "plain", v: previous.v } }) } });
        await withAuthenticatedTestApp((app) => accountRoutes(app as any), async app => {
            const headers = { "x-test-user-id": account.id };
            const mutation = { expectedSettingsVersion: 2, expectedProfileTransferRevision: "absent",
                expectedEncryptionCurrentness: { mode: "plain", signingKeyFingerprint: null, contentKeyFingerprint: null },
                expectedContent: previous, operation: { kind: "normalize", removedRoots: [], content: candidate,
                    savedSecretTransfers: [{ savedSecretId: migrated.id, resourceId, expectedRevision: 1 }] } };
            expect((await app.inject({ method: "POST", url: "/v2/account/settings/history/1/mutate", headers,
                payload: { ...mutation, operation: { ...mutation.operation,
                    savedSecretTransfers: [{ savedSecretId: migrated.id, resourceId, expectedRevision: 2 }] } } })).json())
                .toEqual({ status: "conflict" });
            expect((await app.inject({ method: "POST", url: "/v2/account/settings/history/1/mutate", headers,
                payload: { ...mutation, operation: { ...mutation.operation, removedRoots: ["secrets"] } } })).json())
                .toEqual({ status: "invalid_content" });
            expect((await app.inject({ method: "POST", url: "/v2/account/settings/history/1/mutate", headers, payload: mutation })).json())
                .toEqual({ status: "applied" });
            expect((await app.inject({ method: "GET", url: "/v2/account/settings/history/1", headers })).json().content).toEqual(candidate);
        });
    });

    it("promotes the exact bare inference source atomically and admits only its current Resource history proof", async () => {
        const previous = { t: "plain" as const, v: { inferenceOpenAIKey: " exact-inference-fixture ",
            preferredLanguage: "de", futurePreference: { retained: true } } };
        const account = await db.account.create({ data: { encryptionMode: "plain", settingsVersion: 1,
            settings: JSON.stringify(previous) } });
        const candidate = readSavedSecretTransferSourceV1(previous.v).inferenceCredential;
        if (!candidate) throw new Error("inference_fixture_not_admitted");
        const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: account.id, source: candidate.source });
        const rewrite = promoteLegacyInferenceSavedSecretReferenceV1(previous.v, {
            source: candidate.source, sharedSecretRef: formatSharedSavedSecretRefV1(resourceId),
        });
        const cleaned = { t: "plain" as const, v: rewrite.settings };
        await withAuthenticatedTestApp((app) => accountRoutes(app as any), async app => {
            const headers = { "x-test-user-id": account.id, ...currentAccountStoredContentCompatibilityHeaders };
            const promotion = { resourceId, displayName: candidate.displayName, kind: candidate.kind, encryptionMode: "plain",
                storedContent: { t: "plain", v: { v: 1, name: candidate.displayName, kind: candidate.kind, value: rewrite.value } },
                expectedSettingsVersion: 1, nextSettings: cleaned,
                referenceCensus: { accountMode: "plain", profileTransferRevision: "absent",
                    profiles: { referenceGuardRevision: "absent", rows: [] } }, profileMutations: [] };
            expect((await app.inject({ method: "POST", url: "/v1/account/saved-secrets/resources/promote", headers,
                payload: { ...promotion, expectedSettingsVersion: 0 } })).json()).toEqual({ error: "settings_conflict" });
            expect(await db.savedSecretResource.count({ where: { ownerAccountId: account.id } })).toBe(0);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settings).toBe(JSON.stringify(previous));
            const promoted = await app.inject({ method: "POST", url: "/v1/account/saved-secrets/resources/promote", headers, payload: promotion });
            expect(promoted.statusCode, promoted.body).toBe(200);
            expect(promoted.json()).toEqual({ resourceId, settingsVersion: 2 });
            expect((await app.inject({ method: "GET", url: "/v2/account/settings", headers })).json())
                .toMatchObject({ version: 2, content: cleaned });
            expect((await app.inject({ method: "GET", url: "/v1/account/saved-secrets/resources/materials", headers })).json())
                .toMatchObject({ resources: [{ resourceId, entry: { materialStatus: "ready", revision: 1 },
                    storedContent: promotion.storedContent }] });
            expect((await app.inject({ method: "GET", url: "/v2/account/settings/history/1", headers })).json().content).toEqual(previous);
            const transfer = { source: candidate.source, resourceId, expectedRevision: 1 };
            const mutation = { expectedSettingsVersion: 2, expectedProfileTransferRevision: "absent",
                expectedEncryptionCurrentness: { mode: "plain", signingKeyFingerprint: null, contentKeyFingerprint: null },
                expectedContent: previous, operation: { kind: "normalize", removedRoots: [], content: cleaned, savedSecretTransfers: [transfer] } };
            const postHistory = (payload: unknown) => app.inject({ method: "POST", url: "/v2/account/settings/history/1/mutate", headers, payload });
            expect((await postHistory({ ...mutation, operation: { ...mutation.operation,
                savedSecretTransfers: [{ ...transfer, expectedRevision: 2 }] } })).json()).toEqual({ status: "conflict" });
            expect((await postHistory({ ...mutation, operation: { ...mutation.operation, removedRoots: ["inferenceOpenAIKey"] } })).json())
                .toEqual({ status: "invalid_content" });
            expect((await postHistory({ ...mutation, operation: { ...mutation.operation, savedSecretTransfers: [transfer, transfer] } })).json())
                .toEqual({ status: "invalid_content" });
            expect((await app.inject({ method: "GET", url: "/v2/account/settings/history/1", headers })).json().content).toEqual(previous);
            expect((await postHistory(mutation)).json()).toEqual({ status: "applied" });
            expect((await app.inject({ method: "GET", url: "/v2/account/settings/history/1", headers })).json().content).toEqual(cleaned);
        });
    });

    it("normalizes recorded Plain Profile residue with the exact current E2EE control without server decryption", async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee", settingsVersion: 2 } });
        const previous = { t: "plain" as const, v: { profiles: [{ id: "custom" }],
            profileEnabledById: { custom: false, anthropic: true },
            promptStacksV1: { v: 1, surfaces: { profilesById: { custom: {} }, other: { keep: true } } } } };
        const candidate = { t: "plain", v: { profileEnabledById: { anthropic: true },
            promptStacksV1: { v: 1, surfaces: { other: { keep: true } } } } };
        await db.userKVStore.create({ data: { accountId: account.id, key: PROFILE_TRANSFER_ACCOUNT_KV_KEY, version: 1,
            value: controlDbValue(sealProfileTransferContentV1({ mode: "e2ee",
                material: { type: "dataKey", machineKey: new Uint8Array(32).fill(7) }, record: {
                    v: 1, phase: "active", sourceSettingsVersion: 1, migratedLogicalRevision: 1,
                    inventory: [{ kind: "account_row", id: "custom", revision: 1 }],
                } })) } });
        await db.accountSettingsSnapshot.create({ data: { accountId: account.id, version: 1, encryptionMode: "plain", contentKind: "plain",
            settingsDbValue: storePlainAccountSettingsDbValue({ accountId: account.id, content: previous }) } });
        await withAuthenticatedTestApp(app => accountRoutes(app as any), async app => {
            const headers = { "x-test-user-id": account.id };
            const currentness = (await app.inject({ method: "GET", url: "/v1/account/encryption/currentness", headers })).json();
            const payload = { expectedSettingsVersion: 2, expectedProfileTransferRevision: 1,
                expectedEncryptionCurrentness: { mode: "e2ee", signingKeyFingerprint: currentness.signingKeyFingerprint,
                    contentKeyFingerprint: currentness.contentKeyFingerprint }, expectedContent: previous,
                operation: { kind: "normalize", removedRoots: ["profiles", "secretBindingsByProfileId"],
                    transferredProfileIds: ["custom"], content: candidate } };
            expect((await app.inject({ method: "POST", url: "/v2/account/settings/history/1/mutate", headers,
                payload: { ...payload, expectedProfileTransferRevision: 0 } })).json()).toEqual({ status: "conflict" });
            expect((await app.inject({ method: "POST", url: "/v2/account/settings/history/1/mutate", headers, payload })).json())
                .toEqual({ status: "applied" });
            expect((await app.inject({ method: "GET", url: "/v2/account/settings/history/1", headers })).json().content).toEqual(candidate);
        });
    });

    it.each([
        { field: "mcp", root: "mcpServersSettingsV1", physicalKey: MCP_SERVER_CATALOG_ACCOUNT_KEY_V1,
            seal: () => sealMcpServerCatalogContentV1({ mode: "e2ee",
                material: { type: "dataKey", machineKey: new Uint8Array(32).fill(7) },
                catalog: { v: 1, servers: [], bindings: [] } }) },
        { field: "acp", root: "acpCatalogSettingsV1", physicalKey: ACP_CATALOG_ACCOUNT_ROW_KEY_V1,
            seal: () => sealAcpCatalogContentV1({ mode: "e2ee",
                material: { type: "dataKey", machineKey: new Uint8Array(32).fill(7) },
                record: { v: 1, definitions: [] } }) },
        { field: "providerConnections", root: "providerSettingsV1", physicalKey: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
            seal: () => sealProviderConnectionsContentV1({ mode: "e2ee",
                material: { type: "dataKey", machineKey: new Uint8Array(32).fill(7) },
                catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 }) },
        { field: "notificationChannels", root: "notificationChannelsV1", physicalKey: NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1,
            seal: () => sealNotificationChannelCatalogContentV1({ mode: "e2ee",
                material: { type: "dataKey", machineKey: new Uint8Array(32).fill(7) },
                record: { v: 1, channels: [] } }) },
        { field: "connectedPresentation", root: "connectedServicesProfileLabelByKey", physicalKey: CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1,
            seal: () => sealConnectedPresentationContentV1({ mode: "e2ee",
                material: { type: "dataKey", machineKey: new Uint8Array(32).fill(7) }, record: { v: 1, entries: [] } }) },
        { field: "connectedAcknowledgements", root: "connectedServicesDefaultAuthPoolAdoptionDismissedByKey",
            physicalKey: CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1,
            seal: () => sealConnectedAcknowledgementsContentV1({ mode: "e2ee",
                material: { type: "dataKey", machineKey: new Uint8Array(32).fill(7) }, record: { v: 1, entries: [] } }) },
        ...(["configurations", "purposes"] as const).map(key => ({
            field: key === "configurations" ? "connectedConfigurations" : "connectedPurposes",
            root: key === "configurations" ? "connectedAccountServiceConfigurationsV1" : "connectedAccountPurposeBindingsV1",
            physicalKey: buildConnectedAccountCatalogPhysicalKeyV1(key),
            seal: () => sealConnectedAccountCatalogContentV1({ mode: "e2ee",
                material: { type: "dataKey", machineKey: new Uint8Array(32).fill(7) },
                record: emptyConnectedAccountCatalogRecordV1(key) }),
        })),
    ])("refuses encrypted private history authority with an unclassified outer reference carrier ($field)", async fixture => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(),
            encryptionMode: "e2ee", settingsVersion: 2 } });
        const admitted = { ...fixture.seal(), harmlessMetadata: { retained: true } };
        const stored = { ...admitted, futureReference: { t: "savedSecret",
            secretId: formatSharedSavedSecretRefV1("unclassified-history-resource") } };
        const encode = (value: unknown) => {
            const encoded = encodeAccountScopedKvJson(value);
            if (encoded === null) throw new Error("Private catalog history fixture could not be encoded");
            return new Uint8Array(privacyKit.decodeBase64(encoded));
        };
        await db.userKVStore.create({ data: { accountId: account.id, key: fixture.physicalKey,
            version: 3, value: encode(stored) } });
        await db.accountSettingsSnapshot.create({ data: { accountId: account.id, version: 1,
            encryptionMode: "e2ee", contentKind: "encrypted", settingsDbValue: "recorded-mcp-source" } });
        await withAuthenticatedTestApp(app => accountRoutes(app as any), async app => {
            const headers = { "x-test-user-id": account.id };
            const currentness = (await app.inject({ method: "GET", url: "/v1/account/encryption/currentness", headers })).json();
            const payload = { expectedSettingsVersion: 2, expectedProfileTransferRevision: "absent",
                expectedEncryptionCurrentness: { mode: "e2ee", signingKeyFingerprint: currentness.signingKeyFingerprint,
                    contentKeyFingerprint: currentness.contentKeyFingerprint },
                expectedContent: encryptedContent("recorded-mcp-source"), operation: { kind: "normalize",
                    removedRoots: fixture.field === "connectedAcknowledgements" ? [fixture.root, "dismissedCLIWarnings"] : [fixture.root],
                    transferredPrivateCatalogRevisions: { [fixture.field]: 3 },
                    content: encryptedContent("normalized-mcp-source") } };
            const post = () => app.inject({ method: "POST", url: "/v2/account/settings/history/1/mutate", headers, payload });
            expect((await post()).json()).toEqual({ status: "invalid_content" });
            expect((await db.accountSettingsSnapshot.findUniqueOrThrow({ where: {
                accountId_version: { accountId: account.id, version: 1 },
            } })).settingsDbValue).toBe("recorded-mcp-source");
            // Removing only the unclassified carrier restores the exact same typed row authority.
            await db.userKVStore.update({ where: { accountId_key: { accountId: account.id,
                key: fixture.physicalKey } }, data: { value: encode(admitted) } });
            expect((await post()).json()).toEqual({ status: "applied" });
        });
    });

    it("stores previous and current encrypted snapshots after a v2 write", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "ciphertext-old",
                settingsVersion: 4,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const update = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                        ...currentAccountStoredContentCompatibilityHeaders,
                    },
                    payload: { content: encryptedContent("ciphertext-new"), expectedVersion: 4 },
                });
                expect(update.statusCode).toBe(200);
                expect(update.json()).toEqual({ success: true, version: 5 });

                const history = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history",
                    headers: { "x-test-user-id": account.id },
                });
                expect(history.statusCode).toBe(200);
                expect(history.json()).toEqual({
                    snapshots: [
                        expect.objectContaining({ version: 5, contentKind: "encrypted", byteLength: "ciphertext-new".length }),
                        expect.objectContaining({ version: 4, contentKind: "encrypted", byteLength: "ciphertext-old".length }),
                    ],
                });
                expect(JSON.stringify(history.json())).not.toContain("ciphertext-new");
                expect(JSON.stringify(history.json())).not.toContain("ciphertext-old");
            },
        );
    });

    it("does not create history snapshots for failed v2 version checks", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "ciphertext-current",
                settingsVersion: 7,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const update = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                        ...currentAccountStoredContentCompatibilityHeaders,
                    },
                    payload: { content: encryptedContent("ciphertext-wrong"), expectedVersion: 6 },
                });
                expect(update.statusCode).toBe(200);
                expect(update.json()).toMatchObject({ success: false, error: "version-mismatch", currentVersion: 7 });

                const history = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history",
                    headers: { "x-test-user-id": account.id },
                });
                expect(history.statusCode).toBe(200);
                expect(history.json()).toEqual({ snapshots: [] });
            },
        );
    });

    it("stores previous and current encrypted snapshots after a v1 write", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "v1-old",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const update = await app.inject({
                    method: "POST",
                    url: "/v1/account/settings",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                        ...currentAccountStoredContentCompatibilityHeaders,
                    },
                    payload: { settings: "v1-new", expectedVersion: 1 },
                });
                expect(update.statusCode).toBe(200);
                expect(update.json()).toEqual({ success: true, version: 2 });

                const history = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history",
                    headers: { "x-test-user-id": account.id },
                });
                expect(history.statusCode).toBe(200);
                expect(history.json()).toEqual({
                    snapshots: [
                        expect.objectContaining({ version: 2, contentKind: "encrypted" }),
                        expect.objectContaining({ version: 1, contentKind: "encrypted" }),
                    ],
                });
            },
        );
    });

    it("prunes history snapshots to the configured limit", async () => {
        harness.resetEnv({ HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: "2" });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "ciphertext-0",
                settingsVersion: 0,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                for (let version = 0; version < 4; version += 1) {
                    const update = await app.inject({
                        method: "POST",
                        url: "/v2/account/settings",
                        headers: {
                            "content-type": "application/json",
                            "x-test-user-id": account.id,
                            ...currentAccountStoredContentCompatibilityHeaders,
                        },
                        payload: { content: encryptedContent(`ciphertext-${version + 1}`), expectedVersion: version },
                    });
                    expect(update.statusCode).toBe(200);
                    expect(update.json()).toEqual({ success: true, version: version + 1 });
                }

                const history = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history",
                    headers: { "x-test-user-id": account.id },
                });
                expect(history.statusCode).toBe(200);
                expect(history.json().snapshots.map((snapshot: { version: number }) => snapshot.version)).toEqual([4, 3]);
            },
        );
    });

    it("does not retain history snapshots when the configured limit is zero", async () => {
        harness.resetEnv({ HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: "0" });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "disabled-old",
                settingsVersion: 0,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const update = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                        ...currentAccountStoredContentCompatibilityHeaders,
                    },
                    payload: { content: encryptedContent("disabled-new"), expectedVersion: 0 },
                });
                expect(update.statusCode).toBe(200);
                expect(update.json()).toEqual({ success: true, version: 1 });

                const history = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history",
                    headers: { "x-test-user-id": account.id },
                });
                expect(history.statusCode).toBe(200);
                expect(history.json()).toEqual({ snapshots: [] });
            },
        );
    });

    it("returns snapshot content only from the version detail route", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "detail-old",
                settingsVersion: 10,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                        ...currentAccountStoredContentCompatibilityHeaders,
                    },
                    payload: { content: encryptedContent("detail-new"), expectedVersion: 10 },
                });

                const detail = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history/10",
                    headers: { "x-test-user-id": account.id },
                });
                expect(detail.statusCode).toBe(200);
                expect(detail.json()).toEqual({
                    content: encryptedContent("detail-old"),
                    version: 10,
                    createdAt: expect.any(String),
                });
            },
        );
    });

    it("fails an unknown snapshot mode without exposing bytes, cursors, or a restore mutation", async () => {
        const retainedBytes = "retained-unknown-mode-settings-bytes";
        const account = await db.account.create({
            data: {
                encryptionMode: "plain",
                settings: JSON.stringify({ t: "plain", v: { schemaVersion: 2 } }),
                settingsVersion: 3,
            },
            select: { id: true, settings: true, settingsVersion: true, updatedAt: true },
        });
        await db.accountSettingsSnapshot.create({
            data: {
                accountId: account.id,
                version: 2,
                settingsDbValue: retainedBytes,
                encryptionMode: "future-mode",
                contentKind: "encrypted",
            },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const list = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history",
                    headers: { "x-test-user-id": account.id },
                });
                expect(list.statusCode).toBe(503);
                expect(list.json()).toEqual({ error: "account_settings_storage_unavailable" });
                expect(list.body).not.toContain(retainedBytes);

                const detail = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history/2",
                    headers: { "x-test-user-id": account.id },
                });
                expect(detail.statusCode).toBe(503);
                expect(detail.json()).toEqual({ error: "account_settings_storage_unavailable" });
                expect(detail.body).not.toContain(retainedBytes);

                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/2/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        expectedVersion: 3,
                        content: encryptedContent(retainedBytes),
                    },
                });
                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });
                expect(restore.body).not.toContain(retainedBytes);
            },
        );

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { settings: true, settingsVersion: true, updatedAt: true },
        })).resolves.toEqual({
            settings: account.settings,
            settingsVersion: account.settingsVersion,
            updatedAt: account.updatedAt,
        });
        await expect(db.accountSettingsSnapshot.count({
            where: { accountId: account.id },
        })).resolves.toBe(1);
        await expect(db.accountChange.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
    });

    it("reports an unreadable plain snapshot as storage unavailable without exposing retained bytes", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-detail-unreadable",
                encryptionMode: "plain",
                settings: JSON.stringify({ t: "plain", v: { schemaVersion: 2 } }),
                settingsVersion: 3,
            },
            select: { id: true },
        });
        await db.accountSettingsSnapshot.create({
            data: {
                accountId: account.id,
                version: 2,
                settingsDbValue: "retained-e2ee-history-ciphertext",
                encryptionMode: "plain",
                contentKind: "plain",
            },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const detail = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings/history/2",
                    headers: { "x-test-user-id": account.id },
                });

                expect(detail.statusCode).toBe(503);
                expect(detail.json()).toEqual({ error: "account_settings_storage_unavailable" });
                expect(detail.body).not.toContain("retained-e2ee-history-ciphertext");
            },
        );
    });

    it("refuses to restore an unreadable plain snapshot without writing", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-settings-history-restore-unreadable",
                encryptionMode: "plain",
                settings: JSON.stringify({ t: "plain", v: { schemaVersion: 2 } }),
                settingsVersion: 3,
            },
            select: { id: true, settings: true, settingsVersion: true, updatedAt: true },
        });
        await db.accountSettingsSnapshot.create({
            data: {
                accountId: account.id,
                version: 2,
                settingsDbValue: "retained-e2ee-history-ciphertext",
                encryptionMode: "plain",
                contentKind: "plain",
            },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/2/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        expectedVersion: 3,
                        content: { t: "plain", v: { schemaVersion: 2 } },
                    },
                });

                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });
                expect(restore.body).not.toContain("retained-e2ee-history-ciphertext");
            },
        );

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { settings: true, settingsVersion: true, updatedAt: true },
        })).resolves.toEqual({
            settings: account.settings,
            settingsVersion: account.settingsVersion,
            updatedAt: account.updatedAt,
        });
        await expect(db.accountSettingsSnapshot.count({
            where: { accountId: account.id },
        })).resolves.toBe(1);
    });

    it("fails closed instead of letting the retired exact-content restore overwrite current encrypted settings", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "restore-old",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                        ...currentAccountStoredContentCompatibilityHeaders,
                    },
                    payload: { content: encryptedContent("restore-new"), expectedVersion: 1 },
                });

                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/1/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { expectedVersion: 2, content: encryptedContent("restore-old") },
                });
                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });

                const current = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings",
                    headers: { "x-test-user-id": account.id },
                });
                expect(current.json()).toEqual({ content: encryptedContent("restore-new"), version: 2 });
            },
        );
    });

    it("rejects restore when the client-validated content echo is missing", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "restore-missing-echo-old",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                        ...currentAccountStoredContentCompatibilityHeaders,
                    },
                    payload: { content: encryptedContent("restore-missing-echo-new"), expectedVersion: 1 },
                });

                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/1/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { expectedVersion: 2 },
                });
                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });

                const current = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings",
                    headers: { "x-test-user-id": account.id },
                });
                expect(current.json()).toEqual({ content: encryptedContent("restore-missing-echo-new"), version: 2 });
            },
        );
    });

    it("rejects restore when the client-validated content does not match the snapshot", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "restore-validated-old",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                        ...currentAccountStoredContentCompatibilityHeaders,
                    },
                    payload: { content: encryptedContent("restore-validated-new"), expectedVersion: 1 },
                });

                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/1/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { expectedVersion: 2, content: encryptedContent("wrong-ciphertext") },
                });
                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });

                const current = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings",
                    headers: { "x-test-user-id": account.id },
                });
                expect(current.json()).toEqual({ content: encryptedContent("restore-validated-new"), version: 2 });
            },
        );
    });

    it("rejects restore when the snapshot storage mode is incompatible with the current account mode", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "restore-mode-old",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                        ...currentAccountStoredContentCompatibilityHeaders,
                    },
                    payload: { content: encryptedContent("restore-mode-new"), expectedVersion: 1 },
                });

                await db.account.update({
                    where: { id: account.id },
                    data: { encryptionMode: "plain" },
                });

                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/1/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { expectedVersion: 2, content: encryptedContent("restore-mode-old") },
                });
                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });

                const stored = await db.account.findUnique({
                    where: { id: account.id },
                    select: { settings: true, settingsVersion: true },
                });
                expect(stored).toEqual({ settings: "restore-mode-new", settingsVersion: 2 });
            },
        );
    });

    it("returns a CAS mismatch when restore expectedVersion is stale", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "restore-cas-old",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                        ...currentAccountStoredContentCompatibilityHeaders,
                    },
                    payload: { content: encryptedContent("restore-cas-new"), expectedVersion: 1 },
                });

                const restore = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings/history/1/restore",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { expectedVersion: 1, content: encryptedContent("restore-cas-old") },
                });
                expect(restore.statusCode).toBe(426);
                expect(restore.json()).toEqual({
                    error: "account_settings_restore_client_update_required",
                });
            },
        );
    });
});
