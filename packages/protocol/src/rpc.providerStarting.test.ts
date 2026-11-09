import { describe, expect, it } from "vitest";

import { RPC_METHODS, resolveSocketRpcProviderStartingMethod } from "./rpc";

describe("resolveSocketRpcProviderStartingMethod", () => {
  it.each([
    RPC_METHODS.SPAWN_HAPPY_SESSION,
    RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    RPC_METHODS.SPAWN_HAPPY_SESSION_ROLE_V1,
    RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
    RPC_METHODS.SESSION_FORK,
    RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH,
    RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
    RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL,
    RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
    RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
    RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2,
    RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER,
    RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST,
  ])("resolves provider-starting method %s with or without a machine prefix", (method) => {
    expect(resolveSocketRpcProviderStartingMethod(method)).toBe(method);
    expect(resolveSocketRpcProviderStartingMethod(`machine-1:${method}`)).toBe(method);
  });

  it("does not classify read-only machine RPCs as provider-starting", () => {
    expect(resolveSocketRpcProviderStartingMethod(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET)).toBeNull();
    expect(resolveSocketRpcProviderStartingMethod(`machine-1:${RPC_METHODS.CAPABILITIES_INVOKE}`)).toBeNull();
  });
});
