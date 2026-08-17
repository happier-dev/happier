import { describe, expect, it } from "vitest";

import {
    artifactClassificationFromRelations,
    artifactOrdinaryWhere,
} from "./artifactClassification";

describe("Artifact classification", () => {
    it("treats both UI and package-release links as one protected plugin classification", () => {
        expect(artifactClassificationFromRelations({
            pluginUiArtifact: {
                release: { accountId: "account-1", pluginId: "com.acme.ui" },
            },
            packageAssetRelease: null,
        })).toEqual({
            kind: "plugin",
            pluginId: "com.acme.ui",
        });

        expect(artifactClassificationFromRelations({
            pluginUiArtifact: null,
            packageAssetRelease: { accountId: "account-1", pluginId: "com.acme.assets" },
        })).toEqual({
            kind: "plugin",
            pluginId: "com.acme.assets",
        });

        expect(artifactClassificationFromRelations({
            pluginUiArtifact: null,
            packageAssetRelease: null,
        })).toEqual({ kind: "ordinary" });
        expect(artifactOrdinaryWhere).toEqual({
            pluginUiArtifact: { is: null },
            packageAssetRelease: { is: null },
        });
    });

    it("fails closed for corrupt dual or cross-Account classification links", () => {
        expect(artifactClassificationFromRelations({
            pluginUiArtifact: {
                release: { accountId: "account-1", pluginId: "com.acme.ui" },
            },
            packageAssetRelease: { accountId: "account-1", pluginId: "com.acme.assets" },
        })).toEqual({ kind: "invalid" });

        expect(artifactClassificationFromRelations({
            pluginUiArtifact: {
                release: { accountId: "other-account", pluginId: "com.acme.ui" },
            },
            packageAssetRelease: null,
        }, "account-1")).toEqual({ kind: "invalid" });
    });
});
