import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalAutomaticChecksV1Schema,
  type ApprovalAutomaticChecksV1,
} from '@happier-dev/protocol/approvals/approvalAutomaticChecks';

import { act, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);

const {
  ApprovalAutomaticChecks,
  readApprovalAutomaticChecksDecision,
  useApprovalAutomaticChecksControls,
} = await import('./ApprovalAutomaticChecks');

afterEach(() => standardCleanup());

const selected = {
  phase: 'before',
  actionIds: ['machines.command.run'],
  mode: 'wait',
  onFailure: 'ask',
  automationId: 'automation-freeze',
  triggerId: 'trigger-freeze',
  triggerRevision: 1,
  workflowId: 'artifact-release-freeze',
  workflowRevision: 3,
  ownerAccountId: 'account-mara',
};
const ref = {
  automationId: selected.automationId,
  triggerId: selected.triggerId,
};

function checks(
  patch: Partial<ApprovalAutomaticChecksV1>,
): ApprovalAutomaticChecksV1 {
  return ApprovalAutomaticChecksV1Schema.parse({
    phase: 'consent',
    humanApprovalRequired: false,
    subjects: [],
    selectionStatus: 'ready',
    notices: [],
    selected: [selected],
    consents: [],
    runs: [],
    results: [],
    ...patch,
  });
}

// 05 S6/S8/S9: the card answers a shared check's consent, cancels a running check, or approves anyway after a failure.
describe('Action before checks on the approval card', () => {
  it('opens Review steps and check Runs on the approval Home instead of the focused Home', async () => {
    const navigation = createExpoRouterMock({ params: { serverId: 'focused-home' } });
    const approvalHome = 'approval-home';
    const runId = '971fe48e-43ac-49da-b01c-ed30f5d9a6f7';
    const cases = [
      { value: checks({ consents: [{ ...ref, decision: 'pending' }] }), label: 'reviewSteps',
        route: `/workflows/${selected.workflowId}?serverId=${approvalHome}` },
      { value: checks({ phase: 'checking', runs: [{ ...ref, runId }] }), label: 'openRun',
        route: `/workflows/runs/${runId}?serverId=${approvalHome}` },
      { value: checks({ phase: 'override', runs: [{ ...ref, runId }], results: [{ ...ref, runId, outcome: 'failed' }] }), label: 'openRun',
        route: `/workflows/runs/${runId}?serverId=${approvalHome}` },
    ];
    for (const { value, label, route } of cases) {
      const screen = await renderScreen(<ApprovalAutomaticChecks checks={value} actionTitle="Deploy"
        serverId={approvalHome} onOpenRoute={href => navigation.module.router.push(href)} />);
      const link = screen.findAll(node => typeof node.type === 'string'
        && node.props.accessibilityLabel === `workflows.triggers.checks.${label}`
        && typeof node.props.onPress === 'function')[0];
      expect(link).toBeDefined();
      await act(async () => { link!.props.onPress(); });
      expect(navigation.spies.push).toHaveBeenLastCalledWith(route);
      await screen.unmount();
    }
  });

  it('asks for consent once per pending shared check and says it is asked again after a change', async () => {
    const pending = checks({
      consents: [{ ...ref, decision: 'pending', review: { reason: 'steps' } }],
    });
    expect(readApprovalAutomaticChecksDecision(pending)).toEqual({
      kind: 'consent',
      ...ref,
    });
    const screen = await renderScreen(
      <ApprovalAutomaticChecks
        checks={pending}
        actionTitle="Deploy"
        serverId={null}
        onOpenRoute={() => undefined}
        testID="checks"
      />,
    );
    expect(screen.findByTestId('checks:consent')).not.toBeNull();
    expect(screen.getTextContent()).toContain(
      'workflows.triggers.checks.consentChangedSteps',
    );
    expect(screen.getTextContent()).toContain(
      'workflows.triggers.checks.consentReask',
    );
    expect(screen.getTextContent()).toContain(
      'workflows.triggers.checks.consentOnlyYou',
    );
    expect(screen.findByTestId('checks:review')).not.toBeNull();
    await screen.unmount();
  });

  it('answers consent through the decision owner without approving the Action itself, and cancels a running check', async () => {
    const decide = vi.fn(async () => true);
    const hook = await renderHook(
      (props: { value: ApprovalAutomaticChecksV1 }) => {
        const [isDeciding, setIsDeciding] = React.useState(false);
        return useApprovalAutomaticChecksControls({
          checks: props.value,
          decide,
          unavailable: false,
          isDeciding,
          setIsDeciding,
        });
      },
      {
        initialProps: {
          value: checks({ consents: [{ ...ref, decision: 'pending' }] }),
        },
      },
    );
    await act(async () => {
      await hook.getCurrent().answerConsent('skip');
    });
    expect(decide).toHaveBeenLastCalledWith('approve', {
      triggerConsent: { ...ref, decision: 'skip' },
    });
    await hook.rerender({
      value: checks({
        phase: 'checking',
        consents: [{ ...ref, decision: 'allow' }],
        humanApprovalRequired: false,
        runs: [{ ...ref, runId: 'run-214' }],
      }),
    });
    expect(hook.getCurrent().decision).toEqual({ kind: 'checking' });
    await act(async () => {
      await hook.getCurrent().cancelChecks();
    });
    expect(decide).toHaveBeenLastCalledWith('cancel');
    await hook.unmount();
  });

  it('turns a failed wait check into Approve anyway, and says a visible Skip', async () => {
    const override = checks({
      phase: 'override',
      consents: [],
      runs: [{ ...ref, runId: 'run-214' }],
      results: [{ ...ref, runId: 'run-214', outcome: 'failed' }],
    });
    expect(readApprovalAutomaticChecksDecision(override)).toEqual({
      kind: 'override',
    });
    const screen = await renderScreen(
      <ApprovalAutomaticChecks
        checks={override}
        actionTitle="Deploy"
        serverId={null}
        onOpenRoute={() => undefined}
        testID="checks"
      />,
    );
    expect(screen.findByTestId('checks:override')).not.toBeNull();
    expect(screen.getTextContent()).toContain(
      'workflows.triggers.checks.overrideTitle',
    );
    await screen.unmount();
    const skipped = checks({
      phase: 'passed',
      consents: [{ ...ref, decision: 'skip' }],
    });
    expect(readApprovalAutomaticChecksDecision(skipped)).toBeNull();
    const second = await renderScreen(
      <ApprovalAutomaticChecks
        checks={skipped}
        actionTitle="Deploy"
        serverId={null}
        testID="checks"
      />,
    );
    expect(second.findByTestId('checks:skipped:0')).not.toBeNull();
    expect(second.getTextContent()).toContain(
      'workflows.triggers.checks.skipped',
    );
    await second.unmount();
  });

  // R24 and the shared-Bot recovery: a typed skip says why; an unknown reason says only that it skipped.
  it('says why a check was skipped from its typed reason, naming the Account holder for a shared Bot', async () => {
    const notice = (reason: string) => ({ code: 'action_automation_skipped' as const, ...ref, workflowId: selected.workflowId, reason });
    const machine = notice('machineRequired');
    const holder = notice('actorConsentUnavailableForRequester');
    const other = notice('some_future_reason');
    const value = checks({ phase: 'passed', notices: [machine, holder, other] });
    const screen = await renderScreen(
      <ApprovalAutomaticChecks checks={value} actionTitle="Deploy" serverId={null} testID="checks"
        automaticChecksExecutionAccountName="Ade"
        automaticCheckSkips={[{ notice: machine, reason: 'machineRequired' },
          { notice: holder, reason: 'actorConsentUnavailableForRequester' }, { notice: other, reason: null }]} />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('workflows.triggers.checks.skippedNeedsMachine');
    expect(text).toContain('workflows.triggers.checks.skippedNotAllowedBy');
    expect(text).toContain('Ade');
    expect(text).toContain('workflows.triggers.checks.skippedUnavailable');
    await screen.unmount();
  });
});
