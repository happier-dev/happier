import { describe, expect, it } from 'vitest';

import { createSystemTasksRunner, type EnrollMachineFlowExecutor } from '@happier-dev/cli-common/systemTasks';

import { createSetupThisComputerInteractiveTaskKind } from './setupThisComputerInteractiveKind.js';

/** The CLI acquisition the executor reports: managed install path, with the command it resolved. */
const MANAGED_CLI = { provenance: 'managed', command: '/home/tester/.happier/bin/happier' } as const;

async function waitForPendingPrompt(
  runner: ReturnType<typeof createSystemTasksRunner>,
  params: Readonly<{ taskId: string; cursor: number }>,
) {
  let latest = await runner.poll(params);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    latest = await runner.poll(params);
    if (latest.pendingPrompt) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected pending prompt for ${params.taskId}: ${JSON.stringify(latest)}`);
}

async function waitForResult(
  runner: ReturnType<typeof createSystemTasksRunner>,
  params: Readonly<{ taskId: string; cursor: number }>,
) {
  let latest = await runner.poll(params);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    latest = await runner.poll(params);
    if (latest.result) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected final result for ${params.taskId}: ${JSON.stringify(latest)}`);
}

function createFlowExecutor(invocations: string[]): EnrollMachineFlowExecutor {
  return {
    configureRelay: async () => {
      invocations.push('configureRelay');
    },
    // Already paired: valid credentials and a server-confirmed machine, so the flow
    // attempts no pairing. Pairing is covered by the pairing-approval tests.
    readAuthStatus: async () => ({
      authenticated: true,
      credentialState: 'valid' as const,
      machineRegistrationState: 'server-confirmed' as const,
      machineId: 'machine-1',
    }),
    requestAuthPairing: async () => ({ publicKey: 'pub-key' }),
    waitForAuthPairing: async () => ({ machineId: 'machine-1' }),
    installDaemonService: async (opts) => {
      invocations.push(opts?.replaceExisting ? 'installDaemonService:replaceExisting' : 'installDaemonService');
    },
    startDaemonService: async () => {
      invocations.push('startDaemonService');
    },
    waitForReadyDaemon: async () => ({
      serviceInstalled: true,
      daemonRunning: true,
      needsAuth: false,
      machineId: 'machine-1',
    }),
  };
}

describe('createSetupThisComputerInteractiveTaskKind', () => {
  it('ensures the local Happier tools before running the rest of setup', async () => {
    const invocations: string[] = [];
    const kind = createSetupThisComputerInteractiveTaskKind({
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      ensureLocalHappierTools: async ({ releaseChannel, onProgress }) => {
        onProgress?.({ phase: 'downloading', receivedBytes: 1024, totalBytes: 2048 });
        invocations.push(`ensureLocalHappierTools:${releaseChannel}`);
        return MANAGED_CLI;
      },
      readActiveRelayProfile: async () => ({
        serverUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        localServerUrl: null,
      }),
      createFlowExecutor: () => createFlowExecutor(invocations),
      readBackgroundServiceSetupGuidance: async () => ({
        targetReleaseChannel: 'preview',
        targetServerUrl: 'https://relay.example.test',
        currentHappierHomeDir: null,
        currentDefaultReleaseChannel: 'preview',
        managedReleaseChannels: [],
        manualRelayOwner: null,
        conflictingServices: [],
        foreignHomeConflictingServices: [],
        exactDefaultServiceExists: true,
        exactDefaultServiceRunning: false,
        shouldOfferDefaultReleaseChannelSwitch: false,
        shouldPromptForManualRelayTakeover: false,
        shouldPromptForServiceReplacement: false,
      }),
      readCurrentRelayOwner: async () => null,
      switchDefaultReleaseChannel: async () => undefined,
      readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
      upgradeCliForTokenOnlyPairing: async () => false,
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'setup.thisComputer.v1': kind,
      },
    });

    await runner.start({
      taskId: 'setup-task-tools',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: 'https://relay.example.test',
        activeWebappUrl: 'https://app.example.test',
        channel: 'preview',
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'setup-task-tools', cursor: 0 });
    expect(finalPoll.result?.ok).toBe(true);
    expect(finalPoll.events).toContainEqual(expect.objectContaining({
      type: 'cli.acquisition.progress',
      stepId: 'setup.thisComputer.ensureCli',
      data: { phase: 'downloading', receivedBytes: 1024, totalBytes: 2048 },
    }));
    // The exact service already exists (stopped): the shared disposition owner starts it and does
    // not reinstall it (R3-6).
    expect(invocations).toEqual([
      'ensureLocalHappierTools:preview',
      'configureRelay',
      'startDaemonService',
    ]);
  });

  it('exposes the managed CLI on PATH beside the service work, reports a failure on the stream, and never fails setup or the result', async () => {
    const invocations: string[] = [];
    const kind = createSetupThisComputerInteractiveTaskKind({
      ensureLocalHappierTools: async () => {
        invocations.push('ensureLocalHappierTools');
        return MANAGED_CLI;
      },
      readActiveRelayProfile: async () => ({
        serverUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        localServerUrl: null,
      }),
      createFlowExecutor: () => createFlowExecutor(invocations),
      readBackgroundServiceSetupGuidance: async () => ({
        targetReleaseChannel: 'stable',
        targetServerUrl: 'https://relay.example.test',
        currentHappierHomeDir: null,
        currentDefaultReleaseChannel: 'stable',
        managedReleaseChannels: [],
        manualRelayOwner: null,
        conflictingServices: [],
        foreignHomeConflictingServices: [],
        exactDefaultServiceExists: true,
        exactDefaultServiceRunning: false,
        shouldOfferDefaultReleaseChannelSwitch: false,
        shouldPromptForManualRelayTakeover: false,
        shouldPromptForServiceReplacement: false,
      }),
      readCurrentRelayOwner: async () => null,
      switchDefaultReleaseChannel: async () => undefined,
      readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
      upgradeCliForTokenOnlyPairing: async () => false,
      exposeHappierCliOnPath: async () => {
        invocations.push('exposeHappierCliOnPath');
        // A read-only shell profile is the real failure mode this must survive.
        throw new Error('Could not update shell profile /home/example/.zshrc: EACCES');
      },
    });

    const runner = createSystemTasksRunner({ kinds: { 'setup.thisComputer.v1': kind } });
    await runner.start({
      taskId: 'setup-task-path',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: 'https://relay.example.test',
        activeWebappUrl: 'https://app.example.test',
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'setup-task-path', cursor: 0 });

    // This computer is ready even though terminal exposure failed, and the outcome is not part of
    // the result: nothing reads it, and awaiting a shell-profile write would gate the reveal on it.
    expect(finalPoll.result).toMatchObject({ ok: true, data: { machineId: 'machine-1' } });
    expect((finalPoll.result as { data?: Record<string, unknown> }).data).not.toHaveProperty('pathExposure');
    // The failure is still said out loud on the run's own event stream.
    expect(finalPoll.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'progress',
        message: expect.stringContaining('Could not add happier to your PATH'),
      }),
    ]));
    // It runs alongside the remaining service work, not after it.
    expect(invocations.indexOf('exposeHappierCliOnPath')).toBeGreaterThan(-1);
    expect(invocations.indexOf('exposeHappierCliOnPath')).toBeLessThan(invocations.indexOf('startDaemonService'));
  });

  it('does not write the shell profile when a consent prompt is declined', async () => {
    const invocations: string[] = [];
    const kind = createSetupThisComputerInteractiveTaskKind({
      ensureLocalHappierTools: async () => MANAGED_CLI,
      exposeHappierCliOnPath: async () => {
        invocations.push('exposeHappierCliOnPath');
        return { changed: true, shellReloadHint: null, failure: null, existingCommand: null };
      },
      readActiveRelayProfile: async () => ({
        serverUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        localServerUrl: null,
      }),
      createFlowExecutor: () => createFlowExecutor(invocations),
      readBackgroundServiceSetupGuidance: async () => ({
        targetReleaseChannel: 'stable',
        targetServerUrl: 'https://relay.example.test',
        currentHappierHomeDir: null,
        currentDefaultReleaseChannel: 'stable',
        managedReleaseChannels: [],
        manualRelayOwner: null,
        conflictingServices: [
          {
            label: 'com.happier.cli.daemon.default',
            releaseChannel: 'stable',
            targetMode: 'pinned',
            running: true,
            serverUrl: 'https://relay.example.test',
            happierHomeDir: null,
          },
        ],
        foreignHomeConflictingServices: [],
        exactDefaultServiceExists: false,
        exactDefaultServiceRunning: false,
        shouldOfferDefaultReleaseChannelSwitch: false,
        shouldPromptForManualRelayTakeover: false,
        shouldPromptForServiceReplacement: true,
      }),
      readCurrentRelayOwner: async () => null,
      switchDefaultReleaseChannel: async () => undefined,
      readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
      upgradeCliForTokenOnlyPairing: async () => false,
    });

    const runner = createSystemTasksRunner({ kinds: { 'setup.thisComputer.v1': kind } });
    await runner.start({
      taskId: 'setup-task-path-consent',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: 'https://relay.example.test',
        activeWebappUrl: 'https://app.example.test',
      },
    });

    const promptPoll = await waitForPendingPrompt(runner, { taskId: 'setup-task-path-consent', cursor: 0 });
    // Nothing outside Happier's own directories may have been touched at the moment the question
    // is asked (D4/R12) — the shell profile is the one such write this task makes.
    expect(invocations).not.toContain('exposeHappierCliOnPath');

    await runner.respond({ taskId: 'setup-task-path-consent', answer: { replaceExistingServices: false } });
    const finalPoll = await waitForResult(runner, { taskId: 'setup-task-path-consent', cursor: promptPoll.nextCursor });

    expect(finalPoll.result).toMatchObject({ ok: false, error: { code: 'background_service_conflict_declined' } });
    // …and the declined run leaves the user's shell startup files exactly as they were.
    expect(invocations).not.toContain('exposeHappierCliOnPath');
  });

  it('emits command-level diagnostics on the shared step ids used by the checklist', async () => {
    const invocations: string[] = [];
    const kind = createSetupThisComputerInteractiveTaskKind({
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      ensureLocalHappierTools: async () => {
        invocations.push('ensureLocalHappierTools');
        return MANAGED_CLI;
      },
      readActiveRelayProfile: async () => ({
        serverUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        localServerUrl: null,
      }),
      createFlowExecutor: () => createFlowExecutor(invocations),
      readBackgroundServiceSetupGuidance: async () => ({
        targetReleaseChannel: 'stable',
        targetServerUrl: 'https://relay.example.test',
        currentHappierHomeDir: null,
        currentDefaultReleaseChannel: 'stable',
        managedReleaseChannels: [],
        manualRelayOwner: null,
        conflictingServices: [],
        foreignHomeConflictingServices: [],
        exactDefaultServiceExists: false,
        exactDefaultServiceRunning: false,
        shouldOfferDefaultReleaseChannelSwitch: false,
        shouldPromptForManualRelayTakeover: false,
        shouldPromptForServiceReplacement: false,
      }),
      readCurrentRelayOwner: async () => null,
      switchDefaultReleaseChannel: async () => undefined,
      readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
      upgradeCliForTokenOnlyPairing: async () => false,
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'setup.thisComputer.v1': kind,
      },
    });

    await runner.start({
      taskId: 'setup-task-diagnostics',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: 'https://relay.example.test',
        activeWebappUrl: 'https://app.example.test',
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'setup-task-diagnostics', cursor: 0 });
    expect(finalPoll.result?.ok).toBe(true);
    expect(finalPoll.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepId: 'setup.thisComputer.configureRelay',
        type: 'progress',
        message: 'Running happier server set --json',
        data: expect.objectContaining({
          command: 'happier',
          args: ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
        }),
      }),
      expect.objectContaining({
        stepId: 'setup.thisComputer.installService',
        type: 'progress',
        message: 'Running happier service install --json',
        data: expect.objectContaining({
          command: 'happier',
          args: ['service', 'install', '--json'],
        }),
      }),
      expect.objectContaining({
        stepId: 'setup.thisComputer.verifyService',
        type: 'progress',
        message: 'Polling happier daemon status --json',
        data: expect.objectContaining({
          command: 'happier',
          args: ['daemon', 'status', '--json'],
        }),
      }),
    ]));
  });

  it('prompts to switch the default release channel and replace conflicting local background services before setup completes', async () => {
    const invocations: string[] = [];
    const kind = createSetupThisComputerInteractiveTaskKind({
        ensureLocalHappierTools: async () => MANAGED_CLI,
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      readActiveRelayProfile: async () => ({
        serverUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        localServerUrl: null,
      }),
      createFlowExecutor: () => createFlowExecutor(invocations),
      readBackgroundServiceSetupGuidance: async () => ({
        targetReleaseChannel: 'preview',
        targetServerUrl: 'https://relay.example.test',
        currentHappierHomeDir: null,
        currentDefaultReleaseChannel: 'stable',
        managedReleaseChannels: [
          {
            releaseChannel: 'stable',
            label: 'stable',
            version: '1.0.0',
            installationId: 'stable',
            installationPath: '/managed/stable',
            invokerName: 'happier',
            isDefault: true,
            onPath: true,
          },
          {
            releaseChannel: 'preview',
            label: 'preview',
            version: '2.0.0',
            installationId: 'preview',
            installationPath: '/managed/preview',
            invokerName: 'hprev',
            isDefault: false,
            onPath: true,
          },
        ],
        manualRelayOwner: null,
        conflictingServices: [
          {
            label: 'com.happier.cli.daemon.stable.default',
            releaseChannel: 'stable',
            targetMode: 'pinned',
            running: true,
            serverUrl: 'https://relay.example.test',
            happierHomeDir: null,
          },
        ],
        foreignHomeConflictingServices: [],
        exactDefaultServiceExists: true,
        exactDefaultServiceRunning: false,
        shouldOfferDefaultReleaseChannelSwitch: true,
        shouldPromptForManualRelayTakeover: false,
        shouldPromptForServiceReplacement: true,
      }),
      readCurrentRelayOwner: async () => null,
      switchDefaultReleaseChannel: async (releaseChannel) => {
        invocations.push(`switchDefaultReleaseChannel:${releaseChannel}`);
      },
      readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
      upgradeCliForTokenOnlyPairing: async () => false,
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'setup.thisComputer.v1': kind,
      },
    });

    await runner.start({
      taskId: 'setup-task',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: 'https://relay.example.test',
        activeWebappUrl: 'https://app.example.test',
        channel: 'preview',
      },
    });

    const releaseChannelPrompt = await waitForPendingPrompt(runner, { taskId: 'setup-task', cursor: 0 });
    expect(releaseChannelPrompt.pendingPrompt).toEqual({
      kind: 'releaseChannel.switchDefaultForSetup',
      data: {
        targetReleaseChannel: 'preview',
        currentDefaultReleaseChannel: 'stable',
        targetServerUrl: 'https://relay.example.test',
        managedReleaseChannels: [
          {
            releaseChannel: 'stable',
            label: 'stable',
            version: '1.0.0',
            installationId: 'stable',
            installationPath: '/managed/stable',
            invokerName: 'happier',
            isDefault: true,
            onPath: true,
          },
          {
            releaseChannel: 'preview',
            label: 'preview',
            version: '2.0.0',
            installationId: 'preview',
            installationPath: '/managed/preview',
            invokerName: 'hprev',
            isDefault: false,
            onPath: true,
          },
        ],
      },
    });

    await runner.respond({
      taskId: 'setup-task',
      answer: { switchDefaultReleaseChannel: true },
    });

    const replacePrompt = await waitForPendingPrompt(runner, { taskId: 'setup-task', cursor: releaseChannelPrompt.nextCursor });
    expect(replacePrompt.pendingPrompt).toEqual({
      kind: 'daemon.replaceLocalBackgroundServices',
      data: {
        targetServerUrl: 'https://relay.example.test',
        targetReleaseChannel: 'preview',
        services: [
          {
            label: 'com.happier.cli.daemon.stable.default',
            releaseChannel: 'stable',
            targetMode: 'pinned',
            running: true,
            serverUrl: 'https://relay.example.test',
            happierHomeDir: null,
          },
        ],
      },
    });

    await runner.respond({
      taskId: 'setup-task',
      answer: { replaceExistingServices: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'setup-task', cursor: replacePrompt.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'setup-task',
      ok: true,
      data: { machineId: 'machine-1' },
    });
    expect(invocations).toEqual([
      'switchDefaultReleaseChannel:preview',
      'configureRelay',
      'installDaemonService:replaceExisting',
      'startDaemonService',
    ]);
  });

  it('prefers the explicit relay profile from setup params over the managed CLI current relay', async () => {
    const configureRelayProfiles: Array<{
      serverUrl: string;
      webappUrl: string;
      localServerUrl: string | null;
    }> = [];
    const kind = createSetupThisComputerInteractiveTaskKind({
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      ensureLocalHappierTools: async () => MANAGED_CLI,
      readActiveRelayProfile: async () => ({
        serverUrl: 'https://relay-from-cli.example.test',
        webappUrl: 'https://app-from-cli.example.test',
        localServerUrl: 'http://127.0.0.1:60000',
      }),
      createFlowExecutor: () => ({
        configureRelay: async (profile) => {
          configureRelayProfiles.push(profile);
        },
        // Already paired: valid credentials and a server-confirmed machine, so the flow
        // attempts no pairing. Pairing is covered by the pairing-approval tests.
        readAuthStatus: async () => ({
          authenticated: true,
          credentialState: 'valid' as const,
          machineRegistrationState: 'server-confirmed' as const,
          machineId: 'machine-1',
        }),
        requestAuthPairing: async () => ({ publicKey: 'pub-key' }),
        waitForAuthPairing: async () => ({ machineId: 'machine-1' }),
        installDaemonService: async () => undefined,
        startDaemonService: async () => undefined,
        waitForReadyDaemon: async () => ({
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-1',
        }),
      }),
      readBackgroundServiceSetupGuidance: async () => ({
        targetReleaseChannel: 'stable',
        targetServerUrl: 'https://relay-from-ui.example.test',
        currentHappierHomeDir: null,
        currentDefaultReleaseChannel: 'stable',
        managedReleaseChannels: [],
        manualRelayOwner: null,
        conflictingServices: [],
        foreignHomeConflictingServices: [],
        exactDefaultServiceExists: false,
        exactDefaultServiceRunning: false,
        shouldOfferDefaultReleaseChannelSwitch: false,
        shouldPromptForManualRelayTakeover: false,
        shouldPromptForServiceReplacement: false,
      }),
      readCurrentRelayOwner: async () => null,
      switchDefaultReleaseChannel: async () => undefined,
      readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
      upgradeCliForTokenOnlyPairing: async () => false,
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'setup.thisComputer.v1': kind,
      },
    });

    await runner.start({
      taskId: 'setup-task-explicit-relay',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: 'https://relay-from-ui.example.test',
        activeWebappUrl: 'https://app-from-ui.example.test',
        activeLocalRelayUrl: 'http://127.0.0.1:53288',
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'setup-task-explicit-relay', cursor: 0 });
    expect(finalPoll.result?.ok).toBe(true);
    expect(configureRelayProfiles).toEqual([
      {
        serverUrl: 'https://relay-from-ui.example.test',
        webappUrl: 'https://app-from-ui.example.test',
        localServerUrl: 'http://127.0.0.1:53288',
      },
    ]);
  });

  it('prompts to replace a conflicting default-following service from another Happier installation before setup continues', async () => {
    const invocations: string[] = [];
    const kind = createSetupThisComputerInteractiveTaskKind({
        ensureLocalHappierTools: async () => MANAGED_CLI,
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      readActiveRelayProfile: async () => ({
        serverUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        localServerUrl: null,
      }),
      createFlowExecutor: () => createFlowExecutor(invocations),
      readBackgroundServiceSetupGuidance: async () => ({
        targetReleaseChannel: 'stable',
        targetServerUrl: 'https://relay.example.test',
        currentHappierHomeDir: null,
        currentDefaultReleaseChannel: 'stable',
        managedReleaseChannels: [],
        manualRelayOwner: {
          currentReleaseChannel: 'stable',
          currentCliVersion: '0.2.0',
        },
        exactDefaultServiceExists: false,
        exactDefaultServiceRunning: false,
        conflictingServices: [],
        foreignHomeConflictingServices: [
          {
            label: 'com.happier.cli.daemon.default',
            releaseChannel: 'stable',
            targetMode: 'default-following',
            running: true,
            serverUrl: null,
            happierHomeDir: '/Users/other/.happier',
          },
        ],
        shouldOfferDefaultReleaseChannelSwitch: false,
        shouldPromptForManualRelayTakeover: false,
        shouldPromptForServiceReplacement: true,
      }),
      readCurrentRelayOwner: async () => null,
      switchDefaultReleaseChannel: async () => undefined,
      readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
      upgradeCliForTokenOnlyPairing: async () => false,
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'setup.thisComputer.v1': kind,
      },
    });

    await runner.start({
      taskId: 'setup-task-foreign-home',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: 'https://relay.example.test',
        activeWebappUrl: 'https://app.example.test',
      },
    });

    const replacePrompt = await waitForPendingPrompt(runner, { taskId: 'setup-task-foreign-home', cursor: 0 });
    expect(replacePrompt.pendingPrompt).toEqual({
      kind: 'daemon.replaceLocalBackgroundServices',
      data: {
        targetServerUrl: 'https://relay.example.test',
        targetReleaseChannel: 'stable',
        services: [
          {
            label: 'com.happier.cli.daemon.default',
            releaseChannel: 'stable',
            targetMode: 'default-following',
            running: true,
            serverUrl: null,
            happierHomeDir: '/Users/other/.happier',
          },
        ],
      },
    });

    await runner.respond({
      taskId: 'setup-task-foreign-home',
      answer: { replaceExistingServices: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'setup-task-foreign-home', cursor: replacePrompt.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'setup-task-foreign-home',
      ok: true,
      data: { machineId: 'machine-1' },
    });
    expect(invocations).toEqual([
      'configureRelay',
      'installDaemonService:replaceExisting',
      'startDaemonService',
    ]);
  });

  it('prompts to take over a manual relay runtime before installing the background service', async () => {
    const invocations: string[] = [];
    const kind = createSetupThisComputerInteractiveTaskKind({
        ensureLocalHappierTools: async () => MANAGED_CLI,
        switchDefaultReleaseChannel: async () => undefined,
        readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
        upgradeCliForTokenOnlyPairing: async () => false,
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      readActiveRelayProfile: async () => ({
        serverUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        localServerUrl: null,
      }),
      createFlowExecutor: () => createFlowExecutor(invocations),
      readBackgroundServiceSetupGuidance: async () => ({
        targetReleaseChannel: 'stable',
        targetServerUrl: 'https://relay.example.test',
        currentHappierHomeDir: null,
        currentDefaultReleaseChannel: 'stable',
        managedReleaseChannels: [],
        manualRelayOwner: {
          currentReleaseChannel: 'stable',
          currentCliVersion: '0.2.0',
        },
        conflictingServices: [],
        foreignHomeConflictingServices: [],
        exactDefaultServiceExists: false,
        exactDefaultServiceRunning: false,
        shouldOfferDefaultReleaseChannelSwitch: false,
        shouldPromptForManualRelayTakeover: true,
        shouldPromptForServiceReplacement: false,
      }),
      readCurrentRelayOwner: async () => null,
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'setup.thisComputer.v1': kind,
      },
    });

    await runner.start({
      taskId: 'setup-task-manual-owner',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: 'https://relay.example.test',
        activeWebappUrl: 'https://app.example.test',
      },
    });

    const manualOwnerPrompt = await waitForPendingPrompt(runner, { taskId: 'setup-task-manual-owner', cursor: 0 });
    expect(manualOwnerPrompt.pendingPrompt).toEqual({
      kind: 'daemon.takeOverManualRelayRuntimeForSetup',
      data: {
        targetServerUrl: 'https://relay.example.test',
        targetReleaseChannel: 'stable',
        currentReleaseChannel: 'stable',
        currentCliVersion: '0.2.0',
      },
    });

    await runner.respond({
      taskId: 'setup-task-manual-owner',
      answer: { takeOverManualRelayRuntime: true },
    });

    const finalPoll = await waitForResult(runner, {
      taskId: 'setup-task-manual-owner',
      cursor: manualOwnerPrompt.nextCursor,
    });

    expect(finalPoll.result?.ok).toBe(true);
    expect(finalPoll.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepId: 'setup.thisComputer.installService',
        type: 'progress',
        message: 'Running happier service install --takeover --json',
        data: expect.objectContaining({
          command: 'happier',
          args: ['service', 'install', '--takeover', '--json'],
        }),
      }),
      expect.objectContaining({
        stepId: 'setup.thisComputer.startService',
        type: 'progress',
        message: 'Running happier service start --takeover --json',
        data: expect.objectContaining({
          command: 'happier',
          args: ['service', 'start', '--takeover', '--json'],
        }),
      }),
    ]));
    expect(invocations).toContain('installDaemonService');
  });

  it('fails when the user keeps conflicting local background services', async () => {
    const kind = createSetupThisComputerInteractiveTaskKind({
        ensureLocalHappierTools: async () => MANAGED_CLI,
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      readActiveRelayProfile: async () => ({
        serverUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        localServerUrl: null,
      }),
      createFlowExecutor: () => createFlowExecutor([]),
      readBackgroundServiceSetupGuidance: async () => ({
        targetReleaseChannel: 'preview',
        targetServerUrl: 'https://relay.example.test',
        currentHappierHomeDir: null,
        currentDefaultReleaseChannel: 'preview',
        managedReleaseChannels: [],
        manualRelayOwner: null,
        conflictingServices: [
          {
            label: 'com.happier.cli.daemon.preview.default',
            releaseChannel: 'preview',
            targetMode: 'pinned',
            running: true,
            serverUrl: 'https://relay.example.test',
            happierHomeDir: null,
          },
        ],
        foreignHomeConflictingServices: [],
        exactDefaultServiceExists: false,
        exactDefaultServiceRunning: false,
        shouldOfferDefaultReleaseChannelSwitch: false,
        shouldPromptForManualRelayTakeover: false,
        shouldPromptForServiceReplacement: true,
      }),
      readCurrentRelayOwner: async () => null,
      switchDefaultReleaseChannel: async () => undefined,
      readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
      upgradeCliForTokenOnlyPairing: async () => false,
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'setup.thisComputer.v1': kind,
      },
    });

    await runner.start({
      taskId: 'setup-task-decline',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: 'https://relay.example.test',
        activeWebappUrl: 'https://app.example.test',
        channel: 'preview',
      },
    });

    const promptPoll = await waitForPendingPrompt(runner, { taskId: 'setup-task-decline', cursor: 0 });
    await runner.respond({
      taskId: 'setup-task-decline',
      answer: { replaceExistingServices: false },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'setup-task-decline', cursor: promptPoll.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'setup-task-decline',
      ok: false,
      error: {
        code: 'background_service_conflict_declined',
        message: 'Setup was cancelled because existing background services were kept.',
      },
    });
  });

  it('does not switch the default release channel when setup is later cancelled by keeping conflicting services', async () => {
    const invocations: string[] = [];
    const kind = createSetupThisComputerInteractiveTaskKind({
        ensureLocalHappierTools: async () => MANAGED_CLI,
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      readActiveRelayProfile: async () => ({
        serverUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        localServerUrl: null,
      }),
      createFlowExecutor: () => createFlowExecutor(invocations),
      readBackgroundServiceSetupGuidance: async () => ({
        targetReleaseChannel: 'preview',
        targetServerUrl: 'https://relay.example.test',
        currentHappierHomeDir: null,
        currentDefaultReleaseChannel: 'stable',
        managedReleaseChannels: [
          {
            releaseChannel: 'stable',
            label: 'stable',
            version: '1.0.0',
            installationId: 'stable',
            installationPath: '/managed/stable',
            invokerName: 'happier',
            isDefault: true,
            onPath: true,
          },
          {
            releaseChannel: 'preview',
            label: 'preview',
            version: '2.0.0',
            installationId: 'preview',
            installationPath: '/managed/preview',
            invokerName: 'hprev',
            isDefault: false,
            onPath: true,
          },
        ],
        manualRelayOwner: null,
        conflictingServices: [
          {
            label: 'com.happier.cli.daemon.stable.default',
            releaseChannel: 'stable',
            targetMode: 'pinned',
            running: true,
            serverUrl: 'https://relay.example.test',
            happierHomeDir: null,
          },
        ],
        foreignHomeConflictingServices: [],
        exactDefaultServiceExists: true,
        exactDefaultServiceRunning: false,
        shouldOfferDefaultReleaseChannelSwitch: true,
        shouldPromptForManualRelayTakeover: false,
        shouldPromptForServiceReplacement: true,
      }),
      readCurrentRelayOwner: async () => null,
      switchDefaultReleaseChannel: async (releaseChannel) => {
        invocations.push(`switchDefaultReleaseChannel:${releaseChannel}`);
      },
      readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
      upgradeCliForTokenOnlyPairing: async () => false,
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'setup.thisComputer.v1': kind,
      },
    });

    await runner.start({
      taskId: 'setup-task-decline-after-switch',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: 'https://relay.example.test',
        activeWebappUrl: 'https://app.example.test',
        channel: 'preview',
      },
    });

    const releaseChannelPrompt = await waitForPendingPrompt(runner, { taskId: 'setup-task-decline-after-switch', cursor: 0 });
    await runner.respond({
      taskId: 'setup-task-decline-after-switch',
      answer: { switchDefaultReleaseChannel: true },
    });

    const replacePrompt = await waitForPendingPrompt(runner, { taskId: 'setup-task-decline-after-switch', cursor: releaseChannelPrompt.nextCursor });
    await runner.respond({
      taskId: 'setup-task-decline-after-switch',
      answer: { replaceExistingServices: false },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'setup-task-decline-after-switch', cursor: replacePrompt.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'setup-task-decline-after-switch',
      ok: false,
      error: {
        code: 'background_service_conflict_declined',
        message: 'Setup was cancelled because existing background services were kept.',
      },
    });
    expect(invocations).toEqual([]);
  });

  it('keeps the current default release channel and completes setup when the optional switch is declined', async () => {
    const kind = createSetupThisComputerInteractiveTaskKind({
        ensureLocalHappierTools: async () => MANAGED_CLI,
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      readActiveRelayProfile: async () => ({
        serverUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        localServerUrl: null,
      }),
      createFlowExecutor: () => createFlowExecutor([]),
      readBackgroundServiceSetupGuidance: async () => ({
        targetReleaseChannel: 'preview',
        targetServerUrl: 'https://relay.example.test',
        currentHappierHomeDir: null,
        currentDefaultReleaseChannel: 'stable',
        managedReleaseChannels: [
          {
            releaseChannel: 'stable',
            label: 'stable',
            version: '1.0.0',
            installationId: 'stable',
            installationPath: '/managed/stable',
            invokerName: 'happier',
            isDefault: true,
            onPath: true,
          },
        ],
        manualRelayOwner: null,
        conflictingServices: [],
        foreignHomeConflictingServices: [],
        exactDefaultServiceExists: false,
        exactDefaultServiceRunning: false,
        shouldOfferDefaultReleaseChannelSwitch: true,
        shouldPromptForManualRelayTakeover: false,
        shouldPromptForServiceReplacement: false,
      }),
      readCurrentRelayOwner: async () => null,
      switchDefaultReleaseChannel: async () => undefined,
      readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
      upgradeCliForTokenOnlyPairing: async () => false,
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'setup.thisComputer.v1': kind,
      },
    });

    await runner.start({
      taskId: 'setup-task-release-channel-decline',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: 'https://relay.example.test',
        activeWebappUrl: 'https://app.example.test',
        channel: 'preview',
      },
    });

    const promptPoll = await waitForPendingPrompt(runner, { taskId: 'setup-task-release-channel-decline', cursor: 0 });
    await runner.respond({
      taskId: 'setup-task-release-channel-decline',
      answer: { switchDefaultReleaseChannel: false },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'setup-task-release-channel-decline', cursor: promptPoll.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'setup-task-release-channel-decline',
      ok: true,
      data: { machineId: 'machine-1' },
    });
  });
});
