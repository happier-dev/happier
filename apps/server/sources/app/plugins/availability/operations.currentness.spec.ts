import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent,
    PluginAvailabilityActionHttpPathsV1,
} from "@happier-dev/protocol";
import { createPackageAssetArchiveV1, encodePackageAssetArchiveBodyV1 } from "@happier-dev/protocol/plugins/availability";
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    createPluginUiArtifactArchiveV1,
    encodePluginUiArtifactArchiveBodyV1,
} from "@happier-dev/protocol/plugins/ui";
import * as privacyKit from "privacy-kit";
import { createInTxHarness } from "@/app/api/testkit/txHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

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
            artifactId: "hosted",
            tier: "hostedWeb",
            platform: "web",
            artifactDigest: input.artifactDigest,
            hostUiApiRange: "^1.0.0",
        }],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"c".repeat(64)}`,
            resources: [],
        },
        packageAssetArtifactId: null,
        packageAssetArtifact: null,
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
        accountPluginUiArtifact: { findUnique: vi.fn() },
        artifact: { findUnique: vi.fn() },
        machine: { findMany: vi.fn() },
    };
    const transactionSnapshot = {
        account: { findUnique: vi.fn() },
        accountPluginIntent: { findUnique: vi.fn() },
        accountPluginRelease: { findUnique: vi.fn() },
        accountPluginUiArtifact: { findUnique: vi.fn() },
        artifact: { findUnique: vi.fn() },
        machine: { findMany: vi.fn() },
    };
    return { directDb, transactionSnapshot };
});

vi.mock("@/storage/db", () => ({
    db: boundary.directDb,
    isPrismaErrorCode: () => false,
}));

vi.mock("@/storage/inTx", () => createInTxHarness(() => boundary.transactionSnapshot));

import { createPluginAvailabilityOperations } from "./operations";
import { registerPluginAvailabilityRoutes } from "./routes";

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
                artifactId: "hosted",
                accountArtifactId: "00000000-0000-4000-8000-000000000008",
            }],
        });
        expect(materializations).toMatchObject({
            availabilityCursor: 8,
            snapshots: [{
                machineId: "machine-transaction",
                materializations: [{
                    materializationId: "materialization-transaction",
                    archiveDigestSha256: `sha256:${"8".repeat(64)}`,
                }],
            }],
        });
    });
});

function currentHostedArchiveFixture() {
    const files = [{
        relativePath: "hosted-web/hosted/index.html",
        bytes: new TextEncoder().encode("<main>Current archive</main>"),
    }];
    const graph = {
        artifactId: "hosted",
        tier: "hostedWeb" as const,
        entry: files[0]!.relativePath,
        files: files.map((file) => ({
            relativePath: file.relativePath,
            digest: computePluginUiArtifactSha256DigestV1(file.bytes),
            byteSize: file.bytes.byteLength,
        })),
        digest: computePluginUiArtifactFileSetSha256DigestV1(files),
        builtWith: { staging: "staticDirectory" as const },
        hostUiApiRange: "^1.0.0",
    };
    const uiArchive = createPluginUiArtifactArchiveV1({ pluginId, artifactGraph: graph, files });
    const release = releaseRow({
        artifactId: "00000000-0000-4000-8000-000000000001",
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        artifactDigest: graph.digest,
        displayName: "Current hosted archives",
    });
    const manifest = {
        ...release.normalizedManifest,
        contributes: { resources: [{
            id: "brand-icon", kind: "asset", path: "assets/brand.png", contentType: "image/png",
        }] },
    };
    const packageArchive = createPackageAssetArchiveV1({
        manifest,
        files: [{ path: "assets/brand.png", bytes: new Uint8Array([137, 80, 78, 71]) }],
    });
    if (!uiArchive || !packageArchive) throw new Error("Expected current hosted archive fixture");
    const uiEnvelope = {
        header: encodePlainArtifactStoredContent(uiArchive.header),
        body: encodePlainArtifactStoredContent({ body: encodePluginUiArtifactArchiveBodyV1(uiArchive.body) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    };
    const packageEnvelope = {
        header: encodePlainArtifactStoredContent(packageArchive.header),
        body: encodePlainArtifactStoredContent({ body: encodePackageAssetArchiveBodyV1(packageArchive.body) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    };
    const storedArtifact = (id: string, envelope: typeof uiEnvelope) => ({
        id, accountId,
        header: privacyKit.decodeBase64(envelope.header), headerVersion: 1,
        body: privacyKit.decodeBase64(envelope.body), bodyVersion: 1,
        dataEncryptionKey: privacyKit.decodeBase64(envelope.dataEncryptionKey), seq: 0,
    });
    const uiArtifact = storedArtifact(release.uiArtifacts[0]!.artifactId, uiEnvelope);
    const packageArtifact = storedArtifact("00000000-0000-4000-8000-000000000002", packageEnvelope);
    const qualifiedRelease = {
        ...release,
        normalizedManifest: manifest,
        packageAssetArchive: packageArchive.descriptor,
        packageAssetArtifactId: packageArtifact.id,
        packageAssetArtifact: packageArtifact,
    };
    const foreignAccountId = "account-availability-foreign";
    type AccountRow = Readonly<{
        encryptionMode: "plain" | "e2ee";
        publicKey: string | null;
        contentPublicKey: string | null;
        contentPublicKeySig: string | null;
        seq: number;
    }>;
    let owner: AccountRow = {
        encryptionMode: "plain", publicKey: null, contentPublicKey: null, contentPublicKeySig: null, seq: 8,
    };
    const foreign: AccountRow = { ...owner };
    // Only persistent reads are simulated. Archive, Account-mode, currentness,
    // rejoin, hosting-policy and HTTP admission logic all run through their owners.
    for (const database of [boundary.directDb, boundary.transactionSnapshot]) {
        database.account.findUnique.mockImplementation(async (query: { where: { id: string } }) => (
            query.where.id === accountId ? owner : query.where.id === foreignAccountId ? foreign : null
        ));
        database.accountPluginRelease.findUnique.mockImplementation(async (query: { where: {
            id?: string;
            accountId_pluginId_version?: { accountId: string; pluginId: string; version: string };
        } }) => {
            const coordinate = query.where.accountId_pluginId_version;
            return query.where.id === qualifiedRelease.id || (
                coordinate?.accountId === accountId
                && coordinate.pluginId === pluginId
                && coordinate.version === qualifiedRelease.version
            ) ? qualifiedRelease : null;
        });
        database.accountPluginIntent.findUnique.mockResolvedValue({
            pluginId, desiredVersion: qualifiedRelease.version, enabled: true,
            offlineUiHosting: "enabled", writableCollections: [], revision: 1n,
        });
        database.accountPluginUiArtifact.findUnique.mockResolvedValue({
            ...qualifiedRelease.uiArtifacts[0], artifact: uiArtifact,
        });
        database.artifact.findUnique.mockImplementation(async (query: { where: { id: string } }) => (
            query.where.id === uiArtifact.id ? uiArtifact : query.where.id === packageArtifact.id ? packageArtifact : null
        ));
    }
    return {
        release: { pluginId, version: qualifiedRelease.version },
        slot: qualifiedRelease.uiSlots[0]!,
        uiArtifact, packageArtifact, uiEnvelope, packageEnvelope, foreignAccountId,
        changeOwnerMode() {
            const binding = createSignedAccountContentBinding();
            owner = { ...owner, publicKey: binding.publicKey,
                contentPublicKey: privacyKit.encodeBase64(binding.contentPublicKey),
                contentPublicKeySig: privacyKit.encodeBase64(binding.contentPublicKeySig), encryptionMode: "e2ee" };
        },
    };
}

describe("plugin Availability hosted Artifact current transport", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.stubEnv("HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__ENABLED", "1");
        vi.stubEnv("HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES", "1048576");
        vi.stubEnv("HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES", "4194304");
    });
    afterEach(() => vi.unstubAllEnvs());

    it.each(["ui", "packageAsset"] as const)(
        "rejoins and publicly reads a current plain %s archive without a declaration, retaining Account and mode admission",
        async (kind) => {
            const fixture = currentHostedArchiveFixture();
            const operations = createPluginAvailabilityOperations();
            const freshArtifactId = "00000000-0000-4000-8000-000000000099";
            const rejoined = kind === "ui"
                ? await operations.publishUiArtifact({ accountId, input: {
                    release: fixture.release, slot: fixture.slot,
                    accountArtifactId: freshArtifactId, artifact: fixture.uiEnvelope,
                } })
                : await operations.publishPackageAsset({ accountId, input: {
                    release: fixture.release, artifactId: freshArtifactId, artifact: fixture.packageEnvelope,
                } });
            expect(rejoined).toMatchObject({ outcome: "rejoined", link: kind === "ui"
                ? { accountArtifactId: fixture.uiArtifact.id } : { artifactId: fixture.packageArtifact.id } });
            const path = PluginAvailabilityActionHttpPathsV1[kind === "ui"
                ? "account.plugins.availability.uiArtifact.read" : "account.plugins.availability.packageAsset.read"];
            const payload = kind === "ui"
                ? { release: fixture.release, contributionId: fixture.slot.contributionId,
                    artifactId: fixture.slot.artifactId, tier: fixture.slot.tier, platform: fixture.slot.platform }
                : { release: fixture.release };
            await withAuthenticatedTestApp((app) => registerPluginAvailabilityRoutes(app, { operations }), async (app) => {
                const read = (userId: string) => app.inject({ method: "POST", url: path,
                    headers: { "x-test-user-id": userId }, payload });
                const response = await read(accountId);
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ artifact: kind === "ui" ? fixture.uiEnvelope : fixture.packageEnvelope });
                expect((await read(fixture.foreignAccountId)).statusCode).toBe(404);
                fixture.changeOwnerMode();
                const wrongMode = await read(accountId);
                expect(wrongMode.statusCode).toBe(400);
                expect(wrongMode.json()).toEqual({ error: kind === "ui"
                    ? "plugin_ui_artifact_invalid_content" : "plugin_package_asset_invalid_content" });
            });
        },
    );
});
