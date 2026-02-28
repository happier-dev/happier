import { describe, expect, it } from "vitest";

import { parseTailscaleServeHttpsBaseUrlForPort } from "./tailscaleServeStatusParse";

describe("parseTailscaleServeHttpsBaseUrlForPort", () => {
    it("returns https base url when it proxies the target port", () => {
        const status = [
            "https://my-machine.tailnet.ts.net",
            "|-- / proxy http://127.0.0.1:3005",
            "",
        ].join("\n");
        expect(parseTailscaleServeHttpsBaseUrlForPort(status, 3005)).toBe("https://my-machine.tailnet.ts.net");
    });

    it("returns null when no proxy matches the target port", () => {
        const status = [
            "https://my-machine.tailnet.ts.net",
            "|-- / proxy http://127.0.0.1:9999",
            "",
        ].join("\n");
        expect(parseTailscaleServeHttpsBaseUrlForPort(status, 3005)).toBeNull();
    });

    it("returns the matching base url when multiple sections exist", () => {
        const status = [
            "https://a.tailnet.ts.net",
            "|-- / proxy http://127.0.0.1:1234",
            "",
            "https://b.tailnet.ts.net",
            "|-- / proxy http://127.0.0.1:3005",
            "",
        ].join("\n");
        expect(parseTailscaleServeHttpsBaseUrlForPort(status, 3005)).toBe("https://b.tailnet.ts.net");
    });
});
