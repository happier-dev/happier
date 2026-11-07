import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { createWorkflowPublicationApprovalArtifact } from '@/dev/testkit/fixtures/workflowPublicationApprovalFixture';
import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import * as approvals from '@/sync/domains/artifacts/approvalArtifacts';
import { readOpenApprovalInboxEntry } from '@/sync/domains/artifacts/approvalArtifactAdmission';
import { buildInboxWorkGroups } from '@/activity/presentation/buildInboxWorkGroups';

const previous = storage.getState();
await initializeArtifactInventoryDemandHarness();
const { useWorkflowRunPublicationRequests } = await import('./useWorkflowRunPublicationRequests');
let fixture: Awaited<ReturnType<typeof createArtifactInventoryDemandHarness>>;
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); storage.setState(previous); });

it.each(['publication', 'invitation', 'external'] as const)('selects the exact Run before cold approval body demand (%s)', async requestKind => {
    fixture = await createArtifactInventoryDemandHarness();
    const scope = storage.getState().profileScope!;
    const own = createWorkflowPublicationApprovalArtifact({ id: '11111111-1111-4111-8111-999999999801',
        runId: 'run-a', scope, requestKind });
    const unrelated = Array.from({ length: 2_000 }, (_, index) => createWorkflowPublicationApprovalArtifact({
        id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, runId: 'run-b', scope, requestKind,
    }));
    fixture.inventory = [own, ...unrelated].map(row => createPlainArtifactHttpFixture(row, scope.accountId));
    const hook = await renderHook(() => useWorkflowRunPublicationRequests({ scope, runId: 'run-a', active: true }));
    await vi.waitFor(() => expect(hook.getCurrent().map(row => row.artifactId)).toEqual([own.id]));
    await fixture.settleInventory();
    expect(fixture.bodyReads.flat()).toEqual([own.id]);
    expect(fixture.pages.reduce((count, page) => count + page.headers, 0)).toBe(2_001);
    const selected = hook.getCurrent();
    await act(async () => storage.getState().updateArtifact({ ...unrelated[0]!, headerVersion: 2, bodyVersion: 2 }));
    expect(hook.getCurrent()).toBe(selected);
    expect(fixture.bodyReads.flat()).toEqual([own.id]);
    await act(async () => storage.getState().deleteArtifact(own.id));
    expect(hook.getCurrent()).toEqual([]);
});

it.each(['publication', 'invitation', 'external'] as const)('discovers legacy Run relationships once at the Artifact owner (%s)', async requestKind => {
    fixture = await createArtifactInventoryDemandHarness();
    const scope = storage.getState().profileScope!;
    const own = createWorkflowPublicationApprovalArtifact({ id: '11111111-1111-4111-8111-999999999821',
        runId: 'run-a', scope, requestKind });
    const other = createWorkflowPublicationApprovalArtifact({ id: '11111111-1111-4111-8111-999999999822',
        runId: 'run-b', scope, requestKind });
    const legacy = [own, other].map(row => {
        const { workflowRunId: _relation, ...header } = row.header!;
        return { ...row, header };
    });
    fixture.inventory = legacy.map(row => createPlainArtifactHttpFixture(row, scope.accountId));
    let runId = 'run-a';
    const hook = await renderHook(() => useWorkflowRunPublicationRequests({ scope, runId, active: true }));
    await vi.waitFor(() => expect(hook.getCurrent().map(row => row.artifactId)).toEqual([own.id]));
    await vi.waitFor(() => expect(typeof storage.getState().artifacts[other.id]?.body).toBe('string'));
    expect(fixture.bodyReads.flat().sort()).toEqual([own.id, other.id].sort());
    const selected = hook.getCurrent();
    const openedOther = storage.getState().artifacts[other.id]!;
    await act(async () => storage.getState().updateArtifact({ ...openedOther, headerVersion: 2, bodyVersion: 2 }));
    expect(hook.getCurrent()).toBe(selected);
    runId = 'run-b';
    await hook.rerender();
    expect(hook.getCurrent().map(row => row.artifactId)).toEqual([other.id]);
    expect(fixture.bodyReads.flat()).toHaveLength(2);
});

it('hydrates cold publications from the inventory Home before learning portable header identity', async () => {
    fixture = await createArtifactInventoryDemandHarness();
    const scope = storage.getState().profileScope!;
    const portableId = 'portable-workflow-publication-home';
    const own = createWorkflowPublicationApprovalArtifact({ id: '11111111-1111-4111-8111-999999999811',
        runId: 'run-a', scope: { ...scope, serverId: portableId } });
    const wrongHome = createWorkflowPublicationApprovalArtifact({ id: '11111111-1111-4111-8111-999999999812',
        runId: 'run-a', scope: { ...scope, serverId: 'foreign-publication-home' } });
    fixture.inventory = [own, wrongHome].map(row => createPlainArtifactHttpFixture(row, scope.accountId));
    const hook = await renderHook(() => useWorkflowRunPublicationRequests({ scope, runId: 'run-a', active: true }));
    await vi.waitFor(() => expect(typeof storage.getState().artifacts[own.id]?.body === 'string').toBe(true));
    expect(hook.getCurrent()).toEqual([]);
    const opened = storage.getState().artifacts[own.id];
    const foreign = storage.getState().artifacts[wrongHome.id];
    expect(opened && approvals.readOpenWorkflowPublicationApprovalId(opened, { serverId: portableId, runId: 'run-a' })).toBe(own.id);
    expect(foreign && approvals.readOpenWorkflowPublicationApprovalId(foreign, { serverId: portableId, runId: 'run-a' })).toBeNull();
    expect(fixture.bodyReads.flat().filter(id => id === own.id)).toHaveLength(1);
});

it.each(['publication', 'invitation', 'external'] as const)('FIX249 discovers exact Run requests without unrelated reads (%s)', async requestKind => {
    fixture = await createArtifactInventoryDemandHarness();
    const scope = storage.getState().profileScope!;
    const own = createWorkflowPublicationApprovalArtifact({ id: 'own-publication', runId: 'run-a', scope, requestKind });
    const other = createWorkflowPublicationApprovalArtifact({ id: 'other-publication', runId: 'run-b', scope, requestKind });
    fixture.inventory = [own, other].map(row => createPlainArtifactHttpFixture(row, scope.accountId));
    const ownHeader = own.header;
    const ownBody = own.body;
    if (!ownHeader || typeof ownBody !== 'string') throw new Error('Expected an opened approval fixture');
    const documents = Array.from({ length: 2_000 }, (_, index) => ({ ...own, id: `document-${index}`,
        header: { kind: 'markdown', title: 'Document' }, body: 'Document' }));
    storage.setState({ isDataReady: true, profileScope: scope, artifacts: {} });
    storage.getState().applyArtifacts([...documents, own, other]);
    let active = true;
    const hook = await renderHook(() => useWorkflowRunPublicationRequests({ scope, runId: 'run-a', active }));
    expect(hook.getCurrent()).toEqual([{ artifactId: own.id,
        href: buildApprovalHref(own.id, scope.serverId, createWorkflowRunRoute('run-a', scope.serverId)) }]);
    expect(storage.getState().artifacts[own.id]?.body).toBe(own.body);
    // FIN-PERF-RUN B1: a scoped header refresh never demands another Run's body.
    expect(fixture.bodyReads.flat()).not.toContain(other.id);
    const selected = hook.getCurrent();
    const inbox = buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [], automationRuns: [],
        automationServerId: null, openApprovals: [readOpenApprovalInboxEntry(own)!],
        stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null });
    expect(inbox.flatMap(group => group.items.flatMap(item => item.kind === 'approval' ? [item.artifact.id] : []))).toEqual([own.id]);
    const bodyReadCount = fixture.bodyReads.flat().length;
    // Observe the real projection without replacing its behavior. Unrelated
    // updates must trigger neither admission work nor new navigation records.
    const reads = vi.spyOn(approvals, 'readOpenWorkflowPublicationApprovalId');
    try {
        await act(async () => {
            for (let index = 0; index < 100; index++) storage.getState().addArtifact({
                ...own, id: `unrelated-${index}`, header: { kind: 'markdown', title: 'Unrelated' }, body: 'Document',
            });
        });
        expect(reads).toHaveBeenCalledTimes(0);
    } finally { reads.mockRestore(); }
    expect(hook.getCurrent()).toBe(selected);
    expect(fixture.bodyReads.flat()).toHaveLength(bodyReadCount);
    active = false;
    await hook.rerender();
    expect(hook.getCurrent()).toEqual([]);
    active = true;
    await hook.rerender();
    expect(hook.getCurrent()).toEqual(selected);
    const closedRequest = (requestKind === 'external' ? TargetActionApprovalRequestV1Schema : ApprovalRequestV2Schema).parse({ ...JSON.parse(ownBody), status: 'rejected',
        decision: { kind: 'reject', decidedAtMs: 2 }, updatedAtMs: 2 });
    const closed = { ...own, headerVersion: 2, bodyVersion: 2,
        header: 'qualifiedActionId' in closedRequest ? buildTargetActionApprovalArtifactHeaderV1(closedRequest) : buildApprovalRequestArtifactHeaderV1(closedRequest), body: JSON.stringify(closedRequest) };
    await act(async () => storage.getState().updateArtifact(closed));
    expect(hook.getCurrent()).toEqual([]);
    const wrongHome = { ...own, headerVersion: 3, bodyVersion: 3,
        header: { ...ownHeader, serverId: 'other-home', serverIdentityId: 'other-home' } };
    await act(async () => storage.getState().updateArtifact(wrongHome));
    expect(hook.getCurrent()).toEqual([]);
    await act(async () => storage.getState().deleteArtifact(own.id));
    expect(hook.getCurrent()).toEqual([]);
    await act(async () => storage.getState().addArtifact({ ...own, headerVersion: 4, bodyVersion: 4 }));
    expect(hook.getCurrent()).toHaveLength(1);
    await act(async () => storage.setState({ profileScope: { ...scope, accountId: 'another-account' } }));
    expect(hook.getCurrent()).toEqual([]);
});
