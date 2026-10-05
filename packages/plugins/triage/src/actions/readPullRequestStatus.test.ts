import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriagePullRequestStatusResultV1Schema, type TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { createTriageReadPullRequestStatusActionHandler } from './readPullRequestStatus.js';

const fixture = createTriageSourceV1Fixture();
const status: TriagePullRequestStatusV1 = { kind: 'status', observedAtMs: 1000, checks: null, review: null, merge: null, branch: null, facts: [] };

async function boundary(options: Readonly<{ retired?: boolean; otherSource?: boolean; unsupported?: boolean; foreignCaller?: boolean; hostAgent?: boolean }> = {}) {
    const { collections, control } = createTestkitCorpusCollections();
    const configured = fixture.configuredInstance;
    control.sourceInstances.seed(toCorpusStoredValue({
        instanceTag: 'a'.repeat(43), sourceQualifiedId: `${configured.instance.source.pluginId}/${configured.instance.source.localId}`,
        lifecycle: options.retired ? CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired : CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1000,
        configured: options.otherSource ? { ...configured, instance: { ...configured.instance, source: { pluginId: 'happier.other.forge', localId: 'other' } } } : configured,
        ...(options.retired ? { retiredReason: 'userRemoved' } : {}),
    }));
    const requests: unknown[] = [];
    let disposed = false;
    // Host-stamped context, Account persistence, admission and dispatch are genuine system boundaries.
    const context = {
        surface: options.hostAgent ? 'agent' : 'plugin',
        ...(options.hostAgent ? {} : { caller: { kind: 'plugin', pluginId: options.foreignCaller ? 'happier.other.forge' : 'happier.triage' } }),
        services: {
            storage: { account: { collection: (definition: PluginAccountCollectionDefinition) => definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID ? collections.sourceInstances : collections.userMarks } },
            targetedContributions: { observeForSelf: () => ({
                readCurrent: async () => ({ contributions: [{
                    contributor: { pluginId: configured.instance.source.pluginId, contributionId: configured.instance.source.localId },
                    descriptor: fixture.descriptor,
                    operations: options.unsupported ? {} : { readPullRequestStatus: { handle: 'exact-admitted-status' } },
                }] }),
                dispose: () => { disposed = true; },
            }) },
            actions: { executeAdmittedTargetedOperation: async (operation: unknown, input: unknown) => { requests.push({ operation, input }); return status; } },
        },
    } as unknown as PluginInvocationContext;
    const result = TriagePullRequestStatusResultV1Schema.parse(await createTriageReadPullRequestStatusActionHandler()({
        v: 1, entryRef: fixture.detailInput.observation.entryRef,
        sourceInstanceId: configured.instance.sourceInstanceId, lastKnownLocator: fixture.getInput.lastKnownLocator,
    }, context));
    return { result, requests, disposed };
}

describe('the mounted PR-status action', () => {
    it.each([false, true])('uses one exact admitted source operation with the existing configured get input (host agent: %s)', async (hostAgent) => {
        const actual = await boundary({ hostAgent });
        expect(actual.result).toEqual(status);
        expect(actual.requests).toEqual([{ operation: { handle: 'exact-admitted-status' }, input: fixture.getInput }]);
        expect(actual.disposed).toBe(true);
    });
    it.each([{ retired: true }, { otherSource: true }, { unsupported: true }, { foreignCaller: true }])('refuses unavailable or foreign authority without provider dispatch: %j', async (options) => {
        const actual = await boundary(options);
        expect(actual.result.kind).toBe('unavailable');
        expect(actual.requests).toEqual([]);
    });
});
