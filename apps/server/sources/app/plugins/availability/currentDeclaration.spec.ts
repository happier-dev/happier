import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PluginManifestV2Schema } from "@happier-dev/protocol/plugins/manifest/v2";

import { createReleaseLessDeclarationV1, readCurrentReleaseLessDeclarationV1, resolveCurrentPluginDeclarationTx } from "./currentDeclaration";
import type { Tx } from "@/storage/inTx";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";

function declaration() {
    return createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({
        schemaVersion: 2,
        id: "com.example.external",
        version: "1.2.3",
        displayName: "External plugin",
        engines: { happier: "^1.0.0" },
        runtime: { apiVersion: 1 },
        contributes: {},
    }));
}

describe("server-owned plugin declarations", () => {
    beforeAll(() => { initDbPostgres(); });
    afterAll(async () => { await db.$disconnect(); });

    it.each([false, true])("reuses an admitted declaration without fetching its body (portable: %s)", async portable => {
        const stored = declaration();
        const admittedDeclaration = { manifest: stored.manifest, declarationDigestSha256: stored.manifestDigestSha256 };
        const intent = { pluginId: stored.manifest.id, enabled: true, desiredVersion: portable ? stored.manifest.version : null,
            releaseLessDeclaration: stored };
        let archiveDigestSha256 = stored.manifestDigestSha256;
        let bodyReads = 0;
        // The persistent database is the boundary; keep declaration selection and parsing real.
        const tx = {
            $queryRaw: async () => {
                bodyReads++;
                return bodyReads === 1 ? [intent] : [{ key: "0", manifest: getDbProviderFromEnv(process.env, "postgres") === "sqlite"
                    ? JSON.stringify(stored.manifest) : stored.manifest }];
            },
            accountPluginRelease: { findMany: async (args: { select: { normalizedManifest?: boolean } }) => {
                if (args.select.normalizedManifest) bodyReads++;
                return [{ pluginId: stored.manifest.id, version: stored.manifest.version,
                    archiveDigestSha256,
                    ...(args.select.normalizedManifest ? { normalizedManifest: stored.manifest } : {}) }];
            } },
        } as unknown as Tx;
        const read = () => resolveCurrentPluginDeclarationTx({ tx, accountId: "account", pluginId: stored.manifest.id,
            version: stored.manifest.version, admittedDeclaration });
        const result = await read();
        expect(bodyReads).toBe(1); // One identity query, no release-less or release body transfer.
        expect(result).toBe(admittedDeclaration);
        bodyReads = 0;
        intent.enabled = false;
        expect(await read()).toBeNull();
        expect(bodyReads).toBe(1);
        bodyReads = 0;
        intent.enabled = true;
        intent.desiredVersion = "2.0.0";
        expect(await read()).toBeNull();
        bodyReads = 0;
        intent.desiredVersion = portable ? stored.manifest.version : null;
        const replacement = createReleaseLessDeclarationV1({ ...stored.manifest, displayName: "Replacement declaration" });
        archiveDigestSha256 = replacement.manifestDigestSha256;
        intent.releaseLessDeclaration = replacement;
        expect(await read()).toBeNull();
        expect(bodyReads).toBe(1);
    });

    it("reads the admitted body without repeating manifest validation", () => {
        const stored = declaration();
        const parse = vi.spyOn(PluginManifestV2Schema, "safeParse");
        try {
            for (let read = 0; read < 5; read++) {
                expect(readCurrentReleaseLessDeclarationV1({ desiredVersion: null, releaseLessDeclaration: stored },
                    stored.manifest.id)).toEqual(stored);
            }
            expect(parse).not.toHaveBeenCalled();
        } finally {
            parse.mockRestore();
        }
    });

    it("refuses invalid identifying envelopes and defers to an explicit release selection", () => {
        const stored = declaration();
        const read = (releaseLessDeclaration: unknown, desiredVersion: string | null = null) => (
            readCurrentReleaseLessDeclarationV1({ desiredVersion, releaseLessDeclaration }, stored.manifest.id)
        );
        expect(read(stored, "1.2.3")).toBeNull();
        expect(read(null)).toBeNull();
        expect(read({ ...stored, manifestDigestSha256: "invalid" })).toBeNull();
        expect(read({ ...stored, manifest: { ...stored.manifest, id: "com.example.other" } })).toBeNull();
        expect(read({ ...stored, manifest: { ...stored.manifest, version: 7 } })).toBeNull();
        expect(read({ ...stored, manifest: { ...stored.manifest, schemaVersion: 1 } })).toBeNull();
    });
});
