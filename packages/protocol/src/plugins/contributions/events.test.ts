import { describe, expect, it } from 'vitest';

import {
  AGENT_SESSION_RUNTIME_EVENT_KINDS_V1,
  type AgentSessionRuntimeEventV1,
} from '../../runtime/agentSessionV1.js';
import { PluginEventContributionV1Schema } from './events.js';

describe('plugin event contributions', () => {
  it('reserves every canonical agent runtime event id from plugin publication', () => {
    const exhaustive: Exclude<
      AgentSessionRuntimeEventV1['kind'],
      typeof AGENT_SESSION_RUNTIME_EVENT_KINDS_V1[number]
    > extends never ? true : false = true;
    expect(exhaustive).toBe(true);
    for (const id of AGENT_SESSION_RUNTIME_EVENT_KINDS_V1) {
      expect(PluginEventContributionV1Schema.safeParse({
        id,
        kind: 'event',
        title: id,
      }).success).toBe(false);
    }
    expect(PluginEventContributionV1Schema.safeParse({
      id: 'workspace-changed',
      kind: 'event',
      title: 'Workspace changed',
    }).success).toBe(true);
  });
});
