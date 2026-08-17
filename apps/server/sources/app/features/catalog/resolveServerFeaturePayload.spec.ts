import { beforeEach, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";

import { resolveMachineTransferFeature } from "../machineTransferFeature";
import { resolveMachineLiveStreamFeature } from "../machineLiveStreamFeature";
import { resolveSessionHandoffFeature } from "../sessionHandoffFeature";
import { resolveServerUsageAnalyticsCapabilitiesFeature } from "../serverUsageAnalyticsCapabilitiesFeature";
import { resolveSharingFeature } from "../sharingFeature";
import { resolveTerminalFeature } from "../terminalFeature";
import { resolveServerFeaturePayload } from "./resolveServerFeaturePayload";
import { resolveServerFeatureBuildPolicy } from "./serverFeatureBuildPolicy";
import { serverFeatureRegistry, type ServerFeatureResolver } from "./serverFeatureRegistry";
import type { FeaturesPayloadDelta } from "../types";
import { evaluateFeatureBuildPolicy } from "@happier-dev/protocol";
import { accountUsageRoutePaths } from "@/app/api/routes/account/accountUsageRoutePaths";
import {
    initializeSessionSystemRecordsProtocolV1Activation,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
    SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION,
} from "@/app/session/systemRecords/sessionSystemRecordProtocolContract";

// Prisma is the system boundary; this feature fixture exposes only the audited findMany operation.
type ProtocolActivationDatabase = Parameters<typeof initializeSessionSystemRecordsProtocolV1Activation>[0];

function fromPartial(partial: FeaturesPayloadDelta): ServerFeatureResolver {
    return () => partial;
}

function readRequiredPath(root: unknown, path: ReadonlyArray<string>): unknown {
    let current: unknown = root;
    for (const segment of path) {
        if (typeof current !== "object" || current === null) {
            throw new Error(`Expected object at "${segment}" while reading "${path.join(".")}"`);
        }
        if (!Object.prototype.hasOwnProperty.call(current, segment)) {
            throw new Error(`Missing "${segment}" while reading "${path.join(".")}"`);
        }
        current = (current as Record<string, unknown>)[segment];
    }
    return current;
}

function readOptionalPath(root: unknown, path: ReadonlyArray<string>): unknown {
    try {
        return readRequiredPath(root, path);
    } catch {
        return undefined;
    }
}

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

async function loadMachineTunnelFeatureModule(): Promise<Record<string, any> | null> {
    const modulePath = "../machineTunnelFeature";
    return import(modulePath).catch(() => null) as Promise<Record<string, any> | null>;
}

async function loadSessionFoldersFeatureModule(): Promise<Record<string, any> | null> {
    const modulePath = "../sessionFoldersFeature";
    return import(modulePath).catch(() => null) as Promise<Record<string, any> | null>;
}

describe("resolveServerFeaturePayload", () => {
    beforeEach(() => {
        resetSessionSystemRecordsProtocolV1ActivationForTests();
    });

    it("throws when resolvers list is empty", () => {
        expect(() => resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [])).toThrow(/resolvers/i);
    });

    it("does not apply build policy to the compatibility-only Connected Accounts master bit", () => {
        const env = {
            HAPPIER_BUILD_FEATURES_DENY: "connectedServices",
        } as NodeJS.ProcessEnv;

        const payload = resolveServerFeaturePayload(
            env,
            [
                fromPartial({
                    features: {
                        connectedServices: { enabled: true, quotas: { enabled: true } },
                    },
                }),
            ],
        );

        expect(payload.features.connectedServices.enabled).toBe(true);
        expect(payload.features.connectedServices.quotas.enabled).toBe(true);
    });

    it("keeps an allowlisted subordinate quota gate enabled independently", () => {
        const env = {
            HAPPIER_BUILD_FEATURES_ALLOW: "connectedServices.quotas",
        } as NodeJS.ProcessEnv;

        const buildPolicy = resolveServerFeatureBuildPolicy(env);
        expect(evaluateFeatureBuildPolicy(buildPolicy, "connectedServices.quotas")).toBe("allow");

        const payload = resolveServerFeaturePayload(
            env,
            [
                fromPartial({
                    features: {
                        connectedServices: { enabled: true, quotas: { enabled: true } },
                    },
                }),
            ],
        );

        expect(payload.features.connectedServices.enabled).toBe(true);
        expect(payload.features.connectedServices.quotas.enabled).toBe(true);
    });

    it("does not let the compatibility-only master bit disable independent quota gates", () => {
        const payload = resolveServerFeaturePayload(
            {} as NodeJS.ProcessEnv,
            [
                fromPartial({
                    features: {
                        connectedServices: { enabled: false, quotas: { enabled: true } },
                    },
                }),
            ],
        );

        expect(payload.features.connectedServices.enabled).toBe(false);
        expect(payload.features.connectedServices.quotas.enabled).toBe(true);
    });

    it("applies dependency pruning to a fixed point when a dependency is pruned later in catalog order", () => {
        const payload = resolveServerFeaturePayload(
            {} as NodeJS.ProcessEnv,
            [
                fromPartial({
                    features: {
                        localServices: {
                            enabled: true,
                            inventory: { enabled: true },
                            managed: { enabled: true },
                            preview: { enabled: true },
                            launcher: { enabled: true },
                        },
                        browser: {
                            enabled: false,
                            viewTargets: { enabled: true },
                        },
                    },
                }),
            ],
        );

        expect(readOptionalPath(payload, ["features", "browser", "enabled"])).toBe(false);
        expect(readOptionalPath(payload, ["features", "browser", "viewTargets", "enabled"])).toBe(false);
        expect(readOptionalPath(payload, ["features", "localServices", "launcher", "enabled"])).toBe(false);
    });

    it("enforces transitive dependencies regardless of catalog declaration order (SD-3)", () => {
        // Real out-of-order chain: `connectedServices.accountFallback` is declared BEFORE its
        // dependency `sessions.usageLimitRecovery` in the catalog. A single-pass, order-dependent
        // enforcement visits accountFallback while usageLimitRecovery still reads enabled (its own
        // dependency `sessions` is disabled and only gets enforced later), leaving accountFallback
        // incorrectly enabled. Enforcement must resolve to a fixpoint.
        const payload = resolveServerFeaturePayload(
            {} as NodeJS.ProcessEnv,
            [
                fromPartial({
                    features: {
                        sessions: { enabled: false, usageLimitRecovery: { enabled: true } },
                        connectedServices: {
                            enabled: true,
                            accountGroups: { enabled: true },
                            accountFallback: { enabled: true },
                        },
                    },
                }),
            ],
        );

        expect(payload.features.sessions.enabled).toBe(false);
        expect(payload.features.sessions.usageLimitRecovery.enabled).toBe(false);
        expect(payload.features.connectedServices.accountFallback.enabled).toBe(false);
        // Independent siblings stay untouched.
        expect(payload.features.connectedServices.enabled).toBe(true);
        expect(payload.features.connectedServices.accountGroups.enabled).toBe(true);
    });

    it("keeps pets.sync enabled when pets.companion is disabled", () => {
        const payload = resolveServerFeaturePayload(
            {} as NodeJS.ProcessEnv,
            [
                fromPartial({
                    features: {
                        pets: {
                            companion: { enabled: false },
                            sync: { enabled: true },
                        },
                    },
                }),
            ],
        );

        expect(readOptionalPath(payload, ["features", "pets", "companion", "enabled"])).toBe(false);
        expect(readOptionalPath(payload, ["features", "pets", "sync", "enabled"])).toBe(true);
    });

    it("annotates capabilities when build policy denies Happier Voice", () => {
        const env = {
            HAPPIER_BUILD_FEATURES_DENY: "voice.happierVoice",
        } as NodeJS.ProcessEnv;

        const buildPolicy = resolveServerFeatureBuildPolicy(env);
        expect(evaluateFeatureBuildPolicy(buildPolicy, "voice.happierVoice")).toBe("deny");

        const payload = resolveServerFeaturePayload(
            env,
            [
                fromPartial({
                    features: {
                        voice: { enabled: true, happierVoice: { enabled: true } },
                    },
                    capabilities: {
                        voice: {
                            configured: false,
                            provider: null,
                        },
                    },
                }),
            ],
        );

        expect(payload.features.voice.enabled).toBe(true);
        expect(payload.features.voice.happierVoice.enabled).toBe(false);
        expect(payload.capabilities.voice.disabledByBuildPolicy).toBe(true);
    });

    it("enables terminal embedded PTY by default so the UI toggle can appear", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [resolveTerminalFeature]);
        expect(payload.features.terminal.embeddedPty.enabled).toBe(true);
    });

    it("enables session handoff and server-routed transfer by default", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [resolveSessionHandoffFeature, resolveMachineTransferFeature]);
        expect(payload.features.sessions.handoff.enabled).toBe(true);
        expect(payload.features.machines.transfer.serverRouted.enabled).toBe(true);
        expect(payload.features.machines.transfer.directPeer.enabled).toBe(true);
        // Must be bounded even when env is unset (prevents implicit unlimited server-routed streaming).
        expect(payload.capabilities.machines.transfer.serverRouted.maxBytes).toBe(2 * 1024 * 1024 * 1024);
    });

    it("advertises Session System Records v1 after the final current-version contract is active", async () => {
        await initializeSessionSystemRecordsProtocolV1Activation({
            $queryRawUnsafe: async () => [{
                migration_name: SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION,
            }],
            sessionSystemRecord: {
                findMany: async () => [],
            },
        } as unknown as ProtocolActivationDatabase);
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [resolveSessionHandoffFeature]);

        expect(payload.capabilities.session.messages.role).toBe(true);
        expect(payload.capabilities.session.systemRecords).toEqual({ protocolVersions: [1] });
    });

    it("keeps Session System Records v1 absent until its database contract is activated", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [resolveSessionHandoffFeature]);

        expect(payload.capabilities.session.systemRecords).toBeUndefined();
    });

    it("enables session folders by default so the UI toggle can appear", async () => {
        const mod = await loadSessionFoldersFeatureModule();
        expect(mod?.resolveSessionFoldersFeature).toBeTypeOf("function");

        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [mod!.resolveSessionFoldersFeature]);

        expect(readOptionalPath(payload, ["features", "sessions", "folders", "enabled"])).toBe(true);
    });

    it("supports disabling session folders through the feature env", async () => {
        const mod = await loadSessionFoldersFeatureModule();
        expect(mod?.resolveSessionFoldersFeature).toBeTypeOf("function");

        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_SESSIONS_FOLDERS__ENABLED: "0",
        } as NodeJS.ProcessEnv, [mod!.resolveSessionFoldersFeature]);

        expect(readOptionalPath(payload, ["features", "sessions", "folders", "enabled"])).toBe(false);
    });

    it("enables agent switching from the server registry by default so the in-Session Agent rail can appear", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readOptionalPath(payload, ["features", "sessions", "agentSwitching", "enabled"])).toBe(true);
    });

    it("supports disabling agent switching through the feature env", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_SESSIONS_AGENT_SWITCHING__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readOptionalPath(payload, ["features", "sessions", "agentSwitching", "enabled"])).toBe(false);
    });

    it("keeps agent switching disabled when its `sessions` dependency is disabled", () => {
        const payload = resolveServerFeaturePayload(
            {} as NodeJS.ProcessEnv,
            [...serverFeatureRegistry, fromPartial({ features: { sessions: { enabled: false } } })],
        );

        expect(readOptionalPath(payload, ["features", "sessions", "enabled"])).toBe(false);
        expect(readOptionalPath(payload, ["features", "sessions", "agentSwitching", "enabled"])).toBe(false);
    });

    it("keeps server-routed tunnel relay disabled by default while advertising capped diagnostics", async () => {
        const mod = await loadMachineTunnelFeatureModule();
        expect(mod?.resolveMachineTunnelFeature).toBeTypeOf("function");

        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [mod!.resolveMachineTunnelFeature]);

        expect(payload.features.machines.tunnel.directPeer.enabled).toBe(true);
        expect(payload.features.machines.tunnel.serverRouted.enabled).toBe(false);
        expect(payload.capabilities.machines.tunnel.serverRouted).toMatchObject({
            maxActiveTunnelsPerSocket: 8,
            maxFrameBytes: 64 * 1024,
            supportedEncodings: ["json_base64_v1", "binary_frame_v2"],
            preferredEncoding: "binary_frame_v2",
            allowV1Fallback: true,
            substreams: {
                maxConcurrentSubstreams: 32,
                maxTotalSubstreams: 1024,
            },
            disabledReason: "relay_disabled_by_server_policy",
        });
    });

    it("does not emit retired channel bridge gates when historic env keys are set", () => {
        const payload = resolveServerFeaturePayload(
            {
                HAPPIER_FEATURE_CHANNEL_BRIDGES__ENABLED: "0",
                HAPPIER_FEATURE_CHANNEL_BRIDGES_TELEGRAM__ENABLED: "0",
            } as NodeJS.ProcessEnv,
            serverFeatureRegistry,
        );

        expect(payload.features).not.toHaveProperty("channelBridges");
    });

    it("disables only generic server-routed transfer when the env toggle is off", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__ENABLED: "0",
        } as NodeJS.ProcessEnv, [resolveSessionHandoffFeature, resolveMachineTransferFeature]);

        expect(payload.features.sessions.handoff.enabled).toBe(true);
        expect(payload.features.machines.transfer.serverRouted.enabled).toBe(false);
        expect(payload.features.machines.transfer.directPeer.enabled).toBe(true);
    });

    it("exposes server-routed transfer max-bytes capability when configured", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: "16384",
        } as NodeJS.ProcessEnv, [resolveSessionHandoffFeature, resolveMachineTransferFeature]);

        expect(payload.features.machines.transfer.serverRouted.enabled).toBe(true);
        expect(payload.capabilities.machines.transfer.serverRouted.maxBytes).toBe(16384);
    });

    it("does not advertise peer mediation signing capability without a usable private signing key", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "key_1",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: "public_key_1",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: "1900000000000",
        } as NodeJS.ProcessEnv, [resolveSessionHandoffFeature, resolveMachineTransferFeature]);

        expect(payload.capabilities.machines.peerMediation.grantSigningKeys).toEqual([]);
        expect(payload.capabilities.machines.peerMediation.directRouteGrantProofMintVersions).toEqual([]);
        expect(payload.capabilities.machines.peerMediation.tcpTunnelRelayAuthorizationMintVersions).toEqual([]);
        expect(readOptionalPath(payload, ["features", "machines", "peerMediation", "enabled"])).toBe(false);
    });

    it("does not advertise peer mediation signing capability when the configured public key mismatches", () => {
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const payload = resolveServerFeaturePayload({
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "key_1",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: toBase64Url(keyPair.secretKey),
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: "mismatched_public_key",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: "1900000000000",
        } as NodeJS.ProcessEnv, [resolveSessionHandoffFeature, resolveMachineTransferFeature]);

        expect(payload.capabilities.machines.peerMediation.grantSigningKeys).toEqual([]);
    });

    it("advertises peer mediation signing capability when the configured public key matches", () => {
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const payload = resolveServerFeaturePayload({
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "key_1",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: toBase64Url(keyPair.secretKey),
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: toBase64Url(keyPair.publicKey),
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: "1900000000000",
        } as NodeJS.ProcessEnv, [resolveSessionHandoffFeature, resolveMachineTransferFeature]);

        expect(payload.capabilities.machines.peerMediation.grantSigningKeys).toEqual([
            {
                keyId: "key_1",
                publicKey: toBase64Url(keyPair.publicKey),
                expiresAt: 1_900_000_000_000,
            },
        ]);
        expect(payload.capabilities.machines.peerMediation.directRouteGrantProofMintVersions).toEqual([2]);
        expect(payload.capabilities.machines.peerMediation.tcpTunnelRelayAuthorizationMintVersions).toEqual([2]);
    });

    it("advertises live-stream relay caps only when server-routed live stream is configured", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__ENABLED: "true",
            HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: "64000",
            HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: "12",
            HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: "32000",
            HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: "60000",
            HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: "128000",
            HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: "2",
            HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: "1",
            HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: "1",
        } as NodeJS.ProcessEnv, [resolveMachineLiveStreamFeature]);

        expect(payload.features.machines.liveStream.serverRouted.enabled).toBe(true);
        expect(payload.capabilities.machines.liveStream.serverRouted.caps).toMatchObject({
            maxBitrateBps: 64_000,
            maxFramesPerSecond: 12,
            maxFrameBytes: 32_000,
            maxDurationMs: 60_000,
            maxTotalBytes: 128_000,
        });
    });

    it("keeps server-routed live stream disabled by default even when direct live stream is server-allowed", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [resolveMachineLiveStreamFeature]);

        expect(payload.features.machines.liveStream.directPeer.enabled).toBe(true);
        expect(payload.features.machines.liveStream.serverRouted.enabled).toBe(false);
        expect(payload.capabilities.machines.liveStream.serverRouted.caps).toBeNull();
        expect(payload.capabilities.machines.liveStream.serverRouted.disabledReason).toBe("relay_not_enabled");
    });

    it("merges sibling capabilities.server fields from different resolvers", () => {
        const payload = resolveServerFeaturePayload(
            {
                HAPPIER_PUBLIC_SERVER_URL: "https://stack.example.test/",
            } as NodeJS.ProcessEnv,
            [
                resolveServerUsageAnalyticsCapabilitiesFeature,
                fromPartial({
                    capabilities: {
                        server: {
                            canonicalServerUrl: "https://stack.example.test",
                        },
                    },
                }),
                fromPartial({
                    capabilities: {
                        server: {
                            retention: {
                                enabled: true,
                                policyVersion: 1,
                                sessions: {
                                    mode: "delete_inactive",
                                    inactivityDays: 30,
                                    requires: ["updatedAt", "lastActiveAt"],
                                },
                                accountChanges: { mode: "delete_older_than", days: 30 },
                                usageEvents: { mode: "keep_forever" },
                                voiceSessionLeases: { mode: "keep_forever" },
                                userFeedItems: { mode: "delete_older_than", days: 30 },
                                sessionShareAccessLogs: { mode: "delete_older_than", days: 30 },
                                publicShareAccessLogs: { mode: "delete_older_than", days: 30 },
                                terminalAuthRequests: { mode: "delete_older_than", days: 7 },
                                accountAuthRequests: { mode: "delete_older_than", days: 7 },
                                authPairingSessions: { mode: "delete_older_than", days: 7 },
                                repeatKeys: { mode: "delete_older_than", days: 7 },
                                globalLocks: { mode: "delete_older_than", days: 7 },
                                automationRuns: { mode: "delete_older_than", days: 30 },
                                automationRunEvents: { mode: "delete_older_than", days: 30 },
                            },
                        },
                    },
                }),
            ],
        );

        expect(payload.capabilities.server.canonicalServerUrl).toBe("https://stack.example.test");
        expect(payload.capabilities.server.retention?.enabled).toBe(true);
        expect(payload.capabilities.server.usageAnalytics).toMatchObject({
            version: 1,
            eventsIngest: { path: accountUsageRoutePaths.analyticsEventsIngest },
            query: { path: accountUsageRoutePaths.analyticsQuery },
            legacy: {
                usageReportsPath: accountUsageRoutePaths.legacyReportsIngest,
                usageQueryPath: accountUsageRoutePaths.legacyQuery,
            },
        });
        expect(readOptionalPath(payload, ["features", "server", "usageAnalytics"])).toBeUndefined();
    });

    it("deep-merges nested feature branches from different resolvers", () => {
        const payload = resolveServerFeaturePayload(
            {} as NodeJS.ProcessEnv,
            [
                fromPartial({
                    features: {
                        setup: {
                            relay: {
                                allowCustomRelayUrl: { enabled: false },
                            },
                        },
                    },
                }),
                fromPartial({
                    features: {
                        setup: {
                            relayAccess: {
                                allowTailscale: { enabled: false },
                            },
                        },
                    },
                }),
            ],
        );

        expect(readOptionalPath(payload, ["features", "setup", "relay", "allowCustomRelayUrl", "enabled"])).toBe(false);
        expect(readOptionalPath(payload, ["features", "setup", "relayAccess", "allowTailscale", "enabled"])).toBe(false);
    });

    it("advertises pending delivery-state support separately from the basic pending queue gate", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [resolveSharingFeature]);

        expect(readOptionalPath(payload, ["features", "sharing", "pendingQueueV2", "enabled"])).toBe(true);
        expect(readOptionalPath(payload, ["features", "sharing", "pendingDeliveryState", "enabled"])).toBe(true);
        expect(readOptionalPath(payload, ["capabilities", "sharing", "pendingQueueV2", "deliveryState"])).toBe(true);
        expect(readOptionalPath(payload, ["capabilities", "sharing", "pendingQueueV2", "deliveryBlockedReason"])).toBe(true);
    });

    it("includes setup surface policy gates, and build-policy denies can disable them", () => {
        const payloadAllowed = resolveServerFeaturePayload(
            {} as NodeJS.ProcessEnv,
            [
                resolveTerminalFeature,
            ],
        );
        expect(readOptionalPath(payloadAllowed, ["features", "setup", "relay", "allowRelaySelection", "enabled"])).toBe(true);
        expect(readOptionalPath(payloadAllowed, ["features", "setup", "relay", "allowHappierCloud", "enabled"])).toBe(true);
        expect(readOptionalPath(payloadAllowed, ["features", "setup", "relay", "allowCustomRelayUrl", "enabled"])).toBe(true);
        expect(readOptionalPath(payloadAllowed, ["features", "setup", "relay", "allowLocalRelayHost", "enabled"])).toBe(true);
        expect(readOptionalPath(payloadAllowed, ["features", "setup", "relay", "allowRemoteSshRelayHost", "enabled"])).toBe(true);
        expect(readOptionalPath(payloadAllowed, ["features", "setup", "relayAccess", "allowTailscale", "enabled"])).toBe(true);
        expect(readOptionalPath(payloadAllowed, ["features", "setup", "relayAccess", "allowCloudflareTunnel", "enabled"])).toBe(true);
        expect(readOptionalPath(payloadAllowed, ["features", "remoteHosts", "management", "enabled"])).toBe(true);
        expect(readOptionalPath(payloadAllowed, ["features", "remoteHosts", "secretMaterial", "enabled"])).toBe(false);

        const payloadDenied = resolveServerFeaturePayload(
            {
                HAPPIER_BUILD_FEATURES_DENY: "setup.relay.allowHappierCloud,setup.relay.allowCustomRelayUrl,remoteHosts.management",
            } as NodeJS.ProcessEnv,
            [
                resolveTerminalFeature,
            ],
        );
        expect(readOptionalPath(payloadDenied, ["features", "setup", "relay", "allowRelaySelection", "enabled"])).toBe(true);
        expect(readOptionalPath(payloadDenied, ["features", "setup", "relay", "allowHappierCloud", "enabled"])).toBe(false);
        expect(readOptionalPath(payloadDenied, ["features", "setup", "relay", "allowCustomRelayUrl", "enabled"])).toBe(false);
        expect(readOptionalPath(payloadDenied, ["features", "setup", "relay", "allowLocalRelayHost", "enabled"])).toBe(true);
        expect(readOptionalPath(payloadDenied, ["features", "setup", "relay", "allowRemoteSshRelayHost", "enabled"])).toBe(true);
        expect(readOptionalPath(payloadDenied, ["features", "remoteHosts", "management", "enabled"])).toBe(false);
    });

    it("enforces remoteHosts.secretMaterial dependency on remoteHosts.management", () => {
        const payload = resolveServerFeaturePayload(
            {} as NodeJS.ProcessEnv,
            [
                fromPartial({
                    features: {
                        remoteHosts: {
                            management: { enabled: false },
                            secretMaterial: { enabled: true },
                        },
                    },
                }),
            ],
        );

        expect(readOptionalPath(payload, ["features", "remoteHosts", "management", "enabled"])).toBe(false);
        expect(readOptionalPath(payload, ["features", "remoteHosts", "secretMaterial", "enabled"])).toBe(false);
    });

});
