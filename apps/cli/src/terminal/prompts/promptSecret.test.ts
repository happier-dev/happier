import { afterEach, describe, expect, it, vi } from 'vitest';

type MockReadline = {
  question: (promptLabel: string, callback: (answer: string) => void) => MockReadline;
  once: (eventName: string, listener: (...args: unknown[]) => void) => MockReadline;
  close: () => MockReadline;
  stdoutMuted?: boolean;
  _writeToOutput?: (value: string) => void;
  output?: { write: (value: string) => boolean };
};

const writes: string[] = [];

const createInterfaceMock = vi.fn((): MockReadline => ({
  question(promptLabel, callback) {
    this._writeToOutput?.(promptLabel);
    this._writeToOutput?.('typed-secret');
    callback('entered-secret');
    return this;
  },
  once() {
    return this;
  },
  close() {
    return this;
  },
  _writeToOutput(value: string) {
    writes.push(value);
  },
  output: {
    write(value: string) {
      writes.push(value);
      return true;
    },
  },
}));

vi.mock('node:readline', () => ({
  createInterface: createInterfaceMock as unknown as typeof import('node:readline').createInterface,
}));

vi.mock('./promptInput', () => ({
  isInteractiveTerminal: () => true,
}));

afterEach(() => {
  writes.length = 0;
  createInterfaceMock.mockClear();
  vi.resetModules();
});

describe('promptSecret', () => {
  it('shows the prompt label while suppressing typed secret characters', async () => {
    const { promptSecret } = await import('./promptSecret');

    await expect(promptSecret('OPENAI_API_KEY: ')).resolves.toBe('entered-secret');

    expect(writes).toEqual(['OPENAI_API_KEY: ', '\n']);
  });
});
