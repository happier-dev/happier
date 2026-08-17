import { describe, expect, it } from 'vitest';

import {
  RPC_METHODS,
  resolveSocketRpcProviderStartingMethod,
  resolveSocketRpcSessionWriteAuthorizationMethod,
} from './rpc.js';

/**
 * `session.agentTransition` stops the Session's current runtime, rewrites its
 * current Agent, and admits a user message. That is a Session write and a
 * provider start, so it must carry exactly the same canonical edit proof and
 * starting classification as its siblings — not a transition-local rule, and
 * not a weaker unclassified path that reaches the daemon with no proof at all.
 */
describe('session.agentTransition RPC classification', () => {
  it('requires the canonical Session-write edit proof, prefixed or bare', () => {
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(RPC_METHODS.SESSION_AGENT_TRANSITION))
      .toBe(RPC_METHODS.SESSION_AGENT_TRANSITION);
    expect(
      resolveSocketRpcSessionWriteAuthorizationMethod(`machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`),
    ).toBe(RPC_METHODS.SESSION_AGENT_TRANSITION);
  });

  it('is a provider-starting method, like every other Session start', () => {
    expect(resolveSocketRpcProviderStartingMethod(RPC_METHODS.SESSION_AGENT_TRANSITION))
      .toBe(RPC_METHODS.SESSION_AGENT_TRANSITION);
    expect(
      resolveSocketRpcProviderStartingMethod(`machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`),
    ).toBe(RPC_METHODS.SESSION_AGENT_TRANSITION);
  });

  it('leaves the read-only continuation inspection unclassified', () => {
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(RPC_METHODS.SESSION_CONTINUATION_INSPECT))
      .toBeNull();
    expect(resolveSocketRpcProviderStartingMethod(RPC_METHODS.SESSION_CONTINUATION_INSPECT))
      .toBeNull();
  });
});
