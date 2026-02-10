import { describe, expect, it } from 'vitest';

import { filterImportedTraceEvents, isImportedTraceEvent } from '../../src/testkit/providers/satisfaction/traceSatisfaction';

describe('providers: trace satisfaction import filtering', () => {
  it('identifies ACP imported events by localId prefix', () => {
    const imported = {
      kind: 'tool-call',
      localId: 'acp-import:v1:opencode:abc',
      payload: { id: 'something' },
    } as any;
    expect(isImportedTraceEvent(imported)).toBe(true);
  });

  it('identifies ACP imported events by payload id prefix', () => {
    const imported = {
      kind: 'tool-result',
      payload: { id: 'import-chatcmpl-tool-123' },
    } as any;
    expect(isImportedTraceEvent(imported)).toBe(true);
  });

  it('keeps non-imported trace events', () => {
    const events = [
      { kind: 'tool-call', payload: { callId: 'call_1' } },
      { kind: 'tool-result', payload: { callId: 'call_1' } },
      { kind: 'tool-call', localId: 'acp-import:v1:x', payload: { id: 'import-1' } },
    ] as any[];
    const filtered = filterImportedTraceEvents(events as any);
    expect(filtered).toHaveLength(2);
    expect(filtered.every((event) => !isImportedTraceEvent(event as any))).toBe(true);
  });
});
