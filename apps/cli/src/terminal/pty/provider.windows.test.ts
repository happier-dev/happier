import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPythonPtyRelayProvider } from './pythonRelay';

async function loadProviderWithNoNativePtyModules() {
  vi.resetModules();
  vi.doMock('node:module', () => ({
    createRequire: () => {
      return () => {
        throw new Error('native PTY unavailable');
      };
    },
  }));
  vi.doMock('@/ui/logger', () => ({
    logger: {
      debug: vi.fn(),
    },
  }));

  return import('./provider');
}

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.unmock('node:module');
  vi.unmock('@/ui/logger');
});

describe('terminal PTY Windows fallback posture', () => {
  it('does not create the Python relay provider on Windows', () => {
    expect(createPythonPtyRelayProvider({ platform: 'win32', pythonExecutable: 'python3' })).toBeNull();
  });

  it('requires an injected or native provider on Windows instead of pretending bytes are proven', async () => {
    const { createNodePtyProvider } = await loadProviderWithNoNativePtyModules();
    const provider = createNodePtyProvider({
      platform: 'win32',
      fallbackProvider: null,
      fallbackBackendName: null,
    });

    expect(() => provider.spawn({ file: 'powershell.exe', args: [], options: { encoding: null } }))
      .toThrow('terminal_pty_provider_missing');
  });
});
