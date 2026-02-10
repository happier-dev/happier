import { describe, expect, it } from 'vitest';

import { ensureProviderTokenTelemetryEntries, extractProviderTokenTelemetryEntries } from '../../src/testkit/providers/harness';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';

describe('providers harness: token telemetry extraction', () => {
  it('extracts usage ephemerals and ignores non-usage socket events', async () => {
    const entries = await extractProviderTokenTelemetryEntries({
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

  it('extracts token_count messages from new-message socket updates when available', async () => {
    const secret = new Uint8Array(32).fill(7);
    const encrypted = encryptLegacyBase64(
      {
        type: 'token_count',
        key: 'turn-1',
        model: 'openai/gpt-4o-mini',
        tokens: { input: 7, output: 5, total: 12 },
      },
      secret,
    );

    const entries = await extractProviderTokenTelemetryEntries({
      providerId: 'opencode',
      scenarioId: 'acp_set_model_dynamic',
      phase: 'single',
      sessionId: 'sess_4',
      modelId: null,
      events: [
        {
          at: 2,
          kind: 'update',
          payload: {
            body: {
              t: 'new-message',
              message: {
                id: 'msg_1',
                seq: 1,
                content: { t: 'encrypted', c: encrypted },
                localId: null,
                createdAt: 1,
                updatedAt: 1,
              },
            },
          },
        },
      ],
      secret,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      providerId: 'opencode',
      scenarioId: 'acp_set_model_dynamic',
      phase: 'single',
      sessionId: 'sess_4',
      key: 'turn-1',
      modelId: 'openai/gpt-4o-mini',
      source: 'socket-update-token-count',
      tokens: { total: 12, input: 7, output: 5 },
    });
  });

  it('normalizes malformed usage payloads to a safe shape', async () => {
    const entries = await extractProviderTokenTelemetryEntries({
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

  it('skips usage ephemerals when token map is empty', async () => {
    const entries = await extractProviderTokenTelemetryEntries({
      providerId: 'claude',
      scenarioId: 'agent_sdk_read_known_file',
      phase: 'phase1',
      sessionId: 'sess_1',
      modelId: 'claude-sonnet-4',
      events: [
        {
          at: 2,
          kind: 'ephemeral',
          payload: {
            type: 'usage',
            key: 'claude-session',
            tokens: { bad: 'x', neg: -3 },
          },
        },
      ],
    });

    expect(entries).toEqual([]);
  });

  it('emits a stable placeholder when no usage telemetry is observed', () => {
    const ensured = ensureProviderTokenTelemetryEntries({
      providerId: 'opencode',
      scenarioId: 'acp_probe_capabilities',
      phase: 'single',
      sessionId: 'sess_3',
      modelId: null,
      extracted: [],
    });

    expect(ensured).toHaveLength(1);
    expect(ensured[0]).toMatchObject({
      v: 1,
      providerId: 'opencode',
      scenarioId: 'acp_probe_capabilities',
      phase: 'single',
      sessionId: 'sess_3',
      modelId: null,
      source: 'missing-usage',
      tokens: {},
    });
    expect(typeof ensured[0]?.timestamp).toBe('number');
  });
});
