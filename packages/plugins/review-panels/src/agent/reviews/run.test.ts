import { describe, expect, it, vi } from 'vitest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';

import { runPanelReview, type PanelReviewRunInput } from './run.js';

function completed(stdout = '', exitCode = 0): PluginProcessResult {
  return {
    stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(),
    stdoutTruncated: false, stderrTruncated: false,
    termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
  };
}

function fixture() {
  const controller = new AbortController();
  const input: PanelReviewRunInput = {
    runId: 'review-42', cwd: '/repo', executable: { kind: 'managedDependency', id: 'review-executable' },
    reviewArgs: ['--since', 'base-sha', '--sha', 'head-sha', '--panel', 'default'],
    env: { SELECTED_CREDENTIAL: 'selected-value' }, signal: controller.signal,
  };
  const output = JSON.stringify({
    job_id: 42, job: { id: 42, status: 'done' },
    structured_output: { schema_version: 3, verdict: 'pass', summary: 'Reviewed the selected comparison.', findings: [] },
  });
  // Exec and the host filesystem accessor are genuine OS boundaries.
  const run = vi.fn<ExecService['run']>(async ({ args }) => {
    if (args?.[0] === 'review') return completed('Enqueued job 42 (panel: default, 2 reviewers) for base-sha..head-sha\n');
    if (args?.[1] === 'list') return completed(JSON.stringify([{ id: 42, job_type: 'synthesis' }]));
    if (args?.[1] === 'show') return completed(output);
    return completed();
  });
  const fs = { getPluginDataDirectory: vi.fn(async () => '/host/plugin-data/runs/review-42'), writeFile: vi.fn(async () => {}) };
  return { input, controller, run, services: { exec: { run }, fs } };
}

describe('finite native panel run', () => {
  it('uses isolated durable state, reads only its selected job, and stops at completion', async () => {
    const { input, run, services } = fixture();
    expect(await runPanelReview(services, input)).toMatchObject({ outcome: 'complete', verdict: 'pass', findings: [] });
    expect(services.fs.getPluginDataDirectory).toHaveBeenCalledWith({ relativePath: 'runs/review-42', signal: input.signal });
    // Constant process work, independent of stored review history and panel size.
    expect(run.mock.calls.map(([request]) => request.args)).toEqual([
      ['daemon', 'start'], ['review', ...input.reviewArgs, '--quiet'], ['job', 'list', '--json'], ['job', 'wait', '--job', '42'],
      ['job', 'show', '--job', '42', '--json'], ['daemon', 'stop'],
    ]);
    for (const [request] of run.mock.calls) {
      expect(request).toMatchObject({ cwd: input.cwd, env: {
        SELECTED_CREDENTIAL: 'selected-value', ROBOREV_DATA_DIR: '/host/plugin-data/runs/review-42', ROBOREV_TELEMETRY_ENABLED: '0',
      } });
    }
    expect(run.mock.calls[0]?.[1]).toMatchObject({ descendantDisposition: 'preserve-on-success' });
  });

  it('uses native quiet submission to suppress automatic hook maintenance', async () => {
    const { input, run, services } = fixture();
    await runPanelReview(services, { ...input, env: { ...input.env,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.algorithm', GIT_CONFIG_VALUE_0: 'histogram',
      GIT_CONFIG_PARAMETERS: "'color.ui=false'",
    } });
    expect(run.mock.calls.find(([request]) => request.args?.[0] === 'review')?.[0].args).toContain('--quiet');
    expect(run.mock.calls[0]?.[0].env).toMatchObject({
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.algorithm', GIT_CONFIG_VALUE_0: 'histogram',
      GIT_CONFIG_PARAMETERS: "'color.ui=false'",
    });
  });

  it('retrieves structured findings after native wait exits 1', async () => {
    const { input, run, services } = fixture();
    run.mockImplementation(async ({ args }) => {
      if (args?.[0] === 'review') return completed('Enqueued job 42 for head (agent: codex)\n');
      if (args?.[1] === 'list') return completed('[{"id":42}]');
      if (args?.[1] === 'wait') return completed('', 1);
      if (args?.[1] === 'show') return completed(JSON.stringify({ job_id: 42, structured_output: {
        schema_version: 3, verdict: 'fail', summary: 'Found a defect.', findings: [{
          severity: 'high', problem: 'Incorrect result.', fix: 'Handle the missing case.',
        }],
      } }));
      return completed();
    });
    expect(await runPanelReview(services, input)).toMatchObject({ outcome: 'complete', verdict: 'fail', findings: [{ summary: 'Incorrect result.' }] });
  });

  it('selects the native job without requiring a rendered enqueue receipt', async () => {
    const { input, run, services } = fixture();
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (request, options) => request.args?.[0] === 'review'
      ? completed()
      : original(request, options));
    expect(await runPanelReview(services, input)).toMatchObject({ verdict: 'pass', outcome: 'complete' });
  });

  it.each(['[]', '[{"id":1},{"id":2}]', '[{"id":"42"}]', 'not-json'])('refuses missing, ambiguous or malformed native job selection: %s', async listing => {
    const { input, run, services } = fixture();
    const original = run.getMockImplementation()!;
    run.mockImplementation((request, options) => request.args?.[1] === 'list' ? Promise.resolve(completed(listing)) : original(request, options));
    await expect(runPanelReview(services, input)).rejects.toMatchObject({ code: 'panel_job_missing' });
    expect(run.mock.calls.at(-1)?.[0].args).toEqual(['daemon', 'stop']);
  });

  it.each(['startup', 'review', 'document', 'wrong-job'])('stops the isolated daemon after %s failure', async (phase) => {
    const { input, run, services } = fixture();
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (request, options) => {
      const args = request.args;
      if (phase === 'startup' && args?.[1] === 'start') return completed('', 1);
      if (phase === 'review' && args?.[0] === 'review') throw new Error('OS spawn failure');
      if (phase === 'document' && args?.[1] === 'show') return completed(JSON.stringify({ job_id: 42, output: 'No findings.' }));
      if (phase === 'wrong-job' && args?.[1] === 'show') return completed(JSON.stringify({ job_id: 99, structured_output: { schema_version: 3, verdict: 'pass', summary: 'Another review.', findings: [] } }));
      return original(request, options);
    });
    await expect(runPanelReview(services, input)).rejects.toThrow();
    expect(run.mock.calls.at(-1)?.[0].args).toEqual(['daemon', 'stop']);
  });

  it('cancels the active review and still awaits daemon cleanup without the canceled signal', async () => {
    const { input, controller, run, services } = fixture();
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (request, options) => {
      if (request.args?.[1] === 'wait') {
        controller.abort();
        options?.signal?.throwIfAborted();
      }
      return original(request, options);
    });
    await expect(runPanelReview(services, input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(run.mock.calls.at(-1)?.[0].args).toEqual(['daemon', 'stop']);
    expect(run.mock.calls.at(-2)?.[0].args).toEqual(['job', 'cancel', '42']);
    expect(run.mock.calls.at(-1)?.[1]?.signal?.aborted).not.toBe(true);
  });

  it.each(['start', 'review', 'list'])('finishes native %s custody acquisition before honoring cancellation', async (phase) => {
    const { input, controller, run, services } = fixture();
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (request, options) => {
      if ((phase === 'review' && request.args?.[0] === 'review') || (phase === 'start' && request.args?.[1] === 'start') || (phase === 'list' && request.args?.[1] === 'list')) {
        expect(options?.signal).toBeUndefined();
        controller.abort();
      }
      return original(request, options);
    });
    await expect(runPanelReview(services, input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(run.mock.calls.at(-1)?.[0].args).toEqual(['daemon', 'stop']);
    if (phase !== 'start') expect(run.mock.calls.at(-2)?.[0].args).toEqual(['job', 'cancel', '42']);
    else expect(run.mock.calls.map(([request]) => request.args)).toEqual([['daemon', 'start'], ['daemon', 'stop']]);
  });

  it('starts no native process when already canceled', async () => {
    const { input, controller, run, services } = fixture();
    controller.abort();
    await expect(runPanelReview(services, input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(run).not.toHaveBeenCalled();
    expect(services.fs.getPluginDataDirectory).not.toHaveBeenCalled();
  });

  it('retains the primary cancellation when cleanup also fails', async () => {
    const { input, controller, run, services } = fixture();
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (request, options) => {
      if (request.args?.[1] === 'wait') {
        controller.abort();
        options?.signal?.throwIfAborted();
      }
      if (request.args?.[1] === 'stop') return completed('', 1);
      return original(request, options);
    });
    await expect(runPanelReview(services, input)).rejects.toMatchObject({
      name: 'AggregateError', errors: [expect.objectContaining({ name: 'AbortError' }), expect.objectContaining({ phase: 'stop' })],
    });
  });

  it('reports failed daemon cleanup instead of claiming finite completion', async () => {
    const { input, run, services } = fixture();
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (request, options) => request.args?.[1] === 'stop' ? completed('', 1) : original(request, options));
    await expect(runPanelReview(services, input)).rejects.toMatchObject({ code: 'panel_native_process_failed', phase: 'stop' });
  });
});
