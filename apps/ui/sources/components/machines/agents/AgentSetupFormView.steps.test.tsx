import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
import { t } from '@/text';
import { presentAgentInstallJobFailure, presentAgentInstallJobRpcFailure } from '@/agents/machineAgents/installJobs/presentAgentInstallJobFailure';
import { AgentInstallJobRpcError } from '@/agents/machineAgents/installJobs/api';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import {
  AGENT_INSTALL_JOB_VERIFY_STEP_ID,
  buildAgentInstallJobCliStepId,
} from '@happier-dev/protocol/daemon/agent-install-jobs';

import {
  AgentSetupFormView,
  type AgentSetupFormHandlers,
} from './AgentSetupFormView';
import { resolveMachineAgentPickerPlacement, resolveMachineAgentRowAction } from './machineAgentPresentation';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

afterEach(() => {
  standardCleanup();
});

const noop = () => {};
const HANDLERS: AgentSetupFormHandlers = {
  onInstall: noop,
  onRetry: noop,
  onCancelInstall: noop,
  onCheckAgain: noop,
  onOpenGuide: noop,
  onUseService: noop,
  onConnectService: noop,
  onOpenNativeSignIn: noop,
  onShowTerminal: noop,
  onCancelSignIn: noop,
};

type Job = NonNullable<MachineAgent['job']>;

/** Pi as the inventory owner projects it: not on the Machine until a probe or a settled job says so. */
function pi(
  input: Readonly<{
    installed?: boolean;
    signIn?: 'unknown' | 'signedOut';
    job?: Job | null;
    checking?: boolean;
    guideUrl?: string;
    executionScope?: 'machine' | 'member';
    installAvailable?: boolean;
    connectedServices?: Parameters<typeof projectMachineAgent>[0]['connectedServices'];
  }>,
) {
  const facts = MachineAgentInventoryItemSchema.parse({
    agentId: 'pi',
    title: 'Pi',
    installed: input.installed ?? false,
    version: null,
    latestVersion: null,
    update: { supported: false, command: null },
    signIn: {
      status: input.signIn ?? 'unknown',
      loginSupport: 'login_terminal',
    },
    platform: { supported: true },
    install: {
      available: input.installAvailable ?? true,
      mode: 'managed',
      sizeBytes: null,
      guideUrl: input.guideUrl ?? null,
      ...(input.executionScope ? { executionScope: input.executionScope } : {}),
    },
    dependencies: [],
  });
  return projectMachineAgent({
    agentId: 'pi',
    title: 'Pi',
    facts,
    checking: input.checking ?? false,
    stale: false,
    connectedServices: input.connectedServices ?? [],
    job: input.job ?? null,
    installedCheckedAt: 100,
  });
}

const cliStep = buildAgentInstallJobCliStepId({ agentId: 'pi' });
function job(steps: Job['steps'], outcome: Job['outcome'] = null): Job {
  return {
    jobId: 'job-1',
    intent: 'install',
    startedAtMs: 200,
    logLine: null,
    outcome,
    steps,
  };
}
const step = (
  stepId: string,
  label: string,
  state: 'running' | 'done' | 'failed',
) => ({ stepId, label, state, bytesDone: null, bytesTotal: null });

async function stepsOf(agent: MachineAgent) {
  const screen = await renderScreen(
    <AgentSetupFormView
      testID="setup"
      agent={agent}
      machineName="devbox"
      layout="compact"
      session={null}
      handlers={HANDLERS}
    />,
  );
  const ids = screen.root
    .findAll((node) => node.props.item?.id && node.props.execution?.status)
    .map((node) => `${node.props.execution.status}-${String(node.props.item.id).toLowerCase()}`);
  return { screen, steps: [...new Set(ids)] };
}

describe('agent setup steps', () => {
  it.each(['full', 'compact'] as const)('offers requester-scoped Install and preserves Manage in %s setup', async (layout) => {
    for (const [canManage, executionScope, available, allowed] of [
      [false, undefined, true, false], [false, 'machine', true, false],
      [false, 'member', true, true], [false, 'member', false, false],
      [true, undefined, true, true], [true, 'machine', true, true],
    ] as const) {
      const agent = pi({ executionScope, installAvailable: available });
      const onInstall = vi.fn();
      const screen = await renderScreen(<AgentSetupFormView testID="setup" agent={agent} machineName="devbox"
        layout={layout} canManage={canManage} handlers={{ ...HANDLERS, onInstall }} />);
      expect(screen.findByTestId('setup.install') !== null).toBe(allowed);
      if (allowed) {
        await screen.pressByTestIdAsync('setup.install');
        expect(onInstall).toHaveBeenCalledOnce();
      }
      await screen.unmount();
    }
  });

  it.each(['full', 'compact'] as const)('offers requester-scoped cancel and retry in %s setup', async (layout) => {
    const running = job([step(cliStep, 'Pi CLI', 'running')]);
    const failed = job([step(cliStep, 'Pi CLI', 'failed')], { kind: 'failed', code: 'download_failed', stepId: cliStep, message: 'Download failed' });
    for (const [record, action] of [[running, 'cancel'], [failed, 'retry']] as const) {
      for (const [canManage, executionScope, allowed] of [[false, undefined, false], [false, 'machine', false], [false, 'member', true], [true, undefined, true]] as const) {
        const handler = vi.fn();
        const scopedRecord = executionScope ? { ...record, executionScope } : record;
        const screen = await renderScreen(<AgentSetupFormView testID="setup" agent={pi({ job: scopedRecord, executionScope })} machineName="devbox"
          layout={layout} canManage={canManage} handlers={{ ...HANDLERS, onCancelInstall: handler, onRetry: handler }} />);
        expect(screen.findByTestId(`setup.${action}`) !== null).toBe(allowed);
        if (allowed) {
          await screen.pressByTestIdAsync(`setup.${action}`);
          expect(handler).toHaveBeenCalledOnce();
        }
        await screen.unmount();
      }
    }
  });

  it('starts sign-in on a connected account when one exists, and on the terminal otherwise', async () => {
    // Connected to the Account but not yet chosen for this Agent.
    const chatgpt = { serviceId: 'openai-codex', title: 'ChatGPT', connected: false, healthy: false, profileLabel: null,
      profiles: [{ profileId: 'work', healthy: true, profileLabel: 'Work' }] };
    for (const [connectedServices, primary] of [[[chatgpt], 'useService'], [[], 'openTerminal']] as const) {
      const screen = await renderScreen(<AgentSetupFormView testID="setup" agent={pi({ installed: true, signIn: 'signedOut', connectedServices })}
        machineName="devbox" layout="full" handlers={HANDLERS} />);
      try {
        expect(screen.findByTestId(`setup.${primary}`), screen.getTextContent()).not.toBeNull();
      } finally { await screen.unmount(); }
    }
  });

  it('keeps unknown sign-in distinct from a failed installation check in the expanded setup', async () => {
    const agent = pi({ installed: true, signIn: 'unknown' });
    expect(agent.state).toBe('unknown');
    const onCheckAgain = vi.fn();
    const screen = await renderScreen(<AgentSetupFormView testID="setup" agent={agent} machineName="devbox"
      layout="full" handlers={{ ...HANDLERS, onCheckAgain }} />);
    try {
      expect(screen.getTextContent()).toContain(t('machineAgents.signInUnknown'));
      expect(screen.getTextContent()).not.toContain(t('machineAgents.unknown'));
      await screen.pressByTestIdAsync('setup.unknown-action');
      expect(onCheckAgain).toHaveBeenCalledOnce();
    } finally { await screen.unmount(); }
  });

  it('offers recovery for a refused observation without claiming the installer failed', async () => {
    const onRetry = vi.fn();
    const agent = pi({ job: { ...job([step(cliStep, 'Pi CLI', 'running')]), readFailure: 'install_unavailable' } });
    expect(agent.state).toBe('unknown');
    expect(agent.job?.outcome).toBeNull();
    expect(resolveMachineAgentRowAction(agent)).toEqual({ kind: 'retry' });
    expect(resolveMachineAgentPickerPlacement(agent).opensSetup).toBe(true);
    const screen = await renderScreen(<AgentSetupFormView testID="setup" agent={agent} machineName="devbox"
      layout="compact" handlers={{ ...HANDLERS, onRetry }} />);
    try {
      expect(screen.getTextContent()).toContain(presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError('install_unavailable')).body);
      expect(screen.findByTestId('setup.cancel')).toBeNull();
      await screen.pressByTestIdAsync('setup.retry');
      expect(onRetry).toHaveBeenCalledOnce();
    } finally { await screen.unmount(); }
  });

  it('uses the failure presenter instead of raw installer diagnostics for recovery guidance', async () => {
    const failure = { kind: 'failed', code: 'in_use', stepId: cliStep, message: 'Raw installer output from a private machine path' } as const;
    const screen = await renderScreen(<AgentSetupFormView testID="setup"
      agent={pi({ job: job([], failure) })} machineName="devbox" layout="compact" handlers={HANDLERS} />);
    try {
      expect(screen.getTextContent()).toContain(presentAgentInstallJobFailure(failure).body);
      expect(screen.getTextContent()).not.toContain(failure.message);
    } finally { await screen.unmount(); }
  });

  it('opens the known installation guide when the terminal failure omits its URL', async () => {
    const onOpenGuide = vi.fn(), onRetry = vi.fn();
    const guideUrl = 'https://example.com/install';
    const agent = pi({ guideUrl, job: job([], { kind: 'failed', code: 'not_managed', stepId: cliStep, message: 'Agent is not managed' }) });
    const screen = await renderScreen(<AgentSetupFormView testID="setup" agent={agent} machineName="devbox"
      layout="compact" handlers={{ ...HANDLERS, onOpenGuide, onRetry }} />);
    try {
      await screen.pressByTestIdAsync('setup.failure.guide');
      expect(onOpenGuide).toHaveBeenCalledWith(guideUrl);
      expect(onRetry).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
  });

  it.each([true, false])('chooses another Agent instead of retrying an unsupported installation when selection is available: %s', async canChoose => {
    const onRetry = vi.fn(), onSetUpAnother = vi.fn();
    const agent = pi({ job: job([], { kind: 'failed', code: 'unsupported_platform', stepId: cliStep, message: 'Platform is unsupported' }) });
    const screen = await renderScreen(<AgentSetupFormView testID="setup" agent={agent} machineName="devbox"
      layout="compact" handlers={{ ...HANDLERS, onRetry, ...(canChoose ? { onSetUpAnother } : {}) }} />);
    try {
      expect(screen.findByTestId('setup.retry')).toBeNull();
      if (canChoose) {
        await screen.pressByTestIdAsync('setup.chooseAgent');
        expect(onSetUpAnother).toHaveBeenCalledOnce();
      } else expect(screen.findByTestId('setup.chooseAgent')).toBeNull();
      expect(onRetry).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
    const retryScreen = await renderScreen(<AgentSetupFormView testID="setup"
      agent={pi({ job: job([], { kind: 'failed', code: 'download_failed', stepId: cliStep, message: 'Download failed' }) })}
      machineName="devbox" layout="compact" handlers={{ ...HANDLERS, onRetry, onSetUpAnother }} />);
    try {
      await retryScreen.pressByTestIdAsync('setup.retry');
      expect(onRetry).toHaveBeenCalledOnce();
      expect(onSetUpAnother).toHaveBeenCalledTimes(canChoose ? 1 : 0);
    } finally { await retryScreen.unmount(); }
  });

  it('drives one step list from the plan through the job into sign-in', async () => {
    const plan = await stepsOf(pi({}));
    expect(plan.steps).toEqual([
      'queued-agent',
      'queued-check',
      'queued-signin',
    ]);
    expect(plan.screen.findByTestId('setup.install')).not.toBeNull();
    await plan.screen.unmount();

    // Admitted, before the daemon reported a step: the same rows, not an empty list.
    const admitted = await stepsOf(pi({ job: job([]) }));
    expect(admitted.steps).toEqual([
      'queued-agent',
      'queued-check',
      'queued-signin',
    ]);
    await admitted.screen.unmount();

    const installing = await stepsOf(
      pi({ job: job([step(cliStep, 'Pi', 'running')]) }),
    );
    expect(installing.steps).toEqual([
      'running-agent',
      'queued-check',
      'queued-signin',
    ]);
    await installing.screen.unmount();

    const checking = await stepsOf(
      pi({
        job: job([
          step(cliStep, 'Pi', 'done'),
          step(AGENT_INSTALL_JOB_VERIFY_STEP_ID, 'Check it runs', 'running'),
        ]),
      }),
    );
    expect(checking.steps).toEqual([
      'done-agent',
      'running-check',
      'queued-signin',
    ]);
    await checking.screen.unmount();

    // Settled: the Machine is still reading sign-in, which is the last step running; never "not installed".
    const settledJob = job(
      [
        step(cliStep, 'Pi', 'done'),
        step(AGENT_INSTALL_JOB_VERIFY_STEP_ID, 'Check it runs', 'done'),
      ],
      { kind: 'succeeded', version: '0.9.1' },
    );
    const readingSignIn = await stepsOf(
      pi({ job: settledJob, checking: true }),
    );
    expect(readingSignIn.steps).toEqual([
      'done-agent',
      'done-check',
      'running-signin',
    ]);
    expect(readingSignIn.screen.findByTestId('setup.install')).toBeNull();
    await readingSignIn.screen.unmount();

    const signIn = await stepsOf(pi({ job: settledJob, signIn: 'signedOut' }));
    expect(signIn.steps).toEqual([
      'done-agent',
      'done-check',
      'queued-signin',
    ]);
    expect(signIn.screen.findByTestId('setup.openTerminal')).not.toBeNull();
    await signIn.screen.unmount();
  });

  it('labels a cancelled install step without showing an error', async () => {
    const cancelled = await stepsOf(pi({
      job: job([step(cliStep, 'Pi', 'failed')], {
        kind: 'failed', code: 'cancelled', stepId: cliStep, message: 'Cancelled',
      }),
    }));
    expect(cancelled.steps).toEqual(['idle-agent', 'queued-check', 'queued-signin']);
    expect(cancelled.screen.getTextContent()).toContain(t('status.canceled'));
    expect(cancelled.screen.findByTestId('setup.retry')).toBeNull();
  });

  it('shows the failing step with its Retry', async () => {
    const failed = await stepsOf(
      pi({
        job: job([step(cliStep, 'Pi', 'failed')], {
          kind: 'failed',
          code: 'download_failed',
          stepId: cliStep,
          message: 'Network unreachable',
        }),
      }),
    );
    expect(failed.steps).toEqual([
      'error-agent',
      'queued-check',
      'queued-signin',
    ]);
    expect(failed.screen.findByTestId('setup.retry')).not.toBeNull();
  });

  it('keeps the engine rail on the setup pane while a just-installed agent reads its sign-in', () => {
    const settledJob = job([], { kind: 'succeeded', version: '0.9.1' });
    expect(
      resolveMachineAgentPickerPlacement(
        pi({ job: settledJob, checking: true }),
      ),
    ).toEqual({ group: 'onMachine', marker: 'installing', opensSetup: true });
    expect(
      resolveMachineAgentPickerPlacement(
        pi({ installed: true, checking: true }),
      ),
    ).toMatchObject({ opensSetup: false });
  });
});
