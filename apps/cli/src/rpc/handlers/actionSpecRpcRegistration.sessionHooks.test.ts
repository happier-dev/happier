import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  EXTERNAL_SESSION_REQUIRED_GENERIC_RPC_SCOPES,
  isActionSpecRpcMethodInScope,
} from './actionSpecRpcRegistration';

describe('session-hook management ActionSpec RPC scope', () => {
  it.each([
    RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET,
    RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_INSTALL,
    RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_DISABLE,
    RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_ENABLE,
    RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_UNINSTALL,
  ])('includes %s in the existing External Sessions registrar', (method) => {
    expect(EXTERNAL_SESSION_REQUIRED_GENERIC_RPC_SCOPES.some(
      (scope) => isActionSpecRpcMethodInScope(method, scope),
    )).toBe(true);
  });
});
