import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamInvitationPreviewV1 } from '@happier-dev/protocol/teams';
import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/http/client')>(),
    createServerFetchAtEndpoint: () => request,
}));

import { useTeamInvitationPreview } from './useTeamInvitationPreview';

const preview: TeamInvitationPreviewV1 = {
    home: { serverId: 'srv_acme', displayName: 'Acme Home', storageMode: null, hosting: null },
    team: { teamId: 'team-1', name: 'Acme', logo: null, accentSeed: 'team-1' },
    role: 'guest',
    historyAccess: 'all_existing',
    state: 'active',
    expiresAt: Date.UTC(2030, 0, 1),
    recipientEmailMask: null,
    inviterLabel: null,
};

describe('useTeamInvitationPreview', () => {
    it('keeps the decoded bearer reason for the join presenter', async () => {
        request.mockResolvedValueOnce(Response.json({ outcome: 'unavailable', reason: 'expired' }));
        const target = { kind: 'descriptor', authority: 'trusted_enrollment', descriptor: {
            v: 1, homeServerIdentityId: 'srv_acme', canonicalServerUrl: 'https://acme.example.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://acme.example.test' }],
        }} satisfies HomeTargetInput;
        const hook = await renderHook(useTeamInvitationPreview, { initialProps: { target, token: 'a'.repeat(43) } });
        expect(hook.getCurrent()).toEqual({ kind: 'unavailable', reason: 'expired' });
    });
    afterEach(async () => {
        await standardCleanup();
        request.mockReset();
    });

    it('retains the exact hydrated offer while refreshing and reports a failed refresh', async () => {
        const second = createDeferred<Response>();
        request
            .mockResolvedValueOnce(new Response(JSON.stringify({ outcome: 'ok', preview })))
            .mockImplementationOnce(() => second.promise);
        const target = {
            kind: 'descriptor',
            authority: 'trusted_enrollment',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_acme',
                canonicalServerUrl: 'https://acme.example.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://acme.example.test' }],
            },
        } satisfies HomeTargetInput;
        const hook = await renderHook(useTeamInvitationPreview, {
            initialProps: { target, token: 'a'.repeat(43), revision: 0 },
        });
        expect(hook.getCurrent()).toEqual({ kind: 'ready', preview });

        await hook.rerender({ target, token: 'a'.repeat(43), revision: 1 });
        expect(hook.getCurrent()).toEqual({ kind: 'ready', preview, refreshing: true });

        await act(async () => { second.reject(new Error('offline')); });
        expect(hook.getCurrent()).toEqual({ kind: 'ready', preview, refreshFailure: { retryable: true } });
    });
});
