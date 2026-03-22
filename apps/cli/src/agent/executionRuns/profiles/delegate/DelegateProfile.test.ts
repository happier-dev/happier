import { describe, expect, it } from 'vitest';

import { DelegateProfile } from './DelegateProfile';

describe('DelegateProfile', () => {
  it('parses trailing JSON when model output includes preamble text', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'delegate',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'delegate this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = DelegateProfile.onBoundedComplete({
      start,
      rawText: [
        'Sure, here are the deliverables.',
        '{',
        '  \"summary\": \"Ok\",',
        '  \"deliverables\": [{ \"id\": \"d1\", \"title\": \"Deliverable 1\" }]',
        '}',
      ].join('\n'),
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect(res.structuredMeta?.kind).toBe('delegate_output.v1');
    expect((res.structuredMeta as any).payload?.summary).toBe('Ok');
    expect((res.toolResultMeta as any)?.happier?.kind).toBe('delegate_output.v1');
  });

  it('parses trailing JSON when model output wraps the JSON object in a markdown fence', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'delegate',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'delegate this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = DelegateProfile.onBoundedComplete({
      start,
      rawText: [
        'Sure, here are the deliverables.',
        '```json',
        '{',
        '  \"summary\": \"Ok\",',
        '  \"deliverables\": [{ \"id\": \"d1\", \"title\": \"Deliverable 1\" }]',
        '}',
        '```',
      ].join('\n'),
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect(res.structuredMeta?.kind).toBe('delegate_output.v1');
  });

  it('fails deterministically when model output is not strict JSON', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'delegate',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'delegate this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = DelegateProfile.onBoundedComplete({
      start,
      rawText: 'not json',
      finishedAtMs: 2,
    });

    expect(res.status).toBe('failed');
    expect((res.toolResultOutput as any)?.error?.code).toBe('invalid_output');
  });

  it('recovers loose prose output for pi by extracting deliverables (best-effort)', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'delegate',
      backendId: 'pi',
      backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
      instructions: 'delegate this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = DelegateProfile.onBoundedComplete({
      start,
      rawText: [
        'Deliverables:',
        '- pi-1: Fix repair prompt JSON examples',
        '- pi-2: Add trailing comma tolerant JSON parsing',
      ].join('\n'),
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect(res.structuredMeta?.kind).toBe('delegate_output.v1');
    const payload = (res.structuredMeta as any)?.payload;
    expect(payload?.deliverables?.map((d: any) => d.id)).toEqual(['pi-1', 'pi-2']);
    expect(payload?.deliverables?.map((d: any) => d.title)).toEqual([
      'Fix repair prompt JSON examples',
      'Add trailing comma tolerant JSON parsing',
    ]);
  });

  it('recovers loose numbered-list output for pi by extracting deliverables (best-effort)', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'delegate',
      backendId: 'pi',
      backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
      instructions: 'delegate this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = DelegateProfile.onBoundedComplete({
      start,
      rawText: [
        'Here are 3 deliverables:',
        '1) pi-1: Add pi delegate loose parsing',
        '2) pi-2: Support bullet markers beyond -/*',
        '3) pi-3: Add tests for pi loose parsing',
      ].join('\n'),
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect(res.structuredMeta?.kind).toBe('delegate_output.v1');
    const payload = (res.structuredMeta as any)?.payload;
    expect(payload?.deliverables?.map((d: any) => d.id)).toEqual(['pi-1', 'pi-2', 'pi-3']);
    expect(payload?.deliverables?.map((d: any) => d.title)).toEqual([
      'Add pi delegate loose parsing',
      'Support bullet markers beyond -/*',
      'Add tests for pi loose parsing',
    ]);
  });

  it('recovers tight numbered-list output for pi when the marker is not followed by whitespace', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'delegate',
      backendId: 'pi',
      backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
      instructions: 'delegate this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = DelegateProfile.onBoundedComplete({
      start,
      rawText: [
        'Here are 2 deliverables:',
        '1)pi-1: Accept bullet markers without whitespace',
        '2)pi-2: Keep parsing stable',
      ].join('\n'),
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect(res.structuredMeta?.kind).toBe('delegate_output.v1');
    const payload = (res.structuredMeta as any)?.payload;
    expect(payload?.deliverables?.map((d: any) => d.id)).toEqual(['pi-1', 'pi-2']);
  });

  it('recovers loose prose output for codex by extracting deliverables (best-effort)', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'delegate',
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'delegate this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = DelegateProfile.onBoundedComplete({
      start,
      rawText: [
        'Deliverables:',
        '- codex-1: Ensure delegate outputs strict JSON',
        '- codex-2: Add a loose fallback for non-JSON outputs',
      ].join('\n'),
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect(res.structuredMeta?.kind).toBe('delegate_output.v1');
    const payload = (res.structuredMeta as any)?.payload;
    expect(payload?.deliverables?.map((d: any) => d.id)).toEqual(['codex-1', 'codex-2']);
    expect(payload?.deliverables?.map((d: any) => d.title)).toEqual([
      'Ensure delegate outputs strict JSON',
      'Add a loose fallback for non-JSON outputs',
    ]);
  });

  it('recovers non-bulleted codex prose output as a single deliverable (best-effort)', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'delegate',
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'delegate this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = DelegateProfile.onBoundedComplete({
      start,
      rawText: [
        'I completed the delegation successfully.',
        'No further action is required.',
      ].join('\n'),
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect(res.structuredMeta?.kind).toBe('delegate_output.v1');
    const payload = (res.structuredMeta as any)?.payload;
    expect(payload?.summary).toBe('I completed the delegation successfully.');
    expect(payload?.deliverables?.map((d: any) => d.id)).toEqual(['d1']);
    expect(payload?.deliverables?.map((d: any) => d.title)).toEqual([
      'I completed the delegation successfully.',
    ]);
  });
});
