import { beforeEach, describe, expect, it, vi } from 'vitest';

const { failSpy } = vi.hoisted(() => ({
  failSpy: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    isAxiosError: (error: unknown) => Boolean((error as { isAxios?: boolean }).isAxios),
  },
}));

vi.mock('@/api/offline/serverConnectionErrors', () => ({
  connectionState: {
    fail: (...args: unknown[]) => failSpy(...args),
  },
  isNetworkError: (code: string) => code === 'ECONNRESET',
}));

import { shouldTreatGetOrCreateMachineErrorAsOffline, shouldTreatGetOrCreateSessionErrorAsOffline } from './offlineErrors';

describe('offlineErrors', () => {
  beforeEach(() => {
    failSpy.mockClear();
  });

  it('treats network and 404 session-creation failures as offline', () => {
    expect(shouldTreatGetOrCreateSessionErrorAsOffline({ isAxios: true, code: 'ECONNRESET' }, { url: 'http://api.example' })).toBe(true);
    expect(failSpy).toHaveBeenCalledWith({
      operation: 'Session creation',
      caller: 'api.getOrCreateSession',
      errorCode: 'ECONNRESET',
      url: 'http://api.example',
      details: undefined,
    });

    failSpy.mockClear();
    expect(shouldTreatGetOrCreateSessionErrorAsOffline({ isAxios: true, response: { status: 404 } }, { url: 'http://api.example' })).toBe(true);
  });

  it('ignores 409 machine conflicts but treats 5xx as offline', () => {
    expect(shouldTreatGetOrCreateMachineErrorAsOffline({ isAxios: true, response: { status: 409 } }, { url: 'http://api.example' })).toBe(false);
    expect(shouldTreatGetOrCreateMachineErrorAsOffline({ isAxios: true, response: { status: 503 } }, { url: 'http://api.example' })).toBe(true);
  });
});
