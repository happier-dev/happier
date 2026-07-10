import { describe, expect, it, vi } from 'vitest';

import {
  AntigravityCliPrintOneShotError,
  runAntigravityCliPrintOneShot,
} from './oneShot.js';

function createRunResult(input: {
  exitCode: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}) {
  return {
    exitCode: input.exitCode,
    signal: input.signal ?? null,
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
  };
}

describe('runAntigravityCliPrintOneShot', () => {
  it('drives the host exec.run boundary with argv prompt, timeout, abort signal, and transcript evidence', async () => {
    const abort = new AbortController();
    const runExec = vi.fn(async () => createRunResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const transcriptSteps = [
      { id: 'assistant-1', kind: 'assistant_message' as const, text: 'from transcript' },
    ];

    await expect(runAntigravityCliPrintOneShot({
      agentId: 'antigravity',
      args: ['-p', 'write a summary', '--sandbox'],
      cwd: '/repo',
      prompt: 'write a summary',
      timeoutMs: 1_000,
      env: { SAFE_TEST_ENV: 'kept' },
      signal: abort.signal,
      run: runExec,
      readTranscriptSteps: async () => transcriptSteps,
    })).resolves.toMatchObject({
      status: 'completed',
      stdout: '',
      transcriptSteps,
    });

    expect(runExec).toHaveBeenCalledWith({
      kind: 'agent-cli',
      agentId: 'antigravity',
      args: ['-p', 'write a summary', '--sandbox'],
      cwd: '/repo',
      env: { SAFE_TEST_ENV: 'kept' },
    }, expect.objectContaining({
      signal: abort.signal,
      timeoutMs: 1_000,
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
    }));
  });

  it('resolves successful stdout from the host exec result', async () => {
    const runExec = vi.fn(async () => createRunResult({
      exitCode: 0,
      stdout: 'done\n',
    }));

    await expect(runAntigravityCliPrintOneShot({
      agentId: 'antigravity',
      args: ['-p'],
      cwd: '/repo',
      prompt: 'write a summary',
      timeoutMs: 1_000,
      run: runExec,
    })).resolves.toMatchObject({ status: 'completed', stdout: 'done\n' });
  });

  it('does not fail successful stdout when transcript evidence cannot be read', async () => {
    const runExec = vi.fn(async () => createRunResult({
      exitCode: 0,
      stdout: 'done\n',
    }));

    await expect(runAntigravityCliPrintOneShot({
      agentId: 'antigravity',
      args: ['-p'],
      cwd: '/repo',
      prompt: 'write a summary',
      timeoutMs: 1_000,
      run: runExec,
      readTranscriptSteps: async () => {
        throw new Error('Malformed Antigravity transcript JSONL at line 1');
      },
    })).resolves.toMatchObject({ status: 'completed', stdout: 'done\n' });
  });

  it('rejects exit-zero CLI error text written to stdout before it can become assistant output', async () => {
    const runExec = vi.fn(async () => createRunResult({
      exitCode: 0,
      stdout: 'Error: timed out waiting for response\n',
    }));

    const run = runAntigravityCliPrintOneShot({
      agentId: 'antigravity',
      args: ['-p'],
      cwd: '/repo',
      prompt: 'write a summary',
      timeoutMs: 1_000,
      run: runExec,
      hasTranscriptEvidence: async () => false,
    });

    await expect(run).rejects.toMatchObject({
      code: 'antigravity_cliprint_stdout_error',
      message: expect.stringContaining('timed out waiting for response'),
    });
    await expect(run).rejects.toBeInstanceOf(AntigravityCliPrintOneShotError);
  });

  it('rejects exit zero when neither stdout nor transcript evidence exists', async () => {
    const runExec = vi.fn(async () => createRunResult({
      exitCode: 0,
      stdout: '  ',
    }));

    await expect(runAntigravityCliPrintOneShot({
      agentId: 'antigravity',
      args: ['-p'],
      cwd: '/repo',
      prompt: 'silent',
      timeoutMs: 1_000,
      run: runExec,
      hasTranscriptEvidence: async () => false,
    })).rejects.toMatchObject({
      code: 'antigravity_cliprint_no_output',
    });
  });

  it('returns transcript steps as authoritative evidence when stdout is empty', async () => {
    const runExec = vi.fn(async () => createRunResult({
      exitCode: 0,
      stdout: '  ',
    }));
    const transcriptSteps = [
      { id: 'assistant-1', kind: 'assistant_message' as const, text: 'from transcript' },
    ];

    await expect(runAntigravityCliPrintOneShot({
      agentId: 'antigravity',
      args: ['-p'],
      cwd: '/repo',
      prompt: 'silent but recorded',
      timeoutMs: 1_000,
      run: runExec,
      readTranscriptSteps: async () => transcriptSteps,
    })).resolves.toMatchObject({
      status: 'completed',
      stdout: '  ',
      transcriptSteps,
    });
  });

  it('does not treat checkpoint and system transcript records as successful output evidence', async () => {
    const runExec = vi.fn(async () => createRunResult({
      exitCode: 0,
      stdout: '  ',
    }));

    await expect(runAntigravityCliPrintOneShot({
      agentId: 'antigravity',
      args: ['-p'],
      cwd: '/repo',
      prompt: 'silent control records',
      timeoutMs: 1_000,
      run: runExec,
      readTranscriptSteps: async () => [
        { kind: 'checkpoint' as const, checkpointId: 'cp-1' },
        { kind: 'system_message' as const, text: 'internal status' },
      ],
    })).rejects.toMatchObject({
      code: 'antigravity_cliprint_no_output',
    });
  });

  it('classifies non-zero exits without leaking control to console output', async () => {
    const runExec = vi.fn(async () => createRunResult({
      exitCode: 2,
      stdout: '',
      stderr: 'auth failed',
    }));

    const run = runAntigravityCliPrintOneShot({
      agentId: 'antigravity',
      args: ['-p'],
      cwd: '/repo',
      prompt: 'fail',
      timeoutMs: 1_000,
      run: runExec,
    });

    await expect(run).rejects.toMatchObject({
      code: 'antigravity_cliprint_exit_nonzero',
      exitCode: 2,
      stderr: 'auth failed',
    });
    await expect(run).rejects.toBeInstanceOf(AntigravityCliPrintOneShotError);
  });
});
