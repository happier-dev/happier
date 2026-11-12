import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { createTriageListEntriesDeps } from './listEntries.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { createTriageReobserveEntryActionHandler } from './reobserveEntry.js';

const fixture = createTriageSourceV1Fixture();
const facts = [
    { id: 'acme/updated', importance: 'secondary' as const, value: { kind: 'timestamp' as const, atMs: 1760000030000, format: 'relative' as const } },
    { id: 'acme/checks', importance: 'primary' as const, value: { kind: 'status' as const, value: 'Passing', tone: 'success' as const } },
];

describe('source fact admission across the host result boundary', () => {
    it.each(['page', 'complete'] as const)('refuses a whole 32-row %s when one snapshot repeats a fact id', async kind => {
        const { collections } = createTestkitCorpusCollections();
        const observations = Array.from({ length: 32 }, (_, index) => ({
            ...fixture.getResult, localRef: { ...fixture.getResult.localRef, entryId: 'LGQ-' + index },
            snapshot: { ...fixture.getResult.snapshot, facts },
        }));
        const valid = kind === 'page'
            ? { kind, observations, evidence: { kind: 'walkFinished' as const }, continuation: { v: 1 as const, token: 'next' } }
            : { kind, observations, evidence: { kind: 'walkFinished' as const } };
        let result = valid;
        // Only the host transport is replaced. This is the actual scan adapter
        // consumed by list/search, after JSON-rehydrated host structural parsing.
        const context = { services: {
            storage: { account: { collection: () => collections.sourceInstances } },
            actions: { executeAdmittedTargetedOperation: async () => result },
        } } as unknown as PluginInvocationContext;
        const deps = createTriageListEntriesDeps(context);
        const operation = {} as Parameters<typeof deps.executeScan>[0];
        expect(await deps.executeScan(operation, fixture.scanInput)).toBe(valid);
        expect(valid.observations).toHaveLength(32);
        for (const duplicate of [facts[0]!, { ...facts[0]!, label: 'Different label' }]) {
            result = { ...valid, observations: observations.map((row, index) => index === 31
                ? { ...row, snapshot: { ...row.snapshot, facts: [...facts, duplicate] } } : row) };
            await expect(deps.executeScan(operation, fixture.scanInput)).rejects.toMatchObject({
                data: { code: 'plugin_targeted_operation_result_invalid' },
            });
        }
    });

    it('refuses duplicate ids on exact get while accepting unique ids', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const source = fixture.detailInput.observation.entryRef.source;
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43),
            sourceQualifiedId: source.pluginId + '/' + source.localId,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1, configured: fixture.configuredInstance }));
        let duplicate = false;
        const context = { surface: 'cli', services: {
            storage: { account: { collection: () => collections.sourceInstances } },
            targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [{
                contributor: { pluginId: source.pluginId, contributionId: source.localId },
                descriptor: fixture.descriptor, operations: { get: {} },
            }] }), dispose: () => {} }) },
            actions: { executeAdmittedTargetedOperation: async () => ({ ...fixture.getResult,
                snapshot: { ...fixture.getResult.snapshot, facts: duplicate ? [...facts, facts[0]] : facts } }) },
        } } as unknown as PluginInvocationContext;
        const input = { entryRef: fixture.detailInput.observation.entryRef, sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId };
        const handler = createTriageReobserveEntryActionHandler();
        expect(await handler(input, context)).toMatchObject({ kind: 'observed' });
        duplicate = true;
        await expect(handler(input, context)).rejects.toMatchObject({ data: { code: 'plugin_targeted_operation_result_invalid' } });
    });
});

// Round C requires an inventory guard because these host-bound adapters do not
// share a loader. Domain behavior is asserted above, not inferred from imports.
it('routes every source scan/get host adapter through Triage fact admission', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const sites: string[] = [];
    function visit(directory: string): void {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) { visit(path); continue; }
            if (!entry.name.endsWith('.ts') || /test|test-support/u.test(entry.name)) continue;
            const source = readFileSync(path, 'utf8');
            for (const match of source.matchAll(/execute(?:Get|Scan): async[^]*?executeAdmittedTargetedOperation\([^;]*?\),/gu)) {
                sites.push(relative(root, path).replaceAll('\\', '/'));
                expect(match[0], path).toContain('admitSourceFacts(await');
            }
        }
    }
    visit(root);
    expect(sites.sort()).toEqual([
        'actions/fixPullRequests.ts', 'actions/listEntries.ts', 'actions/reobserveEntry.ts',
        'composer/attachmentRuntime.ts', 'workItems/runtime.ts',
    ]);
});
