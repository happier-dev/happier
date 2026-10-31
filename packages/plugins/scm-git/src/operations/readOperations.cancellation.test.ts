import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithGitScmCommandRunner, type GitScmCommandRunner } from '../testkit/scmRuntime.test-support.js';
import { gitLogList } from './readOperations.js';

const runScmCommandMock = vi.fn<GitScmCommandRunner>();

describe('gitLogList cancellation', () => {
  beforeEach(() => {
    runScmCommandMock.mockReset();
  });

  it('recognizes a 64-hex SHA-256 candidate and verifies HEAD ancestry before reading it', async () => runWithGitScmCommandRunner(runScmCommandMock, async () => {
    runScmCommandMock.mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 });
    const sha256 = 'd'.repeat(64);

    const result = await gitLogList({
      context: { cwd: '/repo', projectKey: 'test:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.git' } },
      request: { cwd: '/repo', query: sha256, limit: 10 },
    });

    expect(result).toMatchObject({ success: true, queryApplied: true, entries: [] });
    expect(runScmCommandMock).toHaveBeenCalledTimes(4);
    expect(runScmCommandMock.mock.calls[2]?.[0]).toMatchObject({
      args: ['merge-base', '--is-ancestor', sha256, 'HEAD'],
    });
    expect(runScmCommandMock.mock.calls[3]?.[0]).toMatchObject({
      args: ['log', '--max-count=1', sha256, expect.any(String)],
    });
  }));

  it('shares one AbortSignal across every concurrent commit-query arm and waits for all to terminate', async () => runWithGitScmCommandRunner(runScmCommandMock, async () => {
    const controller = new AbortController();
    const terminated: number[] = [];
    runScmCommandMock.mockImplementation((input) => new Promise((resolve) => {
      const callIndex = runScmCommandMock.mock.calls.length;
      const settle = () => {
        terminated.push(callIndex);
        resolve({ success: false, stdout: '', stderr: 'SCM command was aborted', exitCode: -1 });
      };
      if (input.signal?.aborted) settle();
      else if (input.signal) input.signal.addEventListener('abort', settle, { once: true });
      else throw new Error('Every commit-query process must receive the caller signal');
    }));

    const result = gitLogList({
      context: { cwd: '/repo', projectKey: 'test:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.git' } },
      request: { cwd: '/repo', query: 'deadbeef', limit: 10 },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(runScmCommandMock).toHaveBeenCalledTimes(3));
    controller.abort();
    await result;

    expect(runScmCommandMock.mock.calls.map(([input]) => input.signal)).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
    expect(terminated).toHaveLength(3);
  }));
});
