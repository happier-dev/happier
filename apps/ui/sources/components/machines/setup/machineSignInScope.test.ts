import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IModal } from '@/modal/types';
import type { MachineCliSignInRow } from '@/agents/machineAgents/signIn/useAgentSignIn';

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

type Scope = NonNullable<NonNullable<MachineCliSignInRow['authentication']>['signInScope']>;

function gh(signInScope: Scope, connected = true): Pick<MachineCliSignInRow, 'title' | 'authentication'> {
  return {
    title: 'GitHub CLI',
    authentication: {
      installed: true,
      status: 'signedOut',
      nativeLogin: 'login_terminal',
      connectedServices: connected
        ? [{ serviceId: 'happier.scm.forge.github/github-account', title: 'GitHub' }]
        : [],
      signInScope,
    },
  };
}

describe('machine CLI sign-in scope (S4)', () => {
  beforeEach(() => {
    modalSpies.confirm.mockClear();
  });

  it('warns a Manage requester that everyone using the shared host user will use their account, before anything starts', async () => {
    modalSpies.confirm.mockResolvedValueOnce(false);
    const started = await confirmMachineSignInScope({ row: gh('machineOwner'), machine: 'devbox', hostUser: 'happier' });
    expect(started).toBe(false);
    expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
    const [title, message] = modalSpies.confirm.mock.calls[0]!;
    // The CLI is what signs in; the account it uses is the service the CLI declares.
    expect(title).toBe(t('machinePresets.setup.tab.signInConfirmTitle', { machine: 'devbox', tool: 'GitHub CLI' }));
    expect(message).toBe(t('machinePresets.setup.tab.signInSharedUser', { user: 'happier', account: 'GitHub' }));
  });

  it('names the CLI as the account when it declares no connected service', async () => {
    await confirmMachineSignInScope({ row: gh('machineOwner', false), machine: 'devbox', hostUser: 'happier' });
    expect(modalSpies.confirm.mock.calls[0]![1]).toBe(
      t('machinePresets.setup.tab.signInSharedUser', { user: 'happier', account: 'GitHub CLI' }),
    );
  });

  it('still warns when the Machine did not publish its user, and for a shared agent user', async () => {
    await confirmMachineSignInScope({ row: gh('machineOwner'), machine: 'devbox', hostUser: null });
    await confirmMachineSignInScope({ row: gh('sharedAgent'), machine: 'devbox', hostUser: 'happier' });
    expect(modalSpies.confirm.mock.calls.map(([, message]) => message)).toEqual(
      Array(2).fill(t('machinePresets.setup.tab.signInSharedUserUnnamed', { account: 'GitHub' })),
    );
  });

  it("starts at once when the sign-in goes into the requester's own OS user", async () => {
    expect(await confirmMachineSignInScope({ row: gh('member'), machine: 'devbox', hostUser: 'happier' })).toBe(true);
    expect(modalSpies.confirm).not.toHaveBeenCalled();
  });
});
