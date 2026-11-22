import { describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/plugin-sdk/actions';
import { MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1, type TriageEntryRefV1, type TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';

import { CORPUS_USER_MARKS_INDEX_ID } from '../collections/ids.js';
import type { CorpusUserMarkRowV1 } from '../collections/rows.js';
import { deriveUserMarkTag } from '../identity/tags.js';
import {
    createTestkitCorpusCollections as createBaseCorpusCollections,
    type TestkitCorpusCollections,
} from '../testkit/corpusCollections.test-support.js';
import { testkitEntryRef, testkitLocator } from '../testkit/observations.test-support.js';
import { linkEntryToSession } from '../../sessions/entrySessionLinks.js';
import { readTriageSessionLinksPageV1 } from '../../sessions/readEntrySessionLinks.js';
import {
    readFixPullRequestSources,
    resolveFixPullRequests,
    type TriageFixPullRequestPresentationV1,
} from './fixPullRequests.js';
import { setFixPullRequest, setPinned } from './setPinned.js';
import { readTriageFixPullRequests } from '../../actions/fixPullRequests.js';
import { createTriageSourceSessionRelations } from '../../sessions/sourceSessionRelations.js';
import { TriageConfiguredSourceInstanceV1Schema } from '@happier-dev/triage-protocol/v1';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../collections/ids.js';
import { toCorpusStoredValue } from '../collections/rowCodec.js';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../../internalTasks/contribution.js';
import { INTERNAL_TASK_SOURCE_V1 } from '../../internalTasks/identity.js';

const SENTRY = { pluginId: 'happier.sentry', localId: 'errors' } as const;
const GITHUB = { pluginId: 'happier.scm-github', localId: 'github' } as const;

/** A Sentry error group: the entry that is being fixed. */
const ERROR_REF: TriageEntryRefV1 = testkitEntryRef({
    source: SENTRY,
    kindId: 'error-group',
    collisionScope: 'acme/web',
    entryId: 'WEB-1A2',
});
const ERROR_DISPLAY = { title: 'TypeError: cannot read id', scopeLabel: 'acme/web' } as const;

function githubPr(entryId: string): TriageEntryRefV1 {
    return testkitEntryRef({ source: GITHUB, kindId: 'pull-request', collisionScope: 'acme/web', entryId });
}
const GITHUB_ISSUE = testkitEntryRef({ source: GITHUB, kindId: 'issue', collisionScope: 'acme/web', entryId: '903' });

const SUBJECTS: Readonly<Record<string, TriageSourceWorkflowSubjectV1>> = {
    'pull-request': 'pullRequest',
    issue: 'issue',
    'error-group': 'errorIssue',
};
const workflowSubjectOf = (ref: TriageEntryRefV1) => SUBJECTS[ref.kindId] ?? null;

function createTestkitCorpusCollections(options: Parameters<typeof createBaseCorpusCollections>[0] = {}, role?: 'ready' | 'failed') {
    const fixture = createBaseCorpusCollections(options);
    const sources = [SENTRY, GITHUB].map((source, index) => {
        fixture.control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: `${index}${'0'.repeat(42)}`,
            sourceQualifiedId: `${source.pluginId}/${source.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
            configuredAtMs: 1,
            configured: TriageConfiguredSourceInstanceV1Schema.parse({
                v: 1, instance: { source, sourceInstanceId: index === 0
                    ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222' },
                binding: { purpose: 'triage-source', account: { service: { pluginId: source.pluginId, localId: 'accounts' }, accountId: 'account-1' } },
                localInstanceKey: 'acme/web', configuration: { v: 1, token: 'fixture-source-configuration' },
            }),
        }));
        return {
            contributor: { pluginId: source.pluginId, contributionId: source.localId },
            descriptor: { v: 1, purpose: 'triage-source', displayName: source.localId,
                kinds: (index === 0 ? ['error-group'] : ['pull-request', 'issue']).map((id) => ({ id, displayName: id, workflowSubject: SUBJECTS[id] })),
                ...(index === 1 && role ? { sessionRelations: { kindIds: ['pull-request'] } } : {}),
            },
            operations: index === 1 && role ? { readSessionLinks: { role: 'read' }, linkSession: { role: 'write' } } : {},
        };
    });
    let configurationReads = 0;
    const roleSelections: Array<string | undefined> = [];
    const linkQueries: unknown[] = [];
    let taskReads = 0;
    let linkedSession: string | undefined = 'session-a';
    let refuseSetQuery = false;
    const internalRead = { role: 'internalRead' };
    const collections = { ...fixture.collections, sourceInstances: { ...fixture.collections.sourceInstances,
        query: async (...args: Parameters<typeof fixture.collections.sourceInstances.query>) => {
            configurationReads++; return await fixture.collections.sourceInstances.query(...args);
        },
    }, sessionLinks: { ...fixture.collections.sessionLinks,
        query: async (...args: Parameters<typeof fixture.collections.sessionLinks.query>) => {
            linkQueries.push(args[0]);
            if (refuseSetQuery && args[0].prefixes !== undefined) throw new Error('Session set unavailable');
            return await fixture.collections.sessionLinks.query(...args);
        },
    } };
    // Host targeted-operation RPC and Account Collection I/O are the boundaries.
    const context = { signal: new AbortController().signal, services: {
        targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [...sources, {
            contributor: { pluginId: INTERNAL_TASK_SOURCE_V1.pluginId, contributionId: INTERNAL_TASK_SOURCE_V1.localId },
            descriptor: INTERNAL_TASK_DESCRIPTOR_V1,
            operations: { readSessionLinks: internalRead, linkSession: { role: 'internalWrite' } },
        }] }), dispose: () => {} }) },
        actions: {
            // Built-in task relations read the canonical Account Action rather than a source RPC.
            execute: async (action: string) => {
                if (action !== 'tasks.internal.list') throw new Error(`Unexpected host Action ${action}`);
                taskReads++;
                return getActionSpec(action).outputSchema.parse({ status: 'ok',
                    scope: { serverId: 'home', accountId: 'account-1' }, todos: [], undoneOrder: [], completedOrder: [] });
            },
            executeAdmittedTargetedOperation: async (_operation: unknown, input: { sessionId?: string }) => {
                roleSelections.push(input.sessionId);
                if (role === 'failed') throw new Error('PR relation unavailable');
                return { kind: 'complete', links: linkedSession !== undefined && input.sessionId === linkedSession
                    ? [{ localRef: { kindId: 'pull-request', collisionScope: 'acme/web', entryId: 'canonical' },
                        sessionId: linkedSession, linkedAtMs: 2_000, displayPath: 'Canonical PR' }] : [] };
            },
        },
    } } as unknown as Parameters<typeof createTriageSourceSessionRelations>[0];
    return { ...fixture, collections, relations: createTriageSourceSessionRelations(context, collections),
        counts: () => ({ configurationReads, roleReads: roleSelections.length }),
        readCosts: () => ({ taskReads, roleSelections: [...roleSelections], linkQueries: [...linkQueries] }),
        setLinkedSession: (sessionId: string | undefined) => { linkedSession = sessionId; },
        refuseSetQuery: () => { refuseSetQuery = true; } };
}

async function link(fixture: TestkitCorpusCollections, entryRef: TriageEntryRefV1, sessionId: string, nowMs: number) {
    const result = await linkEntryToSession({
        collections: fixture.collections,
        entryRef,
        display: { locator: testkitLocator({ displayPath: `acme/web ${entryRef.entryId}` }), scopeLabel: 'acme/web' },
        sessionId: sessionId as never,
        nowMs,
    });
    expect(result.status).toBe('linked');
}

async function resolve(
    fixture: ReturnType<typeof createTestkitCorpusCollections>,
    presentation: Readonly<Record<string, TriageFixPullRequestPresentationV1>> = {},
) {
    const sources = await readFixPullRequestSources({ collections: fixture.collections, sourceRelations: fixture.relations, entryRef: ERROR_REF });
    return resolveFixPullRequests(sources, {
        workflowSubjectOf,
        presentationOf: (ref) => presentation[ref.entryId] ?? null,
    });
}

describe('fix pull request links', () => {
    it('merges live native candidates with user and Session choices without persisting or overriding dismissals', async () => {
        const fixture = createTestkitCorpusCollections();
        const native = githubPr('native');
        const explicit = githubPr('explicit');
        await link(fixture, ERROR_REF, 'session-native', 10);
        await link(fixture, native, 'session-native', 20);
        await setFixPullRequest({ collections: fixture.collections, entryRef: ERROR_REF, displayAtMark: ERROR_DISPLAY,
            linked: true, fixPullRequest: explicit, displayAtLink: ERROR_DISPLAY, nowMs: 1 });
        const base = await readFixPullRequestSources({ collections: fixture.collections, sourceRelations: fixture.relations, entryRef: ERROR_REF });
        const sources = { ...base, native: [{ entryRef: native, status: 'open' as const, display: { title: 'Native update' } }] };
        const projected = resolveFixPullRequests(sources, { workflowSubjectOf, presentationOf: () => 'active' });
        expect(projected.candidates.map(({ entryRef, origins }) => [entryRef.entryId, origins])).toEqual([
            ['explicit', ['user']], ['native', ['session', 'native']],
        ]);
        expect(projected.primary?.entryRef).toEqual(explicit);
        expect(resolveFixPullRequests({ ...sources, dismissed: [native], incomplete: true }, {
            workflowSubjectOf, presentationOf: () => 'active',
        })).toMatchObject({ candidates: [{ entryRef: explicit }], incomplete: true });
        expect((await readFixPullRequestSources({ collections: fixture.collections, sourceRelations: fixture.relations, entryRef: ERROR_REF })).linked)
            .toHaveLength(1);
        expect(resolveFixPullRequests({ ...sources, linked: [], coLinked: [], native: [{ ...sources.native[0]!, status: 'closed' }] }, {
            workflowSubjectOf, presentationOf: () => null,
        }).primary).toBeNull();
    });
    it.each(['ready', 'failed'] as const)('discovers fix PRs through composed relations when the PR owner is %s', async (role) => {
        const fixture = createTestkitCorpusCollections({}, role);
        await link(fixture, ERROR_REF, 'session-a', 1_000);
        await link(fixture, githubPr('stale'), 'session-a', 2_000);
        await link(fixture, GITHUB_ISSUE, 'session-a', 3_000);
        const result = await readTriageFixPullRequests({ v: 1, entryRef: ERROR_REF }, {
            collections: fixture.collections, sourceRelations: fixture.relations, nowMs: () => 5_000,
            projection: { workflowSubjectOf, presentationOf: () => 'active' },
        });
        expect(result.candidates.map((candidate) => candidate.entryRef.entryId)).toEqual(role === 'ready' ? ['canonical'] : []);
        expect(result.incomplete).toBe(role === 'failed');
        expect(fixture.counts()).toEqual({ configurationReads: 1, roleReads: 1 });
        expect((await readTriageSessionLinksPageV1(fixture.collections.sessionLinks, { relation: { sessionId: 'session-a' } })).links)
            .toContainEqual(expect.objectContaining({ entryRef: githubPr('stale') }));
    });
    it('derives fix PRs for 14 Sessions with one task Action and two link queries', async () => {
        const fixture = createTestkitCorpusCollections({}, 'ready');
        const sessionIds = ['session-a', ...Array.from({ length: 13 }, (_, index) => `session-${index}`)];
        for (const sessionId of sessionIds) await link(fixture, ERROR_REF, sessionId, 1_000);
        const setupQueries = fixture.readCosts().linkQueries.length;
        const read = () => readTriageFixPullRequests({ v: 1, entryRef: ERROR_REF }, {
            collections: fixture.collections, sourceRelations: fixture.relations, nowMs: () => 5_000,
            projection: { workflowSubjectOf, presentationOf: () => 'active' },
        });
        const first = await read();
        expect(first.incomplete).toBe(false);
        expect(first.primary).toMatchObject({ entryRef: githubPr('canonical'), origins: ['session'], status: 'open' });
        const { taskReads, roleSelections, linkQueries: allQueries } = fixture.readCosts();
        const linkQueries = allQueries.slice(setupQueries);
        // 14 Sessions and three sources: 28 → 15 nested reads, 15 → 2 Collection queries.
        // Each GitHub read retains its exact Session selector.
        expect([...roleSelections].sort()).toEqual([...sessionIds].sort());
        expect({ taskReads, queries: linkQueries.length, uniqueQueries: new Set(linkQueries.map(query => JSON.stringify(query))).size })
            .toEqual({ taskReads: 1, queries: 2, uniqueQueries: 2 });
        fixture.setLinkedSession('unrelated-session');
        expect(await read()).toMatchObject({ incomplete: false, candidates: [], primary: null });
    });
    it('retains exact Session coverage if the Collection refuses the combined read', async () => {
        const fixture = createTestkitCorpusCollections();
        await link(fixture, ERROR_REF, 'session-a', 1_000);
        await link(fixture, ERROR_REF, 'session-b', 1_000);
        await link(fixture, githubPr('corpus-fix'), 'session-b', 2_000);
        const setupQueries = fixture.readCosts().linkQueries.length;
        fixture.refuseSetQuery();
        const result = await readTriageFixPullRequests({ v: 1, entryRef: ERROR_REF }, {
            collections: fixture.collections, sourceRelations: fixture.relations, nowMs: () => 5_000,
            projection: { workflowSubjectOf, presentationOf: () => 'active' },
        });
        expect(result).toMatchObject({ incomplete: false, primary: { entryRef: githubPr('corpus-fix'), origins: ['session'] } });
        expect(fixture.readCosts().linkQueries.slice(setupQueries)).toContainEqual(expect.objectContaining({
            prefixes: expect.arrayContaining([['session-a'], ['session-b']]),
        }));
    });
    it('retains a fix PR after more than one relation page of distinct non-PR siblings', async () => {
        const fixture = createTestkitCorpusCollections();
        await link(fixture, ERROR_REF, 'session-a', 1);
        await link(fixture, ERROR_REF, 'session-b', 2);
        const sessions = await readTriageSessionLinksPageV1(fixture.collections.sessionLinks, { relation: { entryRef: ERROR_REF } });
        const firstSession = sessions.links[0]!.sessionId;
        const laterSession = sessions.links[1]!.sessionId;
        for (const [sessionId, count] of [[firstSession, MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 - 1], [laterSession, 110]] as const) {
            for (let index = 0; index < count; index += 1) {
                await link(fixture, { ...GITHUB_ISSUE, entryId: `${sessionId}-${index}` }, sessionId, 10 + index);
            }
        }
        const pr = githubPr('late-fix');
        await link(fixture, pr, laterSession, 1_000);
        const later = await readTriageSessionLinksPageV1(fixture.collections.sessionLinks, { relation: { sessionId: laterSession } });
        expect(later.nextCursor).toBeUndefined();
        // The fixture puts at least 200 non-PR entries before this PR across
        // the two complete relation pages, so filtering after a total cap loses it.
        expect(later.links.filter((sibling) => sibling.entryRef.kindId !== 'error-group')[0]?.entryRef.kindId).toBe('issue');

        const sources = await readFixPullRequestSources({ collections: fixture.collections, sourceRelations: fixture.relations, entryRef: ERROR_REF });
        const resolved = await readTriageFixPullRequests({ v: 1, entryRef: ERROR_REF }, {
            collections: fixture.collections, sourceRelations: fixture.relations, nowMs: () => 1_100,
            projection: { workflowSubjectOf, presentationOf: () => null },
        });
        expect(resolved.candidates).toEqual([expect.objectContaining({ entryRef: pr, origins: ['session'] })]);
        expect(sources.coLinked).toHaveLength(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 110);
        expect(sources.incomplete).toBe(false);
        const firstSibling = sources.coLinked[0]!;
        await link(fixture, firstSibling.entryRef, laterSession, 1_900);
        const repeated = await readFixPullRequestSources({ collections: fixture.collections, sourceRelations: fixture.relations, entryRef: ERROR_REF });
        expect(repeated.coLinked.map((entry) => entry.entryRef)).toEqual(sources.coLinked.map((entry) => entry.entryRef));
        expect(repeated.coLinked[0]?.linkedAtMs).toBe(1_900);

        // A duplicate relation is one candidate, and durable choice still
        // outranks a newer derived link of the same lifecycle state.
        await link(fixture, ERROR_REF, 'session-duplicate', 2_000);
        await link(fixture, pr, 'session-duplicate', 2_001);
        const duplicates = await readFixPullRequestSources({ collections: fixture.collections, sourceRelations: fixture.relations, entryRef: ERROR_REF });
        expect(duplicates.coLinked.filter((entry) => entry.entryRef.kindId === 'pull-request'))
            .toEqual([expect.objectContaining({ entryRef: pr, linkedAtMs: 2_001 })]);
        const explicit = githubPr('explicit-fix');
        await setFixPullRequest({ collections: fixture.collections, entryRef: ERROR_REF, displayAtMark: ERROR_DISPLAY,
            linked: true, fixPullRequest: explicit, displayAtLink: ERROR_DISPLAY, nowMs: 500 });
        expect((await resolve(fixture)).candidates.map((candidate) => candidate.entryRef)).toEqual([explicit, pr]);
        expect((await resolve(fixture)).incomplete).toBe(false);
        await setFixPullRequest({ collections: fixture.collections, entryRef: ERROR_REF, displayAtMark: ERROR_DISPLAY,
            linked: false, fixPullRequest: pr, nowMs: 3_000 });
        expect((await resolve(fixture)).candidates.map((candidate) => candidate.entryRef)).toEqual([explicit]);

        // The composed relation owner drains each selected relation's pages;
        // a physical page cut cannot erase a valid sibling or invent incompleteness.
        await link(fixture, { ...GITHUB_ISSUE, entryId: 'beyond-relation-page' }, firstSession, 4_000);
        const firstPage = await readTriageSessionLinksPageV1(fixture.collections.sessionLinks, { relation: { sessionId: firstSession } });
        expect(firstPage.nextCursor).toBeDefined();
        const suffix = await readTriageSessionLinksPageV1(fixture.collections.sessionLinks, {
            relation: { sessionId: firstSession }, cursor: firstPage.nextCursor,
        });
        const incomplete = await readFixPullRequestSources({ collections: fixture.collections, sourceRelations: fixture.relations, entryRef: ERROR_REF });
        expect(incomplete.incomplete).toBe(false);
        expect(incomplete.coLinked.map((entry) => entry.entryRef)).toContainEqual(suffix.links[0]!.entryRef);
    });

    it('returns every durable explicit choice rather than applying the relationship query page to intent', async () => {
        const fixture = createTestkitCorpusCollections();
        const choices = 2 * MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1;
        for (let i = 0; i < choices; i += 1) {
            expect(await setFixPullRequest({ collections: fixture.collections,
                entryRef: ERROR_REF, displayAtMark: ERROR_DISPLAY, fixPullRequest: githubPr(String(i)),
                linked: true, displayAtLink: ERROR_DISPLAY, nowMs: i,
            })).toEqual({ status: 'linked' });
        }
        const result = await readTriageFixPullRequests({ v: 1, entryRef: ERROR_REF }, {
            collections: fixture.collections, sourceRelations: fixture.relations, nowMs: () => choices + 1,
            projection: { workflowSubjectOf, presentationOf: () => 'active' },
        });
        expect(result.candidates).toHaveLength(choices);
        expect(result.incomplete).toBe(false);
    });
    it('keeps link and unlink available after dismissal history exceeds a relationship query page', async () => {
        const fixture = createTestkitCorpusCollections();
        const dismissals = MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1;
        for (let i = 0; i < dismissals; i += 1) {
            expect(await setFixPullRequest({
                collections: fixture.collections, entryRef: ERROR_REF, displayAtMark: ERROR_DISPLAY,
                fixPullRequest: githubPr(String(i)), linked: false, nowMs: i,
            })).toEqual({ status: 'unlinked' });
        }
        expect(await setFixPullRequest({
            collections: fixture.collections, entryRef: ERROR_REF, displayAtMark: ERROR_DISPLAY,
            fixPullRequest: githubPr('new'), linked: true, displayAtLink: ERROR_DISPLAY, nowMs: dismissals + 1,
        })).toEqual({ status: 'linked' });
        expect((await resolve(fixture)).primary?.entryRef).toEqual(githubPr('new'));
        const sources = await readFixPullRequestSources({ collections: fixture.collections, sourceRelations: fixture.relations, entryRef: ERROR_REF });
        expect(sources.dismissed).toHaveLength(dismissals);
    });
    it('returns the owner-resolved public read, excluding non-PR siblings and keeping closed PRs out of primary', async () => {
        const fixture = createTestkitCorpusCollections();
        await link(fixture, ERROR_REF, 'session-a', 1_000);
        await link(fixture, githubPr('41'), 'session-a', 2_000);
        await link(fixture, githubPr('42'), 'session-a', 3_000);
        await link(fixture, GITHUB_ISSUE, 'session-a', 4_000);

        const result = await readTriageFixPullRequests({ v: 1, entryRef: ERROR_REF }, {
            collections: fixture.collections, sourceRelations: fixture.relations,
            nowMs: () => 5_000,
            projection: {
                workflowSubjectOf,
                presentationOf: async (ref: TriageEntryRefV1) => ref.entryId === '41' ? 'closed' : 'resolved',
            },
        });

        expect(result).toEqual({
            v: 1,
            candidates: [
                { entryRef: githubPr('42'), origins: ['session'], status: 'merged', display: { displayPath: 'acme/web 42' } },
                { entryRef: githubPr('41'), origins: ['session'], status: 'closed', display: { displayPath: 'acme/web 41' } },
            ],
            primary: { entryRef: githubPr('42'), origins: ['session'], status: 'merged', display: { displayPath: 'acme/web 42' } },
            incomplete: false,
        });
    });

    it('derives a cross-source fix PR from a Session linked to both the error and the PR, and nothing else', async () => {
        const fixture = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        await link(fixture, ERROR_REF, 'session-a', 1_000);
        await link(fixture, githubPr('41'), 'session-a', 2_000);
        // Co-linked, but an issue is not a pull request.
        await link(fixture, GITHUB_ISSUE, 'session-a', 3_000);
        // A PR worked on in a Session that never touched the error.
        await link(fixture, githubPr('77'), 'session-b', 4_000);

        const resolved = await resolve(fixture, { 41: 'active' });

        expect(resolved.candidates).toEqual([{
            entryRef: githubPr('41'),
            origins: ['session'],
            status: 'open',
            display: { displayPath: 'acme/web 41' },
        }]);
        expect(resolved.primary?.entryRef).toEqual(githubPr('41'));
        expect(resolved.incomplete).toBe(false);
    });

    it('keeps a linked PR unknown when its source is unavailable, while cancellation aborts the read', async () => {
        const fixture = createTestkitCorpusCollections();
        await link(fixture, ERROR_REF, 'session-a', 1_000);
        await link(fixture, githubPr('41'), 'session-a', 2_000);
        const result = await readTriageFixPullRequests({ v: 1, entryRef: ERROR_REF }, {
            collections: fixture.collections, sourceRelations: fixture.relations,
            nowMs: () => 5_000,
            projection: { workflowSubjectOf, presentationOf: async () => { throw new Error('Source unreachable'); } },
        });
        expect(result.primary).toMatchObject({ entryRef: githubPr('41'), status: 'unknown' });
        const controller = new AbortController();
        await expect(readTriageFixPullRequests({ v: 1, entryRef: ERROR_REF }, {
            collections: fixture.collections,
            sourceRelations: fixture.relations,
            nowMs: () => 5_000,
            signal: controller.signal,
            projection: { workflowSubjectOf, presentationOf: async () => {
                controller.abort();
                throw controller.signal.reason;
            } },
        })).rejects.toThrow();
    });

    it('records an explicit link on the error mark without pinning it, and keeps an existing pin', async () => {
        const fixture = createTestkitCorpusCollections();
        const pr = githubPr('52');

        expect(await setFixPullRequest({
            collections: fixture.collections,
            entryRef: ERROR_REF,
            displayAtMark: ERROR_DISPLAY,
            linked: true,
            fixPullRequest: pr,
            displayAtLink: { title: 'Guard missing id', scopeLabel: 'acme/web' },
            nowMs: 5_000,
        })).toEqual({ status: 'linked' });

        const resolved = await resolve(fixture, { 52: 'resolved' });
        expect(resolved.candidates).toEqual([{
            entryRef: pr,
            origins: ['user'],
            status: 'merged',
            display: { title: 'Guard missing id', scopeLabel: 'acme/web' },
        }]);
        expect(resolved.primary?.entryRef).toEqual(pr);

        // The mark exists only for the link: it is not a pin.
        const pinned = await fixture.collections.userMarks.query({
            index: CORPUS_USER_MARKS_INDEX_ID.byPinned,
            prefix: [true],
            order: 'asc',
        });
        expect(pinned.rows).toHaveLength(0);

        // Pinning afterwards keeps the link, and unpinning keeps the row.
        await setPinned({ collections: fixture.collections, entryRef: ERROR_REF, pinned: true, displayAtMark: ERROR_DISPLAY, nowMs: 6_000 });
        const markTag = await deriveUserMarkTag(fixture.collections.userMarks, ERROR_REF);
        expect((await fixture.collections.userMarks.get(markTag))?.value).toMatchObject({ pinned: true, markedAtMs: 6_000 });
        expect(await setPinned({ collections: fixture.collections, entryRef: ERROR_REF, pinned: false, nowMs: 7_000 }))
            .toEqual({ status: 'unpinned', markTag });
        const kept = (await fixture.collections.userMarks.get(markTag))?.value as unknown as CorpusUserMarkRowV1;
        expect(kept.pinned).toBe(false);
        expect((await resolve(fixture)).candidates.map((c) => c.entryRef)).toEqual([pr]);
    });

    it('does not select a known non-PR explicit target, but retains a link when its descriptor is unavailable', async () => {
        const fixture = createTestkitCorpusCollections();
        await setFixPullRequest({
            collections: fixture.collections, entryRef: ERROR_REF, displayAtMark: ERROR_DISPLAY,
            linked: true, fixPullRequest: GITHUB_ISSUE,
            displayAtLink: { title: 'Another issue', scopeLabel: 'acme/web' }, nowMs: 1000,
        });
        const sources = await readFixPullRequestSources({ collections: fixture.collections, sourceRelations: fixture.relations, entryRef: ERROR_REF });
        expect(resolveFixPullRequests(sources, { workflowSubjectOf, presentationOf: () => 'active' }))
            .toEqual({ candidates: [], primary: null, incomplete: false });
        // A stale display projection cannot stand in for an unavailable source descriptor.
        const unavailable = resolveFixPullRequests(sources, { workflowSubjectOf: () => null, presentationOf: () => 'active' });
        expect(unavailable.primary).toMatchObject({ entryRef: GITHUB_ISSUE, status: 'unknown' });
    });

    it('refuses a known non-PR link before writing, while unavailable descriptors preserve explicit intent', async () => {
        const fixture = createTestkitCorpusCollections();
        const input = {
            collections: fixture.collections, entryRef: ERROR_REF, displayAtMark: ERROR_DISPLAY,
            linked: true as const, fixPullRequest: GITHUB_ISSUE,
            displayAtLink: { title: 'Another issue', scopeLabel: 'acme/web' }, nowMs: 1000,
            fixPullRequestWorkflowSubject: 'issue' as const,
        };
        await expect(setFixPullRequest(input)).rejects.toMatchObject({ name: 'PluginError', code: 'triage_fix_pull_request_kind_invalid' });
        expect((await readFixPullRequestSources({ collections: fixture.collections, sourceRelations: fixture.relations, entryRef: ERROR_REF })).linked).toEqual([]);
        expect(await setFixPullRequest({ ...input, fixPullRequestWorkflowSubject: null })).toEqual({ status: 'linked' });
        expect((await readFixPullRequestSources({ collections: fixture.collections, sourceRelations: fixture.relations, entryRef: ERROR_REF })).linked)
            .toEqual([expect.objectContaining({ entryRef: GITHUB_ISSUE })]);
    });

    it('unlinks a derived candidate without touching the Session link, and relinking restores it', async () => {
        const fixture = createTestkitCorpusCollections();
        const pr = githubPr('41');
        await link(fixture, ERROR_REF, 'session-a', 1_000);
        await link(fixture, pr, 'session-a', 2_000);

        expect(await setFixPullRequest({
            collections: fixture.collections,
            entryRef: ERROR_REF,
            displayAtMark: ERROR_DISPLAY,
            linked: false,
            fixPullRequest: pr,
            nowMs: 3_000,
        })).toEqual({ status: 'unlinked' });

        expect((await resolve(fixture)).candidates).toEqual([]);
        // The Session still worked on the PR.
        const sources = await readFixPullRequestSources({ collections: fixture.collections, sourceRelations: fixture.relations, entryRef: ERROR_REF });
        expect(sources.coLinked.map((c) => c.entryRef)).toEqual([pr]);

        await setFixPullRequest({
            collections: fixture.collections,
            entryRef: ERROR_REF,
            displayAtMark: ERROR_DISPLAY,
            linked: true,
            fixPullRequest: pr,
            displayAtLink: { title: 'Guard missing id', scopeLabel: 'acme/web' },
            nowMs: 4_000,
        });
        expect((await resolve(fixture)).candidates).toEqual([
            expect.objectContaining({ entryRef: pr, origins: ['user', 'session'] }),
        ]);
    });

    it('never renders a PR closed without merging, and prefers open, then merged, then unknown', async () => {
        const fixture = createTestkitCorpusCollections();
        await link(fixture, ERROR_REF, 'session-a', 1_000);
        await link(fixture, githubPr('1'), 'session-a', 2_000);
        await link(fixture, githubPr('2'), 'session-a', 3_000);
        await link(fixture, githubPr('3'), 'session-a', 4_000);

        const onlyClosed = await resolve(fixture, { 1: 'closed', 2: 'closed', 3: 'suppressed' });
        expect(onlyClosed.primary).toBeNull();
        expect(onlyClosed.candidates.map((c) => c.status)).toEqual(['closed', 'closed', 'closed']);

        const mixed = await resolve(fixture, { 1: 'closed', 2: 'resolved' });
        expect(mixed.primary?.entryRef).toEqual(githubPr('2'));
        expect(mixed.candidates.map((c) => [c.entryRef.entryId, c.status])).toEqual([
            ['2', 'merged'],
            ['3', 'unknown'],
            ['1', 'closed'],
        ]);

        const open = await resolve(fixture, { 1: 'closed', 2: 'resolved', 3: 'active' });
        expect(open.primary?.entryRef).toEqual(githubPr('3'));
    });
});
