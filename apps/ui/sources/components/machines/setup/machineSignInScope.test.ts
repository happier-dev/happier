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

const { reviewMachineSignInLaunch } = await import('./machineSignInScope');
const { t } = await import('@/text');

/** GitHub CLI's prepared launch, reviewed the way the start sequence hands it over. */
function reviewGh(
  prepared: Parameters<ReturnType<typeof reviewMachineSignInLaunch>>[0],
  options: Readonly<{ account?: string; hostUser?: string | null; onLaunch?: () => void }> = {},
) {
  return reviewMachineSignInLaunch({ tool: 'GitHub CLI', account: options.account ?? 'GitHub', machine: 'devbox',
    hostUser: options.hostUser === undefined ? 'happier' : options.hostUser,
    ...(options.onLaunch ? { onLaunch: options.onLaunch } : {}) })(prepared);
}

describe('machine CLI sign-in scope (S4)', () => {
  beforeEach(() => {
    modalSpies.confirm.mockClear();
  });

  it('warns that everyone using the shared host user will use the account, and launches nothing when declined', async () => {
    modalSpies.confirm.mockResolvedValueOnce(false);
    const onLaunch = vi.fn();
    expect(await reviewGh({ signInScope: 'machineOwner', confirmationRequired: true }, { onLaunch })).toBe(false);
    expect(onLaunch).not.toHaveBeenCalled();
    expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
    const [title, message] = modalSpies.confirm.mock.calls[0]!;
    // The CLI is what signs in; the account it uses is the service the CLI declares.
    expect(title).toBe(t('machinePresets.setup.tab.signInConfirmTitle', { machine: 'devbox', tool: 'GitHub CLI' }));
    expect(message).toBe(t('machinePresets.setup.tab.signInSharedUser', { user: 'happier', account: 'GitHub' }));
  });

  it('still warns when the Machine did not publish its user, and for a shared agent user', async () => {
    await reviewGh({ signInScope: 'machineOwner', confirmationRequired: true }, { hostUser: null });
    await reviewGh({ signInScope: 'sharedAgent', confirmationRequired: true });
    expect(modalSpies.confirm.mock.calls.map(([, message]) => message)).toEqual(
      Array(2).fill(t('machinePresets.setup.tab.signInSharedUserUnnamed', { account: 'GitHub' })),
    );
  });

  it("launches at once when the sign-in goes into the requester's own OS user", async () => {
    const onLaunch = vi.fn();
    expect(await reviewGh({ signInScope: 'member', confirmationRequired: false }, { onLaunch })).toBe(true);
    expect(await reviewGh({ confirmationRequired: false }, { onLaunch })).toBe(true);
    expect(modalSpies.confirm).not.toHaveBeenCalled();
    expect(onLaunch).toHaveBeenCalledTimes(2);
  });
});
