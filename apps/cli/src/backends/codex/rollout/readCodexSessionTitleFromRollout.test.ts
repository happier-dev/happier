import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSessionStateSyncEngine } from '@happier-dev/agents';
import { createCodexRolloutDisplayTitleHandler } from '@happier-dev/plugins-codex/agent/state/displayTitle';
import { readCodexSessionTitleFromRollout } from './readCodexSessionTitleFromRollout';
import { CODEX_SESSION_STATE_CAPABILITIES, codexSessionStateFacet } from '../sessionState';

function sessionMetaLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
  return `${JSON.stringify({ type: 'response_item', timestamp: params.timestamp, payload: params.payload })}\n`;
}

describe('readCodexSessionTitleFromRollout', () => {
  it('skips title boilerplate and scans later pages for the first meaningful user task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-title-'));
    const sessionsDir = join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '11111111-1111-1111-1111-111111111111';
    const filePath = join(sessionsDir, `rollout-2026-03-06T00-00-00-${sessionId}.jsonl`);
    const boilerplate = [
      '# Session title',
      "At the start of the session (before you respond to the first user message), you MUST call the change_title tool once to set a short, descriptive session title based on the user's message.",
    ].join('\n');
    const meaningfulTask = 'Investigate direct transcript paging parity in the direct session browser';

    const lines = [
      sessionMetaLine({ id: sessionId, timestamp: '2026-03-06T00:00:00.000Z', cwd: '/repo/one' }),
      ...Array.from({ length: 80 }, (_, index) =>
        responseItemLine({
          timestamp: `2026-03-06T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: boilerplate }],
          },
        }),
      ),
      responseItemLine({
        timestamp: '2026-03-06T00:02:00.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: meaningfulTask }],
        },
      }),
    ];

    await writeFile(filePath, lines.join(''), 'utf8');

    await expect(readCodexSessionTitleFromRollout(filePath)).resolves.toBe(meaningfulTask);
  });

  it('exposes rollout title adoption as the Codex display.title provider field handler', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-display-title-'));
    const filePath = join(root, 'rollout.jsonl');
    await writeFile(
      filePath,
      responseItemLine({
        timestamp: '2026-03-06T00:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Summarize display title adoption' }],
        },
      }),
      'utf8',
    );

    const handler = createCodexRolloutDisplayTitleHandler({
      readTitle: () => readCodexSessionTitleFromRollout(filePath),
    });

    await expect(handler.readField?.({ sessionId: 'sess-1' })).resolves.toBe('Summarize display title adoption');
  });

  it('prefers Happier MCP change_title tool calls over fallback text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-mcp-title-'));
    const filePath = join(root, 'rollout.jsonl');
    await writeFile(
      filePath,
      [
        responseItemLine({
          timestamp: '2026-03-06T00:00:01.000Z',
          payload: {
            type: 'function_call',
            call_id: 'call-title',
            server: 'happier',
            tool: 'change_title',
            name: 'mcp__happier__change_title',
            arguments: JSON.stringify({ title: 'Canonical MCP title' }),
          },
        }),
        responseItemLine({
          timestamp: '2026-03-06T00:00:02.000Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Fallback user task' }],
          },
        }),
      ].join(''),
      'utf8',
    );

    await expect(readCodexSessionTitleFromRollout(filePath)).resolves.toBe('Canonical MCP title');
  });

  it('recognizes centralized session_title_set aliases when reading rollout titles', async () => {
    const filePath = join(tmpdir(), `codex-title-${Date.now()}-${Math.random()}.jsonl`);
    await writeFile(
      filePath,
      [
        responseItemLine({
          timestamp: '2026-03-06T00:00:01.000Z',
          payload: {
            type: 'function_call',
            call_id: 'call-central-title',
            server: 'happier',
            tool: 'session_title_set',
            name: 'mcp__happier__session_title_set',
            arguments: JSON.stringify({ title: 'Central Alias Title' }),
          },
        }),
      ].join('\n'),
      'utf8',
    );

    await expect(readCodexSessionTitleFromRollout(filePath)).resolves.toBe('Central Alias Title');
  });

  it('ignores non-centralized change_title aliases when reading rollout titles', async () => {
    const filePath = join(tmpdir(), `codex-title-collision-${Date.now()}-${Math.random()}.jsonl`);
    await writeFile(
      filePath,
      [
        responseItemLine({
          timestamp: '2026-03-06T00:00:01.000Z',
          payload: {
            type: 'function_call',
            call_id: 'call-colliding-title',
            name: 'mcp__happy__change_title',
            arguments: JSON.stringify({ title: 'Colliding Alias Title' }),
          },
        }),
        responseItemLine({
          timestamp: '2026-03-06T00:00:02.000Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Fallback user task' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    await expect(readCodexSessionTitleFromRollout(filePath)).resolves.toBe('Fallback user task');
  });

  it('requires the rollout source envelope to identify the Happier MCP server before adopting title tool aliases', async () => {
    const filePath = join(tmpdir(), `codex-title-source-collision-${Date.now()}-${Math.random()}.jsonl`);
    await writeFile(
      filePath,
      [
        responseItemLine({
          timestamp: '2026-03-06T00:00:01.000Z',
          payload: {
            type: 'function_call',
            call_id: 'call-spoofed-title',
            server: 'acme',
            tool: 'change_title',
            name: 'mcp__happier__change_title',
            arguments: JSON.stringify({ title: 'Spoofed Title' }),
          },
        }),
        responseItemLine({
          timestamp: '2026-03-06T00:00:02.000Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Fallback user task after spoofed title' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    await expect(readCodexSessionTitleFromRollout(filePath)).resolves.toBe('Fallback user task after spoofed title');
  });

  it('ignores bare change_title function calls when reading rollout titles', async () => {
    const filePath = join(tmpdir(), `codex-title-bare-change-title-${Date.now()}-${Math.random()}.jsonl`);
    await writeFile(
      filePath,
      [
        responseItemLine({
          timestamp: '2026-03-06T00:00:01.000Z',
          payload: {
            type: 'function_call',
            call_id: 'call-bare-title',
            name: 'change_title',
            arguments: JSON.stringify({ title: 'Bare Function Title' }),
          },
        }),
        responseItemLine({
          timestamp: '2026-03-06T00:00:02.000Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Fallback user task wins' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    await expect(readCodexSessionTitleFromRollout(filePath)).resolves.toBe('Fallback user task wins');
  });

  it('exposes rollout title adoption through the Codex session-state facet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-display-title-facet-'));
    const filePath = join(root, 'rollout.jsonl');
    await writeFile(
      filePath,
      responseItemLine({
        timestamp: '2026-03-06T00:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Read title through session state facet' }],
        },
      }),
      'utf8',
    );

    expect(codexSessionStateFacet.capabilities?.display?.title?.providerToHappier).toMatchObject({
      supported: true,
      source: 'snapshot',
    });
    await expect(codexSessionStateFacet.readField(
      { sessionId: 'sess-1', rolloutFilePath: filePath },
      'display.title',
    )).resolves.toBe('Read title through session state facet');
  });

  it('treats rollout title adoption as provider-to-Happier snapshot only', async () => {
    expect(codexSessionStateFacet.capabilities?.display?.title?.happierToProvider).toEqual({
      supported: false,
    });

    const engine = createSessionStateSyncEngine({
      capabilities: CODEX_SESSION_STATE_CAPABILITIES,
      facet: codexSessionStateFacet,
    });

    await expect(engine.applyHappierField({
      ctx: { sessionId: 'sess-1' },
      fieldId: 'display.title',
      value: 'Attempted provider rename',
      reason: 'user-mutation',
    })).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
  });
});
