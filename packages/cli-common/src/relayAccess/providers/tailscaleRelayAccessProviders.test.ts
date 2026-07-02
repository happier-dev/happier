import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../tailscale/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../tailscale/index.js")>("../../tailscale/index.js");
    return {
    ...actual,
    runTailscaleStatusJson: vi.fn(),
    runTailscaleServeStatus: vi.fn(),
    runTailscaleServeEnable: vi.fn(),
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

  it("tailscaleFunnel bounds status commands to the provided timeout", async () => {
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
    await tailscaleFunnelRelayAccessProvider.status({
      config: { providerId: "tailscaleFunnel" },
      ctx: { env: process.env, upstreamUrl: null },
      timeoutMs: 25,
    });

    expect(runTailscaleStatusJson).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 25 }),
      expect.any(Object),
    );
    expect(runTailscaleFunnelStatus).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 25 }),
      expect.any(Object),
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

  it("tailscaleFunnel bounds configure commands to the provided deadline and signal", async () => {
    const { runTailscaleFunnelEnable } = await import("../../tailscale/index.js");
    vi.mocked(runTailscaleFunnelEnable).mockResolvedValue({
      approvalUrl: null,
      httpsUrl: "https://my-machine.tailnet.ts.net",
      rawStatus: "ok",
    });

    const abortController = new AbortController();
    const now = vi.fn().mockReturnValueOnce(100);
    const deadline = {
      startedAt: 0,
      deadlineAt: 1000,
      now,
      signal: abortController.signal,
    };

    const { tailscaleFunnelRelayAccessProvider } = await import("./tailscaleFunnel/index.js");
    await tailscaleFunnelRelayAccessProvider.configure?.({
      config: { providerId: "tailscaleFunnel" },
      ctx: { env: process.env, upstreamUrl: "http://127.0.0.1:3005" },
      deadline,
      signal: abortController.signal,
    });

    expect(runTailscaleFunnelEnable).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 900,
        signal: abortController.signal,
      }),
      expect.any(Object),
    );
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

  it("tailscaleServe bounds status commands to the provided timeout", async () => {
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
    await tailscaleServeRelayAccessProvider.status({
      config: { providerId: "tailscaleServe" },
      ctx: { env: process.env, upstreamUrl: null },
      timeoutMs: 25,
    });

    expect(runTailscaleStatusJson).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 25 }),
      expect.any(Object),
    );
    expect(runTailscaleServeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 25 }),
      expect.any(Object),
    );
  });

  it("tailscaleServe bounds configure commands to the provided deadline and signal", async () => {
    const { runTailscaleServeEnable } = await import("../../tailscale/index.js");
    vi.mocked(runTailscaleServeEnable).mockResolvedValue({
      approvalUrl: null,
      httpsUrl: "https://my-machine.tailnet.ts.net",
      rawStatus: "ok",
    });

    const abortController = new AbortController();
    const now = vi.fn().mockReturnValueOnce(100);
    const deadline = {
      startedAt: 0,
      deadlineAt: 1000,
      now,
      signal: abortController.signal,
    };

    const { tailscaleServeRelayAccessProvider } = await import("./tailscaleServe/index.js");
    await tailscaleServeRelayAccessProvider.configure?.({
      config: { providerId: "tailscaleServe" },
      ctx: { env: process.env, upstreamUrl: "http://127.0.0.1:3005" },
      deadline,
      signal: abortController.signal,
    });

    expect(runTailscaleServeEnable).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 900,
        signal: abortController.signal,
      }),
      expect.any(Object),
    );
  });

  it("tailscaleServe recomputes remaining time from one provider deadline for serial status commands", async () => {
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

    const now = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(950);
    const deadline = {
      startedAt: 0,
      deadlineAt: 1000,
      now,
    };

    const { tailscaleServeRelayAccessProvider } = await import("./tailscaleServe/index.js");
    const params = {
      config: { providerId: "tailscaleServe" as const },
      ctx: { env: process.env, upstreamUrl: null },
      deadline,
    };
    await tailscaleServeRelayAccessProvider.status(params);

    expect(runTailscaleStatusJson).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 900 }),
      expect.any(Object),
    );
    expect(runTailscaleServeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 50 }),
      expect.any(Object),
    );
  });

  it("tailscaleServe returns sanitized typed diagnostics when a provider command fails", async () => {
    const { runTailscaleStatusJson } = await import("../../tailscale/index.js");
    vi.mocked(runTailscaleStatusJson).mockRejectedValue(
      new Error("stderr: token=secret-token-123 home=/Users/alice/.config/tailscale"),
    );

    const { tailscaleServeRelayAccessProvider } = await import("./tailscaleServe/index.js");
    const status = await tailscaleServeRelayAccessProvider.status({
      config: { providerId: "tailscaleServe" },
      ctx: { env: process.env, upstreamUrl: null },
    });

    expect(status).toEqual({
      state: "error",
      details: {
        code: "provider_command_failed",
        phase: "tailscale.status",
        providerId: "tailscaleServe",
        message: "Provider command failed.",
        developerMessage: expect.not.stringContaining("secret-token-123"),
      },
    });
    expect(JSON.stringify(status.details)).not.toContain("/Users/alice");
  });

  it("tailscaleFunnel returns the share url for the requested upstream even when funnel status includes other mappings first", async () => {
    const { runTailscaleStatusJson, runTailscaleFunnelStatus } = await import("../../tailscale/index.js");
    vi.mocked(runTailscaleStatusJson).mockResolvedValue({
      backendState: "Running",
      authUrl: null,
      dnsName: "my-machine.tailnet.ts.net",
      tailnetName: "tailnet.ts.net",
      tailscaleIps: [],
      loggedIn: true,
    });
    vi.mocked(runTailscaleFunnelStatus).mockResolvedValue([
      "https://other.tailnet.ts.net",
      "|-- / proxy http://127.0.0.1:9999",
      "",
      "https://my-machine.tailnet.ts.net",
      "|-- / proxy http://127.0.0.1:3005",
    ].join("\n"));

    const { tailscaleFunnelRelayAccessProvider } = await import("./tailscaleFunnel/index.js");
    const status = await tailscaleFunnelRelayAccessProvider.status({
      config: { providerId: "tailscaleFunnel" },
      ctx: { env: process.env, upstreamUrl: "http://127.0.0.1:3005" },
    });

    expect(status).toEqual({
      state: "enabled",
      shareUrl: "https://my-machine.tailnet.ts.net",
    });
  });
});
