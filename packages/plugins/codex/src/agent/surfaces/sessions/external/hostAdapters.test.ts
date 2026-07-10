import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExternalSessionRuntimeHostAdapterParamsV1 } from '@happier-dev/plugin-sdk/sessions';
import { describe, expect, it } from 'vitest';

import {
  createCodexExternalSessionCandidateHostAdapter,
  createCodexExternalSessionTranscriptStoreAdapter,
} from './hostAdapters.js';

const unusedExec = Object.freeze({
  systemTools: {
    resolve: async () => {
      throw new Error('exec.systemTools.resolve should not be used by rollout-backed external sessions');
    },
  },
  run: async () => {
    throw new Error('exec.run should not be used by rollout-backed external sessions');
  },
  spawn: async () => {
    throw new Error('exec.spawn should not be used by rollout-backed external sessions');
  },
  spawnClient: async () => {
    throw new Error('exec.spawnClient should not be used by rollout-backed external sessions in fast search mode');
  },
} satisfies ExternalSessionRuntimeHostAdapterParamsV1['exec']);

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('Codex external-session host adapter contribution factories', () => {
  it('list and page rollout-backed sessions without CLI host-adapter bridge imports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-external-host-adapter-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '02', '14');
      await mkdir(sessionsDir, { recursive: true });
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      await writeFile(
        join(sessionsDir, `rollout-2026-02-14T08-28-05-${remoteSessionId}.jsonl`),
        [
          jsonl({
            type: 'session_meta',
            timestamp: '2026-02-14T08:28:05.000Z',
            payload: {
              id: remoteSessionId,
              timestamp: '2026-02-14T08:28:05.000Z',
              cwd: '/repo/codex',
            },
          }),
          jsonl({
            type: 'response_item',
            timestamp: '2026-02-14T08:28:30.000Z',
            payload: {
              type: 'function_call',
              call_id: 'title-call-1',
              name: 'mcp__happier__change_title',
              arguments: JSON.stringify({ title: 'Inspect Codex session titles' }),
            },
          }),
          jsonl({
            type: 'response_item',
            timestamp: '2026-02-14T08:29:05.000Z',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Plugin-owned transcript adapter works' }],
            },
          }),
        ].join(''),
        'utf8',
      );

      const adapterParams = {
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        exec: unusedExec,
      };
      const source = { kind: 'codexHome', home: 'user' } as const;
      const candidateAdapter = createCodexExternalSessionCandidateHostAdapter(adapterParams);
      const candidatePage = await candidateAdapter.listViaChildHost({
        agentId: 'codex',
        source,
        limit: 10,
        searchMode: 'fast',
      });

      expect(candidatePage.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([remoteSessionId]);
      expect(candidatePage.candidates[0]?.title).toBe('Inspect Codex session titles');
      expect(candidatePage.candidates[0]?.details).toMatchObject({
        cwd: '/repo/codex',
      });

      const transcriptAdapter = createCodexExternalSessionTranscriptStoreAdapter(adapterParams);
      await expect(transcriptAdapter.getWorkingDirectory({
        agentId: 'codex',
        source,
        providerSessionId: remoteSessionId,
      })).resolves.toBe('/repo/codex');

      const page = await transcriptAdapter.page({
        agentId: 'codex',
        source,
        providerSessionId: remoteSessionId,
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 10,
      });

      expect(page.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          raw: {
            role: 'agent',
            content: {
              type: 'codex',
              data: {
                type: 'message',
                message: 'Plugin-owned transcript adapter works',
              },
            },
          },
        }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('hydrates rollout-backed titles from canonical non-MCP title aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-external-title-alias-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '02', '15');
      await mkdir(sessionsDir, { recursive: true });
      const remoteSessionId = '22222222-2222-2222-2222-222222222222';
      await writeFile(
        join(sessionsDir, `rollout-2026-02-15T08-28-05-${remoteSessionId}.jsonl`),
        [
          jsonl({
            type: 'session_meta',
            timestamp: '2026-02-15T08:28:05.000Z',
            payload: {
              id: remoteSessionId,
              timestamp: '2026-02-15T08:28:05.000Z',
              cwd: '/repo/codex',
            },
          }),
          jsonl({
            type: 'response_item',
            timestamp: '2026-02-15T08:28:30.000Z',
            payload: {
              type: 'function_call',
              call_id: 'title-call-plain-1',
              name: 'session_title_set',
              arguments: JSON.stringify({ title: 'Plain Alias Codex Title' }),
            },
          }),
        ].join(''),
        'utf8',
      );

      const candidateAdapter = createCodexExternalSessionCandidateHostAdapter({
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        exec: unusedExec,
      });

      const candidatePage = await candidateAdapter.listViaChildHost({
        agentId: 'codex',
        source: { kind: 'codexHome', home: 'user' },
        limit: 10,
        searchMode: 'fast',
      });

      expect(candidatePage.candidates).toHaveLength(1);
      expect(candidatePage.candidates[0]?.title).toBe('Plain Alias Codex Title');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('hydrates rollout-backed titles from canonical MCP title aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-external-mcp-title-alias-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '02', '16');
      await mkdir(sessionsDir, { recursive: true });
      const remoteSessionId = '33333333-3333-3333-3333-333333333333';
      await writeFile(
        join(sessionsDir, `rollout-2026-02-16T08-28-05-${remoteSessionId}.jsonl`),
        [
          jsonl({
            type: 'session_meta',
            timestamp: '2026-02-16T08:28:05.000Z',
            payload: {
              id: remoteSessionId,
              timestamp: '2026-02-16T08:28:05.000Z',
              cwd: '/repo/codex',
            },
          }),
          jsonl({
            type: 'response_item',
            timestamp: '2026-02-16T08:28:30.000Z',
            payload: {
              type: 'function_call',
              call_id: 'title-call-mcp-1',
              name: 'mcp__happy__session_title_set',
              arguments: JSON.stringify({ title: 'MCP Alias Codex Title' }),
            },
          }),
        ].join(''),
        'utf8',
      );

      const candidateAdapter = createCodexExternalSessionCandidateHostAdapter({
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        exec: unusedExec,
      });

      const candidatePage = await candidateAdapter.listViaChildHost({
        agentId: 'codex',
        source: { kind: 'codexHome', home: 'user' },
        limit: 10,
        searchMode: 'fast',
      });

      expect(candidatePage.candidates).toHaveLength(1);
      expect(candidatePage.candidates[0]?.title).toBe('MCP Alias Codex Title');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
