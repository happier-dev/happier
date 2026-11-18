// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageSourceInstanceDraftV1Schema,
    type TriageScanInputV1,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';

import { listTriageEntries, type TriageAdmittedSourceV1 } from '../../actions/listEntries.js';
import { TriageListEntriesInputV1Schema } from '../../actions/listEntriesProtocol.js';
import { administerConfiguredSourceInstance } from '../../corpus/configuration/administerConfiguredSourceInstance.js';
import { createTestkitCorpusCollections, selectTestkitExternalSourceInput } from '../../corpus/testkit/corpusCollections.test-support.js';
import { TESTKIT_SOURCE_INSTANCE_ID, TRIAGE_TESTKIT_SOURCE, testkitLocator, testkitSnapshot, testkitViewer } from '../../corpus/testkit/observations.test-support.js';
import type { TriageRefreshTriggerV1 } from '../../refresh/refreshEligibility.js';
import { createTriageEphemeralSharedScopeOriginFixture } from './ephemeralSharedScope.test-support.js';
import { acquireTriageListWindow, loadMoreTriageListWindow, readTriageListWindowReadOwner, refreshTriageListWindow, type TriageListWindowHostV1 } from './mountedWindow.js';
import { useTriageListWindowViewDemand } from './useTriageListWindowViewDemand.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function present(entryId: string) {
    return { kind: 'present' as const,
        localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId },
        locator: testkitLocator(), snapshot: testkitSnapshot({ title: entryId }), viewer: testkitViewer() };
}

async function configuredMount() {
    const clock = { nowMs: 1_760_000_000_000 };
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);
    const { collections } = createTestkitCorpusCollections();
    // Admission and provider execution are host boundaries; every Triage owner
    // from configuration through the mounted scheduler and aggregate is real.
    const admitted = {
        contributor: { pluginId: TRIAGE_TESTKIT_SOURCE.pluginId, contributionId: TRIAGE_TESTKIT_SOURCE.localId, immutableGenerationId: 'generation-1' },
        protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 },
        descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example forge',
            kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }] },
        operations: { listInstances: {}, scan: {}, get: {} }, surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1;
    const state = { scan: async (_input: TriageScanInputV1): Promise<TriageScanResultV1> => ({
        kind: 'complete', evidence: { kind: 'walkFinished' }, observations: [present('retained')],
    }) };
    const pages: TriageScanInputV1['page'][] = [];
    const host: TriageListWindowHostV1 = {
        async executeAction(_action, rawInput, options) {
            return listTriageEntries(await selectTestkitExternalSourceInput(
                TriageListEntriesInputV1Schema.parse(rawInput), collections.sourceInstances,
            ), {
                sourceInstances: collections.sourceInstances,
                readSourceSnapshot: async () => ({ contributions: [admitted] }),
                executeScan: async (_operation, input) => { pages.push(input.page); return state.scan(input); },
                nowMs: () => clock.nowMs, signal: options?.signal,
            });
        },
    };
    const configured = await administerConfiguredSourceInstance({
        collections, source: TRIAGE_TESTKIT_SOURCE, declaredPurpose: 'triage-source',
        request: { kind: 'create', draft: TriageSourceInstanceDraftV1Schema.parse({
            v: 1, binding: { purpose: 'triage-source', account: {
                service: { pluginId: TRIAGE_TESTKIT_SOURCE.pluginId, localId: 'accounts' }, accountId: 'account-1',
            } }, localInstanceKey: 'example/repository', keyStability: 'stable',
            configuration: { v: 1, token: 'routing-token' }, locator: { v: 1, displayLabel: 'example/repository' },
        }) }, nowMs: clock.nowMs, mintSourceInstanceId: () => TESTKIT_SOURCE_INSTANCE_ID,
    });
    expect(configured).toEqual({ kind: 'active', sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID });
    expect(pages).toEqual([]);
    const lifetime = createTriageEphemeralSharedScopeOriginFixture();
    const scope = lifetime.forExecutionOrigin('daemon-a');
    const lease = acquireTriageListWindow(host, scope);
    const store = readTriageListWindowReadOwner(host, scope)!;
    return { clock, pages, state, store,
        refresh: (trigger: TriageRefreshTriggerV1) => refreshTriageListWindow(trigger, host, scope),
        loadMore: () => loadMoreTriageListWindow(host, scope),
        dispose() { lease.release(); lifetime.retire(); dateNow.mockRestore(); },
    };
}

it('coalesces populated mount and host reactivation demands with one queued manual follow-up', async () => {
    const fixture = await configuredMount();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const demands: Promise<void>[] = [];
    const refresh = (trigger: TriageRefreshTriggerV1) => {
        const pending = fixture.refresh(trigger);
        demands.push(pending);
        return pending;
    };
    const readiness = Object.freeze({ pending: false, ready: true, revision: 0 });
    function Consumer({ active }: { active: boolean }) {
        useTriageListWindowViewDemand(active, refresh, readiness, fixture.store);
        return null;
    }
    async function render(active: boolean) {
        await act(async () => { root.render(React.createElement(React.Fragment, null,
            React.createElement(Consumer, { active }), React.createElement(Consumer, { active }))); });
    }
    let release = () => {};
    try {
        expect(fixture.pages).toEqual([]);
        await render(true);
        await Promise.all(demands);
        expect(fixture.pages.map(page => page.kind)).toEqual(['initial']);
        const retained = fixture.store.getSnapshot().window;
        expect(retained?.rows.map(row => row.entryRef.entryId)).toEqual(['retained']);
        await render(false);
        const held = new Promise<void>(resolve => { release = resolve; });
        fixture.state.scan = async () => {
            await held;
            return { kind: 'complete', evidence: { kind: 'walkFinished' }, observations: [present('refreshed')] };
        };
        await render(true);
        await vi.waitFor(() => expect(fixture.pages).toHaveLength(2));
        expect(fixture.store.getSnapshot().window?.rows).toBe(retained?.rows);
        await render(false);
        await render(true);
        const manual = [fixture.refresh('manual'), fixture.refresh('manual')];
        expect(fixture.pages).toHaveLength(2);
        release();
        await Promise.all([...demands, ...manual]);
        expect(fixture.pages.map(page => page.kind)).toEqual(['initial', 'initial', 'initial']);
        expect(fixture.store.getSnapshot().window?.rows.map(row => row.entryRef.entryId)).toEqual(['refreshed']);
        expect(fixture.store.getSnapshot().pending).toBe('idle');
    } finally {
        release();
        await act(async () => { root.unmount(); });
        container.remove();
        fixture.dispose();
    }
});

it('publishes provider waiting health without a timer and restarts initial on the next eligible mounted demand', async () => {
    const fixture = await configuredMount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
        const deadlineMs = fixture.clock.nowMs + 1_000;
        fixture.state.scan = async input => input.page.kind === 'initial'
            ? { kind: 'page', evidence: { kind: 'partial', reason: 'more-pages' }, observations: [present('retained')], continuation: { v: 1, token: 'only-this-walk' } }
            : { kind: 'failed', failure: { class: 'rateLimit', code: 'provider-wait', retryNotBeforeMs: deadlineMs } };
        await fixture.refresh('view');
        await fixture.loadMore();
        expect(fixture.pages.map(page => page.kind)).toEqual(['initial', 'continuation']);
        expect(fixture.store.getSnapshot().refreshBlocked).toEqual({ reason: 'sourceRetryDeadline', nextEligibleAtMs: deadlineMs });
        expect(fixture.store.getSnapshot().window?.lanes[0]?.health).toEqual({ kind: 'failed', failure: { class: 'rateLimit', code: 'provider-wait', retryNotBeforeMs: deadlineMs } });
        await Promise.all([fixture.refresh('view'), fixture.refresh('manual')]);
        expect(fixture.pages).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
        fixture.clock.nowMs = deadlineMs;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fixture.pages).toHaveLength(2);
        fixture.state.scan = async () => ({ kind: 'complete', evidence: { kind: 'walkFinished' }, observations: [present('recovered')] });
        await fixture.refresh('view');
        expect(fixture.pages.map(page => page.kind)).toEqual(['initial', 'continuation', 'initial']);
        expect(fixture.store.getSnapshot().refreshBlocked).toBeUndefined();
        expect(fixture.store.getSnapshot().window?.rows.map(row => row.entryRef.entryId)).toEqual(['recovered']);
    } finally { fixture.dispose(); vi.useRealTimers(); }
});
