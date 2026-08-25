import { describe, expect, it } from 'vitest';

import { observeExactCodexAcpChildProcess } from './codexAcpChildProcess';

describe('exact Codex ACP child-process observation', () => {
  it('rejects an undifferentiated sole descendant', async () => {
    await expect(observeExactCodexAcpChildProcess(
      { runnerPid: 100 },
      {
        listProcessSnapshot: async () => [
          { pid: 101, ppid: 100, name: 'node', cmd: 'node worker.js', cpu: 0, memory: 0 },
        ],
        readProcessIdentityByPid: async () => ({
          pid: 101,
          ppid: 100,
          processStartTimeMs: 1_000,
          command: 'node worker.js --label codex-acp',
        }),
      },
    )).resolves.toBeNull();
  });

  it('returns one exact live Codex ACP descendant without exposing command material', async () => {
    await expect(observeExactCodexAcpChildProcess(
      { runnerPid: 100 },
      {
        listProcessSnapshot: async () => [
          { pid: 101, ppid: 100, name: 'sh', cmd: 'sh wrapper', cpu: 0, memory: 0 },
          { pid: 102, ppid: 101, name: 'codex-acp', cmd: '/opt/bin/codex-acp --stdio', cpu: 0, memory: 0 },
        ],
        readProcessIdentityByPid: async (pid) => pid === 102
          ? {
              pid,
              ppid: 101,
              processStartTimeMs: 2_000,
              command: '/opt/bin/codex-acp --stdio',
            }
          : {
              pid,
              ppid: 100,
              processStartTimeMs: 1_000,
              command: 'sh wrapper',
            },
      },
    )).resolves.toEqual({ pid: 102, processStartTimeMs: 2_000 });
  });

  it('matches an explicitly configured wrapper name and its platform suffix', async () => {
    await expect(observeExactCodexAcpChildProcess(
      { runnerPid: 200 },
      {
        expectedExecutable: 'C:\\tools\\private-codex-wrapper.cmd',
        listProcessSnapshot: async () => [
          {
            pid: 201,
            ppid: 200,
            name: 'private-codex-wrapper.exe',
            cmd: undefined,
          },
        ],
        readProcessIdentityByPid: async () => ({
          pid: 201,
          ppid: 200,
          processStartTimeMs: 3_000,
          command: 'cmd.exe /d /s /c C:\\tools\\private-codex-wrapper.cmd',
        }),
      },
    )).resolves.toEqual({ pid: 201, processStartTimeMs: 3_000 });
  });

  it('fails closed when more than one Codex ACP descendant matches', async () => {
    const processes = [301, 302].map((pid) => ({
      pid,
      ppid: 300,
      name: 'codex-acp',
      cmd: '/opt/bin/codex-acp',
    }));
    await expect(observeExactCodexAcpChildProcess(
      { runnerPid: 300 },
      {
        listProcessSnapshot: async () => processes,
        readProcessIdentityByPid: async (pid) => ({
          pid,
          ppid: 300,
          processStartTimeMs: pid * 10,
          command: '/opt/bin/codex-acp',
        }),
      },
    )).resolves.toBeNull();
  });
});
