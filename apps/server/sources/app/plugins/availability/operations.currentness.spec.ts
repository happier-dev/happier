import { beforeEach, describe, expect, it, vi } from "vitest";

const accountId = "account-availability-currentness";
const pluginId = "com.acme.currentness";

function materializationRow(input: Readonly<{
    machineId: string;
    materializationId: string;
    archiveDigestSha256: string;
}>) {
    return {
        serverIdentityId: "srv_availability_currentness",
        machineId: input.machineId,
        materializationId: input.materializationId,
        pluginId,
        version: "1.2.3",
        sourceClass: "registryPackage",
        portableRelease: true,
        archiveDigestSha256: input.archiveDigestSha256,
        uiArtifacts: [],
        enabled: true,
        trustState: "trusted",
        observedAt: new Date(0),
    };
}

function releaseRow(input: Readonly<{
    artifactId: string;
    archiveDigestSha256: string;
    artifactDigest: string;
    displayName: string;
}>) {
    return {
        id: `release-${input.displayName}`,
        accountId,
        pluginId,
        version: "1.2.3",
        archiveDigestSha256: input.archiveDigestSha256,
        normalizedManifest: {
            schemaVersion: 2,
            id: pluginId,
            version: "1.2.3",
            displayName: input.displayName,
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            contributes: {},
        },
        collectionContracts: [],
        uiSlots: [{
            contributionId: "hosted",
            tier: "hostedWeb",
            platform: "web",
            artifactDigest: input.artifactDigest,
            compatibility: {
                hostUiApiVersion: "1.0.0",
            },
        }],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"c".repeat(64)}`,
            resources: [],
        },
        uiArtifacts: [{
            contributionId: "hosted",
            tier: "hostedWeb",
            platform: "web",
            artifactId: input.artifactId,
            artifactDigest: input.artifactDigest,
            compatibility: {
                hostAppVersion: "1.0.0",
                hostUiApiVersion: "1.0.0",
                reactVersion: "19.2.0",
                platform: "web",
                channel: "store",
                nativeCapabilities: [],
            },
            release: { accountId, pluginId, version: "1.2.3" },
        }],
    };
}

const boundary = vi.hoisted(() => {
    const directDb = {
        account: { findUnique: vi.fn() },
        accountPluginIntent: { findUnique: vi.fn() },
        accountPluginRelease: { findUnique: vi.fn() },
        machine: { findMany: vi.fn() },
    };
    const transactionSnapshot = {
        account: { findUnique: vi.fn() },
        accountPluginIntent: { findUnique: vi.fn() },
        accountPluginRelease: { findUnique: vi.fn() },
        machine: { findMany: vi.fn() },
    };
    return { directDb, transactionSnapshot };
});

vi.mock("@/storage/db", () => ({
    db: boundary.directDb,
    isPrismaErrorCode: () => false,
}));

vi.mock("@/storage/inTx", () => ({
    inTx: async <T>(run: (tx: typeof boundary.transactionSnapshot) => Promise<T>): Promise<T> => (
        await run(boundary.transactionSnapshot)
    ),
}));

import { createPluginAvailabilityOperations } from "./operations";

describe("plugin Availability read currentness", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        // This direct boundary simulates a request that observes an Account
        // cursor before a concurrent Availability commit and the row after it.
        boundary.directDb.account.findUnique.mockResolvedValue({ seq: 7 });
        boundary.directDb.accountPluginIntent.findUnique.mockResolvedValue({
            pluginId,
            desiredVersion: "1.2.3",
            enabled: false,
            offlineUiHosting: "disabled",
            writableCollections: [],
            revision: BigInt(1),
        });
        boundary.directDb.accountPluginRelease.findUnique.mockResolvedValue(releaseRow({
            artifactId: "00000000-0000-4000-8000-000000000007",
            archiveDigestSha256: `sha256:${"7".repeat(64)}`,
            artifactDigest: `sha256:${"7".repeat(64)}`,
            displayName: "Direct snapshot",
        }));
        boundary.directDb.machine.findMany.mockResolvedValue([{
            id: "machine-direct",
            pluginMaterializationRevision: BigInt(7),
            pluginMaterializations: [materializationRow({
                machineId: "machine-direct",
                materializationId: "materialization-direct",
                archiveDigestSha256: `sha256:${"7".repeat(64)}`,
            })],
        }]);

        // A database transaction must instead return one committed snapshot.
        boundary.transactionSnapshot.account.findUnique.mockResolvedValue({ seq: 8 });
        boundary.transactionSnapshot.accountPluginIntent.findUnique.mockResolvedValue({
            pluginId,
            desiredVersion: "1.2.3",
            enabled: true,
            offlineUiHosting: "disabled",
            writableCollections: [],
            revision: BigInt(2),
        });
        boundary.transactionSnapshot.accountPluginRelease.findUnique.mockResolvedValue(releaseRow({
            artifactId: "00000000-0000-4000-8000-000000000008",
            archiveDigestSha256: `sha256:${"8".repeat(64)}`,
            artifactDigest: `sha256:${"8".repeat(64)}`,
            displayName: "Transaction snapshot",
        }));
        boundary.transactionSnapshot.machine.findMany.mockResolvedValue([{
            id: "machine-transaction",
            pluginMaterializationRevision: BigInt(8),
            pluginMaterializations: [materializationRow({
                machineId: "machine-transaction",
                materializationId: "materialization-transaction",
                archiveDigestSha256: `sha256:${"8".repeat(64)}`,
            })],
        }]);
    });

    it("pairs intent and materialization facts with one committed Availability cursor", async () => {
        const operations = createPluginAvailabilityOperations({
            resolveHostingCapability: () => ({ enabled: false }),
            resolveServerIdentityId: async () => "srv_availability_currentness",
        });

        const [intent, materializations] = await Promise.all([
            operations.readIntent({
                accountId,
                input: { pluginId },
            }),
            operations.readMaterializations({
                accountId,
                input: {},
            }),
        ]);

        expect(intent).toMatchObject({
            availabilityCursor: 8,
            intent: { pluginId, enabled: true, revision: "2" },
            release: {
                archiveDigestSha256: `sha256:${"8".repeat(64)}`,
                normalizedManifest: { displayName: "Transaction snapshot" },
            },
            uiArtifacts: [{
                artifactId: "00000000-0000-4000-8000-000000000008",
            }],
        });
        expect(materializations).toMatchObject({
            availabilityCursor: 8,
            snapshots: [{
                machineId: "machine-transaction",
                revision: 8,
                materializations: [{
                    materializationId: "materialization-transaction",
                    archiveDigestSha256: `sha256:${"8".repeat(64)}`,
                }],
            }],
        });
    });
});
