import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseAuggieLifecycleHookV0_24_0 } from './__fixtures__/lifecycleHooks.test-support.js';
import { parseAuggieSessionListV0_24_0 } from './__fixtures__/sessionList.test-support.js';

const fixtureUrl = (name: string) => new URL(`./__fixtures__/${name}`, import.meta.url);

// Public provenance only: @augmentcode/auggie@0.24.0 (commit b4381cdc),
// npm sha512-mX2Ov32bOQMclUSMUg8er610U5YfisHtB6RbBTRB5cuyUZRoqypM3RUWXjBskWWtqw62R0FgXTNd5Tsk9Y/55g==.
// The list shape comes from the published package's `session list --json` projection;
// lifecycle hook fields come from https://docs.augmentcode.com/cli/hooks.
describe('Auggie 0.24.0 public semantic fixtures', () => {
  it('projects candidate identity without retaining prompt or request content', async () => {
    const raw = JSON.parse(
      await readFile(fixtureUrl('auggie-0.24.0-session-list.json'), 'utf8'),
    ) as unknown;

    expect(parseAuggieSessionListV0_24_0(raw)).toEqual({
      candidates: [
        {
          sessionId: 'auggie-fixture-session-2',
          title: 'Deterministic fixture session',
          createdAtMs: Date.parse('2026-07-20T10:00:00.000Z'),
          updatedAtMs: Date.parse('2026-07-20T10:15:00.000Z'),
          exchangeCount: 3,
          workspaceRoot: '/workspace/fixture-two',
        },
        {
          sessionId: 'auggie-fixture-session-1',
          createdAtMs: Date.parse('2026-07-19T08:00:00.000Z'),
          updatedAtMs: Date.parse('2026-07-19T08:05:00.000Z'),
          exchangeCount: 1,
          workspaceRoot: '/workspace/fixture-one',
        },
      ],
      invalidRecordCount: 0,
    });
    const projected = JSON.stringify(parseAuggieSessionListV0_24_0(raw));
    expect(projected).not.toContain('userMessages');
    expect(projected).not.toContain('Inspect the deterministic fixture');
    expect(projected).not.toContain('request-fixture');
  });

  it('skips malformed summaries and tolerates unknown fields', () => {
    expect(parseAuggieSessionListV0_24_0({ summaries: [] })).toEqual({
      candidates: [],
      invalidRecordCount: 1,
    });
    expect(parseAuggieSessionListV0_24_0([
      null,
      { sessionId: '', modified: '2026-07-20T10:15:00.000Z' },
      { sessionId: 'missing-modified' },
      {
        sessionId: 'future-compatible',
        created: 'invalid',
        modified: '2026-07-20T10:15:00.000Z',
        exchangeCount: -1,
        futureField: { nested: true },
      },
    ])).toEqual({
      candidates: [{
        sessionId: 'future-compatible',
        updatedAtMs: Date.parse('2026-07-20T10:15:00.000Z'),
      }],
      invalidRecordCount: 3,
    });
  });

  it('preserves lifecycle identity and interrupt-aware Stop semantics without asserting authority', async () => {
    const content = await readFile(
      fixtureUrl('auggie-0.24.0-lifecycle-hooks.jsonl'),
      'utf8',
    );
    const records = content.trim().split('\n').map((line) => JSON.parse(line) as unknown);

    expect(records.map(parseAuggieLifecycleHookV0_24_0)).toEqual([
      {
        kind: 'session_started',
        conversationId: 'auggie-fixture-session-2',
        workspaceRoots: ['/workspace/fixture-two'],
      },
      {
        kind: 'turn_stopped',
        conversationId: 'auggie-fixture-session-2',
        workspaceRoots: ['/workspace/fixture-two'],
        cause: 'end_turn',
      },
      {
        kind: 'turn_stopped',
        conversationId: 'auggie-fixture-session-2',
        workspaceRoots: ['/workspace/fixture-two'],
        cause: 'interrupted',
      },
      {
        kind: 'session_ended',
        conversationId: 'auggie-fixture-session-2',
        workspaceRoots: ['/workspace/fixture-two'],
      },
    ]);
  });

  it('keeps unknown Stop causes explicit and rejects unqualified events', () => {
    expect(parseAuggieLifecycleHookV0_24_0({
      hook_event_name: 'Stop',
      conversation_id: 'auggie-future-stop',
      workspace_roots: ['/workspace/future'],
      agent_stop_cause: 'future_reason',
      futureField: true,
    })).toEqual({
      kind: 'turn_stopped',
      conversationId: 'auggie-future-stop',
      workspaceRoots: ['/workspace/future'],
      cause: 'unknown',
    });
    expect(parseAuggieLifecycleHookV0_24_0({
      hook_event_name: 'SessionStart',
      conversation_id: '',
      workspace_roots: [],
    })).toBeNull();
  });
});
