import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginClientActionContext } from '@happier-dev/plugin-sdk/actions';
import { TriageSessionHandoffResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { createTriageNativeFailureOwner, presentTriageNativeFailureResult } from './nativeFailure.js';
import { TriageNativeFailureInputV1Schema } from './nativeFailureProtocol.js';
const scope = { serverId: 'server-a' };
describe('native failure presentation at its Triage owner', () => {
  it('retains the exact Session handoff for outcome links without calling it a finding', () => {
    const handoff = { kind: 'composed', destination: { kind: 'existing', session: { serverId: scope.serverId, sessionId: 'diagnosis' } } } as const;
    expect(presentTriageNativeFailureResult({ ok: true, result: { v: 1, handoff } }))
      .toEqual({ kind: 'started', handoff });
  });
  it.each([
    ['target_home_account_mismatch', { kind: 'unavailable', code: 'target_home_account_mismatch' }],
    ['action_outcome_unknown', { kind: 'uncertain' }],
    ['approval_execution_outcome_unknown', { kind: 'uncertain' }],
  ] as const)('presents the launch settlement from the Action code %s', (code, outcome) => {
    expect(presentTriageNativeFailureResult({ ok: false, errorCode: code, error: code })).toEqual(outcome);
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

  it.each([
    ['a refused read keeps its own code', () => { throw new PluginError({ code: 'action_target_unavailable' }); }, 'action_target_unavailable'],
    ['a read the catalog itself refuses stays catalogUnavailable', () => ({ v: 1, kind: 'unavailable', reason: 'catalogUnavailable' }), 'catalogUnavailable'],
    ['an unreadable answer is an invalid result', () => ({ v: 1, kind: 'actions_invoke', data: {} }), 'invalid_result'],
  ])('settles Investigate to the named reason of its choices read: %s (BL2-HEALTH)', async (_name, answer, code) => {
    // Live #177: every reason the choices read could fail was reported as catalogUnavailable, so a refused
    // or unreadable read looked like a Home with no Triage catalog and the real cause was lost.
    const context = { plugin: { id: 'happier.triage' }, signal: new AbortController().signal,
      ui: { executeAction: async () => answer() } } as unknown as PluginClientActionContext;
    const subject = { kind: 'healthAlert',
      notice: { kind: 'host', artifactId: 'notice', source: { kind: 'host', topic: 'resource_limit' } },
      target: { kind: 'machine', machine: { serverId: 'home', machineId: 'affected' } } };
    const launch = TriageNativeFailureInputV1Schema.parse({ kind: 'launch', context: subject });
    expect(await createTriageNativeFailureOwner().invoke(launch, context))
      .toEqual({ kind: 'presentation', outcome: { kind: 'unavailable', code } });
    const read = TriageNativeFailureInputV1Schema.parse({
      kind: 'readAgentActions', context: subject, includeDefault: true,
    });
    expect(await createTriageNativeFailureOwner().invoke(read, context))
      .toEqual({ kind: 'presentation', outcome: { kind: 'unavailable', code } });
  });
});
