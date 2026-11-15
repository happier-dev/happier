import { describe, expect, it } from "vitest";

import packageJson from "../../../package.json" with { type: "json" };

import { resolveServerUrlCapabilitiesFeature } from "./serverUrlCapabilitiesFeature";

describe("capabilities.server", () => {
    it("states the running server release and flavour (plan §3.7), whatever the address configuration", () => {
        expect(resolveServerUrlCapabilitiesFeature({ HAPPIER_SERVER_FLAVOR: "light" })).toEqual({
            capabilities: { serverRelease: { version: packageJson.version, flavor: "light" }, guestCli: { source: "home-payload", line: "0.3" } },
        });
        expect(resolveServerUrlCapabilitiesFeature({
            HAPPIER_SERVER_FLAVOR: "full",
            HAPPIER_CANONICAL_SERVER_URL: "https://home.example.test",
        }).capabilities).toEqual({
            // The strict server object released readers parse carries only the addresses.
            server: { canonicalServerUrl: "https://home.example.test" },
            serverRelease: { version: packageJson.version, flavor: "full" },
            guestCli: { source: "home-payload", line: "0.3" },
        });
        // A process that never declared its flavour does not guess one.
        expect(resolveServerUrlCapabilitiesFeature({}).capabilities).toEqual({ serverRelease: { version: packageJson.version }, guestCli: { source: "home-payload", line: "0.3" } });
    });
});
