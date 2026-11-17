import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';

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
