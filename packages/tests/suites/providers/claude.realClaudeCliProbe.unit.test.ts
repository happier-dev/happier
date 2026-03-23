import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  extractToolUseBlocksFromStreamJsonLine,
  findClaudeSubagentJsonlPath,
} from '../../src/testkit/providers/claude/realClaudeCliProbe';

describe('realClaudeCliProbe', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts tool_use ids from assistant stream-json records', () => {
    const input = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 'toolu_123', name: 'TaskCreate', input: { description: 'x' } },
        ],
      },
    };

    expect(extractToolUseBlocksFromStreamJsonLine(input)).toEqual([
      { toolUseId: 'toolu_123', name: 'TaskCreate', input: { description: 'x' } },
    ]);
  });

  it('finds hashed teammate subagent JSONL files via adjacent meta agentType', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'claude-probe-home-'));
    tempDirs.push(fakeHome);
    const sessionId = 'session-123';
    const projectDir = join(fakeHome, '.claude', 'projects', 'example-project', sessionId, 'subagents');
    mkdirSync(projectDir, { recursive: true });

    const jsonlPath = join(projectDir, 'agent-a92d2102c02f3209a.jsonl');
    writeFileSync(
      jsonlPath,
      JSON.stringify({
        sessionId,
        agentId: 'a92d2102c02f3209a',
        type: 'user',
        message: {
          role: 'user',
          content:
            '<teammate-message teammate_id="team-lead" summary="Alpha agent for probe team">\nYou are Alpha, a teammate on the probe team.\n</teammate-message>',
        },
      }) + '\n',
      'utf8',
    );
    writeFileSync(join(projectDir, 'agent-a92d2102c02f3209a.meta.json'), JSON.stringify({ agentType: 'Alpha-3' }), 'utf8');

    expect(
      findClaudeSubagentJsonlPath({
        sessionId,
        agentId: 'Alpha-3@probe',
        claudeHomeDir: join(fakeHome, '.claude'),
      }),
    ).toBe(jsonlPath);
  });
});
