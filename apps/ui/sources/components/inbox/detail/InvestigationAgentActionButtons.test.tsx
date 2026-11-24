import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentActionButton } from '@happier-dev/plugin-ui/components';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';

import { InvestigationAgentActionButtons } from './InvestigationAgentActionButtons';

afterEach(standardCleanup);

it('R15-D7: several configured actions are one control; the others launch from its menu in their own mode', async () => {
  const onLaunch = vi.fn();
  const screen = await renderScreen(
    <InvestigationAgentActionButtons
      actions={[
        {
          actionId: 'investigate',
          label: 'Investigate',
          launchMode: 'start',
          startable: true,
        },
        {
          actionId: 'fix',
          label: 'Fix this deploy',
          launchMode: 'review',
          startable: true,
        },
      ]}
      pending={false}
      compact={false}
      onLaunch={onLaunch}
    />,
  );
  try {
    const buttons = screen.findAllByType(AgentActionButton);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.props.title).toBe('Investigate');
    const items =
      buttons[0]!.props.groups?.flatMap(
        (group: { items: readonly { id: string; label: string }[] }) =>
          group.items,
      ) ?? [];
    expect(items.map((item: { label: string }) => item.label)).toEqual([
      'Fix this deploy',
    ]);
    await act(async () => {
      buttons[0]!.props.onSelectDestination?.(items[0]!.id);
    });
    expect(onLaunch).toHaveBeenCalledWith('review', 'fix');
  } finally {
    await screen.unmount();
  }
});
