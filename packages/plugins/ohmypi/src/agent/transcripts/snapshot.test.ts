import { describe, expect, it } from 'vitest';

import { projectOhMyPiSessionSnapshotToDirectMessages } from './snapshot.js';

describe('projectOhMyPiSessionSnapshotToDirectMessages', () => {
  it('projects the current v3 title slot and canonical tool message shapes', () => {
    const projected = projectOhMyPiSessionSnapshotToDirectMessages({
      sessionFilePath: '/tmp/current-omp-session.jsonl',
      sessionId: 'sess-current',
      lines: [
        {
          type: 'title',
          v: 1,
          title: 'Current slot title',
          updatedAt: '2026-07-21T10:00:00.000Z',
          pad: ' ',
        },
        {
          type: 'session',
          version: 3,
          id: 'sess-current',
          timestamp: '2026-07-21T09:59:00.000Z',
          cwd: '/repo/current',
          title: 'Stale header title',
        },
        {
          type: 'message',
          id: 'assistant-1',
          parentId: null,
          timestamp: '2026-07-21T10:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'README.md' } },
            ],
            usage: { input: 12, output: 4 },
          },
        },
        {
          type: 'message',
          id: 'tool-result-1',
          parentId: 'assistant-1',
          timestamp: '2026-07-21T10:00:02.000Z',
          message: {
            role: 'toolResult',
            toolCallId: 'tool-1',
            toolName: 'read',
            content: [{ type: 'text', text: 'file contents' }],
            isError: false,
          },
        },
      ],
    });

    expect(projected).toMatchObject({
      title: 'Current slot title',
      workingDirectory: '/repo/current',
      createdAtMs: Date.parse('2026-07-21T09:59:00.000Z'),
    });
    const [toolCallItem, toolResultItem] = projected.items;
    expect(toolCallItem?.id).toMatch(/^omp:[A-Za-z0-9_-]+:assistant-1:toolCall:0$/u);
    expect(toolResultItem?.id).toMatch(/^omp:[A-Za-z0-9_-]+:tool-result-1:toolResult$/u);
    expect(projected.items.map((item) => item.raw)).toEqual([
      {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'ohMyPi',
          data: {
            type: 'tool-call',
            callId: 'tool-1',
            id: toolCallItem?.id,
            name: 'read',
            input: { path: 'README.md' },
          },
        },
      },
      {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'ohMyPi',
          data: {
            type: 'tool-result',
            callId: 'tool-1',
            id: toolResultItem?.id,
            output: [{ type: 'text', text: 'file contents' }],
            isError: false,
          },
        },
      },
    ]);
  });

  it('projects the persisted visible root-to-leaf path and ignores off-path branches', () => {
    const projected = projectOhMyPiSessionSnapshotToDirectMessages({
      sessionFilePath: '/tmp/omp-session.jsonl',
      sessionId: 'sess-1',
      lines: [
        {
          type: 'session',
          id: 'sess-1',
          timestamp: '2026-04-10T10:00:00.000Z',
          cwd: '/repo',
          title: 'OMP session',
        },
        {
          type: 'message',
          id: 'user-1',
          parentId: null,
          timestamp: '2026-04-10T10:00:01.000Z',
          message: { role: 'user', content: 'hello world' },
        },
        {
          type: 'message',
          id: 'assistant-1',
          parentId: 'user-1',
          timestamp: '2026-04-10T10:00:02.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'hi there' },
              { type: 'thinking', thinking: 'reasoning' },
            ],
          },
        },
        {
          type: 'message',
          id: 'branch-user',
          parentId: 'assistant-1',
          timestamp: '2026-04-10T10:00:03.000Z',
          message: { role: 'user', content: 'branch prompt' },
        },
        {
          type: 'branch_summary',
          id: 'summary-1',
          parentId: 'assistant-1',
          timestamp: '2026-04-10T10:00:04.000Z',
          summary: 'branch summary',
        },
        {
          type: 'message',
          id: 'leaf-user',
          parentId: 'assistant-1',
          timestamp: '2026-04-10T10:00:05.000Z',
          message: { role: 'user', content: 'mainline prompt' },
        },
        {
          type: 'compaction',
          id: 'compact-1',
          parentId: 'leaf-user',
          timestamp: '2026-04-10T10:00:06.000Z',
          summary: 'compacted summary',
        },
        {
          type: 'message',
          id: 'assistant-2',
          parentId: 'compact-1',
          timestamp: '2026-04-10T10:00:07.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
              { type: 'text', text: 'final answer' },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      ],
    });

    expect(projected.items.map((item) => item.id.replace(/^omp:[A-Za-z0-9_-]+:/u, ''))).toEqual([
      'user-1',
      'assistant-1:text:0',
      'assistant-1:thinking:1',
      'leaf-user',
      'compact-1:compaction',
      'assistant-2:tool_use:0',
      'assistant-2:tool_result:1',
      'assistant-2:text:2',
    ]);
    expect(projected.items.map((item) => item.raw.role)).toEqual([
      'user',
      'agent',
      'agent',
      'user',
      'agent',
      'agent',
      'agent',
      'agent',
    ]);
    expect(JSON.stringify(projected.items)).toContain('final answer');
    expect(JSON.stringify(projected.items)).not.toContain('branch prompt');
    expect(JSON.stringify(projected.items)).not.toContain('branch summary');
    expect(JSON.stringify(projected.items)).not.toContain('/tmp/omp-session.jsonl');
    expect(projected.title).toBe('OMP session');
    expect(projected.workingDirectory).toBe('/repo');
    expect(projected.lastActivityAtMs).toBe(Date.parse('2026-04-10T10:00:07.000Z'));
  });
});
