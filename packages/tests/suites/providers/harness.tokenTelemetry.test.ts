import { describe, expect, it } from 'vitest';

import { extractProviderTokenTelemetryEntries } from '../../src/testkit/providers/harness';

describe('providers harness: token telemetry extraction', () => {
  it('extracts usage ephemerals and ignores non-usage socket events', () => {
    const entries = extractProviderTokenTelemetryEntries({
      providerId: 'claude',
      scenarioId: 'agent_sdk_read_known_file',
      phase: 'phase1',
      sessionId: 'sess_1',
      modelId: 'claude-sonnet-4',
      events: [
        { at: 1, kind: 'connect' },
        {
          at: 2,
          kind: 'ephemeral',
          payload: {
            type: 'usage',
            key: 'claude-session',
            tokens: { total: 123, input: 100, output: 23 },
            cost: { total: 1.23 },
            timestamp: 1700000000000,
          },
        },
        { at: 3, kind: 'update', payload: { body: { t: 'session-changed' } } },
        { at: 4, kind: 'ephemeral', payload: { type: 'machine-status', online: true } },
      ],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      v: 1,
      providerId: 'claude',
      scenarioId: 'agent_sdk_read_known_file',
      phase: 'phase1',
      sessionId: 'sess_1',
      key: 'claude-session',
      modelId: 'claude-sonnet-4',
      source: 'socket-ephemeral-usage',
      tokens: { total: 123, input: 100, output: 23 },
    });
  });

  it('normalizes malformed usage payloads to a safe shape', () => {
    const entries = extractProviderTokenTelemetryEntries({
      providerId: 'codex',
      scenarioId: 'acp_probe_models',
      phase: 'single',
      sessionId: 'sess_2',
      modelId: null,
      events: [
        {
          at: 2,
          kind: 'ephemeral',
          payload: {
            type: 'usage',
            key: '',
            tokens: { total: 5, bad: 'x', neg: -4 },
            timestamp: 'bad',
          },
        },
      ],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: 'unknown',
      modelId: null,
      tokens: { total: 5 },
    });
    expect(typeof entries[0]?.timestamp).toBe('number');
  });
});
