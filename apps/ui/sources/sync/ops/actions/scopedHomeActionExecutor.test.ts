import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
await import('./defaultActionExecutor');
const { scopedHomeActionExecutor, resetScopedHomeActionExecutorsForTests } = await import('./scopedHomeActionExecutor');

beforeEach(async () => { await home.reset(); resetScopedHomeActionExecutorsForTests(); });
afterEach(async () => { standardCleanup(); await home.reset(); resetScopedHomeActionExecutorsForTests(); });

async function expectStaleAccountRefusal(actionId: ActionId, path: string, input: unknown): Promise<void> {
    const serverId = await home.addHome({ name: 'Scoped Home', serverUrl: 'https://native-action-scope.test',
        accountId: 'account-a', currentAccount: true, teamsEnabled: true });
    home.answer(serverId, 'GET /v1/artifacts', { body: { items: [], hasUnclassified: false,
        coverage: { status: 'complete', unclassifiedCount: 0 } } });
    home.answer(serverId, 'GET /v1/discussions', { body: { discussions: [], nextCursor: null } });
    const oldAccount = scopedHomeActionExecutor({ serverId, accountId: 'account-a' });
    const context = { surface: 'ui', authority: 'present_user', serverId } as const;
    expect((await oldAccount(actionId, input, context)).ok).toBe(true);
    await home.switchAccount(serverId, 'account-b', { currentAccount: true });
    const currentAccount = scopedHomeActionExecutor({ serverId, accountId: 'account-b' });
    expect((await currentAccount(actionId, input, context)).ok).toBe(true);
    const reads = () => home.requests.filter(request => request.path.split('?')[0] === path);
    expect(reads()).toHaveLength(2);

    const stale = await oldAccount(actionId, input, context);
    expect(reads()).toHaveLength(2);
    expect(stale).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(await oldAccount.confirmed(actionId, input, context)).toMatchObject({
        ok: false, errorCode: 'action_account_scope_changed',
    });
    expect(await oldAccount.prepare(actionId, input, context)).toMatchObject({
        kind: 'settled', result: { ok: false, errorCode: 'action_account_scope_changed' },
    });
    expect(reads()).toHaveLength(2);
}

it('keeps a retained Artifact front door bound to its captured Account after a Home switches Accounts', async () => {
    await expectStaleAccountRefusal('artifact.list', '/v1/artifacts', { sharedWithTeamId: 'team-a' });
});

it('keeps a retained Discussion front door bound to its captured Account after a Home switches Accounts', async () => {
    await expectStaleAccountRefusal('discussion.list', '/v1/discussions', { sharedWithTeamId: 'team-a' });
});
