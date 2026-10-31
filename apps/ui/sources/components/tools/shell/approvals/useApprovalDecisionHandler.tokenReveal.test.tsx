import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1, ApprovalRequestSchema } from '@happier-dev/protocol';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

const modal = vi.hoisted(() => ({ boundary: null as ReturnType<typeof import('@/dev/testkit/mocks/modal').createModalModuleMock> | null }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    modal.boundary = createModalModuleMock();
    return modal.boundary.module;
});

// Only the Home network, device credential store, Socket.IO transport and modal host are replaced.
// The Action executor, Artifact codec/claim, decision hook and reveal controller run for real.
const home = createHomeGovernanceHarness();
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary((socket) => { configureConnectedServerSocketBoundary(socket); });
// Import the real host graph after transport mocks are installed, as explicit
// setup. A transform/fetch timeout must not be mistaken for a hung approval.
const [{ createDefaultActionExecutor }, { useApprovalDecisionHandler }] = await Promise.all([
    import('@/sync/ops/actions/defaultActionExecutor'), import('./useApprovalDecisionHandler'),
]);
const tokenId = '11111111-1111-4111-8111-111111111111';
const token = `hap_v1_${tokenId}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
const summary = { tokenId, label: 'Requested token', displayPrefix: 'hap_v1_11111111',
    createdAt: '2026-10-01T12:00:00.000Z', lastUsedAt: null, expiresAt: null,
    hasEncryptionAccess: false, hasUnattendedTeamAccess: false, grant: API_TOKEN_FULL_GRANT_V1,
    parentTokenId: null, activeChildCount: 0, embedConfig: null };

function expectSuccessfulStoredExecution(serverId: string, artifactId: string) {
    const request = ApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(artifactId)!));
    expect(request.execution?.ok).toBe(true);
}

async function addApprovalHome() {
    return await home.addHome({ name: 'Home A', serverUrl: 'https://home-a.example',
        serverIdentityId: 'srv_stable-home-a', accountId: 'account-a' });
}

async function createRequestedTokenApproval() {
    const serverId = await addApprovalHome();
    await home.requireUiApproval(serverId, 'account.apiTokens.create');
    const cancellation = new AbortController();
    const invocation = createDefaultActionExecutor().execute('account.apiTokens.create', { tokenId, label: summary.label }, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId, actionRequestId: 'requested-token-create', signal: cancellation.signal,
    });
    try {
        const artifactId = await vi.waitFor(() => {
            const request = home.requestsFor('/v1/artifacts').find(request => request.input !== null);
            const input = request?.input;
            if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string') {
                throw new Error('token_approval_not_created');
            }
            expect(home.artifacts(serverId).readPlainBody(input.id)).not.toBeNull();
            return input.id;
        });
        const body = home.artifacts(serverId).readPlainBody(artifactId);
        if (!body) throw new Error('token_approval_not_stored');
        const approval = ApprovalRequestSchema.parse(JSON.parse(body));
        return { serverId, artifactId, approval, invocation, cancellation };
    } catch (error) {
        cancellation.abort(); await invocation;
        throw error;
    }
}

beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    await home.reset();
    modal.boundary?.spies.show.mockClear();
    modal.boundary?.spies.hide.mockClear();
});
afterEach(async () => {
    standardCleanup();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    webLocks?.restore();
    webLocks = undefined;
});

describe('approved API token reveal', () => {
    it('acknowledges a retained token request without revealing its caller-owned result to the approver', async () => {
        const { serverId, artifactId, approval, invocation, cancellation } = await createRequestedTokenApproval();
        try {
            home.answer(serverId, 'POST /v1/auth/api-tokens/create', { body: { token, apiToken: summary } });
            const hook = await renderHook(() => useApprovalDecisionHandler({ id: artifactId, header: null }, approval, '', serverId));
            const revealed = await hook.getCurrent()('approve');
            await expect(invocation).resolves.toMatchObject({ ok: true, result: { token, apiToken: summary } });
            expectSuccessfulStoredExecution(serverId, artifactId);
            expect(revealed).toBe(true);
            expect(modal.boundary?.spies.show).not.toHaveBeenCalled();
            expect(home.requestsFor('/v1/auth/api-tokens/create')).toHaveLength(1);
            expect(home.artifacts(serverId).readPlainBody(artifactId)).not.toContain(token);
        } finally { cancellation.abort(); await invocation; }
    });
});

describe('approved Team invitation reveal', () => {
    it.each(['teams.invitations.create', 'teams.invitations.reissue'] as const)(
        'acknowledges retained %s without adopting its caller-owned bearer', async (actionId) => {
            const serverId = await addApprovalHome();
            // Live-only results retain the original invocation (APPR-S1 step 2).
            // Present its Artifact while it waits; awaiting it here deadlocks consent.
            const cancellation = new AbortController();
            const requested = createDefaultActionExecutor().execute(actionId, actionId === 'teams.invitations.create'
                ? { v: 1, teamId: 'team-a', role: 'member', historyAccess: 'from_membership', recipientEmail: null,
                    requestKey: 'requested-invitation-create' }
                : { v: 1, teamId: 'team-a', invitationId: 'old-invitation', recipientEmail: null,
                    requestKey: 'requested-invitation-reissue' }, {
                surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
                serverId, actionRequestId: `requested-${actionId}`, signal: cancellation.signal,
            });
            try {
                const artifactId = await vi.waitFor(() => {
                    const stored = home.requestsFor('/v1/artifacts').find(request => request.input !== null)?.input;
                    if (!stored || typeof stored !== 'object' || !('id' in stored) || typeof stored.id !== 'string') {
                        throw new Error('invitation_approval_not_created');
                    }
                    expect(home.artifacts(serverId).readPlainBody(stored.id)).not.toBeNull();
                    return stored.id;
                });
                const approval = ApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(artifactId)!));
                const invitation = { id: 'invitation-a', teamId: 'team-a', role: 'member', historyAccess: 'from_membership',
                    state: 'active', recipientEmailMask: null, expiresAt: 2, createdAt: 1, createdByAccountId: 'account-a',
                    acceptedByAccountId: null, lastEmailDelivery: null };
                const joinUrl = 'https://home-a.example/team-invitations/live-human-only';
                const output = actionId === 'teams.invitations.create' ? { invitation, joinUrl }
                    : { previous: { ...invitation, id: 'old-invitation', state: 'revoked' }, replacement: invitation, joinUrl };
                const path = `/v1/teams/invitations/${actionId === 'teams.invitations.create' ? 'create' : 'reissue'}`;
                home.answer(serverId, `POST ${path}`, { body: output });
                const hook = await renderHook(() => useApprovalDecisionHandler({ id: artifactId, header: null }, approval, '', serverId));
                const revealed = await hook.getCurrent()('approve');
                const requesterResult = await requested;
                // APPR-S1's signed invitation cases retain the original live
                // recipient; only observations/Artifacts drop the bearer.
                expect(requesterResult).toEqual({ ok: true, result: output });
                expectSuccessfulStoredExecution(serverId, artifactId);
                expect(revealed).toBe(true);
                expect(modal.boundary?.spies.show).not.toHaveBeenCalled();
                expect(home.requestsFor(path)).toHaveLength(1);
                expect(home.artifacts(serverId).readPlainBody(artifactId)).not.toContain(joinUrl);
                await home.switchAccount(serverId, 'account-b');
                expect(modal.boundary?.spies.show).not.toHaveBeenCalled();
                await hook.unmount();
            } finally { cancellation.abort(); await requested; }
        },
    );
});
