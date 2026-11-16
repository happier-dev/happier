import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PluginManifestV2Schema } from "@happier-dev/protocol/plugins/manifest/v2";

// The OS allocator is the boundary: count trims, never call glibc from the test.
const trimNativeHeap = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/utils/runtime/nativeHeapTrim", () => ({ trimNativeHeap }));

const { db } = await import("@/storage/db");
const { createLightSqliteHarness } = await import("@/testkit/lightSqliteHarness");
const { createPluginAvailabilityOperations } = await import("./operations");
const { createReleaseLessDeclarationV1 } = await import("./currentDeclaration");

const operations = createPluginAvailabilityOperations({ resolveHostingCapability: () => ({ enabled: false }) });
const manifest = (pluginId: string) => PluginManifestV2Schema.parse({ schemaVersion: 2, id: pluginId, version: "1.0.0",
    displayName: "Trim", engines: { happier: "^1.0.0" }, contributes: {} });

describe("native heap return after a daemon's manifest claim burst", () => {
    let harness: Awaited<ReturnType<typeof createLightSqliteHarness>>;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-claim-heap-trim-", initAuth: false, initFiles: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it("trims once when concurrent manifest claims settle, never for digest-only rejoins", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const publisher = { machineId: "trim-machine", installationId: "trim-installation" };
        const pluginIds = ["com.acme.trim-a", "com.acme.trim-b", "com.acme.trim-c"];
        trimNativeHeap.mockClear();
        await Promise.all(pluginIds.map(pluginId => operations.claimCollectionWriters({ accountId: account.id,
            input: { manifest: manifest(pluginId) }, publisher })));
        expect(trimNativeHeap).toHaveBeenCalledTimes(1);

        await Promise.all(pluginIds.map(pluginId => operations.claimCollectionWriters({ accountId: account.id,
            input: { pluginId, manifestDigestSha256: createReleaseLessDeclarationV1(manifest(pluginId)).manifestDigestSha256 }, publisher })));
        expect(trimNativeHeap).toHaveBeenCalledTimes(1);

        // A refused manifest claim still settles the burst.
        await operations.claimCollectionWriters({ accountId: account.id, input: { manifest: manifest(pluginIds[0]!) },
            publisher }).catch(() => undefined);
        expect(trimNativeHeap).toHaveBeenCalledTimes(2);
    });
});
