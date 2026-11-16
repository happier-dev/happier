import { describe, expect, it } from 'vitest';
import { TriageSessionHandoffResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { presentTriageNativeFailureResult } from './nativeFailure.js';
const scope = { serverId: 'server-a' };
describe('native failure presentation at its Triage owner', () => {
  it('retains the exact Session handoff for outcome links without calling it a finding', () => {
    const handoff = { kind: 'composed', destination: { kind: 'existing', session: { serverId: scope.serverId, sessionId: 'diagnosis' } } } as const;
    expect(presentTriageNativeFailureResult({ ok: true, result: { v: 1, handoff } }))
      .toEqual({ kind: 'started', handoff });
  });
  it('keeps a durably admitted input started while its Session is still starting', () => {
    const handoff = { kind: 'sendResult', session: { serverId: scope.serverId, sessionId: 'diagnosis' },
      result: { status: 'accepted', localId: 'receipt-input' } } as const;
    expect(presentTriageNativeFailureResult({ ok: true, result: { v: 1, handoff } }))
      .toEqual({ kind: 'started', handoff });
  });
  it.each([
    { kind: 'entryExecution', status: 'bulk' },
    { kind: 'sendResult', session: { serverId: scope.serverId, sessionId: 'diagnosis' },
      result: { kind: 'fanout', results: [{ target: { serverId: scope.serverId, sessionId: 'diagnosis' },
        result: { ok: true, result: { status: 'rejected', code: 'session_input_target_unavailable' } } }] } },
  ])('does not claim an exact notice investigation started from an unrelated result %#', value => {
    // Entry batches and selector fanout are valid shared protocol results, but the notice
    // invokes one non-entry handoff to one exact Session.
    const handoff = TriageSessionHandoffResultV1Schema.parse(value);
    expect(presentTriageNativeFailureResult({ ok: true, result: { v: 1, handoff } }))
      .toEqual({ kind: 'unavailable', code: 'invalid_result' });
  });

});
