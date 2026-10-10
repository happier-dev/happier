import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1, ApprovalRequestSchema } from '@happier-dev/protocol';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { ApiTokenSettingsController } from '@/components/settings/apiTokens/apiTokenSettingsController';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

const modal = vi.hoisted(() => ({ boundary: null as ReturnType<typeof import('@/dev/testkit/mocks/modal').createModalModuleMock> | null }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    modal.boundary = createModalModuleMock();
    return modal.boundary.module;
});

// Only the Home network, device credential store and modal host are replaced.
// The Action executor, Artifact codec/claim, decision hook and reveal controller run for real.
const home = createHomeGovernanceHarness();
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
installHomeGovernanceBoundaries(home);
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

async function createRequestedTokenApproval() {
    const serverId = await home.addHome({ name: 'Home A', serverUrl: 'https://home-a.example',
        serverIdentityId: 'srv_stable-home-a', accountId: 'account-a' });
    await home.requireUiApproval(serverId, 'account.apiTokens.create');
    const result = await createDefaultActionExecutor().execute('account.apiTokens.create', { tokenId, label: summary.label }, {
        surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
        serverId, actionRequestId: 'requested-token-create',
    });
    if (!result.ok || typeof result.result !== 'object' || result.result === null
        || !('artifactId' in result.result) || typeof result.result.artifactId !== 'string') {
        throw new Error('token_approval_not_created');
    }
    const artifactId = result.result.artifactId;
    const body = home.artifacts(serverId).readPlainBody(artifactId);
    if (!body) throw new Error('token_approval_not_stored');
    const approval = ApprovalRequestSchema.parse(JSON.parse(body));
    return { serverId, artifactId, approval };
}

beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    await home.reset();
    modal.boundary?.spies.show.mockClear();
    modal.boundary?.spies.hide.mockClear();
});
afterEach(() => {
    standardCleanup();
    webLocks?.restore();
    webLocks = undefined;
});

describe('approved API token reveal', () => {
    it('shows the human live result through the canonical show-once controller without another mint or persistence', async () => {
        const { serverId, artifactId, approval } = await createRequestedTokenApproval();
        home.answer(serverId, 'POST /v1/auth/api-tokens/create', { body: { token, apiToken: summary } });
        const hook = await renderHook(() => useApprovalDecisionHandler({ id: artifactId, header: null }, approval, '', serverId));
        await expect(hook.getCurrent()('approve')).resolves.toBe(true);
        const shown = modal.boundary?.spies.show.mock.calls.at(-1)?.[0];
        expect(shown).toBeDefined();
        // The modal is a genuine boundary; its typed props expose the real lifecycle owner beneath it.
        const controller = (shown?.props as { controller: ApiTokenSettingsController }).controller;
        expect(controller.getState().reveal).toMatchObject({ token, apiToken: summary, acknowledged: false });
        expect(home.requestsFor('/v1/auth/api-tokens/create')).toHaveLength(1);
        expect(home.artifacts(serverId).readPlainBody(artifactId)).not.toContain(token);
        shown?.onHostUnmount?.();
        expect(controller.getState().reveal).toBeNull();
    });

    it('does not disclose an approved live result after its captured Home Account retires', async () => {
        const { serverId, artifactId, approval } = await createRequestedTokenApproval();
        let issued!: () => void;
        const started = new Promise<void>(resolve => { issued = resolve; });
        let release!: () => void;
        const respondAfter = new Promise<void>(resolve => { release = resolve; });
        home.answer(serverId, 'POST /v1/auth/api-tokens/create', {
            select: () => { issued(); return { body: { token, apiToken: summary }, respondAfter }; },
        });
        const hook = await renderHook(() => useApprovalDecisionHandler({ id: artifactId, header: null }, approval, '', serverId));
        const deciding = hook.getCurrent()('approve');
        await started;
        await home.switchAccount(serverId, 'account-b');
        release();
        await expect(deciding).resolves.toBe(false);
        expect(modal.boundary?.spies.show).not.toHaveBeenCalled();
    });
});

describe('approved Team invitation reveal', () => {
    it.each(['teams.invitations.create', 'teams.invitations.reissue'] as const)(
        'delivers the %s bearer only to the approving UI and retires the reveal with its Account', async (actionId) => {
            const serverId = await home.addHome({ name: 'Home A', serverUrl: 'https://home-a.example',
                serverIdentityId: 'srv_stable-home-a', accountId: 'account-a' });
            const requested = await createDefaultActionExecutor().execute(actionId, actionId === 'teams.invitations.create'
                ? { v: 1, teamId: 'team-a', role: 'member', historyAccess: 'from_membership', recipientEmail: null,
                    requestKey: 'requested-invitation-create' }
                : { v: 1, teamId: 'team-a', invitationId: 'old-invitation', recipientEmail: null,
                    requestKey: 'requested-invitation-reissue' }, {
                surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
                serverId, actionRequestId: `requested-${actionId}`,
            });
            expect(requested).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            if (!requested.ok || typeof requested.result !== 'object' || !requested.result
                || !('artifactId' in requested.result) || typeof requested.result.artifactId !== 'string') return;
            const artifactId = requested.result.artifactId;
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
            await expect(hook.getCurrent()('approve')).resolves.toBe(true);
            const shown = modal.boundary?.spies.show.mock.calls.at(-1)?.[0];
            expect(shown?.props).toMatchObject({ url: joinUrl });
            expect(home.requestsFor(path)).toHaveLength(1);
            expect(home.artifacts(serverId).readPlainBody(artifactId)).not.toContain(joinUrl);
            await home.switchAccount(serverId, 'account-b');
            expect(modal.boundary?.spies.hide).toHaveBeenCalled();
            shown?.onHostUnmount?.();
        },
    );
});
