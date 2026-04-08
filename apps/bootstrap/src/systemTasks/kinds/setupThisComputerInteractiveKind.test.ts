import { describe, expect, it } from 'vitest';

import { createSystemTasksRunner, type SetupMachineRecipeExecutor } from '@happier-dev/cli-common/systemTasks';

import { createSetupThisComputerInteractiveTaskKind } from './setupThisComputerInteractiveKind.js';

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

function createRecipeExecutor(invocations: string[]): SetupMachineRecipeExecutor {
  return {
    configureRelay: async () => {
      invocations.push('configureRelay');
    },
    readAuthStatus: async () => ({
      authenticated: true,
      machineId: 'machine-1',
    }),
    requestAuthPairing: async () => ({ publicKey: 'pub-key' }),
    waitForAuthPairing: async () => ({ machineId: 'machine-1' }),
    installDaemonService: async () => {
      invocations.push('installDaemonService');
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
  it('prompts to switch the default release channel and replace conflicting local background services before setup completes', async () => {
    const invocations: string[] = [];
    const kind = createSetupThisComputerInteractiveTaskKind({
      readActiveRelayProfile: async () => ({
        serverUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        localServerUrl: null,
      }),
      createRecipeExecutor: () => createRecipeExecutor(invocations),
      readBackgroundServiceSetupGuidance: async () => ({
        targetReleaseChannel: 'preview',
        targetServerUrl: 'https://relay.example.test',
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
        conflictingServices: [
          {
            label: 'com.happier.cli.daemon.stable.default',
            releaseChannel: 'stable',
            targetMode: 'pinned',
            running: true,
            serverUrl: 'https://relay.example.test',
          },
        ],
        exactDefaultServiceExists: true,
        shouldOfferDefaultReleaseChannelSwitch: true,
        shouldPromptForServiceReplacement: true,
      }),
      switchDefaultReleaseChannel: async (releaseChannel) => {
        invocations.push(`switchDefaultReleaseChannel:${releaseChannel}`);
      },
      uninstallExistingDaemonServices: async () => {
        invocations.push('uninstallExistingDaemonServices');
      },
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
      'uninstallExistingDaemonServices',
      'configureRelay',
      'installDaemonService',
      'startDaemonService',
    ]);
  });

  it('fails when the user keeps conflicting local background services', async () => {
    const kind = createSetupThisComputerInteractiveTaskKind({
      readActiveRelayProfile: async () => ({
        serverUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        localServerUrl: null,
      }),
      createRecipeExecutor: () => createRecipeExecutor([]),
      readBackgroundServiceSetupGuidance: async () => ({
        targetReleaseChannel: 'preview',
        targetServerUrl: 'https://relay.example.test',
        currentDefaultReleaseChannel: 'preview',
        managedReleaseChannels: [],
        conflictingServices: [
          {
            label: 'com.happier.cli.daemon.preview.default',
            releaseChannel: 'preview',
            targetMode: 'pinned',
            running: true,
            serverUrl: 'https://relay.example.test',
          },
        ],
        exactDefaultServiceExists: false,
        shouldOfferDefaultReleaseChannelSwitch: false,
        shouldPromptForServiceReplacement: true,
      }),
      switchDefaultReleaseChannel: async () => undefined,
      uninstallExistingDaemonServices: async () => undefined,
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
});
