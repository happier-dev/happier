import { expect, it, vi } from 'vitest';
import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { listTriageEntries, type TriageAdmittedSourceV1 } from '../../actions/listEntries.js';
import { TriageListEntriesInputV1Schema } from '../../actions/listEntriesProtocol.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../../corpus/collections/rowCodec.js';
import { createTestkitCorpusCollections, selectTestkitExternalSourceInput } from '../../corpus/testkit/corpusCollections.test-support.js';
import { testkitLocator, testkitSnapshot, testkitViewer } from '../../corpus/testkit/observations.test-support.js';
import { triageEntryRowKey } from '../../projection/listWindow.js';
import { createTriageEphemeralSharedScopeOriginFixture } from './ephemeralSharedScope.test-support.js';
import {
    acquireTriageListWindow,
    readTriageListWindowReadOwner,
    refreshTriageListWindow,
    type TriageListWindowHostV1,
} from './mountedWindow.js';

it('keeps a retired populated mount inert when its admitted provider scan settles late', async () => {
    const source = { pluginId: 'happier.example.source', localId: 'example-forge' };
    const sourceInstanceId = '11111111-1111-4111-8111-111111111111';
    const { collections, control } = createTestkitCorpusCollections();
    const seeded = control.sourceInstances.seed(toCorpusStoredValue({
        instanceTag: 'a'.repeat(43),
        sourceQualifiedId: `${source.pluginId}/${source.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1,
        configured: TriageConfiguredSourceInstanceV1Schema.parse({
            v: 1, instance: { source, sourceInstanceId },
            binding: { purpose: 'triage-source', account: {
                service: { pluginId: source.pluginId, localId: 'accounts' }, accountId: 'account-1',
            } },
            localInstanceKey: 'example/repository', configuration: { v: 1, token: 'routing-token' },
        }),
    }));
    // The host's admitted operation handles are the external execution boundary.
    const admitted = {
        contributor: { pluginId: source.pluginId, contributionId: source.localId, immutableGenerationId: 'generation-1' },
        protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 },
        descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example forge',
            kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }] },
        operations: { listInstances: {}, scan: {}, get: {} }, surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1;
    let held: Promise<void> | undefined;
    let release = () => {};
    const scanState: { signal?: AbortSignal } = {};
    let entryId = 'baseline';
    const host: TriageListWindowHostV1 = {
        async executeAction(_action, rawInput, options) {
            return listTriageEntries(await selectTestkitExternalSourceInput(
                TriageListEntriesInputV1Schema.parse(rawInput), collections.sourceInstances,
            ), {
                sourceInstances: collections.sourceInstances,
                readSourceSnapshot: async () => ({ contributions: [admitted] }),
                executeScan: async (_operation, _input, scanOptions) => {
                    if (held) scanState.signal = scanOptions?.signal;
                    if (held) await held;
                    return { kind: 'complete', evidence: { kind: 'walkFinished' }, observations: [{
                        kind: 'present', localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId },
                        locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer(),
                    }] };
                },
                nowMs: () => 1_760_000_000_000,
                signal: options?.signal,
            });
        },
    };
    const lifetime = createTriageEphemeralSharedScopeOriginFixture();
    const scope = lifetime.forExecutionOrigin('daemon-a');
    const lease = acquireTriageListWindow(host, scope);
    try {
        await refreshTriageListWindow('view', host, scope);
        const store = readTriageListWindowReadOwner(host, scope)!;
        expect(store.getSnapshot().window?.rows.map(row => row.entryRef.entryId)).toEqual(['baseline']);
        const published = vi.fn();
        store.subscribe(published);
        held = new Promise<void>(resolve => { release = resolve; });
        entryId = 'late-row';
        const pending = refreshTriageListWindow('manual', host, scope);
        await vi.waitFor(() => expect(scanState.signal).toBeDefined());
        lifetime.retire();
        published.mockClear();
        release();
        await pending;
        expect.soft(published).not.toHaveBeenCalled();
        expect.soft(store.getSnapshot().window?.rows.map(row => row.entryRef.entryId)).not.toContain('late-row');
        expect.soft(store.getRow(triageEntryRowKey({ source, kindId: 'pull-request', collisionScope: 'example/repository', entryId: 'late-row' }))).toBeNull();
        expect.soft(control.sourceInstances.inspect(seeded.rowId)).toEqual({ revision: seeded.revision, deleted: false });
    } finally {
        release();
        lease.release();
        lifetime.retire();
    }
});
