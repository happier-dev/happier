import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  apiCreateMock,
  readStoredCredentialsMock,
  sendToAllDevicesAsyncMock,
} = vi.hoisted(() => ({
  apiCreateMock: vi.fn(),
  readStoredCredentialsMock: vi.fn(async () => ({
    token: 'plain-token',
    encryption: null as null,
  })),
  sendToAllDevicesAsyncMock: vi.fn(async () => undefined),
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: () => readStoredCredentialsMock(),
}));

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: (credentials: unknown) => apiCreateMock(credentials),
  },
}));

import { handleNotifyCliCommand } from './notify';

describe('happier notify token-only authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiCreateMock.mockResolvedValue({
      push: () => ({
        sendToAllDevicesAsync: sendToAllDevicesAsyncMock,
      }),
    });
  });

  it('sends through the bearer-token API without account encryption material', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await handleNotifyCliCommand({
        args: ['notify', '-p', 'ready', '-t', 'Deploy'],
        rawArgv: ['happier', 'notify', '-p', 'ready', '-t', 'Deploy'],
        terminalRuntime: null,
      });

      expect(apiCreateMock).toHaveBeenCalledWith({
        token: 'plain-token',
        encryption: null,
      });
      expect(sendToAllDevicesAsyncMock).toHaveBeenCalledWith(
        'Deploy',
        'ready',
        expect.objectContaining({ source: 'cli' }),
      );
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
