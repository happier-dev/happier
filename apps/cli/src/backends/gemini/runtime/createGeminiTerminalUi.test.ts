import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createGeminiTerminalUi } from './createGeminiTerminalUi';

// Ink owns the terminal-rendering boundary; the probe records when the module is first loaded.
const inkProbe = vi.hoisted(() => ({
  loaded: false,
  render: null as null | ReturnType<typeof vi.fn>,
}));
vi.mock('ink', async (importOriginal) => {
  inkProbe.loaded = true;
  const actual = await importOriginal<typeof import('ink')>();
  inkProbe.render = vi.fn(() => ({ unmount: vi.fn() }));
  return { ...actual, render: inkProbe.render };
});

class FakeInputStream extends EventEmitter {
  public isTTY = true;
  public paused = false;

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  setRawMode(): this {
    return this;
  }

  setEncoding(): this {
    return this;
  }
}

function createUi(stdin: FakeInputStream, messageBuffer = new MessageBuffer()) {
  return createGeminiTerminalUi({
    messageBuffer,
    hasTTY: true,
    // Test fixture for the Node stdin boundary; production code only needs the ReadStream surface.
    stdin: stdin as unknown as NodeJS.ReadStream,
    onExit: vi.fn(async () => undefined),
    onDebug: vi.fn(),
    saveModelToConfig: vi.fn(),
  });
}

describe('createGeminiTerminalUi', () => {
  it('loads Ink only when mounted and keeps model updates usable before that', async () => {
    const messageBuffer = new MessageBuffer();
    const ui = createUi(new FakeInputStream(), messageBuffer);
    await vi.dynamicImportSettled();
    expect(inkProbe.loaded).toBe(false);

    ui.updateDisplayedModel('gemini-test-model');
    expect(ui.getDisplayedModel()).toBe('gemini-test-model');

    ui.mount();
    await vi.waitFor(() => expect(inkProbe.render).toHaveBeenCalledTimes(1));
    await ui.unmount();
  });

  it('contains a failed Ink render instead of rejecting unobserved', async () => {
    await import('ink');
    inkProbe.render!.mockClear();
    inkProbe.render!.mockImplementationOnce(() => {
      throw new Error('render failed');
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const ui = createUi(new FakeInputStream());
      ui.mount();
      await vi.waitFor(() => expect(inkProbe.render).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
