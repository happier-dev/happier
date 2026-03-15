import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveClaudeSubagentJsonlPathForRemoteSession } from './resolveClaudeSubagentJsonlPathForRemoteSession';

describe('resolveClaudeSubagentJsonlPathForRemoteSession', () => {
  it('infers claudeSessionId from transcriptPath when claudeSessionId is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-claude-subagent-resolve-'));
    try {
      const projectDir = join(dir, 'project');
      const sessionId = 'sess_1';
      const agentId = 'abc123';
      const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
      const expected = join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
      await mkdir(join(projectDir, sessionId, 'subagents'), { recursive: true });
      await writeFile(transcriptPath, '', 'utf8');
      await writeFile(expected, '{"type":"assistant","uuid":"a1"}\n', 'utf8');

      const resolved = resolveClaudeSubagentJsonlPathForRemoteSession({
        transcriptPath,
        projectDir,
        claudeSessionId: null,
        agentId,
      });

      expect(resolved).toBe(expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prefers explicit claudeSessionId over transcriptPath inference', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-claude-subagent-resolve-'));
    try {
      const projectDir = join(dir, 'project');
      const sessionId = 'sess_explicit';
      const agentId = 'abc123';
      const transcriptPath = join(projectDir, `other.jsonl`);
      const expected = join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
      await mkdir(join(projectDir, sessionId, 'subagents'), { recursive: true });
      await writeFile(transcriptPath, '', 'utf8');
      await writeFile(expected, '{"type":"assistant","uuid":"a1"}\n', 'utf8');

      const resolved = resolveClaudeSubagentJsonlPathForRemoteSession({
        transcriptPath,
        projectDir,
        claudeSessionId: sessionId,
        agentId,
      });

      expect(resolved).toBe(expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
