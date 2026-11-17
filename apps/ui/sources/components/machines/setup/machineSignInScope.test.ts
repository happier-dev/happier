import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IModal } from '@/modal/types';

const modalSpies = vi.hoisted(() => ({
  confirm: vi.fn<IModal['confirm']>(async () => true),
}));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: { confirm: modalSpies.confirm } })
    .module;
});

const { confirmMachineSignInScope } = await import('./machineSignInScope');
const { t } = await import('@/text');

describe('machine CLI sign-in scope (S4)', () => {
  beforeEach(() => {
    modalSpies.confirm.mockClear();
  });

  it('warns a Manage requester that everyone using the shared host user will use their account, before anything starts', async () => {
    modalSpies.confirm.mockResolvedValueOnce(false);
    const started = await confirmMachineSignInScope({
      scope: 'machineOwner',
      tool: 'GitHub CLI',
      machine: 'devbox',
      hostUser: 'happier',
    });
    expect(started).toBe(false);
    expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
    const [, message] = modalSpies.confirm.mock.calls[0]!;
    expect(message).toBe(t('machinePresets.setup.tab.signInSharedUser', { user: 'happier', tool: 'GitHub CLI' }));
  });

  it('still warns when the Machine did not publish its user, and for a shared agent user', async () => {
    await confirmMachineSignInScope({
      scope: 'machineOwner',
      tool: 'GitHub CLI',
      machine: 'devbox',
      hostUser: null,
    });
    await confirmMachineSignInScope({
      scope: 'sharedAgent',
      tool: 'GitHub CLI',
      machine: 'devbox',
      hostUser: 'happier',
    });
    expect(modalSpies.confirm.mock.calls.map(([, message]) => message)).toEqual(
      Array(2).fill(t('machinePresets.setup.tab.signInSharedUserUnnamed', { tool: 'GitHub CLI' })),
    );
  });

  it("starts at once when the sign-in goes into the requester's own OS user", async () => {
    expect(
      await confirmMachineSignInScope({
        scope: 'member',
        tool: 'GitHub CLI',
        machine: 'devbox',
        hostUser: 'happier',
      }),
    ).toBe(true);
    expect(modalSpies.confirm).not.toHaveBeenCalled();
  });
});
