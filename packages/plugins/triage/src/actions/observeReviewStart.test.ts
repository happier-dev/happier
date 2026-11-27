import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { REVIEW_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { expect, it } from 'vitest';
import { TRIAGE_PLUGIN } from '../definition.js';
import {
    CORPUS_SESSION_LINKS_COLLECTION_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    CORPUS_USER_MARKS_COLLECTION_ID,
} from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { createTriageReadEntryDetailActionHandler } from './readEntryDetail.js';

it('links the first daemon Review, replaces it on the same head, and ignores a stale head', async () => {
    const fixture = createTriageSourceV1Fixture();
    const configured = fixture.configuredInstance;
    const entryRef = fixture.detailInput.observation.entryRef;
    const { collections, control } = createTestkitCorpusCollections();
    control.sourceInstances.seed(toCorpusStoredValue({
        instanceTag: `a${'0'.repeat(42)}`,
        sourceQualifiedId: `${entryRef.source.pluginId}/${entryRef.source.localId}`,
        configuredAtMs: 1,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configured,
    }));
    if (fixture.getResult.kind !== 'present') throw new Error('Expected a present PR fixture');
    const head = fixture.getResult.snapshot.reviewRevision?.headSha;
    if (!head) throw new Error('Expected a current PR head');
    const url = 'https://github.com/octo/repo/pull/17';
    const resolve = {};
    const get = {};
    // Substitute host storage and provider transport only. The registered hook,
    // configured-source Resolve, exact get qualification and detail read are live.
    const context = {
        surface: 'agent', invokedAtMs: 1, signal: new AbortController().signal,
        services: {
            storage: { account: { collection: (definition: { id: string }) => {
                if (definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID) return collections.sourceInstances;
                if (definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID) return collections.sessionLinks;
                if (definition.id === CORPUS_USER_MARKS_COLLECTION_ID) return collections.userMarks;
                throw new Error(`Unexpected Collection ${definition.id}`);
            } } },
            targetedContributions: { observeForSelf: () => ({
                readCurrent: async () => ({ contributions: [{
                    contributor: { pluginId: entryRef.source.pluginId, contributionId: entryRef.source.localId },
                    descriptor: fixture.descriptor, operations: { resolveResource: resolve, get },
                }] }),
                dispose() {},
            }) },
            actions: { async executeAdmittedTargetedOperation(operation: unknown, input: unknown) {
                if (operation === resolve) {
                    expect(input).toMatchObject({ resource: { kind: 'pullRequest', url }, instance: configured });
                    return { kind: 'resolved', localRef: fixture.getInput.localRef, locator: fixture.getInput.lastKnownLocator };
                }
                if (operation !== get) throw new Error('Expected the source’s exact get');
                expect(input).toMatchObject({ localRef: fixture.getInput.localRef, instance: configured });
                return fixture.getResult;
            } },
        },
    } as unknown as PluginInvocationContext;
    const plugin = await createPluginTestkit({ manifest: TRIAGE_PLUGIN.manifest, module: TRIAGE_PLUGIN });
    try {
        const read = () => createTriageReadEntryDetailActionHandler()({
            v: 1, entryRef, sourceInstanceId: configured.instance.sourceInstanceId,
        }, context);
        const observe = async (reviewId: string, headOid: string) => {
            for (const declaration of TRIAGE_PLUGIN.manifest.contributes.hooks ?? []) {
                if (declaration.on !== 'action.execute.after') continue;
                await plugin.registration('hooks', declaration.id)?.({
                    actionId: REVIEW_START_ACTION_ID_V1, input: {},
                    invocation: { surface: 'agent', caller: { kind: 'host' } },
                    timestampMs: 1,
                    outcome: { status: 'succeeded', result: {
                        reviewTarget: { locator: { providerId: 'github', repository: 'octo/repo', number: 17 }, url, headOid },
                        reviewRound: { reviewId, roundOrdinal: 1 },
                    } },
                }, context);
            }
        };
        expect(await read()).toMatchObject({ kind: 'read' });
        expect(await read()).not.toHaveProperty('admittedReview');
        await observe('first-review', head);
        expect(await read()).toMatchObject({ kind: 'read', admittedReview: { reviewId: 'first-review', roundOrdinal: 1 } });
        await observe('second-review', head);
        expect(await read()).toMatchObject({ kind: 'read', admittedReview: { reviewId: 'second-review', roundOrdinal: 1 } });
        await observe('stale-review', 'older-head');
        expect(await read()).toMatchObject({ kind: 'read', admittedReview: { reviewId: 'second-review', roundOrdinal: 1 } });
    } finally {
        await plugin.dispose();
    }
});
