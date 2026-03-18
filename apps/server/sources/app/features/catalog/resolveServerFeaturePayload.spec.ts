import { describe, expect, it } from "vitest";

import { resolveMachineTransferFeature } from "../machineTransferFeature";
import { resolveSessionHandoffFeature } from "../sessionHandoffFeature";
import { resolveTerminalFeature } from "../terminalFeature";
import { resolveServerFeaturePayload } from "./resolveServerFeaturePayload";
import { resolveServerFeatureBuildPolicy } from "./serverFeatureBuildPolicy";
import type { ServerFeatureResolver } from "./serverFeatureRegistry";
import type { FeaturesPayloadDelta } from "../types";
import { evaluateFeatureBuildPolicy } from "@happier-dev/protocol";

function fromPartial(partial: FeaturesPayloadDelta): ServerFeatureResolver {
    return () => partial;
}

describe("resolveServerFeaturePayload", () => {
    it("throws when resolvers list is empty", () => {
        expect(() => resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [])).toThrow(/resolvers/i);
    });

    it("forces server feature gates disabled when build policy denies a represented feature", () => {
        const env = {
            HAPPIER_BUILD_FEATURES_DENY: "connectedServices",
        } as NodeJS.ProcessEnv;

        const buildPolicy = resolveServerFeatureBuildPolicy(env);
        expect(evaluateFeatureBuildPolicy(buildPolicy, "connectedServices")).toBe("deny");

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

        expect(payload.features.connectedServices.enabled).toBe(false);
        expect(payload.features.connectedServices.quotas.enabled).toBe(false);
    });

    it("forces server feature gates disabled when build policy allowlist omits a represented feature", () => {
        const env = {
            HAPPIER_BUILD_FEATURES_ALLOW: "connectedServices",
        } as NodeJS.ProcessEnv;

        const buildPolicy = resolveServerFeatureBuildPolicy(env);
        expect(evaluateFeatureBuildPolicy(buildPolicy, "connectedServices")).toBe("allow");
        expect(evaluateFeatureBuildPolicy(buildPolicy, "connectedServices.quotas")).toBe("deny");

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
        expect(payload.features.connectedServices.quotas.enabled).toBe(false);
    });

    it("forces represented features disabled when a represented dependency is disabled", () => {
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
        expect(payload.features.connectedServices.quotas.enabled).toBe(false);
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
        expect(payload.capabilities.machines.transfer.serverRouted.maxBytes).toBeNull();
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

});
