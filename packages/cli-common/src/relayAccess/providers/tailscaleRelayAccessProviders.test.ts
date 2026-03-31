import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../tailscale/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../tailscale/index.js")>("../../tailscale/index.js");
  return {
    ...actual,
    runTailscaleStatusJson: vi.fn(),
    runTailscaleServeStatus: vi.fn(),
    runTailscaleFunnelStatus: vi.fn(),
    runTailscaleFunnelEnable: vi.fn(),
    runTailscaleFunnelReset: vi.fn(),
  };
});

describe("tailscale relay access providers", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("tailscaleFunnel returns needs_auth when not logged in", async () => {
    const { runTailscaleStatusJson } = await import("../../tailscale/index.js");
    vi.mocked(runTailscaleStatusJson).mockResolvedValue({
      backendState: "NeedsLogin",
      authUrl: "https://login.example.test",
      dnsName: null,
      tailnetName: null,
      tailscaleIps: [],
      loggedIn: false,
    });

    const { tailscaleFunnelRelayAccessProvider } = await import("./tailscaleFunnel/index.js");
    const status = await tailscaleFunnelRelayAccessProvider.status({ config: { providerId: "tailscaleFunnel" }, ctx: { env: process.env, upstreamUrl: null } });
    expect(status).toEqual(
      expect.objectContaining({
        state: "needs_auth",
      }),
    );
  });

  it("tailscaleFunnel returns enabled with a shareUrl when logged in", async () => {
    const { runTailscaleStatusJson, runTailscaleFunnelStatus } = await import("../../tailscale/index.js");
    vi.mocked(runTailscaleStatusJson).mockResolvedValue({
      backendState: "Running",
      authUrl: null,
      dnsName: "my-machine.tailnet.ts.net",
      tailnetName: "tailnet.ts.net",
      tailscaleIps: [],
      loggedIn: true,
    });
    vi.mocked(runTailscaleFunnelStatus).mockResolvedValue(
      "https://my-machine.tailnet.ts.net\n|-- / proxy http://127.0.0.1:3005",
    );

    const { tailscaleFunnelRelayAccessProvider } = await import("./tailscaleFunnel/index.js");
    const status = await tailscaleFunnelRelayAccessProvider.status({ config: { providerId: "tailscaleFunnel" }, ctx: { env: process.env, upstreamUrl: null } });
    expect(status).toEqual(
      expect.objectContaining({
        state: "enabled",
        shareUrl: "https://my-machine.tailnet.ts.net",
      }),
    );
  });

  it("tailscaleFunnel returns disabled when funnel is not configured", async () => {
    const { runTailscaleStatusJson, runTailscaleFunnelStatus } = await import("../../tailscale/index.js");
    vi.mocked(runTailscaleStatusJson).mockResolvedValue({
      backendState: "Running",
      authUrl: null,
      dnsName: "my-machine.tailnet.ts.net",
      tailnetName: "tailnet.ts.net",
      tailscaleIps: [],
      loggedIn: true,
    });
    vi.mocked(runTailscaleFunnelStatus).mockResolvedValue("No funnel config");

    const { tailscaleFunnelRelayAccessProvider } = await import("./tailscaleFunnel/index.js");
    const status = await tailscaleFunnelRelayAccessProvider.status({ config: { providerId: "tailscaleFunnel" }, ctx: { env: process.env, upstreamUrl: null } });
    expect(status).toEqual(
      expect.objectContaining({
        state: "disabled",
      }),
    );
  });

  it("tailscaleFunnel disable resets the funnel state", async () => {
    const { runTailscaleFunnelReset } = await import("../../tailscale/index.js");
    vi.mocked(runTailscaleFunnelReset).mockResolvedValueOnce(undefined);

    const { tailscaleFunnelRelayAccessProvider } = await import("./tailscaleFunnel/index.js");
    await tailscaleFunnelRelayAccessProvider.disable?.({
      config: { providerId: "tailscaleFunnel" },
      ctx: { env: process.env, upstreamUrl: null },
    });

    expect(runTailscaleFunnelReset).toHaveBeenCalledTimes(1);
  });

  it("tailscaleFunnel configures funnel for the upstream url", async () => {
    const { runTailscaleFunnelEnable } = await import("../../tailscale/index.js");
    vi.mocked(runTailscaleFunnelEnable).mockResolvedValue({
      approvalUrl: null,
      httpsUrl: "https://my-machine.tailnet.ts.net",
      rawStatus: "ok",
    });

    const { tailscaleFunnelRelayAccessProvider } = await import("./tailscaleFunnel/index.js");
    const ctx = { env: process.env, upstreamUrl: "http://127.0.0.1:3005" };
    const res = await tailscaleFunnelRelayAccessProvider.configure?.({ config: { providerId: "tailscaleFunnel" }, ctx });
    expect(runTailscaleFunnelEnable).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ state: "enabled", shareUrl: "https://my-machine.tailnet.ts.net" });
  });

  it("tailscaleServe returns enabled with a shareUrl when logged in", async () => {
    const { runTailscaleStatusJson, runTailscaleServeStatus } = await import("../../tailscale/index.js");
    vi.mocked(runTailscaleStatusJson).mockResolvedValue({
      backendState: "Running",
      authUrl: null,
      dnsName: "my-machine.tailnet.ts.net",
      tailnetName: "tailnet.ts.net",
      tailscaleIps: [],
      loggedIn: true,
    });
    vi.mocked(runTailscaleServeStatus).mockResolvedValue(
      "https://my-machine.tailnet.ts.net\n|-- / proxy http://127.0.0.1:3005",
    );

    const { tailscaleServeRelayAccessProvider } = await import("./tailscaleServe/index.js");
    const status = await tailscaleServeRelayAccessProvider.status({ config: { providerId: "tailscaleServe" }, ctx: { env: process.env, upstreamUrl: null } });
    expect(status).toEqual(
      expect.objectContaining({
        state: "enabled",
        shareUrl: "https://my-machine.tailnet.ts.net",
      }),
    );
  });
});
