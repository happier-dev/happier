import { readServerEnabledBit } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import { resolveServerFeaturePayload } from "./catalog/resolveServerFeaturePayload";
import { serverFeatureRegistry } from "./catalog/serverFeatureRegistry";

describe("devices server feature resolver", () => {
    it("defaults the device + simulator preview gates to allow so viewing your own simulator is on by default (§4.1)", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "devices")).toBe(true);
        expect(readServerEnabledBit(payload, "devices.simulatorPreview")).toBe(true);
    });

    it("treats a payload with no devices projection as fail-closed (missing bit = disabled)", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [
            () => ({ features: {} }),
        ]);

        expect(readServerEnabledBit(payload, "devices.simulatorPreview")).toBe(false);
    });

    it("lets a server disable simulator preview while keeping the devices namespace on", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_DEVICES_SIMULATOR_PREVIEW__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "devices")).toBe(true);
        expect(readServerEnabledBit(payload, "devices.simulatorPreview")).toBe(false);
    });

    it("lets a server disable the whole devices namespace", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_DEVICES__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "devices")).toBe(false);
    });
});
