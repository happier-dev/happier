import {
    TriageConfiguredSourceInstanceV1Schema,
    TriageSourceDescriptorV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageGetInputV1,
    type TriageGetResultV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import type { TriageAdmittedSourceV1 } from '../actions/listEntries.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { CORPUS_SESSION_LINKS_INDEX_ID } from '../corpus/collections/ids.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../corpus/collections/rows.js';
import { deriveSessionLinkEntryTag, deriveUserMarkTag } from '../corpus/identity/tags.js';
import { setPinned } from '../corpus/marks/setPinned.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitLocator, testkitSnapshot, testkitViewer } from '../corpus/testkit/observations.test-support.js';
import { linkEntryToSession } from '../sessions/entrySessionLinks.js';
import { TESTKIT_LINK_DISPLAY } from '../sessions/testkit/entrySessionTestkit.test-support.js';
import { resolveTriageEntryForDispatch } from './resolveForDispatch.js';

/**
 * Fresh exact resolution immediately before an Agent dispatch
 * (`core/COMPOSER.md` §5).
 *
 * The attached value carries identity and nothing else, so this is where the
 * entry actually gets read — under the exact connection the user attached it
 * with, through the currently admitted source, every time the message is
 * dispatched, requeued or retried. Anything remembered from attach time would
 * be a snapshot of a pull request as it was hours ago.
 */

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const OTHER_SOURCE = Object.freeze({ pluginId: 'happier.other.source', localId: 'other-forge' });
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';

const LOCAL_REF = Object.freeze({
    kindId: 'pull-request',
    collisionScope: 'example/repository',
    entryId: '42',
});
const ENTRY_REF = Object.freeze({ source: SOURCE, ...LOCAL_REF });

function configuredInstance(
    source: Readonly<{ pluginId: string; localId: string }>,
    sourceInstanceId: string,
): TriageConfiguredSourceInstanceV1 {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source, sourceInstanceId },
        binding: {
            purpose: 'triage-source',
            account: {
                service: { pluginId: source.pluginId, localId: 'accounts' },
                accountId: `account-${sourceInstanceId.slice(0, 4)}`,
            },
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
    lifecycle: string = CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: `${tagSeed}${'0'.repeat(43 - tagSeed.length)}`,
        sourceQualifiedId: `${source.pluginId}/${source.localId}`,
        lifecycle: lifecycle as CorpusSourceInstanceRowV1['lifecycle'],
        configuredAtMs: 1,
        configured: configuredInstance(source, sourceInstanceId),
        ...(lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired
            ? { retiredReason: 'userRemoved' as const }
            : {}),
    };
}

type GetFn = (input: TriageGetInputV1) => Promise<TriageGetResultV1>;

function createHarness(options: Readonly<{
    rows?: readonly CorpusSourceInstanceRowV1[];
    sources?: readonly Readonly<{ pluginId: string; localId: string }>[];
    get?: GetFn;
}> = {}) {
    const { collections, control } = createTestkitCorpusCollections();
    const rows = options.rows ?? [instanceRow('a', SOURCE, INSTANCE_A)];
    for (const row of rows) control.sourceInstances.seed(toCorpusStoredValue(row));

    const calls: TriageGetInputV1[] = [];
    const handles = new Map<object, Readonly<{ pluginId: string; localId: string }>>();
    const get: GetFn = options.get ?? (async () => ({
        kind: 'present',
        localRef: LOCAL_REF,
        locator: testkitLocator(),
        snapshot: testkitSnapshot({
            title: 'Replace the duplicated normalizer',
            summary: 'Removes the second normalizer',
            scopeLabel: 'example/repository',
            state: { presentation: 'active', nativeLabel: 'Open' },
        }),
        viewer: testkitViewer(),
    }));

    function admittedSource(source: Readonly<{ pluginId: string; localId: string }>): TriageAdmittedSourceV1 {
        const handle = { role: 'get', of: source.localId };
        handles.set(handle, source);
        return {
            contributor: {
                pluginId: source.pluginId,
                contributionId: source.localId,
                immutableGenerationId: 'generation-1',
            },
            // The descriptor the source actually publishes. The merge path
            // qualifies the named successor against exactly these declared
            // kinds, so a harness without one would qualify nothing.
            descriptor: TriageSourceDescriptorV1Schema.parse({
                v: 1,
                purpose: 'triage-source',
                displayName: 'Example forge',
                kinds: [{
                    id: LOCAL_REF.kindId,
                    workflowSubject: 'pullRequest',
                    displayName: 'Pull request',
                }],
            }),
            operations: { listInstances: {}, scan: {}, get: handle },
        } as unknown as TriageAdmittedSourceV1;
    }

    const admitted = (options.sources ?? [SOURCE]).map(admittedSource);

    return {
        calls,
        collections,
        control,
        deps: {
            sourceInstances: collections.sourceInstances,
            sessionLinks: collections.sessionLinks,
            readAdmittedSources: async () => admitted,
            executeGet: async (operation: unknown, input: TriageGetInputV1) => {
                if (!handles.has(operation as object)) {
                    throw new Error('No admitted get handle for this operation.');
                }
                calls.push(input);
                return await get(input);
            },
        },
    };
}

function attachment(overrides: Readonly<Record<string, unknown>> = {}) {
    return {
        instanceId: 'attachment-1',
        key: 'k'.repeat(43),
        value: {
            v: 1,
            entryRef: ENTRY_REF,
            sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_A },
        },
        ...overrides,
    };
}

describe('resolving an attached Triage entry for dispatch', () => {
    it('reads the entry through the attached connection and returns Tier-A facts', async () => {
        const harness = createHarness();

        const result = await resolveTriageEntryForDispatch(
            { attachments: [attachment()] },
            harness.deps as never,
        );

        // The exact attached instance, its exact configured record, and the
        // exact local ref — never a scan-time snapshot and never another
        // connection that happens to see the same entry.
        expect(harness.calls).toHaveLength(1);
        expect(harness.calls[0]?.instance.instance.sourceInstanceId).toBe(INSTANCE_A);
        expect(harness.calls[0]?.localRef).toEqual(LOCAL_REF);

        const outcome = harness.calls.length === 1 ? result.attachments[0] : undefined;
        expect(outcome?.status).toBe('ready');
        const context = outcome?.status === 'ready' ? outcome.context : '';
        expect(context).toContain('Replace the duplicated normalizer');
        expect(context).toContain('example/repository');
        expect(context).toContain('Open');
        // No prompt framing, instruction wrapper or delimiter fence: framing is
        // the host's, and a resolver that writes it makes two owners of it.
        expect(context).not.toMatch(/```|<attachment|You are|Here is/u);
        // Never a locator: a routing token or web URL is not an identity fact
        // and the value deliberately carries neither.
        expect(context).not.toContain('https://');
    });

    it('resolves under the attached instance even when another connection sees the entry', async () => {
        const harness = createHarness({
            rows: [instanceRow('a', SOURCE, INSTANCE_A), instanceRow('b', SOURCE, INSTANCE_B)],
        });

        await resolveTriageEntryForDispatch(
            {
                attachments: [attachment({
                    value: {
                        v: 1,
                        entryRef: ENTRY_REF,
                        sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_B },
                    },
                })],
            },
            harness.deps as never,
        );

        // Substituting an equally capable account is the natural "be helpful"
        // implementation and it is wrong: it dispatches under credentials the
        // user did not choose.
        expect(harness.calls[0]?.instance.instance.sourceInstanceId).toBe(INSTANCE_B);
    });

    it('blocks when the attached connection is no longer configured', async () => {
        const harness = createHarness({
            rows: [instanceRow('a', SOURCE, INSTANCE_A, CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired)],
        });

        const result = await resolveTriageEntryForDispatch(
            { attachments: [attachment()] },
            harness.deps as never,
        );

        expect(result.attachments).toEqual([{
            instanceId: 'attachment-1',
            status: 'unavailable',
            retryable: false,
            message: 'Its connection is no longer configured.',
        }]);
        expect(harness.calls).toEqual([]);
    });

    it('blocks when the source contribution is no longer admitted', async () => {
        const harness = createHarness({ sources: [OTHER_SOURCE] });

        const result = await resolveTriageEntryForDispatch(
            { attachments: [attachment()] },
            harness.deps as never,
        );

        // An uninstalled source blocks; it never falls back to another source
        // that declares the same kind.
        expect(result.attachments).toEqual([{
            instanceId: 'attachment-1',
            status: 'unavailable',
            retryable: false,
            message: 'Its source is no longer installed.',
        }]);
        expect(harness.calls).toEqual([]);
    });

    it('maps absent, merged and unresolved without following a successor', async () => {
        const absent = createHarness({
            get: async () => ({ kind: 'absent', localRef: LOCAL_REF }),
        });
        const merged = createHarness({
            get: async () => ({
                kind: 'merged',
                localRef: LOCAL_REF,
                successor: { ...LOCAL_REF, entryId: '43' },
            }),
        });
        const unresolved = createHarness({
            get: async () => ({
                kind: 'unresolved',
                localRef: LOCAL_REF,
                failure: { class: 'transient', code: 'provider-busy' },
            }),
        });

        const [absentResult, mergedResult, unresolvedResult] = await Promise.all([
            resolveTriageEntryForDispatch({ attachments: [attachment()] }, absent.deps as never),
            resolveTriageEntryForDispatch({ attachments: [attachment()] }, merged.deps as never),
            resolveTriageEntryForDispatch({ attachments: [attachment()] }, unresolved.deps as never),
        ]);

        expect(absentResult.attachments[0]).toMatchObject({ status: 'notFound', retryable: false });
        // A successor is a different entry. Silently resolving it would send the
        // model something the user never attached.
        expect(mergedResult.attachments[0]).toMatchObject({ status: 'notFound', retryable: false });
        expect(mergedResult.attachments[0]).not.toMatchObject({ status: 'ready' });
        // A transient provider failure is worth retrying; the class decides,
        // not a guess about the word "failed".
        expect(unresolvedResult.attachments[0]).toMatchObject({ status: 'failed', retryable: true });
    });

    it('does not retry a failure the source classified as permanent', async () => {
        const harness = createHarness({
            get: async () => ({
                kind: 'unresolved',
                localRef: LOCAL_REF,
                failure: { class: 'permission', code: 'forbidden' },
            }),
        });

        const result = await resolveTriageEntryForDispatch(
            { attachments: [attachment()] },
            harness.deps as never,
        );

        expect(result.attachments[0]).toMatchObject({ status: 'failed', retryable: false });
    });

    it('refuses a response that answers about a different entry', async () => {
        const harness = createHarness({
            get: async () => ({
                kind: 'present',
                localRef: { ...LOCAL_REF, entryId: '43' },
                locator: testkitLocator(),
                snapshot: testkitSnapshot(),
                viewer: testkitViewer(),
            }),
        });

        const result = await resolveTriageEntryForDispatch(
            { attachments: [attachment()] },
            harness.deps as never,
        );

        // `get` answers about exactly the requested ref; a different one is a
        // contract violation, never a redirect to follow.
        expect(result.attachments[0]).toMatchObject({ status: 'invalid', retryable: false });
    });

    it('carries the attached routing hint into the source read, unchanged', async () => {
        // An account-wide connection names no repository at all, so the entry's
        // own last-known locator is the ONLY evidence that can route this read.
        // Without it a valid attachment resolves to `unresolved` on every
        // dispatch, forever, for a pull request the user can see in the list.
        const harness = createHarness();

        await resolveTriageEntryForDispatch(
            {
                attachments: [attachment({
                    value: {
                        v: 1,
                        entryRef: ENTRY_REF,
                        sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_A },
                        lastKnownLocator: { v: 1, routingToken: 'example/repository' },
                    },
                })],
            },
            harness.deps as never,
        );

        // Copied back verbatim: this resolver is not the parser of a source's
        // own opaque token and never rewrites, shortens or re-derives one.
        expect(harness.calls[0]?.lastKnownLocator).toEqual({ v: 1, routingToken: 'example/repository' });
    });

    it('omits the routing hint entirely when the attachment carries none', async () => {
        // A repository-scoped connection already binds the scope, and an absent
        // hint must stay absent rather than becoming an empty locator the
        // source would have to interpret.
        const harness = createHarness();

        await resolveTriageEntryForDispatch({ attachments: [attachment()] }, harness.deps as never);

        expect(harness.calls[0] && 'lastKnownLocator' in harness.calls[0]).toBe(false);
    });

    it('refuses when a stale hint routes the source to another repository', async () => {
        // This is the whole risk a routing hint introduces: the number `42`
        // exists in more than one repository. The source answers about the
        // occupant of the stale route, and the immutable scope is what catches
        // it — acting here would run the user's prompt against the WRONG pull
        // request.
        const harness = createHarness({
            get: async () => ({
                kind: 'present',
                localRef: { ...LOCAL_REF, collisionScope: 'other/repository' },
                locator: testkitLocator(),
                snapshot: testkitSnapshot({ title: 'A different repository entirely' }),
                viewer: testkitViewer(),
            }),
        });

        const result = await resolveTriageEntryForDispatch(
            {
                attachments: [attachment({
                    value: {
                        v: 1,
                        entryRef: ENTRY_REF,
                        sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_A },
                        lastKnownLocator: { v: 1, routingToken: 'stale/route' },
                    },
                })],
            },
            harness.deps as never,
        );

        expect(result.attachments[0]).toMatchObject({ status: 'invalid', retryable: false });
        const outcome = result.attachments[0];
        const message = outcome && outcome.status !== 'ready' ? outcome.message ?? '' : '';
        expect(message).not.toContain('A different repository entirely');
        // A stale route is repaired by reading the list again, so the refusal
        // names that remedy instead of stopping at "no".
        expect(message).toContain('Refresh');
    });

    it('refuses a value whose instance belongs to another source', async () => {
        const harness = createHarness();

        const result = await resolveTriageEntryForDispatch(
            {
                attachments: [attachment({
                    value: {
                        v: 1,
                        entryRef: ENTRY_REF,
                        sourceInstance: { source: OTHER_SOURCE, sourceInstanceId: INSTANCE_A },
                    },
                })],
            },
            harness.deps as never,
        );

        expect(result.attachments[0]).toMatchObject({ status: 'invalid', retryable: false });
        expect(harness.calls).toEqual([]);
    });

    it('reports every attachment, so one blocked peer cannot be sent alone', async () => {
        let call = 0;
        const harness = createHarness({
            get: async (input) => {
                call += 1;
                return call === 1
                    ? { kind: 'absent', localRef: input.localRef }
                    : {
                        kind: 'present',
                        localRef: input.localRef,
                        locator: testkitLocator(),
                        snapshot: testkitSnapshot(),
                        viewer: testkitViewer(),
                    };
            },
        });

        const result = await resolveTriageEntryForDispatch(
            {
                attachments: [
                    attachment({ instanceId: 'attachment-1' }),
                    attachment({
                        instanceId: 'attachment-2',
                        value: {
                            v: 1,
                            entryRef: { ...ENTRY_REF, entryId: '43' },
                            sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_A },
                        },
                    }),
                ],
            },
            harness.deps as never,
        );

        // The host enforces all-or-none; the resolver's job is to report each
        // one honestly rather than dropping the blocked peer and letting a
        // partial prompt through.
        expect(result.attachments.map((outcome) => outcome.instanceId))
            .toEqual(['attachment-1', 'attachment-2']);
        expect(result.attachments[0]?.status).toBe('notFound');
        expect(result.attachments[1]?.status).toBe('ready');
    });
    /**
     * The one durable effect an authoritative `merged(successor)` has
     * (`core/CORPUS.md` §3.3), proved through the real dispatch path rather
     * than by calling the reconciler: the source answers `merged` to the exact
     * `get` this resolution issued, and the user's Session link stops pointing
     * at a predecessor nobody will open again.
     */
    it('retargets the predecessor Session link when its source answers merged', async () => {
        const successorLocalRef = { ...LOCAL_REF, entryId: '43' };
        const successorEntryRef = { source: SOURCE, ...successorLocalRef };
        const harness = createHarness({
            get: async () => ({ kind: 'merged', localRef: LOCAL_REF, successor: successorLocalRef }),
        });

        // The real link writer commits the relationship, and the real mark
        // writer commits the pin: both are the collections' only creators.
        const linked = await linkEntryToSession({
            collections: harness.collections,
            entryRef: ENTRY_REF,
            display: TESTKIT_LINK_DISPLAY,
            sessionId: 'session-a',
            nowMs: 1_760_000_900_000,
        });
        if (linked.status !== 'linked') throw new Error('the link fixture did not commit');
        await setPinned({
            collections: harness.collections,
            entryRef: ENTRY_REF,
            pinned: true,
            displayAtMark: { title: 'Replace the duplicated normalizer', scopeLabel: 'example/repository' },
            nowMs: 1_760_000_900_000,
        });
        const markTag = await deriveUserMarkTag(harness.collections.userMarks, ENTRY_REF);
        const markBefore = harness.control.userMarks.inspect(markTag);

        const result = await resolveTriageEntryForDispatch(
            { attachments: [attachment()] },
            harness.deps as never,
        );

        // The attachment itself is still blocked: the successor is a different
        // entry and the model never receives one the user did not attach.
        expect(result.attachments[0]).toMatchObject({ status: 'notFound', retryable: false });

        const rowsOn = async (entryRef: typeof ENTRY_REF): Promise<readonly CorpusSessionLinkRowV1[]> => {
            const entryTag = await deriveSessionLinkEntryTag(harness.collections.sessionLinks, entryRef);
            const page = await harness.collections.sessionLinks.query({
                index: CORPUS_SESSION_LINKS_INDEX_ID.byEntry,
                prefix: [entryTag],
                order: 'asc',
            });
            return page.rows.map((stored) => fromCorpusStoredRow<CorpusSessionLinkRowV1>(stored).value);
        };

        expect(await rowsOn(ENTRY_REF)).toEqual([]);
        const moved = await rowsOn(successorEntryRef);
        expect(moved).toHaveLength(1);
        // In place: same row, same relationship. Only the current entry ref
        // and its projected index tag moved.
        expect(moved[0]?.linkTag).toBe(linked.linkTag);
        expect(moved[0]?.sessionId).toBe('session-a');
        expect(moved[0]?.linkedAtMs).toBe(1_760_000_900_000);
        expect(moved[0]?.entryRef).toEqual(successorEntryRef);
        expect(moved[0]?.identityEntryRef).toEqual(ENTRY_REF);

        // A pin is a user's own fact and this path is not its writer: the mark
        // row is untouched, still addressed to the predecessor.
        expect(harness.control.userMarks.inspect(markTag)).toEqual(markBefore);
    });
});
