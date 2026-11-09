import { describe, expect, it } from 'vitest';

import type { HappierCliChoice } from '@happier-dev/cli-common/firstPartyRuntime';
import { createSystemTasksRunner, type EnrollMachineFlowExecutor } from '@happier-dev/cli-common/systemTasks';
import type { SetupCliChoicePromptData } from '@happier-dev/protocol';

import {
  createSetupThisComputerInteractiveTaskKind,
  type SetupCliChoiceDeps,
} from './setupThisComputerInteractiveKind.js';

const NPM_CLI = '/home/tester/npm-global/bin/happier';

function question(overrides: Partial<SetupCliChoicePromptData> = {}): SetupCliChoicePromptData {
  return {
    command: NPM_CLI,
    version: '0.3.0',
    origin: 'npm',
    removalCommand: 'npm uninstall -g @happier-dev/cli',
    updateCommand: 'npm install -g @happier-dev/cli@latest',
    belowSetupFloor: false,
    missing: false,
    keepBlockedBy: null,
    ...overrides,
  };
}

function createFlowExecutor(calls: string[]): EnrollMachineFlowExecutor {
  return {
    configureRelay: async () => { calls.push('configureRelay'); },
    readAuthStatus: async () => ({
      authenticated: true,
      credentialState: 'valid' as const,
      machineRegistrationState: 'server-confirmed' as const,
      machineId: 'machine-1',
    }),
    requestAuthPairing: async () => ({ publicKey: 'pub-key' }),
    waitForAuthPairing: async () => ({ machineId: 'machine-1' }),
    installDaemonService: async () => { calls.push('installDaemonService'); },
    startDaemonService: async () => { calls.push('startDaemonService'); },
    restartDaemonService: async () => { calls.push('restartDaemonService'); },
    waitForReadyDaemon: async () => ({ serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'machine-1' }),
  };
}

function createKind(calls: string[], cliChoice: Partial<SetupCliChoiceDeps> & Pick<SetupCliChoiceDeps, 'inspect'>) {
  return createSetupThisComputerInteractiveTaskKind({
    cliChoice: {
      record: async (choice: HappierCliChoice) => { calls.push(`record:${choice.mode}`); },
      removePathExposure: async () => { calls.push('removePathExposure'); },
      readServices: async () => { calls.push('readServices'); return []; },
      convergeServices: async ({ exclude }) => {
        calls.push(`convergeServices:${exclude?.targetMode}:${exclude?.serverId}`);
        return { converged: [], failed: [] };
      },
      ...cliChoice,
    },
    ensureLocalHappierTools: async () => {
      calls.push('ensureLocalHappierTools');
      return { provenance: 'override', command: NPM_CLI } as const;
    },
    exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
    createFlowExecutor: () => createFlowExecutor(calls),
    readBackgroundServiceSetupGuidance: async () => ({
      targetReleaseChannel: 'stable',
      targetServerUrl: 'https://relay.example.test',
      currentHappierHomeDir: null,
      currentDefaultReleaseChannel: 'stable',
      managedReleaseChannels: [],
      manualRelayOwner: null,
      conflictingServices: [],
      foreignHomeConflictingServices: [],
      // This Home's service exists and runs — on whatever CLI installed it before.
      exactDefaultServiceExists: true,
      exactDefaultServiceRunning: true,
      shouldOfferDefaultReleaseChannelSwitch: false,
      shouldPromptForManualRelayTakeover: false,
      shouldPromptForServiceReplacement: false,
    }),
    readCurrentRelayOwner: async () => null,
    switchDefaultReleaseChannel: async () => undefined,
    readServerProfileScope: async () => ({ serverId: 'home', activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
    upgradeCliForTokenOnlyPairing: async () => false,
  });
}

async function runSetup(
  kind: ReturnType<typeof createKind>,
  params: Record<string, unknown> = {},
  answer?: unknown,
) {
  const runner = createSystemTasksRunner({ kinds: { 'setup.thisComputer.v1': kind } });
  await runner.start({
    taskId: 'setup',
    kind: 'setup.thisComputer.v1',
    params: {
      surface: 'desktop.ui',
      target: 'thisComputer',
      activeRelayUrl: 'https://relay.example.test',
      activeWebappUrl: 'https://app.example.test',
      ...params,
    },
  });
  const prompts: unknown[] = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const latest = await runner.poll({ taskId: 'setup', cursor: 0 });
    if (latest.result) return { result: latest.result, prompts, events: latest.events };
    if (latest.pendingPrompt && prompts.length === 0) {
      prompts.push(latest.pendingPrompt);
      await runner.respond({ taskId: 'setup', answer: answer ?? {} });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('setup did not finish');
}

describe('setup.thisComputer.v1 — the one-CLI question (R12, 0.3)', () => {
  it('asks before anything is acquired or written, and a dismissal stops with nothing changed', async () => {
    const calls: string[] = [];
    const { result, prompts } = await runSetup(createKind(calls, { inspect: async () => ({ choice: null, question: question() }) }), {}, {});

    expect(prompts).toEqual([{ kind: 'setup.cliChoice', data: question() }]);
    expect(result).toMatchObject({ ok: false, error: { code: 'cli_choice_unanswered' } });
    expect(calls).toEqual([]);
  });

  it('"Keep my own" records the answer and takes back Desktop\'s PATH lines before the kept CLI runs, and converges the service onto it', async () => {
    const calls: string[] = [];
    const { result, events } = await runSetup(createKind(calls, { inspect: async () => ({ choice: null, question: question() }) }), {}, { choice: 'own' });

    expect(result).toMatchObject({ ok: true });
    expect(events).toContainEqual(expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.restartService' }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.startService' }));
    expect(calls).toEqual([
      'record:own',
      'removePathExposure',
      'ensureLocalHappierTools',
      // The other services as they were before this run touched any.
      'readServices',
      'configureRelay',
      // The answer is the consent to switch the service's CLI: the strict install rewrites it.
      'installDaemonService',
      'restartDaemonService',
      // Then every other service of this home and ring, never the one this run set up.
      'convergeServices:pinned:home',
    ]);
  });

  it('"Let Happier manage it" records the answer, acquires, and converges the service without a second prompt', async () => {
    const calls: string[] = [];
    const { result, prompts } = await runSetup(createKind(calls, { inspect: async () => ({ choice: null, question: question() }) }), {}, { choice: 'managed' });

    expect(result).toMatchObject({ ok: true });
    expect(prompts).toHaveLength(1);
    expect(calls).toEqual(['record:managed', 'ensureLocalHappierTools', 'readServices', 'configureRelay', 'installDaemonService', 'restartDaemonService', 'convergeServices:pinned:home']);
  });

  it('refuses "Keep my own" where the question said keeping it cannot work, before anything is written', async () => {
    const calls: string[] = [];
    const { result } = await runSetup(
      createKind(calls, { inspect: async () => ({ choice: null, question: question({ keepBlockedBy: '/home/tester/.local/bin/happier' }) }) }),
      {},
      { choice: 'own' },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'cli_choice_unanswered', message: expect.stringContaining('/home/tester/.local/bin/happier') } });
    expect(calls).toEqual([]);
  });

  it('"Keep my own" for a kept CLI that disappeared stops by name with nothing written (R13 b)', async () => {
    const calls: string[] = [];
    const { result } = await runSetup(
      createKind(calls, { inspect: async () => ({ choice: { mode: 'own', command: NPM_CLI }, question: question({ version: null, missing: true }) }) }),
      {},
      { choice: 'own' },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'cli_own_missing' } });
    expect(calls).toEqual([]);
  });

  it('"Keep my own" for a CLI that cannot serve setup keeps the answer, names its update command and acquires nothing', async () => {
    const calls: string[] = [];
    const { result } = await runSetup(
      createKind(calls, { inspect: async () => ({ choice: null, question: question({ version: '0.2.13', belowSetupFloor: true }) }) }),
      {},
      { choice: 'own' },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'cli_own_below_setup_floor', message: expect.stringContaining('npm install -g @happier-dev/cli@latest') },
    });
    expect(calls).toEqual(['record:own', 'removePathExposure']);
  });

  it('asks nothing when there is no question, and passes Settings\' reconsider through', async () => {
    const calls: string[] = [];
    const inspected: unknown[] = [];
    const { result, prompts } = await runSetup(createKind(calls, {
      inspect: async (params) => { inspected.push(params); return { choice: null, question: null }; },
    }), { reconsiderCli: true });

    expect(result).toMatchObject({ ok: true });
    expect(prompts).toEqual([]);
    expect(inspected).toEqual([{ reconsider: true }]);
    // Nothing was answered in this run: the running exact service is left alone.
    expect(calls).toEqual(['ensureLocalHappierTools', 'configureRelay']);
  });

  it('fails by name when another service of this home could not be moved to the chosen CLI', async () => {
    const calls: string[] = [];
    const { result } = await runSetup(createKind(calls, {
      inspect: async () => ({ choice: null, question: question() }),
      convergeServices: async () => ({ converged: [], failed: [{ label: 'happier-daemon.default', message: 'systemctl failed' }] }),
    }), {}, { choice: 'own' });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'cli_choice_service_convergence_failed', message: expect.stringContaining('happier-daemon.default') },
    });
  });

  it('a recovery retry re-converges every service onto the recorded choice without asking again', async () => {
    const calls: string[] = [];
    const { result, prompts } = await runSetup(createKind(calls, {
      inspect: async () => ({ choice: { mode: 'own', command: NPM_CLI }, question: null }),
    }), { convergeCliChoice: true });

    expect(result).toMatchObject({ ok: true });
    expect(prompts).toEqual([]);
    expect(calls).toEqual([
      'ensureLocalHappierTools',
      'readServices',
      'configureRelay',
      'installDaemonService',
      'restartDaemonService',
      'convergeServices:pinned:home',
    ]);
  });
});
