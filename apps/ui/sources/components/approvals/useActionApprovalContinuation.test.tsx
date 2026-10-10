import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';

// Imported from their owning testkit modules, never the `@/dev/testkit` barrel:
// the harness installs its network boundaries with `vi.doMock`, which only
// reaches modules imported afterwards (see `installHomeGovernanceBoundaries`).
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createUiApprovalRequest, decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createActionApprovalContinuation, type ActionApprovalContinuation } from './actionApprovalContinuation';

/**
 * The shared result-custody owner, over the real approval lifecycle.
 *
 * Every approval here is one the product writes: a present-user Team rename
 * creates it through the shared Action front door, the Inbox decides it through
 * the generic executor, and the hook observes the outcome through the real
 * `useApprovalArtifact` reading the Home's stateful Artifact store. Only the
 * network and the device credential store are replaced; no terminal record is
 * assembled by the test.
 */

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useActionApprovalContinuation } = await import('./useActionApprovalContinuation');
const { createIdentityAdministrationClient } = await import('@/components/settings/teams/identity/identityAdministrationClient');
const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');

const ACCOUNT_ID = 'account-a';
const TEAM_UPDATE_PATH = '/v1/teams/update';

/** One Home whose Account explicitly requires approval for a Team rename. */
async function addApprovalHome(): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home One',
        serverUrl: 'https://approval-continuation.example',
        accountId: ACCOUNT_ID,
        teamsEnabled: true,
    });
    await harness.requireUiApproval(serverId, 'teams.update');
    return serverId;
}

async function openRenameApproval(serverId: string, requestId: string, name = 'Renamed'): Promise<string> {
    return await createUiApprovalRequest({
        serverId,
        actionId: 'teams.update',
        actionInput: { v: 1, teamId: 'team-1', name },
        actionRequestId: requestId,
    });
}

function answerRename(serverId: string): void {
    harness.answer(serverId, TEAM_UPDATE_PATH, {
        body: teamSummaryFixture({ name: 'Renamed', capabilities: teamCapabilitiesFixture({ manageSettings: true }) }),
    });
}

async function renderContinuation(serverId: string, onExecuted: () => void = vi.fn()) {
    return await renderHook(({ scopeKey }: { scopeKey: string }) => useActionApprovalContinuation({
        scopeKey,
        serverId,
        onExecuted,
    }), { initialProps: { scopeKey: `${serverId}:${ACCOUNT_ID}` } });
}

describe('useActionApprovalContinuation', () => {
    beforeEach(async () => {
        standardCleanup();
        await harness.reset();
    });

    afterEach(() => standardCleanup());

    it('claims and clears an executed result before delivering it exactly once', async () => {
        const serverId = await addApprovalHome();
        answerRename(serverId);
        const artifactId = await openRenameApproval(serverId, 'rename-executed');
        const refresh = vi.fn();
        const hook = await renderContinuation(serverId, refresh);
        const deliveryObservedCustody = vi.fn();
        const onExecuted = vi.fn<ActionApprovalContinuation['onExecuted']>(async (_artifact) => {
            deliveryObservedCustody(hook.getCurrent().approvalId);
            return 'consumed' as const;
        });

        act(() => hook.getCurrent().requestApproval({ artifactId, onExecuted }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().approvalStatus).toBe('open'));
        expect(hook.getCurrent().approvalPending).toBe(true);

        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });

        await waitForHomeGovernance(() => expect(onExecuted).toHaveBeenCalledTimes(1));
        expect(refresh).toHaveBeenCalledTimes(1);
        // Custody is released before the result is handed over, so a result
        // handler can never observe (or re-deliver) its own pending approval.
        expect(deliveryObservedCustody).toHaveBeenCalledWith(null);
        const delivered = onExecuted.mock.calls[0]?.[0];
        expect(delivered).toBeDefined();
        if (!delivered) throw new Error('Expected the executed approval Artifact');
        expect(delivered.id).toBe(artifactId);
        if (typeof delivered.body !== 'string') throw new Error('Expected the executed approval Artifact body');
        expect(ApprovalRequestV2Schema.parse(JSON.parse(delivered.body))).toMatchObject({
            status: 'executed',
            execution: { ok: true },
        });

        await hook.rerender({ scopeKey: `${serverId}:${ACCOUNT_ID}` });
        expect(onExecuted).toHaveBeenCalledTimes(1);
        expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1);
    });

    it('leaves projection refresh with a caller that owns completion beyond Action admission', async () => {
        const serverId = await addApprovalHome();
        answerRename(serverId);
        const artifactId = await openRenameApproval(serverId, 'caller-owned-completion');
        const refresh = vi.fn();
        const hook = await renderContinuation(serverId, refresh);
        const received: unknown[] = [];
        const scope = createServerAccountScope(serverId, ACCOUNT_ID);
        if (!scope) throw new Error('Expected the originating Home scope');
        const continuation = createActionApprovalContinuation({
            artifactId,
            actionId: 'teams.update',
            scope,
            expectedInput: { v: 1, teamId: 'team-1', name: 'Renamed' },
            refreshAfterExecution: false,
            onSucceeded: (value: unknown) => { received.push(value); },
        });

        act(() => hook.getCurrent().requestApproval(continuation));
        await decideApprovalAsInbox(serverId, artifactId, 'approve');
        await waitForHomeGovernance(() => expect(received).toHaveLength(1));

        expect(hook.getCurrent().approvalId).toBeNull();
        expect(hook.getCurrent().approvalPending).toBe(false);
        expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1);
        // The origin received its real result, but only that origin can know
        // when its remaining work is complete and its projection can refresh.
        expect(refresh).not.toHaveBeenCalled();
    });

    it('hands a chained result-bearing Action to the same owner after the first result is claimed', async () => {
        const serverId = await addApprovalHome();
        answerRename(serverId);
        const firstId = await openRenameApproval(serverId, 'rename-first');
        const secondId = await openRenameApproval(serverId, 'rename-second', 'Renamed again');
        const hook = await renderContinuation(serverId);
        const secondResult = vi.fn(async () => 'consumed' as const);
        const firstResult = vi.fn(async () => {
            hook.getCurrent().requestApproval({ artifactId: secondId, onExecuted: secondResult });
            return 'consumed' as const;
        });

        act(() => hook.getCurrent().requestApproval({ artifactId: firstId, onExecuted: firstResult }));
        await decideApprovalAsInbox(serverId, firstId, 'approve');
        await waitForHomeGovernance(() => expect(firstResult).toHaveBeenCalledOnce());
        await waitForHomeGovernance(() => expect(hook.getCurrent().approvalId).toBe(secondId));
        expect(secondResult).not.toHaveBeenCalled();

        await decideApprovalAsInbox(serverId, secondId, 'approve');
        await waitForHomeGovernance(() => expect(secondResult).toHaveBeenCalledOnce());
        expect(hook.getCurrent().approvalId).toBeNull();
    });

    it('delivers both concurrently registered read results even when the Inbox decides the second first', async () => {
        const serverId = await addApprovalHome();
        await harness.requireUiApproval(serverId, 'teams.identity.connections.list');
        harness.answer(serverId, '/v1/teams/identity/connections/list', {
            body: {
                items: [], eligibleProviders: [], memberSignInUrl: null,
                admissionModeApplicability: { v: 1, modes: {
                    invite_only: { status: 'available' },
                    provisioned: { status: 'unavailable', reason: 'directory_source_required' },
                    jit: { status: 'unavailable', reason: 'team_connection_required' },
                } },
            },
        });
        harness.answer(serverId, 'GET /v1/teams/team-1/directory-sources', {
            body: { items: [], nextCursor: null },
        });
        const hook = await renderContinuation(serverId);
        const scope = createServerAccountScope(serverId, ACCOUNT_ID)!;
        const client = createIdentityAdministrationClient(scope, { onApprovalPending: hook.getCurrent().requestApproval });
        const firstResult = vi.fn();
        const secondResult = vi.fn();
        await act(async () => { await client.execute('teams.identity.connections.list', { v: 1, teamId: 'team-1' }, { onApprovalSucceeded: firstResult }); });
        await harness.requireUiApproval(serverId, 'teams.directory.sources.list');
        await act(async () => { await client.executeDirectory('teams.directory.sources.list', { v: 1, teamId: 'team-1' }, { onApprovalSucceeded: secondResult }); });
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(2));
        const artifactIdFor = (actionId: string) => harness.artifacts(serverId).list().find((row) => {
            const body = harness.artifacts(serverId).readPlainBody(row.id);
            return body !== null && ApprovalRequestV2Schema.parse(JSON.parse(body)).actionId === actionId;
        })!.id;
        const firstId = artifactIdFor('teams.identity.connections.list');
        const secondId = artifactIdFor('teams.directory.sources.list');
        await expect(decideApprovalAsInbox(serverId, secondId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
        await expect(decideApprovalAsInbox(serverId, firstId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });

        await waitForHomeGovernance(() => {
            expect(firstResult).toHaveBeenCalledOnce();
            expect(secondResult).toHaveBeenCalledOnce();
        });
        expect(firstResult).toHaveBeenCalledWith(expect.objectContaining({ items: [], eligibleProviders: [] }));
        expect(secondResult).toHaveBeenCalledWith({ items: [], nextCursor: null });
        expect(hook.getCurrent().approvalId).toBeNull();
        expect(harness.requestsFor('/v1/teams/identity/connections/list')).toHaveLength(1);
        expect(harness.requestsFor('/v1/teams/team-1/directory-sources')).toHaveLength(1);
    });

    it.each([
        { status: 'rejected' as const, decision: 'reject' as const, homeAnswer: null },
        // The Home refuses the replayed rename, so execution settles failed.
        { status: 'failed' as const, decision: 'approve' as const, homeAnswer: { status: 409, body: { error: 'team_archived' } } },
    ])('releases $status custody with its typed body and restores retry', async ({ status, decision, homeAnswer }) => {
        const serverId = await addApprovalHome();
        if (homeAnswer) harness.answer(serverId, TEAM_UPDATE_PATH, homeAnswer);
        const artifactId = await openRenameApproval(serverId, `rename-${status}`);
        const hook = await renderContinuation(serverId);
        const onExecuted = vi.fn(async () => 'consumed' as const);
        const onTerminal = vi.fn();

        act(() => hook.getCurrent().requestApproval({ artifactId, onExecuted, onTerminal }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().approvalStatus).toBe('open'));
        await decideApprovalAsInbox(serverId, artifactId, decision);

        await waitForHomeGovernance(() => expect(onTerminal).toHaveBeenCalledOnce());
        const [terminalStatus, artifact] = onTerminal.mock.calls[0] as [string, { id: string; body: unknown }];
        expect(terminalStatus).toBe(status);
        expect(artifact.id).toBe(artifactId);
        expect(typeof artifact.body).toBe('string');
        expect(onExecuted).not.toHaveBeenCalled();
        expect(hook.getCurrent().approvalId).toBeNull();
        expect(hook.getCurrent().approvalPending).toBe(false);
    });

    it('keeps custody through a transport failure so the same approval can still settle', async () => {
        const serverId = await addApprovalHome();
        const artifactId = await openRenameApproval(serverId, 'rename-unreachable');
        harness.answer(serverId, `GET /v1/artifacts/${artifactId}`, { status: 503, body: { error: 'unavailable' } });
        const hook = await renderContinuation(serverId);
        const onTerminal = vi.fn();

        act(() => hook.getCurrent().requestApproval({ artifactId, onExecuted: vi.fn(), onTerminal }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().error).toBe(true));

        expect(hook.getCurrent().invalidArtifact).toBe(false);
        expect(hook.getCurrent().approvalId).toBe(artifactId);
        expect(hook.getCurrent().approvalPending).toBe(true);
        expect(onTerminal).not.toHaveBeenCalled();
    });

    it('clears an Artifact the Home serves whose header contradicts its approval body', async () => {
        const serverId = await addApprovalHome();
        const genuineId = await openRenameApproval(serverId, 'rename-genuine');
        const genuineBody = harness.artifacts(serverId).readPlainBody(genuineId);
        const genuine = ApprovalRequestV2Schema.parse(genuineBody === null ? null : JSON.parse(genuineBody));
        // Any client of the Home's Artifact route can store this row; the reader
        // must refuse it rather than wait on it forever.
        const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const context = await captureActionAccountContext(serverId, new AbortController().signal);
        let contradictoryId: string;
        try {
            contradictoryId = await context.createArtifact(
                buildApprovalRequestArtifactHeaderV1({ ...genuine, actionId: 'teams.archive' }),
                JSON.stringify(genuine),
            );
        } finally {
            context.dispose();
        }
        const hook = await renderContinuation(serverId);
        const onTerminal = vi.fn();

        act(() => hook.getCurrent().requestApproval({ artifactId: contradictoryId, onExecuted: vi.fn(), onTerminal }));

        await waitForHomeGovernance(() => expect(onTerminal).toHaveBeenCalledWith('invalid', null));
        expect(hook.getCurrent().approvalId).toBeNull();
    });

    it('discards process-local custody when the exact scope changes', async () => {
        const serverId = await addApprovalHome();
        answerRename(serverId);
        const artifactId = await openRenameApproval(serverId, 'rename-scope');
        const queuedArtifactId = await openRenameApproval(serverId, 'rename-queued-scope');
        const hook = await renderContinuation(serverId);
        const onExecuted = vi.fn(async () => 'consumed' as const);

        act(() => hook.getCurrent().requestApproval({ artifactId, onExecuted }));
        expect(hook.getCurrent().approvalId).toBe(artifactId);
        act(() => hook.getCurrent().requestApproval({ artifactId: queuedArtifactId, onExecuted }));

        await hook.rerender({ scopeKey: `${serverId}:account-b` });
        expect(hook.getCurrent().approvalId).toBeNull();
        await decideApprovalAsInbox(serverId, artifactId, 'approve');
        await decideApprovalAsInbox(serverId, queuedArtifactId, 'approve');
        expect(onExecuted).not.toHaveBeenCalled();
    });

    it('releases an aborted loader without canceling its durable approval or losing the next result', async () => {
        const serverId = await addApprovalHome();
        answerRename(serverId);
        const firstId = await openRenameApproval(serverId, 'abandoned-load');
        const secondId = await openRenameApproval(serverId, 'current-load');
        const hook = await renderContinuation(serverId);
        const abandoned = new AbortController();
        const firstResult = vi.fn(async () => 'consumed' as const);
        const secondResult = vi.fn(async () => 'consumed' as const);
        act(() => {
            hook.getCurrent().requestApproval({ artifactId: firstId, onExecuted: firstResult, signal: abandoned.signal });
            hook.getCurrent().requestApproval({ artifactId: secondId, onExecuted: secondResult });
        });
        expect(hook.getCurrent().approvalId).toBe(firstId);

        act(() => abandoned.abort());
        await waitForHomeGovernance(() => expect(hook.getCurrent().approvalId).toBe(secondId));
        const abandonedBody = harness.artifacts(serverId).readPlainBody(firstId);
        expect(ApprovalRequestV2Schema.parse(JSON.parse(abandonedBody!)).status).toBe('open');
        await decideApprovalAsInbox(serverId, secondId, 'approve');
        await waitForHomeGovernance(() => expect(secondResult).toHaveBeenCalledOnce());
        expect(firstResult).not.toHaveBeenCalled();
    });
});
