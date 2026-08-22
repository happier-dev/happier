import { describe, expect, it } from "vitest";

import { resolveTailscaleMachineHttpsUrlFromStatusSnapshot } from "./publicUrl.js";

describe("resolveTailscaleMachineHttpsUrlFromStatusSnapshot", () => {
  it("returns https://<dnsName> when dnsName is present", () => {
    const url = resolveTailscaleMachineHttpsUrlFromStatusSnapshot({
      backendState: "Running",
      authUrl: null,
      dnsName: "my-machine.tailnet.ts.net",
      tailnetName: "tailnet.ts.net",
      tailscaleIps: [],
      loggedIn: true,
      running: true, daemonReachable: true,
    });
    expect(url).toBe("https://my-machine.tailnet.ts.net");
  });

  it("trims trailing dots and rejects names with slashes", () => {
    const url = resolveTailscaleMachineHttpsUrlFromStatusSnapshot({
      backendState: "Running",
      authUrl: null,
      dnsName: "my-machine.tailnet.ts.net.",
      tailnetName: "tailnet.ts.net",
      tailscaleIps: [],
      loggedIn: true,
      running: true, daemonReachable: true,
    });
    expect(url).toBe("https://my-machine.tailnet.ts.net");

    const bad = resolveTailscaleMachineHttpsUrlFromStatusSnapshot({
      backendState: "Running",
      authUrl: null,
      dnsName: "evil.example.test/path",
      tailnetName: "tailnet.ts.net",
      tailscaleIps: [],
      loggedIn: true,
      running: true, daemonReachable: true,
    });
    expect(bad).toBeNull();
  });

  it("returns null when dnsName is missing", () => {
    expect(
      resolveTailscaleMachineHttpsUrlFromStatusSnapshot({
        backendState: "Running",
        authUrl: null,
        dnsName: null,
        tailnetName: null,
        tailscaleIps: [],
        loggedIn: false,
        running: true, daemonReachable: true,
      }),
    ).toBeNull();
  });
});

