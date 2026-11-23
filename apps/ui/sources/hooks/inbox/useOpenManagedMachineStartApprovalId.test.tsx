import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { MANAGED_DELETE_ACTION_ID_V1, MANAGED_POWER_SET_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import type { UpdateContainer } from '@happier-dev/protocol/updates';
import { act, createRenderCommitCounter, renderScreen, useRenderCommitCounter } from '@/dev/testkit';
import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';
import { createArtifactStoreBoundary, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

await initializeArtifactInventoryDemandHarness();

it('uses a single header query and follows only the selected Machine’s open approvals through reconnect', async () => {
    const fixture = await createArtifactInventoryDemandHarness();
    const { storage } = await import('@/sync/domains/state/storage');
    const { sync } = await import('@/sync/sync');
    const { useOpenManagedMachineStartApprovalId, useOpenManagedMachineApprovalIds } = await import('./useOpenManagedMachineStartApprovalId');
    const scope = storage.getState().settingsScope!;
    const machine = { homeId: 'managed-home', managedId: 'selected-machine' };
    const boundary = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
    fixture.artifactStore = boundary;
    const approval = (n: number, managedId: string, intent: 'start' | 'stop' | 'delete', options: Readonly<{
        status?: 'open' | 'rejected'; version?: number; ownerAccountId?: string;
    }> = {}): Extract<DecryptedArtifact, { isDecrypted: true }> => {
        const id = `11111111-1111-4111-8111-99999999990${n}`;
        const { status = 'open', version = 1, ownerAccountId = scope.accountId } = options;
        const actionId = intent === 'delete' ? MANAGED_DELETE_ACTION_ID_V1 : MANAGED_POWER_SET_ACTION_ID_V1;
        const request = ApprovalRequestV2Schema.parse({
            v: 2, status, createdAtMs: n, updatedAtMs: n + version, createdBy: { surface: 'agent' },
            requestedSurface: 'agent', executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
                caller: { kind: 'host' }, serverId: scope.serverId, accountId: ownerAccountId, actionId, requestId: id },
            actionId, actionArgs: { ...machine, managedId, intent, when: 'now', expectedRevision: 1,
                ...(intent === 'delete' ? { reviewedDependencies: true } : {}) },
            ...(status === 'rejected' ? { decision: { kind: 'reject', decidedAtMs: n + version } } : {}),
            summary: 'Set Machine power',
        });
        const header = buildApprovalRequestArtifactHeaderV1(request);
        return { id, header, rawHeader: header, title: header.title, body: JSON.stringify(request), isDecrypted: true,
            headerVersion: version, bodyVersion: version, seq: version, updatedAt: n + version, createdAt: n,
            ownerAccountId, access: 'owner', publicAudience: 'none', sourceServerId: scope.serverId };
    };
    const seed = (row: ReturnType<typeof approval>) => {
        const wire = createPlainArtifactHttpFixture(row, scope.accountId);
        boundary.replaceStoredRow(wire);
        return wire;
    };
    const own = approval(1, machine.managedId, 'start');
    const unrelated = approval(2, 'other-machine', 'start');
    const stop = approval(3, machine.managedId, 'stop');
    const otherAccount = approval(4, machine.managedId, 'start', { ownerAccountId: 'another-account' });
    const deletion = approval(5, machine.managedId, 'delete');
    const legacy = approval(6, machine.managedId, 'start');
    const { subjectIndexKey: _hint, approvalSubjectKey: _key, ...oldHeader } = legacy.header!;
    seed({ ...legacy, header: oldHeader, rawHeader: oldHeader });
    for (const row of [own, unrelated, stop, otherAccount, deletion]) seed(row);

    const renders = createRenderCommitCounter();
    let startId: string | null = null;
    let deleteId: string | null = null;
    function StartProbe() {
        useRenderCommitCounter(renders);
        startId = useOpenManagedMachineStartApprovalId(machine);
        return null;
    }
    function DetailProbe() {
        const ids = useOpenManagedMachineApprovalIds(scope.serverId, machine, true);
        startId = ids.startId;
        deleteId = ids.deleteId;
        return null;
    }
    let sequence = 0;
    const publish = (body: UpdateContainer['body']) => {
        const socket = fixture.network.socketBoundaries.find(boundary => boundary.socket.onAny.mock.calls.length > 0);
        if (!socket) throw new Error('Expected the active Account Socket.IO transport');
        sequence += 1;
        socket.trigger('update', { id: `approval-publication-${sequence}`, seq: sequence, createdAt: sequence, body } satisfies UpdateContainer);
    };
    const publishNew = (row: ReturnType<typeof approval>) => {
        const wire = seed(row);
        if (typeof wire.body !== 'string' || wire.bodyVersion === undefined) throw new Error('Expected the stored approval body revision on the create event');
        publish({ t: 'new-artifact', artifactId: wire.id, seq: wire.seq, header: wire.header,
            headerVersion: wire.headerVersion, body: wire.body, bodyVersion: wire.bodyVersion,
            dataEncryptionKey: wire.dataEncryptionKey, createdAt: wire.createdAt, updatedAt: wire.updatedAt });
    };
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        screen = await renderScreen(<StartProbe />);
        await act(async () => { await fixture.settleInventory(); });
        expect(startId).toBe(own.id);
        expect(fixture.pages).toEqual([{ kinds: expect.stringContaining('approval_request.v1#managed-power:'), headers: 1 }]);
        expect(fixture.headerReads).toEqual([]);
        expect(fixture.bodyReads).toEqual([]);

        const settled = seed(approval(1, machine.managedId, 'start', { status: 'rejected', version: 2 }));
        await act(async () => {
            publish({ t: 'update-artifact', artifactId: settled.id, header: { version: settled.headerVersion, value: settled.header } });
        });
        await vi.waitFor(() => expect(startId).toBeNull());

        // The still-mounted reader receives committed create and update events on the real socket ingress.
        const published = approval(7, machine.managedId, 'start');
        await act(async () => { publishNew(published); });
        await vi.waitFor(() => expect(startId).toBe(published.id));
        renders.reset();
        const unrelatedPublication = approval(9, 'other-machine', 'start');
        await act(async () => {
            publishNew(unrelatedPublication);
            await vi.waitFor(() => expect(storage.getState().artifacts[unrelatedPublication.id]).toBeDefined());
        });
        expect(renders.read().renders).toBe(0);
        expect(fixture.pages).toHaveLength(1);
        expect(fixture.headerReads).toEqual([]);

        // Settlement missed while disconnected is reconciled by the still-mounted subject query.
        seed(approval(7, machine.managedId, 'start', { status: 'rejected', version: 2 }));
        fixture.currentCursor = 200;
        fixture.cursorGone = true;
        await act(async () => { await sync.resumeSync('socket-reconnect'); });
        await vi.waitFor(() => expect(startId).toBeNull());
        expect(storage.getState().artifacts[published.id]?.header?.approvalStatus).toBe('rejected');

        const reopened = approval(8, machine.managedId, 'start');
        seed(reopened);
        fixture.currentCursor = 300;
        fixture.cursorGone = true;
        await act(async () => { await sync.resumeSync('socket-reconnect'); });
        await vi.waitFor(() => expect(startId).toBe(reopened.id));
        const beforeDetail = fixture.pages.length;
        await screen.unmount();
        screen = await renderScreen(<DetailProbe />);
        await vi.waitFor(() => expect(deleteId).toBe(deletion.id));
        expect(startId).toBe(reopened.id);
        expect(fixture.pages.slice(beforeDetail)).toEqual([{
            kinds: expect.stringMatching(/managed-delete:.*managed-power:/), headers: 2,
        }]);
        expect(fixture.pages.every(page => page.kinds?.includes('approval_request.v1#'))).toBe(true);
        expect(fixture.bodyReads).toEqual([]);
        expect(fixture.exactReads).toEqual([]);
    } finally {
        await screen?.unmount();
        await fixture.dispose();
    }
}, 120_000);
