import { describe, expect, it, vi } from 'vitest';
import type { JsonValue, PluginContributionRef } from '@happier-dev/plugin-sdk';
import { defineProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { requestTriageSessionHandoffV1, prepareTriageSessionHandoffV1, settleTriageSessionHandoffV1, TRIAGE_SESSION_HANDOFF_ACTION_REF_V1 } from './sessionHandoff.js';
import { readTriageSessionHandoffChoicesV1 } from './runtime.js';
import { TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1 } from '@happier-dev/triage-protocol/v1';

const input = {
  task: 'fix', configuredActionId: 'fix',
  context: { kind: 'repository', repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/repository' } },
  evidence: [{ kind: 'localTerminal', text: 'selected output',
    operationRef: { serverId: 'home', machineId: 'machine', operationId: 'operation' }, coverage: { complete: false, gaps: true } }],
  sessionChoice: { kind: 'new' }, agentChoice: { kind: 'configured' }, delivery: 'compose',
} as const;

const choices = {
  v: 1, kind: 'choices', actions: [{ label: 'Custom repair', selection: { configuredActionId: 'custom-fix',
    sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'configured' } }], defaultActionId: null,
} as const;

describe('public Session handoff chooser read', () => {
  it('reads the investigate catalog when preparing an explicitly selected issue investigation', async () => {
    const executeAction = vi.fn(async () => choices);
    const options = { task: 'investigate' as const, signal: new AbortController().signal };
    await readTriageSessionHandoffChoicesV1({ executeAction }, options);
    expect(executeAction).toHaveBeenCalledWith(TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1,
      { v: 1, projection: 'sessionHandoff', task: 'investigate' }, { signal: options.signal });
  });
  it.each([choices, { ok: true, result: choices }, { v: 1, kind: 'choices', actions: [], defaultActionId: null },
    { v: 1, kind: 'unavailable', reason: 'catalogUnavailable' }] satisfies JsonValue[])(
    'reads the canonical projection once without choosing or executing an Action %#', async raw => {
      const executeAction = vi.fn(async () => raw);
      const signal = new AbortController().signal;
      const expected = 'ok' in raw ? raw.result : raw;
      expect(await readTriageSessionHandoffChoicesV1({ executeAction }, { signal })).toEqual(expected);
      expect(executeAction).toHaveBeenCalledTimes(1);
      expect(executeAction).toHaveBeenCalledWith(TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1,
        { v: 1, projection: 'sessionHandoff' }, { signal });
    });

  it.each([
    { ok: false, errorCode: 'approval_required', error: 'A decision is required.', recovery: { input: 'retained' } },
    { kind: 'approval_request_created', artifactId: 'approval', actionId: 'catalog-read' },
    { ok: true, result: { kind: 'approval_request_created', artifactId: 'approval', actionId: 'catalog-read' } },
    undefined,
  ] satisfies (JsonValue | undefined)[])('preserves non-choice Action outcomes by identity without a second invocation %#', async raw => {
    const executeAction = vi.fn(async () => raw);
    const result = await readTriageSessionHandoffChoicesV1({ executeAction });
    if (result.kind !== 'actionOutcome') throw new Error('Expected the original host Action outcome');
    expect(result.outcome).toBe(raw);
    expect(executeAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...choices, permission: 'allow' },
    { ...choices, actions: [{ ...choices.actions[0], selection: { ...choices.actions[0].selection,
      sessionChoice: { kind: 'configured', serverId: 'other-home' } } }] },
    { ...choices, actions: [{ ...choices.actions[0], selection: { ...choices.actions[0].selection,
      agentChoice: { kind: 'configured', profileId: 'caller-override', permission: 'allow' } } }] },
    { ok: true, result: { ...choices, actions: [{ ...choices.actions[0], authority: 'owner' }] } },
    { ok: true },
    'unexpected',
  ] satisfies JsonValue[])('refuses malformed successful projections rather than inventing a default %#', async raw => {
    const executeAction = vi.fn(async () => raw);
    await expect(readTriageSessionHandoffChoicesV1({ executeAction })).rejects.toBeInstanceOf(TypeError);
    expect(executeAction).toHaveBeenCalledTimes(1);
  });
});

describe('public configured Session handoff client', () => {
  it('prepares the same admitted operand for a host control without executing and settles its original envelope', () => {
    expect(TRIAGE_SESSION_HANDOFF_ACTION_REF_V1).toEqual({ pluginId: 'happier.triage', localId: 'sessions/run-configured-v1' });
    expect(prepareTriageSessionHandoffV1(input)).toEqual({ input: { v: 1, handoff: input } });
    const response = { ok: true, result: { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } } } as const;
    expect(settleTriageSessionHandoffV1(response)).toBe(response);
    const failure = { ok: false, errorCode: 'unavailable', phase: 'dispatch' } as const;
    expect(settleTriageSessionHandoffV1(failure)).toBe(failure);
    expect(() => prepareTriageSessionHandoffV1({ ...input, evidence: [] })).toThrow();
    expect(() => settleTriageSessionHandoffV1({ ok: true, result: {} })).toThrow('triage_handoff_result_invalid');
  });
  it.each([{}, { number: undefined }])('omits a missing or undefined CI attempt number from strict wire JSON (%o)', async (optionalNumber) => {
    const repository = input.context.repository;
    const attempt = { run: { v: 1, repository, runId: 'run' }, attemptId: 'attempt', ...optionalNumber };
    const hostedInput = { ...input, evidence: [{ kind: 'hostedCi', summary: {
      repository, selection: { kind: 'attempt', attempt },
      jobs: [], annotations: [], excerpts: [], missing: [], ambiguous: [], omitted: [], continuation: null,
    } }] } as const;
    const response = { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } } as const;
    let received: JsonValue | undefined;
    // The external host admits the exact strict JSON its Action transport accepts.
    const executeAction = vi.fn(async (_ref: PluginContributionRef, payload: JsonValue) => {
      received = defineProtocolJsonValue().parse(payload);
      return response;
    });

    expect(await requestTriageSessionHandoffV1({ executeAction }, hostedInput)).toBe(response);
    expect(received).toEqual({ v: 1, handoff: { ...hostedInput, evidence: [{ ...hostedInput.evidence[0], summary: {
      ...hostedInput.evidence[0].summary, selection: { kind: 'attempt', attempt: { run: attempt.run, attemptId: attempt.attemptId } },
    } }] } });
    expect(received).not.toHaveProperty('handoff.evidence.0.summary.selection.attempt.number');
  });

  it.each([
    { v: 1, handoff: { kind: 'entryExecution', status: 'bulk' }, results: [{ status: 'unknownOutcome', creationKey: 'retained' }] },
    { v: 1, handoff: { kind: 'entryExecution', status: 'reviewUnknown' }, reviewInstructions: 'retained' },
    { v: 1, handoff: { kind: 'uncertain', phase: 'send', session: { serverId: 'home', sessionId: 'session' } }, recovery: { retainedInput: 'input' } },
    { kind: 'approval_request_created', artifactId: 'approval', actionId: 'action' },
    { ok: false, errorCode: 'approval_required', error: 'A decision is required.' },
    { ok: true, result: { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } }, recovery: { retainedInput: 'input' } } },
  ] satisfies JsonValue[])('preserves Action envelope/recovery by identity and never replays %#', async raw => {
    const executeAction = vi.fn(async () => raw);
    const signal = new AbortController().signal;
    expect(await requestTriageSessionHandoffV1({ executeAction }, input, { signal })).toBe(raw);
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(executeAction).toHaveBeenCalledWith({ pluginId: 'happier.triage', localId: 'sessions/run-configured-v1' },
      { v: 1, handoff: input }, { signal });
  });

  it('rejects invalid caller evidence before invoking the host', async () => {
    const executeAction = vi.fn(async () => undefined);
    await expect(requestTriageSessionHandoffV1({ executeAction }, { ...input, evidence: [] })).rejects.toThrow();
    expect(executeAction).not.toHaveBeenCalled();
  });
});
