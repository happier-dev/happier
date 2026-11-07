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
    expect(storage.getState().artifacts[other.id]?.body).toBe(other.body);
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
