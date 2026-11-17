import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { TriggerWhenValue } from './sessionTriggerForm';
import type { ResourceWorkflowTriggerStartOption } from './workflowTriggerStarts';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';

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
vi.mock('@/utils/web/radixCjs', async () =>
  (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock(),
);
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
    { maxHeight: 640, maxWidth: 600, placement: 'bottom' },
  ),
);

const { ResourceLinkWorkflowSheet } =
  await import('./ResourceLinkWorkflowSheet');
const { TriggerPluginEventRows } = await import('./TriggerPluginEventRows');
const { ValueFieldSelect } =
  await import('@/components/ui/forms/ValueFieldSelect');
const { SegmentedTabBar } =
  await import('@/components/ui/navigation/SegmentedTabBar');

afterEach(() => standardCleanup());

const subject = {
  kind: 'environment' as const,
  serverId: 'home',
  environmentId: 'production',
};
const before = {
  kind: 'action' as const,
  phase: 'before' as const,
  actionIds: ['machines.command.run'],
  subject,
};
const option = {
  id: 'action.before:machines.command.run',
  label: 'Run a command',
  relation: 'before' as const,
  subject,
  setupRequired: false as const,
  when: before,
  trigger: { ...before, enabled: true },
};

function linkFor(missingAudience: readonly PrincipalRefV1[]) {
  return {
    whenOptions: [option],
    whenStatus: 'ready' as const,
    draft: null,
    setDraft: vi.fn(),
    missingAudience,
    issue: null,
    loading: false,
    retryReview: vi.fn(),
    submit: vi.fn(async (decision: 'accept' | 'decline') =>
      decision === 'decline'
        ? {
            ok: false as const,
            phase: 'declined' as const,
            shared: [] as const,
          }
        : {
            ok: false as const,
            phase: 'link' as const,
            shared: [],
            error: new Error('offline'),
          },
    ),
  };
}

// 05 S5 Link + D8: Workflow, When from the resource's starts, the before wait policy, and the same-step share question.
describe('Link a workflow to a resource', () => {
  it.each([false, true])('retains configured Event input when choosing another Workflow (configured first: %s)', async configuredFirst => {
    const eventRef = { pluginId: 'acme.deploy', localId: 'released' };
    const eventOption = {
      id: 'event:acme.deploy/released', label: 'Released', relation: 'event', subject,
      setupRequired: true, when: { kind: 'pluginEvent', value: null, eventRef }, trigger: null,
      eventSeed: { eventRef, monitoringMachineId: 'runner', setupInput: {} },
    } satisfies ResourceWorkflowTriggerStartOption;
    const configured: Extract<TriggerWhenValue, { kind: 'pluginEvent' }> = {
      kind: 'pluginEvent', value: {
        kind: 'pluginEvent', enabled: true, eventRef, sourceInstanceId: 'production', sourceContractVersion: 1,
        sourceConfig: { environment: 'production' }, displayLabel: 'Production release', filter: null,
        maximumObservationAgeMs: null, observationTransport: { kind: 'checkpointedPull',
          watcherMaterializationRef: { machineId: 'runner', pluginId: 'acme.deploy', materializationId: 'deploy' } },
      },
    };
    const link = { ...linkFor([]), whenOptions: [eventOption] };
    const screen = await renderScreen(<ResourceLinkWorkflowSheet anchorRef={React.createRef<never>()}
      resourceName="Production" link={link} serverId={null} machineId={null} accountLifetime={null}
      onRequestClose={() => undefined} onLinked={() => undefined} />);
    try {
      const [workflowSelect, whenSelect] = screen.findAllByType(ValueFieldSelect);
      if (!configuredFirst) await act(async () => workflowSelect!.props.onSelect('builtin:review-and-converge'));
      await act(async () => whenSelect!.props.onSelect(eventOption.id));
      // The real Event editor's accepted configuration is the presentation owner's input.
      await act(async () => screen.findAllByType(TriggerPluginEventRows)[0]!.props.onChange(configured));
      expect(screen.findAllByType(TriggerPluginEventRows)[0]!.props.when).toMatchObject(configured);
      await act(async () => workflowSelect!.props.onSelect('builtin:plan-with-a-panel'));
      expect(link.setDraft).toHaveBeenLastCalledWith({ workflow: 'builtin:plan-with-a-panel', trigger: configured.value });
    } finally { await screen.unmount(); }
  });

  it('groups the Workflow choices as yours, shared with you, then built-in', async () => {
    const screen = await renderScreen(<ResourceLinkWorkflowSheet anchorRef={React.createRef<never>()}
      resourceName="Production" link={linkFor([]) as never} serverId={null} machineId={null} accountLifetime={null}
      onRequestClose={() => undefined} onLinked={() => undefined} />);
    try {
      const [workflowSelect] = screen.findAllByType(ValueFieldSelect);
      const builtin = workflowSelect!.props.items.find((item: { id: string }) => item.id === 'builtin:review-and-converge');
      expect(builtin?.category).toBe('workflows.triggers.link.builtIn');
    } finally { await screen.unmount(); }
  });

  it('drafts a before link that waits by default, offers If it fails, and asks to share on a shared resource', async () => {
    const link = linkFor([
      { kind: 'team', teamId: 'team-studio' } as PrincipalRefV1,
    ]);
    const anchor = React.createRef<never>();
    const screen = await renderScreen(
      <ResourceLinkWorkflowSheet
        anchorRef={anchor}
        resourceName="Production"
        link={link as never}
        serverId={null}
        machineId={null}
        accountLifetime={null}
        onRequestClose={() => undefined}
        onLinked={() => undefined}
      />,
    );
    const [workflowSelect, whenSelect] = screen.findAllByType(ValueFieldSelect);
    await act(async () => {
      workflowSelect!.props.onSelect('builtin:review-and-converge');
    });
    await act(async () => {
      whenSelect!.props.onSelect(option.id);
    });
    expect(link.setDraft).toHaveBeenLastCalledWith({
      workflow: 'builtin:review-and-converge',
      trigger: { ...before, mode: 'wait', enabled: true },
    });
    // Wait shows If it fails; choosing Let a person approve drafts the override policy.
    const policy = screen.findAllByType(SegmentedTabBar);
    expect(policy).toHaveLength(2);
    await act(async () => {
      policy[1]!.props.onSelectTab('ask');
    });
    expect(link.setDraft).toHaveBeenLastCalledWith({
      workflow: 'builtin:review-and-converge',
      trigger: { ...before, mode: 'wait', onFailure: 'ask', enabled: true },
    });
    expect(screen.findByTestId('resource-link-share')).not.toBeNull();
    expect(screen.getTextContent()).toContain(
      'workflows.triggers.link.shareAndLink',
    );
    await act(async () => {
      screen.findByTestId('resource-link-cancel')!.props.onPress();
    });
    expect(link.submit).toHaveBeenLastCalledWith('decline');
    await screen.unmount();
  });

  // QA-B E10: the section hands a new setter on a later render; the chosen Workflow and When must stay drafted.
  it('keeps the draft while the section re-renders with a new setter, and drops it only on close', async () => {
    const first = linkFor([]);
    const sheet = (link: ReturnType<typeof linkFor>) => <ResourceLinkWorkflowSheet anchorRef={React.createRef<never>()}
      resourceName="Studio" link={link} serverId={null} machineId={null} accountLifetime={null}
      onRequestClose={() => undefined} onLinked={() => undefined} />;
    const screen = await renderScreen(sheet(first));
    const [workflowSelect, whenSelect] = screen.findAllByType(ValueFieldSelect);
    await act(async () => workflowSelect!.props.onSelect('builtin:review-and-converge'));
    await act(async () => whenSelect!.props.onSelect(option.id));
    const drafted = first.setDraft.mock.calls.at(-1)?.[0];
    expect(drafted).toMatchObject({ workflow: 'builtin:review-and-converge' });
    const second = { ...linkFor([]), draft: drafted };
    await act(async () => screen.update(sheet(second)));
    expect(first.setDraft).not.toHaveBeenLastCalledWith(null);
    expect(second.setDraft).not.toHaveBeenCalled();
    await screen.unmount();
    expect(second.setDraft).toHaveBeenLastCalledWith(null);
  });

  it('links without a share question on a private resource and says why a link failed', async () => {
    const link = linkFor([]);
    const screen = await renderScreen(
      <ResourceLinkWorkflowSheet
        anchorRef={React.createRef<never>()}
        resourceName="Production"
        link={
          {
            ...link,
            draft: { workflow: 'w', trigger: { ...before, enabled: true } },
          } as never
        }
        serverId={null}
        machineId={null}
        accountLifetime={null}
        onRequestClose={() => undefined}
        onLinked={() => undefined}
      />,
    );
    expect(screen.findByTestId('resource-link-share')).toBeNull();
    expect(screen.getTextContent()).toContain('workflows.triggers.link.link');
    await act(async () => {
      screen.findByTestId('resource-link-submit')!.props.onPress();
    });
    expect(link.submit).toHaveBeenLastCalledWith('accept');
    expect(screen.findByTestId('resource-link-failure')).not.toBeNull();
    await screen.unmount();
  });
});
