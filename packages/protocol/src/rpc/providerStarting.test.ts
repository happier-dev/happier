import { describe, expect, it } from 'vitest';

import { RPC_METHODS, resolveSocketRpcProviderStartingMethod } from './index';

describe('resolveSocketRpcProviderStartingMethod', () => {
  it.each([
    RPC_METHODS.SPAWN_HAPPY_SESSION,
    RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    RPC_METHODS.SESSION_SPAWN_NEW,
    RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
    RPC_METHODS.SESSION_FORK,
    RPC_METHODS.SESSION_FORK_PROVIDER_SAFE,
    RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH,
    RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
    RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2,
    RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL,
    RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
    RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
    RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
    RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER,
    RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
    RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
  ])('resolves provider-starting method %s with or without a machine prefix', (method) => {
    expect(resolveSocketRpcProviderStartingMethod(method)).toBe(method);
    expect(resolveSocketRpcProviderStartingMethod(`machine-1:${method}`)).toBe(method);
  });

  it('does not classify read-only machine RPCs as provider-starting', () => {
    expect(resolveSocketRpcProviderStartingMethod(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET)).toBeNull();
    expect(resolveSocketRpcProviderStartingMethod(`machine-1:${RPC_METHODS.CAPABILITIES_INVOKE}`)).toBeNull();
  });
});
