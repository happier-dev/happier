import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { workflowSessionOptionRow } from './workflowSessionOptionRow';

describe('workflowSessionOptionRow', () => {
  // Every Session chooser leads with the mark the Sessions list draws: the catalog identity read on the
  // Session's Machine, which also knows Agents that Machine contributes (Muse has no bundled artwork).
  it('draws the Session list mark from its Agent and Machine', async () => {
    const row = workflowSessionOptionRow({
      sessionId: 's1',
      machineId: 'machine-a',
      label: 'Fix the relay',
      agentId: 'muse',
    });
    const screen = await renderScreen(<>{row.icon}</>);
    try {
      const mark = screen.tree.root.findByType(SessionAgentCatalogIdentityIcon);
      expect(mark.props).toMatchObject({
        agentId: 'muse',
        machineId: 'machine-a',
      });
    } finally {
      await screen.unmount();
    }
  });
});
