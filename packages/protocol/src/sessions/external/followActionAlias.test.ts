import { describe, expect, it } from 'vitest';

import { ActionIdSchema, normalizeLegacyActionId } from '../../actions/actionIds.js';
import { getActionSpec } from '../../actions/actionSpecs.js';
import { RPC_METHODS } from '../../rpc/index.js';

describe('external-session background-follow action compatibility', () => {
  it('does not normalize the never-released prior external follow-policy id', () => {
    expect(ActionIdSchema.safeParse('sessions.external.backgroundFollow.set').success).toBe(true);
    expect(ActionIdSchema.safeParse('sessions.external.followPolicy.set').success).toBe(false);
    expect(normalizeLegacyActionId('sessions.external.followPolicy.set')).toBe(
      'sessions.external.followPolicy.set',
    );
  });

  it('retains only the predecessor direct RPC identity outside the canonical method', () => {
    const rpcMethods = RPC_METHODS as Record<string, string>;
    expect(rpcMethods.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET).toBe(
      'daemon.externalSessions.backgroundFollow.set',
    );
    expect(rpcMethods.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET).toBeUndefined();

    const spec = getActionSpec('sessions.external.backgroundFollow.set');
    expect(spec.bindings?.rpcMethod).toBe(
      rpcMethods.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
    );
    expect(spec.bindings?.rpcMethodAliases).toBeUndefined();
    expect(rpcMethods.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET_LEGACY).toBe(
      'daemon.directSessions.followPolicy.set',
    );
  });
});
