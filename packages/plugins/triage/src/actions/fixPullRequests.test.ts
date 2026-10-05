import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageReadFixPullRequestsResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE, CORPUS_USER_MARKS_INDEX_ID } from '../corpus/collections/ids.js';
import { createTriageReadFixPullRequestsActionHandler, createTriageSetFixPullRequestActionHandler, setTriageFixPullRequest } from './fixPullRequests.js';

const fixture = createTriageSourceV1Fixture();
const pr = fixture.detailInput.observation.entryRef;
const error = { ...pr, source: { pluginId: 'happier.example.errors', localId: 'errors' }, kindId: 'error', entryId: 'error-1' };
const display = { title: 'Fix error', scopeLabel: 'example/repo' };

describe('fix-PR public Action read', () => {
    it('resolves lifecycle through the current configured source and admitted get, without exposing mark storage', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: 'a'.repeat(43),
            sourceQualifiedId: `${pr.source.pluginId}/${pr.source.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1000, configured: fixture.configuredInstance,
        }));
        await setTriageFixPullRequest({ v: 1, linked: true, entryRef: error, displayAtMark: display,
            fixPullRequest: pr, displayAtLink: display }, { collections, nowMs: () => 1000 });
        const requests: unknown[] = [];
        const controller = new AbortController();
        let disposed = false;
        // Host context, Account persistence, admission and provider dispatch are system boundaries.
        const context = {
            surface: 'agent', signal: controller.signal,
            services: {
                storage: { account: { collection: (definition: PluginAccountCollectionDefinition) => (
                    definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID ? collections.sourceInstances
                        : definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID ? collections.sessionLinks : collections.userMarks
                ) } },
                targetedContributions: { observeForSelf: () => ({
                    readCurrent: async () => ({ contributions: [{
                        contributor: { pluginId: pr.source.pluginId, contributionId: pr.source.localId },
                        descriptor: fixture.descriptor, operations: { get: { handle: 'admitted-get' } },
                    }] }),
                    dispose: () => { disposed = true; },
                }) },
                actions: { executeAdmittedTargetedOperation: async (operation: unknown, input: unknown, options: { signal?: AbortSignal }) => {
                    requests.push({ operation, input });
                    expect(options.signal?.aborted).toBe(false);
                    return { ...fixture.getResult, snapshot: { ...fixture.detailInput.observation.snapshot,
                        state: { ...fixture.detailInput.observation.snapshot.state, presentation: 'closed' } } };
                } },
            },
        } as unknown as PluginInvocationContext;
        const result = TriageReadFixPullRequestsResultV1Schema.parse(await createTriageReadFixPullRequestsActionHandler()({
            v: 1, entryRef: error,
        }, context));
        expect(result).toEqual({ v: 1, candidates: [{ entryRef: pr, origins: ['user'], status: 'closed', display }], primary: null, incomplete: false });
        expect(requests).toEqual([{ operation: { handle: 'admitted-get' }, input: {
            v: 1, instance: fixture.configuredInstance,
            localRef: { kindId: pr.kindId, collisionScope: pr.collisionScope, entryId: pr.entryId },
        } }]);
        expect(disposed).toBe(true);
    });

    it('rejects a currently declared issue target through the write Action without invoking a provider', async () => {
        const { collections } = createTestkitCorpusCollections();
        const issue = { ...pr, kindId: 'issue' };
        let disposed = false;
        // Only Account storage and the host's admitted descriptor snapshot are substituted.
        const context = {
            surface: 'agent',
            services: {
                storage: { account: { collection: () => collections.userMarks } },
                targetedContributions: { observeForSelf: () => ({
                    readCurrent: async () => ({ contributions: [{
                        contributor: { pluginId: pr.source.pluginId, contributionId: pr.source.localId },
                        descriptor: fixture.descriptor, operations: {},
                    }] }),
                    dispose: () => { disposed = true; },
                }) },
                actions: { executeAdmittedTargetedOperation: async () => { throw new Error('Writes do not read the provider'); } },
            },
        } as unknown as PluginInvocationContext;
        await expect(createTriageSetFixPullRequestActionHandler()({
            v: 1, linked: true, entryRef: error, displayAtMark: display, fixPullRequest: issue, displayAtLink: display,
        }, context)).rejects.toMatchObject({ name: 'PluginError', code: 'triage_fix_pull_request_kind_invalid' });
        expect((await collections.userMarks.query({ index: CORPUS_USER_MARKS_INDEX_ID.byPinned, order: 'asc' })).rows).toHaveLength(0);
        expect(disposed).toBe(true);
    });

    it('preserves link and unlink intent when admitted source facts cannot be reached', async () => {
        const { collections } = createTestkitCorpusCollections();
        const context = {
            surface: 'agent',
            services: {
                storage: { account: { collection: () => collections.userMarks } },
                // The host descriptor-read boundary is unavailable, not evidence of a non-PR kind.
                targetedContributions: { observeForSelf: () => ({
                    readCurrent: async () => { throw new Error('Admitted source view unavailable'); },
                    dispose: () => {},
                }) },
            },
        } as unknown as PluginInvocationContext;
        const handler = createTriageSetFixPullRequestActionHandler();
        const input = { v: 1 as const, entryRef: error, displayAtMark: display, fixPullRequest: pr };
        await expect(handler({ ...input, linked: true, displayAtLink: display }, context)).resolves.toEqual({ v: 1, status: 'linked' });
        await expect(handler({ ...input, linked: false }, context)).resolves.toEqual({ v: 1, status: 'unlinked' });
    });

    it('reads a durable explicit choice as unknown when the admitted view is unavailable', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: 'a'.repeat(43), sourceQualifiedId: `${pr.source.pluginId}/${pr.source.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1000, configured: fixture.configuredInstance,
        }));
        await setTriageFixPullRequest({ v: 1, linked: true, entryRef: error, displayAtMark: display,
            fixPullRequest: pr, displayAtLink: display }, { collections, nowMs: () => 1000 });
        const context = {
            surface: 'agent',
            services: {
                storage: { account: { collection: (definition: PluginAccountCollectionDefinition) => (
                    definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID ? collections.sourceInstances
                        : definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID ? collections.sessionLinks : collections.userMarks
                ) } },
                // Only the host's admitted-view read fails; durable Account storage stays reachable.
                targetedContributions: { observeForSelf: () => ({
                    readCurrent: async () => { throw new Error('Admitted source view unavailable'); },
                    dispose: () => {},
                }) },
                actions: { executeAdmittedTargetedOperation: async () => { throw new Error('Unavailable facts cannot authorize a provider read'); } },
            },
        } as unknown as PluginInvocationContext;
        const result = await createTriageReadFixPullRequestsActionHandler()({ v: 1, entryRef: error }, context);
        expect(result.primary).toMatchObject({ entryRef: pr, origins: ['user'], status: 'unknown', display });
        expect(result.candidates).toEqual([result.primary]);
    });
});
