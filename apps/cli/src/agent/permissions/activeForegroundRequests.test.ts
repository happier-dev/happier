import { expect, it } from 'vitest';
import { AgentStateSchema } from '@happier-dev/session-core';
import { readActiveForegroundAgentRequests } from './activeForegroundRequests';

it('returns only foreground originals with a usable occurrence timestamp', () => {
  const state = AgentStateSchema.parse({ requests: {
    missing: { tool: 'AskUserQuestion', arguments: {} },
    absent: { tool: 'AskUserQuestion', arguments: {}, createdAt: null },
    valid: { tool: 'AskUserQuestion', arguments: {}, createdAt: 0 },
    child: { tool: 'AskUserQuestion', arguments: {}, createdAt: 1, sidechainId: 'child' },
  } });
  expect(readActiveForegroundAgentRequests(state).map(([id, request]) => [id, request.createdAt]))
    .toEqual([['valid', 0]]);
});
