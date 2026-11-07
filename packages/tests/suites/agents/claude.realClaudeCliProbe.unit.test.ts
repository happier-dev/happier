import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Claude itself is the OS/process boundary; parsing and stream handling stay real.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

import {
  extractToolUseBlocksFromStreamJsonLine,
  findClaudeSubagentJsonlPath,
  runRealClaudeCliStreamJsonProbe,
} from '../../src/testkit/providers/claude/realClaudeCliProbe';

describe('realClaudeCliProbe', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains final JSON records and diagnostics after root exit without extending the kill deadline', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
    vi.mocked(spawn).mockReturnValue(child);

    const probe = runRealClaudeCliStreamJsonProbe({
      prompt: 'fixture', timeoutMs: 1_000, maxTurns: 1,
      stopWhen: ({ toolUses }) => toolUses.length > 0,
    });
    child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read'] }) + '\n');
    Object.defineProperty(child, 'exitCode', { value: 0 });
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).not.toHaveBeenCalled();

    child.stdout.end(JSON.stringify({ type: 'assistant', session_id: 'session-final', message: {
      content: [{ type: 'tool_use', id: 'final-tool', name: 'Read', input: { path: 'fixture' } }],
    } }) + '\n' + JSON.stringify({ type: 'user', tool_use_result: { agent_id: 'agent-final' }, message: {
      content: [{ type: 'tool_result', tool_use_id: 'final-tool', content: 'final result' }],
    } }));
    child.stderr.end('final diagnostic');
    await vi.advanceTimersByTimeAsync(0);
    child.emit('close', 0, null);

    const result = await probe;
    expect(result.sessionId).toBe('session-final');
    expect(result.toolUses).toEqual([{ toolUseId: 'final-tool', name: 'Read', input: { path: 'fixture' } }]);
    expect(result.initTools).toEqual(['Read']);
    expect(result.toolUseNames).toEqual(['Read']);
    expect(result.toolResults).toEqual([{ toolUseId: 'final-tool', result: {
      content: 'final result', tool_use_result: { agent_id: 'agent-final' },
    } }]);
    expect(result.agentIds).toEqual(['agent-final']);
    expect(result.stdoutTail).toHaveLength(3);
    expect(result.stderrTail).toEqual(['final diagnostic']);
    expect(result.exitCode).toBe(0);
    await vi.runOnlyPendingTimersAsync();
    expect(kill).not.toHaveBeenCalled();
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
