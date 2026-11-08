import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
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
import { resolveMachineAgentPickerPlacement } from './machineAgentPresentation';

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
      available: true,
      mode: 'managed',
      sizeBytes: null,
      guideUrl: null,
    },
    dependencies: [],
  });
  return projectMachineAgent({
    agentId: 'pi',
    title: 'Pi',
    facts,
    checking: input.checking ?? false,
    stale: false,
    connectedServices: [],
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
    .findAll(
      (node) =>
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith('setup.steps-') &&
        typeof node.type === 'string',
    )
    .map((node) => String(node.props.testID).slice('setup.steps-'.length));
  return { screen, steps: [...new Set(ids)] };
}

describe('agent setup steps', () => {
  it('drives one step list from the plan through the job into sign-in', async () => {
    const plan = await stepsOf(pi({}));
    expect(plan.steps).toEqual([
      'upcoming-agent',
      'upcoming-check',
      'upcoming-signin',
    ]);
    expect(plan.screen.findByTestId('setup.install')).not.toBeNull();
    await plan.screen.unmount();

    // Admitted, before the daemon reported a step: the same rows, not an empty list.
    const admitted = await stepsOf(pi({ job: job([]) }));
    expect(admitted.steps).toEqual([
      'upcoming-agent',
      'upcoming-check',
      'upcoming-signin',
    ]);
    await admitted.screen.unmount();

    const installing = await stepsOf(
      pi({ job: job([step(cliStep, 'Pi', 'running')]) }),
    );
    expect(installing.steps).toEqual([
      'running-agent',
      'upcoming-check',
      'upcoming-signin',
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
      'upcoming-signin',
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
      'current-signin',
    ]);
    expect(signIn.screen.findByTestId('setup.openTerminal')).not.toBeNull();
    await signIn.screen.unmount();
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
      'failed-agent',
      'upcoming-check',
      'upcoming-signin',
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
