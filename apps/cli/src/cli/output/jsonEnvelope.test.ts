import { afterEach, describe, expect, it, vi } from 'vitest';

import { printJsonEnvelope } from './jsonEnvelope';

describe('printJsonEnvelope', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('does not settle until stdout confirms that the JSON write completed', async () => {
    let completeWrite: ((error?: Error | null) => void) | undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk, encoding, callback) => {
      completeWrite = typeof encoding === 'function' ? encoding : callback;
      return false;
    }) as typeof process.stdout.write);

    let settled = false;
    const write = printJsonEnvelope({
      ok: true,
      kind: 'large_output_probe',
      data: { payload: 'x'.repeat(128 * 1024) },
    });
    void write.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    completeWrite?.(null);
    await expect(write).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it('rejects instead of claiming success when stdout closes with EPIPE', async () => {
    const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk, encoding, callback) => {
      const completeWrite = typeof encoding === 'function' ? encoding : callback;
      queueMicrotask(() => completeWrite?.(error));
      return false;
    }) as typeof process.stdout.write);

    await expect(printJsonEnvelope({
      ok: true,
      kind: 'large_output_probe',
      data: { payload: 'x'.repeat(128 * 1024) },
    })).rejects.toMatchObject({ code: 'EPIPE' });
  });
});
