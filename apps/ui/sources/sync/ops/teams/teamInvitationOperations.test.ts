import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup, teamInvitationRowFixture } from '@/dev/testkit';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

/**
 * The invitation wrappers, through the path they actually take.
 *
 * Each wrapper names a canonical Action id and nothing else: the method, path
 * and result shape come from that id's row by way of the shared Action front
 * door. So this watches the network boundary — a wrapper pointed at the wrong
 * id, or a row whose transport moved, changes what arrives there and fails
 * here. Only the network and the device credential store are replaced.
 */

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const LIST_PATH = '/v1/teams/invitations/list';
const CREATE_PATH = '/v1/teams/invitations/create';
const ACCEPT_PATH = '/v1/team-invitations/accept';
const ACCEPT_PREPARE_PATH = '/v1/team-invitations/accept/prepare-approval';
const ARTIFACT_CREATE_PATH = '/v1/artifacts';

const TOKEN = 'a'.repeat(43);
const PREPARED_ACCEPT = {
    outcome: 'ok',
    continuation: {
        v: 1,
        kind: 'post_auth_invitation',
        reference: 'continuation-reference-1',
        teamId: 'team-1',
    },
    preview: {
        home: { serverId: 'home-identity-1', displayName: 'Home A', storageMode: 'plain' },
        team: { teamId: 'team-1', name: 'Platform', logo: null, accentSeed: 'team-1' },
        role: 'member',
        historyAccess: 'from_membership',
        state: 'active',
        expiresAt: 2_000_000_000_000,
        recipientEmailMask: null,
    },
} as const;

async function addHome(): Promise<string> {
    return await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
    });
}

async function operations() {
    return await import('./teamInvitationOperations');
}

/** The approval request a Home persisted, as its Plain Account row stores it. */
function storedApprovalRequest(serverId: string, artifactId: string) {
    const body = harness.artifacts(serverId).readPlainBody(artifactId);
    return ApprovalRequestV2Schema.parse(body === null ? null : JSON.parse(body));
}

/**
 * The settled approval exactly as a mounted continuation receives it: read
 * back from the Home through the same exact-Home reader `useApprovalArtifact`
 * uses, never assembled by the test.
 */
async function readApprovalArtifact(serverId: string, artifactId: string) {
    const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureActionAccountContext(serverId, new AbortController().signal);
    try {
        const artifact = await context.fetchArtifact(artifactId);
        if (!artifact) throw new Error(`approval_artifact_missing:${artifactId}`);
        return artifact;
    } finally {
        context.dispose();
    }
}

async function scopeAndAddress(serverId: string) {
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { createTeamAddress } = await import('@/sync/domains/teams/teamAddress');
    return {
        scope: createServerAccountScope(serverId, 'account-ada')!,
        address: createTeamAddress(serverId, 'team-1')!,
    };
}

/**
 * The person's own Actions policy explicitly requires UI approval for one exact
 * Action. `teams.invitations.accept` is declared deferred/result-required, so
 * that requirement produces a durable approval Artifact instead of reaching the
 * Home, and its real answer has to arrive through the continuation.
 *
 * The harness owns that write because it also owns undoing it: the requirement
 * lives in the shared Account settings baseline, which outlives both the Home
 * and the case. A suite-local copy left it standing, which silently deferred
 * every later accept in this file into an Artifact its Home was never asked to
 * answer for — read here as a domain failure rather than the leak it was.
 */
const requireUiApproval = (serverId: string, actionId: string): Promise<void> =>
    harness.requireUiApproval(serverId, actionId);

/**
 * The Action front door, resolved once.
 *
 * It cannot be a static import: the installed boundaries are registered with
 * `vi.doMock`, so pulling the executor graph in at module evaluation would bind
 * the real transport instead. Resolving it here keeps that one-time cost — large
 * enough to exceed the per-hook budget on a cold cache — out of `beforeEach`,
 * where it reads as a hung hook rather than as a slow import.
 */
let teamActionClient!: typeof import('./teamActionClient');

beforeAll(async () => {
    teamActionClient = await import('./teamActionClient');
}, 300_000);

beforeEach(async () => {
    await harness.reset();
    teamActionClient.resetTeamActionClientForTests();
});

afterEach(() => {
    teamActionClient.resetTeamActionClientForTests();
    standardCleanup();
});

describe('teamInvitationOperations', () => {
    it('lists invitations without ever receiving a bearer', async () => {
        const serverId = await addHome();
        harness.answer(serverId, LIST_PATH, {
            // The page carries the Home's own mail-delivery answer, and the
            // declared output schema is strict: a page without it is not a page
            // this build accepts, so omitting it here would prove the wrapper
            // reads a shape the Home never sends.
            body: { items: [teamInvitationRowFixture()], nextCursor: null, emailDelivery: 'available', linkDelivery: 'available' },
        });
        const { scope, address } = await scopeAndAddress(serverId);

        const outcome = await (await operations()).listTeamInvitations({ scope, address, state: null });

        expect(outcome.kind).toBe('succeeded');
        if (outcome.kind !== 'succeeded') return;
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(1);
        // The strict row schema has no bearer field at all, so a manager
        // reviewing this list can never recover a secret from it.
        expect(Object.keys(outcome.value.items[0] ?? {})).not.toContain('token');
    });

    it('treats a null joinUrl as an email-bound delivery rather than a failure', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREATE_PATH, {
            body: { invitation: teamInvitationRowFixture(), joinUrl: null },
        });
        const { scope, address } = await scopeAndAddress(serverId);

        const outcome = await (await operations()).createTeamInvitation({
            scope,
            address,
            role: 'member',
            historyAccess: 'from_membership',
            recipientEmail: 'someone@example.com',
            requestKey: 'key-1',
        });

        expect(outcome.kind).toBe('succeeded');
        if (outcome.kind !== 'succeeded') return;
        // The bearer reached only the mail boundary; that absence is meaningful.
        expect(outcome.value.joinUrl).toBeNull();
        expect(harness.requestsFor(CREATE_PATH)[0]?.input).toMatchObject({
            recipientEmail: 'someone@example.com',
            requestKey: 'key-1',
        });
    });

    it('carries the bearer in the request body, never in the accept URL', async () => {
        const serverId = await addHome();
        harness.answer(serverId, ACCEPT_PATH, { body: { outcome: 'joined', teamId: 'team-1' } });
        const { scope } = await scopeAndAddress(serverId);

        const outcome = await (await operations()).acceptTeamInvitation({ scope, admission: { token: TOKEN } });

        expect(outcome).toMatchObject({ kind: 'succeeded', value: { outcome: 'joined', teamId: 'team-1' } });
        const request = harness.requestsFor(ACCEPT_PATH)[0];
        // A bearer in a query string would survive in logs the path redactor
        // templates, so it must only ever appear in the strict body.
        expect(request?.path).toBe(ACCEPT_PATH);
        expect(request?.path).not.toContain(TOKEN);
        expect(request?.input).toEqual({ v: 1, token: TOKEN });
    });

    it('defers an explicitly approval-required accept into a result-bearing continuation', async () => {
        const serverId = await addHome();
        harness.answer(serverId, ACCEPT_PATH, { body: { outcome: 'joined', teamId: 'team-1' } });
        harness.answer(serverId, ACCEPT_PREPARE_PATH, { body: PREPARED_ACCEPT });
        await requireUiApproval(serverId, 'teams.invitations.accept');
        const { scope } = await scopeAndAddress(serverId);
        const { isTeamActionApprovalPendingError } = await import('./teamActionClient');

        const onApprovalSucceeded = vi.fn();
        const onApprovalFailed = vi.fn();
        const pending = await (await operations()).acceptTeamInvitation({
            scope,
            admission: { token: TOKEN },
            onApprovalSucceeded,
            onApprovalFailed,
        }).then(() => null, (cause: unknown) => cause);

        expect(isTeamActionApprovalPendingError(pending)).toBe(true);
        // Nobody is admitted before the approval is decided; only the durable
        // request exists.
        expect(harness.requestsFor(ACCEPT_PATH)).toHaveLength(0);
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(1);
        // Supplying a result handler is what upgrades the registration from a
        // bare Artifact id to a continuation bound to this exact intent, so the
        // deferred admission can settle with the Home's own answer instead of
        // degrading into "something changed, reload".
        expect(isTeamActionApprovalPendingError(pending) && pending.registration).toMatchObject({
            artifactId: expect.any(String),
            onExecuted: expect.any(Function),
        });
        if (!isTeamActionApprovalPendingError(pending) || typeof pending.registration === 'string') return;

        const openRequest = storedApprovalRequest(serverId, pending.artifactId);
        expect(openRequest.actionArgs).toMatchObject({
            v: 1,
            continuation: { v: 1, kind: 'post_auth_invitation', teamId: 'team-1' },
        });
        expect(JSON.stringify(openRequest)).not.toContain(TOKEN);

        // Decided where the product decides it: the Inbox replays the admission
        // once, and the registration settles from what that replay persisted.
        await expect(decideApprovalAsInbox(serverId, pending.artifactId, 'approve')).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });
        expect(harness.requestsFor(ACCEPT_PATH)).toHaveLength(1);
        expect(await pending.registration.onExecuted(await readApprovalArtifact(serverId, pending.artifactId)))
            .toBe('consumed');
        expect(onApprovalSucceeded).toHaveBeenCalledWith({ outcome: 'joined', teamId: 'team-1' });
        expect(onApprovalFailed).not.toHaveBeenCalled();
        expect(harness.requestsFor(ACCEPT_PATH)).toHaveLength(1);
    });

    it('leaves a handler-free accept registering only its Artifact id', async () => {
        const serverId = await addHome();
        harness.answer(serverId, ACCEPT_PATH, { body: { outcome: 'joined', teamId: 'team-1' } });
        harness.answer(serverId, ACCEPT_PREPARE_PATH, { body: PREPARED_ACCEPT });
        await requireUiApproval(serverId, 'teams.invitations.accept');
        const { scope } = await scopeAndAddress(serverId);
        const { isTeamActionApprovalPendingError } = await import('./teamActionClient');

        const pending = await (await operations()).acceptTeamInvitation({ scope, admission: { token: TOKEN } })
            .then(() => null, (cause: unknown) => cause);

        expect(isTeamActionApprovalPendingError(pending)).toBe(true);
        expect(isTeamActionApprovalPendingError(pending) && typeof pending.registration).toBe('string');
    });

    /**
     * Creation is the other half of the custody problem, answered differently.
     *
     * Accept can be deferred because its answer is a membership anyone may
     * re-read. Creation cannot: its answer carries a raw bearer, so it is
     * declared live-only custody — the invocation itself is what waits, the
     * link returns to it alone, and the durable Artifact keeps only the safe
     * projection. The caller therefore hands down its mount lifetime, and a
     * cancelled lifetime cancels the wait rather than stranding a bearer.
     */
    it('ends an approval-held creation with its caller lifetime and never keeps the bearer durably', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREATE_PATH, {
            body: { invitation: teamInvitationRowFixture(), joinUrl: `https://home-a.example/join/${TOKEN}` },
        });
        await requireUiApproval(serverId, 'teams.invitations.create');
        const { scope, address } = await scopeAndAddress(serverId);
        const lifetime = new AbortController();

        const creation = (await operations()).createTeamInvitation({
            scope,
            address,
            role: 'member',
            historyAccess: 'from_membership',
            recipientEmail: null,
            requestKey: 'key-1',
            signal: lifetime.signal,
        });

        // The explicit approval holds this live invocation open; nothing has
        // reached the Home yet.
        await vi.waitFor(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
        const artifactId = harness.artifacts(serverId).list()[0]!.id;
        expect(harness.requestsFor(CREATE_PATH)).toHaveLength(0);

        // The surface unmounts: its lifetime ends the wait instead of leaving
        // the invocation pending forever.
        lifetime.abort();
        await expect(creation).resolves.toMatchObject({ kind: 'failed' });
        expect(harness.requestsFor(CREATE_PATH)).toHaveLength(0);

        // The durable Artifact cannot restore a lost live bearer recipient.
        // Refuse before minting, exactly like the canonical approval executor.
        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({
            ok: true,
            result: { status: 'failed', execution: {
                ok: false, errorCode: 'approval_stale', effectAttempted: false,
                details: { reason: 'live_invocation_unavailable' },
            } },
        });
        expect(harness.requestsFor(CREATE_PATH)).toHaveLength(0);
        expect(harness.artifacts(serverId).readPlainBody(artifactId)).not.toContain(TOKEN);
    });

    it('keeps every terminal accept outcome distinguishable', async () => {
        const serverId = await addHome();
        harness.answer(serverId, ACCEPT_PATH, { body: { outcome: 'email_mismatch' } });
        const { scope } = await scopeAndAddress(serverId);

        const outcome = await (await operations()).acceptTeamInvitation({ scope, admission: { token: TOKEN } });

        expect(outcome).toMatchObject({ kind: 'succeeded', value: { outcome: 'email_mismatch' } });
    });
});
