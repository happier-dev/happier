// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

installUiListsCommonModuleMocks();
vi.mock('@/utils/web/reactDomCjs', () => ({
  // ReactTestRenderer cannot mount DOM portals; keep the real popover/menu beneath this boundary.
  requireReactDOM: () => ({
    createPortal: (children: React.ReactNode) => children,
  }),
}));

const { ProjectPhoneHeadView } = await import('./ProjectShellHeaderHost');
const { LookPopover } = await import('@/components/atmosphere/look/LookChip');
const { DropdownMenu } =
  await import('@/components/ui/forms/dropdown/DropdownMenu');
const { t } = await import('@/text');
const { actionOperationStore } =
  await import('@/sync/domains/actionOperations/actionOperationStore');

const checkout = {
  machineName: 'NLDW3-5-36-33 · 58f6',
  machineNameParts: { name: 'NLDW3-5-36-33', hint: '58f6' },
  machineIcon: 'desktop' as const,
  branch: null,
  choices: [],
  onSelect: () => {},
};

describe('Project phone head (owner P1 11-15)', () => {
  afterEach(() => {
    standardCleanup();
    actionOperationStore.reset();
  });

  it("carries the Machine chip, the launchers and ⋯ on the bar, and the ⋯ opens the Project's Look", async () => {
    const screen = await renderScreen(
      <ProjectPhoneHeadView
        checkout={checkout}
        project={{ serverId: 'home', projectKey: 'project' }}
        launchers={{
          testIdPrefix: 'project-header',
          showWorktreesButton: true,
          onOpenWorktrees: () => {},
        }}
      />,
    );
    try {
      expect(
        screen.findHostByTestId('project-phone-checkout')?.props
          .accessibilityLabel,
      ).toBe('NLDW3-5-36-33 · 58f6');
      expect(
        screen.findAllHostsByTestId('project-header-open-worktrees'),
      ).toHaveLength(1);
      expect(screen.root.findAllByType(LookPopover)).toHaveLength(0);
      const menu = screen.root
        .findAllByType(DropdownMenu)
        .find((candidate) =>
          candidate.props.items.some(
            (item: { title: string }) =>
              item.title === t('settingsAppearance.glassControls.look'),
          ),
        );
      expect(menu).toBeDefined();
      const look = menu!.props.items.find(
        (item: { title: string }) =>
          item.title === t('settingsAppearance.glassControls.look'),
      );
      await React.act(async () => {
        await menu!.props.onSelect(look.id);
      });
      expect(screen.root.findAllByType(LookPopover)).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it('carries New session on the bar, so a phone can open the Project-launched composer', async () => {
    const onNewSession = vi.fn();
    const screen = await renderScreen(
      <ProjectPhoneHeadView
        checkout={checkout}
        project={{ serverId: 'home', projectKey: 'project' }}
        launchers={{ testIdPrefix: 'project-header', showWorktreesButton: false }}
        onNewSession={onNewSession}
      />,
    );
    try {
      const add = screen.findHostByTestId('project-header-new-session');
      expect(add?.props.accessibilityLabel).toBe(t('projects.open.newSession'));
      await React.act(async () => {
        add!.props.onPress();
      });
      expect(onNewSession).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it('carries Activity on the bar while background work is running, as the wide title strip does', async () => {
    actionOperationStore.mergeSnapshots({
      serverId: 'server-1',
      snapshots: [{
        version: 1,
        operationId: 'operation-1',
        revision: 1,
        actionId: 'session.fork',
        state: 'running',
        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
        title: 'Fork session',
        createdAt: 100,
        startedAt: 110,
        cancellation: 'unsupported',
      }],
    });
    const screen = await renderScreen(
      <ProjectPhoneHeadView
        checkout={checkout}
        project={{ serverId: 'home', projectKey: 'project' }}
        launchers={{ testIdPrefix: 'project-header', showWorktreesButton: false }}
      />,
    );
    try {
      expect(screen.findHostByTestId('project-phone-head.activity')).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
