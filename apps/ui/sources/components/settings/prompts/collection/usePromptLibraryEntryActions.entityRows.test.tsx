import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createArtifactStoreBoundary, createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1,
    ProfileRowMutationV1Schema, type ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { installPromptLibrarySettingsCommonModuleMocks, promptLibrarySettingsRouterPushSpy } from '../promptLibrarySettingsTestHelpers';
import { promptCollectionItemHref } from './promptCollectionRoutes';
import { withUiPromptLibraryArtifactReader } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { resolvePromptStackSystemAppendBlocksV1 } from '@/sync/ops/promptLibrary/resolvePromptStackSystemAppendBlocksV1';

installDisconnectedServerSocketBoundary();
installPromptLibrarySettingsCommonModuleMocks({ storage: importOriginal => importOriginal(),
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module });

const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { applyPromptLibraryCatalogSnapshot } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { usePromptLibraryEntryActions } = await import('./usePromptLibraryEntryActions');

describe('prompt deletion catalog mutation', () => {
    it('opens the acknowledged duplicate in its captured Home when personal placement loses CAS', async () => {
        await loadSyncSingletonForTests();
        promptLibrarySettingsRouterPushSpy.mockClear();
        const catalog = createPromptLibraryCatalogBoundary({ mutationOutcome: 'conflict', revision: 4,
            records: [{ key: 'folders', value: { v: 1, folders: [], artifactHeadersById: { source: { tags: ['personal'] } } } }],
        });
        const fixture = await createPlainArtifactHomeFixture('https://prompt-duplicate-row-receipt.test', { handleRequest: catalog.handle });
        onTestFinished(fixture.dispose);
        await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'source',
            header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Original' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'Retained copy content', createdAtMs: 1, updatedAtMs: 1 }) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) });
        const hook = await renderHook(() => usePromptLibraryEntryActions('doc'));
        await act(async () => { await hook.getCurrent().duplicate('source'); });
        expect(catalog.requests).toHaveLength(1);
        const copied = fixture.boundary.list().find(artifact => artifact.id !== 'source');
        expect(copied).toBeDefined();
        expect(JSON.parse(fixture.boundary.readPlainBody(copied!.id)!)).toMatchObject({ markdown: 'Retained copy content' });
        const folders = catalog.read('folders');
        if (folders.key !== 'folders') throw new Error('Wrong catalog');
        expect(folders.value.artifactHeadersById?.[copied!.id]).toBeUndefined();
        expect(promptLibrarySettingsRouterPushSpy).toHaveBeenCalledWith(
            promptCollectionItemHref('doc', copied!.id, { serverId: fixture.home.id }),
        );
        expect(fixture.boundary.list()).toHaveLength(2);
    });

    it.each(['updated', 'conflict', 'legacy-source'] as const)('deletes the reviewed Artifact without detaching required catalog or Profile references: %s', async outcome => {
        await loadSyncSingletonForTests();
        const initialState = storage.getState();
        onTestFinished(() => storage.setState(initialState, true));
        const artifactBoundary = createArtifactStoreBoundary({ ownerAccountId: () => 'alice', encryptionMode: 'plain' });
        let settingsWrites = 0;
        let rowWrites = 0;
        const rows: Array<{ record: PromptLibraryRecordV1; revision: number }> = [
            { record: { key: 'invocations', value: { v: 1, entries: [{ id: 'template', token: '/prompt', title: 'Prompt',
                target: { kind: 'doc', artifactId: 'doc-1' }, behavior: 'insert', allowArgs: false, availableIn: 'global' }] } }, revision: 4 },
            { record: { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [{ id: 'stack-entry',
                ref: { kind: 'doc', artifactId: 'doc-1' }, enabled: true, placement: 'system_append', required: true }] } }, revision: 5 },
            { record: { key: 'voice', value: { v: 1, scope: { kind: 'voice' }, entries: [] } }, revision: 6 },
            { record: { key: 'external-links', value: { v: 1, links: [{ id: 'export-link', artifactId: 'doc-1',
                assetTypeId: 'claude.instructions', machineId: 'machine-1', scope: 'user', externalRef: { path: '/instructions.md' } }] } }, revision: 7 },
        ];
        const tombstones = PromptLibraryCatalogKeyV1Schema.options.filter(key => !rows.some(row => row.record.key === key))
            .map(key => ({ key, revision: 1 }));
        let profileRevision = 8;
        let profileRecord: ProfileRecordV1 = { v: 1, id: 'profile-one', enabled: false, secretBindings: {},
            definition: { kind: 'legacy', profile: AIBackendProfileSchema.parse({ id: 'profile-one', name: 'Profile One' }) },
            promptStack: [{ id: 'profile-entry', ref: { kind: 'doc', artifactId: 'doc-1' }, enabled: true,
                placement: 'system_append', required: true }] };
        const originalDefinition = profileRecord.definition;
        const originalRows = structuredClone(rows);
        const originalProfile = structuredClone(profileRecord);
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://prompt-delete-row.test', accountId: 'alice',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') {
                    if (init?.method === 'POST') settingsWrites += 1;
                    return Response.json({ content: { t: 'plain', v: outcome === 'legacy-source' ? { profiles: [] } : {} }, version: 7 });
                }
                if (path === '/v1/account/entity-rows/prompt-library') return Response.json({ status: 'listed',
                    rows: [...rows.map(row => ({ key: row.record.key, revision: row.revision, content: { t: 'plain', v: row.record } })),
                        ...tombstones.map(row => ({ ...row, content: null }))] });
                if (path.startsWith('/v1/account/entity-rows/prompt-library/') && init?.method === 'POST') {
                    rowWrites += 1;
                    const input = PromptLibraryRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    const row = rows.find(row => path.endsWith(`/${row.record.key}`));
                    if (!row || input.content?.t !== 'plain') throw new Error('Unexpected catalog mutation');
                    expect(input.expectedRevision).toBe(row.revision);
                    if (outcome === 'conflict') return Response.json({ status: 'conflict', revision: row.revision + 1 });
                    row.record = input.content.v;
                    return Response.json({ status: 'updated', revision: ++row.revision, cursor: row.revision });
                }
                if (path === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [{ id: profileRecord.id,
                    revision: profileRevision, content: { t: 'plain', v: profileRecord } }],
                    nextCursor: null, complete: true, referenceGuardRevision: 'absent', transferControl: { status: 'absent' }, diagnostics: [] });
                if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 'absent' });
                if (path === PROFILE_TRANSFER_ROUTE_V1 && init?.method !== 'POST') return Response.json({ status: 'absent' });
                if (path === `${PROFILE_RECORDS_ROUTE_V1}/${profileRecord.id}` && init?.method === 'POST') {
                    const input = ProfileRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    expect(input).toMatchObject({ expectedRevision: profileRevision, operation: 'update' });
                    if (input.content?.t !== 'plain') throw new Error('Unexpected Profile content');
                    profileRecord = input.content.v;
                    return Response.json({ status: 'updated', revision: ++profileRevision, cursor: profileRevision });
                }
                return await artifactBoundary.handle(path, init) ?? new Response(null, { status: 404 });
            } });
        onTestFinished(connection.dispose);
        await artifactBoundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'doc-1',
            header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Prompt' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'prompt', createdAtMs: 1, updatedAtMs: 1 }) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
        const scope = { serverId: connection.home.id, accountId: 'alice' };
        storage.setState({ settings: settingsDefaults, settingsScope: scope, profileScope: scope, settingsVersion: 7 });
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows, tombstones, diagnostics: [] },
            rawSettings: {}, sourceSettingsVersion: 7 }, true);
        const hook = await renderHook(() => usePromptLibraryEntryActions('doc'));
        let removed: boolean | undefined;
        await act(async () => { removed = await hook.getCurrent().remove('doc-1'); });
        expect(artifactBoundary.read('doc-1')).toBeNull();
        expect(removed).toBe(true);
        expect(rows).toEqual(originalRows);
        expect(profileRecord).toEqual(originalProfile);
        expect(profileRecord.definition).toEqual(originalDefinition);
        expect(profileRevision).toBe(8);
        expect(rowWrites).toBe(0);
        const coding = rows.find(row => row.record.key === 'coding')?.record;
        if (!coding || coding.key !== 'coding') throw new Error('Missing required coding reference');
        await expect(withUiPromptLibraryArtifactReader(reader => resolvePromptStackSystemAppendBlocksV1({
            surface: 'coding', scope, accountEntries: coding.value.entries, ...reader,
        }), { serverId: scope.serverId })).rejects.toMatchObject({ code: 'attachment_unavailable', reason: 'not_found' });
        expect(settingsWrites).toBe(0);
        expect(storage.getState().settingsVersion).toBe(7);
    });
});
