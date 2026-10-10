import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { TransactionClient } from "@/storage/prisma";
import { buildPromptLibraryPhysicalKeyV1 } from "@happier-dev/protocol/prompts/library/promptLibraryRowsV1";
import { emptyPromptLibraryRecordV1 } from "@happier-dev/protocol/prompts/library/promptLibraryCatalogV1";
import { readLegacyRolesV1 } from "@happier-dev/protocol";
import { buildConnectedAccountCatalogPhysicalKeyV1 } from "@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1";
import { emptyConnectedAccountCatalogRecordV1 } from "@happier-dev/protocol/connect/connectedAccountCatalogV1";
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1 } from "@happier-dev/protocol/providers/connections/connectionRowsV1";
import { ACP_CATALOG_ACCOUNT_ROW_KEY_V1, AcpCatalogRecordV1Schema } from "@happier-dev/protocol/acp/catalog/catalogRowsV1";
import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1, McpServerCatalogV1Schema } from "@happier-dev/protocol/mcp/servers/serverRowsV1";
import { formatSharedSavedSecretRefV1 } from "@happier-dev/protocol/account/settings/savedSecretReferenceV1";

import { ACCOUNT_SETTINGS_HISTORY_MAX_AGGREGATE_BYTES } from "./accountSettingsHistoryConfig";
import { mutateAccountSettingsHistorySnapshotInTx, recordAccountSettingsSnapshotsForWrite } from "./accountSettingsHistoryRepository";

type Snapshot = Readonly<{
    id: string;
    accountId: string;
    version: number;
    createdAt: Date;
    settingsDbValue: string | null;
}>;

function createHistoryTransaction(initialSnapshots: readonly Snapshot[]) {
    const snapshots = [...initialSnapshots];
    let nextId = initialSnapshots.length + 1;
    const accountSettingsSnapshot = {
        upsert: vi.fn(async (input: Readonly<{
            where: Readonly<{ accountId_version: Readonly<{ accountId: string; version: number }> }>;
            create: Readonly<{
                accountId: string;
                version: number;
                settingsDbValue: string | null;
            }>;
        }>) => {
            const existing = snapshots.find((snapshot) => (
                snapshot.accountId === input.where.accountId_version.accountId
                && snapshot.version === input.where.accountId_version.version
            ));
            if (existing) return existing;

            const created: Snapshot = {
                id: `snapshot-${nextId++}`,
                accountId: input.create.accountId,
                version: input.create.version,
                createdAt: new Date(input.create.version),
                settingsDbValue: input.create.settingsDbValue,
            };
            snapshots.push(created);
            return created;
        }),
        findMany: vi.fn(async (input: Readonly<{
            where: Readonly<{ accountId: string }>;
            skip?: number;
        }>) => snapshots
            .filter((snapshot) => snapshot.accountId === input.where.accountId)
            .sort((left, right) => right.version - left.version)
            .slice(input.skip ?? 0)
            .map((snapshot) => ({
                id: snapshot.id,
                settingsDbValue: snapshot.settingsDbValue,
            }))),
        deleteMany: vi.fn(async (input: Readonly<{
            where: Readonly<{
                accountId?: string;
                id?: Readonly<{ in: readonly string[] }>;
            }>;
        }>) => {
            const ids = input.where.id?.in;
            const deleted = snapshots.filter((snapshot) => (
                ids?.includes(snapshot.id)
                || (input.where.accountId !== undefined && snapshot.accountId === input.where.accountId)
            ));
            for (const snapshot of deleted) {
                snapshots.splice(snapshots.indexOf(snapshot), 1);
            }
            return { count: deleted.length };
        }),
    };

    // Narrow persistence-boundary fixture; this owner only uses the snapshot delegate.
    return {
        tx: { accountSettingsSnapshot } as unknown as TransactionClient,
        snapshots,
        accountSettingsSnapshot,
    };
}

describe("Account Settings history repository", () => {
    it.each([
        { field: "providerConnections", root: "providerSettingsV1", physicalKey: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
            value: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, source: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, defaultsByAgentTargetKey: {} },
            malformed: { v: 2, connections: [] } },
        { field: "acp", root: "acpCatalogSettingsV1", physicalKey: ACP_CATALOG_ACCOUNT_ROW_KEY_V1,
            value: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [] }), source: { v: 2, backends: [] },
            malformed: { v: 2, definitions: [] } },
        { field: "mcp", root: "mcpServersSettingsV1", physicalKey: MCP_SERVER_CATALOG_ACCOUNT_KEY_V1,
            value: McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] }), source: { v: 1, servers: [], bindings: [] },
            malformed: { v: 2, servers: [], bindings: [] } },
        { field: "connectedConfigurations", root: "connectedAccountServiceConfigurationsV1",
            physicalKey: buildConnectedAccountCatalogPhysicalKeyV1("configurations"),
            value: emptyConnectedAccountCatalogRecordV1("configurations"), source: { v: 1, entries: [] },
            malformed: { key: "configurations", value: { v: 2, entries: [] } } },
        { field: "connectedPurposes", root: "connectedAccountPurposeBindingsV1",
            physicalKey: buildConnectedAccountCatalogPhysicalKeyV1("purposes"),
            value: emptyConnectedAccountCatalogRecordV1("purposes"), source: { v: 1, bindings: [] },
            malformed: { key: "purposes", value: { v: 2, bindings: [] } } },
    ] as const)("admits private catalog history cleanup only for its actual row revision ($field)", async fixture => {
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST", "none");
        onTestFinished(() => { vi.unstubAllEnvs(); });
        const siblingRoot = fixture.root === "connectedAccountPurposeBindingsV1"
            ? "connectedAccountServiceConfigurationsV1" : "connectedAccountPurposeBindingsV1";
        const siblingValue = siblingRoot === "connectedAccountPurposeBindingsV1" ? { v: 1, bindings: [] } : { v: 1, entries: [] };
        const original = { [fixture.root]: fixture.source, [siblingRoot]: siblingValue, preferredLanguage: "de" };
        const normalized = { [siblingRoot]: siblingValue, preferredLanguage: "de",
            ...(fixture.field === "providerConnections" ? { providerDefaultModelSelectionsByAgentTargetKeyV1: {} } : {}),
            ...(fixture.field === "mcp" ? { mcpServersStrictMode: false } : {}) };
        const snapshot = { accountId: "account-1", version: 4, encryptionMode: "plain", contentKind: "plain",
            settingsDbValue: JSON.stringify({ t: "plain", v: original }) };
        let row: { version: number; value: Uint8Array | null } | null = { version: 3,
            value: new TextEncoder().encode(JSON.stringify({ t: "plain", v: fixture.value })) };
        // Persistent DB and at-rest environment are boundaries; real mode, row and history owners enforce proofs.
        const tx = { $queryRawUnsafe: async () => [{ id: "account-1" }], $executeRawUnsafe: async () => 1,
            account: { findUnique: async () => ({ publicKey: null, seq: 1, encryptionMode: "plain", contentPublicKey: null,
                contentPublicKeySig: null, settings: null, settingsVersion: 9 }) },
            userKVStore: { findUnique: async (input: { where: { accountId_key: { key: string } } }) =>
                input.where.accountId_key.key === fixture.physicalKey ? row : null },
            accountSettingsSnapshot: { findUnique: async () => snapshot,
                updateMany: async (input: { data: { settingsDbValue: string } }) => {
                    snapshot.settingsDbValue = input.data.settingsDbValue; return { count: 1 };
                } },
        } as unknown as TransactionClient;
        const candidate = { expectedSettingsVersion: 9, expectedProfileTransferRevision: "absent" as const,
            expectedEncryptionCurrentness: { mode: "plain" as const, signingKeyFingerprint: null, contentKeyFingerprint: null },
            expectedContent: { t: "plain" as const, v: original }, operation: { kind: "normalize" as const,
                removedRoots: [fixture.root], transferredPrivateCatalogRevisions: { [fixture.field]: 3 },
                content: { t: "plain" as const, v: normalized } } } satisfies Parameters<typeof mutateAccountSettingsHistorySnapshotInTx>[0]["mutation"];
        for (const value of [row!.value, null]) {
            row = { version: 3, value };
            snapshot.settingsDbValue = JSON.stringify(candidate.expectedContent);
            expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 4, mutation: candidate }))
                .toEqual({ status: "applied" });
            expect(JSON.parse(snapshot.settingsDbValue)).toEqual(candidate.operation.content);
        }
        snapshot.settingsDbValue = JSON.stringify(candidate.expectedContent);
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 4,
            mutation: { ...candidate, operation: { ...candidate.operation, transferredPrivateCatalogRevisions: { [fixture.field]: 2 } } } }))
            .toEqual({ status: "conflict" });
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 4,
            mutation: { ...candidate, operation: { ...candidate.operation,
                transferredPrivateCatalogRevisions: fixture.field === "connectedPurposes" ? { connectedConfigurations: 3 } : { connectedPurposes: 3 } } } }))
            .toEqual({ status: "invalid_content" });
        row = null;
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 4, mutation: candidate }))
            .toEqual({ status: "invalid_content" });
        for (const malformed of [fixture.malformed, { ...fixture.value,
            futureReference: { t: "savedSecret", secretId: formatSharedSavedSecretRefV1("unclassified-resource") } }]) {
            row = { version: 3, value: new TextEncoder().encode(JSON.stringify({ t: "plain", v: malformed })) };
            expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 4, mutation: candidate }))
                .toEqual({ status: "invalid_content" });
        }
        expect(snapshot.settingsDbValue).toBe(JSON.stringify(candidate.expectedContent));
    });
    it("refuses changed opaque history without destination cleanup proof while retaining a proofless no-op", async () => {
        const snapshot = { accountId: "account-1", version: 4, encryptionMode: "e2ee", contentKind: "encrypted",
            settingsDbValue: "recorded-private-ciphertext" };
        // Persistent DB boundary only: captured currentness, control admission and
        // exact-history semantics below are the real production owners.
        const tx = { $queryRawUnsafe: async () => [{ id: "account-1" }], $executeRawUnsafe: async () => 1,
            account: { findUnique: async () => ({ publicKey: null, seq: 1, encryptionMode: "plain", contentPublicKey: null,
                contentPublicKeySig: null, settings: null, settingsVersion: 9 }) },
            userKVStore: { findUnique: async () => null },
            accountSettingsSnapshot: { findUnique: async () => snapshot,
                updateMany: async (input: { data: { settingsDbValue: string } }) => {
                    snapshot.settingsDbValue = input.data.settingsDbValue; return { count: 1 };
                } },
        } as unknown as TransactionClient;
        const unchanged = { expectedSettingsVersion: 9, expectedProfileTransferRevision: "absent" as const,
            expectedEncryptionCurrentness: { mode: "plain" as const, signingKeyFingerprint: null, contentKeyFingerprint: null },
            expectedContent: { t: "encrypted" as const, c: "recorded-private-ciphertext" }, operation: {
                kind: "normalize" as const, removedRoots: [], content: { t: "encrypted" as const, c: "recorded-private-ciphertext" },
            } } satisfies Parameters<typeof mutateAccountSettingsHistorySnapshotInTx>[0]["mutation"];
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 4, mutation: unchanged }))
            .toEqual({ status: "unchanged" });
        const changed = { ...unchanged, operation: { ...unchanged.operation, content: { t: "encrypted" as const, c: "unproved-rewrite" } } };
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 4, mutation: changed }))
            .toEqual({ status: "invalid_content" });
        expect(snapshot.settingsDbValue).toBe("recorded-private-ciphertext");
    });
    it.each(["plain", "encrypted"] as const)("sanitizes recorded %s guidance only against actual current Role Artifact receipts", async kind => {
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST", "none");
        onTestFinished(() => { vi.unstubAllEnvs(); });
        const raw = { executionRunsGuidanceEnabled: true, executionRunsGuidanceEntries: [{ id: "legacy", description: "Retained role" }], preferredLanguage: "de" };
        const artifactId = readLegacyRolesV1(raw, "account-1")[0]!.artifactId;
        const original = kind === "plain" ? { t: "plain" as const, v: raw } : { t: "encrypted" as const, c: "recorded-guidance" };
        const normalized = kind === "plain" ? { t: "plain" as const, v: { preferredLanguage: "de" } } : { t: "encrypted" as const, c: "sanitized-guidance" };
        const snapshot = { accountId: "account-1", version: 4, encryptionMode: kind === "plain" ? "plain" : "e2ee",
            contentKind: kind, settingsDbValue: kind === "plain" ? JSON.stringify(original) : "recorded-guidance" };
        const originalStoredValue = snapshot.settingsDbValue;
        let retainedArtifact: { id: string; accountId: string; headerVersion: number; bodyVersion: number; deletedAt: Date | null } | null = {
            id: artifactId, accountId: "account-1", headerVersion: 2, bodyVersion: 3, deletedAt: null,
        };
        // Persistent DB only: history fences, strict request and proof admission run through their real owners.
        const tx = { $queryRawUnsafe: async () => [{ id: "account-1" }], $executeRawUnsafe: async () => 1,
            account: { findUnique: async () => ({ publicKey: null, seq: 1, encryptionMode: "plain", contentPublicKey: null,
                contentPublicKeySig: null, settings: null, settingsVersion: 9 }) },
            userKVStore: { findUnique: async () => null },
            artifact: { findUnique: async () => retainedArtifact },
            accountSettingsSnapshot: { findUnique: async () => snapshot,
                updateMany: async (input: { data: { settingsDbValue: string } }) => { snapshot.settingsDbValue = input.data.settingsDbValue; return { count: 1 }; } },
        } as unknown as TransactionClient;
        const candidate = { expectedSettingsVersion: 9, expectedProfileTransferRevision: "absent" as const,
            expectedEncryptionCurrentness: { mode: "plain" as const, signingKeyFingerprint: null, contentKeyFingerprint: null },
            expectedContent: original, operation: { kind: "normalize" as const,
                removedRoots: ["executionRunsGuidanceEntries", "executionRunsGuidanceEnabled"], content: normalized,
                legacyRoleArtifactTransfers: [{ artifactId, expectedRevision: { headerVersion: 2, bodyVersion: 3 } }] } };
        for (const expectedRevision of [{ headerVersion: 1, bodyVersion: 3 }, { headerVersion: 2, bodyVersion: 2 }]) {
            const stale = { ...candidate, operation: { ...candidate.operation,
                legacyRoleArtifactTransfers: [{ artifactId, expectedRevision }] } };
            expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 4, mutation: stale }))
                .toEqual({ status: "conflict" });
            expect(snapshot.settingsDbValue).toBe(originalStoredValue);
        }
        const currentArtifact = retainedArtifact;
        for (const unavailableArtifact of [null, { ...currentArtifact, deletedAt: new Date(1) }]) {
            retainedArtifact = unavailableArtifact;
            expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 4, mutation: candidate }))
                .toEqual({ status: "conflict" });
            expect(snapshot.settingsDbValue).toBe(originalStoredValue);
        }
        retainedArtifact = { ...currentArtifact, accountId: "another-account" };
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 4, mutation: candidate }))
            .toEqual({ status: "invalid_content" });
        expect(snapshot.settingsDbValue).toBe(originalStoredValue);
        retainedArtifact = currentArtifact;
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 4, mutation: candidate })).toEqual({ status: "applied" });
        expect(snapshot.settingsDbValue).toBe(kind === "plain" ? JSON.stringify(normalized) : "sanitized-guidance");
    });
    it("normalizes only actual prompt row authority without erasing untransferred Profile history", async () => {
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST", "none");
        onTestFinished(() => { vi.unstubAllEnvs(); });
        const original = { promptFoldersV1: { v: 1, folders: [{ id: "old", name: "Old" }] },
            promptStacksV1: { v: 1, surfaces: { coding: [], voice: [], profilesById: { private: [] } } },
            preferredLanguage: "de" };
        const normalized = { promptStacksV1: { v: 1, surfaces: { voice: [], profilesById: { private: [] } } }, preferredLanguage: "de" };
        const snapshot = { accountId: "account-1", version: 4,
            settingsDbValue: JSON.stringify({ t: "plain", v: original }), encryptionMode: "plain", contentKind: "plain" };
        // Only persistent DB and at-rest policy boundaries are replaced; mode, domain row and history validation are real.
        const tx = { $queryRawUnsafe: async () => [{ id: "account-1" }], $executeRawUnsafe: async () => 1,
            account: { findUnique: async () => ({ publicKey: null, seq: 1, encryptionMode: "plain", contentPublicKey: null,
                contentPublicKeySig: null, settings: null, settingsVersion: 9 }) },
            userKVStore: { findUnique: async (input: { where: { accountId_key: { key: string } } }) => {
                const key = input.where.accountId_key.key;
                return key === buildPromptLibraryPhysicalKeyV1("coding")
                    ? { version: 4, value: new TextEncoder().encode(JSON.stringify({ t: "plain", v: emptyPromptLibraryRecordV1("coding") })) }
                    : key === buildPromptLibraryPhysicalKeyV1("folders") ? { version: 5, value: null } : null;
            } },
            accountSettingsSnapshot: {
                findUnique: async () => snapshot,
                updateMany: async (input: { data: { settingsDbValue: string } }) => {
                    snapshot.settingsDbValue = input.data.settingsDbValue; return { count: 1 };
                },
            },
        } as unknown as TransactionClient;
        const mutation = { expectedSettingsVersion: 9, expectedProfileTransferRevision: "absent" as const,
            expectedEncryptionCurrentness: { mode: "plain" as const, signingKeyFingerprint: null, contentKeyFingerprint: null },
            expectedContent: { t: "plain" as const, v: original }, operation: { kind: "normalize" as const,
                removedRoots: ["promptFoldersV1"], transferredPromptLibraryKeys: ["coding", "folders"],
                content: { t: "plain" as const, v: normalized } } } satisfies Parameters<typeof mutateAccountSettingsHistorySnapshotInTx>[0]["mutation"];
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 4, mutation }))
            .toEqual({ status: "applied" });
        expect(JSON.parse(snapshot.settingsDbValue)).toEqual({ t: "plain", v: normalized });
    });
    it("fences an exact recorded snapshot and never purges an unaddressed encrypted version", async () => {
        // Server-at-rest policy is an environment boundary, not the mutation domain.
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST", "none");
        onTestFinished(() => { vi.unstubAllEnvs(); });
        const snapshots = [1, 2].map(version => ({ accountId: "account-1", version, settingsDbValue: `locked-${version}`,
            encryptionMode: "e2ee", contentKind: "encrypted" }));
        snapshots.push({ accountId: "account-1", version: 3, settingsDbValue: "unreadable-at-rest",
            encryptionMode: "plain", contentKind: "plain" });
        snapshots.push({ accountId: "account-1", version: 4, settingsDbValue: JSON.stringify({ t: "plain", v: { futurePreference: true } }),
            encryptionMode: "plain", contentKind: "plain" });
        type SnapshotWhere = Partial<(typeof snapshots)[number]>;
        const match = (snapshot: (typeof snapshots)[number], where: SnapshotWhere) => Object.entries(where)
            .every(([key, value]) => snapshot[key as keyof typeof snapshot] === value);
        const snapshotDelegate = {
            findUnique: async (input: { where: { accountId_version: { accountId: string; version: number } } }) =>
                snapshots.find(snapshot => match(snapshot, input.where.accountId_version)) ?? null,
            updateMany: async (input: { where: SnapshotWhere; data: Partial<(typeof snapshots)[number]> }) => {
                const selected = snapshots.filter(snapshot => match(snapshot, input.where));
                selected.forEach(snapshot => Object.assign(snapshot, input.data));
                return { count: selected.length };
            },
            deleteMany: async (input: { where: SnapshotWhere }) => {
                const selected = snapshots.filter(snapshot => match(snapshot, input.where));
                selected.forEach(snapshot => snapshots.splice(snapshots.indexOf(snapshot), 1));
                return { count: selected.length };
            },
        };
        // Persistent database boundary only; the real Account-mode fence and history owner run below it.
        const tx = { $queryRawUnsafe: async () => [{ id: "account-1" }], $executeRawUnsafe: async () => 1,
            userKVStore: { findUnique: async () => ({ version: 2, value: new TextEncoder().encode(JSON.stringify({ t: "plain", v: {
                v: 1, phase: "active", sourceSettingsVersion: 8, migratedLogicalRevision: 1, inventory: [],
            } })) }) },
            account: { findUnique: async () => ({ publicKey: null, seq: 1, encryptionMode: "plain", contentPublicKey: null,
                contentPublicKeySig: null, settings: null, settingsVersion: 9 }) }, accountSettingsSnapshot: snapshotDelegate,
        } as unknown as TransactionClient;
        const captured = { expectedSettingsVersion: 9, expectedProfileTransferRevision: 2, expectedEncryptionCurrentness: {
            mode: "plain" as const, signingKeyFingerprint: null, contentKeyFingerprint: null,
        }, expectedContent: { t: "encrypted" as const, c: "locked-1" }, operation: {
            kind: "normalize" as const, removedRoots: ["profiles", "secretBindingsByProfileId"], transferredProfileIds: [],
            content: { t: "encrypted" as const, c: "normalized-1" },
        } };
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 1,
            mutation: { ...captured, expectedEncryptionCurrentness: { ...captured.expectedEncryptionCurrentness, contentKeyFingerprint: "stale-key" } },
        })).toEqual({ status: "conflict" });
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 1,
            mutation: { ...captured, expectedProfileTransferRevision: 1 },
        })).toEqual({ status: "conflict" });
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 1,
            mutation: { ...captured, expectedSettingsVersion: 8 } })).toEqual({ status: "conflict" });
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 1, mutation: captured })).toEqual({ status: "applied" });
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 1, mutation: captured })).toEqual({ status: "conflict" });
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 4,
            mutation: { ...captured, expectedContent: { t: "plain", v: { futurePreference: true } },
                operation: { kind: "normalize", removedRoots: ["futurePreference"], content: { t: "plain", v: {} } } },
        })).toEqual({ status: "invalid_content" });
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 3,
            mutation: { ...captured, expectedContent: undefined, expectedSettingsVersion: 8, operation: { kind: "purge" } },
        })).toEqual({ status: "conflict" });
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 3,
            mutation: { ...captured, expectedContent: undefined, operation: { kind: "purge" } },
        })).toEqual({ status: "applied" });
        expect(await mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: "account-1", version: 2,
            mutation: { ...captured, expectedContent: { t: "encrypted", c: "locked-2" }, operation: { kind: "purge" } },
        })).toEqual({ status: "applied" });
        expect(snapshots).toEqual([
            { accountId: "account-1", version: 1, settingsDbValue: "normalized-1", encryptionMode: "e2ee", contentKind: "encrypted" },
            { accountId: "account-1", version: 4, settingsDbValue: JSON.stringify({ t: "plain", v: { futurePreference: true } }), encryptionMode: "plain", contentKind: "plain" },
        ]);
    });
  it("prunes oldest stored envelopes until the 16 MiB cap holds even below the count ceiling", async () => {
        const envelopeBytes = 512 * 1024;
        const storedEnvelope = "x".repeat(envelopeBytes);
        const fixture = createHistoryTransaction(
            Array.from({ length: 32 }, (_, index): Snapshot => ({
                id: `snapshot-${index + 1}`,
                accountId: "account-1",
                version: index + 1,
                createdAt: new Date(index + 1),
                settingsDbValue: storedEnvelope,
            })),
        );

        await recordAccountSettingsSnapshotsForWrite({
            tx: fixture.tx,
            previous: {
                accountId: "account-1",
                version: 33,
                settingsDbValue: storedEnvelope,
                encryptionMode: "e2ee",
            },
            next: {
                accountId: "account-1",
                version: 34,
                settingsDbValue: storedEnvelope,
                encryptionMode: "e2ee",
            },
            env: { HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: "250" },
        });

        expect(fixture.snapshots.map((snapshot) => snapshot.version).sort((left, right) => left - right))
            .toEqual(Array.from({ length: 32 }, (_, index) => index + 3));
        expect(fixture.snapshots.reduce(
            (total, snapshot) => total + Buffer.byteLength(snapshot.settingsDbValue ?? "", "utf8"),
            0,
        )).toBe(16 * 1024 * 1024);
    });

    it("prunes a contiguous oldest-first suffix when a middle snapshot exceeds the byte ceiling", async () => {
        const fixture = createHistoryTransaction([
            {
                id: "snapshot-1",
                accountId: "account-1",
                version: 1,
                createdAt: new Date(1),
                settingsDbValue: "oldest-small",
            },
            {
                id: "snapshot-2",
                accountId: "account-1",
                version: 2,
                createdAt: new Date(2),
                settingsDbValue: "x".repeat(ACCOUNT_SETTINGS_HISTORY_MAX_AGGREGATE_BYTES),
            },
        ]);

        await recordAccountSettingsSnapshotsForWrite({
            tx: fixture.tx,
            previous: {
                accountId: "account-1",
                version: 3,
                settingsDbValue: "newer-previous",
                encryptionMode: "e2ee",
            },
            next: {
                accountId: "account-1",
                version: 4,
                settingsDbValue: "newest-current",
                encryptionMode: "e2ee",
            },
            env: { HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: "250" },
        });

        expect(fixture.snapshots.map((snapshot) => snapshot.version).sort((left, right) => left - right))
            .toEqual([3, 4]);
    });
});
