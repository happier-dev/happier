import { describe, expect, it } from 'vitest';

import { normalizeBaseUrl, withAbortTimeout } from './httpClient';

describe('normalizeBaseUrl', () => {
  it('removes query + hash and trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.example.com/path/?token=abc#frag///')).toBe('https://api.example.com/path');
  });
});

describe('withAbortTimeout', () => {
  it('keeps a long HTTP deadline pending and preserves caller cancellation', async () => {
    const caller = new AbortController();
    let aborted = false;
    const operation = withAbortTimeout(2_147_483_648, (signal) => new Promise<string>((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; resolve('cancelled'); }, { once: true });
    }), caller.signal);
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(aborted).toBe(false);
      caller.abort();
      await expect(operation).resolves.toBe('cancelled');
    } finally {
      caller.abort();
      await operation;
    }
  });
});
