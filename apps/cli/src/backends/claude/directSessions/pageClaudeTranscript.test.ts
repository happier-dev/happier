import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pageClaudeTranscript } from './pageClaudeTranscript';
import { readAfterClaudeTranscript } from './readAfterClaudeTranscript';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('pageClaudeTranscript', () => {
  it('fails observably when the existing oversized-line budget cannot establish a safe tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-page-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });
    await writeFile(sessionFile, JSON.stringify({ text: 'x'.repeat(8 * 1024 * 1024) }).slice(0, -1), 'utf8');
    const params = { source: { kind: 'claudeConfig' as const, configDir, projectId: 'proj-a' }, env: {}, remoteSessionId: 'sess-1', maxBytes: 1024, maxItems: 1 };

    await expect(pageClaudeTranscript({ ...params, direction: 'older' })).rejects.toMatchObject({ code: 'JSONL_RECORD_TOO_LARGE' });
    await expect(readAfterClaudeTranscript({ ...params, cursor: 'tail' })).rejects.toMatchObject({ code: 'JSONL_RECORD_TOO_LARGE' });
  });

  it.each([true, false])('delivers a terminal message completed after the latest-page snapshot (earlier message: %s)', async (hasEarlierMessage) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-page-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });
    const complete = hasEarlierMessage ? jsonlLine({ type: 'user', uuid: 'u1', message: { content: 'before' } }) : '';
    const pending = JSON.stringify({ type: 'user', uuid: 'u2', message: { content: 'completed after snapshot' } });
    await writeFile(sessionFile, complete + pending.slice(0, -1), 'utf8');
    const params = { source: { kind: 'claudeConfig' as const, configDir, projectId: 'proj-a' }, env: {}, remoteSessionId: 'sess-1', maxBytes: 1024, maxItems: 1 };

    const page = await pageClaudeTranscript({ ...params, direction: 'older' });
    expect(page.items).toHaveLength(hasEarlierMessage ? 1 : 0);
    expect(page.tailCursor).toBeTruthy();
    await appendFile(sessionFile, pending.slice(-1) + '\n', 'utf8');

    const followed = await readAfterClaudeTranscript({ ...params, cursor: page.tailCursor! });
    expect(followed.items.map((item) => item.raw)).toEqual([{ role: 'user', content: { type: 'text', text: 'completed after snapshot' } }]);
  });

  it('pages a Claude session JSONL file from newest backwards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-page-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });

    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'user', uuid: 'u1', message: { content: 'hello' } }),
        jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [{ type: 'text', text: 'hi' }] } }),
        // Internal event should be ignored.
        jsonlLine({ type: 'change', uuid: 'c1', payload: { foo: 'bar' } }),
        jsonlLine({ type: 'user', uuid: 'u2', message: { content: 'next' } }),
        jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'ok' }] } }),
      ].join(''),
      'utf8',
    );

    const first = await pageClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 2,
    });

    expect(first.items).toHaveLength(2);
    expect((first.items[0]?.raw as any)?.role).toBe('user');
    expect(((first.items[0]?.raw as any)?.content as any)?.text).toBe('next');
    expect((first.items[1]?.raw as any)?.role).toBe('agent');
    expect((((first.items[1]?.raw as any)?.content as any)?.data as any)?.message?.role).toBe('assistant');
    expect(first.nextCursor).toBeTruthy();
    expect(first.tailCursor).toBeTruthy();
    expect(first.hasMore).toBe(true);

    const second = await pageClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(second.items.map((m) => (m.raw as any)?.role)).toEqual(['user', 'agent']);
    expect(((second.items[0]?.raw as any)?.content as any)?.text).toBe('hello');
    expect((((second.items[1]?.raw as any)?.content as any)?.data as any)?.message?.role).toBe('assistant');
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();

    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'user', uuid: 'u1', message: { content: 'hello' } }),
        jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [{ type: 'text', text: 'hi' }] } }),
        jsonlLine({ type: 'change', uuid: 'c1', payload: { foo: 'bar' } }),
        jsonlLine({ type: 'user', uuid: 'u2', message: { content: 'next' } }),
        jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'ok' }] } }),
        jsonlLine({ type: 'user', uuid: 'u3', message: { content: 'follow after initial page' } }),
      ].join(''),
      'utf8',
    );

    const followed = await readAfterClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      cursor: first.tailCursor ?? 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(followed.items.map((item) => ((item.raw as any)?.content as any)?.text).filter(Boolean)).toEqual([
      'follow after initial page',
    ]);
  });

  it('drops internal Claude hook stdout records from compact hooks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-hook-stdout-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });

    await writeFile(
      sessionFile,
      [
        jsonlLine({
          type: 'assistant',
          uuid: 'a-hook-stdout',
          message: {
            role: 'assistant',
            model: 'm',
            content: [{
              type: 'text',
              text: [
                '<local-command-stdout>Compacted PreCompact [/Users/leeroy/.vibe-island/bin/vibe-island-bridge --source claude] completed successfully',
                "PreCompact [python3 '/Users/leeroy/.claude/hooks/claude-island-state.py'] completed successfully",
                "PostCompact [python3 '/Users/leeroy/.claude/hooks/claude-island-state.py'] completed successfully</local-command-stdout>",
              ].join('\n'),
            }],
          },
        }),
      ].join(''),
      'utf8',
    );

    const page = await pageClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(page.items).toHaveLength(0);
  });

  it('drops internal Claude local command user records from direct transcript pages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-local-command-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });

    await writeFile(
      sessionFile,
      [
        jsonlLine({
          type: 'user',
          uuid: 'local-command-caveat-1',
          isMeta: true,
          message: {
            content: '<local-command-caveat>Generated by a local command.</local-command-caveat>',
          },
        }),
        jsonlLine({
          type: 'user',
          uuid: 'compact-command-1',
          message: {
            content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
          },
        }),
        jsonlLine({
          type: 'user',
          uuid: 'model-empty-args-command-1',
          message: {
            content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
          },
        }),
        jsonlLine({
          type: 'user',
          uuid: 'effort-empty-args-command-1',
          message: {
            content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>',
          },
        }),
        jsonlLine({
          type: 'user',
          uuid: 'compact-stdout-1',
          message: {
            content: [
              {
                type: 'text',
                text: [
                  '<local-command-stdout>Compacted',
                  'PreCompact [hook] completed successfully',
                  'PostCompact [hook] completed successfully',
                  'Additional genuine multi-line Claude local-command stdout</local-command-stdout>',
                ].join('\n'),
              },
            ],
          },
        }),
        jsonlLine({ type: 'user', uuid: 'plain-compact-prompt-1', message: { content: '/compact' } }),
        jsonlLine({ type: 'user', uuid: 'real-user-1', message: { content: 'visible prompt' } }),
      ].join(''),
      'utf8',
    );

    const page = await pageClaudeTranscript({
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      env: {} as NodeJS.ProcessEnv,
      remoteSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(page.items.map((item) => JSON.stringify(item.raw)).join('\n')).not.toContain('local-command');
    expect(page.items.map((item) => JSON.stringify(item.raw)).join('\n')).not.toContain('<command-name>/compact');
    expect(page.items.map((item) => JSON.stringify(item.raw)).join('\n')).not.toContain('<command-name>/model');
    expect(page.items.map((item) => JSON.stringify(item.raw)).join('\n')).not.toContain('<command-name>/effort');
    expect(page.items.map((item) => JSON.stringify(item.raw)).join('\n')).toContain('/compact');
    expect(page.items.map((item) => JSON.stringify(item.raw)).join('\n')).toContain('visible prompt');
  });
});
