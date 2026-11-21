import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

// test-policy-boundary: the controlling terminal is an OS device; a CLI child with
// stdin from /dev/null and no /dev/tty is the non-interactive shape under test.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: () => {
      throw Object.assign(new Error('ENXIO'), { code: 'ENXIO' });
    },
  };
});

import { createCliActionApprovalPresenter } from './approvalPrompt';

const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

afterEach(() => {
  if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  vi.restoreAllMocks();
});

describe('CLI Action approval presenter', () => {
  it.each([
    {
      review: { platformRollback: {
        environment: { id: 'env', name: 'Production' },
        revision: { kind: 'repository', sha: 'a'.repeat(40) },
        replaces: { deploymentId: 'serving', revision: { kind: 'repository', sha: 'b'.repeat(40) } },
        platformName: 'Vercel', providerResourceId: 'project', providerEnvironment: 'production', data: 'keep',
      }, providerReview: {} },
      target: /Vercel.*project.*production/s, data: 'Keep current data',
    },
    {
      review: {
        inspection: 'complete', services: [], risks: [],
        machineId: 'own-machine', environment: { id: 'env', name: 'Production' },
        revision: { kind: 'repository', sha: 'a'.repeat(40) },
        replaces: { deploymentId: 'serving', revision: { kind: 'repository', sha: 'b'.repeat(40) } },
        target: { engine: 'native', requiresAwakeComputerAndDockerDesktop: false, domains: 'notDetermined' },
        rollbackData: 'restoreBackup',
      },
      target: /own-machine/, data: 'Replace current data with the selected backup',
    },
  ])('shows Rollback versions, target and $data before asking', async ({ review, target, data }) => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as NodeJS.ReadStream);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as NodeJS.WriteStream);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let written = '';
    output.on('data', (chunk: Buffer) => { written += chunk.toString(); });
    const controller = new AbortController();
    const decide = vi.fn(async () => ({ ok: true as const, result: {} }));
    const present = createCliActionApprovalPresenter({
      actionId: 'deployments.rollback', json: false, envelopeKind: 'actions_invoke',
    });
    try {
      const prompted = new Promise<'prompt'>(resolve => {
        output.on('data', () => {
          if (written.includes('[y/N]')) resolve('prompt');
        });
      });
      const pending = present('approval_rollback', controller.signal, decide, async () => ({ deploymentReview: review }));
      const observed = await Promise.race([prompted, Promise.resolve(pending).then(() => 'settled')]);
      const displayed = stripVTControlCharacters(written);
      const decisionsBeforeAnswer = decide.mock.calls.length;
      if (observed === 'prompt') input.write('y\r');
      await expect(pending).resolves.toMatchObject({ ok: true });
      expect(displayed).toMatch(/Production.*aaaaaaa.*bbbbbbb/s);
      expect(displayed).toMatch(target);
      expect(displayed).toContain(data);
      expect(decisionsBeforeAnswer).toBe(0);
      expect(decide).toHaveBeenCalledWith('approve');
    } finally {
      controller.abort();
      input.destroy();
      output.destroy();
    }
  });

  it('cancels the originating wait on terminal Ctrl+C without deciding the durable approval', async () => {
    // Exercise the real readline/confirmation path over the stdio boundary.
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as NodeJS.ReadStream);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as NodeJS.WriteStream);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = new AbortController();
    const decide = vi.fn(async () => ({ ok: true as const, result: { done: true } }));
    const present = createCliActionApprovalPresenter({
      actionId: 'session.stop', json: false, envelopeKind: 'actions_invoke',
    });
    const answer = async (value: string) => {
      const prompted = new Promise<void>(resolve => output.once('data', () => resolve()));
      const pending = present('approval_ctrl_c', controller.signal, decide);
      await prompted;
      input.write(value);
      return await pending;
    };

    try {
      // The same terminal can answer normally before the interruption case.
      await expect(answer('y\r')).resolves.toEqual({ ok: true, result: { done: true } });
      expect(decide).toHaveBeenCalledWith('approve');
      decide.mockClear();

      await expect(answer('\u0003')).resolves.toEqual({
        ok: false, errorCode: 'cancelled', error: 'cancelled',
      });
      expect(controller.signal.aborted).toBe(false);
      expect(decide).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      input.destroy();
      output.destroy();
    }
  });

  it('leaves the approval open for another surface when no terminal can answer it', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const decide = vi.fn(async () => ({ ok: true as const, result: {} }));

    const outcome = await createCliActionApprovalPresenter({
      actionId: 'session.stop',
      json: true,
      envelopeKind: 'actions_invoke',
    })('approval_1', new AbortController().signal, decide);

    // No decision is recorded: the request stays pending and decidable elsewhere.
    expect(decide).not.toHaveBeenCalled();
    expect(outcome).toBeUndefined();
  });

  it('records an explicit approval without prompting when the caller passed --yes', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const decide = vi.fn(async () => ({
      ok: true as const,
      result: { done: true },
    }));

    await expect(
      createCliActionApprovalPresenter({
        actionId: 'session.stop',
        json: false,
        envelopeKind: 'actions_invoke',
        approve: true,
      })('approval_2', new AbortController().signal, decide),
    ).resolves.toEqual({ ok: true, result: { done: true } });
    expect(decide).toHaveBeenCalledWith('approve');
  });
});
