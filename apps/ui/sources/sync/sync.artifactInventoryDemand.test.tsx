import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeferred, invokeTestInstanceHandler, renderHook, renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { createAccountNoticeArtifactFixture, createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { ApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1, APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ACCOUNT_NOTICE_ARTIFACT_KIND_V1, USAGE_NOTICE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';
import { createArtifactStoreBoundary, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import type { Artifact } from './domains/artifacts/artifactTypes';
import type { InboxSummary } from '@/hooks/inbox/useInboxSummary';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { INBOX_ARTIFACT_KINDS } from './domains/artifacts/inboxArtifacts';
import { deriveApprovalArtifactQueryHintsV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { createWorkflowPublicationApprovalArtifact } from '@/dev/testkit/fixtures/workflowPublicationApprovalFixture';
import { isArtifactInventoryReady } from './domains/artifacts/artifactInventory';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

await initializeArtifactInventoryDemandHarness();
// Warm the real Browser graph outside the per-test interaction budget.
const { ArtifactsBrowserScreen } = await import('@/components/artifacts/ArtifactsBrowserScreen');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');

describe('Sync mounted Artifact inventory demand', () => {
    let fixture: Awaited<ReturnType<typeof createArtifactInventoryDemandHarness>>;
    beforeEach(async () => { fixture = await createArtifactInventoryDemandHarness(); });
    afterEach(async () => { await fixture?.dispose(); vi.restoreAllMocks(); });

    it.each(['closed', 'open'] as const)('keeps mounted Discussion attention demand out of 42856 retained receipts at 43399 approval scale with %s Inbox', async presentation => {
        const { storage } = await import('./domains/state/storage');
        const { decryptArtifactListItems } = await import('./engine/artifacts/syncArtifacts');
        const { useDiscussionListRows } = await import('./ops/discussions/useDiscussionListRows');
        const { InboxSummaryProvider, useSharedInboxSummary } = await import('@/hooks/inbox/useInboxSummary');
        const { InboxModelProvider, useInboxModel } = await import('@/hooks/inbox/useInboxModel');
        const scope = storage.getState().profileScope!;
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'Attention demand' });
        const closed = ApprovalRequestV1Schema.parse({ ...request, status: 'rejected', updatedAtMs: 2,
            decision: { kind: 'reject', decidedAtMs: 2 } });
        const wire = (value: typeof request): Artifact => {
            const header = buildApprovalRequestArtifactHeaderV1(value, { legacyServerId: scope.serverId });
            return { ...fixture.inventory[0]!, kindHint: APPROVAL_ARTIFACT_KINDS_V1.builtIn,
                ...deriveApprovalArtifactQueryHintsV1(header), header: encodePlainArtifactStoredContent(header),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(value) }) };
        };
        const settledWire = wire(closed), openWire = wire(request);
        const prototype = (await decryptArtifactListItems({ artifacts: [settledWire], encryption: null, artifactDataKeys: new Map() }))[0]!;
        const retained = Array.from({ length: 42_856 }, (_, index) => ({ ...prototype,
            id: `11111111-1111-4111-8111-8${String(index).padStart(11, '0')}` }));
        storage.getState().applyArtifacts(retained);
        fixture.inventory = [...retained.map(row => ({ ...settledWire, id: row.id })),
            ...Array.from({ length: 543 }, (_, index) => ({ ...openWire,
                id: `11111111-1111-4111-8111-9${String(index).padStart(11, '0')}` }))];
        const counts = { header: 0, rawHeader: 0, body: 0 };
        for (const row of retained) for (const field of ['header', 'rawHeader', 'body'] as const) {
            const value = row[field];
            Object.defineProperty(row, field, { configurable: true, enumerable: true, get() { counts[field]++; return value; } });
        }
        fixture.pages.length = 0; fixture.bodyReads.length = 0; fixture.headerReads.length = 0;
        let summary!: InboxSummary;
        const items: readonly import('@happier-dev/protocol/discussions/actions').DiscussionOpenedSummaryV1[] = [];
        function Attention() { useDiscussionListRows(scope, items); summary = useSharedInboxSummary(); return null; }
        function Model() { useInboxModel(); return null; }
        const screen = await renderScreen(<InboxSummaryProvider><Attention />
            {presentation === 'open' && <InboxModelProvider><Model /></InboxModelProvider>}
        </InboxSummaryProvider>);
        try {
            await vi.waitFor(() => expect(summary.count).toBe(543));
            await fixture.settleInventory();
            console.log('R43t mounted Discussion demand counts', JSON.stringify({ counts,
                returnedHeaders: fixture.pages.reduce((sum, page) => sum + page.headers, 0), pages: fixture.pages,
                bodyIds: fixture.bodyReads.flat().length }));
            expect(counts).toEqual({ header: 0, rawHeader: 0, body: 0 });
            expect(fixture.pages.every(page => page.headers <= 543)).toBe(true);
            expect(fixture.bodyReads.flat().every(id => id.startsWith('11111111-1111-4111-8111-9'))).toBe(true);
            const changed = fixture.inventory.at(-1)!;
            const unaffectedOpenReads = { header: 0, rawHeader: 0, body: 0 };
            for (const wire of fixture.inventory.slice(-543, -1)) {
                const row = storage.getState().artifacts[wire.id]!;
                for (const field of ['header', 'rawHeader', 'body'] as const) {
                    const value = row[field];
                    Object.defineProperty(row, field, { configurable: true, enumerable: true,
                        get() { unaffectedOpenReads[field]++; return value; } });
                }
            }
            const settled = { ...settledWire, id: changed.id, headerVersion: changed.headerVersion + 1,
                bodyVersion: changed.bodyVersion! + 1 };
            const decoded = (await decryptArtifactListItems({ artifacts: [settled], encryption: null, artifactDataKeys: new Map() }))[0]!;
            fixture.pages.length = 0; fixture.headerReads.length = 0; fixture.bodyReads.length = 0;
            await act(async () => storage.getState().updateArtifact(decoded));
            await vi.waitFor(() => expect(summary.count).toBe(542));
            console.log('R43t settlement unaffected open reads', JSON.stringify({ reads: unaffectedOpenReads,
                pages: fixture.pages.length, headers: fixture.headerReads, bodies: fixture.bodyReads }));
            expect(unaffectedOpenReads).toEqual({ header: 0, rawHeader: 0, body: 0 });
            expect(fixture.pages).toEqual([]);
            expect(fixture.headerReads).toEqual([]);
            expect(fixture.bodyReads).toEqual([]);
        } finally { await screen.unmount(); }
    }, 120_000);

    it('reconciles a Post settlement census without revisiting 43331 retained approvals or opening their bodies', async () => {
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        const { decryptArtifactListItems } = await import('./engine/artifacts/syncArtifacts');
        const { InboxSummaryProvider, useSharedInboxSummary } = await import('@/hooks/inbox/useInboxSummary');
        const scope = storage.getState().profileScope!;
        const open = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'post-session' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'Post cost control' });
        const rejected = ApprovalRequestV1Schema.parse({ ...open, status: 'rejected', updatedAtMs: 2,
            decision: { kind: 'reject', decidedAtMs: 2 } });
        const header = buildApprovalRequestArtifactHeaderV1({ ...rejected, createdBy: { surface: 'agent' } },
            { legacyServerId: scope.serverId });
        const prototype = (await decryptArtifactListItems({ artifacts: [{ ...fixture.inventory[0]!,
            kindHint: APPROVAL_ARTIFACT_KINDS_V1.builtIn, header: encodePlainArtifactStoredContent(header),
        }], encryption: null, artifactDataKeys: new Map() }))[0]!;
        const retained = Array.from({ length: 43_331 }, (_, index) => ({ ...prototype,
            id: `11111111-1111-4111-8111-8${String(index).padStart(11, '0')}` }));
        storage.getState().applyArtifacts(retained);
        const selectedId = '11111111-1111-4111-8111-900000000000';
        const selected = (request: typeof open): Artifact => {
            const selectedHeader = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: scope.serverId });
            return { ...fixture.inventory[0]!, id: selectedId, kindHint: APPROVAL_ARTIFACT_KINDS_V1.builtIn,
                ...deriveApprovalArtifactQueryHintsV1(selectedHeader), header: encodePlainArtifactStoredContent(selectedHeader),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
                headerVersion: request.status === 'open' ? 1 : 2, bodyVersion: request.status === 'open' ? 1 : 2 };
        };
        fixture.inventory = [selected(open)];
        let summary!: InboxSummary;
        function Summary() { summary = useSharedInboxSummary(); return null; }
        const screen = await renderScreen(<InboxSummaryProvider><Summary /></InboxSummaryProvider>);
        try {
            await vi.waitFor(() => expect(summary.count).toBe(1));
            await fixture.settleInventory();
            const counts = { header: 0, rawHeader: 0, body: 0 };
            const stacks = new Map<string, number>();
            // Transparent property counters observe the real owner's reads, not a mocked selector.
            for (const row of retained) for (const field of ['header', 'rawHeader', 'body'] as const) {
                const value = row[field];
                Object.defineProperty(row, field, { configurable: true, enumerable: true, get() {
                    counts[field]++;
                    if (row === retained[0]) {
                        const stack = `${field}: ${new Error().stack?.split('\n').slice(2, 7).join(' | ')}`;
                        stacks.set(stack, (stacks.get(stack) ?? 0) + 1);
                    }
                    return value;
                } });
            }
            fixture.pages.length = 0; fixture.bodyReads.length = 0; fixture.headerReads.length = 0;
            // The Post changes one request. Its next open-membership response omits
            // the settled id; the query owner must reconcile that exact id, not history.
            fixture.inventory = [selected(rejected)];
            await act(async () => { await sync.fetchArtifactsList({ selection: 'inboxOpen' }); });
            await fixture.settleInventory();
            await vi.waitFor(() => expect(summary.count).toBe(0));
            expect(storage.getState().artifacts[selectedId]?.header?.approvalStatus).toBe('rejected');
            expect(Object.keys(storage.getState().artifacts)).toHaveLength(43_332);
            console.log('R43q Post census retained-property counts', JSON.stringify({ counts,
                pages: fixture.pages.length, headers: fixture.headerReads, bodies: fixture.bodyReads, stacks: [...stacks] }));
            expect(counts).toEqual({ header: 0, rawHeader: 0, body: 0 });
            expect(fixture.pages).toHaveLength(1);
            expect(fixture.headerReads).toEqual([[selectedId]]);
            expect(fixture.bodyReads).toEqual([]);
        } finally { await screen.unmount(); }
    }, 120_000);

    it('does no Inbox classification or hydration work for unrelated admitted Artifact arrivals, closed or open', async () => {
        const { storage } = await import('./domains/state/storage');
        const { InboxSummaryProvider, useSharedInboxSummary } = await import('@/hooks/inbox/useInboxSummary');
        const { InboxModelProvider, useInboxModel } = await import('@/hooks/inbox/useInboxModel');
        const inbox = await import('./domains/artifacts/inboxArtifacts');
        const notices = await import('./domains/artifacts/usageNoticeArtifacts');
        const scope = storage.getState().profileScope!;
        const notice = createAccountNoticeArtifactFixture({ id: '11111111-1111-4111-8111-999999999750', ownerAccountId: scope.accountId });
        fixture.inventory = [createPlainArtifactHttpFixture(notice, scope.accountId)];
        const unrelated = Array.from({ length: 3500 }, (_, index) => ({ ...notice, id: `unrelated-${index}`,
            header: { kind: 'markdown', title: 'Document' }, rawHeader: { kind: 'markdown', title: 'Document' }, body: 'Document' }));
        storage.getState().applyArtifacts(unrelated);
        let summary!: InboxSummary, model!: InboxModel;
        let setOpen!: React.Dispatch<React.SetStateAction<boolean>>;
        function Summary() { summary = useSharedInboxSummary(); return null; }
        function Model() { model = useInboxModel(); return null; }
        function Surface() {
            const [open, updateOpen] = React.useState(false);
            setOpen = updateOpen;
            return <InboxSummaryProvider><Summary />{open && <InboxModelProvider><Model /></InboxModelProvider>}</InboxSummaryProvider>;
        }
        const screen = await renderScreen(<Surface />);
        try {
            await vi.waitFor(() => expect(summary).toEqual({ count: 1, hasContent: true }));
            await fixture.settleInventory();
            const hydration = vi.spyOn(inbox, 'listInboxArtifactBodyHydrationRequests');
            const completeness = vi.spyOn(inbox, 'isInboxArtifactBodyAdmissionComplete');
            const classification = vi.spyOn(notices, 'readAccountNoticeArtifactHeader');
            for (const open of [false, true]) {
                await act(async () => setOpen(open));
                const before = summary;
                const beforeModel = open ? model : null;
                const reads = fixture.network.httpRequests.length;
                hydration.mockClear(); completeness.mockClear(); classification.mockClear();
                for (const document of unrelated.slice(0, 10)) {
                    await act(async () => storage.getState().updateArtifact({ ...document, bodyVersion: open ? 3 : 2, body: 'Changed document' }));
                }
                expect({ hydrationRows: hydration.mock.calls.reduce((sum, [rows]) => sum + rows.length, 0),
                    completenessRows: completeness.mock.calls.reduce((sum, [rows]) => sum + rows.length, 0),
                    classifications: classification.mock.calls.length }).toEqual({ hydrationRows: 0, completenessRows: 0, classifications: 0 });
                expect(summary).toBe(before);
                if (open) expect(model).toBe(beforeModel);
                expect(fixture.network.httpRequests).toHaveLength(reads);
            }
            await act(async () => storage.getState().addArtifact({ ...notice, id: 'new-notice' }));
            await vi.waitFor(() => expect(summary.count).toBe(2));
            expect(model.openAccountNotices.map(entry => entry.artifact.id).sort()).toEqual([notice.id, 'new-notice'].sort());
            await act(async () => storage.getState().deleteArtifact('new-notice'));
            expect(summary.count).toBe(1);
            expect(model.openAccountNotices.map(entry => entry.artifact.id)).toEqual([notice.id]);
        } finally { await screen.unmount(); }
    });

    it('retains mounted Inbox demand across Account binding before bootstrap publishes inventory readiness', async () => {
        const { storage } = await import('./domains/state/storage');
        const { sync, syncSwitchServer } = await import('./sync');
        const { getActiveServerSnapshot } = await import('./domains/server/serverRuntime');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { disconnectActiveServerConnection, restoreConnectionToActiveServer } = await import('./runtime/orchestration/connectionManager');
        const snapshot = getActiveServerSnapshot();
        const scope = storage.getState().settingsScope!;
        fixture.inventory = [createPlainArtifactHttpFixture(createUsageNoticeArtifactFixture({
            ownerAccountId: scope.accountId,
        }), scope.accountId)];
        const credentials = await TokenStorage.getCredentialsForServerUrl(snapshot.serverUrl, { serverId: snapshot.serverId });
        if (!credentials) throw new Error('Expected test-owned Account credentials');
        await disconnectActiveServerConnection();
        await syncSwitchServer(null);
        fixture.pages.length = 0;
        const settled: string[] = [];
        // A mounted source can see the store scope before Sync finishes binding it.
        // Registration must survive; acquisition still waits for the matching Account.
        const remove = sync.observeArtifactInventory(scope, 'inboxOpen', { onSettled: outcome => settled.push(outcome) });
        const removeForeign = sync.observeArtifactInventory({ ...scope, accountId: 'another-account' }, 'browserListed');
        try {
            expect(fixture.pages).toEqual([]);
            await restoreConnectionToActiveServer(credentials);
            await fixture.settleInventory();
            await vi.waitFor(() => expect({ ready: isArtifactInventoryReady(storage.getState(), 'inboxOpen'),
                pages: fixture.pages.length }).toEqual({ ready: true, pages: 1 }));
            expect(settled).toContain('success');
            expect(fixture.pages).toEqual([expect.objectContaining({ kinds: JSON.stringify(INBOX_ARTIFACT_KINDS) })]);
        } finally { remove(); removeForeign(); }
    });

    it('discovers open Run publications through selected inventory and exact body hydration without unrelated-arrival reads', async () => {
        const { storage } = await import('./domains/state/storage');
        const { useWorkflowRunPublicationRequests } = await import('@/components/workflows/run/useWorkflowRunPublicationRequests');
        const scope = storage.getState().profileScope!;
        const opened = ['workflow-a', 'workflow-b'].map((runId, index) => createWorkflowPublicationApprovalArtifact({
            id: `11111111-1111-4111-8111-99999999980${index}`, runId, scope,
        }));
        fixture.inventory = [...fixture.inventory.filter(row => row.kindHint === 'markdown'),
            ...opened.map(row => createPlainArtifactHttpFixture(row, scope.accountId))];
        let active = true;
        const hook = await renderHook(() => useWorkflowRunPublicationRequests({ scope, runId: 'workflow-a', active }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().map(request => request.artifactId)).toEqual([opened[0]!.id]));
            const lists = fixture.network.httpRequests.filter(({ url }) => new URL(url).pathname === '/v1/artifacts');
            expect(lists).toHaveLength(1);
            expect(new URL(lists[0]!.url).searchParams.get('approvalStates')).toBe(JSON.stringify(['open']));
            expect(new URL(lists[0]!.url).searchParams.get('kinds'))
                .toBe(JSON.stringify([APPROVAL_ARTIFACT_KINDS_V1.builtIn, APPROVAL_ARTIFACT_KINDS_V1.targetAction]));
            const reads = fixture.network.httpRequests.length;
            const selected = hook.getCurrent();
            const approvals = await import('./domains/artifacts/approvalArtifacts');
            const classifications = vi.spyOn(approvals, 'readOpenWorkflowPublicationApprovalId');
            await act(async () => {
                for (let index = 0; index < 100; index++) storage.getState().addArtifact({
                    ...opened[0]!, id: `unrelated-document-${index}`, header: { title: 'Document', kind: 'markdown' }, body: 'Document',
                });
            });
            expect(classifications).toHaveBeenCalledTimes(0);
            expect(fixture.network.httpRequests).toHaveLength(reads);
            expect(hook.getCurrent()).toBe(selected);
            active = false;
            await hook.rerender();
            expect(hook.getCurrent()).toEqual([]);
        } finally { await hook.unmount(); }
    });

    it('discovers an approved Project Service Start on a cold page without reading settled receipts', async () => {
        const { storage } = await import('./domains/state/storage');
        const { ProjectServicePlacementObservationProvider, useProjectServicePlacementObservation } = await import(
            '@/components/projects/detail/services/projectServicePlacementObservation');
        const scope = storage.getState().profileScope!;
        const source = { serverId: scope.serverId, machineId: 'devbox', refId: 'checkout' };
        const workspace = { serverId: scope.serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' };
        const request = { machineId: 'worker', targetId: 'server-target', workspace,
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest' as const, name: 'server' } } };
        const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
        const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'localServices.launcher.start', actionArgs: request,
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' }, serverId: scope.serverId,
                accountId: scope.accountId, actionId: 'localServices.launcher.start', requestId: 'pending-start', machineId: 'worker' },
            summary: 'Start server', decision: { kind: 'approve', decidedAtMs: 2 }, preview: { serviceStartReview: {
                request, target: { ...workspace, machineId: 'worker', workspaceId: 'worker-checkout', rootPath: '/copy' },
                reviewedEffectDigest: 'a'.repeat(64), reviewedEffect: {}, setup: { required: false,
                    project: { serverId: scope.serverId, projectId: 'project' }, reviewedEffectDigest: 'b'.repeat(64), reviewedEffect: {} },
            } } });
        const header = buildApprovalRequestArtifactHeaderV1(approval);
        expect(typeof header.approvalSubjectKey).toBe('string');
        const { LocalServiceStartApprovalReviewV1Schema } = await import('@happier-dev/protocol/local/services/launcher/v1');
        LocalServiceStartApprovalReviewV1Schema.parse(approval.preview && typeof approval.preview === 'object'
            && 'serviceStartReview' in approval.preview ? approval.preview.serviceStartReview : null);
        const pending: Artifact = { ...fixture.inventory[0]!, id: '11111111-1111-4111-8111-999999999801',
            kindHint: 'approval_request.v1', ...deriveApprovalArtifactQueryHintsV1(header),
            header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) };
        fixture.inventory = [pending];
        const hook = await renderHook(() => useProjectServicePlacementObservation('server', undefined, { absent: true }), {
            wrapper: ({ children }) => <ProjectServicePlacementObservationProvider source={source}>{children}</ProjectServicePlacementObservationProvider>,
        });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().active, JSON.stringify({ pages: fixture.pages,
                bodyReads: fixture.bodyReads, artifact: storage.getState().artifacts[pending.id] })).toBe(true));
            expect(fixture.pages).toEqual([{ kinds: JSON.stringify(['approval_request.v1']), headers: 1 }]);
            const list = fixture.network.httpRequests.find(({ url }) => new URL(url).pathname === '/v1/artifacts');
            expect(new URL(list!.url).searchParams.get('approvalStates')).toBe(JSON.stringify(['approved', 'executing']));
            expect(fixture.bodyReads).toEqual([]);
            expect(fixture.exactReads).toEqual([pending.id]);
        } finally { await hook.unmount(); }
    });

    it.each(['private', 'unknown'] as const)('opens the real browser with one listed page while retaining %s opaque rows truthfully', async opaqueKind => {
        const { storage } = await import('./domains/state/storage');
        const { sync } = await import('./sync');
        const { t } = await import('@/text');
        const opaque: Artifact = { ...fixture.inventory[3]!, kindHint: opaqueKind === 'private' ? 'approval_request.v1' : undefined,
            header: 'unreadable stored header' };
        const listed = ['markdown', 'future.document.v9', null].map((kind, index): Artifact => ({
            ...fixture.inventory[index]!, kindHint: kind,
            header: encodePlainArtifactStoredContent({ ...(kind === null ? {} : { kind }), title: 'Listed document' }),
        }));
        const inventory = [...listed, ...fixture.inventory.slice(3).map(row => ({ ...row,
            kindHint: 'approval_request.v1', header: encodePlainArtifactStoredContent({ kind: 'approval_request.v1' }),
        }))];
        // Admit the private variant through the real Inbox selection; a retained legacy
        // unknown can only come from an earlier unscoped observation.
        fixture.inventory = [opaque];
        await sync.fetchArtifactsList(opaqueKind === 'private' ? { kinds: INBOX_ARTIFACT_KINDS } : undefined);
        expect(storage.getState().artifacts[opaque.id]?.isDecrypted).toBe(false);
        fixture.pages.length = 0;
        fixture.inventory = inventory;
        const screen = await renderScreen(<AppPaneProvider><ArtifactsBrowserScreen /></AppPaneProvider>);
        try {
            await vi.waitFor(() => expect(storage.getState().artifacts[listed[0]!.id]).toBeDefined());
            expect(fixture.pages).toEqual([{ kinds: null, headers: 3 }]);
            const lists = fixture.network.httpRequests.filter(request => {
                const url = new URL(request.url);
                return url.pathname === '/v1/artifacts' && url.searchParams.get('browserListed') === 'true';
            });
            expect(lists).toHaveLength(1);
            expect(new URL(lists[0]!.url).searchParams.get('browserListed')).toBe('true');
            expect(storage.getState().artifactsLoaded).toBe(opaqueKind === 'unknown');
            expect(storage.getState().artifactBrowserLoaded).toBe(opaqueKind === 'private');
            expect(Object.keys(storage.getState().artifacts).sort()).toEqual([...listed.map(row => row.id), opaque.id].sort());
            await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('artifacts:collection:stage'), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } },
            }); });
            for (const row of listed) expect(screen.findHostByTestId(`artifacts:row:${row.id}`)).not.toBeNull();
            const visibleIds = screen.findAll(node => typeof node.props.testID === 'string'
                && /^artifacts:row:[^:]+$/.test(node.props.testID) && typeof node.type === 'string')
                .map(node => String(node.props.testID).slice('artifacts:row:'.length));
            expect(visibleIds.sort()).toEqual((opaqueKind === 'private' ? listed.map(row => row.id)
                : [...listed.map(row => row.id), opaque.id]).sort());
            expect(screen.getTextContent()).toContain(opaqueKind === 'private'
                ? t('artifacts.countPlural', { count: 3 }) : t('artifacts.browser.countSoFar', { count: 4 }));
            if (opaqueKind === 'private') expect(screen.findByTestId('artifacts:pending')).toBeNull();
            expect(fixture.bodyReads).toEqual([]);
            let visitedRows = 0;
            const displayed = storage.getState().artifacts[listed[0]!.id]!;
            if (!displayed.isDecrypted) throw new Error('Expected the displayed browser fixture to be readable');
            await act(async () => storage.getState().updateArtifact({ ...displayed, headerVersion: displayed.headerVersion + 1,
                get draft() { visitedRows++; return false; },
            }));
            visitedRows = 0;
            await act(async () => storage.getState().addArtifact({
                ...createAccountNoticeArtifactFixture(), id: 'unrelated-private-notice',
            }));
            expect(visitedRows).toBe(0);
        } finally { await screen.unmount(); }
    });

    it('keeps an opaque full census unavailable to browser consumers without discarding structural membership', async () => {
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        fixture.inventory = [fixture.inventory[0]!, { ...fixture.inventory[1]!, kindHint: null, header: 'unreadable stored header' }];
        let outcome: 'success' | 'failed' | undefined;
        const closeBrowser = sync.observeArtifactInventory(storage.getState().profileScope!, 'browserListed', {
            onSettled: settled => { outcome = settled; },
        });
        try {
            await sync.fetchArtifactsList();
            expect(storage.getState().artifactsLoaded).toBe(true);
            expect(storage.getState().artifactBrowserLoaded).toBe(false);
            expect(outcome).toBe('failed');
        } finally { closeBrowser(); }
    });

    it('counts a cold shell badge from the first Inbox census page and reads the rest only while Inbox rows are shown', async () => {
        const { storage } = await import('./domains/state/storage');
        const { InboxSummaryProvider, useSharedInboxSummary } = await import('@/hooks/inbox/useInboxSummary');
        const { InboxModelProvider, useInboxModel } = await import('@/hooks/inbox/useInboxModel');
        const scope = storage.getState().profileScope!;
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'Badge' });
        const header = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: scope.serverId });
        const base = fixture.inventory[0]!;
        // 1,600 open requests: four Inbox census pages (500, 500, 500, 100). The badge shows at most 99+.
        fixture.inventory = Array.from({ length: 1600 }, (_, index): Artifact => ({ ...base,
            id: `11111111-1111-4111-8111-9${String(index).padStart(11, '0')}`, updatedAt: index,
            kindHint: APPROVAL_ARTIFACT_KINDS_V1.builtIn, ...deriveApprovalArtifactQueryHintsV1(header),
            header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }) }));
        fixture.network.httpRequests.length = 0;
        const censusPages = () => fixture.network.httpRequests.map(entry => new URL(entry.url))
            .filter(url => url.pathname === '/v1/artifacts' && url.searchParams.get('kinds') === JSON.stringify(INBOX_ARTIFACT_KINDS));
        let summary!: InboxSummary, model: InboxModel | null = null;
        let openInbox!: (open: boolean) => void;
        function Summary() { summary = useSharedInboxSummary(); return null; }
        function Model() { model = useInboxModel(); return null; }
        function Shell() {
            const [open, setOpen] = React.useState(false);
            openInbox = setOpen;
            return <InboxSummaryProvider><Summary />{open ? <InboxModelProvider><Model /></InboxModelProvider> : null}</InboxSummaryProvider>;
        }
        const screen = await renderScreen(<Shell />);
        try {
            await vi.waitFor(() => expect(summary.count).not.toBeNull());
            await fixture.settleInventory();
            const cold = { pages: censusPages().length, headers: Object.keys(storage.getState().artifacts).length, count: summary.count };
            await act(async () => { openInbox(true); });
            await vi.waitFor(() => expect(model?.artifactSource.phase).toBe('current'));
            await fixture.settleInventory();
            const pages = censusPages();
            const opened = { pages: pages.length, firstPages: pages.filter(url => !url.searchParams.get('cursor')).length,
                rows: (model as InboxModel | null)?.openApprovals.length, count: summary.count };
            console.log('INBOX3 badge census counts', JSON.stringify({ cold, opened }));
            expect(cold.pages).toBe(1);
            expect(cold.count).toBeGreaterThan(99);
            expect(opened).toEqual({ pages: 5, firstPages: 2, rows: 1600, count: 1600 });
        } finally { await screen.unmount(); }
    });

    it('keeps one Inbox census when its row consumer remounts while the census is unfinished', async () => {
        const { storage } = await import('./domains/state/storage');
        const { InboxSummaryProvider, useSharedInboxSummary } = await import('@/hooks/inbox/useInboxSummary');
        const { InboxModelProvider, useInboxModel } = await import('@/hooks/inbox/useInboxModel');
        const scope = storage.getState().profileScope!;
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'Remount' });
        const header = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: scope.serverId });
        const base = fixture.inventory[0]!;
        fixture.inventory = Array.from({ length: 1600 }, (_, index): Artifact => ({ ...base,
            id: `11111111-1111-4111-8111-9${String(index).padStart(11, '0')}`, updatedAt: index,
            kindHint: APPROVAL_ARTIFACT_KINDS_V1.builtIn, ...deriveApprovalArtifactQueryHintsV1(header),
            header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }) }));
        let summary!: InboxSummary, model: InboxModel | null = null;
        let openInbox!: (open: boolean) => void;
        function Summary() { summary = useSharedInboxSummary(); return null; }
        function Model() { model = useInboxModel(); return null; }
        function Shell() {
            const [open, setOpen] = React.useState(false);
            openInbox = setOpen;
            return <InboxSummaryProvider><Summary />{open ? <InboxModelProvider><Model /></InboxModelProvider> : null}</InboxSummaryProvider>;
        }
        const screen = await renderScreen(<Shell />);
        const release = createDeferred<void>(), held = createDeferred<void>();
        try {
            await vi.waitFor(() => expect(summary.count).not.toBeNull());
            await fixture.settleInventory();
            fixture.network.httpRequests.length = 0;
            fixture.holdList = async (_signal, url) => {
                if (url?.searchParams.get('cursor')) { held.resolve(); await release.promise; }
            };
            await act(async () => { openInbox(true); });
            await held.promise;
            // The Inbox row consumer unmounts and mounts again (a route or loading remount) mid-census.
            await act(async () => { openInbox(false); });
            await act(async () => { openInbox(true); });
            fixture.holdList = null;
            release.resolve();
            await vi.waitFor(() => expect(model?.artifactSource.phase).toBe('current'));
            await fixture.settleInventory();
            const census = fixture.network.httpRequests.map(entry => new URL(entry.url))
                .filter(url => url.pathname === '/v1/artifacts' && url.searchParams.get('kinds') === JSON.stringify(INBOX_ARTIFACT_KINDS));
            const counts = { pages: census.length, firstPages: census.filter(url => !url.searchParams.get('cursor')).length,
                rows: (model as InboxModel | null)?.openApprovals.length };
            console.log('INBOX3 remount census counts', JSON.stringify(counts));
            expect(counts).toEqual({ pages: 4, firstPages: 1, rows: 1600 });
        } finally { fixture.holdList = null; release.resolve(); await screen.unmount(); }
    });

    it('admits a Session approval consumer during an unfinished Inbox census without restarting the census', async () => {
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        const { InboxSummaryProvider, useSharedInboxSummary } = await import('@/hooks/inbox/useInboxSummary');
        const { InboxModelProvider, useInboxModel } = await import('@/hooks/inbox/useInboxModel');
        const scope = storage.getState().profileScope!;
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'Census' });
        const header = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: scope.serverId });
        const base = fixture.inventory[0]!;
        // 1,600 open requests: four Inbox census pages (500, 500, 500, 100).
        fixture.inventory = Array.from({ length: 1600 }, (_, index): Artifact => ({ ...base,
            id: `11111111-1111-4111-8111-9${String(index).padStart(11, '0')}`, updatedAt: index,
            kindHint: APPROVAL_ARTIFACT_KINDS_V1.builtIn, ...deriveApprovalArtifactQueryHintsV1(header),
            header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }) }));
        fixture.network.httpRequests.length = 0;
        const secondPage = createDeferred<void>(), release = createDeferred<void>();
        let listed = 0;
        fixture.holdList = async () => { if (++listed === 2) { secondPage.resolve(); await release.promise; } };
        let summary!: InboxSummary;
        function Summary() { summary = useSharedInboxSummary(); return null; }
        function Model() { useInboxModel(); return null; }
        // The open Inbox shows rows, so it reads the whole census.
        const screen = await renderScreen(<InboxSummaryProvider><Summary /><InboxModelProvider><Model /></InboxModelProvider></InboxSummaryProvider>);
        let close: (() => void) | undefined;
        try {
            await secondPage.promise;
            // A Session surface (composer, transcript) opens while the census is on its second page.
            close = sync.observeArtifactInventory(scope, { approvalSessionIds: ['census-session'] }, { refreshOnAdmission: true });
            await new Promise(resolve => setTimeout(resolve, 50));
            release.resolve();
            await vi.waitFor(() => expect(summary.count).toBe(1600));
            await fixture.settleInventory();
            const lists = fixture.network.httpRequests.map(entry => new URL(entry.url)).filter(url => url.pathname === '/v1/artifacts');
            const census = lists.filter(url => url.searchParams.get('kinds') === JSON.stringify(INBOX_ARTIFACT_KINDS));
            const counts = { censusPages: census.length, censusFirstPages: census.filter(url => !url.searchParams.get('cursor')).length,
                sessionPages: lists.filter(url => url.searchParams.get('approvalSessionIds') !== null).length };
            console.log('INBOX3 census restart counts', JSON.stringify(counts));
            expect(counts).toEqual({ censusPages: 4, censusFirstPages: 1, sessionPages: 1 });
        } finally { fixture.holdList = null; release.resolve(); close?.(); await screen.unmount(); }
    });

    it('withdraws browser recovery without aborting or restarting the still-demanded Inbox selection', async () => {
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        const scope = storage.getState().profileScope!;
        fixture.inventory = fixture.inventory.map((row, index) => index < 3 ? { ...row, kindHint: 'markdown',
            header: encodePlainArtifactStoredContent({ kind: 'markdown' }) }
            : { ...row, kindHint: 'approval_request.v1', header: encodePlainArtifactStoredContent({ kind: 'approval_request.v1' }) });
        const browserStarted = createDeferred<AbortSignal | null | undefined>();
        const inboxStarted = createDeferred<AbortSignal | null | undefined>();
        const browserRelease = createDeferred<void>(), inboxRelease = createDeferred<void>();
        let heldInbox = false;
        fixture.holdList = async (signal, url) => {
            if (url?.searchParams.get('browserListed') === 'true') {
                browserStarted.resolve(signal);
                await browserRelease.promise;
            } else if (!heldInbox) {
                heldInbox = true;
                inboxStarted.resolve(signal);
                await inboxRelease.promise;
            }
        };
        let closeBrowser: (() => void) | undefined = sync.observeArtifactInventory(scope, 'browserListed', { includeProvenance: true });
        const closeInbox = sync.observeArtifactInventory(scope, INBOX_ARTIFACT_KINDS);
        const recovery = fixture.recoverSnapshot();
        try {
            const [browserSignal, inboxSignal] = await Promise.race([
                Promise.all([browserStarted.promise, inboxStarted.promise]),
                recovery.then(() => {
                    const routes = new Map<string, number>();
                    for (const request of fixture.network.httpRequests) {
                        const path = new URL(request.url).pathname;
                        routes.set(path, (routes.get(path) ?? 0) + 1);
                    }
                    throw new Error(`Snapshot recovery finished before its mounted Artifact selections started: ${JSON.stringify({
                        pages: fixture.pages, routes: [...routes],
                    })}`);
                }),
            ]);
            closeBrowser();
            closeBrowser = undefined;
            expect(browserSignal?.aborted).toBe(true);
            expect(inboxSignal?.aborted).toBe(false);
            browserRelease.resolve();
            inboxRelease.resolve();
            await recovery;
            await fixture.settleInventory();
            expect(fixture.pages.filter(page => page.kinds === null)).toEqual([{ kinds: null, headers: 3 }]);
            const inboxPages = fixture.pages.filter(page => page.kinds !== null);
            expect(inboxPages).toHaveLength(7);
            expect(inboxPages.reduce((sum, page) => sum + page.headers, 0)).toBe(3499);
            expect(inboxPages.every(page => page.kinds === JSON.stringify(INBOX_ARTIFACT_KINDS))).toBe(true);
            fixture.pages.length = 0;
            await fixture.recoverSnapshot();
            expect(fixture.pages).toHaveLength(7);
            expect(fixture.pages.every(page => page.kinds === JSON.stringify(INBOX_ARTIFACT_KINDS))).toBe(true);
        } finally {
            fixture.holdList = null;
            browserRelease.resolve(); inboxRelease.resolve();
            closeBrowser?.(); closeInbox();
            await recovery;
        }
    });

    it('opens Inbox beside 10000 settled receipts with O(open) rows and bodies and no equal-response publications', async () => {
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        const { InboxSummaryProvider, useSharedInboxSummary } = await import('@/hooks/inbox/useInboxSummary');
        const { InboxModelProvider, useInboxModel } = await import('@/hooks/inbox/useInboxModel');
        const scope = storage.getState().profileScope!;
        const openRequest = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'Review access' });
        const settledRequest = ApprovalRequestV1Schema.parse({ ...openRequest, status: 'rejected', updatedAtMs: 2,
            decision: { kind: 'reject', decidedAtMs: 2 } });
        const base = fixture.inventory[0]!;
        const approvalRow = (id: string, request: typeof openRequest): Artifact => ({ ...base, id,
            ...deriveApprovalArtifactQueryHintsV1(buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: scope.serverId })),
            kindHint: APPROVAL_ARTIFACT_KINDS_V1.builtIn,
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: scope.serverId })),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }) });
        const selected = Array.from({ length: 10000 }, (_, index) =>
            approvalRow(`11111111-1111-4111-8111-8${String(index).padStart(11, '0')}`, settledRequest));
        selected.push(approvalRow('11111111-1111-4111-8111-900000000000', openRequest));
        for (const notice of [createAccountNoticeArtifactFixture({ id: '11111111-1111-4111-8111-900000000001', ownerAccountId: scope.accountId }),
            createUsageNoticeArtifactFixture({ id: '11111111-1111-4111-8111-900000000002', ownerAccountId: scope.accountId })]) {
            selected.push({ ...base, id: notice.id, kindHint: notice.header!.kind,
                header: encodePlainArtifactStoredContent(notice.rawHeader), body: encodePlainArtifactStoredContent({ body: notice.body }) });
        }
        fixture.inventory = [...fixture.inventory.filter(row => row.kindHint === 'markdown'), ...selected];
        fixture.currentCursor = 100;
        await sync.resumeSync('app-foreground');
        expect(await fixture.readChangesCursor()).toBe('100');
        let artifactPublications = 0, rootPublications = 0;
        const changedRootFields = new Set<string>();
        const stop = storage.subscribe((next, previous) => {
            rootPublications++;
            if (next.artifacts !== previous.artifacts) artifactPublications++;
            for (const key of Object.keys(next) as Array<keyof typeof next>)
                if (next[key] !== previous[key]) changedRootFields.add(key);
        });
        const progressive: Array<{ pages: number; stored: number; artifactPublications: number }> = [];
        fixture.holdList = async () => {
            progressive.push({ pages: fixture.pages.length, stored: Object.keys(storage.getState().artifacts).length, artifactPublications });
        };
        let summary!: InboxSummary, model!: InboxModel;
        let summaryRenders = 0, modelRenders = 0;
        function Summary() { summary = useSharedInboxSummary(); summaryRenders++; return null; }
        function Model() { model = useInboxModel(); modelRenders++; return null; }
        const screen = await renderScreen(<InboxSummaryProvider><Summary /><InboxModelProvider><Model /></InboxModelProvider></InboxSummaryProvider>);
        try {
            await vi.waitFor(() => {
                expect(summary).toEqual({ count: 3, hasContent: true });
                expect(model.artifactSource.phase).toBe('current');
            });
            await fixture.settleInventory();
            fixture.holdList = null;
            expect(fixture.pages).toEqual([{ kinds: JSON.stringify(INBOX_ARTIFACT_KINDS), headers: 3 }]);
            // Pages are decoded progressively, but no earlier partial Artifact map is published or retained by the store.
            expect(progressive).toEqual([{ pages: 1, stored: 0, artifactPublications: 0 }]);
            expect(artifactPublications).toBe(2); // One complete header map, then one selected body batch.
            expect(fixture.bodyReads).toHaveLength(1);
            expect(fixture.bodyReads[0]).toHaveLength(3);
            const baseline = storage.getState().artifacts;
            const baselineSummary = summary, baselineModel = model;
            const baselineSummaryRenders = summaryRenders, baselineModelRenders = modelRenders;
            expect(Object.keys(baseline)).toHaveLength(3);
            const observations: Array<{ phase: string; artifactPublications: number; rootPublications: number; changedRootFields: string[];
                changedModelFields: string[]; summaryRenders: number; modelRenders: number }> = [];
            const resetCounts = () => {
                artifactPublications = 0; rootPublications = 0; changedRootFields.clear(); fixture.pages.length = 0;
            };
            const expectStable = (phase: string, expectedPages: number[], wholeModelStable = true) => {
                observations.push({ phase, artifactPublications, rootPublications, changedRootFields: [...changedRootFields].sort(),
                    changedModelFields: (Object.keys(model) as Array<keyof InboxModel>).filter(key => model[key] !== baselineModel[key]),
                    summaryRenders: summaryRenders - baselineSummaryRenders, modelRenders: modelRenders - baselineModelRenders });
                expect(artifactPublications, JSON.stringify(observations)).toBe(0);
                expect(storage.getState().artifacts).toBe(baseline);
                expect(selected.filter(row => storage.getState().artifacts[row.id] !== baseline[row.id]).map(row => row.id)).toEqual([]);
                expect(summary).toBe(baselineSummary);
                for (const key of ['artifactSource', 'openApprovals', 'openUsageNotices', 'accountNotices', 'openAccountNotices'] as const)
                    expect(model[key], `${phase}: ${key}`).toBe(baselineModel[key]);
                expect(summaryRenders).toBe(baselineSummaryRenders);
                if (wholeModelStable) {
                    expect(model).toBe(baselineModel);
                    expect(modelRenders).toBe(baselineModelRenders);
                }
                expect(fixture.pages).toEqual(expectedPages.map(headers => ({ kinds: JSON.stringify(INBOX_ARTIFACT_KINDS), headers })));
                expect(fixture.bodyReads).toHaveLength(1);
                expect(storage.getState().artifactsLoaded).toBe(false);
                expect(storage.getState().artifactInventoryKindsLoaded).toEqual([]);
                expect(storage.getState().artifactInboxLoaded).toBe(true);
            };
            for (let refresh = 0; refresh < 3; refresh++) {
                resetCounts();
                await act(async () => { await sync.fetchArtifactsList({ selection: 'inboxOpen' }); });
                expectStable(`same-five-family-${refresh + 1}`, [3]);
                expect(rootPublications, JSON.stringify(observations)).toBe(0);
            }
            resetCounts();
            await act(async () => { await sync.resumeSync('socket-reconnect'); });
            expectStable('cursor-current-reconnect', []);
            expect(fixture.changesReads.at(-1)).toEqual({ after: '100', outcome: 'ok', cursor: 100 });
            resetCounts();
            fixture.currentCursor = 200;
            fixture.cursorGone = true;
            await act(async () => { await sync.resumeSync('socket-reconnect'); });
            await fixture.settleInventory();
            // Snapshot repair also refreshes Session-list observation timestamps, a separate Model input.
            expectStable('cursor-gone-reconnect', [3], false);
            expect(fixture.changesReads).toContainEqual({ after: '100', outcome: 'gone', cursor: 200 });
            expect(await fixture.readChangesCursor()).toBe('200');
            resetCounts();
            const changed = selected[0]!;
            const changedRequest = { ...settledRequest, summary: 'Updated settled request', updatedAtMs: 3 };
            const changedHeader = buildApprovalRequestArtifactHeaderV1(changedRequest, { legacyServerId: scope.serverId });
            fixture.inventory = fixture.inventory.map(row => row.id === changed.id ? { ...row,
                headerVersion: 2, bodyVersion: 2, seq: 3, updatedAt: 3, header: encodePlainArtifactStoredContent(changedHeader),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(changedRequest) }) } : row);
            await act(async () => { await sync.fetchArtifactsList({ selection: 'inboxOpen' }); });
            expect(artifactPublications).toBe(0);
            expect(rootPublications).toBe(0);
            expect(storage.getState().artifacts).toBe(baseline);
            expect(storage.getState().artifacts[changed.id]).toBeUndefined();
            expect(summary).toEqual({ count: 3, hasContent: true });
            expect(fixture.bodyReads).toHaveLength(1);
            expect(fixture.pages).toEqual([{ kinds: JSON.stringify(INBOX_ARTIFACT_KINDS), headers: 3 }]);
            console.info('Inbox inventory retention counts:', JSON.stringify({ selected: selected.length, progressive, observations }));
        } finally { fixture.holdList = null; stop(); await screen.unmount(); }
    }, 120_000);

    it('discovers unchanged Inbox approvals and unread notices before the current cursor and repairs expired removals narrowly', async () => {
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        const scope = storage.getState().profileScope!;
        const kinds = [...Object.values(APPROVAL_ARTIFACT_KINDS_V1), ACCOUNT_NOTICE_ARTIFACT_KIND_V1, USAGE_NOTICE_ARTIFACT_KIND_V1].sort();
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'Review access' });
        const approvalHeader = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: scope.serverId });
        const approval: Artifact = { ...fixture.inventory[0]!, id: '11111111-1111-4111-8111-999999999990',
            ...deriveApprovalArtifactQueryHintsV1(approvalHeader),
            kindHint: APPROVAL_ARTIFACT_KINDS_V1.builtIn, header: encodePlainArtifactStoredContent(approvalHeader),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }) };
        const notices = [createAccountNoticeArtifactFixture({ id: '11111111-1111-4111-8111-999999999991', ownerAccountId: scope.accountId }),
            createUsageNoticeArtifactFixture({ id: '11111111-1111-4111-8111-999999999992', ownerAccountId: scope.accountId })].map((notice): Artifact => ({
                ...fixture.inventory[0]!, id: notice.id, kindHint: notice.header!.kind,
                header: encodePlainArtifactStoredContent(notice.rawHeader), body: encodePlainArtifactStoredContent({ body: notice.body }),
            }));
        fixture.inventory = [...fixture.inventory.filter(row => row.kindHint === 'markdown'), approval, ...notices];
        fixture.currentCursor = 100;
        await sync.resumeSync('app-foreground');
        expect(await fixture.readChangesCursor()).toBe('100');
        expect(storage.getState().artifacts).toEqual({});
        const { InboxSummaryProvider, useSharedInboxSummary } = await import('@/hooks/inbox/useInboxSummary');
        const { InboxModelProvider, useInboxModel } = await import('@/hooks/inbox/useInboxModel');
        const { InboxPopoverContent } = await import('@/components/inbox/InboxPopover');
        let summary!: InboxSummary;
        let model!: InboxModel;
        function Summary() { summary = useSharedInboxSummary(); return null; }
        function Model() { model = useInboxModel(); return <InboxPopoverContent close={() => {}} onOpenInbox={() => {}} />; }
        const bodiesStarted = createDeferred<void>(), releaseBodies = createDeferred<void>();
        const retryStarted = createDeferred<void>(), releaseRetry = createDeferred<void>();
        fixture.holdBodies = () => { bodiesStarted.resolve(); return releaseBodies.promise; };
        const screen = await renderScreen(<InboxSummaryProvider><Summary /><InboxModelProvider><Model /></InboxModelProvider></InboxSummaryProvider>);
        try {
            await vi.waitFor(() => expect(fixture.pages).toEqual([{ kinds: JSON.stringify(kinds), headers: 3 }]));
            await bodiesStarted.promise;
            expect(summary).toEqual({ count: null, hasContent: null });
            expect(model?.showCaughtUp).toBe(false);
            releaseBodies.resolve();
            await vi.waitFor(() => expect(summary).toEqual({ count: 3, hasContent: true }));
            expect(model?.openApprovals.map(row => row.id)).toEqual([approval.id]);
            expect(model?.openAccountNotices).toHaveLength(2);
            expect([...new Set(fixture.bodyReads.flat())].sort()).toEqual([approval.id, ...notices.map(row => row.id)].sort());
            expect(fixture.bodyReads).toHaveLength(1);
            expect(storage.getState().artifactsLoaded).toBe(false);
            expect(storage.getState().artifactInventoryKindsLoaded).toEqual([]);
            expect(storage.getState().artifactInboxLoaded).toBe(true);
            const { invokeMountedWorkRead } = await import('@/sync/ops/actions/mountedWorkReadAction');
            const readInbox = () => invokeMountedWorkRead({ actionId: 'inbox.get', input: {},
                context: { surface: 'ui', serverId: scope.serverId, runtimeAccountId: scope.accountId } });
            expect(await readInbox()).toMatchObject({ status: 'ready' });
            expect(screen.findByTestId('inbox.popover.count')?.props.children).toBe('3');
            fixture.listFailure = 403;
            await act(async () => { await expect(fixture.recoverSnapshot()).rejects.toMatchObject({
                name: 'HappyError', status: 403, canTryAgain: false,
            }); });
            // Retained rows stay visible, but neither the shell nor its Action certifies a total.
            await vi.waitFor(async () => expect({ total: screen.findByTestId('inbox.popover.count')?.props.children ?? null,
                action: await readInbox(), summary, phase: model?.artifactSource.phase }).toMatchObject({
                total: null, action: { status: 'partial', refreshFailed: true,
                    coverage: { sources: [{ source: 'notices', status: 'partial', reason: 'content_unavailable' }] } },
                summary: { count: null, hasContent: null }, phase: 'failed',
            }));
            expect(model?.openApprovals).toHaveLength(1);
            expect(model?.openAccountNotices).toHaveLength(2);
            fixture.listFailure = null;
            fixture.holdList = () => { retryStarted.resolve(); return releaseRetry.promise; };
            await act(async () => { model?.artifactSource.retry(); });
            await retryStarted.promise;
            expect(summary).toEqual({ count: null, hasContent: null });
            expect(await readInbox()).toMatchObject({ status: 'partial', refreshFailed: true });
            fixture.holdList = null;
            releaseRetry.resolve();
            await vi.waitFor(() => expect(summary).toEqual({ count: 3, hasContent: true }));
            const admitted = storage.getState().artifacts[approval.id];
            await act(async () => { await fixture.recoverSnapshot(); });
            expect(storage.getState().artifacts[approval.id]).toBe(admitted);
            expect(fixture.bodyReads).toHaveLength(1);
            const changedRequest = { ...request, updatedAtMs: 2 };
            fixture.inventory = fixture.inventory.map(row => row.id !== approval.id ? row : { ...row,
                bodyVersion: 2, seq: 2, updatedAt: 2,
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(changedRequest) }) });
            await act(async () => { await fixture.recoverSnapshot(); });
            await vi.waitFor(() => expect(storage.getState().artifacts[approval.id]?.body).toBe(JSON.stringify(changedRequest)));
            expect(fixture.bodyReads).toHaveLength(2);
            expect(summary).toEqual({ count: 3, hasContent: true });
            fixture.inventory = fixture.inventory.filter(row => row.kindHint === 'markdown');
            fixture.currentCursor = 200;
            fixture.cursorGone = true;
            fixture.pages.length = 0;
            await act(async () => { await sync.resumeSync('socket-reconnect'); });
            await vi.waitFor(() => expect(summary).toEqual({ count: 0, hasContent: false }));
            expect(model?.openApprovals).toEqual([]);
            expect(model?.openAccountNotices).toEqual([]);
            expect(model?.showCaughtUp).toBe(true);
            expect(fixture.pages).toEqual([{ kinds: JSON.stringify(kinds), headers: 0 }]);
            const cursorState = await fixture.readChangesCursorState();
            expect({ persisted: cursorState.persisted, live: cursorState.live }, JSON.stringify(cursorState))
                .toEqual({ persisted: '200', live: '200' });
            fixture.listFailure = 403;
            await act(async () => { await expect(fixture.recoverSnapshot()).rejects.toMatchObject({
                name: 'HappyError', status: 403, canTryAgain: false,
            }); });
            await vi.waitFor(() => expect(model?.artifactSource?.phase).toBe('failed'));
            expect(summary).toEqual({ count: null, hasContent: null });
            expect(model?.showCaughtUp).toBe(false);
            fixture.listFailure = null;
            await act(async () => { model?.artifactSource.retry(); });
            await vi.waitFor(() => expect(summary).toEqual({ count: 0, hasContent: false }));
            expect(model?.showCaughtUp).toBe(true);
        } finally { releaseBodies.resolve(); releaseRetry.resolve(); fixture.holdList = null; await screen.unmount(); }
    }, 120_000);

    it('mounts readable legacy approval cards through its existing body owner without read-side kind mutations', async () => {
        const { storage } = await import('./domains/state/storage');
        const scope = storage.getState().profileScope!;
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'Review access' });
        const header = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: scope.serverId });
        const rows: Artifact[] = [null, 'prompt' as const].map((kind, index) => {
            const { kindHint: _hint, ...base } = fixture.inventory[index]!;
            return { ...base, kind, header: encodePlainArtifactStoredContent(header),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }) };
        });
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
        for (const row of rows) boundary.replaceStoredRow(row);
        fixture.artifactStore = boundary;
        const { InboxSummaryProvider } = await import('@/hooks/inbox/useInboxSummary');
        const { InboxModelProvider, useInboxModel } = await import('@/hooks/inbox/useInboxModel');
        const { ApprovalInboxCard } = await import('@/components/inbox/cards/ApprovalInboxCard');
        function Cards() { return <>{useInboxModel().openApprovals.map(artifact =>
            <ApprovalInboxCard key={artifact.id} artifact={artifact} onPress={() => {}} />)}</>; }
        const screen = await renderScreen(<InboxSummaryProvider><InboxModelProvider><Cards /></InboxModelProvider></InboxSummaryProvider>);
        try {
            await vi.waitFor(() => { for (const row of rows) expect(screen.findByTestId(`inbox.approval.${row.id}`)).not.toBeNull(); });
            for (const row of rows) {
                expect(boundary.read(row.id)?.kindHint).toBeUndefined();
                expect(boundary.read(row.id)?.kind).toBe(row.kind);
                expect(storage.getState().artifacts[row.id]?.body).toBe(JSON.stringify(request));
            }
            expect(fixture.bodyReads).toEqual([rows.map(row => row.id).sort()]);
            expect(fixture.artifactWrites).toEqual([]);
            await act(async () => { screen.tree.update(<InboxSummaryProvider><InboxModelProvider><Cards /></InboxModelProvider></InboxSummaryProvider>); });
            expect(fixture.artifactWrites).toEqual([]);
        } finally { await screen.unmount(); }
    }, 120_000);

    it.each(['partial', 'malformed-body', 'malformed-status', 'failed'] as const)('keeps Inbox count and caught-up unknown when its Artifact source is %s', async state => {
        const { InboxSummaryProvider, useSharedInboxSummary } = await import('@/hooks/inbox/useInboxSummary');
        const { InboxModelProvider, useInboxModel } = await import('@/hooks/inbox/useInboxModel');
        const { InboxContent } = await import('@/components/inbox/InboxContent');
        const { storage } = await import('./domains/state/storage');
        if (state === 'failed') fixture.listFailure = 403;
        else if (state === 'malformed-body' || state === 'malformed-status') {
            const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'Review access' });
            fixture.inventory = [{ ...fixture.inventory[0]!, kindHint: APPROVAL_ARTIFACT_KINDS_V1.builtIn,
                header: encodePlainArtifactStoredContent({ ...buildApprovalRequestArtifactHeaderV1(request),
                    ...(state === 'malformed-status' ? { approvalStatus: 'corrupted' } : {}) }),
                body: encodePlainArtifactStoredContent({ body: '{' }) }];
        }
        else {
            const { kindHint: _hint, ...legacy } = fixture.inventory[0]!;
            fixture.inventory = [{ ...legacy, kind: null, header: 'unreadable retained header' }];
        }
        let summary!: InboxSummary;
        let model!: InboxModel;
        function Summary() { summary = useSharedInboxSummary(); return null; }
        function Model() { model = useInboxModel(); return <InboxContent model={model} />; }
        const screen = await renderScreen(<InboxSummaryProvider><Summary /><InboxModelProvider><Model /></InboxModelProvider></InboxSummaryProvider>);
        try {
            await vi.waitFor(() => expect(summary).toEqual({ count: null, hasContent: null }));
            expect(model?.showCaughtUp).toBe(false);
            await vi.waitFor(() => expect(model?.artifactSource?.phase).toBe(state === 'failed' || state === 'malformed-status' ? 'failed' : 'partial'));
            expect(model?.isLoading).toBe(false);
            expect(screen.findByTestId('inbox.empty')).toBeNull();
            expect(screen.findByTestId('inbox.artifacts_unavailable')).not.toBeNull();
            expect(storage.getState().artifactsLoaded).toBe(false);
            if (state === 'failed') {
                fixture.listFailure = null;
                fixture.inventory = fixture.inventory.filter(row => row.kindHint === 'markdown');
                await screen.pressByTestIdAsync('inbox.artifacts_retry');
                await vi.waitFor(() => expect(summary).toEqual({ count: 0, hasContent: false }));
                expect(model?.showCaughtUp).toBe(true);
            }
        } finally { await screen.unmount(); }
    }, 120_000);

    it('reads zero inventory pages at cold bootstrap or fallback resume without a mounted consumer', async () => {
        expect(fixture.pages).toEqual([]);
        await fixture.recoverSnapshot();
        expect(fixture.pages).toEqual([]);
    }, 120_000);

    it('retires a failed inventory fact when real Account replacement starts an unfinished read', async () => {
        const { useArtifactInventoryRead } = await import('@/components/artifacts/useArtifactInventoryRead');
        const { storage } = await import('./domains/state/storage');
        const kinds = INBOX_ARTIFACT_KINDS;
        fixture.listFailure = 403;
        const consumer = await renderHook(() => useArtifactInventoryRead(true, kinds));
        const nextStarted = createDeferred<void>(), releaseNext = createDeferred<void>();
        try {
            await vi.waitFor(() => expect(consumer.getCurrent().failed).toBe(true));
            fixture.accountId = 'replacement-artifact-account';
            fixture.inventory = [];
            fixture.listFailure = null;
            fixture.holdList = () => { nextStarted.resolve(); return releaseNext.promise; };
            await act(async () => { await fixture.network.setAccount('https://artifact-demand.example.test', fixture.accountId); });
            await nextStarted.promise;
            expect(storage.getState().settingsScope?.accountId).toBe(fixture.accountId);
            expect(consumer.getCurrent().failed).toBe(false);
            fixture.holdList = null;
            releaseNext.resolve();
            await vi.waitFor(() => expect(storage.getState().artifactInventoryKindsLoaded).toEqual(kinds));
            expect(consumer.getCurrent().failed).toBe(false);
            await fixture.settleInventory();
            expect(fixture.pages).toEqual([{ kinds: JSON.stringify(kinds), headers: 0 }]);
            fixture.listFailure = 403;
            await act(async () => { await expect(fixture.recoverSnapshot()).rejects.toMatchObject({
                name: 'HappyError', status: 403, canTryAgain: false,
            }); });
            await vi.waitFor(() => expect(consumer.getCurrent().failed).toBe(true));
        } finally { releaseNext.resolve(); fixture.holdList = null; await consumer.unmount(); }
    }, 120_000);

    it('refreshes only mounted kinds after readiness disables initial loading and stops when they close', async () => {
        const { useArtifactInventoryRead } = await import('@/components/artifacts/useArtifactInventoryRead');
        const { storage } = await import('./domains/state/storage');
        const kinds = ['prompt_doc.v2', 'approval_request.v1'];
        const promptKinds = [kinds[0]!], approvalKinds = [kinds[1]!], noKinds: string[] = [];
        const consumer = await renderHook(() => {
            useArtifactInventoryRead(false, promptKinds);
            useArtifactInventoryRead(false, approvalKinds);
            useArtifactInventoryRead(false, noKinds);
        });
        try {
            await fixture.settleInventory();
            fixture.pages.length = 0;
            await fixture.recoverSnapshot();
            expect(fixture.pages).toEqual([{ kinds: JSON.stringify([...kinds].sort()), headers: 2 }]);
            expect(storage.getState().artifactsLoaded).toBe(false);
            expect(storage.getState().artifactInventoryKindsLoaded).toEqual([...kinds].sort());
            const changed = fixture.inventory[0]!;
            fixture.inventory[0] = { ...changed, headerVersion: 2,
                header: encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2', title: 'Changed while offline' }) };
            fixture.pages.length = 0;
            await fixture.recoverSnapshot();
            expect(storage.getState().artifacts[changed.id]?.headerVersion).toBe(2);
            expect(fixture.pages).toHaveLength(1);
        } finally { await consumer.unmount(); }
        fixture.pages.length = 0;
        await fixture.recoverSnapshot();
        expect(fixture.pages).toEqual([]);
    }, 120_000);

    it('cancels a closed full inventory while retaining narrow demand, then opens a complete full inventory', async () => {
        const { useArtifactInventoryRead } = await import('@/components/artifacts/useArtifactInventoryRead');
        const { storage } = await import('./domains/state/storage');
        const requestStarted = createDeferred<void>(), release = createDeferred<void>();
        const narrowKinds = ['prompt_doc.v2'], noKinds: string[] = [];
        fixture.holdList = () => { requestStarted.resolve(); return release.promise; };
        const consumer = await renderHook(({ full }: { full: boolean }) => {
            useArtifactInventoryRead(false, full ? undefined : noKinds, { includeProvenance: true });
            useArtifactInventoryRead(false, narrowKinds);
        }, { initialProps: { full: true } });
        try {
            try {
                await requestStarted.promise;
                await consumer.rerender({ full: false });
            } finally { fixture.holdList = null; release.resolve(); }
            await fixture.settleInventory();
            expect(fixture.pages).toEqual([{ kinds: null, headers: 500 }, { kinds: JSON.stringify(narrowKinds), headers: 1 }]);
            await consumer.unmount();
            fixture.holdList = null;
            fixture.pages.length = 0;
            const reopened = await renderHook(() => useArtifactInventoryRead(false));
            try {
                await fixture.settleInventory();
                expect(fixture.pages).toHaveLength(8);
                expect(fixture.pages.reduce((count, page) => count + page.headers, 0)).toBe(3502);
                expect(storage.getState().artifactsLoaded).toBe(true);
            } finally { await reopened.unmount(); }
            fixture.pages.length = 0;
            await fixture.recoverSnapshot();
            expect(fixture.pages).toEqual([]);
        } finally { await consumer.unmount(); }
    }, 120_000);

    it('does not acquire inventory for a retained settings scope from another Account', async () => {
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        const scope = storage.getState().settingsScope!;
        // A retained surface supplies its captured Account, never the new Sync Account's identity.
        const stop = sync.observeArtifactInventory({ ...scope, accountId: 'previous-account' }, ['prompt_doc.v2']);
        try {
            fixture.pages.length = 0;
            await fixture.recoverSnapshot();
            expect(fixture.pages).toEqual([]);
        } finally {
            stop();
        }
    }, 120_000);

    it('loads no inventory while retained hidden, refreshes on reveal, and releases demand on hide', async () => {
        const { useArtifactInventoryRead } = await import('@/components/artifacts/useArtifactInventoryRead');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { storage } = await import('./domains/state/storage');
        const kinds = ['prompt_doc.v2'];
        let presented = false;
        function Presentation(props: React.PropsWithChildren) {
            return <PluginSurfaceFocusEligibilityProvider active={presented}>{props.children}</PluginSurfaceFocusEligibilityProvider>;
        }
        const consumer = await renderHook(() => {
            const ready = storage(state => state.artifactInventoryKindsLoaded.includes(kinds[0]!));
            return useArtifactInventoryRead(!ready, kinds);
        }, { wrapper: Presentation });
        try {
            await fixture.recoverSnapshot();
            expect(fixture.pages).toEqual([]);
            presented = true;
            await consumer.rerender();
            await vi.waitFor(() => expect(storage.getState().artifactInventoryKindsLoaded).toEqual(kinds));
            expect(fixture.pages).toEqual([{ kinds: JSON.stringify(kinds), headers: 1 }]);
            presented = false;
            await consumer.rerender();
            fixture.pages.length = 0;
            consumer.getCurrent().retry();
            await fixture.recoverSnapshot();
            expect(fixture.pages).toEqual([]);
            const changed = fixture.inventory[0]!;
            fixture.inventory[0] = { ...changed, headerVersion: 2,
                header: encodePlainArtifactStoredContent({ kind: kinds[0], title: 'Updated while hidden' }) };
            presented = true;
            await consumer.rerender();
            await vi.waitFor(() => expect(storage.getState().artifacts[changed.id]?.headerVersion).toBe(2));
            expect(fixture.pages).toEqual([{ kinds: JSON.stringify(kinds), headers: 1 }]);
        } finally { await consumer.unmount(); }
    }, 120_000);
});
