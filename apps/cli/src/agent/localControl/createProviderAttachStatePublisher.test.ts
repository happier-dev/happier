import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

import { createProviderAttachStatePublisher } from './createProviderAttachStatePublisher';

describe('createProviderAttachStatePublisher', () => {
  it('publishes shared writable local-control state for provider-attach sessions', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_opencode_1',
      encryptionMode: 'plain',
      agentState: JSON.stringify({ existing: 'value' }),
      agentStateVersion: 4,
      metadata: JSON.stringify({ flavor: 'opencode' }),
    });
    const socket = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const updateSessionAgentStateWithAckFn = vi.fn(async (params: any) => {
      const next = params.handler(params.getAgentState() ?? {});
      params.setAgentState(next);
      params.setAgentStateVersion(params.getAgentStateVersion() + 1);
    });

    const publisher = createProviderAttachStatePublisher({
      agentId: 'opencode',
      sessionId: 'sid_opencode_1',
      credentials,
      rawSession,
      createSessionScopedSocketFn: () => socket as any,
      waitForSocketConnectFn: async () => {},
      updateSessionAgentStateWithAckFn,
    });

    expect(publisher).not.toBeNull();
    await publisher?.publishAttached(true);
    await publisher?.publishAttached(false);

    expect(updateSessionAgentStateWithAckFn).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'sid_opencode_1',
      getAgentStateVersion: expect.any(Function),
      setAgentStateVersion: expect.any(Function),
    }));

    const firstState = updateSessionAgentStateWithAckFn.mock.calls[0]?.[0]?.handler({ existing: 'value' });
    expect(firstState).toEqual({
      existing: 'value',
      controlledByUser: false,
      localControl: {
        attached: true,
        topology: 'shared',
        remoteWritable: true,
        canAttach: true,
        canDetach: true,
      },
    });

    const secondState = updateSessionAgentStateWithAckFn.mock.calls[1]?.[0]?.handler(firstState);
    expect(secondState).toEqual({
      existing: 'value',
      controlledByUser: false,
      localControl: {
        attached: false,
        topology: 'shared',
        remoteWritable: true,
        canAttach: true,
        canDetach: false,
      },
    });
    expect(socket.connect).toHaveBeenCalledTimes(2);
    expect(socket.disconnect).toHaveBeenCalledTimes(2);
  });

  it('returns null for agents without provider-native attach', () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_claude_1',
      encryptionMode: 'plain',
      metadata: JSON.stringify({ flavor: 'claude' }),
    });

    const publisher = createProviderAttachStatePublisher({
      agentId: 'claude',
      sessionId: 'sid_claude_1',
      credentials,
      rawSession,
    });

    expect(publisher).toBeNull();
  });
});
