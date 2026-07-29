import { describe, expect, it } from 'vitest';

import {
  resolveSpawnConnectedServicesDefaultDisposition,
  resolveSpawnConnectedServicesDefaults,
} from './spawnConnectedServicesDefaults';

describe('resolveSpawnConnectedServicesDefaults', () => {
  it('preserves an exact connected group selection while availability is deferred to the daemon', () => {
    expect(resolveSpawnConnectedServicesDefaults({
      agentId: 'claude',
      accountSettings: {
        connectedServicesDefaultAuthByAgentIdV1: {
          v: 1,
          bindingsByAgentId: {
            claude: {
              v: 1,
              bindingsByServiceId: {
                'claude-subscription': {
                  source: 'connected',
                  selection: 'group',
                  groupId: 'team',
                },
              },
            },
          },
        },
      },
    })).toEqual({
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'team',
        },
        anthropic: { source: 'native' },
      },
    });
  });

  it('preserves protocol-tolerant native fallback for a malformed persisted default blob', () => {
    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex',
      accountSettings: {},
    })).toEqual({ kind: 'native' });
    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex',
      accountSettings: {
        connectedServicesDefaultAuthByAgentIdV1: { v: 999 },
      },
    })).toEqual({ kind: 'native' });
  });
});
