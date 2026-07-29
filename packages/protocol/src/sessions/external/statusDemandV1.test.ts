import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
  EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1,
  ExternalSessionStatusDemandDaemonMessageV1Schema,
  ExternalSessionStatusDemandReplaceV1Schema,
  buildExternalSessionStatusDemandReplaceV1,
  isExternalSessionStatusDemandRevisionNewerV1,
} from './statusDemandV1';

describe('external-session status demand v1', () => {
  it('coalesces one bounded replace-set by current link with the highest demand', () => {
    expect(EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1).toBe('external-session-status-demand-v1');
    expect(buildExternalSessionStatusDemandReplaceV1({
      revision: 7,
      entries: [
        {
          sessionId: 'session-2',
          machineId: 'machine-1',
          linkGeneration: 'generation-1',
          demand: 'loaded',
        },
        {
          sessionId: 'session-1',
          machineId: 'machine-1',
          linkGeneration: 'generation-1',
          demand: 'visible',
        },
        {
          sessionId: 'session-1',
          machineId: 'machine-1',
          linkGeneration: 'generation-1',
          demand: 'open',
        },
        {
          sessionId: 'session-1',
          machineId: 'machine-1',
          linkGeneration: 'generation-2',
          demand: 'loaded',
        },
      ],
    })).toEqual({
      v: 1,
      type: 'replace',
      revision: 7,
      entries: [
        {
          sessionId: 'session-1',
          machineId: 'machine-1',
          linkGeneration: 'generation-1',
          demand: 'open',
        },
        {
          sessionId: 'session-1',
          machineId: 'machine-1',
          linkGeneration: 'generation-2',
          demand: 'loaded',
        },
        {
          sessionId: 'session-2',
          machineId: 'machine-1',
          linkGeneration: 'generation-1',
          demand: 'loaded',
        },
      ],
    });

    expect(ExternalSessionStatusDemandReplaceV1Schema.safeParse({
      v: 1,
      type: 'replace',
      revision: 7,
      entries: [
        {
          sessionId: 'session-1',
          machineId: 'machine-1',
          linkGeneration: 'generation-1',
          demand: 'visible',
        },
        {
          sessionId: 'session-1',
          machineId: 'machine-1',
          linkGeneration: 'generation-1',
          demand: 'open',
        },
      ],
    }).success).toBe(false);
  });

  it('keeps client identity and daemon-derivable link identity out of the ingress message', () => {
    const base = {
      v: 1,
      type: 'replace',
      revision: 1,
      entries: [{
        sessionId: 'session-1',
        machineId: 'machine-1',
        linkGeneration: 'generation-1',
        demand: 'visible',
      }],
    } as const;

    expect(ExternalSessionStatusDemandReplaceV1Schema.parse(base)).toEqual(base);
    expect(ExternalSessionStatusDemandReplaceV1Schema.safeParse({
      ...base,
      clientConnectionId: 'caller-chosen',
    }).success).toBe(false);
    expect(ExternalSessionStatusDemandReplaceV1Schema.safeParse({
      ...base,
      entries: [{
        ...base.entries[0],
        qualifiedLinkIdentity: {
          agentId: 'codex',
          remoteSessionId: 'remote-1',
        },
      }],
    }).success).toBe(false);
    expect(ExternalSessionStatusDemandReplaceV1Schema.safeParse({
      ...base,
      entries: [{
        ...base.entries[0],
        transcriptCursor: 'cursor-1',
      }],
    }).success).toBe(false);
  });

  it('caps payload work above the existing 200-row native eager-subscription ceiling', () => {
    const entries = Array.from(
      { length: EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1 + 1 },
      (_, index) => ({
        sessionId: `session-${index}`,
        machineId: 'machine-1',
        linkGeneration: 'generation-1',
        demand: 'loaded' as const,
      }),
    );

    expect(() => buildExternalSessionStatusDemandReplaceV1({
      revision: 2,
      entries,
    })).toThrow();
    expect(ExternalSessionStatusDemandReplaceV1Schema.safeParse({
      v: 1,
      type: 'replace',
      revision: 2,
      entries,
    }).success).toBe(false);
  });

  it('defines one daemon event for replace and transport-disconnect cleanup', () => {
    expect(ExternalSessionStatusDemandDaemonMessageV1Schema.parse({
      v: 1,
      type: 'replace',
      clientConnectionId: 'socket-1',
      revision: 3,
      entries: [{
        sessionId: 'session-1',
        linkGeneration: 'generation-1',
        demand: 'open',
      }],
    })).toEqual({
      v: 1,
      type: 'replace',
      clientConnectionId: 'socket-1',
      revision: 3,
      entries: [{
        sessionId: 'session-1',
        linkGeneration: 'generation-1',
        demand: 'open',
      }],
    });
    expect(ExternalSessionStatusDemandDaemonMessageV1Schema.parse({
      v: 1,
      type: 'disconnect',
      clientConnectionId: 'socket-1',
    })).toEqual({
      v: 1,
      type: 'disconnect',
      clientConnectionId: 'socket-1',
    });
    expect(ExternalSessionStatusDemandDaemonMessageV1Schema.parse({
      v: 1,
      type: 'replace',
      clientConnectionId: 'socket-2',
      revision: 4,
      entries: [],
    })).toMatchObject({
      clientConnectionId: 'socket-2',
      entries: [],
    });
  });

  it('accepts only newer safe revisions for latest-replace semantics', () => {
    expect(isExternalSessionStatusDemandRevisionNewerV1(null, 0)).toBe(true);
    expect(isExternalSessionStatusDemandRevisionNewerV1(3, 4)).toBe(true);
    expect(isExternalSessionStatusDemandRevisionNewerV1(3, 3)).toBe(false);
    expect(isExternalSessionStatusDemandRevisionNewerV1(3, 2)).toBe(false);
  });
});
