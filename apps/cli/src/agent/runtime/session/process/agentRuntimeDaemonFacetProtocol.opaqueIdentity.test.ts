import { describe, expect, it } from 'vitest';

import { AgentRuntimeDaemonExternalSessionFollowEventV1Schema, RunnerAgentDaemonExternalSessionRefV1Schema } from './agentRuntimeDaemonFacetProtocol';

// The Agent minted these bytes. The runner/daemon IPC seam transports the id
// back to that Agent, so a schema that re-canonicalizes it silently asks the
// Agent for a session it never issued.
const OPAQUE_REMOTE_SESSION_ID = '  provider\nses/AB+cd==  ';

describe('runner/daemon External Sessions IPC identity', () => {
  it('transports an opaque remote session id byte-exact through the session ref', () => {
    const parsed = RunnerAgentDaemonExternalSessionRefV1Schema.parse({
      agentId: 'acme.provider',
      remoteSessionId: OPAQUE_REMOTE_SESSION_ID,
      sourceId: 'acme-source',
    });

    expect(parsed.remoteSessionId).toBe(OPAQUE_REMOTE_SESSION_ID);
  });

  it('rejects a whitespace-only remote session id', () => {
    expect(RunnerAgentDaemonExternalSessionRefV1Schema.safeParse({
      agentId: 'acme.provider',
      remoteSessionId: '   \n  ',
      sourceId: 'acme-source',
    }).success).toBe(false);
  });

  it('keeps the Happier-owned source id canonicalized', () => {
    // `sourceId` names a plugin-declared contribution, not an Agent-minted
    // identity, so it keeps its existing canonicalization.
    expect(RunnerAgentDaemonExternalSessionRefV1Schema.parse({
      agentId: 'acme.provider',
      remoteSessionId: OPAQUE_REMOTE_SESSION_ID,
      sourceId: '  acme-source  ',
    }).sourceId).toBe('acme-source');
  });
  it('retains the admitted source and exact media fact reference across the private follow transport', () => {
    const event = {
      kind: 'data', providerSessionId: 'native-1', source: { kind: 'claudeConfig', projectId: 'project' },
      fromCursor: null, nextCursor: 'cursor-1',
      items: [{ id: 'claude:000000000000:tool_result:0', kind: 'event', timestampMs: 10,
        toolResultMedia: { sourceMessageId: 'claude-jsonl:main:user:image-1', toolCallId: 'read-1' },
        data: { role: 'agent', content: { type: 'acp', agentId: 'claude', data: {
          type: 'tool-result', callId: 'read-1', output: [{ type: 'image' }],
        } } },
      }],
    };
    expect(AgentRuntimeDaemonExternalSessionFollowEventV1Schema.parse(JSON.parse(JSON.stringify(event))))
      .toEqual(event);
  });

});
