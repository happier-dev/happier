import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, createRenderCommitCounter, flushHookEffects, renderHook, renderScreen, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { createAccountNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { createServiceHealthNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { createDeploymentReadControllerV1, type DeploymentReadDemandV1, type DeploymentReadTransportV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createArtifactStoreBoundary, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ApprovalRequestV1Schema, ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { storage, useInboxArtifactBodyHydration } = await import('@/sync/domains/state/storage');
const { InboxArtifactSourceBoundary, useInboxArtifactBodyDemand, useInboxArtifactItems, useInboxArtifactOpenCount, useInboxArtifactSource } = await import('./useInboxArtifactSource');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { useDeploymentEnvironment } = await import('@/components/projects/deployments/useDeploymentReads');
const { useDiscussionListRows } = await import('@/sync/ops/discussions/useDiscussionListRows');

afterEach(async () => { standardCleanup(); await account.reset(); });

it('wakes the mounted badge once when a recipient reminder becomes due and cancels its idle clock', async () => {
    const home = await account.restore({ machines: [] });
    const scope = storage.getState().settingsScope!;
    const now = Date.now();
    const notice = createAccountNoticeArtifactFixture({ ownerAccountId: scope.accountId,
        sourceServerId: scope.serverId, header: { type: 'decision', remindAt: now + 1_000 } });
    const boundary = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
    boundary.replaceStoredRow(createPlainArtifactHttpFixture(notice, scope.accountId));
    account.home.answer(home.serverId, 'GET /v1/artifacts', { select: async (_input, request) => {
        const url = new URL(request.url);
        const response = await boundary.handle(`${url.pathname}${url.search}`, { method: 'GET' });
        if (!response) throw new Error('Expected Artifact inventory boundary');
        return { body: await response.json() };
    } });
    account.home.answer(home.serverId, 'POST /v1/artifacts/read', { select: async input => {
        const response = await boundary.handle('/v1/artifacts/read', { method: 'POST', body: JSON.stringify(input) });
        if (!response) throw new Error('Expected Artifact read boundary');
        return { body: await response.json() };
    } });
    await act(async () => {
        storage.setState({ isDataReady: true, profileScope: scope });
        storage.getState().applyArtifacts([notice]);
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(now);
    let count = -1;
    let publications = 0;
    let source: ReturnType<typeof useInboxArtifactSource> | undefined;
    function Badge() { count = useInboxArtifactOpenCount(); source = useInboxArtifactSource(); publications++; return null; }
    const screen = await renderScreen(<InboxArtifactSourceBoundary><Badge /></InboxArtifactSourceBoundary>);
    try {
        await vi.waitFor(() => expect(source?.phase).toBe('current'));
        expect(storage.getState().artifactInboxEntries[notice.id]?.notice?.artifact.id).toBe(notice.id);
        expect(count).toBe(0);
        const settled = publications;
        await act(async () => { await vi.advanceTimersByTimeAsync(now + 1_000 - Date.now()); });
        expect(count).toBe(1);
        expect(publications).toBe(settled + 1);
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(publications).toBe(settled + 1);
    } finally { await screen.unmount(); vi.useRealTimers(); }
});

it('feeds admitted C1 health changes only to the consumed Environment and keeps unaffected rows quiet', async () => {
    const home = await account.restore({ machines: [] });
    const scope = storage.getState().settingsScope!;
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, environment: { ...base.environment, serverId: scope.serverId } };
    const notice = (environmentId: string, id: string, phase: 'open' | 'recovered' = 'open', revision = 3) =>
        createServiceHealthNoticeArtifactFixture(scope.serverId, { id, ownerAccountId: scope.accountId,
            sourceServerId: scope.serverId, headerVersion: revision, bodyVersion: revision,
            header: { source: { kind: 'host', topic: 'service_health', subject: { kind: 'environment',
                environmentId, targetLinkId: 'runtime-link', condition: 'health' } },
                page: { kind: 'host', page: 'environment', environment: { serverId: scope.serverId,
                    projectSourceId: detail.environment.projectSourceId, environmentId }, targetLinkId: 'runtime-link' },
                environmentHealth: { v: 1, environmentId, targetLinkId: 'runtime-link', protection: 'production',
                    status: phase === 'open' ? 'down' : 'up', n: 1, down: phase === 'open' ? 1 : 0, degraded: 0, unknown: 0,
                    members: [{ machineId: 'runtime-machine', roles: ['runtime'], status: phase === 'open' ? 'down' : 'up',
                        evidence: [{ role: 'runtime', status: phase === 'open' ? 'down' : 'up', source: 'native' }] }],
                    affectedMachineIds: phase === 'open' ? ['runtime-machine'] : [], edgeUnreachable: false,
                    authoritativeRecovery: phase === 'recovered' },
                healthPhase: phase, type: phase === 'open' ? 'blocked' : 'update' } });
    const selected = notice(detail.environment.id, 'selected-health');
    const other = notice('unrelated', 'other-health');
    const boundary = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
    for (const row of [selected, other]) boundary.replaceStoredRow(createPlainArtifactHttpFixture(row, scope.accountId));
    let failInventory = false;
    account.home.answer(home.serverId, 'GET /v1/artifacts', { select: async (_input, request) => {
        if (failInventory) return { status: 503, body: { error: 'artifact_content_unavailable' } };
        const url = new URL(request.url);
        const response = await boundary.handle(`${url.pathname}${url.search}`, { method: 'GET' });
        if (!response) throw new Error('Expected Artifact list boundary');
        return { body: await response.json() };
    } });
    const bodyRelease = createDeferred<void>();
    let bodyReads = 0;
    account.home.answer(home.serverId, 'POST /v1/artifacts/read', { select: async input => {
        bodyReads++;
        await bodyRelease.promise;
        const response = await boundary.handle('/v1/artifacts/read', { method: 'POST', body: JSON.stringify(input) });
        if (!response) throw new Error('Expected Artifact body boundary');
        return { body: await response.json() };
    } });
    let reads = 0;
    const transport: DeploymentReadTransportV1 = {
        listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
        readEnvironment: async () => { reads++; return { ok: true, value: detail }; },
        listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
        readReceipt: async () => ({ ok: false, failure: { code: 'not_demanded', retryable: false } }),
    };
    const controller = createDeploymentReadControllerV1({ scope: { ...scope, projectSourceId: detail.environment.projectSourceId }, transport });
    const renders = createRenderCommitCounter();
    const shown = { mounted: true, visible: true, focused: true };
    await act(async () => { storage.setState({ isDataReady: true }); });
    const hook = await renderHook((demand: DeploymentReadDemandV1) => {
        useRenderCommitCounter(renders);
        return useDeploymentEnvironment(controller, detail.environment.id, demand);
    }, { initialProps: shown, wrapper: ({ children }: Readonly<{ children?: React.ReactNode }>) => <InboxArtifactSourceBoundary>{children}</InboxArtifactSourceBoundary> });
    try {
        await vi.waitFor(() => expect(bodyReads).toBeGreaterThan(0));
        expect(hook.getCurrent().healthNotices).toMatchObject({ status: 'loading', items: [] });
        await act(async () => { bodyRelease.resolve(); });
        await vi.waitFor(() => expect(hook.getCurrent().healthNotices).toMatchObject({ status: 'ready', items: [
            { artifact: { id: selected.id }, header: { healthPhase: 'open', environmentHealth: { n: 1, down: 1 } } },
        ] }));
        renders.reset();
        const settledReads = reads;
        const first = hook.getCurrent().healthNotices;
        await act(async () => {
            for (let i = 4; i <= 23; i++) storage.getState().updateArtifact(notice('unrelated', other.id, i % 2 ? 'open' : 'recovered', i));
        });
        expect(renders.read()).toEqual({ renders: 0, commits: 0 });
        expect(reads).toBe(settledReads);
        expect(hook.getCurrent().healthNotices).toBe(first);
        await act(async () => { storage.getState().updateArtifact(notice(detail.environment.id, selected.id, 'recovered', 4)); });
        expect(hook.getCurrent().healthNotices.items[0]?.header.healthPhase).toBe('recovered');
        expect(hook.getCurrent().healthNotices.items[0]?.header.environmentHealth).toMatchObject({ authoritativeRecovery: true, down: 0 });
        expect(renders.read()).toEqual({ renders: 1, commits: 1 });
        renders.reset();
        await act(async () => {
            for (let i = 0; i < 20; i++) storage.getState().updateArtifact(notice(detail.environment.id, selected.id, 'recovered', 4));
        });
        expect(renders.read()).toEqual({ renders: 0, commits: 0 });
        await hook.rerender({ mounted: true, visible: false, focused: false });
        renders.reset();
        await act(async () => { storage.getState().updateArtifact(notice(detail.environment.id, selected.id, 'open', 5)); });
        expect(renders.read()).toEqual({ renders: 0, commits: 0 });
        await hook.rerender(shown);
        expect(hook.getCurrent().healthNotices.items[0]?.header.healthPhase).toBe('open');
        failInventory = true;
        await act(async () => { hook.getCurrent().healthNotices.retry(); });
        await vi.waitFor(() => expect(hook.getCurrent().healthNotices.status).toBe('unavailable'));
        expect(hook.getCurrent().healthNotices.items[0]?.artifact.id).toBe(selected.id);
        failInventory = false;
        await act(async () => { hook.getCurrent().healthNotices.retry(); });
        await vi.waitFor(() => expect(hook.getCurrent().healthNotices.status).toBe('ready'));
        await act(async () => { storage.getState().deleteArtifact(selected.id); });
        expect(hook.getCurrent().healthNotices).toMatchObject({ status: 'ready', items: [] });
        await act(async () => { storage.setState({ profileScope: { ...scope, accountId: 'another-account' } }); });
        expect(hook.getCurrent().healthNotices).toMatchObject({ status: 'unavailable', items: [] });
    } finally { bodyRelease.resolve(); await hook.unmount(); controller.retire(); }
});

it('withdraws hidden notice body demand, resumes exact hydration and ignores unrelated Artifact changes without writes', async () => {
    const home = await account.restore({ machines: [] });
    const scope = storage.getState().settingsScope!;
    const full = createAccountNoticeArtifactFixture({ ownerAccountId: scope.accountId, header: { type: 'blocked' } });
    const boundary = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
    boundary.replaceStoredRow(createPlainArtifactHttpFixture(full, scope.accountId));
    let bodyReads = 0;
    account.home.answer(home.serverId, 'GET /v1/artifacts', { select: async (_input, request) => {
        const url = new URL(request.url);
        const response = await boundary.handle(`${url.pathname}${url.search}`, { method: 'GET' });
        if (!response) throw new Error('Expected Artifact list boundary');
        return { body: await response.json() };
    } });
    account.home.answer(home.serverId, 'POST /v1/artifacts/read', { select: async input => {
        bodyReads++;
        const response = await boundary.handle('/v1/artifacts/read', { method: 'POST', body: JSON.stringify(input) });
        if (!response) throw new Error('Expected Artifact read boundary');
        return { body: await response.json() };
    } });
    const unrelated = Array.from({ length: 1000 }, (_, index) => ({ ...full, id: `unrelated-${index}`,
        header: { kind: 'markdown', title: 'Unrelated document' }, rawHeader: { kind: 'markdown', title: 'Unrelated document' }, body: 'Text' }));
    await act(async () => { storage.setState({ isDataReady: true });
        storage.getState().applyArtifacts([...unrelated, { ...full, sourceServerId: scope.serverId, body: undefined }]); });
    let items: ReturnType<typeof useInboxArtifactItems> | undefined;
    let source: ReturnType<typeof useInboxArtifactSource> | undefined;
    let publications = 0;
    function Probe() { items = useInboxArtifactItems(); source = useInboxArtifactSource(); publications++; return null; }
    const view = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active}>
        <InboxArtifactSourceBoundary><Probe /></InboxArtifactSourceBoundary>
    </PluginSurfaceFocusEligibilityProvider>;
    const screen = await renderScreen(view(false));
    await flushHookEffects();
    expect(bodyReads).toBe(0);
    await act(async () => { screen.update(view(true)); });
    await vi.waitFor(() => expect(items?.openAccountNotices.map(notice => notice.artifact.id)).toEqual([full.id]));
    await vi.waitFor(() => expect(source?.phase).toBe('current'));
    expect(bodyReads).toBe(1);
    const retained = items;
    const settled = publications;
    await act(async () => { storage.getState().updateArtifact({ ...unrelated[0]!, updatedAt: 9 }); });
    expect(items).toBe(retained);
    expect(publications).toBe(settled);
    expect(bodyReads).toBe(1);
    expect(storage.getState().artifacts[full.id]?.header?.readAt).toBeUndefined();
    expect(storage.getState().artifacts[full.id]?.header?.status).toBe('open');
    expect(rpc.state.requests).toHaveLength(0);
    await act(async () => { screen.unmount(); });
});

it('renders a count-only consumer when the Inbox count moves, not for every inbox-family Artifact write', async () => {
    await account.restore({ machines: [] });
    const scope = storage.getState().settingsScope!;
    const notice = (id: string, readAt?: number) => createAccountNoticeArtifactFixture({ id, ownerAccountId: scope.accountId,
        access: 'owner', publicAudience: 'none', header: { type: 'update', ...(readAt === undefined ? {} : { readAt }) } });
    await act(async () => { storage.setState({ isDataReady: true, profileScope: scope });
        storage.getState().applyArtifacts([notice('unread-1')]); });
    let count = -1;
    let publications = 0;
    function Probe() { count = useInboxArtifactOpenCount(); publications++; return null; }
    // Not presented: the shell source reads nothing from the network; only store writes drive this test.
    const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active={false}>
        <InboxArtifactSourceBoundary><Probe /></InboxArtifactSourceBoundary>
    </PluginSurfaceFocusEligibilityProvider>);
    await flushHookEffects();
    expect(count).toBe(1);
    const settled = publications;
    // New inbox-family rows that are already read: the item list changes, the count does not.
    await act(async () => { storage.getState().applyArtifacts([notice('read-1', 5), notice('read-2', 6)]); });
    expect(Object.keys(storage.getState().artifactInboxEntries)).toHaveLength(3);
    expect(count).toBe(1);
    expect(publications).toBe(settled);
    await act(async () => { storage.getState().applyArtifacts([notice('unread-2')]); });
    expect(count).toBe(2);
    expect(publications).toBe(settled + 1);
    await act(async () => { screen.unmount(); });
});

it('renders the hydration state once per page: no render for pending or for an empty request list', async () => {
    const home = await account.restore({ machines: [] });
    const scope = storage.getState().settingsScope!;
    const incomplete = createAccountNoticeArtifactFixture({ ownerAccountId: scope.accountId, access: 'owner',
        publicAudience: 'none', header: { type: 'blocked' } });
    const boundary = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
    boundary.replaceStoredRow(createPlainArtifactHttpFixture(incomplete, scope.accountId));
    const release = createDeferred<void>();
    let bodyReads = 0;
    account.home.answer(home.serverId, 'POST /v1/artifacts/read', { select: async input => {
        bodyReads++;
        await release.promise;
        const response = await boundary.handle('/v1/artifacts/read', { method: 'POST', body: JSON.stringify(input) });
        if (!response) throw new Error('Expected Artifact read boundary');
        return { body: await response.json() };
    } });
    await act(async () => { storage.setState({ isDataReady: true }); });
    const page = { [incomplete.id]: { ...incomplete, body: undefined } } as Record<string, typeof incomplete>;
    const renders = createRenderCommitCounter();
    const hook = await renderHook((rows: Record<string, typeof incomplete>) => {
        useRenderCommitCounter(renders);
        return useInboxArtifactBodyHydration(rows, scope.serverId, scope.accountId);
    }, { initialProps: page });
    try {
        await vi.waitFor(() => expect(bodyReads).toBe(1));
        expect(hook.getCurrent().pending).toBe(true);
        // Mount rendered once; the pending state is derived from the key, not stored by the effect.
        expect(renders.read().renders).toBe(1);
        await act(async () => { release.resolve(); });
        await vi.waitFor(() => expect(hook.getCurrent().pending).toBe(false));
        expect(renders.read().renders).toBe(2);
        // The page settled in the store and the request list empties: nothing about the hook changed.
        renders.reset();
        await hook.rerender({});
        expect(renders.read().renders).toBe(1);
        expect(hook.getCurrent()).toMatchObject({ pending: false, failed: false });
    } finally { release.resolve(); await hook.unmount(); }
});

// 10,500 is the observed cold-drain census (P03-INBOX2 lp4.json, 2026-11-02).
it.each([2000, 10_500])('applies an inventory page without re-sorting %i retained Inbox entries', async (retainedCount) => {
    await account.restore({ machines: [] });
    const scope = storage.getState().settingsScope!;
    const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId: 'drain-session' }, requestedSurface: 'agent',
        actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
    const header = buildApprovalRequestArtifactHeaderV1(request);
    const body = JSON.stringify(request);
    // Retained rows report reads of their order key and id. The real store, admission and Inbox
    // projection run unchanged; a read of a row outside the applied page is work on the retained Inbox.
    const page = new Set<string>();
    let counting = false;
    const retainedReads = { id: 0, updatedAt: 0 };
    const updatedAtById = new Map<string, number>();
    // A revision carries a new body revision (same request, different bytes), as a hydrated page does.
    const row = (index: number, bodyVersion = 1): DecryptedArtifact => {
        const id = `drain-${index}`;
        const updatedAt = (index * 7919) % 100_003;
        updatedAtById.set(id, updatedAt);
        const value: DecryptedArtifact = { id, title: 'List sessions', header,
            body: bodyVersion === 1 ? body : JSON.stringify(request, null, 1), headerVersion: 1, bodyVersion,
            seq: index, createdAt: updatedAt, updatedAt, isDecrypted: true, draft: false };
        const observe = (key: 'id' | 'updatedAt', fact: string | number) => Object.defineProperty(value, key, {
            enumerable: true, configurable: true,
            get() { if (counting && !page.has(id)) retainedReads[key]++; return fact; },
        });
        observe('id', id); observe('updatedAt', updatedAt);
        return value;
    };
    await act(async () => { storage.setState({ isDataReady: true, profileScope: scope }); });
    let items: ReturnType<typeof useInboxArtifactItems> | null = null;
    function Probe() { items = useInboxArtifactItems(); return null; }
    const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active={false}>
        <InboxArtifactSourceBoundary><Probe /></InboxArtifactSourceBoundary>
    </PluginSurfaceFocusEligibilityProvider>);
    const pageSize = 500;
    for (let start = 0; start < retainedCount; start += pageSize) {
        const rows = Array.from({ length: pageSize }, (_, offset) => row(start + offset));
        await act(async () => { storage.getState().applyArtifacts(rows); });
    }
    expect(items!.openApprovals).toHaveLength(retainedCount);
    const settledNotices = items!.accountNotices;
    const publications = storage.getState().artifactWorkflowPublicationArtifactsByRunId;
    // One drain step: ten new requests plus ten hydrated revisions of retained requests.
    const added = Array.from({ length: 10 }, (_, offset) => row(retainedCount + 1000 + offset));
    const revised = Array.from({ length: 10 }, (_, offset) => row(offset * 150, 2));
    for (const artifact of [...added, ...revised]) page.add(artifact.id);
    counting = true;
    await act(async () => { storage.getState().applyArtifacts([...added, ...revised]); });
    counting = false;
    console.info('Inbox page application cost', { retained: retainedCount, page: page.size, retainedReads });
    // This composed check rejects a retained-list re-sort. The owner test separately asserts
    // bounded retained visits per task, including the first reader and requested row window.
    expect(retainedReads.updatedAt).toBeLessThan(retainedCount);
    expect(retainedReads.id).toBeLessThanOrEqual(retainedCount + 40 * page.size);
    // The merged order is the complete newest-first order, and unchanged lists keep their identity.
    const expected = [...updatedAtById].sort((left, right) => right[1] - left[1]).map(([id]) => id);
    expect(items!.openApprovals.map(artifact => artifact.id)).toEqual(expected);
    expect(items!.openApprovals.find(artifact => artifact.id === revised[3]!.id)).toBe(storage.getState().artifacts[revised[3]!.id]);
    expect(items!.accountNotices).toBe(settledNotices);
    // Ordinary approvals never enter a Workflow Run's body-demand projection (FIN-PERF-RUN B1).
    expect(storage.getState().artifactWorkflowPublicationArtifactsByRunId).toBe(publications);
    expect(storage.getState().artifactUnclassifiedWorkflowPublicationArtifacts).toEqual({});
    await act(async () => { screen.unmount(); });
});

// P03-INBOX-BODIES: a cold shell summary reads header facts; approval bodies follow a presenting consumer.
async function seedColdInbox(approvalCount: number) {
    const home = await account.restore({ machines: [] });
    const scope = storage.getState().settingsScope!;
    const boundary = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
    const approvals = Array.from({ length: approvalCount }, (_, index): Extract<DecryptedArtifact, { isDecrypted: true }> => {
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: index + 1, updatedAtMs: index + 1,
            createdBy: { surface: 'agent', sessionId: `cold-session-${index}` }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: { note: 'x'.repeat(2000) }, summary: `List sessions ${index}` });
        const header = buildApprovalRequestArtifactHeaderV1(request);
        return { id: `cold-approval-${index}`, title: header.title, header, rawHeader: header, body: JSON.stringify(request),
            headerVersion: 1, bodyVersion: 1, seq: index, createdAt: index + 1, updatedAt: index + 1, isDecrypted: true, draft: false,
            ownerAccountId: scope.accountId, access: 'owner', publicAudience: 'none', sourceServerId: scope.serverId };
    });
    const notice = createAccountNoticeArtifactFixture({ id: 'cold-notice', ownerAccountId: scope.accountId, access: 'owner',
        publicAudience: 'none', header: { type: 'blocked' } });
    for (const row of [...approvals, notice]) boundary.replaceStoredRow(createPlainArtifactHttpFixture(row, scope.accountId));
    // Body bytes are the bytes of full (non-`headers` projection) reads.
    const reads = { approvalBodies: 0, noticeBodies: 0, bodyBytes: 0, headerReads: 0 };
    account.home.answer(home.serverId, 'POST /v1/artifacts/read', { select: async input => {
        const request = input as { artifactIds: string[]; projection?: 'headers' };
        if (request.projection === 'headers') reads.headerReads += request.artifactIds.length;
        else for (const id of request.artifactIds) {
            if (id.startsWith('cold-approval-')) reads.approvalBodies++; else reads.noticeBodies++;
        }
        const response = await boundary.handle('/v1/artifacts/read', { method: 'POST', body: JSON.stringify(input) });
        if (!response) throw new Error('Expected Artifact read boundary');
        const body = await response.json();
        if (request.projection !== 'headers') reads.bodyBytes += JSON.stringify(body).length;
        return { body };
    } });
    // The inventory page carries headers only, as the Home's kinds list does.
    await act(async () => { storage.setState({ isDataReady: true, profileScope: scope });
        storage.getState().applyArtifacts([...approvals, notice].map(row => ({ ...row, body: undefined }))); });
    return { reads, approvals, boundary };
}

it('counts a cold shell Inbox from header facts without reading any approval body', async () => {
    const { reads } = await seedColdInbox(20);
    let count = -1;
    let source: ReturnType<typeof useInboxArtifactSource> | undefined;
    function Badge() { count = useInboxArtifactOpenCount(); source = useInboxArtifactSource(); return null; }
    const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active>
        <InboxArtifactSourceBoundary><Badge /></InboxArtifactSourceBoundary>
    </PluginSurfaceFocusEligibilityProvider>);
    await vi.waitFor(() => expect(source?.phase).toBe('current'));
    await flushHookEffects();
    console.info('Cold shell Inbox body reads', JSON.stringify(reads));
    // 20 open approval headers plus one unread (blocked) notice.
    expect(count).toBe(21);
    expect(reads.approvalBodies).toBe(0);
    await act(async () => { screen.unmount(); });
});

it('reads approval bodies only while a presenting consumer is mounted, then keeps the count from headers', async () => {
    const { reads } = await seedColdInbox(20);
    let items: ReturnType<typeof useInboxArtifactItems> | undefined;
    let source: ReturnType<typeof useInboxArtifactSource> | undefined;
    function Badge() { source = useInboxArtifactSource(); return null; }
    function Rows() { useInboxArtifactBodyDemand(); items = useInboxArtifactItems(); return null; }
    const view = (open: boolean) => <PluginSurfaceFocusEligibilityProvider active>
        <InboxArtifactSourceBoundary><Badge />{open ? <Rows /> : null}</InboxArtifactSourceBoundary>
    </PluginSurfaceFocusEligibilityProvider>;
    const screen = await renderScreen(view(false));
    await vi.waitFor(() => expect(source?.phase).toBe('current'));
    expect(reads.approvalBodies).toBe(0);
    await act(async () => { screen.update(view(true)); });
    await vi.waitFor(() => expect(items?.openApprovals).toHaveLength(20));
    await vi.waitFor(() => expect(source?.phase).toBe('current'));
    expect(reads.approvalBodies).toBe(20);
    expect(items?.count).toBe(21);
    expect(items?.unreadApprovalBodies).toBe(0);
    await act(async () => { screen.update(view(false)); });
    await flushHookEffects();
    expect(reads.approvalBodies).toBe(20);
    await act(async () => { screen.unmount(); });
});

// P03-INBOX2: a Discussion list reads each request's Discussion from the approval header, never its body.
it('opens a Discussion list with its waiting requests without reading any approval body', async () => {
    const { reads, boundary } = await seedColdInbox(0);
    const scope = storage.getState().settingsScope!;
    const request = (index: number) => ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: index + 1, updatedAtMs: index + 1,
        createdBy: { surface: 'agent', sessionId: `disc-session-${index}` }, requestedSurface: 'agent',
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
            serverId: scope.serverId, accountId: scope.accountId, sessionId: `disc-session-${index}`,
            actionId: 'discussion.post', requestId: `disc-request-${index}` },
        actionId: 'discussion.post', ...(index === 0 ? { discussionDraftReview: true } : {}),
        actionArgs: { discussionId: 'discussion-1', localId: `local-${index}`, content: 'x'.repeat(2000) }, summary: `Post ${index}` });
    const rows = Array.from({ length: 20 }, (_, index): DecryptedArtifact => {
        const header = buildApprovalRequestArtifactHeaderV1(request(index));
        return { id: `cold-approval-disc-${index}`, title: header.title, header, rawHeader: header, body: undefined,
            headerVersion: 1, bodyVersion: 1, seq: index, createdAt: index + 1, updatedAt: index + 1, isDecrypted: true, draft: false,
            ownerAccountId: scope.accountId, access: 'owner', publicAudience: 'none', sourceServerId: scope.serverId };
    });
    rows.forEach((row, index) => boundary.replaceStoredRow(createPlainArtifactHttpFixture(
        { ...row, body: JSON.stringify(request(index)) } as Extract<DecryptedArtifact, { isDecrypted: true }>, scope.accountId)));
    await act(async () => { storage.getState().applyArtifacts(rows); });
    let listed: ReturnType<typeof useDiscussionListRows> | undefined;
    const items = [{ id: 'discussion-1', unreadMentionCount: 0 }] as unknown as Parameters<typeof useDiscussionListRows>[1];
    function List() { listed = useDiscussionListRows(scope, items); return null; }
    const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active>
        <InboxArtifactSourceBoundary><List /></InboxArtifactSourceBoundary>
    </PluginSurfaceFocusEligibilityProvider>);
    await vi.waitFor(() => expect(listed?.[0]?.approvalArtifactIds).toHaveLength(20));
    await flushHookEffects();
    console.info('Discussion list body reads', JSON.stringify(reads));
    expect(listed?.[0]).toMatchObject({ attentionReason: 'draft_waiting', attentionType: 'approval', waitingSessionId: 'disc-session-0' });
    expect(reads.approvalBodies).toBe(0);
    await act(async () => { screen.unmount(); });
});
