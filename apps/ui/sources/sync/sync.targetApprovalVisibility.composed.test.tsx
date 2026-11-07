import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createProviderSettingsAccountHarness,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { createArtifactStoreBoundary, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { DecryptedArtifact } from './domains/artifacts/artifactTypes';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { storage } = await import('./domains/state/storage');
const { InboxArtifactSourceBoundary, useInboxArtifactSource } = await import('@/hooks/inbox/useInboxArtifactSource');

afterEach(async () => {
    standardCleanup();
    await account.reset();
});

it('acquires a CLI live-only target approval header without a Machine or Session after replacing the signed-in Account', async () => {
    const home = await account.restore({ machines: [], accountId: 'first-approval-account' });
    const scope = storage.getState().profileScope!;
    let ownerAccountId = scope.accountId;
    const boundary = createArtifactStoreBoundary({ ownerAccountId: () => ownerAccountId, encryptionMode: 'plain' });
    account.home.answer(home.serverId, 'GET /v1/artifacts', { select: async (_input, request) => {
        const url = new URL(request.url);
        const response = await boundary.handle(`${url.pathname}${url.search}`, { method: 'GET' });
        if (!response) throw new Error('Expected Artifact inventory boundary');
        return { body: await response.json() };
    } });
    account.home.answer(home.serverId, 'POST /v1/artifacts/read', { select: async input => {
        const response = await boundary.handle('/v1/artifacts/read', { method: 'POST', body: JSON.stringify(input) });
        if (!response) throw new Error('Expected Artifact body boundary');
        return { body: await response.json() };
    } });
    let source!: ReturnType<typeof useInboxArtifactSource>;
    function Consumer() {
        source = useInboxArtifactSource();
        return null;
    }
    await act(async () => { storage.setState({ isDataReady: true }); });
    const screen = await renderScreen(<InboxArtifactSourceBoundary><Consumer /></InboxArtifactSourceBoundary>);
    try {
        await vi.waitFor(() => expect(source.phase).toBe('current'));
        expect(storage.getState().artifacts).toEqual({});
        const accountId = 'second-approval-account';
        const request = TargetActionApprovalRequestV1Schema.parse({
            v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli', accountId,
            qualifiedActionId: 'happier.triage/actions/sources/administer-v1', input: { kind: 'remove' },
            approvalInputCustody: 'live_only', secretInputPaths: [],
            sourceCustody: { kind: 'development', registeredRootId: 'source-root' },
            policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64),
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                serverId: scope.serverId, accountId, actionId: 'action.invoke', requestId: 'pending-remove' },
            summary: 'Remove source',
        });
        const header = buildTargetActionApprovalArtifactHeaderV1(request);
        const artifactId = '11111111-1111-4111-8111-999999999901';
        ownerAccountId = accountId;
        const artifact: DecryptedArtifact = { id: artifactId, ownerAccountId: accountId, access: 'owner', publicAudience: 'none',
            header, rawHeader: header, title: header.title, body: JSON.stringify(request), isDecrypted: true,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        boundary.replaceStoredRow(createPlainArtifactHttpFixture(artifact, accountId));
        await act(async () => { await account.restore({ machines: [], accountId }); });
        await vi.waitFor(() => {
            expect(source.phase).toBe('current');
            expect(storage.getState().artifacts[artifactId]?.header).toEqual(header);
        });
        expect(storage.getState().profileScope?.accountId).toBe(accountId);
        expect(storage.getState().artifacts[artifactId]?.ownerAccountId).toBe(accountId);
    } finally { await screen.unmount(); }
}, 120_000);
