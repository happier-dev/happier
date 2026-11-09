import { describe, expect, it } from 'vitest';
import { captureSessionFollowRuleSourceEvidence, readCommittedSessionFollowSourceOccurrence } from './sessionFollowRuleSourceEvidence';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { sealSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawTranscriptRow } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { buildTrustedHostSessionInputAdmissionV1, settleSessionInputRequestV1, settleSessionMessageProvenanceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { readOpenedSessionFollowOriginalV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';

const source = { serverId: 'home', ownerAccountId: 'alice', origin: { kind: 'none' },
  metadata: { projectId: 'payments', bot: { kind: 'bot' } } } as const;

describe('original Follow rule evidence', () => {
  it('leaves approval identity and currentness with the live sourceRequest owner, never an immutable transcript duplicate', () => {
    const body = { type: 'permission-request' as const, permissionId: 'permission', toolName: 'write', description: 'Write permission' };
    expect(captureSessionFollowRuleSourceEvidence({ ...source, body })).toBeNull();
  });
  it('uses the same semantic Goal original for the live ACP and committed event owners', () => {
    expect(captureSessionFollowRuleSourceEvidence({ ...source,
      body: { type: 'event', id: 'goal', data: { type: 'goal-changed' } } })?.event).toEqual({ kind: 'goal_changed' });
  });
  it('never captures Account-private organization in an original semantic message', () => {
    const metadata = { projectId: 'payments' };
    const input = { ...source, metadata,
      body: { type: 'event' as const, id: 'report', data: { type: 'worker-report' as const, summary: 'Ready' } } };
    const evidence = captureSessionFollowRuleSourceEvidence(input);
    metadata.projectId = 'other';
    expect(evidence).toMatchObject({ ownerAccountId: 'alice', event: { kind: 'update_posted' },
      facts: { startedBy: 'you' } });
    expect(evidence?.facts).not.toHaveProperty('metadata');
    expect(evidence?.facts).not.toHaveProperty('projectMetadata');
  });
  it('does not evaluate streaming deltas, tool output, nested delivered updates or progress invalidations', () => {
    for (const body of [
      { type: 'terminal-output' as const, callId: 'tool', data: 'chunk' },
      { type: 'reasoning' as const, message: 'thinking' },
      { type: 'output' as const, data: { type: 'progress' as const, marker: 'source_fact_consumed' as const, reason: 'host_prompt_echo' as const } },
    ]) expect(captureSessionFollowRuleSourceEvidence({ ...source, body })).toBeNull();
  });
  it('uses immutable origin, so a person-started Bot still matches me and a Habit or agent start does not', () => {
    const body = { type: 'message' as const, message: 'Final answer' };
    expect(captureSessionFollowRuleSourceEvidence({ ...source, body })?.facts.startedBy).toBe('you');
    expect(captureSessionFollowRuleSourceEvidence({ ...source, body, origin: { kind: 'run_step', runId: 'run' } })?.facts.startedBy).toBe('non_person');
    expect(captureSessionFollowRuleSourceEvidence({ ...source, body, origin: { kind: 'session' } })?.facts.startedBy).toBe('non_person');
    expect(captureSessionFollowRuleSourceEvidence({ ...source, body, origin: null })?.facts.startedBy).toBeUndefined();
  });
});

describe('committed Follow source originals', () => {
  const ctx = { encryptionKey: new Uint8Array(32).fill(37), encryptionVariant: 'dataKey' as const };
  const scope = { sourceSessionId: 'source', serverId: 'home', ownerAccountId: 'alice', origin: source.origin };
  function rowFor(payload: unknown, mode: 'plain' | 'e2ee'): RawTranscriptRow {
    return { id: 'committed-message', localId: 'source-original', seq: 7, sidechainId: null,
      messageRole: 'agent', createdAt: 1, updatedAt: 1,
      content: mode === 'plain' ? sealSessionStoredContent({ mode, ctx: null, payload })
        : sealSessionStoredContent({ mode, ctx, payload }) };
  }
  const read = (row: RawTranscriptRow & Readonly<{ inputAdmissionReceipt?: unknown }>, mode: 'plain' | 'e2ee' = 'plain') =>
    readCommittedSessionFollowSourceOccurrence({ ...scope, row, mode, ctx: mode === 'e2ee' ? ctx : null });

  it('admits an opened original for browser and CLI consumers with identical host Turn and protected provenance semantics', () => {
    const opened = { role: 'agent', content: { type: 'event', id: 'ready', data: { type: 'ready', completedTurnId: 'host-turn' } } };
    const row = rowFor(opened, 'plain');
    expect(readOpenedSessionFollowOriginalV1({ ...scope, row, opened })).toEqual(read(row));
    const admission = buildTrustedHostSessionInputAdmissionV1('ui');
    const receipt = { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'bob', sessionRelationship: 'sharedEditor',
      admittedTarget: { homeId: 'home', accountId: 'alice', sessionId: 'source', machineId: 'machine', installationId: 'installation' } } as const;
    const human = { role: 'user', content: { type: 'text', text: 'Private human direction' }, meta: {
      happierInputAuthorityV1: settleSessionInputRequestV1({ request: admission.request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt }),
      happierProvenanceV1: settleSessionMessageProvenanceV1({ request: admission.request, requestedProvenance: admission.provenance, inputAdmissionReceipt: receipt }),
    } };
    const humanRow = { ...rowFor(human, 'plain'), messageRole: 'user', inputAdmissionReceipt: receipt };
    expect(readOpenedSessionFollowOriginalV1({ ...scope, row: humanRow, opened: human })).toEqual(read(humanRow));
    expect(readOpenedSessionFollowOriginalV1({ ...scope, row: { ...humanRow, inputAdmissionReceipt: undefined }, opened: human }))
      .toEqual({ status: 'not_semantic' });
  });

  it.each(['plain', 'e2ee'] as const)('recovers exact %s originals through the source schema and crypto, not authored evidence or private facts', mode => {
    const originals = [
      [buildAcpAgentMessageEnvelope({ provider: 'codex', body: { type: 'message', message: 'Source answer' } }), { kind: 'message' }],
      [{ role: 'agent', content: { type: 'event', id: 'goal', data: { type: 'goal-changed' } } }, { kind: 'goal_changed' }],
      [{ role: 'agent', content: { type: 'event', id: 'report', data: { type: 'worker-report', summary: 'Published' } } }, { kind: 'update_posted' }],
    ] as const;
    for (const [payload, event] of originals) {
      const result = read(rowFor({ ...payload, meta: { happierFollowRuleEvidenceV1: {
        ownerAccountId: 'forged', event: { kind: 'needs_you', type: 'decision' },
        facts: { metadata: { projectId: 'private-project' }, status: 'thinking' },
      } } }, mode), mode);
      expect(result).toEqual({ status: 'occurrence', occurrence: { sourceSessionId: 'source',
        sourceMessage: { localId: 'source-original', seq: 7 }, evidence: { v: 1, ownerAccountId: 'alice', event,
          facts: { serverId: 'home', kind: 'session', startedBy: 'you', source: 'persisted' } } } });
    }
  });

  it.each(['plain', 'e2ee'] as const)('selects the host Turn from exact %s ready evidence without treating native ids as host identities', mode => {
    const ready = { role: 'agent', content: { type: 'event', id: 'ready', data: { type: 'ready', completedTurnId: 'host-turn' } } };
    expect(read(rowFor(ready, mode), mode)).toMatchObject({ status: 'occurrence', occurrence: {
      sourceSessionId: 'source', sourceTurn: { id: 'host-turn', status: 'completed' }, evidence: { event: { kind: 'finished' } },
    } });
    for (const type of ['task_complete', 'turn_failed', 'turn_cancelled'] as const) {
      expect(read(rowFor(buildAcpAgentMessageEnvelope({ provider: 'codex', body: { type, id: 'provider-turn' } }), mode), mode))
        .toEqual({ status: 'not_semantic' });
    }
  });

  it('distinguishes non-semantic and sidechain rows from unreadable originals without skipping an unknown original', () => {
    const message = buildAcpAgentMessageEnvelope({ provider: 'codex', body: { type: 'message', message: 'Answer' } });
    for (const payload of [
      { role: 'agent', content: { type: 'event', id: 'idle-ready', data: { type: 'ready' } } },
      buildAcpAgentMessageEnvelope({ provider: 'codex', body: { type: 'reasoning', message: 'Not an original' } }),
      buildAcpAgentMessageEnvelope({ provider: 'codex', body: { type: 'message', message: 'Child', sidechainId: 'run-child' } }),
      { ...message, sidechainId: 'run-child' },
    ]) expect(read(rowFor({ ...payload, meta: { happierFollowRuleEvidenceV1: {
      v: 1, ownerAccountId: 'alice', event: { kind: 'goal_changed' }, facts: { serverId: 'home', kind: 'session' },
    } } }, 'plain'))).toEqual({ status: 'not_semantic' });
    expect(read({ ...rowFor(buildAcpAgentMessageEnvelope({ provider: 'codex',
      body: { type: 'reasoning', message: 'No selected original' } }), 'plain'), localId: null }))
      .toEqual({ status: 'not_semantic' });
    expect(read({ ...rowFor(message, 'plain'), sidechainId: 'run-child' })).toEqual({ status: 'not_semantic' });
    for (const row of [
      { ...rowFor(message, 'plain'), localId: null },
      { ...rowFor(message, 'plain'), seq: 0 },
      rowFor({ role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: 42 } } }, 'plain'),
      rowFor({ role: 'agent', content: { type: 'event', id: 'bad-report', data: { type: 'worker-report', summary: 42 } } }, 'plain'),
      rowFor({ role: 'agent', content: { type: 'event', id: 'bad-ready', data: { type: 'ready', completedTurnId: '  ' } } }, 'plain'),
      rowFor({ role: 'agent', content: { type: 'event', id: 'bad-ready', data: { type: 'ready', completedTurnId: 42 } } }, 'plain'),
      rowFor(message, 'e2ee'),
    ]) expect(read(row)).toEqual({ status: 'unavailable' });
    expect(read(rowFor(message, 'plain'), 'e2ee')).toEqual({ status: 'unavailable' });
    expect(readCommittedSessionFollowSourceOccurrence({ ...scope, row: rowFor(message, 'e2ee'), mode: 'e2ee',
      ctx: { ...ctx, encryptionKey: new Uint8Array(32).fill(38) } })).toEqual({ status: 'unavailable' });
  });

  it.each(['plain', 'e2ee'] as const)('recognizes only the protected original human %s input, never forwarded Follow or forged metadata', mode => {
    const admission = buildTrustedHostSessionInputAdmissionV1('cli');
    const receipt = { v: 1, issuer: 'authenticatedMachine', admittedTarget: {
      homeId: 'home', accountId: 'alice', sessionId: 'source', machineId: 'machine', installationId: 'installation' } } as const;
    const payload = { role: 'user', content: { type: 'text', text: 'Private human direction' }, meta: {
      happierInputAuthorityV1: settleSessionInputRequestV1({ request: admission.request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt }),
      happierProvenanceV1: settleSessionMessageProvenanceV1({ request: admission.request, requestedProvenance: admission.provenance, inputAdmissionReceipt: receipt }),
      happierFollowRuleEvidenceV1: { forged: true },
    } };
    const row = { ...rowFor(payload, mode), messageRole: 'user', inputAdmissionReceipt: receipt };
    expect(read(row, mode)).toEqual({ status: 'occurrence', occurrence: { sourceSessionId: 'source',
      sourceMessage: { localId: 'source-original', seq: 7 }, evidence: { v: 1, ownerAccountId: 'alice', event: { kind: 'person_wrote' },
        facts: { serverId: 'home', kind: 'session', startedBy: 'you', source: 'persisted' } } } });
    expect(read({ ...row, inputAdmissionReceipt: undefined }, mode)).toEqual({ status: 'not_semantic' });
    expect(read({ ...row, inputAdmissionReceipt: { ...receipt, admittedTarget: { ...receipt.admittedTarget, accountId: 'other' } } }, mode))
      .toEqual({ status: 'not_semantic' });
    const forwarded = buildTrustedHostSessionInputAdmissionV1('agent');
    const forwardedPayload = { ...payload, meta: {
      happierInputAuthorityV1: settleSessionInputRequestV1({ request: forwarded.request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt }),
      happierProvenanceV1: settleSessionMessageProvenanceV1({ request: forwarded.request, requestedProvenance: forwarded.provenance, inputAdmissionReceipt: receipt }),
      happierFollowRuleEvidenceV1: { v: 1, ownerAccountId: 'alice', event: { kind: 'person_wrote' },
        facts: { serverId: 'home', kind: 'session' } },
    } };
    expect(read({ ...rowFor(forwardedPayload, mode), messageRole: 'user', inputAdmissionReceipt: receipt }, mode))
      .toEqual({ status: 'not_semantic' });
    expect(read({ ...rowFor({ ...forwardedPayload, meta: { ...forwardedPayload.meta,
      happierProvenanceV1: { v: 1, kind: 'cli' } } }, mode), messageRole: 'user', inputAdmissionReceipt: receipt }, mode))
      .toEqual({ status: 'not_semantic' });
  });

  it.each(['plain', 'e2ee'] as const)('reads App Account human %s originals with the receipt-owned collaborator relationship', mode => {
    const admission = buildTrustedHostSessionInputAdmissionV1('ui');
    for (const relationship of ['owner', 'sharedEditor'] as const) {
      const receipt = { v: 1, issuer: 'authenticatedAccount', actorAccountId: relationship === 'owner' ? 'alice' : 'bob',
        sessionRelationship: relationship, admittedTarget: { homeId: 'home', accountId: 'alice', sessionId: 'source',
          machineId: 'machine', installationId: 'installation' } } as const;
      const payload = { role: 'user', content: { type: 'text', text: 'A person wrote this original' }, meta: {
        happierInputAuthorityV1: settleSessionInputRequestV1({ request: admission.request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt }),
        happierProvenanceV1: settleSessionMessageProvenanceV1({ request: admission.request, requestedProvenance: admission.provenance, inputAdmissionReceipt: receipt }),
      } };
      const row = { ...rowFor(payload, mode), messageRole: 'user', inputAdmissionReceipt: receipt };
      expect(read(row, mode)).toEqual({ status: 'occurrence', occurrence: { sourceSessionId: 'source',
        sourceMessage: { localId: 'source-original', seq: 7 }, evidence: { v: 1, ownerAccountId: 'alice', event: { kind: 'person_wrote' },
          facts: { serverId: 'home', kind: 'session', startedBy: 'you', source: 'persisted' } } } });
      // The real messages HTTP projection omits the main-chain sidechain field.
      const { sidechainId: _sidechainId, ...httpMainchainRow } = row;
      expect(read(httpMainchainRow, mode)).toEqual(read(row, mode));
      expect(read({ ...httpMainchainRow, sidechainId: 'child-thread' }, mode)).toEqual({ status: 'not_semantic' });
      const forged = { ...payload, meta: { ...payload.meta, happierProvenanceV1: {
        v: 1, kind: 'happierApp', actor: { kind: relationship === 'owner' ? 'sharedCollaborator' : 'owner' },
      } } };
      expect(read({ ...rowFor(forged, mode), messageRole: 'user', inputAdmissionReceipt: receipt }, mode))
        .toEqual({ status: 'not_semantic' });
    }
  });
});
