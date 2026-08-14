import { describe, expect, it, vi } from 'vitest';

const resolveSessionTransportContext = vi.fn();
const readExecutionRunStream = vi.fn();

vi.mock('@/session/services/resolveSessionTransportContext', () => ({ resolveSessionTransportContext }));
vi.mock('@/session/services/executionRuns', () => ({ readExecutionRunStream }));

describe('happier session run stream-read arguments', () => {
  it.each([
    ['a malformed cursor', ['session', 'run', 'sess-prefix', 'run-1', 'stream-1', '--cursor', '0oops']],
    ['a non-positive max-events value', ['session', 'run', 'sess-prefix', 'run-1', 'stream-1', '--cursor', '0', '--max-events', '0']],
  ])('rejects %s before reading credentials', async (_label, argv) => {
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionRunStreamRead } = await import('./streamRead');
    await expect(cmdSessionRunStreamRead(argv, { readCredentialsFn }))
      .rejects.toMatchObject({ code: 'invalid_arguments' });

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(resolveSessionTransportContext).not.toHaveBeenCalled();
    expect(readExecutionRunStream).not.toHaveBeenCalled();
  });
});
