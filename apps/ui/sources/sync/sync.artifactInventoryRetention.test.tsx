import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { queryObjects } from 'node:v8';
import { Session as InspectorSession } from 'node:inspector';
import { ApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { renderScreen } from '@/dev/testkit';
import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';
import { INBOX_ARTIFACT_KINDS } from './domains/artifacts/inboxArtifacts';
import type { Artifact } from './domains/artifacts/artifactTypes';
import type { InboxSummary } from '@/hooks/inbox/useInboxSummary';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

await initializeArtifactInventoryDemandHarness();

// Report-only heap experiment: run explicitly with Node --expose-gc. Ordinary
// suites retain the deterministic count/identity contract in the demand suite.
it.skipIf(typeof globalThis.gc !== 'function')('releases superseded Inbox cohort maps and measures 41,600 headers after ten unchanged reads', async () => {
    const collectGarbage = globalThis.gc!;
    async function countCohortArrays() {
        const inspector = new InspectorSession();
        inspector.connect();
        const objectGroup = 'artifact-retention-array-census';
        try {
            const prototype = await new Promise<string>((resolve, reject) => inspector.post('Runtime.evaluate', {
                expression: 'Array.prototype', objectGroup,
            }, (error, response) => error ? reject(error) : response.result.objectId
                ? resolve(response.result.objectId) : reject(new Error('Missing Array prototype handle'))));
            // CDP accepts objectGroup here; @types/node omits it, so pass a named value rather than a literal.
            const queryObjectsParams = { prototypeObjectId: prototype, objectGroup };
            const objects = await new Promise<string>((resolve, reject) => inspector.post('Runtime.queryObjects', queryObjectsParams, (error, response) => error ? reject(error) : response.objects.objectId
                ? resolve(response.objects.objectId) : reject(new Error('Missing Array census handle'))));
            // Only lengths leave the inspector, never array elements/content.
            // Include full/last transport pages as well as whole cohorts.
            return await new Promise<Record<string, number>>((resolve, reject) => inspector.post('Runtime.callFunctionOn', {
                objectId: objects, returnByValue: true,
                arguments: [{ value: 41_600 }, { value: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 }],
                functionDeclaration: 'function (cohort, page) { const counts = {}; for (const value of this) if (value.length >= cohort || value.length === page || value.length === cohort % page) counts[value.length] = (counts[value.length] || 0) + 1; return counts; }',
            }, (error, response) => {
                const counts: unknown = response?.result.value;
                if (error) reject(error);
                else if (counts && typeof counts === 'object' && Object.values(counts).every(count => typeof count === 'number'))
                    resolve(counts as Record<string, number>);
                else reject(new Error('Missing Array length census'));
            }));
        } finally {
            // queryObjects itself temporarily roots all results. Release the whole
            // group before the next GC/sample so diagnostics cannot retain pages.
            await new Promise<void>((resolve, reject) => inspector.post('Runtime.releaseObjectGroup', { objectGroup },
                error => error ? reject(error) : resolve()));
            inspector.disconnect();
        }
    }
    async function afterGc() {
        // WeakRefs keep their target alive for the current job. Leave the job
        // before collecting, and never dereference them in the collection loop.
        await new Promise<void>(resolve => setImmediate(resolve));
        collectGarbage();
        await new Promise<void>(resolve => setImmediate(resolve));
        collectGarbage();
        const containers = { arrays: queryObjects(Array), maps: queryObjects(Map), sets: queryObjects(Set) };
        const memory = process.memoryUsage();
        const cohortArrays = await countCohortArrays();
        return { ...memory, containers, cohortArrays };
    }
    const fixture = await createArtifactInventoryDemandHarness();
    const { sync } = await import('./sync');
    const { storage } = await import('./domains/state/storage');
    const { InboxSummaryProvider, useSharedInboxSummary } = await import('@/hooks/inbox/useInboxSummary');
    fixture.inventory = [];
    let summary: InboxSummary | undefined;
    function Summary() { summary = useSharedInboxSummary(); return null; }
    const screen = await renderScreen(<InboxSummaryProvider><Summary /></InboxSummaryProvider>);
    let artifactPublications = 0;
    const supersededMaps: WeakRef<object>[] = [];
    const stop = storage.subscribe((state, previous) => {
        if (state.artifacts !== previous.artifacts) {
            artifactPublications++;
            // Zustand intentionally keeps its initial empty state; only retired
            // nonempty cohort maps are the lifetime contract under investigation.
            if (Object.keys(previous.artifacts).length > 0) supersededMaps.push(new WeakRef(previous.artifacts));
        }
    });
    async function refresh() {
        await act(async () => { await sync.fetchArtifactsList({ kinds: INBOX_ARTIFACT_KINDS }); });
        await fixture.settleInventory();
    }
    function drainObservation() {
        const pages = fixture.pages.length;
        fixture.pages.length = 0;
        fixture.network.httpRequests.length = 0;
        return pages;
    }
    function rememberBaseline() {
        // This ONE intentional strong baseline proves every unchanged row's
        // identity. Drop it before the superseded-lifetime control below.
        const baseline = storage.getState().artifacts;
        return () => {
            const current = storage.getState().artifacts;
            expect(current).toBe(baseline);
            expect(Object.keys(current)).toHaveLength(41_600);
            expect(Object.values(current).every(row => row === baseline[row.id])).toBe(true);
        };
    }
    try {
        await vi.waitFor(() => expect(summary?.count).toBe(0));
        const empty = await afterGc();
        const prototype = fixture.inventory[0] ?? {
            id: '', kind: 'other', ownerAccountId: fixture.accountId, access: 'owner',
            encryptionMode: 'plain', publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: '', headerVersion: 1, bodyVersion: 1, seq: 0, createdAt: 0, updatedAt: 0,
        } satisfies Artifact;
        // Closed approval headers are the historical cohort: they legitimately
        // remain members, but demand no large bodies. The separate composed test
        // covers open approvals and unread notices through the real body owner.
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'rejected', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'retention-session' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'Synthetic completed approval',
            decision: { kind: 'reject', decidedAtMs: 1 } });
        const baseHeader = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: storage.getState().profileScope!.serverId });
        fixture.inventory = Array.from({ length: 41_600 }, (_, index): Artifact => ({ ...prototype,
            id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`, kindHint: String(baseHeader.kind),
            header: encodePlainArtifactStoredContent({ ...baseHeader, title: `Synthetic completed approval ${index}` }),
            seq: index, createdAt: index, updatedAt: index,
        }));
        const fixtureOnly = await afterGc();
        fixture.pages.length = 0;
        artifactPublications = 0;
        await refresh();
        expect(drainObservation()).toBe(84);
        expect(artifactPublications).toBe(1);
        expect(summary?.count).toBe(0);
        let verifyBaseline: (() => void) | undefined = rememberBaseline();
        const afterOne = await afterGc();
        artifactPublications = 0;
        fixture.pages.length = 0;
        let repeatPages = 0;
        for (let index = 0; index < 10; index++) {
            await refresh();
            verifyBaseline();
            repeatPages += drainObservation();
        }
        expect(repeatPages).toBe(10 * 84);
        expect(artifactPublications).toBe(0);
        expect(fixture.bodyReads).toHaveLength(0);
        const afterTen = await afterGc();
        expect(afterTen.cohortArrays).toEqual(afterOne.cohortArrays);
        verifyBaseline = undefined;
        // Actual changed reads give the owner obsolete maps to release. Keep
        // React mounted and advance beyond its bounded current/alternate pair.
        for (let generation = 2; generation <= 5; generation++) {
            fixture.inventory = fixture.inventory.map((row, index) => index === 0 ? { ...row,
                headerVersion: generation, header: encodePlainArtifactStoredContent({ ...baseHeader, title: `Revision ${generation}` }),
            } : row);
            await refresh();
        }
        await afterGc();
        const obsolete = supersededMaps.slice(0, -1);
        console.info('PERF_ARTINV_R4_HEAP', JSON.stringify({ node: process.version, exposedGc: true,
            headers: 41_600, pagesPerRead: 84, totalReads: 11, identicalRefreshes: 10,
            unchangedPublications: 0, unchangedRowIdentities: 41_600,
            bodyReads: fixture.bodyReads.length, empty, fixtureOnly, afterOne, afterTen,
            loadedHeapBytes: afterOne.heapUsed - fixtureOnly.heapUsed,
            repeatHeapBytes: afterTen.heapUsed - afterOne.heapUsed,
            obsoleteMapCount: obsolete.length, obsoleteMapsAlive: obsolete.filter(reference => reference.deref() !== undefined).length,
        }));
        expect(artifactPublications).toBe(4);
        expect(obsolete.every(reference => reference.deref() === undefined),
            'settled reads must not retain prior cohort maps beyond the mounted React alternate').toBe(true);
    } finally {
        stop();
        await screen.unmount();
        await fixture.dispose();
        vi.restoreAllMocks();
    }
}, 180_000);
