import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createArtifactStoreBoundary, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1, deriveDeploymentEnvironmentApprovalSubjectKeyV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { approvalArtifactSubjectIndexedKindV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true }).module;
});

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { DeploymentSecretRequests } = await import('./DeploymentSecretRequests');
const { ModalProvider } = await import('@/modal');

afterEach(async () => { standardCleanup(); await account.reset(); });

it('cold Environment secret lookup opens only the selected approval body on Review', async () => {
    const home = await account.restore({ machines: [] });
    const scope = storage.getState().settingsScope!;
    const request = (environmentId: string) => ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        actionId: 'deployments.bindings.set', summary: 'Choose deployment credential', requestedSurface: 'agent',
        actionArgs: { serverId: scope.serverId, environmentId, expectedRevision: 1,
            set: [{ purpose: 'variable', name: 'API_TOKEN', phase: 'runtime', source: { kind: 'secret', ref: 'person_selects' } }], remove: [] },
        createdBy: { surface: 'agent', sessionId: 'session' }, executionOriginV1: { v: 1, actionId: 'deployments.bindings.set',
            requestId: environmentId, authority: 'account_automation', surface: 'agent', serverId: scope.serverId, accountId: scope.accountId,
            caller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 } } });
    const row = (id: string, environmentId: string) => {
        const approval = request(environmentId);
        const header = buildApprovalRequestArtifactHeaderV1(approval);
        return { id, title: header.title, header, rawHeader: header, body: JSON.stringify(approval), isDecrypted: true as const,
            ownerAccountId: scope.accountId, sourceServerId: scope.serverId, access: 'owner' as const,
            publicAudience: 'none' as const, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    };
    const selected = row('selected-secret', 'staging');
    const other = row('other-secret', 'production');
    const boundary = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
    for (const artifact of [selected, other]) {
        const stored = createPlainArtifactHttpFixture(artifact, scope.accountId);
        boundary.replaceStoredRow(stored);
    }
    const lists: string[][] = [];
    const bodies: string[][] = [];
    account.home.answer(home.serverId, 'GET /v1/artifacts', { select: async (_input, request) => {
        const url = new URL(request.url);
        const kinds: string[] = JSON.parse(url.searchParams.get('kinds') ?? '[]');
        lists.push(kinds);
        const response = await boundary.handle(url.pathname + url.search, { method: 'GET' });
        if (!response) throw new Error('Expected Artifact list boundary');
        return { body: await response.json() };
    } });
    account.home.answer(home.serverId, 'POST /v1/artifacts/read', { select: async input => {
        const request = input as { artifactIds: string[]; projection?: 'headers' };
        if (request.projection !== 'headers') bodies.push(request.artifactIds);
        const response = await boundary.handle('/v1/artifacts/read', { method: 'POST', body: JSON.stringify(input) });
        if (!response) throw new Error('Expected Artifact read boundary');
        return { body: await response.json() };
    } });
    for (const artifact of [selected, other]) {
        const path = `/v1/artifacts/${artifact.id}`;
        account.home.answer(home.serverId, `GET ${path}`, { select: async () => {
            bodies.push([artifact.id]);
            const response = await boundary.handle(path, { method: 'GET' });
            if (!response) throw new Error('Expected Artifact detail boundary');
            return { body: await response.json() };
        } });
    }
    await act(async () => { storage.setState({ isDataReady: true, profileScope: scope }); });
    const onRender = vi.fn();
    const screen = await renderScreen(<ModalProvider><React.Profiler id="secret-requests" onRender={onRender}>
        <DeploymentSecretRequests environmentId="staging" scope={scope} active />
    </React.Profiler></ModalProvider>);
    try {
        const selectedId = 'project-deployments.environment.secret-request.selected-secret';
        await vi.waitFor(() => expect(screen.findByTestId(selectedId)).not.toBeNull());
        expect(screen.findByTestId('project-deployments.environment.secret-request.other-secret')).toBeNull();
        expect(lists).toEqual([[approvalArtifactSubjectIndexedKindV1(deriveDeploymentEnvironmentApprovalSubjectKeyV1({ environmentId: 'staging' }))]]);
        expect(bodies).toEqual([]);
        onRender.mockClear();
        await act(async () => { storage.getState().updateArtifact(other); });
        expect(onRender).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync(`${selectedId}.review`);
        await vi.waitFor(() => expect(bodies).toEqual([[selected.id]]));
    } finally { await screen.unmount(); }
});
