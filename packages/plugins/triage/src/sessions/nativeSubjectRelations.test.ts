import { describe, expect, it } from 'vitest';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../internalTasks/contribution.js';
import { createTestkitSourceSessionRelations } from './testkit/entrySessionTestkit.test-support.js';
import { CORPUS_SESSION_LINKS_INDEX_ID } from '../corpus/collections/ids.js';

const receipt: TriageEntryRefV1 = { source: { pluginId: 'happier.triage', localId: 'internal' },
    kindId: 'deployment-receipt', collisionScope: JSON.stringify(['home', 'environment']), entryId: 'receipt' };
const display = { locator: { v: 1 as const, displayPath: 'Deployment receipt' }, scopeLabel: 'Deployment' };

describe('native investigation relationships', () => {
    it.each(['plain', 'e2ee'] as const)('persists exact receipt work across owner recreation without inventory reads (%s)', async accountEncryptionMode => {
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode });
        let inventoryReads = 0;
        const linkQueries: Parameters<typeof collections.sessionLinks.query>[0][] = [];
        const measured = { ...collections, sessionLinks: { ...collections.sessionLinks,
            query: async (...args: Parameters<typeof collections.sessionLinks.query>) => {
                linkQueries.push(args[0]);
                return collections.sessionLinks.query(...args);
            } }, sourceInstances: { ...collections.sourceInstances,
            query: async (...args: Parameters<typeof collections.sourceInstances.query>) => {
                inventoryReads++;
                return collections.sourceInstances.query(...args);
            } } };
        const contributions = [{ contributor: { pluginId: 'happier.triage', contributionId: 'internal' },
            descriptor: INTERNAL_TASK_DESCRIPTOR_V1,
            operations: { linkSession: { role: 'task-write' }, readSessionLinks: { role: 'task-read' } } }];
        const owner = () => createTestkitSourceSessionRelations({ collections: measured, contributions });
        expect(await owner().write({ entryRef: receipt, display, sessionId: 'investigation', linked: true })).toMatchObject({ status: 'linked' });
        inventoryReads = 0;
        linkQueries.length = 0;
        const reopened = await owner().read({ entryRef: receipt });
        expect(reopened).toMatchObject({ kind: 'complete', links: [{ entryRef: receipt, sessionId: 'investigation' }] });
        expect(inventoryReads).toBe(0);
        expect(linkQueries).toHaveLength(1);
        expect(linkQueries[0]).toMatchObject({ index: CORPUS_SESSION_LINKS_INDEX_ID.byEntry, prefix: [expect.any(String)] });
        expect(await owner().write({ entryRef: receipt, display, sessionId: 'investigation', linked: true })).toMatchObject({ status: 'linked' });
        expect((await owner().read({ entryRef: receipt })).links).toEqual(reopened.links);
        expect((await owner().read({ entryRef: { ...receipt, entryId: 'another-receipt' } })).links).toEqual([]);
        expect((await owner().read({ entryRef: { ...receipt, collisionScope: JSON.stringify(['other-home', 'environment']) } })).links).toEqual([]);
    });
});
