import { describe, expect, it } from 'vitest';
import { curateToolTraceFixturesFromJsonlLines } from './curateToolTraceFixtures';
import { makeTraceEvent, scenarioToolResultThenPermissionRequest, scenarioToolResultThenToolCall, toJsonlLines } from './testEvents.testkit';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

describe('curateToolTraceFixturesFromJsonlLines', () => {
  it('curates current qualified native provenance', () => {
    const source = { protocol: 'native', agent: { pluginId: 'acme.agents', localId: 'muse' } };
    const fixtures = curateToolTraceFixturesFromJsonlLines([JSON.stringify({
      v: 2, ts: 1, direction: 'outbound', sessionId: 'native-session', source,
      kind: 'tool-call', payload: { name: 'Read', input: { path: '/source' } },
    })]);
    expect(fixtures.examples['native/acme.agents/muse/tool-call/Read']).toHaveLength(1);
  });

  it.each(['codex', 'claude'] as const)('keeps historical %s keys eligible for their existing allowlist', (protocol) => {
    const key = `${protocol}/${protocol}/tool-call/Read`;
    const fixtures = curateToolTraceFixturesFromJsonlLines(toJsonlLines([
      makeTraceEvent({ ts: 1, protocol, provider: protocol, kind: 'tool-call', payload: { name: 'Read' } }),
    ]), { allowlistKeys: new Set([key]) });
    expect(fixtures.examples[key]).toHaveLength(1);
  });

  it('prefers higher-signal examples and obeys maxExamplesPerKey', () => {
    const fixtures = curateToolTraceFixturesFromJsonlLines(
      toJsonlLines([
        makeTraceEvent({
          ts: 1,
          protocol: 'acp',
          provider: 'opencode',
          kind: 'tool-call',
          payload: { type: 'tool-call', name: 'read', input: {} },
        }),
        makeTraceEvent({
          ts: 2,
          protocol: 'acp',
          provider: 'opencode',
          kind: 'tool-call',
          payload: { type: 'tool-call', name: 'read', input: { file_path: '/etc/hosts' } },
        }),
        makeTraceEvent({
          ts: 3,
          protocol: 'acp',
          provider: 'opencode',
          kind: 'tool-call',
          payload: { type: 'tool-call', name: 'read', input: { file_path: '/etc/hosts', limit: 3 } },
        }),
      ]),
      { maxExamplesPerKey: 2 },
    );

    const key = 'acp/opencode/tool-call/read';
    expect(fixtures.examples[key]).toHaveLength(2);
    const firstInput = asRecord(asRecord(fixtures.examples[key]?.[0]?.payload)?.input);
    const secondInput = asRecord(asRecord(fixtures.examples[key]?.[1]?.payload)?.input);
    expect(firstInput).toEqual(expect.objectContaining({ file_path: '/etc/hosts' }));
    expect(secondInput).toEqual(expect.objectContaining({ file_path: '/etc/hosts' }));
  });

  it('can filter by allowlist keys', () => {
    const fixtures = curateToolTraceFixturesFromJsonlLines(
      toJsonlLines([
        makeTraceEvent({
          ts: 1,
          protocol: 'acp',
          provider: 'opencode',
          kind: 'tool-call',
          payload: { type: 'tool-call', name: 'read', input: { file_path: '/etc/hosts' } },
        }),
        makeTraceEvent({
          ts: 2,
          protocol: 'acp',
          provider: 'opencode',
          kind: 'tool-call',
          payload: { type: 'tool-call', name: 'execute', input: { command: 'echo hi' } },
        }),
      ]),
      { allowlistKeys: new Set(['acp/opencode/tool-call/read']) },
    );

    expect(Object.keys(fixtures.examples)).toEqual(['acp/opencode/tool-call/read']);
  });

  it('keys tool-result events by tool name even when the tool-call arrives later in the trace', () => {
    const fixtures = curateToolTraceFixturesFromJsonlLines(scenarioToolResultThenToolCall());
    expect(Object.keys(fixtures.examples)).toEqual(expect.arrayContaining(['acp/opencode/tool-result/read']));
  });

  it('keys tool-result events by tool name when a permission-request exists without a tool-call', () => {
    const fixtures = curateToolTraceFixturesFromJsonlLines(scenarioToolResultThenPermissionRequest());
    expect(Object.keys(fixtures.examples)).toEqual(expect.arrayContaining(['acp/gemini/tool-result/read']));
  });
});
