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
