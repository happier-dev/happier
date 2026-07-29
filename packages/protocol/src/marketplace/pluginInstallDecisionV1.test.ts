import { describe, expect, it } from 'vitest';

import { HostPrivatePluginInstallDecisionV1Schema } from './pluginInstallDecisionV1';

describe('HostPrivatePluginInstallDecisionV1Schema', () => {
  it('is absent from the protocol root public surface', async () => {
    const publicProtocol = await import('../index.js');
    expect(publicProtocol).not.toHaveProperty('HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD');
    expect(publicProtocol).not.toHaveProperty('HostPrivatePluginInstallDecisionV1Schema');
  }, 30_000);

  it('requires bounded UI-created evidence only for positive decisions', () => {
    expect(HostPrivatePluginInstallDecisionV1Schema.parse({
      v: 1,
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'ui-interaction-1',
        occurredAtMs: 42,
      },
      optionalSelections: [{ accessId: 'workspace', selected: false }],
    })).toEqual({
      v: 1,
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'ui-interaction-1',
        occurredAtMs: 42,
      },
      optionalSelections: [{ accessId: 'workspace', selected: false }],
    });
    expect(HostPrivatePluginInstallDecisionV1Schema.parse({
      v: 1,
      pendingChangeId: 'pending-2',
      decision: 'cancel',
    })).toEqual({
      v: 1,
      pendingChangeId: 'pending-2',
      decision: 'cancel',
    });

    for (const invalid of [
      {
        v: 1,
        pendingChangeId: 'pending-1',
        decision: 'installAndTrust',
        optionalSelections: [],
      },
      {
        v: 1,
        pendingChangeId: 'pending-1',
        decision: 'installAndTrust',
        optionalSelections: [
          { accessId: 'workspace', selected: false },
          { accessId: 'workspace', selected: true },
        ],
      },
      {
        v: 1,
        pendingChangeId: 'pending-1',
        decision: 'cancel',
        optionalSelections: [],
      },
    ]) {
      expect(HostPrivatePluginInstallDecisionV1Schema.safeParse(invalid).success).toBe(false);
    }
  });
});
