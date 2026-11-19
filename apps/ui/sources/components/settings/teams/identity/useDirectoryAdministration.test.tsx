import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamDirectorySourceRemovalPreflightV1Schema, TeamDirectorySourceSummaryV1Schema, type TeamDirectorySourceSummaryV1 } from '@happier-dev/protocol/teams';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeferred, teamIdentityConnectionFixture } from '@/dev/testkit';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });

// Keep the real Actions policy, response parser and hook
// state transitions. Only the Home network and device credential store change.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useActionApprovalContinuation } = await import('@/components/approvals/useActionApprovalContinuation');
const { serverAccountScopedTeamKey, serverAccountScopedTeamResourceKey } = await import('@/sync/domains/teams/teamAddress');
const { useDirectoryAdministration, useDirectorySourceAdministration } = await import('./useDirectoryAdministration');
const { useIdentityAdministration } = await import('./useIdentityAdministration');
const { useDirectoryPeopleList } = await import('./DirectoryPeopleList');

const ACCOUNT_ID = 'account-directory';
const LIST_PATH = '/v1/teams/team-1/directory-sources';
const SOURCE_PATH = `${LIST_PATH}/source-1`;
const PREVIEW_PATH = `${SOURCE_PATH}/removal-impact`;
const onExecuted = () => undefined;

function directorySource(id: string, teamId = 'team-1'): TeamDirectorySourceSummaryV1 {
    return TeamDirectorySourceSummaryV1Schema.parse({
        v: 1,
        id,
        teamId,
        kind: 'workos_directory',
        displayName: id,
        state: 'active',
        allowedActions: ['teams.directory.sources.remove'],
        sync: {
            mode: 'events_and_full',
            attempt: 'succeeded',
            freshness: 'fresh',
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastFullReconcileAt: null,
            nextScheduledAt: null,
        },
        error: null,
    });
}

const removalImpact = TeamDirectorySourceRemovalPreflightV1Schema.parse({
    v: 1,
    status: 'allowed',
    sourceId: 'source-1',
    sourceLabel: 'Directory One',
    impact: {
        teamMembershipsRemoved: 2,
        groupMembershipsRemoved: 3,
        groupContributionsRemoved: 4,
        directoryCreatedGroupsRetained: 1,
        nativeMembershipsPreserved: 5,
        nativeGroupContributionsPreserved: 6,
    },
});

async function addHome(): Promise<ServerAccountScope> {
    const serverId = await harness.addHome({
        name: 'Directory Home',
        serverUrl: 'https://directory-read-approval.example',
        accountId: ACCOUNT_ID,
        teamsEnabled: true,
    });
    return { serverId, accountId: ACCOUNT_ID };
}

async function renderList(scope: ServerAccountScope) {
    return await renderHook((props: { scope: ServerAccountScope; teamId: string }) => {
        const approval = useActionApprovalContinuation({
            serverId: props.scope.serverId,
            scopeKey: serverAccountScopedTeamKey(props.scope, { serverId: props.scope.serverId, teamId: props.teamId }),
            onExecuted,
        });
        const directory = useDirectoryAdministration(props.scope, props.teamId, true, approval.requestApproval);
        return { approval, directory };
    }, { initialProps: { scope, teamId: 'team-1' } });
}

async function renderSource(scope: ServerAccountScope) {
    return await renderHook((props: { sourceId: string }) => {
        const approval = useActionApprovalContinuation({
            serverId: scope.serverId,
            scopeKey: serverAccountScopedTeamResourceKey(scope, { serverId: scope.serverId, teamId: 'team-1' }, 'directory-source', props.sourceId),
            onExecuted,
        });
        const directory = useDirectorySourceAdministration(scope, 'team-1', props.sourceId, approval.requestApproval);
        return { approval, directory };
    }, { initialProps: { sourceId: 'source-1' } });
}

describe('mounted directory reads with local Ask confirmation', () => {
    beforeEach(async () => {
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
        standardCleanup();
        await harness.reset();
    });
    afterEach(() => standardCleanup());

    it.each(['connections', 'directory'] as const)('keeps observed %s visible until the returning Home read settles', async (kind) => {
        const scope = await addHome();
        const id = kind === 'connections' ? 'connection-1' : 'source-1';
        const path = kind === 'connections' ? '/v1/teams/identity/connections/list' : LIST_PATH;
        const useProjection = kind === 'connections' ? useIdentityAdministration : useDirectoryAdministration;
        const body = kind === 'connections'
            ? {
                items: [teamIdentityConnectionFixture({ id })], eligibleProviders: [], memberSignInUrl: null,
                admissionModeApplicability: {
                    v: 1,
                    modes: {
                        invite_only: { status: 'available' },
                        provisioned: { status: 'unavailable', reason: 'directory_source_required' },
                        jit: { status: 'unavailable', reason: 'team_connection_required' },
                    },
                },
            }
            : { items: [directorySource(id)], nextCursor: null };
        harness.answer(scope.serverId, path, { body });
        const initial = await renderHook(() => useProjection(scope, 'team-1'));
        await waitForHomeGovernance(() => expect(initial.getCurrent().state).toMatchObject({
            kind: 'ready', items: [{ id }], refreshing: false,
        }));
        await initial.unmount();

        const fresh = createDeferred<void>();
        harness.answer(scope.serverId, path, { status: 403, respondAfter: fresh.promise });
        const returning = await renderHook(() => useProjection(scope, 'team-1'));
        expect(returning.getCurrent().state).toMatchObject({ kind: 'ready', items: [{ id }], refreshing: true });
        await act(async () => fresh.resolve());
        await waitForHomeGovernance(() => expect(returning.getCurrent().state.kind).toBe('unavailable'));
        await returning.unmount();
    });

    it('confirms source and continuation reads locally without replaying either read', async () => {
        const scope = await addHome();
        await harness.requireUiApproval(scope.serverId, 'teams.directory.sources.list');
        harness.answer(scope.serverId, LIST_PATH, { body: { items: [directorySource('source-1')], nextCursor: 'page-2' } });
        harness.answer(scope.serverId, `${LIST_PATH}?cursor=page-2`, { body: { items: [directorySource('source-2')], nextCursor: null } });
        const hook = await renderList(scope);
        await waitForHomeGovernance(() => expect(hook.getCurrent().directory.state).toMatchObject({
            kind: 'ready', items: [{ id: 'source-1' }], nextCursor: 'page-2',
        }));
        await act(async () => { await hook.getCurrent().directory.loadMore(); });

        expect(hook.getCurrent().directory.state).toMatchObject({
            kind: 'ready', items: [{ id: 'source-1' }, { id: 'source-2' }], nextCursor: null, loadingMore: false,
        });
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(1);
        expect(harness.requestsFor(`${LIST_PATH}?cursor=page-2`)).toHaveLength(1);
        await hook.rerender();
        expect(harness.artifacts(scope.serverId).list()).toHaveLength(0);
    });

    it('sends no declined Ask read and completes a locally confirmed retry', async () => {
        const scope = await addHome();
        await harness.requireUiApproval(scope.serverId, 'teams.directory.sources.list');
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        harness.answer(scope.serverId, LIST_PATH, { body: { items: [], nextCursor: null } });
        const hook = await renderList(scope);
        await waitForHomeGovernance(() => expect(hook.getCurrent().directory.state).toMatchObject({
            kind: 'unavailable', failure: { code: 'approval_canceled' },
        }));
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(0);

        await act(async () => hook.getCurrent().directory.refresh());
        await waitForHomeGovernance(() => expect(hook.getCurrent().directory.state).toMatchObject({ kind: 'ready', items: [] }));
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(1);
        expect(harness.artifacts(scope.serverId).list()).toHaveLength(0);
    });

    it('ignores an old Team read whose local confirmation settles after the mounted scope changes', async () => {
        const scope = await addHome();
        await harness.requireUiApproval(scope.serverId, 'teams.directory.sources.list');
        const { Modal } = await import('@/modal');
        let confirmOldRead!: (accepted: boolean) => void;
        vi.mocked(Modal.confirm).mockImplementationOnce(() => new Promise(resolve => { confirmOldRead = resolve; }));
        harness.answer(scope.serverId, LIST_PATH, { body: { items: [directorySource('source-old')], nextCursor: null } });
        harness.answer(scope.serverId, '/v1/teams/team-2/directory-sources', { body: { items: [directorySource('source-new', 'team-2')], nextCursor: null } });
        const hook = await renderList(scope);
        await waitForHomeGovernance(() => expect(Modal.confirm).toHaveBeenCalledOnce());
        await hook.rerender({ scope, teamId: 'team-2' });
        await waitForHomeGovernance(() => expect(hook.getCurrent().directory.state).toMatchObject({ kind: 'ready', items: [{ id: 'source-new' }] }));
        await act(async () => confirmOldRead(true));
        expect(hook.getCurrent().directory.state).toMatchObject({ kind: 'ready', items: [{ id: 'source-new' }] });
    });

    it('confirms source and removal preview locally and cancels the pending preview on unmount', async () => {
        const scope = await addHome();
        await harness.requireUiApproval(scope.serverId, 'teams.directory.sources.get');
        harness.answer(scope.serverId, SOURCE_PATH, { body: directorySource('source-1') });
        harness.answer(scope.serverId, PREVIEW_PATH, { body: removalImpact });
        const hook = await renderSource(scope);
        await waitForHomeGovernance(() => expect(hook.getCurrent().directory.state).toMatchObject({ kind: 'ready', item: { id: 'source-1' } }));
        await act(async () => { await harness.requireUiApproval(scope.serverId, 'teams.directory.sources.remove.preview'); });

        let preview!: ReturnType<ReturnType<typeof hook.getCurrent>['directory']['readRemovalImpact']>;
        await act(async () => { preview = hook.getCurrent().directory.readRemovalImpact(); });
        await act(async () => { await expect(preview).resolves.toEqual({ ok: true, value: removalImpact }); });
        expect(hook.getCurrent().directory.pendingAction).toBeNull();
        expect(harness.requestsFor(SOURCE_PATH)).toHaveLength(1);
        expect(harness.requestsFor(PREVIEW_PATH)).toHaveLength(1);

        const { Modal } = await import('@/modal');
        let confirmPreview!: (accepted: boolean) => void;
        vi.mocked(Modal.confirm).mockClear().mockImplementationOnce(() => new Promise(resolve => { confirmPreview = resolve; }));
        await act(async () => { preview = hook.getCurrent().directory.readRemovalImpact(); });
        await waitForHomeGovernance(() => expect(Modal.confirm).toHaveBeenCalledOnce());
        await hook.unmount();
        await act(async () => confirmPreview(true));
        await expect(preview).resolves.toMatchObject({ ok: false, failure: { code: 'aborted' } });
        expect(harness.requestsFor(PREVIEW_PATH)).toHaveLength(1);
        expect(harness.artifacts(scope.serverId).list()).toHaveLength(0);
    });

    it('withdraws loaded people when a locally confirmed continuation read loses Home authority', async () => {
        const scope = await addHome();
        const peoplePath = `${SOURCE_PATH}/people?limit=50`;
        harness.answer(scope.serverId, peoplePath, { body: {
            items: [{
                v: 1, id: 'person-1', sourceId: 'source-1', externalUserId: 'external-1',
                displayName: 'Ada', email: null, externalLogin: null, state: 'active',
                accountBinding: { state: 'unbound' }, sourceLabel: 'Directory One',
            }],
            nextCursor: 'next-people',
        } });
        const address = { serverId: scope.serverId, teamId: 'team-1' };
        const hook = await renderHook(() => {
            const approval = useActionApprovalContinuation({
                serverId: scope.serverId,
                scopeKey: serverAccountScopedTeamKey(scope, address),
                onExecuted,
            });
            const people = useDirectoryPeopleList({ scope, address, sourceId: 'source-1', requestApproval: approval.requestApproval });
            return { approval, people };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().people.rows).toMatchObject([{ id: 'person-1' }]));
        await act(async () => { await harness.requireUiApproval(scope.serverId, 'teams.directory.people.list'); });
        const continuationPath = `${peoplePath}&cursor=next-people`;
        harness.answer(scope.serverId, continuationPath, { status: 403, body: { error: 'forbidden' } });
        let loadMore!: Promise<void>;
        await act(async () => { loadMore = hook.getCurrent().people.loadMore(); });
        await act(async () => { await loadMore; });

        expect(hook.getCurrent().people).toMatchObject({ rows: [], status: 'error', hasMore: false, error: { kind: 'forbidden', retryable: false } });
        expect(harness.requestsFor(peoplePath)).toHaveLength(1);
        expect(harness.requestsFor(continuationPath)).toHaveLength(1);
    });
});
