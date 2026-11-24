import { describe, expect, it, vi } from 'vitest';

vi.mock('@/auth/remoteTerminalEnrollment', () => ({ runRemoteTerminalEnrollment: vi.fn() }));
vi.mock('@/cli/output/jsonEnvelope', () => ({ writeJsonStdout: vi.fn() }));
vi.mock('@/server/homeTarget', () => ({ resolveCliHomeTarget: vi.fn() }));
vi.mock('@/server/serverSelection', () => ({ applyResolvedServerSelectionNonFocusing: vi.fn() }));
vi.mock('@/server/serverProfiles', () => ({
  adoptServerProfileHomeConnectionDescriptor: vi.fn(),
  upsertServerProfileByUrl: vi.fn(),
  useServerProfile: vi.fn(),
}));

import { handleAuthEnrollRemote } from './enrollRemote';

describe('handleAuthEnrollRemote cancellation ownership', () => {
  it('does not read or prepare a Home target when the command is already cancelled', async () => {
    const caller = new AbortController();
    caller.abort();
    const readHomeTargetInput = vi.fn(async () => ({ kind: 'https_url' as const, url: 'https://home.example.test' }));
    const prepareHomeTarget = vi.fn();

    await expect(handleAuthEnrollRemote(
      ['--json-lines', '--home-target-stdin'],
      caller.signal,
      { readHomeTargetInput, prepareHomeTarget },
    )).rejects.toMatchObject({ name: 'AbortError' });

    expect(readHomeTargetInput).not.toHaveBeenCalled();
    expect(prepareHomeTarget).not.toHaveBeenCalled();
  });

  it('composes caller cancellation with process-signal cancellation at the enrollment boundary', async () => {
    const caller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const pending = handleAuthEnrollRemote(
      ['--json-lines', '--home-target-stdin'],
      caller.signal,
      {
        readHomeTargetInput: async () => ({ kind: 'https_url', url: 'https://home.example.test' }),
        prepareHomeTarget: async () => ({ profileId: 'home', target: {} as never }),
        runEnrollment: async ({ signal }) => {
          observedSignal = signal;
          return await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          });
        },
        useHomeProfile: async () => ({}) as never,
        writeOutput: async () => undefined,
      },
    );
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('does not focus the prepared Home when enrollment completes after cancellation', async () => {
    const caller = new AbortController();
    const useHomeProfile = vi.fn();

    await expect(handleAuthEnrollRemote(
      ['--json-lines', '--home-target-stdin'],
      caller.signal,
      {
        readHomeTargetInput: async () => ({ kind: 'https_url', url: 'https://home.example.test' }),
        prepareHomeTarget: async () => ({ profileId: 'home', target: {} as never }),
        runEnrollment: async () => {
          caller.abort();
          return {
            success: true,
            homeServerIdentityId: 'srv_home',
            machineId: 'machine',
            encryptionType: 'tokenOnly',
            pairingAuthentication: 'v3',
            remoteProfileId: 'home',
          };
        },
        useHomeProfile,
        writeOutput: async () => undefined,
      },
    )).rejects.toMatchObject({ name: 'AbortError' });

    expect(useHomeProfile).not.toHaveBeenCalled();
  });
});
