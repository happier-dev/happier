import { describe, expect, it } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

import { createMcpActionEnablement } from '@/mcp/server/createMcpActionEnablement';
import { createSessionActionSettingsView } from './actionsSettingsProvider';

describe('Session advertisement under an approval profile', () => {
  const account = normalizeActionsSettingsV1({
    v: 1,
    approvalProfiles: [
      {
        id: 'careful',
        name: 'Careful agent',
        actions: { 'session.list': { disabledSurfaces: ['agent'] } },
      },
    ],
    machineApprovalProfiles: { 'machine-a': 'careful' },
  });
  const provider = { getActionsSettings: () => account };

  it('hides an Action the Session profile turns Off, following Session > Machine > Account at each read', () => {
    let metadata: Record<string, unknown> = { machineId: 'machine-b' };
    const isEnabled = createMcpActionEnablement({
      surface: 'agent',
      actionSettingsProvider: createSessionActionSettingsView(
        provider,
        () => metadata,
      ),
    });
    expect(isEnabled('session.list')).toBe(true);
    metadata = { machineId: 'machine-a' };
    expect(isEnabled('session.list')).toBe(false);
    metadata = { machineId: 'machine-b', approvalProfileId: 'careful' };
    expect(isEnabled('session.list')).toBe(false);
    metadata = { machineId: 'machine-a', approvalProfileId: 'deleted' };
    expect(isEnabled('session.list')).toBe(true);
    // The Account view, used by approval routing and every non-Session caller, is unchanged.
    expect(
      createMcpActionEnablement({
        surface: 'agent',
        actionSettingsProvider: provider,
      })('session.list'),
    ).toBe(true);
  });

  it('reuses the merged policy across per-tool enablement reads until a fact changes', () => {
    const view = createSessionActionSettingsView(provider, () => ({
      machineId: 'machine-a',
    }));
    const first = view.getActionsSettings();
    expect(view.getActionsSettings()).toBe(first);
    expect(first).not.toBe(account);
  });
});
