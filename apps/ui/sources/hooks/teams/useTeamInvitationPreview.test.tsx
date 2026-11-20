import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamInvitationPreviewFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';

const request = vi.hoisted(() => vi.fn());


import { useTeamInvitationPreview } from './useTeamInvitationPreview';

const preview = teamInvitationPreviewFixture({ home: { serverId: 'srv_acme', displayName: 'Acme Home', hosting: null },
    team: { name: 'Acme' }, role: 'guest', historyAccess: 'all_existing' });

describe('useTeamInvitationPreview', () => {
    beforeEach(() => setRuntimeFetch(request));
    it('keeps the decoded bearer reason for the join presenter', async () => {
        request.mockResolvedValueOnce(Response.json({ outcome: 'unavailable', reason: 'expired' }));
        const target = { kind: 'descriptor', authority: 'trusted_enrollment', descriptor: {
            v: 1, homeServerIdentityId: 'srv_acme', canonicalServerUrl: 'https://acme.example.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://acme.example.test' }],
        }} satisfies HomeTargetInput;
        const hook = await renderHook(useTeamInvitationPreview, { initialProps: { target, token: 'a'.repeat(43) } });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ kind: 'unavailable', reason: 'expired' }));
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
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ kind: 'ready', preview }));

        await hook.rerender({ target, token: 'a'.repeat(43), revision: 1 });
        expect(hook.getCurrent()).toEqual({ kind: 'ready', preview, refreshing: true });

        await act(async () => { second.reject(new Error('offline')); });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ kind: 'ready', preview, refreshFailure: { retryable: true } }));

        const retiredRequest = createDeferred<Response>();
        request.mockReset().mockImplementationOnce(() => retiredRequest.promise);
        await hook.rerender({ target, token: 'b'.repeat(43), revision: 1 });
        await waitForHomeGovernance(() => expect(request).toHaveBeenCalledTimes(1));
        const signal = request.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;
        expect(signal).toBeDefined();
        expect(signal?.aborted).toBe(false);
        await hook.rerender({ target, token: null, revision: 1 });
        expect(signal?.aborted).toBe(true);
        expect(hook.getCurrent()).toEqual({ kind: 'idle' });
        await act(async () => { retiredRequest.resolve(Response.json({ outcome: 'ok', preview })); });
        expect(hook.getCurrent()).toEqual({ kind: 'idle' });
    });
});
