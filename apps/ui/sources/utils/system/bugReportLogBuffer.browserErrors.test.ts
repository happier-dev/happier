import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('bugReportLogBuffer (browser fatal errors)', () => {
  const originalWindow = (globalThis as any).window;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
  });

  it('captures window error events into the log buffer', async () => {
    (globalThis as any).window = {};

    const mod = await import('./bugReportLogBuffer');
    mod.installBugReportConsoleCapture({ maxEntries: 50, maxMessageChars: 4_000 });

    const err = new Error('boom');
    (globalThis as any).window.onerror?.('Uncaught Error: boom', 'app.js', 1, 2, err);

    const text = mod.getBugReportLogText(50_000);
    expect(text).toContain('Uncaught Error: boom');
    expect(text).toContain('boom');
    // Stack traces are the critical diagnostic signal.
    expect(text.toLowerCase()).toContain('stack');
  });

  it('captures unhandledrejection events into the log buffer', async () => {
    (globalThis as any).window = {};

    const mod = await import('./bugReportLogBuffer');
    mod.installBugReportConsoleCapture({ maxEntries: 50, maxMessageChars: 4_000 });

    const reason = new Error('nope');
    (globalThis as any).window.onunhandledrejection?.({ reason });

    const text = mod.getBugReportLogText(50_000);
    expect(text).toContain('Unhandled promise rejection');
    expect(text).toContain('nope');
  });
});
