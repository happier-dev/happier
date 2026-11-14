import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { listTeamGroups } from '@/sync/ops/teams/teamGroupOperations';
import { runTeamAction } from '@/sync/ops/teams/teamActionClient';
import { searchSessionAccessAccountPage } from '@/sync/api/session/sessionAccessApi';
import { useTeamGroups } from '@/hooks/teams/useTeamGroups';
import { useTeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';

import type { SessionAccessCandidateRowModel, SessionAccessGrantOperationModel } from './sessionAccessEditorTypes';
import { useSessionAccessDirectory, type SessionAccessDirectory } from './useSessionAccessDirectory';

vi.mock('@/sync/api/session/sessionAccessApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/api/session/sessionAccessApi')>(),
    searchSessionAccessAccountPage: vi.fn(),
}));
vi.mock('@/sync/ops/teams/teamActionClient', () => ({ runTeamAction: vi.fn() }));
vi.mock('@/sync/ops/teams/teamGroupOperations', () => ({ listTeamGroups: vi.fn() }));
vi.mock('@/hooks/teams/useTeamGroups', () => ({ useTeamGroups: vi.fn(() => ({
    rows: [], status: 'ready', error: null, hasMore: false, loadMore: vi.fn(), reload: vi.fn(), isCurrent: true,
})) }));
vi.mock('@/hooks/teams/useTeamMembersRoster', () => ({ useTeamMembersRoster: vi.fn(() => ({
    rows: [], status: 'ready', error: null, hasMore: false, loadMore: vi.fn(), reload: vi.fn(),
})) }));

const scope = { serverId: 'home-one', accountId: 'owner' };

const NO_OPERATIONS: Readonly<Record<string, SessionAccessGrantOperationModel>> = {};

function Probe(props: Readonly<{
    onValue: (value: SessionAccessDirectory) => void;
    operations?: Readonly<Record<string, SessionAccessGrantOperationModel>>;
    teamId?: string;
}>) {
    const value = useSessionAccessDirectory({
        scope,
        availability: 'available',
        contextTeams: [],
        operations: props.operations ?? NO_OPERATIONS,
        revision: 1,
        enabled: true,
        ...(props.teamId ? { teamAddress: { serverId: scope.serverId, teamId: props.teamId } } : {}),
    });
    props.onValue(value);
    return null;
}

function accountRow(index: number) {
    return {
        kind: 'account' as const,
        accountId: `account-${index}`,
        name: null,
        username: `candidate_${String(index).padStart(2, '0')}`,
        firstName: null,
        lastName: null,
        avatarUrl: null,
    };
}

function team(id: string) {
    return {
        id,
        name: id,
        policy: { sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed' },
    };
}

function group(teamId: string, id: string) {
    return {
        id,
        teamId,
        name: { kind: 'available' as const, label: { content: { t: 'plain' as const, v: id }, recipientEnvelope: null } },
    };
}

function membership(id: string, accountId: string, firstName: string, status: 'active' | 'suspended') {
    return {
        v: 1, id, teamId: 'team-a', accountId,
        account: { accountId, name: firstName, firstName, lastName: null, username: null, avatarUrl: null },
        role: 'member', status, historyAccess: 'from_join', management: { kind: 'native' },
        capabilities: {}, joinedAt: 1,
    };
}

describe('useSessionAccessDirectory', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps the Account search cursor and reaches the eleventh matching Account', async () => {
        vi.mocked(runTeamAction).mockResolvedValue({ kind: 'succeeded', value: { items: [], nextCursor: null } } as never);
        vi.mocked(searchSessionAccessAccountPage)
            .mockResolvedValueOnce({ rows: Array.from({ length: 10 }, (_, index) => accountRow(index)), nextCursor: 'account-page-2' })
            .mockResolvedValueOnce({ rows: [accountRow(10)], nextCursor: null });

        let latest!: SessionAccessDirectory;
        await renderScreen(<Probe onValue={(value) => { latest = value; }} />);
        const firstSource = latest.sections.find((section) => section.kind === 'account')!;
        await act(async () => { await firstSource.resolveCandidates!('candidate_', new AbortController().signal); });

        await vi.waitFor(() => expect(latest.sections.find((section) => section.kind === 'account'))
            .toMatchObject({ cursor: 'account-page-2', hasMore: true }));
        await act(async () => { latest.loadMore('account'); });
        await vi.waitFor(() => expect(searchSessionAccessAccountPage).toHaveBeenLastCalledWith(expect.objectContaining({
            query: 'candidate_', cursor: 'account-page-2',
        })));
        await vi.waitFor(() => expect(latest.sections.find((section) => section.kind === 'account'))
            .toMatchObject({ loadingMore: false, hasMore: false }));

        const finalSource = latest.sections.find((section) => section.kind === 'account')!;
        const rows = await finalSource.resolveCandidates!('candidate_', new AbortController().signal);
        expect(rows.map((row) => row.principal.ref)).toContainEqual({ kind: 'account', accountId: 'account-10' });
        expect(rows).toHaveLength(11);
        expect(finalSource.hasMore).toBe(false);
    });

    it('republishes a candidate row with the current add operation while the query is retained', async () => {
        vi.mocked(runTeamAction).mockResolvedValue({ kind: 'succeeded', value: { items: [], nextCursor: null } } as never);
        vi.mocked(searchSessionAccessAccountPage)
            .mockResolvedValue({ rows: [accountRow(0), accountRow(1)], nextCursor: null } as never);

        let latest!: SessionAccessDirectory;
        const screen = await renderScreen(<Probe onValue={(value) => { latest = value; }} />);
        const idleSource = latest.sections.find((section) => section.kind === 'account')!;
        let idleRows: readonly SessionAccessCandidateRowModel[] = [];
        await act(async () => {
            idleRows = await idleSource.resolveCandidates!('candidate_', new AbortController().signal);
        });
        expect(idleRows.map((row) => row.operation.kind)).toEqual(['idle', 'idle']);
        const settledSource = latest.sections.find((section) => section.kind === 'account')!;

        // The owner dispatches the add keyed by subject before any grant row exists,
        // so the pending state can only reach the user through this candidate row.
        await screen.update(<Probe onValue={(value) => { latest = value; }}
            operations={{ 'account:account-0': { kind: 'saving' } }} />);
        const pendingSource = latest.sections.find((section) => section.kind === 'account')!;
        // The list only re-resolves a dynamic section when its resolver key changes,
        // and the operation is the only thing that changed since the settled page.
        expect(pendingSource.resolverKey).not.toBe(settledSource.resolverKey);
        const pendingRows = await pendingSource.resolveCandidates!('candidate_', new AbortController().signal);
        expect(searchSessionAccessAccountPage).toHaveBeenCalledTimes(1);
        expect(pendingRows[0]?.operation).toEqual({ kind: 'saving' });
        // An unaffected candidate keeps its identity so the list does not rebuild it.
        expect(pendingRows[1]).toBe(idleRows[1]);
    });

    it('keeps usable Groups when one Team fails, then retries that Team and loads another Group page', async () => {
        vi.mocked(runTeamAction).mockResolvedValue({
            kind: 'succeeded', value: { items: [team('team-a'), team('team-b')], nextCursor: null },
        } as never);
        vi.mocked(listTeamGroups).mockImplementation(async ({ address, cursor }) => {
            if (address.teamId === 'team-a' && !cursor) {
                return { kind: 'succeeded', value: { items: [group('team-a', 'group-a1')], nextCursor: 'groups-a-2' } } as never;
            }
            if (address.teamId === 'team-a' && cursor === 'groups-a-2') {
                return { kind: 'succeeded', value: { items: [group('team-a', 'group-a2')], nextCursor: null } } as never;
            }
            const priorTeamBCalls = vi.mocked(listTeamGroups).mock.calls.filter(([input]) => input.address.teamId === 'team-b').length;
            if (priorTeamBCalls === 1) {
                return { kind: 'failed', failure: { kind: 'unreachable', retryable: true, code: null } } as never;
            }
            return { kind: 'succeeded', value: { items: [group('team-b', 'group-b1')], nextCursor: null } } as never;
        });

        let latest!: SessionAccessDirectory;
        await renderScreen(<Probe onValue={(value) => { latest = value; }} />);
        await vi.waitFor(() => expect(latest.teamDirectoryStatus).toBe('ready'));
        const source = latest.sections.find((section) => section.kind === 'group')!;
        let partial: readonly SessionAccessCandidateRowModel[] = [];
        await act(async () => {
            partial = await source.resolveCandidates!('', new AbortController().signal);
        });
        expect(partial.map((row) => row.principal.ref)).toContainEqual({ kind: 'group', teamId: 'team-a', groupId: 'group-a1' });
        await vi.waitFor(() => expect(latest.sections.find((section) => section.kind === 'group'))
            .toMatchObject({ status: 'error', hasMore: true }));

        await act(async () => {
            latest.retry('group');
            await vi.waitFor(() => expect(listTeamGroups).toHaveBeenCalledWith(expect.objectContaining({
                address: { serverId: 'home-one', teamId: 'team-b' },
            })));
        });
        await vi.waitFor(() => expect(latest.sections.find((section) => section.kind === 'group'))
            .toMatchObject({ status: 'idle', hasMore: true }));

        await act(async () => {
            latest.loadMore('group');
            await vi.waitFor(() => expect(listTeamGroups).toHaveBeenCalledWith(expect.objectContaining({
                address: { serverId: 'home-one', teamId: 'team-a' }, cursor: 'groups-a-2',
            })));
        });
        await vi.waitFor(() => expect(latest.sections.find((section) => section.kind === 'group'))
            .toMatchObject({ loadingMore: false, hasMore: false }));
        const finalSource = latest.sections.find((section) => section.kind === 'group')!;
        const finalRows = await finalSource.resolveCandidates!('', new AbortController().signal);
        expect(finalRows.map((row) => row.principal.ref)).toEqual(expect.arrayContaining([
            { kind: 'group', teamId: 'team-a', groupId: 'group-a1' },
            { kind: 'group', teamId: 'team-a', groupId: 'group-a2' },
            { kind: 'group', teamId: 'team-b', groupId: 'group-b1' },
        ]));
        expect(finalSource.hasMore).toBe(false);
    });

    it('keeps a partial Team page and retries its exact continuation', async () => {
        vi.mocked(runTeamAction)
            .mockResolvedValueOnce({
                kind: 'succeeded', value: { items: [team('team-a')], nextCursor: 'teams-page-2' },
            } as never)
            .mockRejectedValueOnce(new Error('temporary Team directory failure'))
            .mockResolvedValueOnce({
                kind: 'succeeded', value: { items: [team('team-b')], nextCursor: null },
            } as never);

        let latest!: SessionAccessDirectory;
        await renderScreen(<Probe onValue={(value) => { latest = value; }} />);
        await vi.waitFor(() => expect(latest.teamDirectoryStatus).toBe('ready'));

        await act(async () => {
            latest.loadMore('team');
            await vi.waitFor(() => expect(runTeamAction).toHaveBeenCalledTimes(2));
        });
        await vi.waitFor(() => expect(latest.sections.find((section) => section.kind === 'team'))
            .toMatchObject({ status: 'error', cursor: 'teams-page-2', hasMore: true }));
        const partialSource = latest.sections.find((section) => section.kind === 'team')!;
        await expect(partialSource.resolveCandidates!('', new AbortController().signal))
            .resolves.toHaveLength(1);

        await act(async () => {
            latest.retry('team');
            await vi.waitFor(() => expect(runTeamAction).toHaveBeenLastCalledWith(expect.objectContaining({
                input: expect.objectContaining({ cursor: 'teams-page-2' }),
            })));
        });
        await vi.waitFor(() => expect(latest.sections.find((section) => section.kind === 'team'))
            .toMatchObject({ status: 'idle', cursor: null, hasMore: false }));
        const completeSource = latest.sections.find((section) => section.kind === 'team')!;
        await expect(completeSource.resolveCandidates!('', new AbortController().signal))
            .resolves.toHaveLength(2);
    });

    it('projects exact Team membership and Group identities through the canonical directory', async () => {
        const memberLoadMore = vi.fn();
        const groupRetry = vi.fn();
        vi.mocked(useTeamMembersRoster).mockReturnValue({
            rows: [{
                v: 1, id: 'membership-11', teamId: 'team-a', accountId: 'account-11',
                account: { accountId: 'account-11', name: 'Chosen Name', firstName: 'Beyond', lastName: 'Page', username: null, avatarUrl: null },
                role: 'member', status: 'active', historyAccess: 'from_join', management: { kind: 'native' },
                capabilities: {}, joinedAt: 1,
            }, {
                v: 1, id: 'membership-suspended', teamId: 'team-a', accountId: 'account-suspended',
                account: { accountId: 'account-suspended', name: 'Suspended', firstName: 'Suspended', lastName: null, username: null, avatarUrl: null },
                role: 'member', status: 'suspended', historyAccess: 'from_join', management: { kind: 'native' },
                capabilities: {}, joinedAt: 1,
            }],
            status: 'ready', error: null, hasMore: true, loadMore: memberLoadMore, reload: vi.fn(),
        } as never);
        vi.mocked(useTeamGroups).mockReturnValue({
            rows: [{ v: 1, id: 'group-7', teamId: 'team-a', name: {
                kind: 'available', label: { content: { t: 'plain', v: 'Platform' }, recipientEnvelope: null },
            }, memberCount: 3 }],
            status: 'error', error: { kind: 'unreachable', retryable: true, code: null }, hasMore: false,
            loadMore: vi.fn(), reload: groupRetry, isCurrent: false,
        } as never);

        let latest!: SessionAccessDirectory;
        await renderScreen(<Probe teamId="team-a" onValue={(value) => { latest = value; }} />);

        const people = latest.sections.find((section) => section.kind === 'account')!;
        const peopleRows = await people.resolveCandidates!('', new AbortController().signal);
        expect(peopleRows[0]).toMatchObject({
            principal: { ref: { kind: 'account', accountId: 'account-11' }, displayName: 'Chosen Name' },
            teamMembership: { teamId: 'team-a', teamMembershipId: 'membership-11', accountId: 'account-11' },
        });
        expect(peopleRows.map((row) => row.principal.ref)).not.toContainEqual({ kind: 'account', accountId: 'account-suspended' });
        expect(people.hasMore).toBe(true);
        latest.loadMore('account');
        expect(memberLoadMore).toHaveBeenCalledOnce();

        await vi.waitFor(async () => {
            const groupRows = await latest.sections.find((section) => section.kind === 'group')!
                .resolveCandidates!('', new AbortController().signal);
            expect(groupRows[0]).toMatchObject({
                principal: {
                    ref: { kind: 'group', teamId: 'team-a', groupId: 'group-7' },
                    displayName: 'Platform',
                },
                teamGroup: { teamId: 'team-a', teamGroupId: 'group-7' },
            });
        });
        const groups = latest.sections.find((section) => section.kind === 'group')!;
        expect(groups.status).toBe('error');
        latest.retry('group');
        expect(groupRetry).toHaveBeenCalledOnce();
        // An empty lookup is not a lookup: it leaves the roster on its unqueried sequence
        // instead of restarting it, so the pages already read still answer.
        expect(vi.mocked(useTeamMembersRoster).mock.calls.every(([params]) => !params.query)).toBe(true);
    });

    it('asks the Home for a Team member no loaded roster page contains', async () => {
        // Rows the Home answered with for this lookup. Nothing about them matches the typed
        // text locally, which is the point: the Home's matcher decides, not this editor.
        vi.mocked(useTeamMembersRoster).mockReturnValue({
            rows: [
                membership('membership-99', 'account-99', 'Beyond', 'active'),
                membership('membership-98', 'account-98', 'Beyond', 'suspended'),
            ],
            status: 'ready', error: null, hasMore: true, loadMore: vi.fn(), reload: vi.fn(),
        } as never);

        let latest!: SessionAccessDirectory;
        await renderScreen(<Probe teamId="team-a" onValue={(value) => { latest = value; }} />);

        const people = latest.sections.find((section) => section.kind === 'account')!;
        let rows: readonly SessionAccessCandidateRowModel[] = [];
        await act(async () => { rows = await people.resolveCandidates!('Seventh', new AbortController().signal); });

        await vi.waitFor(() => expect(useTeamMembersRoster).toHaveBeenLastCalledWith(expect.objectContaining({
            address: { serverId: 'home-one', teamId: 'team-a' },
            filter: 'all',
            query: 'Seventh',
        })));
        // A member outside the loaded pages is still found, and a suspended membership is
        // still not a collaboration principal.
        expect(rows.map((row) => row.principal.ref)).toEqual([{ kind: 'account', accountId: 'account-99' }]);
        expect(rows[0]).toMatchObject({
            teamMembership: { teamId: 'team-a', teamMembershipId: 'membership-99', accountId: 'account-99' },
        });
    });
});
