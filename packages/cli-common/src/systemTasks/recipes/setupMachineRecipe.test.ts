import { describe, expect, it, vi } from 'vitest';

import { SystemTaskExecutionError } from '../runSystemTask.js';
import { runSetupMachineRecipe } from './setupMachineRecipe.js';

describe('runSetupMachineRecipe', () => {
  it('configures the relay, skips auth pairing, and returns the machine id when already authenticated', async () => {
    const relayProfile = {
      serverUrl: 'https://relay.example.test',
      webappUrl: 'https://app.example.test',
      localServerUrl: null,
    };
    const emitted: Array<Readonly<{ type: string; stepId?: string }>> = [];

    const executor = {
      configureRelay: vi.fn(async () => undefined),
      readAuthStatus: vi.fn(async () => ({ authenticated: true, machineId: 'machine-1' as string | null })),
      requestAuthPairing: vi.fn(async () => ({ publicKey: 'public-key-1' })),
      waitForAuthPairing: vi.fn(async () => ({ machineId: 'machine-1' as string | null })),
      approveAuthPairing: vi.fn(async () => undefined),
      installDaemonService: vi.fn(async () => undefined),
      startDaemonService: vi.fn(async () => undefined),
      waitForReadyDaemon: vi.fn(async () => ({
        serviceInstalled: true,
        daemonRunning: true,
        needsAuth: false,
        machineId: 'machine-1' as string | null,
      })),
    } as const;

    const result = await runSetupMachineRecipe({
      relayProfile,
      initialAuthStatus: { authenticated: true, machineId: 'machine-1' },
      executor,
      steps: {
        installService: false,
        startService: false,
        verifyService: false,
      },
      stepIds: {
        configureRelay: 'setup.machine.configureRelay',
      },
      signal: new AbortController().signal,
      emit(event) {
        emitted.push(event);
      },
    });

    expect(result).toEqual({ machineId: 'machine-1', publicKey: null });
    expect(executor.configureRelay).toHaveBeenCalledTimes(1);
    expect(executor.configureRelay).toHaveBeenCalledWith(relayProfile);
    expect(executor.readAuthStatus).not.toHaveBeenCalled();
    expect(executor.requestAuthPairing).not.toHaveBeenCalled();
    expect(emitted.map((event) => event.type)).toContain('progress');
  });

  it('can skip configuring the relay when configureRelay is disabled', async () => {
    const relayProfile = {
      serverUrl: 'https://relay.example.test',
      webappUrl: 'https://app.example.test',
      localServerUrl: null,
    };
    const emitted: Array<Readonly<{ type: string; stepId?: string }>> = [];

    const executor = {
      configureRelay: vi.fn(async () => undefined),
      readAuthStatus: vi.fn(async () => ({ authenticated: true, machineId: 'machine-1' as string | null })),
      requestAuthPairing: vi.fn(async () => ({ publicKey: 'public-key-1' })),
      waitForAuthPairing: vi.fn(async () => ({ machineId: 'machine-1' as string | null })),
      installDaemonService: vi.fn(async () => undefined),
      startDaemonService: vi.fn(async () => undefined),
    } as const;

    const result = await runSetupMachineRecipe({
      relayProfile,
      initialAuthStatus: { authenticated: true, machineId: 'machine-1' },
      executor,
      steps: {
        configureRelay: false,
        installService: false,
        startService: false,
        verifyService: false,
      },
      stepIds: {
        configureRelay: 'setup.machine.configureRelay',
      },
      signal: new AbortController().signal,
      emit(event) {
        emitted.push(event);
      },
    });

    expect(result).toEqual({ machineId: 'machine-1', publicKey: null });
    expect(executor.configureRelay).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('requests pairing and waits when unauthenticated, invoking the approval hook', async () => {
    const relayProfile = {
      serverUrl: 'https://relay.example.test',
      webappUrl: 'https://app.example.test',
      localServerUrl: null,
    };
    const approvals: string[] = [];
    const prompts: unknown[] = [];

    const executor = {
      configureRelay: vi.fn(async () => undefined),
      readAuthStatus: vi.fn(async () => ({ authenticated: false, machineId: null })),
      requestAuthPairing: vi.fn(async () => ({ publicKey: 'public-key-2', supportsV2: true })),
      waitForAuthPairing: vi.fn(async () => ({ machineId: 'machine-2' as string | null })),
      installDaemonService: vi.fn(async () => undefined),
      startDaemonService: vi.fn(async () => undefined),
    } as const;

    const result = await runSetupMachineRecipe({
      relayProfile,
      executor,
      steps: {
        installService: false,
        startService: false,
        verifyService: false,
      },
      stepIds: {
        authWait: 'setup.machine.auth.wait',
      },
      signal: new AbortController().signal,
      emit() {},
      approvePairingRequest: async (params) => {
        approvals.push(params.publicKey);
        prompts.push(params.requestPayload);
      },
    });

    expect(result).toEqual({ machineId: 'machine-2', publicKey: 'public-key-2' });
    expect(approvals).toEqual(['public-key-2']);
    expect(prompts).toEqual([{ publicKey: 'public-key-2', supportsV2: true }]);
    expect(executor.readAuthStatus).toHaveBeenCalledTimes(1);
    expect(executor.requestAuthPairing).toHaveBeenCalledTimes(1);
    expect(executor.waitForAuthPairing).toHaveBeenCalledTimes(1);
  });

  it('throws daemon_service_not_ready with the provided message when readiness verification fails', async () => {
    const relayProfile = {
      serverUrl: 'https://relay.example.test',
      webappUrl: 'https://app.example.test',
      localServerUrl: null,
    };

    const executor = {
      configureRelay: vi.fn(async () => undefined),
      readAuthStatus: vi.fn(async () => ({ authenticated: true, machineId: 'machine-4' as string | null })),
      requestAuthPairing: vi.fn(async () => ({ publicKey: 'public-key-4' })),
      waitForAuthPairing: vi.fn(async () => ({ machineId: 'machine-4' as string | null })),
      approveAuthPairing: vi.fn(async () => undefined),
      installDaemonService: vi.fn(async () => undefined),
      startDaemonService: vi.fn(async () => undefined),
      waitForReadyDaemon: vi.fn(async () => ({
        serviceInstalled: true,
        daemonRunning: false,
        needsAuth: false,
        machineId: 'machine-4' as string | null,
      })),
    } as const;

    await expect(runSetupMachineRecipe({
      relayProfile,
      executor,
      steps: {
        installService: true,
        startService: true,
        verifyService: true,
      },
      stepIds: {
        verifyService: 'setup.machine.verifyService',
      },
      signal: new AbortController().signal,
      emit() {},
      daemonReadinessErrorMessage: 'Daemon service did not reach a ready state for the selected Relay.',
    })).rejects.toEqual(expect.objectContaining({
      code: 'daemon_service_not_ready',
      message: 'Daemon service did not reach a ready state for the selected Relay.',
    }));
  });

  it('can require a machine id after pairing wait', async () => {
    const relayProfile = {
      serverUrl: 'https://relay.example.test',
      webappUrl: 'https://app.example.test',
      localServerUrl: null,
    };

    const executor = {
      configureRelay: vi.fn(async () => undefined),
      readAuthStatus: vi.fn(async () => ({ authenticated: false, machineId: null })),
      requestAuthPairing: vi.fn(async () => ({ publicKey: 'public-key-5' })),
      waitForAuthPairing: vi.fn(async () => ({ machineId: null })),
      installDaemonService: vi.fn(async () => undefined),
      startDaemonService: vi.fn(async () => undefined),
    } as const;

    await expect(runSetupMachineRecipe({
      relayProfile,
      executor,
      steps: {
        installService: false,
        startService: false,
        verifyService: false,
      },
      signal: new AbortController().signal,
      emit() {},
      requireMachineIdAfterAuthWait: true,
    })).rejects.toEqual(expect.objectContaining({
      code: 'machine_id_unavailable',
    }));
  });
});
