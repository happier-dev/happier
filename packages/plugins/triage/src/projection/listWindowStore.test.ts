import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageScanInputV1,
    type TriageScanResultV1,
    type TriageSourceFailureV1,
    type TriageSourceScanObservationV1,
    type TriageSourceViewerFactsV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createTriageListPublicationV1 } from '../ui/list/publication.js';
import { planTriageListItemsV1 } from '../ui/list/sections.js';
import { fileURLToPath } from 'node:url';
import { fixtureCommandTimeoutMs, runBoundedFixtureCommand } from '../../../../plugin-sdk/src/test-support/boundedFixtureCommand.js';

import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import {
    MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
    TriageListEntriesResultV1Schema,
    type TriageListEntriesInputV1,
} from '../actions/listEntriesProtocol.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { createTestkitCorpusCollections, selectTestkitExternalSourceInput } from '../corpus/testkit/corpusCollections.test-support.js';
import { createTestkitEmptyInternalTaskSource } from '../corpus/testkit/internalTaskSource.test-support.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../internalTasks/configuration.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1, TRIAGE_LIST_DEFAULT_LENS_V1, triageEntryRowKey } from './listWindow.js';
import { createTriageListWindowStore } from './listWindowStore.js';
import { readTriageListFailureNotice, readTriageSourceFailureRowV1, resolveTriageListShellState } from '../ui/shell/windowState.js';
import { projectTriagePickerCorpusFacts } from '../composer/pickerFacts.js';
import { projectTriageWindowRow } from '../ui/marks/pinnedRows.js';
import { readTriageEntryRowAnnouncementV1 } from '../ui/window/entryDisplay.js';

it('keeps the read model off device storage and starts fresh after its populated process exits', async () => {
    const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
    const runner = fileURLToPath(new URL('../../../../../node_modules/vite-node/vite-node.mjs', import.meta.url));
    const fixture = fileURLToPath(new URL('./listWindowStore.process.test-support.ts', import.meta.url));
    const results: Array<{ phase: string; pid: number; deviceWrites: string[]; durableWrites: string[] }> = [];
    for (const phase of ['populate', 'fresh']) {
        const output = await runBoundedFixtureCommand(`QB84 ${phase} process`, packageRoot,
            [runner, '--config', 'vitest.config.ts', fixture, phase]);
        const record = output.split('\n').find(line => line.startsWith('QB84_PROCESS '));
        expect(record, output).toBeDefined();
        const result = JSON.parse(record!.slice('QB84_PROCESS '.length)) as (typeof results)[number];
        expect(result.phase).toBe(phase);
        expect(result.deviceWrites).toEqual([]);
        expect(result.durableWrites).toEqual([]);
        results.push(result);
        console.info(record);
    }
    expect(results[0]?.pid).not.toBe(results[1]?.pid);
}, fixtureCommandTimeoutMs * 2);

/**
 * The composed PRs & Issues vertical, driven end to end.
 *
 * Nothing here is a unit stand-in for the aggregate: the store drives the real
 * refresh coordinator, which drives the real aggregate list Action, which reads
 * the real declared `source-instances` Collection through the in-memory store
 * boundary, walks the real published `scan` protocol against fixture sources,
 * and folds the result through the real qualification, presence, attention,
 * selection and ordering owners. Only three genuine boundaries are replaced:
 * the Account Collection store, the host's admitted-contribution view, and the
 * host's Action dispatcher.
 */

const SOURCE_A = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const SOURCE_B = Object.freeze({ pluginId: 'happier.other.source', localId: 'other-forge' });
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';
const INTERNAL_INSTANCE_ID = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId;

type ScanFn = (input: TriageScanInputV1) => Promise<TriageScanResultV1>;

function configuredInstance(
    source: Readonly<{ pluginId: string; localId: string }>,
    sourceInstanceId: string,
    accountId = 'account-1',
): TriageConfiguredSourceInstanceV1 {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source, sourceInstanceId },
        binding: {
            purpose: 'triage-source',
            account: { service: { pluginId: source.pluginId, localId: 'accounts' }, accountId },
        },
        localInstanceKey: 'example/repository',
        configuration: { v: 1, token: 'routing-token' },
        locator: { v: 1, displayLabel: 'example/repository' },
    });
}

function instanceRow(
    tagSeed: string,
    source: Readonly<{ pluginId: string; localId: string }>,
    sourceInstanceId: string,
    configuredAtMs: number,
    accountId?: string,
): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: `${tagSeed}${'0'.repeat(43 - tagSeed.length)}`,
        sourceQualifiedId: `${source.pluginId}/${source.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs,
        configured: configuredInstance(source, sourceInstanceId, accountId),
    };
}

function presentObservation(input: Readonly<{
    entryId: string;
    title: string;
    sourceUpdatedAtMs: number;
    involvement?: TriageSourceViewerFactsV1['involvement'];
}>): TriageSourceScanObservationV1 {
    return {
        kind: 'present',
        localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: input.entryId },
        locator: testkitLocator(),
        snapshot: testkitSnapshot({ title: input.title }),
        viewer: testkitViewer(input.involvement ? { involvement: input.involvement } : {}),
        sourceUpdatedAtMs: input.sourceUpdatedAtMs,
    };
}

/**
 * The two page bodies the endless source alternates between, built once.
 *
 * The mount ceiling case makes hundreds of bounded invocations, so rebuilding a
 * full page of observations for each of them measured the fixture rather than
 * the store.
 */
const ENDLESS_PAGES: readonly (readonly TriageSourceScanObservationV1[])[] = Object.freeze([0, 1]
    .map((parity) => Object.freeze(Array.from(
        { length: MAX_TRIAGE_LIST_WINDOW_ROWS_V1 },
        (unused, index) => presentObservation({
            entryId: `p${parity}-${index}`,
            title: `Change ${parity}.${index}`,
            // The first page reads newest, so the newest-first order puts each
            // appended window after the rows already on screen.
            sourceUpdatedAtMs: 1_000_000
                - ((parity === 1 ? 0 : 1) * MAX_TRIAGE_LIST_WINDOW_ROWS_V1 + index),
        }),
    ))));

function endlessPage(parity: number): readonly TriageSourceScanObservationV1[] {
    return ENDLESS_PAGES[parity] ?? [];
}

function createHarness(options: Readonly<{
    admitSourceB?: boolean;
    /** Seeded by default; a single-connection mount is its own configured set. */
    configureSourceA?: boolean;
    configureSourceB?: boolean;
    admitInternal?: boolean;
    wholeCatalog?: boolean;
    /** Two distinct configured accounts of one source can observe one canonical entry. */
    sameSourceForB?: boolean;
    /** Substitute only the provider scan boundary for a discriminating walk fixture. */
    scanA?: ScanFn;
    sortFields?: readonly import('@happier-dev/triage-protocol/v1').TriageListSortFieldV1[];
}> = {}) {
    const admitSourceB = options.admitSourceB ?? true;
    const sourceForB = options.sameSourceForB ? SOURCE_A : SOURCE_B;
    const { collections, control } = createTestkitCorpusCollections();
    if (options.configureSourceA ?? true) {
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow('a', SOURCE_A, INSTANCE_A, 1)));
    }
    if (options.configureSourceB ?? true) {
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow(
            'b',
            sourceForB,
            INSTANCE_B,
            2,
            options.sameSourceForB ? 'account-2' : undefined,
        )));
    }

    const scans = new Map<object, ScanFn>();
    const scanCalls = { count: 0 };
    const actionInputs: TriageListEntriesInputV1[] = [];

    function admittedSource(
        source: Readonly<{ pluginId: string; localId: string }>,
        scan: ScanFn,
    ): TriageAdmittedSourceV1 {
        const handle = { role: 'scan', of: source.localId };
        scans.set(handle, scan);
        // The admitted entry is a host-created value whose operation handles are
        // deliberately non-constructible; a fixture stands in for the host at
        // that exact boundary and nowhere else.
        return {
            contributor: {
                pluginId: source.pluginId,
                contributionId: source.localId,
                immutableGenerationId: 'generation-1',
            },
            protocol: {
                id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
                version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
            },
            descriptor: {
                v: 1,
                purpose: 'triage-source',
                displayName: 'Example forge',
                ...(options.sortFields === undefined ? {} : { sortFields: options.sortFields }),
                kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }],
            },
            operations: { listInstances: {}, scan: handle, get: {} },
            surfaces: { detail: {} },
        } as unknown as TriageAdmittedSourceV1;
    }

    const state = {
        titleOfFirstEntry: 'Replace the duplicated normalizer',
        sourceBFails: false,
        sourceBInvocationRejected: false,
        enumerationRejected: false,
        /** The exact rejection the aggregate enumeration answers with, when set. */
        enumerationRejectedWith: null as unknown,
        enumerationRepeatsCursor: false,
        /** A typed failure source A answers with instead of a page, when set. */
        sourceAFailure: null as TriageSourceFailureV1 | null,
        /** The same for source B, so two connections can wait out different deadlines. */
        sourceBFailure: null as TriageSourceFailureV1 | null,
        /**
         * Source A admits its first page and then fails the continuation — the
         * ordinary shape of a walk that is interrupted part way through.
         */
        sourceASecondPageFails: false,
        /** Holds source A's next scan open so lens/config changes can cross an in-flight page. */
        holdSourceA: null as Promise<void> | null,
        /** The admitted contribution can disappear without retiring its configured row. */
        sourceAContributionAvailable: true,
        /** Makes source A's answer visibly depend on the exact configured Account. */
        sourceAUsesConfigurationIdentity: false,
        /** Holds source B's scan open, standing in for a connection that has not answered yet. */
        holdSourceB: null as Promise<void> | null,
        /**
         * Source A qualifies more observations than one window carries and then
         * reports a settled end — a source whose own provider page is smaller
         * than the page we asked for, finishing on its second one.
         */
        sourceAOverDelivers: false,
        /**
         * Replaces source A's normal two-page walk with one visibly different
         * generation whose terminal evidence decides whether the mounted lane
         * may replace its prior scan membership.
         */
        sourceAReplacementOutcome: null as 'baseline' | 'walkFinished' | 'failsAfterPage' | null,
        /**
         * Which set of entries the over-delivering walk answers with. Bumping it
         * makes a later pass name entirely different entries while STILL being
         * cut short, which is the shape that must not delete what it never
         * reached.
         */
        sourceAGeneration: 1,
        /**
         * Source A fills the Action's whole observation budget on every page and
         * always offers another — the shape that makes ONE invocation return a
         * bounded window plus a continuation, which is what a mount appends.
         *
         * Its entry ids alternate between two page sets rather than growing with
         * the depth. The first append still reaches entries past the transport
         * bound, which is the product fact; deeper ones re-name entries the
         * merge already holds, which keeps the ceiling case from folding two
         * thousand rows thirty-six times to prove one bound.
         */
        sourceANeverFinishes: false,
        /** Both lanes advance one row at a time so a mixed transport page returns two frontiers. */
        mixedSourcesNeverFinish: false,
        /**
         * Source A meets ONE entry through two involvement lanes of the same
         * walk: the first window reports the review request, the terminal
         * window reports the same entry as merely participating. That is what
         * the first-party GitHub scan owner deliberately emits — one encounter
         * per native lane, no pre-dedupe, relying on the aggregate to union.
         */
        sourceASplitsInvolvementAcrossWindows: false,
        /**
         * The next walk is authoritative and no longer reports the review
         * request at all. A fresh completed walk must be able to remove it.
         */
        sourceADropsReviewRequest: false,
        /**
         * Every configured instance returns exactly the page size the aggregate
         * submitted, with distinct rows. This exposes transport-batch geometry:
         * a 32-source batch and a one-source batch must share one mounted
         * window's row allowance rather than each spending it in full.
         */
        rowsPerSubmittedLimit: false,
        /** Entry ids the provider boundary handed to the aggregate. */
        acquiredEntryIds: [] as string[],
    };

    const scanA: ScanFn = async (input) => {
        scanCalls.count += 1;
        if (options.scanA !== undefined) return await options.scanA(input);
        if (state.holdSourceA !== null) await state.holdSourceA;
        if (state.rowsPerSubmittedLimit) {
            const limit = input.page.kind === 'initial' ? input.page.limit : 1;
            const sourceInstanceId = input.instance.instance.sourceInstanceId;
            const observations = Array.from({ length: limit }, (unused, index) => {
                const entryId = `${sourceInstanceId}-${String(index).padStart(2, '0')}`;
                state.acquiredEntryIds.push(entryId);
                return presentObservation({
                    entryId,
                    title: `Change ${entryId}`,
                    sourceUpdatedAtMs: 10_000 - index,
                });
            });
            return {
                kind: 'complete',
                observations,
                evidence: { kind: 'walkFinished' },
            };
        }
        if (state.sourceAUsesConfigurationIdentity) {
            const accountId = input.instance.binding.account.accountId;
            return accountId === 'account-1'
                ? {
                    kind: 'page',
                    observations: [presentObservation({
                        entryId: 'configured-account-1',
                        title: 'First configured account',
                        sourceUpdatedAtMs: 3_000,
                    })],
                    evidence: { kind: 'partial', reason: 'more-pages' },
                    continuation: { v: 1, token: 'old-configuration-page-2' },
                }
                : {
                    kind: 'complete',
                    observations: [presentObservation({
                        entryId: 'configured-account-2',
                        title: 'Replacement configured account',
                        sourceUpdatedAtMs: 4_000,
                    })],
                    evidence: { kind: 'walkFinished' },
                };
        }
        if (options.sameSourceForB) {
            const isSecondAccount = input.instance.instance.sourceInstanceId === INSTANCE_B;
            return {
                kind: 'complete',
                observations: [presentObservation({
                    entryId: 'shared-entry',
                    title: isSecondAccount ? 'Second account view' : 'First account view',
                    sourceUpdatedAtMs: isSecondAccount ? 2_000 : 3_000,
                    ...(isSecondAccount ? { involvement: ['reviewRequested'] as const } : {}),
                })],
                evidence: { kind: 'walkFinished' },
            };
        }
        if (state.mixedSourcesNeverFinish) {
            const page = input.page.kind === 'initial' ? 1 : Number(input.page.continuation.token);
            return {
                kind: 'page',
                observations: [presentObservation({
                    entryId: `a-${page}`,
                    title: `Source A change ${page}`,
                    sourceUpdatedAtMs: 10_000 - page,
                })],
                evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: `${page + 1}` },
            };
        }
        if (state.sourceAFailure !== null) {
            return { kind: 'failed', failure: state.sourceAFailure };
        }
        if (state.sourceASplitsInvolvementAcrossWindows) {
            if (state.sourceADropsReviewRequest) {
                return {
                    kind: 'complete',
                    observations: [presentObservation({
                        entryId: '1',
                        title: state.titleOfFirstEntry,
                        sourceUpdatedAtMs: 3_000,
                        involvement: ['participating'],
                    })],
                    evidence: { kind: 'walkFinished' },
                };
            }
            return input.page.kind === 'initial'
                ? {
                    kind: 'page',
                    observations: [presentObservation({
                        entryId: '1',
                        title: state.titleOfFirstEntry,
                        sourceUpdatedAtMs: 3_000,
                        involvement: ['reviewRequested'],
                    })],
                    evidence: { kind: 'partial', reason: 'more-pages' },
                    continuation: { v: 1, token: 'page-2' },
                }
                : {
                    kind: 'complete',
                    observations: [presentObservation({
                        entryId: '1',
                        title: state.titleOfFirstEntry,
                        sourceUpdatedAtMs: 3_000,
                        involvement: ['participating'],
                    })],
                    evidence: { kind: 'walkFinished' },
                };
        }
        if (state.sourceANeverFinishes) {
            const page = input.page.kind === 'initial' ? 1 : Number(input.page.continuation.token);
            return {
                kind: 'page',
                observations: endlessPage(page % 2),
                evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: `${page + 1}` },
            };
        }
        if (state.sourceAOverDelivers) {
            const first = input.page.kind === 'initial';
            const count = first ? MAX_TRIAGE_LIST_WINDOW_ROWS_V1 - 6 : 20;
            const observations = Array.from({ length: count }, (unused, index) => presentObservation({
                entryId: `${first ? 'first' : 'second'}-${state.sourceAGeneration === 1 ? '' : `g${state.sourceAGeneration}-`}${index}`,
                title: `Change ${first ? 'A' : 'B'}${index}`,
                // A later generation reads OLDER so the first one still outranks
                // it: if the earlier entries survive at all, they are visible.
                sourceUpdatedAtMs: (state.sourceAGeneration === 1 ? 3_000 : 1_000)
                    + (first ? index : count + index),
            }));
            return first
                ? {
                    kind: 'page',
                    observations,
                    evidence: { kind: 'partial', reason: 'more-pages' },
                    continuation: { v: 1, token: 'page-2' },
                }
                : { kind: 'complete', observations, evidence: { kind: 'walkFinished' } };
        }
        if (state.sourceAReplacementOutcome !== null) {
            if (state.sourceAReplacementOutcome === 'baseline') {
                return {
                    kind: 'complete',
                    observations: [
                        presentObservation({
                            entryId: '1',
                            title: state.titleOfFirstEntry,
                            sourceUpdatedAtMs: 3_000,
                            involvement: ['reviewRequested'],
                        }),
                        presentObservation({
                            entryId: '2',
                            title: 'Older change',
                            sourceUpdatedAtMs: 1_000,
                        }),
                    ],
                    evidence: { kind: 'walkFinished' },
                };
            }
            if (input.page.kind === 'continuation') {
                return { kind: 'failed', failure: { class: 'transient', code: 'replacement-interrupted' } };
            }
            const observations = [presentObservation({
                entryId: 'replacement-only',
                title: 'Only member of the replacement scan',
                sourceUpdatedAtMs: 4_000,
            })];
            return state.sourceAReplacementOutcome === 'walkFinished'
                ? { kind: 'complete', observations, evidence: { kind: 'walkFinished' } }
                : {
                    kind: 'page',
                    observations,
                    evidence: { kind: 'partial', reason: 'more-pages' },
                    continuation: { v: 1, token: 'replacement-page-2' },
                };
        }
        if (input.page.kind === 'initial') {
            return {
                kind: 'page',
                observations: [presentObservation({
                    entryId: '1',
                    title: state.titleOfFirstEntry,
                    sourceUpdatedAtMs: 3_000,
                    involvement: ['reviewRequested'],
                })],
                evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: 'page-2' },
            };
        }
        if (state.sourceASecondPageFails) {
            return { kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } };
        }
        return {
            kind: 'complete',
            observations: [presentObservation({ entryId: '2', title: 'Older change', sourceUpdatedAtMs: 1_000 })],
            evidence: { kind: 'walkFinished' },
        };
    };

    const scanB: ScanFn = async (input) => {
        scanCalls.count += 1;
        if (state.sourceBFailure !== null) {
            return { kind: 'failed', failure: state.sourceBFailure };
        }
        if (state.sourceBFails) {
            return { kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } };
        }
        if (state.mixedSourcesNeverFinish) {
            const page = input.page.kind === 'initial' ? 1 : Number(input.page.continuation.token);
            return {
                kind: 'page',
                observations: [presentObservation({
                    entryId: `b-${page}`,
                    title: `Source B change ${page}`,
                    sourceUpdatedAtMs: 20_000 - page,
                })],
                evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: `${page + 1}` },
            };
        }
        if (state.holdSourceB !== null) await state.holdSourceB;
        return {
            kind: 'complete',
            observations: [presentObservation({ entryId: '3', title: 'Middle change', sourceUpdatedAtMs: 2_000 })],
            evidence: { kind: 'walkFinished' },
        };
    };

    const internal = createTestkitEmptyInternalTaskSource();
    const external = options.sameSourceForB
        ? [admittedSource(SOURCE_A, scanA)]
        : admitSourceB
            ? [admittedSource(SOURCE_A, scanA), admittedSource(SOURCE_B, scanB)]
            : [admittedSource(SOURCE_A, scanA)];
    const admitted = [...(options.wholeCatalog && options.admitInternal !== false ? [internal.contribution] : []), ...external];
    const executeScan: TriageAdmittedOperationExecutorV1 = async (operation, input, options) => {
        if (operation === internal.contribution.operations.scan) return await internal.scan(operation, input, options);
        const scan = scans.get(operation as unknown as object);
        if (scan === undefined) throw new Error('No admitted scan handle for this operation.');
        return await scan(input);
    };

    const clock = { nowMs: 1_760_000_000_000 };
    const readEntries = async (input: TriageListEntriesInputV1) => {
        actionInputs.push(input);
        // The aggregate read itself is refused: no machine is reachable, so even
        // enumerating the configured instances fails. This is the path a daemon
        // that goes away after a first successful pass takes.
        if (
            state.enumerationRejectedWith !== null
            && input.sources.kind === 'allConfigured'
            && input.limit === 0
        ) {
            throw state.enumerationRejectedWith;
        }
        if (
            state.enumerationRejected
            && input.sources.kind === 'allConfigured'
            && input.limit === 0
        ) {
            throw new Error('The plugin action could not be dispatched: no machine is reachable.');
        }
        // The invocation itself is refused for this one instance — a rejected
        // Action rather than provider evidence about the source.
        if (
            state.sourceBInvocationRejected
            && input.sources.kind === 'selected'
            && input.sources.sourceInstances.map(source => source.sourceInstanceId).includes(INSTANCE_B)
        ) {
            throw new Error('The other forge action was refused.');
        }
        const result = await readAdmittedEntries(input);
        if (
            state.enumerationRepeatsCursor
            && input.sources.kind === 'allConfigured'
            && input.limit === 0
            && input.sources.cursor !== undefined
        ) {
            return { ...result, configuredSourcesStatus: 'truncated' as const, configuredSourcesNextCursor: input.sources.cursor };
        }
        return result;
    };
    const readAdmittedEntries = async (input: TriageListEntriesInputV1) => await listTriageEntries(
        options.wholeCatalog ? input : await selectTestkitExternalSourceInput(input, collections.sourceInstances), {
        sourceInstances: collections.sourceInstances,
        readAdmittedSources: async () => admitted.filter((source) => (
            source.contributor.pluginId !== SOURCE_A.pluginId || state.sourceAContributionAvailable
        )),
        executeScan,
        nowMs: () => clock.nowMs,
    });

    return { actionInputs, clock, collections, control, readEntries, scanCalls, state };
}

describe('the mounted PRs & Issues window store', () => {
    it('publishes an exact observation into retained truth and only its keyed reader, preserving shape until the lens changes', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        try {
            await store.refresh('view');
            const before = store.getSnapshot().window!;
            const row = before.rows.find(candidate => candidate.entryRef.source.pluginId === SOURCE_A.pluginId)!;
            const sibling = before.rows.find(candidate => candidate !== row)!;
            const key = triageEntryRowKey(row.entryRef);
            const changed = vi.fn();
            const untouched = vi.fn();
            const all = vi.fn();
            store.subscribeRow(key, changed);
            store.subscribeRow(triageEntryRowKey(sibling.entryRef), untouched);
            store.subscribe(all);
            const prior = row.observations[0]!;
            if (prior.outcome.kind !== 'present') throw new Error('Expected a present fixture');
            const observation = { ...prior, entryRef: row.entryRef, observedAtMs: prior.observedAtMs + 1,
                outcome: { ...prior.outcome, snapshot: testkitSnapshot({ title: 'Closed after native write',
                    state: { presentation: 'closed', nativeLabel: 'Closed' } }) } };
            const unacquired = { ...observation, entryRef: { ...row.entryRef, entryId: 'exact-only-not-acquired' } };
            expect(store.publishObservation(unacquired)).toBeNull();
            expect(store.getRow(triageEntryRowKey(unacquired.entryRef))).toBeNull();
            expect(store.getSnapshot().window).toBe(before);
            const published = store.publishObservation(observation);
            expect(published?.content?.outcome.snapshot.title).toBe('Closed after native write');
            expect(store.getRow(key)).toBe(published);
            expect(store.getSnapshot().window?.rows.find(candidate => triageEntryRowKey(candidate.entryRef) === key)).toBe(published);
            expect(store.getSnapshot().window?.rows.find(candidate => candidate.entryRef === sibling.entryRef)).toBe(sibling);
            expect(changed).toHaveBeenCalledTimes(1);
            expect(untouched).not.toHaveBeenCalled();
            expect(all).toHaveBeenCalledTimes(1);
            store.publishObservation(observation);
            expect(changed).toHaveBeenCalledTimes(1);
            expect(all).toHaveBeenCalledTimes(1);
            const scans = harness.scanCalls.count;
            store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'Closed after native write' });
            expect(store.getSnapshot().window?.rows).toEqual([published]);
            store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'Middle' });
            expect(store.getSnapshot().window?.rows).not.toContain(published);
            expect(store.getRow(key)).toBe(published);
            expect(harness.scanCalls.count).toBe(scans);
            const unresolved = store.publishObservation({ ...observation, observedAtMs: observation.observedAtMs + 1,
                outcome: { kind: 'unresolved', failure: { class: 'transient', code: 'offline' } } });
            expect(unresolved?.content).toBe(published?.content);
            expect(unresolved?.attention).toBe(published?.attention);
            expect(unresolved?.presence.kind).toBe('unresolved');
        } finally { store.dispose(); }
    });

    it('builds one display item for a title change in a 1,000-row mounted publication', async () => {
        const harness = createHarness({ configureSourceB: false, scanA: async input => {
            const offset = input.page.kind === 'initial' ? 0 : Number(input.page.continuation.token);
            const observations = Array.from({ length: Math.min(MAX_TRIAGE_LIST_WINDOW_ROWS_V1, 1_000 - offset) }, (_, index) => presentObservation({
                entryId: `entry-${offset + index}`, title: `Entry ${offset + index}`, sourceUpdatedAtMs: 10_000 - offset - index,
            }));
            return offset + observations.length === 1_000
                ? { kind: 'complete', evidence: { kind: 'walkFinished' }, observations }
                : { kind: 'page', evidence: { kind: 'partial', reason: 'more-pages' }, observations,
                    continuation: { v: 1, token: `${offset + observations.length}` } };
        } });
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        const publication = createTriageListPublicationV1();
        let builds = 0;
        publication.setPlanner((rows, previous) => planTriageListItemsV1({ rows, pins: [], workflowSubjectOf: () => {
            builds += 1;
            return 'pullRequest';
        } }, previous));
        const unsubscribe = store.subscribe(change => publication.synchronize(store.getSnapshot(), change));
        try {
            await store.refresh('view');
            while ((store.getSnapshot().window?.rows.length ?? 0) < 1_000) {
                expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
                await store.loadMore();
            }
            expect(publication.getItems()).toHaveLength(1_000);
            const before = publication.getItems();
            const revision = publication.getRevision();
            const row = store.getSnapshot().window!.rows[0]!;
            const sibling = store.getSnapshot().window!.rows[1]!;
            const siblingReads = vi.fn();
            store.subscribeRow(triageEntryRowKey(sibling.entryRef), siblingReads);
            builds = 0;
            const updated = store.publishObservation({ ...row.observations[0]!, entryRef: row.entryRef,
                outcome: { ...row.content!.outcome, snapshot: { ...row.content!.outcome.snapshot, title: 'Changed title' } } });
            expect(updated?.content?.outcome.snapshot.title).toBe('Changed title');
            expect(builds).toBe(1);
            expect(publication.getRevision()).toBe(revision);
            expect(publication.getItems()).toBe(before);
            expect(publication.getItem(triageEntryRowKey(row.entryRef))?.row.title).toBe('Changed title');
            expect(siblingReads).not.toHaveBeenCalled();
            // Activation uses the display projection's selected connection, including a connection-only change.
            const selected = { ...updated!, selected: { kind: 'selected' as const, sourceInstanceId: INSTANCE_B,
                reason: 'onlyPresent' as const } };
            const current = store.getSnapshot();
            publication.synchronize({ ...current, window: { ...current.window!,
                rows: current.window!.rows.map(value => value === updated ? selected : value) } }, {
                changedRows: [selected], metadataChanged: false, structureChanged: false,
            });
            expect(publication.getItems().find(item => item.key === triageEntryRowKey(row.entryRef))?.row.sourceInstanceId).toBe(INSTANCE_B);
            expect(builds).toBe(2);
        } finally { unsubscribe(); store.dispose(); }
    });

    it.each(['complete', 'partial'] as const)('filters 2,000 retained %s rows without provider scans and keeps Load more independent of text', async coverage => {
        const queries: string[] = [];
        const harness = createHarness({ configureSourceB: false, scanA: async input => {
            queries.push(input.query ?? '');
            const offset = input.page.kind === 'initial' ? 0 : Number(input.page.continuation.token);
            const count = offset < 2_000 ? Math.min(MAX_TRIAGE_LIST_WINDOW_ROWS_V1, 2_000 - offset) : 1;
            const observations = Array.from({ length: count }, (_, index) => presentObservation({
                entryId: `entry-${offset + index}`,
                title: (offset + index) % 2 === 0 ? 'triage target' : 'Change',
                sourceUpdatedAtMs: 10_000 - offset - index,
            }));
            return coverage === 'complete' && offset + count === 2_000
                ? { kind: 'complete', evidence: { kind: 'walkFinished' }, observations }
                : { kind: 'page', evidence: { kind: 'partial', reason: 'more-pages' }, observations,
                    continuation: { v: 1, token: `${offset + count}` } };
        } });
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        try {
            await store.refresh('view');
            while ((store.getSnapshot().window?.rows.length ?? 0) < 2_000) await store.loadMore();
            expect(store.getSnapshot().window?.coverage).toBe(coverage);
            const scans = queries.length;
            vi.useFakeTimers();
            for (let length = 1; length <= 'triage'.length; length += 1) {
                store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'triage'.slice(0, length) });
                await vi.runAllTimersAsync();
                expect(queries).toHaveLength(scans);
            }
            expect(store.getSnapshot().window?.rows).toHaveLength(1_000);
            vi.useRealTimers();
            if (coverage === 'partial') {
                expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
                await store.loadMore();
                expect(queries).toHaveLength(scans + 1);
                expect(queries.at(-1)).toBe('');
                expect(harness.actionInputs.at(-1)?.resume?.[0]?.continuation.token).toBe('2000');
                expect(store.getSnapshot().window?.rows).toHaveLength(1_001);
            }
            const scansBeforeClear = queries.length;
            store.setLens(TRIAGE_LIST_DEFAULT_LENS_V1);
            expect(store.getSnapshot().window?.rows).toHaveLength(coverage === 'partial' ? 2_001 : 2_000);
            expect(queries).toHaveLength(scansBeforeClear);
        } finally { store.dispose(); vi.useRealTimers(); }
    });

    it('keeps equal semantic rows, lanes and configured sources while publishing completion separately', async () => {
        const harness = createHarness();
        let projected = 0;
        let sourceLabel: string | undefined;
        const store = createTriageListWindowStore({
            readEntries: async input => {
                const result = await harness.readEntries(input);
                const displayLabel = sourceLabel;
                return displayLabel === undefined ? result : { ...result, configuredSources: result.configuredSources.map(summary =>
                    summary.sourceInstanceId === INSTANCE_A ? { ...summary, displayLabel } : summary) };
            },
            nowMs: () => harness.clock.nowMs,
            onRowProjected: () => { projected += 1; },
        });
        try {
            await store.refresh('view');
            const before = store.getSnapshot();
            expect(before.window?.rows).toHaveLength(2);
            expect(store.project({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'Middle' })?.rows).toHaveLength(1);
            expect(store.getSnapshot().window).toBe(before.window);
            projected = 0;
            for (let refresh = 0; refresh < 3; refresh += 1) {
                // Move across displayed minute units, independently from refresh eligibility.
                harness.clock.nowMs += 60_000;
                await store.refresh('manual');
                const after = store.getSnapshot();
                expect(after.completedAtMs).toBe(harness.clock.nowMs);
                expect(after.window).toBe(before.window);
                expect(after.configuredSources).toBe(before.configuredSources);
            }
            expect(projected).toBe(0);
            const retainedRow = before.window?.rows[0];
            if (retainedRow === undefined) throw new Error('Missing retained fixture row');
            const latest = store.getSnapshot();
            const announcement = (completedAtMs: number | undefined) => readTriageEntryRowAnnouncementV1(
                projectTriageWindowRow(retainedRow, new Map(), { stale: true,
                    ...(completedAtMs === undefined ? {} : { completedAtMs }) }),
                { nowMs: harness.clock.nowMs + 120_000, locale: 'en' });
            expect(announcement(latest.completedAtMs)).not.toBe(announcement(before.completedAtMs));
            expect(store.getSnapshot().window?.rows[0]).toBe(retainedRow);
            const byId = new Map(before.window?.rows.map(row => [row.entryRef.entryId, row]));
            harness.state.titleOfFirstEntry = 'One actual changed finding';
            harness.clock.nowMs += 1;
            await store.refresh('manual');
            expect(projected).toBe(1);
            const after = store.getSnapshot().window;
            expect(after?.rows.filter(row => row !== byId.get(row.entryRef.entryId))).toHaveLength(1);
            expect(after?.lanes).toBe(before.window?.lanes);
            const priorSummaries = store.getSnapshot().configuredSources;
            sourceLabel = 'Renamed source';
            projected = 0;
            harness.clock.nowMs += 1;
            await store.refresh('manual');
            const renamed = store.getSnapshot();
            expect(renamed.window).toBe(after);
            expect(projected).toBe(0);
            expect(renamed.configuredSources.find(summary => summary.sourceInstanceId === INSTANCE_A)?.displayLabel).toBe(sourceLabel);
            expect(renamed.configuredSources.find(summary => summary.sourceInstanceId === INSTANCE_B)).toBe(
                priorSummaries.find(summary => summary.sourceInstanceId === INSTANCE_B));
        } finally { store.dispose(); }
    });

    it('keeps a failed acquisition until explicit retry when the reader changes only a local facet', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        try {
            harness.state.enumerationRejected = true;
            await store.refresh('view');
            expect(store.getSnapshot().error).toBeDefined();
            expect(harness.actionInputs).toHaveLength(1);
            harness.state.enumerationRejected = false;
            store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, filters: { ...TRIAGE_LIST_DEFAULT_LENS_V1.filters,
                sources: [{ source: SOURCE_B }] } });
            expect(harness.actionInputs.filter(input => input.limit === 0)).toHaveLength(1);
            expect(store.getSnapshot().error).toBeDefined();
            await store.refresh('manual');
            expect(store.getSnapshot().error).toBeUndefined();
            expect(store.getSnapshot().window?.rows.map(row => row.entryRef.entryId)).toEqual(['3']);
        } finally { store.dispose(); }
    });

    it('changes the displayed instance lens while keeping every configured lane acquired', async () => {
        const harness = createHarness({ sameSourceForB: true, scanA: async (input) => ({
            kind: 'complete', evidence: { kind: 'walkFinished' },
            observations: [presentObservation({ entryId: input.instance.instance.sourceInstanceId,
                title: input.instance.instance.sourceInstanceId, sourceUpdatedAtMs: 100 })],
        }) });
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        try {
            await store.refresh('view');
            const lensFor = (sourceInstanceId: string) => ({ ...TRIAGE_LIST_DEFAULT_LENS_V1,
                filters: { ...TRIAGE_LIST_DEFAULT_LENS_V1.filters, sources: [{ source: SOURCE_A, sourceInstanceId }] } });
            store.setLens(lensFor(INSTANCE_A));
            expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toEqual([INSTANCE_A]);
            store.setLens(lensFor(INSTANCE_B));
            expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toEqual([INSTANCE_B]);
            expect(store.getSnapshot().window?.lanes).toHaveLength(2);
        } finally { store.dispose(); }
    });

    it('assembles one ordered bounded window from every configured source', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        const snapshot = store.getSnapshot();

        expect(snapshot.pending).toBe('idle');
        expect(snapshot.freshness).toBe('fresh');
        expect(snapshot.error).toBeUndefined();
        expect(snapshot.configuredSources.map((source) => source.sourceInstanceId))
            .toEqual([INSTANCE_A, INSTANCE_B]);
        // Newest activity first, across two sources and across a walked
        // continuation, with the fold keying on the canonical entry reference.
        expect(snapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '3', '2']);
        expect(snapshot.window?.coverage).toBe('complete');
        expect(snapshot.window?.rows[0]?.attention?.reasonId).toBe('involvement/review-requested');
        // Detail and mutations run under the connection the row's own reason
        // names, not under whichever lane happened to answer first.
        expect(snapshot.window?.rows[0]?.selected).toEqual({
            kind: 'selected',
            sourceInstanceId: INSTANCE_A,
            reason: 'attention',
        });
        const transportPages = harness.actionInputs.filter((input) => (
            input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0
        ));
        expect(transportPages.map(input => input.sources)).toEqual([INSTANCE_A, INSTANCE_B, INSTANCE_A]
            .map(id => ({ kind: 'selected', sourceInstances: [{ sourceInstanceId: id, configurationRowId: instanceRow(id === INSTANCE_A ? 'a' : 'b', SOURCE_A, id, 1).instanceTag }] })));
        expect(transportPages[2]?.resume?.map(entry => entry.sourceInstanceId)).toEqual([INSTANCE_A]);
        store.dispose();
    });

    it('enumerates every configured source cursor page then reads each source once through the same coordinator', async () => {
        const harness = createHarness({ configureSourceB: false, wholeCatalog: true });
        for (let index = 0; index < MAX_TRIAGE_LIST_SOURCE_BATCH_V1; index += 1) {
            const sourceInstanceId = `${String(index + 3).padStart(8, '0')}-1111-4111-8111-111111111111`;
            harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow(
                `c${String(index).padStart(4, '0')}x`,
                SOURCE_A,
                sourceInstanceId,
                index + 3,
                `account-${String(index + 3)}`,
            )));
        }
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');

        expect(store.getSnapshot().configuredSources).toHaveLength(MAX_TRIAGE_LIST_SOURCE_BATCH_V1 + 2);
        expect(store.getSnapshot().configuredSources[0]?.sourceInstanceId).toBe(INTERNAL_INSTANCE_ID);
        expect(store.getSnapshot().window?.lanes.find(lane => lane.sourceInstanceId === INTERNAL_INSTANCE_ID))
            .toMatchObject({ exhausted: true, health: { kind: 'walkFinished' } });

        const enumerationPages = harness.actionInputs.filter((input) => (
            input.sources.kind === 'allConfigured' && input.limit === 0
        ));
        expect(enumerationPages).toHaveLength(2);
        expect(enumerationPages[0]?.sources).toEqual({ kind: 'allConfigured' });
        expect(enumerationPages[1]?.sources).toMatchObject({
            kind: 'allConfigured',
            cursor: expect.any(String),
        });

        const batches = harness.actionInputs.filter((input) => (
            input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0
        ));
        expect(batches.map((input) => (
            input.sources.kind === 'selected' ? input.sources.sourceInstances.length : 0
        ))).toEqual(Array.from({ length: MAX_TRIAGE_LIST_SOURCE_BATCH_V1 + 2 }, () => 1));
        expect(batches.reduce((sum, input) => sum + input.limit, 0)).toBe(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(new Set(batches.flatMap((input) => (
            input.sources.kind === 'selected' ? input.sources.sourceInstances.map(source => source.sourceInstanceId) : []
        ))).size).toBe(MAX_TRIAGE_LIST_SOURCE_BATCH_V1 + 2);
        store.dispose();
    });

    it('keeps every row acquired from 33 configured sources visible or resumable', async () => {
        const harness = createHarness({ configureSourceB: false, wholeCatalog: true });
        for (let index = 0; index < MAX_TRIAGE_LIST_SOURCE_BATCH_V1; index += 1) {
            const sourceInstanceId = `${String(index + 3).padStart(8, '0')}-1111-4111-8111-111111111111`;
            harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow(
                `g${String(index).padStart(4, '0')}x`,
                SOURCE_A,
                sourceInstanceId,
                index + 3,
                `account-g${String(index + 3)}`,
            )));
        }
        harness.state.rowsPerSubmittedLimit = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');

        const snapshot = store.getSnapshot();
        const visible = new Set(snapshot.window?.rows.map((row) => row.entryRef.entryId) ?? []);
        const hiddenAcquired = harness.state.acquiredEntryIds.filter((entryId) => !visible.has(entryId));
        const sourceBudgets = harness.actionInputs.filter(input => input.sources.kind === 'selected'
            && input.sources.sourceInstances.map(source => source.sourceInstanceId).some(id => id !== INTERNAL_INSTANCE_ID));
        expect(harness.state.acquiredEntryIds).toHaveLength(sourceBudgets.reduce((sum, input) => sum + input.limit, 0));
        expect(harness.state.acquiredEntryIds.length).toBeLessThanOrEqual(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(hiddenAcquired.length === 0 || snapshot.loadMore?.kind === 'available').toBe(true);
        store.dispose();
    });

    it('leaves configured sources beyond one 56-row window explicitly resumable', async () => {
        const harness = createHarness({ configureSourceB: false, wholeCatalog: true });
        for (let index = 0; index < (MAX_TRIAGE_LIST_WINDOW_ROWS_V1 + 7); index += 1) {
            const sourceInstanceId = `${String(index + 3).padStart(8, '0')}-1111-4111-8111-111111111111`;
            harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow(
                `h${String(index).padStart(4, '0')}x`,
                SOURCE_A,
                sourceInstanceId,
                index + 3,
                `account-h${String(index + 3)}`,
            )));
        }
        harness.state.rowsPerSubmittedLimit = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');

        const first = store.getSnapshot();
        const firstBatches = harness.actionInputs.filter((input) => (
            input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0
        ));
        expect(firstBatches.map((input) => input.sources.kind === 'selected'
            ? [input.sources.sourceInstances.length, input.limit]
            : [])).toEqual(Array.from({ length: MAX_TRIAGE_LIST_WINDOW_ROWS_V1 }, () => [1, 1]));
        expect(harness.state.acquiredEntryIds).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 - 1);
        expect(first.window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 - 1);
        expect(first.window?.coverage).toBe('partial');
        expect(first.loadMore).toEqual({ kind: 'available' });

        await store.loadMore();

        const allBatches = harness.actionInputs.filter((input) => (
            input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0
        ));
        expect(allBatches.at(-1)?.sources.kind === 'selected'
            ? allBatches.at(-1)?.sources.sourceInstances.length
            : null).toBe(1);
        const visible = new Set(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId) ?? []);
        expect(harness.state.acquiredEntryIds.every((entryId) => visible.has(entryId))).toBe(true);
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'exhausted' });

        // A Refresh restarts the mounted depth while preserving last-known-good
        // lane objects. Those retained lanes must not make the untouched tail
        // look visited in the new acquisition cut.
        await store.refresh('manual');
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
        await store.loadMore();
        const refreshedBatches = harness.actionInputs.filter((input) => (
            input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0
        ));
        expect(refreshedBatches.at(-1)?.sources.kind === 'selected'
            ? refreshedBatches.at(-1)?.sources.sourceInstances.length
            : null).toBe(1);
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'exhausted' });
        store.dispose();
    });

    it.each(['lens', 'transport', 'configuration', 'failed-prefix'] as const)(
        'keeps an unvisited configured suffix reachable after %s replacement',
        async (replacement) => {
            let failPrefix = false;
            const retryAtMs = 1_760_000_010_000;
            const harness = createHarness({ configureSourceA: false, configureSourceB: false, wholeCatalog: true,
                scanA: async (input) => failPrefix && input.instance.instance.sourceInstanceId.startsWith('00000003-') ? {
                    kind: 'failed',
                    failure: { class: 'rateLimit', code: 'prefix-rate-limit', retryNotBeforeMs: retryAtMs },
                } : ({
                    kind: 'complete',
                    observations: [presentObservation({
                        entryId: input.instance.instance.sourceInstanceId,
                        title: 'Change',
                        sourceUpdatedAtMs: 1_000,
                    })],
                    evidence: { kind: 'walkFinished' },
                }),
            });
            const seed = (index: number) => {
                const id = `${String(index + 3).padStart(8, '0')}-1111-4111-8111-111111111111`;
                harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow(
                    `suffix${String(index).padStart(4, '0')}`, SOURCE_A, id, index + 3,
                )));
                return id;
            };
            for (let index = 0; index < MAX_TRIAGE_LIST_WINDOW_ROWS_V1; index += 1) seed(index);
            let suffixId = replacement === 'configuration' ? '' : seed(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
            const store = createTriageListWindowStore({
                readEntries: harness.readEntries,
                nowMs: () => harness.clock.nowMs,
            });
            try {
                await store.refresh('view');
                failPrefix = replacement === 'failed-prefix';
                if (replacement === 'configuration') suffixId = seed(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
                else if (replacement === 'lens') store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, tasks: { completedSinceMs: 123 } });
                else store.replaceReadTransport();
                await store.refresh('manual');

                if (failPrefix) {
                    expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
                    await store.loadMore();
                    expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toContain(suffixId);
                    expect(store.getSnapshot().window?.lanes.some((lane) => lane.health.kind === 'failed')).toBe(true);
                    failPrefix = false;
                    harness.clock.nowMs = retryAtMs;
                    await store.refresh('manual');
                }

                expect(store.getSnapshot().window?.coverage).toBe('partial');
                expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
                await store.loadMore();
                expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toContain(suffixId);
                expect(store.getSnapshot().window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 + 1);
                expect(store.getSnapshot().loadMore).toEqual({ kind: 'exhausted' });
                const batches = harness.actionInputs.filter((input) => input.sources.kind === 'selected');
                expect(batches.every((input) => input.sources.kind === 'selected'
                    && input.sources.sourceInstances.length <= MAX_TRIAGE_LIST_SOURCE_BATCH_V1
                    && input.limit <= MAX_TRIAGE_LIST_WINDOW_ROWS_V1)).toBe(true);
            } finally {
                store.dispose();
            }
        },
    );

    it('publishes only the refreshed walk membership when its terminal page arrives on Load More', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceAReplacementOutcome = 'baseline';
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });
        try {
            await store.refresh('view');
            expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '2']);
            harness.state.sourceAOverDelivers = true;
            await store.refresh('manual');
            const partial = store.getSnapshot();
            expect(partial.window?.coverage).toBe('partial');
            expect(partial.window?.rows.map((row) => row.entryRef.entryId)).toEqual(expect.arrayContaining(['1', '2']));

            await store.loadMore();
            const completed = store.getSnapshot();
            expect(completed.window?.coverage).toBe('complete');
            expect(completed.loadMore).toEqual({ kind: 'exhausted' });
            const ids = completed.window?.rows.map((row) => row.entryRef.entryId) ?? [];
            expect(ids).not.toContain('1');
            expect(ids).not.toContain('2');
            expect(ids).toHaveLength(70);
            expect(ids).toEqual(expect.arrayContaining(['first-0', 'first-49', 'second-0', 'second-19']));
            expect(completed.window?.rows.flatMap((row) => row.observations).some(
                (observation) => observation.outcome.kind === 'absent',
            )).toBe(false);
        } finally {
            store.dispose();
        }
    });

    it.each(['walkFinished', 'partial', 'moving', 'failed'] as const)(
        'keeps walk-local facts separate from old continuity rows through a %s terminal refresh page',
        async (outcome) => {
            let refreshing = false;
            const harness = createHarness({ configureSourceB: false, scanA: async (input) => {
                if (!refreshing) return {
                    kind: 'complete',
                    observations: ['old-only', 'seen-on-terminal'].map((entryId) => presentObservation({
                        entryId, title: entryId, sourceUpdatedAtMs: 9_000, involvement: ['reviewRequested'],
                    })),
                    evidence: { kind: 'walkFinished' },
                };
                if (input.page.kind === 'initial') return {
                    kind: 'page',
                    observations: Array.from({ length: 50 }, (_, index) => presentObservation({
                        entryId: index === 0 ? 'shared-in-walk' : `new-${index}`,
                        title: 'New change', sourceUpdatedAtMs: 1_000,
                        involvement: index === 0 ? ['reviewRequested'] : ['participating'],
                    })),
                    evidence: { kind: 'partial', reason: 'more-pages' },
                    continuation: { v: 1, token: 'terminal' },
                };
                if (outcome === 'failed') return {
                    kind: 'failed', failure: { class: 'transient', code: 'terminal-failure' },
                };
                return {
                    kind: 'complete',
                    observations: ['shared-in-walk', 'seen-on-terminal'].map((entryId) => presentObservation({
                        entryId, title: entryId, sourceUpdatedAtMs: 2_000, involvement: ['participating'],
                    })),
                    evidence: outcome === 'walkFinished' ? { kind: 'walkFinished' } : { kind: outcome, reason: 'unsettled' },
                };
            } });
            const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
            try {
                await store.refresh('view');
                refreshing = true;
                await store.refresh('manual');
                expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toContain('old-only');
                await store.loadMore();
                const snapshot = store.getSnapshot();
                const rows = snapshot.window?.rows ?? [];
                expect(rows.some((row) => row.entryRef.entryId === 'old-only')).toBe(outcome !== 'walkFinished');
                expect(snapshot.window?.coverage).toBe(outcome === 'walkFinished' ? 'complete' : 'partial');
                expect(rows.find((row) => row.entryRef.entryId === 'shared-in-walk')?.attention?.reasonId)
                    .toBe('involvement/review-requested');
                if (outcome !== 'failed') {
                    expect(rows.find((row) => row.entryRef.entryId === 'seen-on-terminal')?.attention?.reasonId)
                        .toBe('involvement/participating');
                } else {
                    // A failed walk has no resumable custody. A later clean
                    // first-page walk must not publish its abandoned pages.
                    expect(snapshot.refreshBlocked).toBeUndefined();
                    refreshing = false;
                    await store.refresh('manual');
                    expect(store.getSnapshot().window?.coverage).toBe('complete');
                    expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId).sort())
                        .toEqual(['old-only', 'seen-on-terminal']);
                }
            } finally {
                store.dispose();
            }
        },
    );

    it('publishes each lane completion rather than the last source settlement as the read time', async () => {
        const harness = createHarness();
        const firstCompletedAtMs = harness.clock.nowMs;
        let release = (): void => {};
        const held = new Promise<void>(resolve => { release = resolve; });
        const store = createTriageListWindowStore({
            readEntries: async input => {
                if (input.sources.kind === 'selected' && input.sources.sourceInstances.map(source => source.sourceInstanceId).includes(INSTANCE_B)) await held;
                return harness.readEntries(input);
            },
            nowMs: () => harness.clock.nowMs,
        });
        const cycle = store.refresh('view');
        try {
            await vi.waitFor(() => expect(store.getSnapshot().window?.rows).toHaveLength(1));
            expect(store.getSnapshot()).not.toHaveProperty('completedAtMs');
            harness.clock.nowMs += 1;
        } finally {
            release();
            await cycle;
        }
        expect(store.getSnapshot().freshness).toBe('fresh');
        expect(store.getSnapshot()).toHaveProperty('completedAtMs', firstCompletedAtMs);
        store.dispose();
    });

    it('publishes the oldest successful read time through pacing, failed refresh and recovery', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        try {
            expect(store.getSnapshot()).not.toHaveProperty('completedAtMs');
            const firstCompletedAtMs = harness.clock.nowMs;
            await store.refresh('view');
            expect(store.getSnapshot()).toHaveProperty('completedAtMs', firstCompletedAtMs);

            harness.clock.nowMs += 1;
            await store.refresh('view');
            expect(store.getSnapshot()).toHaveProperty('completedAtMs', firstCompletedAtMs + 1);

            harness.state.sourceBFails = true;
            harness.clock.nowMs += 1;
            await store.refresh('manual');
            expect(store.getSnapshot()).toMatchObject({ freshness: 'stale', completedAtMs: firstCompletedAtMs + 1 });
            harness.state.enumerationRejected = true;
            harness.clock.nowMs += 1;
            await store.refresh('manual');
            expect(store.getSnapshot()).toMatchObject({ freshness: 'stale', completedAtMs: firstCompletedAtMs + 1 });

            harness.state.enumerationRejected = false;
            harness.state.sourceBFails = false;
            harness.clock.nowMs += 1;
            await store.refresh('manual');
            expect(store.getSnapshot()).toMatchObject({ freshness: 'fresh', completedAtMs: harness.clock.nowMs });
            harness.clock.nowMs += 1;
            await store.refresh('manual');
            expect(store.getSnapshot()).toHaveProperty('completedAtMs', harness.clock.nowMs);
        } finally { store.dispose(); }
    });

    it('publishes a completed read even when the retained window content is unchanged', async () => {
        const harness = createHarness({ configureSourceB: false,
            scanA: async () => ({ kind: 'complete', observations: [], evidence: { kind: 'walkFinished' } }),
        });
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        try {
            await store.refresh('view');
            const retained = store.getSnapshot().window;
            let lastPublished: number | undefined;
            const unsubscribe = store.subscribe(() => { lastPublished = store.getSnapshot().completedAtMs; });
            harness.clock.nowMs += 1;
            await store.refresh('manual');
            expect(store.getSnapshot().window).toBe(retained);
            expect(lastPublished).toBe(harness.clock.nowMs);
            unsubscribe();
        } finally { store.dispose(); }
    });

    it('settles a budget-partial and finished mixed pass while naming an unavailable external source', async () => {
        let title = 'Current partial row';
        const harness = createHarness({ scanA: async () => ({
            kind: 'complete',
            observations: [presentObservation({ entryId: 'partial', title, sourceUpdatedAtMs: 3_000 })],
            evidence: { kind: 'partial', reason: 'projection-budget' },
        }) });
        const unavailableId = '33333333-3333-4333-8333-333333333333';
        harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow('c',
            { pluginId: 'external.ledger', localId: 'entries' }, unavailableId, 3)));
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        try {
            await store.refresh('view');
            const snapshot = store.getSnapshot();
            expect(snapshot).toMatchObject({ freshness: 'fresh', pending: 'idle', passes: 1,
                completedAtMs: harness.clock.nowMs });
            expect(snapshot.window).toMatchObject({ coverage: 'partial', lanes: [
                { sourceInstanceId: INSTANCE_A, health: { kind: 'partial', reason: 'projection-budget' } },
                { sourceInstanceId: INSTANCE_B, health: { kind: 'walkFinished' } },
                { sourceInstanceId: unavailableId, health: { kind: 'unavailable' } },
            ] });
            expect(snapshot.window?.rows.map(row => row.entryRef.entryId).sort()).toEqual(['3', 'partial']);
            expect(snapshot.configuredSources.map(source => source.available)).toEqual([true, true, false]);
            expect(snapshot.unreadableSources ?? []).toEqual([]);
            expect(resolveTriageListShellState(snapshot)).toMatchObject({ kind: 'window', stale: false,
                showReadWarning: true, failure: { kind: 'sources', sources: [{ sourceInstanceId: unavailableId }] } });
            // An unavailable contribution adds no provider work or follow-up pass.
            expect(harness.scanCalls.count).toBe(2);
            const calls = harness.actionInputs.length;
            const settledWindow = snapshot.window;
            for (let read = 0; read < 100; read += 1) expect(store.getSnapshot().window).toBe(settledWindow);
            expect(harness.actionInputs).toHaveLength(calls);
            harness.clock.nowMs += 1;
            expect(store.getSnapshot()).toMatchObject({ freshness: 'fresh', completedAtMs: snapshot.completedAtMs });
            expect(harness.actionInputs).toHaveLength(calls);

            // Losing admission retains rows and names availability once, rather
            // than giving its old read error authority over the healthy source.
            harness.state.sourceAContributionAvailable = false;
            await store.refresh('manual');
            const unavailable = store.getSnapshot();
            expect(unavailable).toMatchObject({ freshness: 'fresh', completedAtMs: harness.clock.nowMs });
            expect(unavailable.window?.rows.map(row => row.entryRef.entryId).sort()).toEqual(['3', 'partial']);
            const unavailableShell = resolveTriageListShellState(unavailable);
            expect(unavailableShell.kind === 'window' ? unavailableShell.failure?.sources.map(source => source.sourceInstanceId) : [])
                .toEqual([INSTANCE_A, unavailableId]);

            harness.state.sourceAContributionAvailable = true;
            title = 'Changed after source re-admission';
            harness.clock.nowMs += 1;
            await store.refresh('manual');
            const recovered = store.getSnapshot();
            expect(recovered).toMatchObject({ freshness: 'fresh', completedAtMs: harness.clock.nowMs });
            expect(recovered.window?.rows.find(row => row.entryRef.entryId === 'partial')?.content?.outcome.snapshot.title).toBe(title);
            expect(resolveTriageListShellState(recovered)).toMatchObject({ failure: {
                sources: [{ sourceInstanceId: unavailableId }],
            } });
        } finally { store.dispose(); }
    });

    it('does not claim a completed list read for empty or entirely unavailable configured lanes', async () => {
        for (const empty of [true, false]) {
            const harness = createHarness({ configureSourceA: false, configureSourceB: !empty, admitSourceB: false });
            const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
            try {
                await store.refresh('view');
                expect(store.getSnapshot().window).toBeDefined();
                expect(store.getSnapshot()).not.toHaveProperty('completedAtMs');
            } finally { store.dispose(); }
        }
    });

    it('settles a repeated configured-source cursor instead of looping the mounted read', async () => {
        const harness = createHarness({ configureSourceB: false, wholeCatalog: true });
        for (let index = 0; index < MAX_TRIAGE_LIST_SOURCE_BATCH_V1; index += 1) {
            const sourceInstanceId = `${String(index + 3).padStart(8, '0')}-1111-4111-8111-111111111111`;
            harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow(
                `r${String(index).padStart(4, '0')}x`,
                SOURCE_A,
                sourceInstanceId,
                index + 3,
                `account-r${String(index + 3)}`,
            )));
        }
        harness.state.enumerationRepeatsCursor = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');

        const pages = harness.actionInputs.filter((input) => (
            input.sources.kind === 'allConfigured' && input.limit === 0
        ));
        expect(pages).toHaveLength(2);
        expect(store.getSnapshot().pending).toBe('idle');
        expect(store.getSnapshot().error?.message).toContain('repeated continuation cursor');
        store.dispose();
    });

    it('retains every account observation when one mixed page folds them into one canonical entry', async () => {
        // Two accounts of the same source can legitimately see the same entry.
        // The Action renders the stable content winner (A) in full, while B is
        // the attention/selection winner. Rehydrating only the rendered answer
        // makes the mounted read model choose A again, silently changing where
        // detail and mutations run even though the one mixed Action answered B.
        const harness = createHarness({ sameSourceForB: true });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        try {
            await store.refresh('view');

            const row = store.getSnapshot().window?.rows[0];
            expect(row?.observations.map((observation) => observation.sourceInstanceId))
                .toEqual([INSTANCE_A, INSTANCE_B]);
            expect(row?.attention).toMatchObject({
                level: 'required',
                fromSourceInstanceId: INSTANCE_B,
            });
            expect(row?.selected).toEqual({
                kind: 'selected',
                sourceInstanceId: INSTANCE_B,
                reason: 'attention',
            });
        } finally {
            store.dispose();
        }
    });

    it('projects completed and failed shared reads into the provider-silent picker', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        const pickerFacts = () => {
            const calls = harness.scanCalls.count;
            const facts = projectTriagePickerCorpusFacts({ snapshot: store.getSnapshot(), nowMs: harness.clock.nowMs });
            expect(harness.scanCalls.count).toBe(calls);
            return facts;
        };
        expect(pickerFacts().freshness).toEqual({ kind: 'neverSynchronized' });
        await store.refresh('view');
        expect(pickerFacts().freshness).toEqual({ kind: 'current' });
        const callsAfterFirstPass = harness.scanCalls.count;
        harness.clock.nowMs += 1;
        harness.state.titleOfFirstEntry = 'Consolidate the two normalizers';
        await store.refresh('view');
        expect(harness.scanCalls.count).toBeGreaterThan(callsAfterFirstPass);
        expect(store.getSnapshot().window?.rows[0]?.content?.outcome.snapshot.title)
            .toBe('Consolidate the two normalizers');
        expect(pickerFacts().freshness).toEqual({ kind: 'current' });
        expect(resolveTriageListShellState(store.getSnapshot())).toMatchObject({ stale: false, showReadWarning: false });

        const retainedRows = pickerFacts().rows;
        harness.state.sourceBFails = true;
        await store.refresh('manual');
        expect(pickerFacts().freshness.kind).toBe('stale');
        expect(pickerFacts().rows).toEqual(retainedRows);
        harness.state.sourceBFails = false;
        await store.refresh('manual');
        expect(pickerFacts().freshness).toEqual({ kind: 'current' });
        store.dispose();
    });

    it('keeps the same window, and tells nobody, when a pass or a lens adds nothing new', async () => {
        // Every subscriber re-plans the whole list from a new window: a paced-away view refresh and a re-applied
        // identical lens read nothing new, so they must not hand subscribers a new window to recompute from.
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });
        await store.refresh('view');
        const settled = store.getSnapshot().window;
        expect(settled).toBeDefined();

        harness.clock.nowMs += 1;
        await store.refresh('view');
        expect(store.getSnapshot().window).toBe(settled);

        let notified = 0;
        const unsubscribe = store.subscribe(() => { notified += 1; });
        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1 });
        expect(notified).toBe(0);
        expect(store.getSnapshot().window).toBe(settled);
        unsubscribe();
        store.dispose();
    });

    it('counts the passes that read, so readers keyed on a pass follow reads and not pacing', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });
        expect(store.getSnapshot().passes).toBe(0);
        await store.refresh('view');
        expect(store.getSnapshot().passes).toBe(1);
        // Each settled demand reads, even at the same clock instant.
        await store.refresh('view');
        expect(store.getSnapshot().passes).toBe(2);
        // A manual press reads, even when what it read is unchanged.
        await store.refresh('manual');
        expect(store.getSnapshot().passes).toBe(3);
        store.dispose();
    });

    it('retains successful freshness without scheduling a clock-driven wake', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        try {
            await store.refresh('view');
            const settled = store.getSnapshot();
            const reads = harness.scanCalls.count;
            let publications = 0;
            const unsubscribe = store.subscribe(() => { publications += 1; });
            harness.clock.nowMs += 24 * 60 * 60 * 1_000;
            expect(store.getSnapshot()).toBe(settled);
            expect(store.getSnapshot().freshness).toBe('fresh');
            expect(harness.scanCalls.count).toBe(reads);
            expect(publications).toBe(0);
            unsubscribe();
        } finally { store.dispose(); }
    });

    it('names the connections it could not reach rather than calling the list unreadable', async () => {
        // The regression this closes, twice repaired and twice survived: the
        // store-wide `error` means "the aggregate list read failed", and the
        // shell renders it as the banner "The list could not be read". Writing it
        // while a window is retained puts that sentence beside rows the reader
        // can see — self-evidently false — with a raw transport string as its
        // body. The enumeration failure is the writer that survived the previous
        // two repairs, because it is only reachable once a first pass has
        // already produced a window.
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        expect(store.getSnapshot().window?.rows).toHaveLength(3);

        harness.state.enumerationRejected = true;
        harness.clock.nowMs += 1;
        await store.refresh('manual');

        const snapshot = store.getSnapshot();
        expect(snapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '3', '2']);
        expect(snapshot.error).toBeUndefined();
        // Every connection this pass would have asked is named, because none of
        // them was read — `core/SURFACE.md` §6.2 row 4 asks for the affected
        // connections, not for an anonymous verdict on the list.
        expect((snapshot.unreadableSources ?? []).map((source) => source.sourceInstanceId).sort())
            .toEqual([INSTANCE_A, INSTANCE_B]);
        // And the rows are no longer claimed to be current.
        expect(snapshot.freshness).toBe('stale');
        store.dispose();
    });


    it('still reports a failed aggregate read when no window was ever assembled', async () => {
        // The one honest use of the store-wide slot: there is no list, so "the
        // list could not be read" is exactly what happened.
        const harness = createHarness();
        harness.state.enumerationRejected = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');

        const snapshot = store.getSnapshot();
        expect(snapshot.window).toBeUndefined();
        expect(snapshot.error?.code).toBe('plugin_action_failed');
        store.dispose();
    });

    it('withholds the previous cold-read failure while a retry is pending and restores a genuine failed retry', async () => {
        const harness = createHarness();
        harness.state.enumerationRejected = true;
        let holdRead: Promise<void> | null = null;
        const store = createTriageListWindowStore({
            readEntries: async (input) => {
                if (holdRead !== null) await holdRead;
                return await harness.readEntries(input);
            },
            nowMs: () => harness.clock.nowMs,
        });

        try {
            await store.refresh('view');
            const initialFailure = store.getSnapshot().error;
            expect(initialFailure?.code).toBe('plugin_action_failed');

            for (const failsAgain of [true, false]) {
                let release = () => {};
                holdRead = new Promise<void>((resolve) => { release = resolve; });
                harness.state.enumerationRejected = failsAgain;
                const retry = store.refresh('manual');
                try {
                    await vi.waitFor(() => {
                        expect(store.getSnapshot().pending).toBe('initial');
                    });
                    // No completed first read has answered this attempt yet.
                    // Both shell and picker must see loading, not a verdict
                    // retained from the attempt that just failed.
                    expect(store.getSnapshot().window).toBeUndefined();
                    expect(store.getSnapshot().error).toBeUndefined();
                } finally {
                    release();
                    await retry;
                    holdRead = null;
                }
                expect(store.getSnapshot().pending).toBe('idle');
                if (failsAgain) {
                    expect(store.getSnapshot().error).toEqual(initialFailure);
                    expect(store.getSnapshot().window).toBeUndefined();
                } else {
                    expect(store.getSnapshot().error).toBeUndefined();
                    expect(store.getSnapshot().window?.rows).toHaveLength(2);
                    expect(store.getSnapshot().freshness).toBe('fresh');
                }
            }
        } finally {
            store.dispose();
        }
    });

    it('retains a source invocation Request ID through the scan, window and source disclosures', async () => {
        const requestId = 'a72d338d-5ad9-44c9-b722-f080c7cb84e1';
        const harness = createHarness({ configureSourceB: false, scanA: async () => {
            throw new PluginError({ code: 'plugin_action_generation_retired', retryable: false,
                details: { requestId } });
        } });
        // F's loaded census has fourteen active connections. Keeping their
        // diagnostics must not trigger a second read of any connection.
        const sourceInstanceIds = [INSTANCE_A, ...Array.from({ length: 13 }, (_, index) =>
            `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)];
        for (const [index, sourceInstanceId] of sourceInstanceIds.slice(1).entries()) {
            harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow(
                `request-id-${String(index).padStart(2, '0')}`, SOURCE_A, sourceInstanceId, index + 1,
            )));
        }
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        try {
            await store.refresh('view');
            expect(harness.scanCalls.count).toBe(sourceInstanceIds.length);
            expect(store.getSnapshot().unreadableSources).toHaveLength(sourceInstanceIds.length);
            for (const sourceInstanceId of sourceInstanceIds) {
                expect(store.getSnapshot().unreadableSources).toContainEqual(expect.objectContaining({
                    sourceInstanceId, code: 'plugin_action_generation_retired', requestId,
                }));
            }
            const state = resolveTriageListShellState(store.getSnapshot());
            if (state.kind !== 'window' || state.failure === null) throw new Error('Expected the named source failure');
            expect(state.failure.sources).toHaveLength(sourceInstanceIds.length);
            for (const source of state.failure.sources) {
                expect(source).toMatchObject({ requestId });
                expect(readTriageSourceFailureRowV1(source).details).toContain(requestId);
            }
            expect(readTriageListFailureNotice(state.failure).details).toContain(requestId);
        } finally {
            store.dispose();
        }
    });
    it('keeps whether retrying can help, and the host diagnostic, beside the aggregate failure', async () => {
        // The shell used to print the host's bare code ("unavailable") as the
        // sentence and offered Refresh whatever the host said. The store keeps
        // the host's own classification instead: whether a retry can succeed,
        // and the diagnostic a support reader needs behind a disclosure.
        const permanent = createHarness();
        permanent.state.enumerationRejectedWith = new PluginError({
            code: 'unsupported_method',
            retryable: false,
            diagnostics: [{ code: 'host_api_method_not_installed:executeAction', severity: 'error' }],
        });
        const permanentStore = createTriageListWindowStore({
            readEntries: permanent.readEntries,
            nowMs: () => permanent.clock.nowMs,
        });
        await permanentStore.refresh('view');
        expect(permanentStore.getSnapshot().error).toEqual({
            code: 'unsupported_method',
            message: 'unsupported_method',
            retryable: false,
            diagnostics: ['host_api_method_not_installed:executeAction'],
            detail: 'unsupported_method · host_api_method_not_installed:executeAction',
        });
        permanentStore.dispose();

        const unsettled = createHarness();
        unsettled.state.enumerationRejectedWith = new PluginError({
            code: 'timeout',
            retryable: false,
            details: { requestId: 'list-read-request' },
            diagnostics: [{ code: 'plugin_ui_action_outcome_unknown', severity: 'error' }],
        });
        const unsettledStore = createTriageListWindowStore({
            readEntries: unsettled.readEntries,
            nowMs: () => unsettled.clock.nowMs,
        });
        await unsettledStore.refresh('view');
        expect(unsettledStore.getSnapshot()).toMatchObject({
            pending: 'idle',
            error: { code: 'timeout', retryable: false },
        });
        expect(unsettledStore.getSnapshot().error?.detail).toContain('list-read-request');
        expect(unsettledStore.getSnapshot().error?.diagnostics).toEqual(['plugin_ui_action_outcome_unknown']);
        unsettledStore.dispose();

        const transient = createHarness();
        transient.state.enumerationRejectedWith = new PluginError({ code: 'unavailable', retryable: true });
        const transientStore = createTriageListWindowStore({
            readEntries: transient.readEntries,
            nowMs: () => transient.clock.nowMs,
        });
        await transientStore.refresh('view');
        expect(transientStore.getSnapshot().error).toMatchObject({ retryable: true, detail: 'unavailable' });
        transientStore.dispose();

        // A failure nobody classified is worth one more try.
        const unclassified = createHarness();
        unclassified.state.enumerationRejected = true;
        const unclassifiedStore = createTriageListWindowStore({
            readEntries: unclassified.readEntries,
            nowMs: () => unclassified.clock.nowMs,
        });
        await unclassifiedStore.refresh('view');
        expect(unclassifiedStore.getSnapshot().error).toMatchObject({
            retryable: true,
            detail: 'The plugin action could not be dispatched: no machine is reachable.',
        });
        unclassifiedStore.dispose();
    });

    it('keeps the last known good window when one source fails to refresh', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '3', '2']);

        harness.state.sourceBFails = true;
        harness.clock.nowMs += 1;
        await store.refresh('manual');

        const snapshot = store.getSnapshot();
        // The failing connection's entry is still on screen: a transient
        // provider error must not read as "nothing needs you".
        expect(snapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '3', '2']);
        // The failure is provider evidence about one named lane, so the lane's
        // own health carries it. Copying it onto the store-wide slot as well
        // gave the same fact two owners, and the surface then presented a
        // single connection's problem as the aggregate list read failing.
        expect(snapshot.error).toBeUndefined();
        expect(snapshot.unreadableSources ?? []).toEqual([]);
        expect(snapshot.freshness).toBe('stale');
        expect(snapshot.window?.lanes.find((lane) => lane.sourceInstanceId === INSTANCE_B)?.health)
            .toEqual({ kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } });
        store.dispose();
    });

    it('keeps the pages a connection admitted before its walk failed', async () => {
        // A walk that fails part way through still gave the pages it gave. The
        // pass owner already retains them (`projection/scanPass.ts`) and the
        // aggregate carries them back, so discarding them here is this mount
        // deleting rows the provider had already answered for: on a cold scan
        // there is no last-known-good behind them, and every page-one row
        // simply vanishes from the list.
        const harness = createHarness();
        harness.state.sourceASecondPageFails = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        const snapshot = store.getSnapshot();

        expect(snapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '3']);
        // The lane still reports the failure, and the window still refuses to
        // call the walk finished: keeping the rows is not claiming coverage.
        expect(snapshot.window?.lanes.find((lane) => lane.sourceInstanceId === INSTANCE_A)?.health)
            .toEqual({ kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } });
        expect(snapshot.window?.coverage).toBe('partial');
        expect(snapshot.freshness).toBe('stale');
        store.dispose();
    });

    it('merges the pages a failed walk admitted over the last known good by entry identity', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(['1', '3', '2']);

        // The next walk re-reads entry 1 with a newer title and then fails
        // before it reaches entry 2.
        harness.state.titleOfFirstEntry = 'Consolidate the two normalizers';
        harness.state.sourceASecondPageFails = true;
        harness.clock.nowMs += 1;
        await store.refresh('manual');
        await store.loadMore();

        const snapshot = store.getSnapshot();
        // Entry 2 was never re-read, so its last known good survives; entry 1
        // was, so the newer answer replaces the retained one rather than
        // listing the same entry twice.
        expect(snapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '3', '2']);
        const first = snapshot.window?.rows[0];
        const outcome = first?.observations[0]?.outcome;
        expect(outcome?.kind === 'present' ? outcome.snapshot.title : null)
            .toBe('Consolidate the two normalizers');
        expect(snapshot.freshness).toBe('stale');
        store.dispose();
    });

    it('never deletes what a cut-short pass did not reach', async () => {
        const harness = createHarness({ configureSourceB: false, admitSourceB: false });
        harness.state.sourceAOverDelivers = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const firstPass = store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId) ?? [];
        expect(firstPass.length).toBeGreaterThan(0);

        // The next pass is HEALTHY and answers with entirely different entries,
        // and it is cut short exactly as the first was. The scan-pass owner
        // leaves the walk unexhausted because another native page cannot fit.
        //
        // `PLAN.md` INV-02: no scan establishes absence and the aggregate never
        // derives it by set complement. A pass that never reached the earlier
        // entries has said nothing about them, so they must survive; only a walk
        // that FINISHED enumerating may narrow the lane's set. `core/CORPUS.md`
        // §5.4 names what the missing guard costs: "the set-complement
        // implementation passes every list test and quietly loses user-visible
        // state".
        harness.state.sourceAGeneration = 2;
        harness.clock.nowMs += 1;
        await store.refresh('manual');

        const secondPass = store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId) ?? [];
        // Entries from the first pass survive a second pass that never reached
        // them. Under set-complement replacement this list held only generation
        // two, and everything the reader had been looking at was gone.
        expect(secondPass.some((id) => firstPass.includes(id))).toBe(true);
        store.dispose();
    });

    it.each([
        {
            outcome: 'walkFinished' as const,
            expectedIds: ['replacement-only'],
            expectedCoverage: 'complete' as const,
        },
        {
            outcome: 'failsAfterPage' as const,
            expectedIds: ['replacement-only', '1', '2'],
            expectedCoverage: 'partial' as const,
        },
    ])('replaces scan membership only after an authoritative $outcome walk', async ({
        outcome,
        expectedIds,
        expectedCoverage,
    }) => {
        const harness = createHarness({ configureSourceB: false, admitSourceB: false });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        harness.state.sourceAReplacementOutcome = 'baseline';
        await store.refresh('view');
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(['1', '2']);

        harness.state.sourceAReplacementOutcome = outcome;
        harness.clock.nowMs += 1;
        await store.refresh('manual');
        if (outcome === 'failsAfterPage') await store.loadMore();

        const snapshot = store.getSnapshot();
        expect(snapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(expectedIds);
        expect(snapshot.window?.coverage).toBe(expectedCoverage);

        // A clean completed walk may replace this mount's current scan
        // membership, but neither outcome manufactures an entity-level absent
        // observation or touches durable user state.
        expect(snapshot.window?.rows.flatMap((row) => row.observations).some(
            (observation) => observation.outcome.kind === 'absent',
        )).toBe(false);
        store.dispose();
    });

    it('does not call a window current when a configured connection was never read', async () => {
        // Every configured connection is unavailable, so the cycle refused no
        // request and reached no provider at all. Stamping it left the surface
        // saying "Up to date" over a list that had read nothing.
        const harness = createHarness({ configureSourceA: false, admitSourceB: false, admitInternal: false });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const snapshot = store.getSnapshot();

        expect(harness.scanCalls.count).toBe(0);
        expect(snapshot.configuredSources.map((source) => source.available)).toEqual([false]);
        expect(snapshot.window?.rows).toEqual([]);
        expect(snapshot.freshness).toBe('stale');
        store.dispose();
    });

    it('preserves each source health beside independently settled rows', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        harness.state.sourceBFails = true;
        await store.refresh('view');
        const snapshot = store.getSnapshot();

        // `snapshot.error` means one thing: enumerating the configured instances
        // failed, which belongs to no source. Copying one lane's message into it
        // is what let the shell tell a reader "the list could not be read" while
        // the list was on screen in front of them.
        expect(snapshot.error).toBeUndefined();
        expect(snapshot.unreadableSources).toBeUndefined();
        expect(snapshot.window?.lanes).toContainEqual({
            sourceInstanceId: INSTANCE_B,
            source: SOURCE_B,
            health: {
                kind: 'failed',
                failure: { class: 'transient', code: 'provider-busy' },
            },
            exhausted: false,
        });
        // The rows the other connection did admit stay, and the window stops
        // claiming currentness it does not have.
        expect(snapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1']);
        expect(snapshot.freshness).toBe('stale');

        await store.refresh('manual');
        const transportPages = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
        );
        // A manual press retries both lanes when neither provider supplied a
        // retry deadline. Local failure pacing cannot refuse explicit demand.
        expect(transportPages.slice(-2).flatMap(input => input.sources.kind === 'selected'
            ? input.sources.sourceInstances.map(source => source.sourceInstanceId) : [])).toEqual([INSTANCE_A, INSTANCE_B]);
        store.dispose();
    });

    /**
     * The published refusal is a promise about a moment, and a surface that
     * disables **Refresh** until then has to be able to trust it.
     *
     * Across connections the aggregate refusal ends when the FIRST of them
     * becomes eligible, because one eligible connection is enough for a press to
     * read something — which is exactly the rule `refreshBlock` already applies
     * when it returns "not blocked" the moment any source is eligible. Reporting
     * the furthest deadline told the reader to come back at a time long after
     * the press would have worked, and a control that waits for the moment it
     * was given waits through the whole difference.
     */
    it('reports the moment its refusal ends, not the last connection to recover', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });
        const firstEligibleAtMs = harness.clock.nowMs + 60_000;
        // Each connection's own answer is its stated provider deadline.
        harness.state.sourceAFailure = {
            class: 'rateLimit',
            code: 'secondary-limit',
            retryNotBeforeMs: firstEligibleAtMs,
        };
        harness.state.sourceBFailure = {
            class: 'rateLimit',
            code: 'secondary-limit',
            retryNotBeforeMs: harness.clock.nowMs + 300_000,
        };

        await store.refresh('view');
        expect(store.getSnapshot().refreshBlocked)
            .toEqual({ reason: 'sourceRetryDeadline', nextEligibleAtMs: firstEligibleAtMs });

        // At that moment the refusal is over, with the other connection still
        // waiting out its own much longer deadline.
        harness.clock.nowMs = firstEligibleAtMs;
        expect(store.getSnapshot().refreshBlocked).toBeUndefined();
        store.dispose();
    });

    it('serves two concurrent consumers from one walk', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        // The shell list and the Composer picker both demand the window at
        // mount. One store, one coordinator, one pass per configured source.
        await Promise.all([store.refresh('view'), store.refresh('view')]);

        // One bounded read per source; A retains its next page for Load More.
        expect(harness.scanCalls.count).toBe(2);
        expect(store.getSnapshot().window?.rows).toHaveLength(2);

        // A joining view must not erase the person's already queued fresh read.
        let release!: () => void;
        harness.state.holdSourceA = new Promise<void>((resolve) => { release = resolve; });
        const viewing = store.refresh('view');
        await vi.waitFor(() => { expect(harness.scanCalls.count).toBeGreaterThan(2); });
        const manual = store.refresh('manual');
        const joining = store.refresh('view');
        release();
        await Promise.all([viewing, manual, joining]);
        expect(harness.scanCalls.count).toBe(6);
        expect(store.getSnapshot().pending).toBe('idle');
        store.dispose();
    });
    /**
     * `core/CORPUS.md` §4.2: manual **Refresh** honours a live source deadline
     * and must "surface that waiting health rather than bypassing provider
     * authority". The coordinator already decided this; until it was published
     * the press simply did nothing, and both surfaces said nothing.
     */
    it('publishes the coordinator\'s refusal instead of offering a Refresh that does nothing', async () => {
        const harness = createHarness({ admitSourceB: false });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });
        const deadlineMs = harness.clock.nowMs + 45_000;
        harness.state.sourceAFailure = {
            class: 'rateLimit',
            code: 'secondary-limit',
            retryNotBeforeMs: deadlineMs,
        };

        await store.refresh('view');
        expect(store.getSnapshot().refreshBlocked)
            .toEqual({ reason: 'sourceRetryDeadline', nextEligibleAtMs: deadlineMs });

        // The press the reader would make next reads no provider at all — which
        // is exactly why the refusal has to be visible before they make it.
        const before = harness.scanCalls.count;
        await store.refresh('manual');
        expect(harness.scanCalls.count).toBe(before);
        expect(store.getSnapshot().refreshBlocked)
            .toEqual({ reason: 'sourceRetryDeadline', nextEligibleAtMs: deadlineMs });

        // A deadline that has passed stops being a refusal on the clock, without
        // waiting for a cycle to overwrite it.
        harness.clock.nowMs = deadlineMs;
        expect(store.getSnapshot().refreshBlocked).toBeUndefined();
        store.dispose();
    });

    it('expires a published refresh deadline on read without a clock-driven wake', async () => {
        vi.useFakeTimers();
        try {
            const harness = createHarness({ admitSourceB: false });
            const store = createTriageListWindowStore({
                readEntries: harness.readEntries,
                nowMs: () => harness.clock.nowMs,
            });
            const deadlineMs = harness.clock.nowMs + 45_000;
            harness.state.sourceAFailure = {
                class: 'rateLimit',
                code: 'secondary-limit',
                retryNotBeforeMs: deadlineMs,
            };
            await store.refresh('view');

            const published: unknown[] = [];
            const unsubscribe = store.subscribe(() => {
                published.push(store.getSnapshot().refreshBlocked);
            });
            try {
                harness.clock.nowMs = deadlineMs;
                await vi.advanceTimersByTimeAsync(45_000);

                expect(published).toEqual([]);
                expect(store.getSnapshot().refreshBlocked).toBeUndefined();
            } finally {
                unsubscribe();
                store.dispose();
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('retains the successful read time while provider deadlines refuse demand', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        try {
            await store.refresh('view');
            const readAtMs = store.getSnapshot().completedAtMs;
            const deadlineMs = harness.clock.nowMs + 10;
            harness.state.sourceAFailure = { class: 'rateLimit', code: 'source-busy', retryNotBeforeMs: deadlineMs };
            harness.state.sourceBFailure = { class: 'rateLimit', code: 'source-busy', retryNotBeforeMs: deadlineMs };
            await store.refresh('manual');
            const reads = harness.scanCalls.count;
            harness.clock.nowMs += 1;
            await store.refresh('view');
            expect(harness.scanCalls.count).toBe(reads);
            expect(store.getSnapshot()).toMatchObject({ freshness: 'stale', completedAtMs: readAtMs });

            harness.state.sourceAFailure = null;
            harness.state.sourceBFailure = null;
            harness.clock.nowMs = deadlineMs;
            await store.refresh('view');
            expect(harness.scanCalls.count).toBeGreaterThan(reads);
            expect(store.getSnapshot()).toMatchObject({ freshness: 'fresh', completedAtMs: deadlineMs });
        } finally { store.dispose(); }
    });


    it('does not load an old continuation while a provider deadline holds the replacement', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        const readsBeforeLensChange = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
        ).length;
        const publishedDuringLensChange: Array<ReturnType<typeof store.getSnapshot>['loadMore']> = [];
        let changingLens = false;
        const unsubscribe = store.subscribe(() => {
            if (changingLens) publishedDuringLensChange.push(store.getSnapshot().loadMore);
        });

        // An actual provider deadline holds the replacement read. The lens
        // still invalidates the old frontier synchronously.
        harness.state.sourceAFailure = { class: 'rateLimit', code: 'source-busy', retryNotBeforeMs: harness.clock.nowMs + 10 };
        await store.refresh('manual');
        changingLens = true;
        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, tasks: { completedSinceMs: 123 } });
        changingLens = false;
        expect(publishedDuringLensChange).not.toContainEqual({ kind: 'available' });
        expect(store.getSnapshot().loadMore).not.toEqual({ kind: 'available' });
        await store.loadMore();

        const readsAfterAttempt = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
        );
        expect(readsAfterAttempt).toHaveLength(readsBeforeLensChange + 1);
        expect(store.getSnapshot().pending).not.toBe('append');
        unsubscribe();
        store.dispose();
    });

    it('never publishes an in-flight append after the completed-since acquisition scope changes', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });
        await store.refresh('view');

        let release = (): void => {};
        harness.state.holdSourceA = new Promise<void>((resolve) => { release = resolve; });
        const publishedAfterLensChange: string[][] = [];
        let lensChanged = false;
        const unsubscribe = store.subscribe(() => {
            if (!lensChanged) return;
            publishedAfterLensChange.push(
                store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId) ?? [],
            );
        });

        const append = store.loadMore();
        await vi.waitFor(() => {
            const providerReads = harness.actionInputs.filter(
                (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
            );
            expect(providerReads).toHaveLength(2);
            expect(providerReads.at(-1)?.resume).toHaveLength(1);
        });

        lensChanged = true;
        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, tasks: { completedSinceMs: 123 } });
        release();
        await append;
        await vi.waitFor(() => expect(store.getSnapshot().pending).toBe('idle'));

        // `p0-*` is produced only by the old continuation that was already in
        // flight. The replacement lens may keep the retained first page and may
        // publish its own first-page reacquisition, but the late append must
        // never become an observable window between those two states.
        expect(publishedAfterLensChange.some((ids) => ids.some((id) => id.startsWith('p0-'))))
            .toBe(false);
        expect(store.getSnapshot().window?.rows.every((row) => row.entryRef.entryId.startsWith('p1-')))
            .toBe(true);

        unsubscribe();
        store.dispose();
    });

    it('never publishes an in-flight append after the mounted read transport is replaced', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });
        await store.refresh('view');

        let release = (): void => {};
        harness.state.holdSourceA = new Promise<void>((resolve) => { release = resolve; });
        const publishedAfterReplacement: string[][] = [];
        let replaced = false;
        const unsubscribe = store.subscribe(() => {
            if (!replaced) return;
            publishedAfterReplacement.push(
                store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId) ?? [],
            );
        });

        const append = store.loadMore();
        await vi.waitFor(() => {
            const providerReads = harness.actionInputs.filter(
                (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
            );
            expect(providerReads).toHaveLength(2);
            expect(providerReads.at(-1)?.resume).toHaveLength(1);
        });

        replaced = true;
        store.replaceReadTransport();
        release();
        await append;
        await vi.waitFor(() => {
            expect(store.getSnapshot().pending).toBe('idle');
            expect(store.getSnapshot().window?.rows.every((row) => row.entryRef.entryId.startsWith('p1-')))
                .toBe(true);
        });

        // `p0-*` can only come from the append already submitted through the
        // retired reader. The replacement page starts at page one and must be
        // the first newly publishable provider result.
        expect(publishedAfterReplacement.some((ids) => ids.some((id) => id.startsWith('p0-'))))
            .toBe(false);
        const providerReads = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
        );
        expect(providerReads.at(-1)?.resume).toBeUndefined();

        unsubscribe();
        store.dispose();
    });

    it('invalidates a same-id configured-row revision before old pacing or frontiers can be reused', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceAUsesConfigurationIdentity = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(['configured-account-1']);
        const readsBeforeReconfigure = harness.scanCalls.count;

        // Same stable sourceInstanceId and same Collection row address, but a
        // newer row revision carries a different exact configured Account.
        harness.control.sourceInstances.seed(toCorpusStoredValue(
            instanceRow('a', SOURCE_A, INSTANCE_A, 2, 'account-2'),
        ));
        await store.refresh('view');

        // A revision-aware acquisition must retire the old slot, start the new configuration at its
        // first page, and retain no row or frontier from the former Account.
        expect(harness.scanCalls.count).toBeGreaterThan(readsBeforeReconfigure);
        const lastProviderInput = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
        ).at(-1);
        expect(lastProviderInput?.resume).toBeUndefined();
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(['configured-account-2']);
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'exhausted' });

        store.dispose();
    });

    it('retains last-known-good rows but clears truth and frontier while a contribution is unavailable', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const retainedIds = store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId);
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });

        harness.state.sourceAContributionAvailable = false;
        await store.refresh('manual');

        const unavailable = store.getSnapshot();
        expect(unavailable.window?.rows.map((row) => row.entryRef.entryId)).toEqual(retainedIds);
        expect(unavailable.window?.lanes).toContainEqual({
            sourceInstanceId: INSTANCE_A,
            source: SOURCE_A,
            health: { kind: 'unavailable' },
            exhausted: false,
        });
        expect(unavailable.window?.coverage).toBe('partial');
        expect(unavailable.freshness).toBe('stale');
        expect(unavailable.loadMore).toEqual({ kind: 'unresumable' });

        const readsBeforeReadmission = harness.scanCalls.count;
        harness.state.sourceAContributionAvailable = true;
        await store.refresh('view');
        expect(harness.scanCalls.count).toBeGreaterThan(readsBeforeReadmission);
        const readmittedInput = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
        ).at(-1);
        expect(readmittedInput?.resume).toBeUndefined();

        store.dispose();
    });

    /**
     * The lens is a projection of the retained page, never a parameter of the
     * read.
     *
     * The Action's fold drops every row the lens excludes, and this mount keeps
     * only what came back — so a read taken under the reader's own filter
     * deletes the excluded entries from the mount, and widening the filter
     * again cannot bring them back without another provider read. The reader
     * narrows, widens, and finds entries silently missing.
     */
    it('projects a narrowed facet over the retained page instead of narrowing the read', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(['1', '3', '2']);

        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, filters: { ...TRIAGE_LIST_DEFAULT_LENS_V1.filters,
            sources: [{ source: SOURCE_A }] } });
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '2']);

        // The refresh a reader takes while their filter is narrow.
        harness.clock.nowMs += 1;
        await store.refresh('manual');
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '2']);

        // Clearing it restores every entry the page carried, locally, without
        // reading any provider again.
        const readsBefore = harness.scanCalls.count;
        store.setLens(TRIAGE_LIST_DEFAULT_LENS_V1);
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(['1', '3', '2']);
        expect(harness.scanCalls.count).toBe(readsBefore);
        store.dispose();
    });

    it('does not call its window complete when the page it retained was cut', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceAOverDelivers = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const snapshot = store.getSnapshot();

        // The one configured connection qualified more entries than a window
        // carries and then reported a settled end of its walk. Its lane health
        // is therefore honest — the walk did finish — but the window that
        // reached this mount was cut to the row bound first, so the entries
        // past it never arrived and no later read of the retained page can
        // produce them. Reporting `complete` here tells the reader every
        // configured source answered in full, over a list that is missing rows.
        expect(snapshot.window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 - 6);
        expect(snapshot.window?.coverage).toBe('partial');
        store.dispose();
    });

    it('cuts the over-delivered page under the reader own order, not a fixed one', async () => {
        // The mounted store fetches a NEUTRAL page and projects the lens locally,
        // which is right for `query` and the facets: those EXCLUDE rows, so asking
        // the provider to apply them destroys entries that widening the filter
        // should bring back without another read.
        //
        // `order` is not that kind of lens member. It excludes nothing — it RANKS,
        // and `listWindow` ranks before it bounds (`rankCorpusWindow` then
        // `boundAcrossSourceLanes`), so the order in force at the cut decides WHICH
        // rows survive it. Sending a fixed order therefore hands a reader on
        // `oldest` the NEWEST page re-sorted ascending, and no local re-sort can
        // recover the older entries that were already cut away.
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceAOverDelivers = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
            lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, order: 'oldest' },
        });

        await store.refresh('view');
        const snapshot = store.getSnapshot();

        // The connection offered 70 entries stamped oldest-first from `first-0`.
        // A reader asking for the oldest must be given the oldest one there is,
        // not the oldest survivor of a cut taken under someone else's order.
        expect(snapshot.window?.rows[0]?.entryRef.entryId).toBe('first-0');
        store.dispose();
    });

    it('re-ranks acquired pages without reads and retains their frontier after order or Smart policy changes', async () => {
        // QB86: ranking changes only the fetched window, never its acquisition or continuation.
        const harness = createHarness({ configureSourceB: false, scanA: async input => {
            const page = input.page.kind === 'initial' ? 1 : Number(input.page.continuation.token);
            return {
                kind: 'page',
                observations: Array.from({ length: MAX_TRIAGE_LIST_WINDOW_ROWS_V1 }, (_, index) => presentObservation({
                    entryId: `page-${page}-${index}`,
                    title: `Change ${page}.${index}`,
                    sourceUpdatedAtMs: 1_000_000 - page * MAX_TRIAGE_LIST_WINDOW_ROWS_V1 - index,
                    involvement: page === 2 && index === 0 ? ['reviewRequested'] : [],
                })),
                evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: `${page + 1}` },
            };
        } });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });
        try {
            await store.refresh('view');
            await store.loadMore();
            const acquired = store.getSnapshot().window?.rows ?? [];
            expect(acquired).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 * 2);
            expect(acquired[0]?.entryRef.entryId).toBe('page-1-0');
            const reads = harness.actionInputs.length;
            const scans = harness.scanCalls.count;
            const smartLens = { ...TRIAGE_LIST_DEFAULT_LENS_V1, order: 'smart' as const };
            store.setLens(smartLens);
            expect(store.getSnapshot().window?.rows[0]?.entryRef.entryId).toBe('page-2-0');
            expect(new Set(store.getSnapshot().window?.rows)).toEqual(new Set(acquired));
            expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
            store.setLens({ ...smartLens, smartPolicy: { v: 1, precedence: ['activity', 'attention'] } });
            expect(store.getSnapshot().window?.rows).toEqual(acquired);
            store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, order: 'oldest' });
            expect(store.getSnapshot().window?.rows).toEqual([...acquired].reverse());
            expect(harness.actionInputs).toHaveLength(reads);
            expect(harness.scanCalls.count).toBe(scans);
            await store.loadMore();
            const resumed = harness.actionInputs.filter(input => input.sources.kind === 'selected'
                && input.sources.sourceInstances.length > 0).at(-1);
            expect(resumed?.resume?.[0]?.continuation?.token).toBe('3');
            expect(harness.scanCalls.count).toBe(scans + 1);
            expect(store.getSnapshot().window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 * 3);
            expect(store.getSnapshot().window?.rows[0]?.entryRef.entryId)
                .toBe(`page-3-${MAX_TRIAGE_LIST_WINDOW_ROWS_V1 - 1}`);
        } finally { store.dispose(); }
    });

    it('keeps an in-flight append when order and Smart policy change', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        let appendSignal: AbortSignal | undefined;
        const store = createTriageListWindowStore({
            readEntries: async (input, options) => {
                if (input.resume !== undefined) appendSignal = options?.signal;
                return await harness.readEntries(input);
            },
            nowMs: () => harness.clock.nowMs,
        });
        let release = (): void => {};
        let append: Promise<unknown> | undefined;
        try {
            await store.refresh('view');
            harness.state.holdSourceA = new Promise<void>(resolve => { release = resolve; });
            append = store.loadMore();
            await vi.waitFor(() => expect(appendSignal).toBeDefined());
            store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, order: 'smart' });
            store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, order: 'oldest',
                smartPolicy: { v: 1, precedence: ['activity', 'attention'] } });
            expect(appendSignal?.aborted).toBe(false);
            release();
            await append;
            expect(harness.scanCalls.count).toBe(2);
            expect(store.getSnapshot().window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 * 2);
            expect(store.getSnapshot().window?.rows[0]?.entryRef.entryId)
                .toBe(`p0-${MAX_TRIAGE_LIST_WINDOW_ROWS_V1 - 1}`);
            expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
        } finally { release(); await append; store.dispose(); }
    });

    it.each(['facet'] as const)('preserves acquired depth and frontier after a display-only %s edit', async () => {
        let changed = false;
        const harness = createHarness({ configureSourceB: false, scanA: async input => {
            const page = input.page.kind === 'initial' ? 1 : Number(input.page.continuation.token);
            return {
                kind: 'page',
                observations: endlessPage(page % 2).map((observation, index) => changed && index === 0
                    && observation.kind === 'present' ? {
                        ...observation,
                        snapshot: { ...observation.snapshot, title: 'Change reaching the filtered consumer' },
                        sourceUpdatedAtMs: observation.sourceUpdatedAtMs + 1,
                    } : observation),
                evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: `${page + 1}` },
            };
        } });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        const acquiredDepth = store.getSnapshot().window?.rows.length;
        const readsBefore = harness.scanCalls.count;
        expect(acquiredDepth).toBe(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 * 2);

        store.setLens({
            ...TRIAGE_LIST_DEFAULT_LENS_V1,
            filters: {
                ...TRIAGE_LIST_DEFAULT_LENS_V1.filters,
                states: ['open'],
            },
        });

        const providerReads = () => harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
        );
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
        expect(store.getSnapshot().window?.rows).toHaveLength(acquiredDepth!);
        expect(harness.scanCalls.count).toBe(readsBefore);
        await store.loadMore();
        expect(providerReads()).toHaveLength(3);
        expect(providerReads().at(-1)?.resume).toHaveLength(1);
        expect(store.getSnapshot().window?.rows).toHaveLength(acquiredDepth!);

        // A display-only edit must retain acquisition, not freeze the source.
        // A later real refresh still publishes a matching changed provider row.
        changed = true;
        harness.clock.nowMs += 1;
        await store.refresh('manual');
        expect(store.getSnapshot().window?.rows.find(row => row.entryRef.entryId === 'p1-0')
            ?.content?.outcome.snapshot.title).toBe('Change reaching the filtered consumer');

        store.dispose();
    });

    it('projects the latest text over an in-flight neutral read without cancelling or replacing it', async () => {
        const harness = createHarness({ configureSourceB: false });
        let heldSignal: AbortSignal | undefined;
        let release = (): void => {};
        const held = new Promise<void>(resolve => { release = resolve; });
        const store = createTriageListWindowStore({
            nowMs: () => harness.clock.nowMs,
            readEntries: async (input, options) => {
                if (input.sources.kind === 'selected') {
                    heldSignal = options?.signal;
                    await held;
                }
                return await harness.readEntries(input);
            },
        });
        const cycle = store.refresh('view');
        try {
            await vi.waitFor(() => expect(heldSignal).toBeDefined());
            store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'no match' });
            store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'normalizer' });
            expect(heldSignal?.aborted).toBe(false);
            release();
            await cycle;
            expect(store.getSnapshot().window?.rows.map(row => row.entryRef.entryId)).toEqual(['1']);
            expect(harness.scanCalls.count).toBe(1);
            expect(harness.actionInputs.every(input => input.query === undefined)).toBe(true);
            expect(store.getSnapshot().error).toBeUndefined();
        } finally { release(); await cycle; store.dispose(); }
    });

    it('reacquires from page one and replaces the old paging generation when the completed-since window changes', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        expect(store.getSnapshot().window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 * 2);

        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, tasks: { completedSinceMs: 123 } });
        const providerReads = () => harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
        );
        await vi.waitFor(() => {
            expect(providerReads()).toHaveLength(3);
            const rows = store.getSnapshot().window?.rows ?? [];
            expect(rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
            expect(rows.every((row) => row.entryRef.entryId.startsWith('p1-'))).toBe(true);
        });

        const reacquisition = providerReads().at(-1);
        expect(reacquisition?.resume).toBeUndefined();
        expect(reacquisition?.tasks).toEqual({ completedSinceMs: 123 });
        const reacquiredIds = store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId) ?? [];
        expect(reacquiredIds).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(reacquiredIds.every((entryId) => entryId.startsWith('p1-'))).toBe(true);

        store.dispose();
    });

    it('keeps the new completed-since generation pending until a failed reacquisition recovers', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        harness.state.sourceANeverFinishes = false;
        harness.state.sourceAFailure = { class: 'transient', code: 'provider-busy' };

        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, tasks: { completedSinceMs: 123 } });
        await vi.waitFor(() => {
            expect(store.getSnapshot().pending).toBe('idle');
            expect(store.getSnapshot().window?.lanes.find(lane => lane.sourceInstanceId === INSTANCE_A)?.health.kind).toBe('failed');
        });

        harness.state.sourceAFailure = null;
        harness.state.sourceANeverFinishes = true;
        expect(store.getSnapshot().refreshBlocked).toBeUndefined();
        await store.refresh('manual');

        const recoveredIds = store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId) ?? [];
        expect(recoveredIds).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(recoveredIds.every((entryId) => entryId.startsWith('p1-'))).toBe(true);

        store.dispose();
    });

    it('does not call a window stale because the reader changed the lens', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        expect(store.getSnapshot().freshness).toBe('fresh');

        // The page the lens is projected from is exactly as fresh as the read
        // that produced it. Typing in the search box reads no provider and ages
        // nothing, so "stale" here would ask the reader to refresh away a
        // filter they just applied.
        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'older' });
        expect(store.getSnapshot().freshness).toBe('fresh');
        store.dispose();
    });

    it('publishes settled source rows while another source is still pending', async () => {
        const harness = createHarness();
        let release = (): void => {};
        harness.state.holdSourceB = new Promise<void>((resolve) => { release = resolve; });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        const cycle = store.refresh('view');
        try {
            await vi.waitFor(() => expect(store.getSnapshot().window?.rows.map(row => row.entryRef.entryId))
                .toEqual(['1']));
            const snapshot = store.getSnapshot();
            expect(snapshot.window?.coverage).toBe('partial');
            expect(snapshot.window?.lanes.find(lane => lane.sourceInstanceId === INSTANCE_B)?.health.kind)
                .toBe('unavailable');
            expect(snapshot.unreadableSources).toBeUndefined();
            expect(resolveTriageListShellState(snapshot)).toMatchObject({ kind: 'window', refreshing: true });
        } finally {
            release();
            await cycle;
            store.dispose();
        }

        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(['1', '3']);
        expect(store.getSnapshot().pending).toBe('idle');
    });

    it.each(['refused', 'rateLimit'] as const)('keeps settled rows when another source is %s', async failure => {
        const harness = createHarness();
        if (failure === 'refused') harness.state.sourceBInvocationRejected = true;
        else harness.state.sourceBFailure = { class: 'rateLimit', code: 'quota', retryNotBeforeMs: harness.clock.nowMs + 60_000 };
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        try {
            await store.refresh('view');
            const snapshot = store.getSnapshot();
            expect(snapshot.window?.rows.map(row => row.entryRef.entryId)).toEqual(['1']);
            expect(snapshot.pending).toBe('idle');
            expect(snapshot.error).toBeUndefined();
            expect(snapshot.window?.lanes.find(lane => lane.sourceInstanceId === INSTANCE_B)?.health.kind)
                .toBe(failure === 'refused' ? 'unavailable' : 'failed');
            expect(resolveTriageListShellState(snapshot)).toMatchObject({ kind: 'window', showReadWarning: true,
                failure: { sources: [expect.objectContaining({ sourceInstanceId: INSTANCE_B })] } });
        } finally {
            store.dispose();
        }
    });
});

/**
 * The 56-row Action response bound is a transport limit and stays one. What is
 * proved here is that it stopped being a PRODUCT limit: entry 57 is reachable,
 * the rows already on screen survive a page that fails, and nothing durable is
 * created to make either true.
 */
describe('appending another bounded window to one mount', () => {
    /** A mount of the endless source alone, already holding its first window. */
    async function mountedAtFirstWindow() {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });
        await store.refresh('view');
        return { harness, store };
    }

    it('offers nothing to append before a window exists', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        // Not `available`: pressing it is refused, because there is nothing to
        // append to yet. A published `available` here was an offer the store had
        // already decided to do nothing about.
        expect(store.getSnapshot().loadMore).toBeUndefined();
        await store.loadMore();
        expect(harness.scanCalls.count).toBe(0);

        store.dispose();
    });

    it('reaches the entries after the transport bound and keeps the ones already on screen', async () => {
        const { harness, store } = await mountedAtFirstWindow();

        const first = store.getSnapshot();
        expect(first.window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(first.window?.coverage).toBe('partial');
        expect(first.loadMore).toEqual({ kind: 'available' });

        await store.loadMore();

        const appended = store.getSnapshot();
        // Twice the transport bound in one mount, from two bounded invocations —
        // the per-invocation page contract is untouched.
        expect(appended.window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 * 2);
        const ids = appended.window?.rows.map((row) => row.entryRef.entryId) ?? [];
        // Every row of the first window is still there, in front of the new ones.
        expect(ids.slice(0, MAX_TRIAGE_LIST_WINDOW_ROWS_V1))
            .toEqual(first.window?.rows.map((row) => row.entryRef.entryId));
        expect(ids).toContain('p0-0');
        expect(appended.loadMore).toEqual({ kind: 'available' });

        store.dispose();
    });

    it('keeps the earlier pages when the resumed page finishes the lane', async () => {
        const harness = createHarness({ configureSourceB: false });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1']);
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });

        // The continuation is the lane's terminal page. Finishing the walk is
        // evidence that there is nothing after this page; it is not permission
        // to replace the pages this same mounted generation already retained.
        await store.loadMore();

        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '2']);
        expect(store.getSnapshot().window?.coverage).toBe('complete');
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'exhausted' });

        store.dispose();
    });

    it('resumes each active source frontier exactly once without replaying page one', async () => {
        const harness = createHarness();
        harness.state.mixedSourcesNeverFinish = true;
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        const reads = () => harness.actionInputs.filter(input => input.sources.kind === 'selected'
            && input.sources.sourceInstances.length > 0);
        try {
            await store.refresh('view');
            expect(reads().map(input => input.sources)).toEqual([INSTANCE_A, INSTANCE_B]
                .map(id => ({ kind: 'selected', sourceInstances: [{ sourceInstanceId: id, configurationRowId: instanceRow(id === INSTANCE_A ? 'a' : 'b', SOURCE_A, id, 1).instanceTag }] })));
            let precedingPages = [1, 1];
            for (let append = 0; append < 2; append += 1) {
                const before = reads().length;
                await store.loadMore();
                const resumed = reads().slice(before);
                expect(resumed.map(input => input.resume?.map(entry => entry.sourceInstanceId)))
                    .toEqual([[INSTANCE_A], [INSTANCE_B]]);
                const pages = resumed.map(input => Number(input.resume?.[0]?.continuation?.token));
                expect(pages.every((page, index) => page > (precedingPages[index] ?? 0))).toBe(true);
                precedingPages = pages;
            }
        } finally { store.dispose(); }
    });

    it('restarts the mixed paging generation when a configured source appears before Load More', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.mixedSourcesNeverFinish = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow('b', SOURCE_B, INSTANCE_B, 2)));

        await store.loadMore();

        const transportPages = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
        );
        // Source B cannot join A's prior frontier: a configured-set change is
        // a new mixed acquisition generation, so both start from their first
        // page through their independent Actions.
        expect(transportPages).toHaveLength(3);
        expect(transportPages.slice(1).map(input => input.sources)).toEqual([INSTANCE_A, INSTANCE_B]
            .map(id => ({ kind: 'selected', sourceInstances: [{ sourceInstanceId: id, configurationRowId: instanceRow(id === INSTANCE_A ? 'a' : 'b', SOURCE_A, id, 1).instanceTag }] })));
        expect(transportPages.slice(1).every(input => input.resume === undefined)).toBe(true);
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(expect.arrayContaining(['a-1', 'b-1']));

        await store.loadMore();
        const resumed = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
        ).slice(-2);
        expect(resumed.flatMap(input => input.resume?.map(entry => entry.sourceInstanceId) ?? []))
            .toEqual([INSTANCE_A, INSTANCE_B]);
        const resumedPages = resumed.flatMap(input => input.resume?.map(entry => Number(entry.continuation?.token)) ?? []);
        expect(resumedPages).toHaveLength(2);
        expect(resumedPages.every((page) => page > 1)).toBe(true);

        store.dispose();
    });

    it.each(['configured source', 'completed-since window'] as const)('continues healthy replacement frontiers after a %s change while a failed lane recovers', async (change) => {
        const harness = createHarness({ configureSourceB: change !== 'configured source' });
        harness.state.mixedSourcesNeverFinish = true;
        const store = createTriageListWindowStore({ readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
        const reads = () => harness.actionInputs.filter(input => input.sources.kind === 'selected'
            && input.sources.sourceInstances.length > 0);
        try {
            await store.refresh('view');
            await store.loadMore();
            const beforeReplacement = reads().length;
            harness.state.sourceBFails = true;
            if (change === 'configured source') {
                harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow('b', SOURCE_B, INSTANCE_B, 2)));
                await store.loadMore();
            } else {
                store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, tasks: { completedSinceMs: 123 } });
                await vi.waitFor(() => {
                    expect(store.getSnapshot().pending).toBe('idle');
                    expect(store.getSnapshot().window?.lanes.find(lane => lane.sourceInstanceId === INSTANCE_B)?.health.kind).toBe('failed');
                });
            }
            expect(reads().slice(beforeReplacement).every(input => input.resume === undefined)).toBe(true);
            expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
            const beforeAppend = reads().length;
            await store.loadMore();
            const appended = reads().slice(beforeAppend);
            expect(appended).toHaveLength(1);
            expect(appended[0]?.sources).toEqual({ kind: 'selected', sourceInstances: [{ sourceInstanceId: INSTANCE_A, configurationRowId: instanceRow('a', SOURCE_A, INSTANCE_A, 1).instanceTag }] });
            // The replacement returned page one's frontier, not the old cut's next page.
            expect(appended[0]?.resume?.[0]?.continuation?.token).toBe('2');
            expect(store.getSnapshot().window?.rows.map(row => row.entryRef.entryId))
                .toEqual(expect.arrayContaining(['a-1', 'a-2']));
            expect(store.getSnapshot().window?.lanes.find(lane => lane.sourceInstanceId === INSTANCE_B)?.health.kind).toBe('failed');

            harness.state.sourceBFails = false;
            const beforeRecovery = reads().length;
            await store.refresh('manual');
            expect(reads().slice(beforeRecovery).every(input => input.resume === undefined)).toBe(true);
            expect(store.getSnapshot().window?.rows.map(row => row.entryRef.entryId).sort()).toEqual(['a-1', 'b-1']);
            expect(store.getSnapshot().window?.lanes.every(lane => lane.health.kind !== 'failed')).toBe(true);
            expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
        } finally { store.dispose(); }
    });

    it('reserves the returned page geometry when a deferred lane exceeds its mixed-window share', async () => {
        const harness = createHarness({ configureSourceB: false, wholeCatalog: true, admitInternal: false,
            scanA: async input => {
                const page = input.page.kind === 'initial' ? 1 : Number(input.page.continuation.token.split(':')[0]);
                const limit = input.page.kind === 'initial' ? input.page.limit : Number(input.page.continuation.token.split(':')[1]);
                return {
                    kind: 'page',
                    observations: Array.from({ length: limit }, (_, index) => presentObservation({
                        entryId: `${input.instance.instance.sourceInstanceId}-${page}-${index}`,
                        title: 'Change', sourceUpdatedAtMs: 1_000,
                    })),
                    evidence: { kind: 'partial', reason: 'more-pages' },
                    continuation: { v: 1, token: `${page + 1}:${limit}` },
                };
            },
        });
        for (let index = 0; index < 10; index += 1) {
            harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow(
                `geometry${index}`, SOURCE_A,
                `${String(index + 3).padStart(8, '0')}-1111-4111-8111-111111111111`, index + 3,
            )));
        }
        const inputs: TriageListEntriesInputV1[] = [];
        const store = createTriageListWindowStore({
            readEntries: async input => {
                inputs.push(input);
                if (input.sources.kind === 'selected' && input.sources.sourceInstances.map(source => source.sourceInstanceId).includes(INSTANCE_A)
                    && input.limit < 10) {
                    // The Action transport can defer a source before its first
                    // provider call, returning its required geometry without a cursor.
                    const result = await harness.readEntries({ ...input, limit: 0 });
                    return TriageListEntriesResultV1Schema.parse({ ...result, window: {
                        ...result.window,
                        rows: [],
                        coverage: 'partial',
                        lanes: [{ sourceInstanceId: INSTANCE_A, source: SOURCE_A,
                            health: { kind: 'partial', reason: 'more-pages' }, exhausted: false }],
                        continuations: [{ sourceInstanceId: INSTANCE_A, pageLimit: 10 }],
                    } });
                }
                return await harness.readEntries(input);
            },
            nowMs: () => harness.clock.nowMs,
        });
        try {
            await store.refresh('view');
            expect(store.getSnapshot().window?.rows.some(row => row.entryRef.entryId.startsWith(INSTANCE_A))).toBe(false);
            expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
            const beforeAppend = inputs.length;
            await store.loadMore();
            const resumed = inputs.slice(beforeAppend).find(input => input.sources.kind === 'selected'
                && input.sources.sourceInstances.map(source => source.sourceInstanceId).includes(INSTANCE_A));
            expect(resumed?.limit).toBe(10);
            expect(resumed?.resume).toEqual([{ sourceInstanceId: INSTANCE_A, pageLimit: 10 }]);
            expect(store.getSnapshot().window?.rows.map(row => row.entryRef.entryId)).toContain(`${INSTANCE_A}-1-0`);
        } finally { store.dispose(); }
    });

    it('keeps paging healthy frontiers when one lane fails', async () => {
        const harness = createHarness();
        harness.state.mixedSourcesNeverFinish = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const initialFrontiers = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
        ).at(-1)?.resume;
        harness.state.sourceBFails = true;
        await store.loadMore();

        const afterFailure = store.getSnapshot();
        expect(afterFailure.loadMore).toEqual({ kind: 'available' });
        expect(afterFailure.window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(expect.arrayContaining(['a-1', 'a-2', 'b-1']));
        expect(afterFailure.window?.lanes).toContainEqual({
            sourceInstanceId: INSTANCE_B,
            source: SOURCE_B,
            health: {
                kind: 'failed',
                failure: { class: 'transient', code: 'provider-busy' },
            },
            exhausted: false,
        });

        await store.loadMore();
        const transportPages = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
        );
        expect(transportPages.at(-1)?.sources).toEqual({
            kind: 'selected',
            sourceInstances: [{ sourceInstanceId: INSTANCE_A, configurationRowId: instanceRow('a', SOURCE_A, INSTANCE_A, 1).instanceTag }],
        });
        expect(transportPages.at(-1)?.resume).toHaveLength(1);
        expect(Number(transportPages.at(-1)?.resume?.[0]?.continuation?.token))
            .toBeGreaterThan(Number(initialFrontiers?.[0]?.continuation?.token ?? 0));
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(expect.arrayContaining(['a-3', 'b-1']));

        store.dispose();
    });

    it('keeps every retained row when the append fails, and retries at the same depth', async () => {
        const { harness, store } = await mountedAtFirstWindow();
        const retained = store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId);

        // The aggregate read is refused outright: no machine is reachable. The
        // append the reader pressed for never arrives.
        harness.state.enumerationRejected = true;
        await store.loadMore();

        const failed = store.getSnapshot();
        expect(failed.loadMore).toEqual({ kind: 'failed' });
        // The rows are untouched, and the sentence "the list could not be read"
        // is not published beside them.
        expect(failed.window?.rows.map((row) => row.entryRef.entryId)).toEqual(retained);
        expect(failed.error).toBeUndefined();

        harness.state.enumerationRejected = false;
        await store.loadMore();

        // A retry, not a second increment: the depth asked for is the one that
        // failed, so exactly two windows come back rather than three.
        expect(store.getSnapshot().window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 * 2);
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });

        store.dispose();
    });

    it('refresh discards retained frontiers and restarts once from page one', async () => {
        const { harness, store } = await mountedAtFirstWindow();
        await store.loadMore();
        const callsAtDepthTwo = harness.scanCalls.count;

        harness.clock.nowMs += 1;
        await store.refresh('manual');

        expect(harness.scanCalls.count).toBe(callsAtDepthTwo + 1);
        expect(store.getSnapshot().window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        const lastProviderInput = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstances.length > 0,
        ).at(-1);
        expect(lastProviderInput?.resume).toBeUndefined();

        store.dispose();
    });

    it('offers nothing further once every connection finished its walk', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        expect(store.getSnapshot().window?.coverage).toBe('complete');
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'exhausted' });

        const calls = harness.scanCalls.count;
        await store.loadMore();
        expect(harness.scanCalls.count).toBe(calls);

        store.dispose();
    });

    /**
     * An incomplete result and a resumable frontier are two different facts, and
     * only the second one is a place to continue from.
     *
     * A configured connection with no admitted contribution leaves the window
     * `partial` forever: nothing walked it, so nothing exhausted it. Reading the
     * coverage claim as the offer published `available`, and every press then
     * deepened the mount by one and re-read page one of the connections that DID
     * answer — the same rows again, deduped away, until the mount ceiling. The
     * reader is told the list is incomplete and pointed at **Refresh** instead.
     */
    it('does not offer a deeper window when no connection left a frontier to resume', async () => {
        const harness = createHarness({ admitSourceB: false, configureSourceA: false });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        // The configured source could not be asked at all. The window is
        // honestly incomplete and there is nothing to page.
        expect(store.getSnapshot().window?.coverage).toBe('partial');
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'unresumable' });

        const calls = harness.scanCalls.count;
        await store.loadMore();
        // The published arm and the gate read the same fact, so the press the
        // row does not offer is also the press this store refuses.
        expect(harness.scanCalls.count).toBe(calls);
        store.dispose();
    });

    it('keeps every source continuation reachable beyond the former 2,000-row mount wall', async () => {
        const { harness, store } = await mountedAtFirstWindow();

        // The retired ceiling was ceil(2,000 / 56) = 36 windows. Walk one page
        // beyond it: the only authority to stop is provider exhaustion, not an
        // invented process-local product count.
        for (let depth = 1; depth <= 36; depth += 1) {
            expect(store.getSnapshot().loadMore, `depth ${depth}`).toEqual({ kind: 'available' });
            await store.loadMore();
        }

        // This fixture deliberately keeps returning a continuation. The next
        // source page therefore remains reachable.
        expect(store.getSnapshot().window?.coverage).toBe('partial');
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
        const calls = harness.scanCalls.count;
        await store.loadMore();
        expect(harness.scanCalls.count).toBeGreaterThan(calls);

        store.dispose();
    }, 60_000);

    /**
     * One walk, several involvement lanes, several transport windows.
     *
     * A source is designed to meet the same entry more than once inside one
     * walk and to report only the fact each native lane established
     * (`scm-github/src/triage/scan/frontier.ts`). Inside one Action invocation
     * the canonical connection-answer fold already unions those encounters; a
     * mount that appends a later window must keep doing so, or paging silently
     * removes a pull request from **Needs your attention** while the source
     * still requires the review.
     */
    it('unions the involvement one walk reported across appended windows', async () => {
        const harness = createHarness({ admitSourceB: false, configureSourceB: false });
        harness.state.sourceASplitsInvolvementAcrossWindows = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        expect(store.getSnapshot().window?.rows[0]?.attention).toMatchObject({
            level: 'required',
            reasonId: 'involvement/review-requested',
        });

        // The appended window is genuinely newer, so its content wins and only
        // involvement accumulates.
        harness.clock.nowMs += 1;
        await store.loadMore();

        const row = store.getSnapshot().window?.rows[0];
        expect(row?.entryRef.entryId).toBe('1');
        expect(row?.observations.flatMap((observation) => (
            observation.outcome.kind === 'present' ? [...observation.outcome.viewer.involvement] : []
        ))).toEqual(['reviewRequested', 'participating']);
        expect(row?.attention).toMatchObject({
            level: 'required',
            reasonId: 'involvement/review-requested',
        });

        store.dispose();
    });

    /**
     * Accumulation is scoped to the walk that produced it.
     *
     * A later completed walk is authoritative about what it observed, so an
     * involvement it no longer reports has to disappear. Without that
     * distinction the union above becomes permanent and a withdrawn review
     * request would keep demanding attention forever.
     */
    it('clears an involvement a later completed walk no longer reports', async () => {
        const harness = createHarness({ admitSourceB: false, configureSourceB: false });
        harness.state.sourceASplitsInvolvementAcrossWindows = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        harness.clock.nowMs += 1;
        await store.loadMore();

        harness.state.sourceADropsReviewRequest = true;
        harness.clock.nowMs += 1;
        await store.refresh('manual');

        const row = store.getSnapshot().window?.rows[0];
        expect(row?.entryRef.entryId).toBe('1');
        expect(row?.observations.flatMap((observation) => (
            observation.outcome.kind === 'present' ? [...observation.outcome.viewer.involvement] : []
        ))).toEqual(['participating']);
        expect(row?.attention).toMatchObject({
            level: 'suggested',
            reasonId: 'involvement/participating',
        });

        store.dispose();
    });
});

it('restarts provider acquisition for a source-owned field sort and carries it on every page', async () => {
  const inputs: TriageListEntriesInputV1[] = [];
  const harness = createHarness({ configureSourceB: false, admitSourceB: false, sortFields: ['created'] });
  harness.state.mixedSourcesNeverFinish = true;
  const store = createTriageListWindowStore({ readEntries: async input => {
    inputs.push(input);
    return harness.readEntries(input);
  }, nowMs: () => harness.clock.nowMs });
  try {
    await store.refresh('view');
    const before = inputs.length;
    const sort = { field: 'created', direction: 'asc' } as const;
    store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, sort });
    await store.refresh('view');
    const firstSortedPage = inputs.length;
    await store.loadMore();
    expect(inputs.length).toBeGreaterThan(firstSortedPage);
    expect(inputs.slice(before).filter(input => input.sources.kind === 'selected')).not.toHaveLength(0);
    expect(inputs.slice(before).filter(input => input.limit > 0).every(input => input.sort?.field === 'created' && input.sort.direction === 'asc')).toBe(true);
  } finally { store.dispose(); }
});
it('keeps one aggregate sorted prefix across selected source lanes instead of regrouping returned rows', async () => {
 const harness = createHarness({ sortFields: ['created', 'updated'] });
 const inputs: TriageListEntriesInputV1[] = [];
 let expectedKeys: string[] = [];
 const store = createTriageListWindowStore({ lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, sort: { field: 'created', direction: 'asc' } },
  readEntries: async input => {
   inputs.push(input);
   const result = await harness.readEntries(input);
   if (input.limit === 0) return result;
   // The real Action builds the wire rows; this transport fixture publishes their authoritative alternating order.
   const grouped = result.window.rows;
   const a = grouped.filter(row => row.entryRef.source.pluginId === SOURCE_A.pluginId);
   const b = grouped.filter(row => row.entryRef.source.pluginId === SOURCE_B.pluginId);
   const rows = Array.from({ length: Math.max(a.length, b.length) }, (_, index) => [b[index], a[index]])
    .flat().filter((row): row is (typeof grouped)[number] => row !== undefined);
   expectedKeys = rows.map(row => triageEntryRowKey(row.entryRef));
   return TriageListEntriesResultV1Schema.parse({ ...result, window: { ...result.window, rows } });
  }, nowMs: () => harness.clock.nowMs });
 try {
  await store.refresh('view');
  const sortedReads = inputs.filter(input => input.limit > 0);
  expect(sortedReads).toHaveLength(1);
  expect(sortedReads[0]?.sources).toEqual({ kind: 'selected', sourceInstances: [
   { sourceInstanceId: INSTANCE_A, configurationRowId: expect.any(String) },
   { sourceInstanceId: INSTANCE_B, configurationRowId: expect.any(String) },
  ] });
  expect(store.getSnapshot().window?.rows.map(row => triageEntryRowKey(row.entryRef))).toEqual(expectedKeys);
  const before = inputs.length;
  store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, sort: { field: 'created', direction: 'asc' },
   filters: { ...TRIAGE_LIST_DEFAULT_LENS_V1.filters, sources: [{ source: SOURCE_B }] } });
  await store.refresh('view');
  const selectedReads = inputs.slice(before).filter(input => input.limit > 0);
  expect(selectedReads).not.toHaveLength(0);
  expect(selectedReads.every(input => input.sources.kind === 'selected'
   && input.sources.sourceInstances.length === 1 && input.sources.sourceInstances[0]?.sourceInstanceId === INSTANCE_B)).toBe(true);
 } finally { store.dispose(); }
});

it('retains the last aggregate ordered prefix as stale when a sorted refresh fails before emitting rows', async () => {
 const harness = createHarness({ configureSourceB: false, admitSourceB: false, sortFields: ['created'] });
 const store = createTriageListWindowStore({ lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, sort: { field: 'created', direction: 'asc' } },
  readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
 try {
  await store.refresh('view');
  const before = store.getSnapshot().window?.rows.map(row => triageEntryRowKey(row.entryRef));
  expect(before?.length).toBeGreaterThan(0);
  harness.state.sourceAFailure = { class: 'transient', code: 'source-busy' };
  await store.refresh('manual');
  expect(store.getSnapshot().window?.rows.map(row => triageEntryRowKey(row.entryRef))).toEqual(before);
  expect(store.getSnapshot().freshness).toBe('stale');
 } finally { store.dispose(); }
});

it('admits a sorted head beyond the window row count before choosing the first visible row', async () => {
 const lastId = String(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 + 3).padStart(8, '0') + '-1111-4111-8111-111111111111';
 const harness = createHarness({ configureSourceB: false, wholeCatalog: true, sortFields: ['updated'],
  scanA: async input => {
   const id = input.instance.instance.sourceInstanceId;
   return { kind: 'complete', observations: [presentObservation({ entryId: id, title: id,
    sourceUpdatedAtMs: id === lastId ? 1_000_000 : 1 })], evidence: { kind: 'walkFinished' } };
  } });
 for (let index = 0; index <= MAX_TRIAGE_LIST_WINDOW_ROWS_V1; index += 1) {
  const id = String(index + 3).padStart(8, '0') + '-1111-4111-8111-111111111111';
  harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow('s' + String(index).padStart(4, '0') + 'x', SOURCE_A, id, index + 3, 'account-s' + index)));
 }
 const store = createTriageListWindowStore({ lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, sort: { field: 'updated', direction: 'desc' } },
  readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
 try {
  await store.refresh('view');
  expect(store.getSnapshot().window?.rows[0]?.entryRef.entryId).toBe(lastId);
  expect(store.getSnapshot().window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
  expect(store.getSnapshot().loadMore?.kind).toBe('available');
 } finally { store.dispose(); }
});

it('keeps a source-silent default projection honest about sources outside its sorted acquisition', async () => {
 const harness = createHarness({ sortFields: ['created'] });
 const store = createTriageListWindowStore({ lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1,
  sort: { field: 'created', direction: 'asc' },
  filters: { ...TRIAGE_LIST_DEFAULT_LENS_V1.filters, sources: [{ source: SOURCE_B }] } },
  readEntries: harness.readEntries, nowMs: () => harness.clock.nowMs });
 try {
  await store.refresh('view');
  expect(store.getSnapshot().window?.coverage).toBe('complete');
  const reads = harness.actionInputs.length;
  const projected = store.project(TRIAGE_LIST_DEFAULT_LENS_V1);
  expect(projected?.lanes.map(lane => lane.sourceInstanceId)).toEqual([INSTANCE_A, INSTANCE_B]);
  expect(projected?.coverage).toBe('partial');
  expect(harness.actionInputs).toHaveLength(reads);
 } finally { store.dispose(); }
});
