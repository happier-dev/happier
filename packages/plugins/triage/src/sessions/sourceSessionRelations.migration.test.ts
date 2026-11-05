import { describe, expect, it, vi } from 'vitest';
import type { JsonValue, PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';

import { MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1, type TriageSourceEntryLocalRefV1 } from '@happier-dev/triage-protocol/v1';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';
import { TriageReadSourceSessionLinksResultV1Schema } from '../actions/sessionLinksProtocol.js';
import { activate } from '../accountRuntime.js';
import { linkEntryToSession } from './entrySessionLinks.js';
import { testkitConfiguredInstance, testkitReadOnlySourceSnapshot, TESTKIT_LINK_DISPLAY } from './testkit/entrySessionTestkit.test-support.js';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../internalTasks/contribution.js';

describe('automatic retained PR duplicate contraction', () => {
    it.each(['verified', 'newer-proof', 'read-lost', 'late-proof', 'census-failed', 'concurrent-proof', 'explicit-unlink', 'absent', 'foreign-proof', 'retired', 'retired-census', 'configured-later', 'paged', 'cancelled-demand', 'cancelled-census'] as const)(
        'uses native proof without write Actions when the duplicate is %s', async outcome => {
            const { collections: backing, control } = createTestkitCorpusCollections();
            let upgradePages = 0;
            let configuredReads = 0;
            let admittedReads = 0;
            let retainedDeletes = 0;
            let releaseCensus: (() => void) | undefined;
            let releaseSuccessorCensus: (() => void) | undefined;
            let censusSignal: AbortSignal | undefined;
            let proofRowId: string | undefined;
            let proofGets = 0;
            let secondProofGet: (() => void) | undefined;
            let firstProofReadComplete: (() => void) | undefined;
            const bothProofReads = new Promise<void>(resolve => { secondProofGet = resolve; });
            const firstProofRead = new Promise<void>(resolve => { firstProofReadComplete = resolve; });
            const internalRead = { role: 'internalRead' };
            const internalWrite = { role: 'internalWrite' };
            const collections: CorpusCollectionsV1 = { ...backing,
                sourceInstances: { ...backing.sourceInstances, query: async (...args: Parameters<typeof backing.sourceInstances.query>) => {
                    configuredReads++;
                    return await backing.sourceInstances.query(...args);
                } }, sessionLinks: { ...backing.sessionLinks,
                get: async (...args: Parameters<typeof backing.sessionLinks.get>) => {
                    if (args[0] === proofRowId) {
                        const proofGet = ++proofGets;
                        if (proofGet === 1) await bothProofReads;
                        if (proofGet === 2) { secondProofGet?.(); await firstProofRead; }
                    }
                    return await backing.sessionLinks.get(...args);
                },
                delete: async (...args: Parameters<typeof backing.sessionLinks.delete>) => {
                    retainedDeletes++;
                    return await backing.sessionLinks.delete(...args);
                },
                query: async (...args: Parameters<typeof backing.sessionLinks.query>) => {
                    if (args[0].index === 'by-entry' && args[0].prefix === undefined) {
                        upgradePages++;
                        if (outcome === 'census-failed' && upgradePages === 1) throw new Error('Initial retained census unavailable');
                        if ((outcome === 'cancelled-census' || outcome === 'retired-census') && upgradePages === 1) {
                            censusSignal = args[1]?.signal;
                            await new Promise<void>(resolve => { releaseCensus = resolve; });
                            if (censusSignal?.aborted) throw new Error('Collection request cancelled');
                        }
                        if (outcome === 'cancelled-census' && upgradePages === 2) {
                            await new Promise<void>(resolve => { releaseSuccessorCensus = resolve; });
                        }
                    }
                    return await backing.sessionLinks.query(...args);
                },
            } };
            const configured = testkitConfiguredInstance();
            const configuredRow = { instanceTag: 'a'.repeat(43),
                lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
                sourceQualifiedId: `${configured.instance.source.pluginId}/${configured.instance.source.localId}`, configured };
            if (outcome !== 'configured-later') control.sourceInstances.seed(toCorpusStoredValue(configuredRow));
            const entryRef = testkitEntryRef();
            const old = await linkEntryToSession({ collections, entryRef, sessionId: 'session-a',
                display: TESTKIT_LINK_DISPLAY, nowMs: 1234 });
            const issue = outcome === 'concurrent-proof' ? undefined : await linkEntryToSession({ collections, entryRef: { ...entryRef, kindId: 'issue' }, sessionId: 'session-a',
                display: TESTKIT_LINK_DISPLAY, nowMs: 1235 });
            if (outcome === 'paged') for (let index = 0; index < MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1; index++) {
                await linkEntryToSession({ collections, entryRef: { ...entryRef, kindId: 'issue', entryId: `issue-${index}` },
                    sessionId: 'other-session', display: TESTKIT_LINK_DISPLAY, nowMs: index + 1236 });
            }
            if (old.status !== 'linked' || (issue !== undefined && issue.status !== 'linked')) throw new Error('Expected retained corpus links');
            const unresolved = outcome === 'concurrent-proof' ? await linkEntryToSession({ collections,
                entryRef: { ...entryRef, entryId: 'unresolved-pr' }, sessionId: 'session-b',
                display: TESTKIT_LINK_DISPLAY, nowMs: 1236 }) : undefined;
            const retained = await collections.sessionLinks.get(old.linkTag);
            const localRef = { kindId: entryRef.kindId, collisionScope: entryRef.collisionScope, entryId: entryRef.entryId };
            const nativeProof = { localRef, sessionId: 'session-a', linkedAtMs: outcome === 'newer-proof' ? 5678 : 1234, displayPath: 'Native PR' };
            let native: Array<typeof nativeProof> = outcome === 'absent' || outcome === 'concurrent-proof'
                || outcome === 'configured-later' || outcome === 'cancelled-demand' || outcome === 'explicit-unlink' || outcome === 'late-proof' ? []
                : [{ ...nativeProof, localRef: { ...localRef, ...(outcome === 'foreign-proof' ? { entryId: '999' } : {}) } }];
            const writes: unknown[] = [];
            const source = testkitReadOnlySourceSnapshot().contributions[0]!;
            let finishNativeRead: (() => void) | undefined;
            let firstNativeRead = true;
            let nativeSignal: AbortSignal | undefined;
            const demand = new AbortController();
            // Only the admitted Action transport is replaced; ownership, paging,
            // native-result validation and conditional corpus contraction are real.
            const context = { surface: 'api', signal: demand.signal, services: {
                storage: { account: { collection: (definition: { id: string }) => definition.id === 'session-links'
                    ? collections.sessionLinks : definition.id === 'source-instances' ? collections.sourceInstances : collections.userMarks } },
                targetedContributions: { observeForSelf: () => ({ readCurrent: async () => { admittedReads++; return { contributions: [{ ...source,
                    descriptor: { ...source.descriptor, sessionRelations: { kindIds: ['pull-request'] } },
                    operations: { readSessionLinks: { role: 'read' }, linkSession: { role: 'write' } },
                }, {
                    contributor: { pluginId: 'happier.triage', contributionId: 'internal' },
                    descriptor: INTERNAL_TASK_DESCRIPTOR_V1,
                    operations: { readSessionLinks: internalRead, linkSession: internalWrite },
                }] }; }, dispose() {} }) },
                actions: {
                    execute: async (action: string) => {
                        if (action !== 'tasks.internal.list') throw new Error(`Unexpected host Action ${action}`);
                        return { status: 'ok', scope: { serverId: 'home', accountId: 'account' }, todos: [], undoneOrder: [], completedOrder: [] };
                    },
                    executeAdmittedTargetedOperation: async (operation: { role: string }, input: {
                    localRef?: TriageSourceEntryLocalRefV1; sessionId?: string; linked?: boolean;
                }, options?: { signal?: AbortSignal }) => {
                    if (options?.signal?.aborted) throw new Error('Host invocation retired');
                    if (operation === internalRead) {
                        const handler = handlers.get('internal/tasks/read-session-links-v1');
                        if (handler === undefined) throw new Error('Expected registered internal source');
                        return await handler(input, context);
                    }
                    if (operation.role === 'read') {
                        if (outcome === 'read-lost' && firstNativeRead) {
                            firstNativeRead = false;
                            throw new Error('Native read response lost');
                        }
                        if ((outcome === 'retired' || outcome === 'cancelled-demand') && firstNativeRead) {
                            firstNativeRead = false;
                            nativeSignal = options?.signal;
                            await new Promise<void>(resolve => { finishNativeRead = resolve; });
                        }
                        return { kind: 'complete', links: native.filter(link => input.sessionId === undefined || input.sessionId === link.sessionId) };
                    }
                    writes.push(input);
                    if ((outcome === 'explicit-unlink' || outcome === 'concurrent-proof') && input.linked === false) return { status: 'unlinked' };
                    throw new Error('A read cannot acquire approval to create a native relationship');
                } },
            } } as unknown as Parameters<PluginAccountActionHandler>[1];
            const handlers = new Map<string, PluginAccountActionHandler<JsonValue, JsonValue | void>>();
            const api = { resources: { registerDynamicResource() {} }, actions: { register: (id: string,
                handler: PluginAccountActionHandler<JsonValue, JsonValue | void>) => { handlers.set(id, handler); } } } as unknown as PluginAccountApi;
            const cleanup = activate(api);
            const handler = handlers.get('sessions/read-source-links-v1');
            if (handler === undefined) throw new Error('Account activation must register the relation owner');
            const read = async () => TriageReadSourceSessionLinksResultV1Schema.parse(await handler({ v: 1, sessionId: 'session-a' }, context));
            const unlink = async () => {
                const unlinkHandler = handlers.get('sessions/unlink-entry-v1');
                if (unlinkHandler === undefined) throw new Error('Expected registered explicit unlink');
                return await unlinkHandler({ v: 1, entryRef, sessionId: 'session-a',
                    sourceInstanceId: configured.instance.sourceInstanceId }, context);
            };
            if (outcome === 'cancelled-census' || outcome === 'retired-census') {
                const reading = read();
                await vi.waitFor(() => expect(releaseCensus).toBeTypeOf('function'));
                if (outcome === 'cancelled-census') demand.abort();
                const fresh = { ...context, signal: new AbortController().signal };
                // A newly mounted demand can arrive before the cancelled
                // Collection request has finished draining.
                const successor = outcome === 'cancelled-census'
                    ? Promise.all([handler({ v: 1, sessionId: 'session-a' }, fresh),
                        handler({ v: 1, sessionId: 'session-a' }, { ...context, signal: new AbortController().signal })]) : undefined;
                const retirement = outcome === 'retired-census' ? cleanup() : Promise.resolve();
                expect(censusSignal?.aborted).toBe(true);
                let drained = false;
                void retirement.then(() => { drained = true; });
                await Promise.resolve();
                if (outcome === 'retired-census') expect(drained).toBe(false);
                releaseCensus?.();
                await reading;
                await retirement;
                expect(writes).toEqual([]);
                if (outcome === 'retired-census') {
                    expect(upgradePages).toBe(1);
                    expect(await collections.sessionLinks.get(old.linkTag)).toEqual(retained);
                    expect(cleanup()).toBe(retirement);
                } else {
                    await vi.waitFor(() => expect(releaseSuccessorCensus).toBeTypeOf('function'));
                    // Drain current microtasks while the successor's actual
                    // Collection boundary stays pending; no deadline is imposed.
                    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
                    releaseSuccessorCensus?.();
                    const recovered = ((await successor) ?? []).map(value => TriageReadSourceSessionLinksResultV1Schema.parse(value));
                    expect(recovered.map(result => result.kind)).toEqual(['complete', 'complete']);
                    expect(await collections.sessionLinks.get(old.linkTag)).toBeNull();
                    expect(upgradePages).toBe(2);
                    await handler({ v: 1, sessionId: 'session-a' }, fresh);
                    expect(upgradePages).toBe(2);
                    expect(writes).toEqual([]);
                    await cleanup();
                }
                return;
            }
            if (outcome === 'configured-later') {
                await read();
                control.sourceInstances.seed(toCorpusStoredValue(configuredRow));
                expect((await read()).kind).toBe('partial');
                expect(await collections.sessionLinks.get(old.linkTag)).toEqual(retained);
                native = [nativeProof];
                expect((await read()).kind).toBe('complete');
                expect(writes).toEqual([]);
                expect(await collections.sessionLinks.get(old.linkTag)).toBeNull();
                await cleanup();
                return;
            }
            if (outcome === 'retired' || outcome === 'cancelled-demand') {
                const reading = read();
                await vi.waitFor(() => expect(finishNativeRead).toBeTypeOf('function'));
                if (outcome === 'cancelled-demand') demand.abort();
                const retirement = outcome === 'retired' ? cleanup() : Promise.resolve();
                expect(nativeSignal?.aborted).toBe(true);
                let drained = false;
                void retirement.then(() => { drained = true; });
                await Promise.resolve();
                if (outcome === 'retired') expect(drained).toBe(false);
                finishNativeRead?.();
                await retirement;
                await reading;
                expect(writes).toEqual([]);
                expect(await collections.sessionLinks.get(old.linkTag)).toEqual(retained);
                if (outcome === 'cancelled-demand') {
                    const resumed = await handler({ v: 1, sessionId: 'session-a' }, { ...context, signal: new AbortController().signal });
                    expect(resumed).toMatchObject({ kind: 'partial' });
                    expect(writes).toEqual([]);
                    await cleanup();
                }
                return;
            }
            const first = await read();
            if (outcome === 'late-proof' || outcome === 'census-failed') {
                expect(first.kind).toBe('partial');
                expect(retainedDeletes).toBe(0);
                native = [nativeProof];
                for (let demandIndex = 0; demandIndex < 2; demandIndex++) {
                    const later = await read();
                    expect(retainedDeletes).toBe(1);
                    expect(later.kind).toBe('complete');
                    expect(later.links).toContainEqual(expect.objectContaining({ entryRef, sessionId: 'session-a' }));
                    expect(await collections.sessionLinks.get(old.linkTag)).toBeNull();
                }
                expect(upgradePages).toBe(outcome === 'census-failed' ? 2 : 1);
                expect(writes).toEqual([]);
                await cleanup();
                return;
            }
            if (outcome === 'explicit-unlink') {
                expect(first.kind).toBe('partial');
                expect(writes).toEqual([]);
                expect(await unlink()).toMatchObject({ status: 'unlinked' });
                expect(await collections.sessionLinks.get(old.linkTag)).toBeNull();
                expect((await read()).kind).toBe('complete');
                expect(writes).toHaveLength(1);
                await cleanup();
                return;
            }
            if (outcome === 'concurrent-proof') {
                expect(first.kind).toBe('partial');
                expect(writes).toEqual([]);
                expect(await unlink()).toMatchObject({ status: 'unlinked' });
                proofRowId = old.linkTag;
                const firstReading = read();
                await vi.waitFor(() => expect(proofGets).toBe(1));
                const secondReading = read();
                void firstReading.then(() => firstProofReadComplete?.());
                await Promise.all([firstReading, secondReading]);
                proofRowId = undefined;
                const other = TriageReadSourceSessionLinksResultV1Schema.parse(await handler({ v: 1, sessionId: 'session-b' }, context));
                expect(other.kind).toBe('partial');
                expect(other.lanes).toContainEqual(expect.objectContaining({ kindIds: ['pull-request'],
                    health: { kind: 'failed', failure: { class: 'transient', code: 'sessionLinksMigrationIncomplete' } } }));
                expect(unresolved?.status).toBe('linked');
                if (unresolved?.status === 'linked') expect(await collections.sessionLinks.get(unresolved.linkTag)).not.toBeNull();
                expect(writes).toHaveLength(1);
                await cleanup();
                return;
            }
            expect(writes).toEqual([]);
            if (issue?.status === 'linked') expect(await collections.sessionLinks.get(issue.linkTag)).not.toBeNull();
            if (outcome === 'verified' || outcome === 'newer-proof' || outcome === 'paged' || outcome === 'read-lost') {
                expect(first.kind).toBe('complete');
                expect(first.links).toContainEqual(expect.objectContaining({ entryRef, sessionId: 'session-a', linkedAtMs: nativeProof.linkedAtMs,
                    displayPath: 'Native PR' }));
                expect(await collections.sessionLinks.get(old.linkTag)).toBeNull();
                // The one activation upgrade and the post-upgrade requested
                // read acquire separate current views; steady reads acquire one.
                expect([configuredReads, admittedReads]).toEqual([2, 2]);
                await read();
                expect([configuredReads, admittedReads]).toEqual([3, 3]);
                expect(writes).toEqual([]);
                expect(upgradePages).toBe(outcome === 'paged' ? 2 : 1);
                await cleanup();
                // A new real activation owns a separate captured Account
                // occurrence even if its fixture uses equal natural entry ids.
                await linkEntryToSession({ collections, entryRef, sessionId: 'session-a', display: TESTKIT_LINK_DISPLAY, nowMs: 1234 });
                const secondCleanup = activate(api);
                const secondHandler = handlers.get('sessions/read-source-links-v1');
                if (secondHandler === undefined) throw new Error('Expected second Account registration');
                await Promise.all([secondHandler({ v: 1, sessionId: 'session-a' }, context), secondHandler({ v: 1, sessionId: 'session-a' }, context)]);
                expect(writes).toEqual([]);
                await secondCleanup();
            } else {
                expect(first.kind).toBe('partial');
                expect(await collections.sessionLinks.get(old.linkTag)).toEqual(retained);
                if (outcome === 'absent' || outcome === 'foreign-proof') {
                    await read();
                    expect(writes).toEqual([]);
                    expect(retainedDeletes).toBe(0);
                }
            }
            await cleanup?.();
        },
    );
});
