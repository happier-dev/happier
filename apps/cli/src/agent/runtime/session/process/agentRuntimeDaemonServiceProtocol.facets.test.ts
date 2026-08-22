import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeDaemonServiceRequestV1Schema,
  AgentRuntimeDaemonServiceResponseV1Schema,
  AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema,
} from './agentRuntimeDaemonServiceProtocol';

const witness = {
  turnId: 'turn-1',
  inputId: 'input-1',
  userMessageSeq: 7,
  userMessageSeqs: [7],
} as const;

function request(operation: unknown) {
  return {
    v: 1,
    context: {
      token: 'A'.repeat(43),
      sessionId: 'session-1',
    },
    operation,
  };
}

describe('Agent runtime daemon-owned session facets protocol', () => {
  it('uses only the rotating bearer and Session identity for daemon-service context', () => {
    const base = request({
      kind: 'voice.authority.snapshot',
      requestId: 'voice-snapshot-1',
    });

    expect(
      AgentRuntimeDaemonServiceRequestV1Schema.safeParse(base).success,
    ).toBe(true);
    expect(
      AgentRuntimeDaemonServiceRequestV1Schema.safeParse({
        ...base,
        context: {
          ...base.context,
          unexpected: true,
        },
      }).success,
    ).toBe(false);
  });

  it('admits one strict runner-owned session-open attestation', () => {
    expect(AgentRuntimeDaemonServiceRequestV1Schema.parse(request({
      kind: 'session.open.attest',
      requestId: 'attest-open-1',
      request: {
        kind: 'fork',
        sessionId: 'session-1',
        cwd: '/child',
        source: {
          sessionId: 'session-parent',
          providerSessionId: 'provider-parent',
          cwd: '/parent',
          target: {
            turnId: 'turn-7',
            providerCheckpoint: {
              kind: 'prompt_index',
              promptIndex: 7,
            },
          },
        },
      },
      providerSessionId: 'provider-child',
    })).operation).toMatchObject({
      kind: 'session.open.attest',
      request: {
        kind: 'fork',
        sessionId: 'session-1',
      },
      providerSessionId: 'provider-child',
    });
  });

  it('keeps only direct Session-open request and provider-Session facts', () => {
    const attestation = {
      request: {
        kind: 'create',
        sessionId: 'session-1',
        cwd: '/workspace',
      },
      providerSessionId: 'provider-1',
    };
    const recorded = {
      ok: true,
      result: {
        kind: 'session.open.attestation',
        status: 'recorded',
      },
    };

    expect(
      AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema
        .parse(attestation),
    ).toEqual(attestation);
    expect(
      AgentRuntimeDaemonServiceResponseV1Schema.parse(recorded),
    ).toEqual(recorded);
  });

  it('admits only the exact External Session control operations', () => {
    const ref = {
      agentId: 'codex',
      sourceId: 'default',
      remoteSessionId: 'remote-session-1',
    } as const;
    const source = { kind: 'codexHome', home: 'user' } as const;
    const operations = [
      {
        kind: 'external_session.follow.open',
        requestId: 'follow-open-1',
        followId: 'follow-1',
        target: {
          kind: 'externalSession',
          ref,
          source,
        },
        cursor: 'cursor-1',
        witness,
      },
      {
        kind: 'external_session.follow.open',
        requestId: 'provider-follow-open-1',
        followId: 'provider-follow-1',
        target: {
          kind: 'providerSession',
          agentId: 'codex',
          providerSessionId: 'remote-session-1',
        },
      },
      {
        kind: 'external_session.follow.next',
        requestId: 'follow-next-1',
        followId: 'follow-1',
        acknowledgeEventId: 'event-1',
        witness,
      },
      {
        kind: 'external_session.follow.next',
        requestId: 'follow-provider-response-1',
        followId: 'follow-1',
        providerResponse: {
          providerRequestId: 'provider-request-1',
          status: 'success',
          result: {
            kind: 'validateSource',
            value: { ok: true, source },
          },
        },
      },
      {
        kind: 'external_session.follow.close',
        requestId: 'follow-close-1',
        followId: 'follow-1',
        acknowledgeEventId: 'event-2',
      },
    ] as const;

    for (const operation of operations) {
      expect(
        AgentRuntimeDaemonServiceRequestV1Schema.safeParse(
          request(operation),
        ).success,
      ).toBe(true);
    }

    expect(
      AgentRuntimeDaemonServiceRequestV1Schema.safeParse(
        request({
          ...operations[0],
          invoke: 'arbitrary',
        }),
      ).success,
    ).toBe(false);
    expect(
      AgentRuntimeDaemonServiceRequestV1Schema.safeParse(
        request({
          ...operations[3],
          providerResponse: {
            ...operations[3].providerResponse,
            unexpected: true,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('admits exactly the six current-global External Session author operations', () => {
    const source = { kind: 'codexHome', home: 'user' } as const;
    const operations = [
      {
        kind: 'external_session.current.resolve_source',
        requestId: 'resolve-source-1',
        agentId: 'codex',
        source,
        witness,
      },
      {
        kind: 'external_session.current.list_candidates',
        requestId: 'list-candidates-1',
        agentId: 'codex',
        source,
        cursor: 'cursor-1',
        limit: 20,
        searchTerm: 'project',
        searchMode: 'fast',
        maxBytes: 65_536,
      },
      {
        kind: 'external_session.current.resolve_link_identity',
        requestId: 'resolve-link-1',
        agentId: 'codex',
        source,
        remoteSessionId: 'remote-session-1',
        metadata: { linkData: { provider: 'codex' } },
      },
      {
        kind: 'external_session.current.resolve_linked_identity',
        requestId: 'resolve-linked-1',
        agentId: 'codex',
        source,
        remoteSessionId: 'remote-session-1',
        metadata: { linkData: { provider: 'codex' } },
      },
      {
        kind: 'external_session.current.page_transcript',
        requestId: 'page-transcript-1',
        agentId: 'codex',
        source,
        remoteSessionId: 'remote-session-1',
        direction: 'older',
        cursor: 'cursor-1',
        maxBytes: 65_536,
        maxItems: 100,
      },
      {
        kind: 'external_session.current.read_after_transcript',
        requestId: 'read-after-1',
        agentId: 'codex',
        source,
        remoteSessionId: 'remote-session-1',
        cursor: 'cursor-1',
        maxBytes: 65_536,
        maxItems: 100,
      },
    ] as const;

    for (const operation of operations) {
      expect(
        AgentRuntimeDaemonServiceRequestV1Schema.safeParse(
          request(operation),
        ).success,
      ).toBe(true);
      expect(
        AgentRuntimeDaemonServiceRequestV1Schema.safeParse(
          request({ ...operation, invoke: 'arbitrary' }),
        ).success,
      ).toBe(false);
    }
    expect(
      AgentRuntimeDaemonServiceRequestV1Schema.safeParse(
        request({
          ...operations[1],
          cursor: 'x'.repeat(32_769),
        }),
      ).success,
    ).toBe(false);
  });

  it('admits only snapshot and retirement wait Voice authority operations', () => {
    expect(
      AgentRuntimeDaemonServiceRequestV1Schema.safeParse(
        request({
          kind: 'voice.authority.snapshot',
          requestId: 'voice-snapshot-1',
        }),
      ).success,
    ).toBe(true);
    expect(
      AgentRuntimeDaemonServiceRequestV1Schema.safeParse(
        request({
          kind: 'voice.authority.waitRetired',
          requestId: 'voice-retired-1',
          provider: {
            pluginId: 'happier.voice.elevenlabs',
            localId: 'conversation',
          },
          providerGeneration: 'voice-generation-1',
          witness,
        }),
      ).success,
    ).toBe(true);
    expect(
      AgentRuntimeDaemonServiceRequestV1Schema.safeParse(
        request({
          kind: 'voice.authority.snapshot',
          requestId: 'voice-snapshot-1',
          provider: {
            pluginId: 'happier.voice.elevenlabs',
            localId: 'conversation',
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('admits strict facet results without a generic invocation envelope', () => {
    expect(
      AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
        ok: true,
        result: {
          kind: 'voice.authority.snapshot',
          agentGeneration: 'agent-generation-1',
          providers: [],
        },
      }).success,
    ).toBe(true);
    const classifiedInitialReplay = {
      ok: true,
      result: {
        kind: 'external_session.follow.event',
        followId: 'follow-classified-user-1',
        eventId: 'event-classified-user-1',
        event: {
          kind: 'data',
          phase: 'initial_replay',
          items: [{
            id: 'provider-user-1',
            localId: 'provider-fact-user-1',
            timestampMs: 1,
            kind: 'user',
            userProjection: 'source_fact',
            data: {
              role: 'user',
              content: { type: 'text', text: 'from the provider' },
            },
          }],
          fromCursor: null,
          nextCursor: 'cursor-1',
        },
      },
    } as const;
    expect(
      AgentRuntimeDaemonServiceResponseV1Schema.safeParse(
        classifiedInitialReplay,
      ).success,
    ).toBe(true);
    expect(
      AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
        ...classifiedInitialReplay,
        result: {
          ...classifiedInitialReplay.result,
          event: {
            ...classifiedInitialReplay.result.event,
            items: [{
              ...classifiedInitialReplay.result.event.items[0],
              data: {
                role: 'user',
                content: { type: 'text', text: 'from the provider' },
                providerTag: 'legacy',
              },
            }],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
        ok: true,
        result: {
          kind: 'external_session.follow.event',
          followId: 'follow-1',
          eventId: 'event-1',
          event: {
            kind: 'terminated',
            reason: 'retired',
            cursor: null,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
        ok: true,
        result: {
          kind: 'voice.authority.snapshot',
          agentGeneration: 'agent-generation-1',
          providers: [],
          invoke: 'arbitrary',
        },
      }).success,
    ).toBe(false);

    expect(
      AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
        ok: true,
        result: {
          kind: 'external_session.current.list_candidates',
          result: {
            candidates: [{
              remoteSessionId: 'remote-session-1',
              updatedAtMs: 1,
            }],
            nextCursor: null,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
        ok: true,
        result: {
          kind: 'external_session.current.list_candidates',
          result: {
            candidates: [],
            nextCursor: null,
          },
          invoke: 'arbitrary',
        },
      }).success,
    ).toBe(false);
  });

  it('validates External Session state updates against their canonical field values', () => {
    const response = {
      ok: true,
      result: {
        kind: 'external_session.current.resolve_link_identity',
        result: {
          remoteSessionId: 'remote-session-1',
          source: { kind: 'codexHome', home: 'user' },
          sessionStateUpdates: [{
            fieldId: 'identity.providerSessionId',
            value: 'provider-session-1',
          }],
        },
      },
    } as const;

    expect(
      AgentRuntimeDaemonServiceResponseV1Schema.safeParse(response)
        .success,
    ).toBe(true);
    expect(
      AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
        ...response,
        result: {
          ...response.result,
          result: {
            ...response.result.result,
            sessionStateUpdates: [{
              fieldId: 'identity.providerSessionId',
              value: { unexpected: true },
            }],
          },
        },
      }).success,
    ).toBe(false);
  });
});
