import { describe, expect, it } from 'vitest';

import { executionRunsCapability } from './toolExecutionRuns';

describe('tool.executionRuns capability', () => {
  it('reports unavailable when the execution.runs feature is locally disabled', async () => {
    const prev = process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED;
    process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED = '0';
    try {
      const result = await executionRunsCapability.detect({
        request: { id: 'tool.executionRuns' as any },
        context: { cliSnapshot: null },
      });

      expect((result as any).available).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED;
      else process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED = prev;
    }
  });

  it('omits voice_agent intent when voice is locally disabled', async () => {
    const prevVoice = process.env.HAPPIER_FEATURE_VOICE__ENABLED;
    const prevRuns = process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED;
    process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED = '1';
    process.env.HAPPIER_FEATURE_VOICE__ENABLED = '0';
    try {
      const result = await executionRunsCapability.detect({
        request: { id: 'tool.executionRuns' as any },
        context: { cliSnapshot: null },
      });

      expect((result as any).available).toBe(true);
      expect((result as any).intents).not.toContain('voice_agent');
    } finally {
      if (prevVoice === undefined) delete process.env.HAPPIER_FEATURE_VOICE__ENABLED;
      else process.env.HAPPIER_FEATURE_VOICE__ENABLED = prevVoice;
      if (prevRuns === undefined) delete process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED;
      else process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED = prevRuns;
    }
  });

  it('reports coderabbit backend available when the command exists on PATH even without an override env var', async () => {
    const prevRuns = process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED;
    const prevCmd = process.env.HAPPIER_CODERABBIT_REVIEW_CMD;
    process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED = '1';
    delete process.env.HAPPIER_CODERABBIT_REVIEW_CMD;

    const { mkdtemp, writeFile, chmod } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const dir = await mkdtemp(join(tmpdir(), 'happier-coderabbit-path-'));
    const bin = join(dir, process.platform === 'win32' ? 'coderabbit.cmd' : 'coderabbit');
    await writeFile(bin, process.platform === 'win32' ? '@echo off\r\necho 0.0.0\r\n' : '#!/bin/sh\necho 0.0.0\n', 'utf8');
    if (process.platform !== 'win32') await chmod(bin, 0o755);

    try {
      const result = await executionRunsCapability.detect({
        request: { id: 'tool.executionRuns' as any },
        context: { cliSnapshot: { path: dir, clis: {}, tmux: { available: false } } } as any,
      });

      expect((result as any).available).toBe(true);
      expect((result as any).backends?.coderabbit?.available).toBe(true);
    } finally {
      if (prevRuns === undefined) delete process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED;
      else process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED = prevRuns;
      if (prevCmd === undefined) delete process.env.HAPPIER_CODERABBIT_REVIEW_CMD;
      else process.env.HAPPIER_CODERABBIT_REVIEW_CMD = prevCmd;
    }
  });
});
