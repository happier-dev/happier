import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { projectReleasedSessionHandoffRequestForMethod } from './predecessorCompatibility';

describe('released session handoff request compatibility', () => {
  it('freezes unversioned request schemas while leaving V3 method-discriminated', () => {
    const releasedStart = {
      sessionId: 'session-1',
      sourceMachineId: 'machine-1',
      targetMachineId: 'machine-2',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['server_routed_stream'],
      workspaceTransfer: {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    };

    expect(projectReleasedSessionHandoffRequestForMethod(
      RPC_METHODS.DAEMON_SESSION_HANDOFF_START,
      releasedStart,
    )).toEqual({ accepted: true, input: releasedStart });
    expect(projectReleasedSessionHandoffRequestForMethod(
      RPC_METHODS.DAEMON_SESSION_HANDOFF_START,
      { ...releasedStart, currentOnly: true },
    )).toEqual({ accepted: false, response: { ok: false, errorCode: 'invalid_request' } });
    expect(projectReleasedSessionHandoffRequestForMethod(
      RPC_METHODS.DAEMON_SESSION_HANDOFF_START,
      {
        ...releasedStart,
        workspaceTransfer: { ...releasedStart.workspaceTransfer, currentOnly: true },
      },
    )).toEqual({ accepted: false, response: { ok: false, errorCode: 'invalid_request' } });

    const currentV3 = { ...releasedStart, currentOnly: true };
    expect(projectReleasedSessionHandoffRequestForMethod(
      RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3,
      currentV3,
    )).toEqual({ accepted: true, input: currentV3 });
  });
});
