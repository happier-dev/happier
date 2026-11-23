import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1, deriveProjectServiceStartApprovalSubjectKeyV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { approvalArtifactSubjectIndexedKindV1, deriveApprovalArtifactQueryHintsV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { deriveArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
await initializeArtifactInventoryDemandHarness();

describe('Project Source pending Start acquisition', () => {
  let fixture: Awaited<ReturnType<typeof createArtifactInventoryDemandHarness>>;
  afterEach(async () => { await fixture?.dispose(); vi.restoreAllMocks(); });

  it.each([true, false])('keeps independent pending Starts and scoped costs (pending=%s)', async (pending) => {
    fixture = await createArtifactInventoryDemandHarness();
    const { storage } = await import('@/sync/domains/state/storage');
    const { decryptArtifactListItems } = await import('@/sync/engine/artifacts/syncArtifacts');
    const { ProjectServicePlacementObservationProvider, useProjectServicePlacementObservation } = await import('./projectServicePlacementObservation');
    const scope = storage.getState().profileScope!;
    const source = { serverId: scope.serverId, machineId: 'source-machine', refId: 'source-checkout' };
    const wire = (index: number, matching: boolean, serviceName = 'server') => {
      const workspace = { serverId: scope.serverId, machineId: source.machineId,
        workspaceId: matching ? source.refId : `unrelated-${index}`, rootPath: '/source' };
      const request = { machineId: 'worker-machine', targetId: 'server', workspace,
        declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest', name: serviceName } } };
      const approval = ApprovalRequestV2Schema.parse({ v: 2, status: index === 1 ? 'executing' : 'approved', createdAtMs: 1, updatedAtMs: 2,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'localServices.launcher.start', actionArgs: request,
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' }, serverId: scope.serverId,
          accountId: scope.accountId, actionId: 'localServices.launcher.start', requestId: `start-${index}`, machineId: 'worker-machine' },
        summary: 'Start server', decision: { kind: 'approve', decidedAtMs: 2 }, preview: { serviceStartReview: {
          request, target: { ...workspace, machineId: 'worker-machine', workspaceId: 'worker-checkout', rootPath: '/worker' },
          reviewedEffectDigest: 'a'.repeat(64), reviewedEffect: {}, setup: { required: false,
            project: { serverId: scope.serverId, projectId: 'project' }, reviewedEffectDigest: 'b'.repeat(64), reviewedEffect: {} },
        } } });
      const header = buildApprovalRequestArtifactHeaderV1(approval);
      return { ...fixture.inventory[0]!, ...deriveArtifactKindV1(header), ...deriveApprovalArtifactQueryHintsV1(header),
        id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) };
    };
    fixture.inventory = Array.from({ length: 1002 }, (_, index) => wire(index, pending && index < 2, index === 1 ? 'worker' : 'server'));
    fixture.pages.length = 0; fixture.bodyReads.length = 0; fixture.headerReads.length = 0; fixture.exactReads.length = 0;
    let renders = 0;
    let active = false;
    let workerActive = false;
    const frames: boolean[] = [];
    function Reader() {
      renders++;
      active = useProjectServicePlacementObservation('server', undefined, { absent: true }).active;
      workerActive = useProjectServicePlacementObservation('worker', undefined, { absent: true }).active;
      frames.push(active && workerActive);
      return null;
    }
    const screen = await renderScreen(<ProjectServicePlacementObservationProvider source={source}><Reader /></ProjectServicePlacementObservationProvider>);
    try {
      await fixture.settleInventory();
      await vi.waitFor(() => expect(active).toBe(pending));
      const subject = deriveProjectServiceStartApprovalSubjectKeyV1(source);
      console.log('Project Source cold cost', JSON.stringify({ pages: fixture.pages, bodies: fixture.bodyReads, exactBodies: fixture.exactReads }));
      expect(fixture.pages).toEqual([{ kinds: JSON.stringify([approvalArtifactSubjectIndexedKindV1(subject)]), headers: pending ? 2 : 0 }]);
      expect(workerActive).toBe(pending);
      expect(fixture.headerReads).toEqual([]);
      expect(fixture.bodyReads).toEqual([]);
      expect(fixture.exactReads).toEqual([]);
      const unrelated = (await decryptArtifactListItems({ artifacts: [wire(1002, false)], encryption: null, artifactDataKeys: new Map() }))[0]!;
      const before = renders;
      await act(async () => { storage.getState().updateArtifact(unrelated); });
      expect(renders - before).toBe(0);
      expect(fixture.pages).toHaveLength(1);
      const entered = createDeferred<void>(), release = createDeferred<void>();
      fixture.holdList = async () => { entered.resolve(); await release.promise; };
      const refreshFramesStart = frames.length;
      const refresh = fixture.recoverSnapshot();
      try {
        await entered.promise;
        expect(active).toBe(pending);
      } finally { release.resolve(); }
      await refresh;
      await fixture.settleInventory();
      expect(active).toBe(pending);
      expect(frames.slice(refreshFramesStart).every(value => value === pending)).toBe(true);
      expect(workerActive).toBe(pending);
      expect(fixture.bodyReads).toEqual([]);
      expect(fixture.exactReads).toEqual([]);
      if (!pending) return;
      const changed = (await decryptArtifactListItems({ artifacts: [wire(0, true, 'next-service')], encryption: null,
        artifactDataKeys: new Map() }))[0]!;
      const beforeRelevant = renders;
      await act(async () => { storage.getState().updateArtifact(changed); });
      expect(active).toBe(false);
      expect(workerActive).toBe(true);
      expect(renders - beforeRelevant).toBe(1);
    } finally { await screen.unmount(); }
  });
});
