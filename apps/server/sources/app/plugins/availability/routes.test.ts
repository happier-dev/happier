import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent,
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentSetActionInputV1Schema,
    PluginAvailabilityMaterializationsReportActionInputV1Schema,
    PluginAvailabilityPackageAssetReadActionOutputV1Schema,
    PluginAvailabilityReleaseReadActionInputV1Schema,
    PluginAvailabilityReleaseReadActionOutputV1Schema,
    PluginAvailabilityReleasePublishActionInputV1Schema,
    PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1Schema,
    type PluginAccountPluginUiArtifactLinkV1,
    type PluginAccountPluginPackageAssetLinkV1,
} from "@happier-dev/protocol";
import { createFakeRouteApp } from "@/app/api/testkit/routeHarness";

import { registerPluginAvailabilityRoutes } from "./routes";
import {
    PluginAvailabilityOperationError,
    type PluginAvailabilityOperations,
} from "./operations";

const publisherProofMock = vi.hoisted(() => ({
    verify: vi.fn(),
}));

vi.mock("@/app/plugins/installations/publisherProof", () => ({
    PluginInstallationPublisherProofError: class PluginInstallationPublisherProofError extends Error {},
    verifyPluginInstallationPublisherHeader: publisherProofMock.verify,
}));

const releasePublishInput = {
    facts: {
        ref: { pluginId: "com.acme.fixture", version: "1.2.3" },
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        normalizedManifest: {
            schemaVersion: 2,
            id: "com.acme.fixture",
            version: "1.2.3",
            displayName: "Fixture",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            contributes: {},
        },
        collectionContracts: [],
        uiSlots: [],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"c".repeat(64)}`,
            resources: [],
        },
    },
    sourceClass: "registryPackage",
} as const;

const materializationsReportInput = {
    snapshot: {
        serverIdentityId: "srv_availabilityRouteFixture",
        machineId: "machine-route-fixture",
        revision: 1,
        materializations: [],
    },
} as const;

const uiArtifactLink: PluginAccountPluginUiArtifactLinkV1 = {
    release: releasePublishInput.facts.ref,
    contributionId: "hosted",
    tier: "hostedWeb" as const,
    platform: "web" as const,
    artifactId: "00000000-0000-4000-8000-000000000001",
    artifactDigest: `sha256:${"b".repeat(64)}`,
    compatibility: {
        hostAppVersion: "1.0.0",
        hostUiApiVersion: "1.0.0",
        reactVersion: "19.2.0",
        platform: "web" as const,
        channel: "store" as const,
        nativeCapabilities: [],
    },
};

const packageAssetLink: PluginAccountPluginPackageAssetLinkV1 = {
    release: releasePublishInput.facts.ref,
    artifactId: "00000000-0000-4000-8000-000000000002",
    descriptor: {
        ...releasePublishInput.facts.packageAssetArchive,
        resources: [],
    },
};

const uiArtifactSlot = {
    contributionId: uiArtifactLink.contributionId,
    tier: uiArtifactLink.tier,
    platform: uiArtifactLink.platform,
    artifactDigest: uiArtifactLink.artifactDigest,
    compatibility: {
        hostUiApiVersion: uiArtifactLink.compatibility.hostUiApiVersion,
    },
};

const uiArtifactReadInput = {
    release: releasePublishInput.facts.ref,
    contributionId: uiArtifactLink.contributionId,
    tier: uiArtifactLink.tier,
    platform: uiArtifactLink.platform,
} as const;

const uiArtifactBrowserFrameIssueInput = {
    ...uiArtifactReadInput,
    expectedArtifactDigest: uiArtifactLink.artifactDigest,
} as const;

const browserArtifactCapabilityRoutePath =
    "/v1/plugins/availability/ui-artifacts/browser/:capability/*";

type BrowserArtifactRouteOperations = PluginAvailabilityOperations & Readonly<{
    readBrowserArtifactFrame: ReturnType<typeof vi.fn>;
}>;

function createOperations(): BrowserArtifactRouteOperations {
    return {
        readRelease: vi.fn(async () => PluginAvailabilityReleaseReadActionOutputV1Schema.parse({
            availabilityCursor: 0,
            facts: releasePublishInput.facts,
        })),
        publishRelease: vi.fn(async ({ input }) => ({
            facts: PluginAvailabilityReleasePublishActionInputV1Schema.parse(input).facts,
            outcome: "created" as const,
        })),
        reportMaterializations: vi.fn(async ({ input }) => ({
            snapshot: PluginAvailabilityMaterializationsReportActionInputV1Schema.parse(input).snapshot,
            outcome: "replaced" as const,
        })),
        readMaterializations: vi.fn(async () => ({ availabilityCursor: 0, snapshots: [] })),
        readIntent: vi.fn(async () => ({
            availabilityCursor: 0,
            hostingCapability: { enabled: false } as const,
            intent: null,
            release: null,
            uiArtifacts: [],
        })),
        listIntentIds: vi.fn(async () => ({
            availabilityCursor: 0,
            pluginIds: [],
        })),
        setIntent: vi.fn(async ({ input }) => {
            const parsed = PluginAvailabilityIntentSetActionInputV1Schema.parse(input);
            return {
                intent: {
                    pluginId: parsed.pluginId,
                    desiredVersion: parsed.desiredVersion,
                    enabled: parsed.enabled,
                    offlineUiHosting: parsed.offlineUiHosting,
                    writableCollections: parsed.writableCollections,
                    revision: "0",
                },
            };
        }),
        publishUiArtifact: vi.fn(async () => ({
            outcome: "created" as const,
            link: uiArtifactLink,
        })),
        readUiArtifact: vi.fn(async () => ({
            link: uiArtifactLink,
            artifact: {
                header: encodePlainArtifactStoredContent({ title: "Hosted" }),
                headerVersion: 1,
                body: encodePlainArtifactStoredContent({ archive: "fixture" }),
                bodyVersion: 1,
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                seq: 0,
            },
        })),
        publishPackageAsset: vi.fn(async () => ({
            outcome: "created" as const,
            link: packageAssetLink,
        })),
        readPackageAsset: vi.fn(async () => PluginAvailabilityPackageAssetReadActionOutputV1Schema.parse({
            link: packageAssetLink,
            artifact: {
                header: encodePlainArtifactStoredContent({ title: "Package assets" }),
                headerVersion: 1,
                body: encodePlainArtifactStoredContent({ body: "fixture" }),
                bodyVersion: 1,
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                seq: 0,
            },
        })),
        issueBrowserArtifactFrame: vi.fn(async ({ input }) => {
            PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1Schema.parse(input);
            return {
                url: "https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/capability/",
                expiresAt: 1_800_000_000_000,
            };
        }),
        readBrowserArtifactFrame: vi.fn(async () => ({
            bytes: new Uint8Array([1, 2, 3]),
            contentType: "text/javascript; charset=utf-8",
            headers: {
                "Cache-Control": "no-store",
                "Content-Security-Policy": "frame-ancestors https://app.happier.test",
                "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
            },
        })),
        removeUiArtifact: vi.fn(async () => ({
            removed: true as const,
            link: uiArtifactLink,
        })),
    };
}

function replyHarness() {
    const reply = {
        code: vi.fn(function code() { return reply; }),
        header: vi.fn(function header() { return reply; }),
        send: vi.fn((payload) => payload),
    };
    return reply;
}

describe("plugin Availability routes", () => {
    beforeEach(() => {
        publisherProofMock.verify.mockReset();
    });

    it("mounts each canonical Availability action behind the authenticated Account boundary", () => {
        const app = createFakeRouteApp();
        registerPluginAvailabilityRoutes(app as never);

        for (const action of [
            "account.plugins.availability.intent.read",
            "account.plugins.availability.intent.set",
            "account.plugins.availability.intents.list",
            "account.plugins.availability.release.read",
            "account.plugins.availability.release.publish",
            "account.plugins.availability.materializations.report",
            "account.plugins.availability.materializations.read",
            "account.plugins.availability.uiArtifact.publish",
            "account.plugins.availability.uiArtifact.read",
            "account.plugins.availability.uiArtifact.remove",
            "account.plugins.availability.uiArtifact.browserFrame.issue",
            "account.plugins.availability.packageAsset.publish",
            "account.plugins.availability.packageAsset.read",
        ] as const) {
            const entry = app.routes.get(
                `POST ${PluginAvailabilityActionHttpPathsV1[action]}`,
            );
            expect(entry, action).toBeDefined();
            expect(entry?.opts.preHandler).toBe(app.authenticate);
        }
    });

    it("mounts Account intent listing as an additive present-user Availability operation", () => {
        const app = createFakeRouteApp();
        const operations = createOperations();
        registerPluginAvailabilityRoutes(app as never, { operations });

        const entry = app.routes.get(`POST ${PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.intents.list"
        ]}`);
        expect(entry).toBeDefined();
        expect(entry?.opts.preHandler).toBe(app.authenticate);
    });

    it("routes intent listing through the authenticated Account owner", async () => {
        const app = createFakeRouteApp();
        const operations = createOperations();
        registerPluginAvailabilityRoutes(app as never, { operations });
        const request = {
            userId: "account-present-user",
            method: "POST",
            headers: {},
        };

        await app.routes.get(`POST ${PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.intents.list"
        ]}`)!.handler({
            ...request,
            body: {},
        }, replyHarness());

        expect(operations.listIntentIds).toHaveBeenCalledWith({
            accountId: request.userId,
            input: {},
        });
        expect(publisherProofMock.verify).not.toHaveBeenCalled();
    });

    it("reads an exact unselected release coordinate through the present-user Account boundary", async () => {
        const app = createFakeRouteApp();
        const operations = createOperations();
        const expected = PluginAvailabilityReleaseReadActionOutputV1Schema.parse({
            availabilityCursor: 7,
            facts: releasePublishInput.facts,
        });
        const readRelease = vi.fn(async ({ input }: Readonly<{ input: unknown }>) => {
            PluginAvailabilityReleaseReadActionInputV1Schema.parse(input);
            return expected;
        });
        (operations as unknown as { readRelease: typeof readRelease }).readRelease = readRelease;
        registerPluginAvailabilityRoutes(app as never, { operations });
        const path = PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.release.read"
        ];
        const entry = app.routes.get(`POST ${path}`);
        expect(entry).toBeDefined();
        if (!entry) return;

        await expect(entry.handler({
            userId: "account-present-user",
            method: "POST",
            headers: {},
            body: { release: releasePublishInput.facts.ref },
        }, replyHarness())).resolves.toEqual(expected);
        expect(readRelease).toHaveBeenCalledWith({
            accountId: "account-present-user",
            input: { release: releasePublishInput.facts.ref },
        });
        expect(publisherProofMock.verify).not.toHaveBeenCalled();
    });

    it("maps an exact release read miss to its typed 404 response", async () => {
        const app = createFakeRouteApp();
        const operations = createOperations();
        const readRelease = vi.fn(async () => {
            throw new PluginAvailabilityOperationError("plugin_release_not_found");
        });
        (operations as unknown as { readRelease: typeof readRelease }).readRelease = readRelease;
        registerPluginAvailabilityRoutes(app as never, { operations });
        const path = PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.release.read"
        ];
        const entry = app.routes.get(`POST ${path}`);
        if (!entry) throw new Error("Expected exact release read route");
        const reply = replyHarness();

        await entry.handler({
            userId: "account-present-user",
            method: "POST",
            headers: {},
            body: { release: releasePublishInput.facts.ref },
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "plugin_release_not_found" });
        expect(publisherProofMock.verify).not.toHaveBeenCalled();
    });

    it("uses the authenticated Account directly for present-user Availability actions", async () => {
        const app = createFakeRouteApp();
        const operations = createOperations();
        registerPluginAvailabilityRoutes(app as never, { operations });
        const request = {
            userId: "account-present-user",
            method: "POST",
            headers: {},
        };

        await app.routes.get(`POST ${PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.intent.read"
        ]}`)!.handler({
            ...request,
            body: { pluginId: "com.acme.fixture" },
        }, replyHarness());
        await app.routes.get(`POST ${PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.intent.set"
        ]}`)!.handler({
            ...request,
            body: {
                pluginId: "com.acme.fixture",
                desiredVersion: "1.2.3",
                enabled: true,
                offlineUiHosting: "disabled",
                writableCollections: [],
                expectedRevision: null,
            },
        }, replyHarness());
        await app.routes.get(`POST ${PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.materializations.read"
        ]}`)!.handler({
            ...request,
            body: {},
        }, replyHarness());
        await app.routes.get(`POST ${PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.uiArtifact.read"
        ]}`)!.handler({
            ...request,
            body: {
                release: releasePublishInput.facts.ref,
                contributionId: uiArtifactLink.contributionId,
                tier: uiArtifactLink.tier,
                platform: uiArtifactLink.platform,
                purpose: "candidatePreparation",
                expectedArtifactDigest: uiArtifactLink.artifactDigest,
            },
        }, replyHarness());

        expect(publisherProofMock.verify).not.toHaveBeenCalled();
        expect(operations.readIntent).toHaveBeenCalledWith({
            accountId: request.userId,
            input: { pluginId: "com.acme.fixture" },
        });
        expect(operations.setIntent).toHaveBeenCalledWith({
            accountId: request.userId,
            input: expect.objectContaining({
                pluginId: "com.acme.fixture",
                desiredVersion: "1.2.3",
                expectedRevision: null,
            }),
        });
        expect(operations.readMaterializations).toHaveBeenCalledWith({
            accountId: request.userId,
            input: {},
        });
        expect(operations.readUiArtifact).toHaveBeenCalledWith({
            accountId: request.userId,
            input: expect.objectContaining({
                release: releasePublishInput.facts.ref,
                contributionId: uiArtifactLink.contributionId,
                purpose: "candidatePreparation",
                expectedArtifactDigest: uiArtifactLink.artifactDigest,
            }),
        });
    });

    it("returns typed Collection quota activation failures without flattening their effective limit", async () => {
        const app = createFakeRouteApp();
        const operations = createOperations();
        vi.mocked(operations.setIntent).mockRejectedValueOnce(new PluginAvailabilityOperationError(
            "collection_quota_incompatible",
            { dimension: "maxRows", effectiveMaximum: 1 },
        ));
        registerPluginAvailabilityRoutes(app as never, { operations });
        const reply = replyHarness();

        await app.routes.get(`POST ${PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.intent.set"
        ]}`)!.handler({
            userId: "account-present-user",
            method: "POST",
            headers: {},
            body: {
                pluginId: "com.acme.fixture",
                desiredVersion: "1.2.3",
                enabled: true,
                offlineUiHosting: "disabled",
                writableCollections: [],
                expectedRevision: null,
            },
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(reply.send).toHaveBeenCalledWith({
            error: "collection_quota_incompatible",
            dimension: "maxRows",
            effectiveMaximum: 1,
        });
    });

    it("adapts qualified Artifact publish/read through the incumbent stored-content compatibility boundary", async () => {
        const app = createFakeRouteApp();
        const operations = createOperations();
        registerPluginAvailabilityRoutes(app as never, { operations });
        const publishReply = replyHarness();
        const publishRequest = {
            userId: "account-present-user",
            method: "POST",
            headers: {},
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: true,
                supportsPluginDataProtocol: true,
                outcome: "accepted" as const,
                declaration: null,
                upgradeRequired: null,
            },
        };

        const uiArtifactPublishInput = {
            release: uiArtifactReadInput.release,
            slot: uiArtifactSlot,
            hostCompatibility: uiArtifactLink.compatibility,
            artifactId: uiArtifactLink.artifactId,
            artifact: {
                header: encodePlainArtifactStoredContent({ title: "Hosted" }),
                body: encodePlainArtifactStoredContent({ archive: "fixture" }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            },
        };
        await app.routes.get(`POST ${PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.uiArtifact.publish"
        ]}`)!.handler({
            ...publishRequest,
            body: uiArtifactPublishInput,
        }, publishReply);
        expect(operations.publishUiArtifact).toHaveBeenCalledWith({
            accountId: publishRequest.userId,
            supportsCurrentStoredContentProtocol: true,
            input: expect.objectContaining({ artifactId: uiArtifactLink.artifactId }),
        });

        const legacyReadReply = replyHarness();
        await app.routes.get(`POST ${PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.uiArtifact.read"
        ]}`)!.handler({
            userId: publishRequest.userId,
            method: "POST",
            headers: {},
            body: uiArtifactReadInput,
        }, legacyReadReply);
        expect(legacyReadReply.code).toHaveBeenCalledWith(426);
        expect(legacyReadReply.send).toHaveBeenCalledWith(expect.objectContaining({
            error: "client-upgrade-required",
        }));

        const packageAssetPublishInput = {
            release: releasePublishInput.facts.ref,
            artifactId: packageAssetLink.artifactId,
            artifact: {
                header: encodePlainArtifactStoredContent({ title: "Package assets" }),
                body: encodePlainArtifactStoredContent({ body: "fixture" }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            },
        };
        await app.routes.get(`POST ${PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.packageAsset.publish"
        ]}`)!.handler({
            ...publishRequest,
            body: packageAssetPublishInput,
        }, replyHarness());
        expect(operations.publishPackageAsset).toHaveBeenCalledWith({
            accountId: publishRequest.userId,
            supportsCurrentStoredContentProtocol: true,
            input: packageAssetPublishInput,
        });

        const packageAssetLegacyReadReply = replyHarness();
        await app.routes.get(`POST ${PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.packageAsset.read"
        ]}`)!.handler({
            userId: publishRequest.userId,
            method: "POST",
            headers: {},
            body: { release: releasePublishInput.facts.ref },
        }, packageAssetLegacyReadReply);
        expect(operations.readPackageAsset).toHaveBeenCalledWith({
            accountId: publishRequest.userId,
            input: { release: releasePublishInput.facts.ref },
        });
        expect(packageAssetLegacyReadReply.code).toHaveBeenCalledWith(426);
        expect(publisherProofMock.verify).not.toHaveBeenCalled();
    });

    it("issues a browser Artifact frame only through the authenticated Availability owner", async () => {
        const app = createFakeRouteApp();
        const operations = createOperations();
        registerPluginAvailabilityRoutes(app as never, { operations });
        const path = PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.uiArtifact.browserFrame.issue"
        ];

        await app.routes.get(`POST ${path}`)!.handler({
            userId: "account-present-user",
            method: "POST",
            headers: {},
            body: uiArtifactBrowserFrameIssueInput,
        }, replyHarness());

        expect(operations.issueBrowserArtifactFrame).toHaveBeenCalledWith({
            accountId: "account-present-user",
            input: uiArtifactBrowserFrameIssueInput,
        });
        expect(publisherProofMock.verify).not.toHaveBeenCalled();
    });

    it("serves browser Artifact bytes only through an unauthenticated opaque capability path", async () => {
        const app = createFakeRouteApp();
        const operations = createOperations();
        registerPluginAvailabilityRoutes(app as never, { operations });

        const entry = app.routes.get(`GET ${browserArtifactCapabilityRoutePath}`);
        expect(entry).toBeDefined();
        if (!entry) return;
        expect(entry.opts.preHandler).toBeUndefined();

        const reply = replyHarness();
        await entry.handler({
            method: "GET",
            headers: {},
            protocol: "https",
            host: "artifacts.happier.test",
            params: {
                capability: "opaque-capability",
                "*": "assets/app.js",
            },
        }, reply);

        expect(operations.readBrowserArtifactFrame).toHaveBeenCalledWith({
            capability: "opaque-capability",
            requestPath: "assets/app.js",
            request: {
                host: "artifacts.happier.test",
                protocol: "https",
            },
        });
        expect(reply.header).toHaveBeenCalledWith(
            "content-type",
            "text/javascript; charset=utf-8",
        );
        expect(reply.header).toHaveBeenCalledWith("Cache-Control", "no-store");
        expect(reply.send).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
        expect(publisherProofMock.verify).not.toHaveBeenCalled();
    });

    it("keeps rejected browser Artifact capability requests nonpersistent and non-referring", async () => {
        const app = createFakeRouteApp();
        const operations = createOperations();
        operations.readBrowserArtifactFrame.mockRejectedValueOnce(
            new PluginAvailabilityOperationError("plugin_ui_artifact_not_found"),
        );
        registerPluginAvailabilityRoutes(app as never, { operations });

        const entry = app.routes.get(`GET ${browserArtifactCapabilityRoutePath}`);
        if (!entry) throw new Error("Expected browser Artifact capability route");
        const reply = replyHarness();
        await entry.handler({
            method: "GET",
            headers: {},
            protocol: "https",
            host: "artifacts.happier.test",
            params: {
                capability: "retired-capability",
                "*": "assets/app.js",
            },
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.header).toHaveBeenCalledWith("Cache-Control", "no-store");
        expect(reply.header).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
        expect(reply.header).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
        expect(reply.send).toHaveBeenCalledWith({ error: "Not found" });
    });

    it("keeps unexpected browser Artifact failures nonpersistent and non-referring before global error handling", async () => {
        const app = createFakeRouteApp();
        const operations = createOperations();
        operations.readBrowserArtifactFrame.mockRejectedValueOnce(
            new Error("unexpected browser Artifact failure"),
        );
        registerPluginAvailabilityRoutes(app as never, { operations });

        const entry = app.routes.get(`GET ${browserArtifactCapabilityRoutePath}`);
        if (!entry) throw new Error("Expected browser Artifact capability route");
        const reply = replyHarness();
        await expect(entry.handler({
            method: "GET",
            headers: {},
            protocol: "https",
            host: "artifacts.happier.test",
            params: {
                capability: "unexpected-capability",
                "*": "assets/app.js",
            },
        }, reply)).rejects.toThrow("unexpected browser Artifact failure");

        expect(reply.header).toHaveBeenCalledWith("Cache-Control", "no-store");
        expect(reply.header).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
        expect(reply.header).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
        expect(reply.send).not.toHaveBeenCalled();
    });

    it("uses the incumbent publisher proof for both release facts and the exact reporting machine", async () => {
        const app = createFakeRouteApp();
        const operations = createOperations();
        registerPluginAvailabilityRoutes(app as never, { operations });
        publisherProofMock.verify.mockResolvedValue({
            machineId: "machine-route-fixture",
            installationId: "install-route-fixture",
        });
        const releasePath = PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.release.publish"
        ];
        const reportPath = PluginAvailabilityActionHttpPathsV1[
            "account.plugins.availability.materializations.report"
        ];
        const request = {
            userId: "account-route-fixture",
            method: "POST",
            headers: {},
        };

        await app.routes.get(`POST ${releasePath}`)!.handler({
            ...request,
            body: releasePublishInput,
        }, replyHarness());
        await app.routes.get(`POST ${reportPath}`)!.handler({
            ...request,
            body: materializationsReportInput,
        }, replyHarness());

        expect(publisherProofMock.verify).toHaveBeenNthCalledWith(1, {
            accountId: request.userId,
            request: expect.objectContaining({ body: releasePublishInput }),
            path: releasePath,
            required: true,
        });
        expect(publisherProofMock.verify).toHaveBeenNthCalledWith(2, {
            accountId: request.userId,
            request: expect.objectContaining({ body: materializationsReportInput }),
            path: reportPath,
            required: true,
        });
        expect(operations.publishRelease).toHaveBeenCalledWith({
            accountId: request.userId,
            input: expect.objectContaining({
                facts: expect.objectContaining({
                    ref: releasePublishInput.facts.ref,
                    archiveDigestSha256: releasePublishInput.facts.archiveDigestSha256,
                }),
                sourceClass: releasePublishInput.sourceClass,
            }),
        });
        expect(operations.reportMaterializations).toHaveBeenCalledWith({
            accountId: request.userId,
            publisherMachineId: "machine-route-fixture",
            input: materializationsReportInput,
        });
    });
});
