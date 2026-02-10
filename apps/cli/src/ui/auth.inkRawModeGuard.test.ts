import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setStdioTtyForTest } from '@/ui/testkit/authNonInteractiveGlobals.testkit';

const renderMock = vi.fn((element: any) => {
  // If Ink render is invoked, immediately select a method so doAuth doesn't hang on the selector.
  const onSelect = element?.props?.onSelect as unknown;
  if (typeof onSelect === 'function') {
    setTimeout(() => onSelect('web'), 0);
  }
  return { unmount: vi.fn() };
});

vi.mock('ink', () => {
  return { render: renderMock };
});

const axiosPostMock = vi.fn(async () => {
  throw new Error('stop-before-network');
});

vi.mock('axios', () => {
  return {
    default: { post: axiosPostMock },
  };
});

function setRawModeSupportForTest(supported: boolean): () => void {
  const desc = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  Object.defineProperty(process.stdin, 'setRawMode', {
    value: supported ? (() => {}) : undefined,
    configurable: true,
    writable: true,
  });

  return () => {
    if (desc) Object.defineProperty(process.stdin, 'setRawMode', desc);
    else delete (process.stdin as { setRawMode?: unknown }).setRawMode;
  };
}

describe('doAuth (Ink raw mode guard)', () => {
  const envKeys = ['HAPPIER_AUTH_METHOD'] as const;
  let restoreTty: (() => void) | null = null;
  let restoreRawMode: (() => void) | null = null;

  beforeEach(() => {
    vi.useRealTimers();
    for (const key of envKeys) delete process.env[key];
    renderMock.mockClear();
    axiosPostMock.mockClear();
    restoreTty = setStdioTtyForTest({ stdin: true, stdout: true });
    // Simulate a stdin that isTTY but cannot enter raw mode (Ink would crash).
    restoreRawMode = setRawModeSupportForTest(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'clear').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreRawMode?.();
    restoreRawMode = null;
    restoreTty?.();
    restoreTty = null;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('does not render Ink auth selector when stdin raw mode is unsupported', async () => {
    vi.resetModules();
    const { doAuth } = await import('./auth');

    const result = await doAuth();

    expect(result).toBeNull();
    expect(renderMock).not.toHaveBeenCalled();
  });
});
