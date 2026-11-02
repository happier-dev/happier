import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '../../rpc/methods.js';
import { resolveMachineRpcRoutePolicy } from '../../machines/peer/mediation/rpc/routePolicyV1.js';

describe('native browser credential authority', () => {
  it('requires Manage for source enumeration, cookie reads and private profile insertion', () => {
    for (const method of [RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES,
      RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIE_SOURCE_READ, RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIES_APPLY]) {
      expect(resolveMachineRpcRoutePolicy(method).sharedMachineAccess).toBe('manage');
    }
  });
});
