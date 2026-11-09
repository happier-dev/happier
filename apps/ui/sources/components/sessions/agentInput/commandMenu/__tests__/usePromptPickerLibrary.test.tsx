import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPromptDocInLibrary, updatePromptDocInLibrary} from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema, buildPromptLibraryPhysicalKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// The picker reads the real foreground-acquisition graph after Home admission.
await import('@/sync/syncEngine');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { usePromptPickerLibrary } = await import('../usePromptPickerLibrary');

beforeEach(async () => { await harness.reset(); installHomeGovernanceBoundaries(harness); });
afterEach(() => {
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    vi.restoreAllMocks();
});

async function seed(organize = true) {
    const serverId = await harness.addHome({ name: 'Picker Home', serverUrl: 'https://picker-library.test', accountId: 'picker-account' });
    harness.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 2 }) });
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'folders', value: { v: 1,
        folders: [{ id: 'folder', name: 'Personal' }] } }] });
    harness.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { select: async () => ({ body: await (await catalog.handle(PROMPT_LIBRARY_ROWS_ROUTE_V1))!.json() }) });
    for (const key of PromptLibraryCatalogKeyV1Schema.options) {
        const path = `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/${key}`;
        harness.answer(serverId, `POST ${path}`, { select: async input => {
            const response = await catalog.handle(path, { method: 'POST', body: JSON.stringify(input) });
            return { status: response!.status, body: await response!.json() };
        } });
    }
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const created = await createPromptDocInLibrary({ store: createUiPromptLibraryArtifactStore(account.workflowArtifacts, account),
            request: { title: 'Testing', markdown: 'Test $ARGUMENTS', favorite: false,
                ...(organize ? { tags: ['debug'], folderId: 'folder' } : {}) } });
        harness.answer(serverId, '/v1/artifacts?limit=500', { body: harness.artifacts(serverId).list() });
        return { serverId, artifactId: created.artifactId, catalog };
    } finally { account.dispose(); }
}

describe('active prompt picker Account library', () => {
    it('shares the catalog read and shows usable prompts while retained Settings cleanup is pending', async () => {
        const { serverId, catalog } = await seed(false);
        resetPromptLibraryCatalogEngineForTests();
        resetPromptLibraryCatalogSnapshotsForTests();
        // Sign-in already hydrated Action policy; only the catalog's retained-source read is held.
        const { storage } = await import('@/sync/domains/state/storage');
        const previousScope = { settingsScope: storage.getState().settingsScope, profileScope: storage.getState().profileScope };
        storage.setState({ settingsScope: { serverId, accountId: 'picker-account' }, profileScope: { serverId, accountId: 'picker-account' } });
        const held = createDeferred<void>();
        harness.answer(serverId, '/v2/account/settings', {
            body: { version: 2, content: { t: 'plain', v: {} } }, respondAfter: held.promise,
        });
        const before = harness.requests.filter(request => request.path === PROMPT_LIBRARY_ROWS_ROUTE_V1).length;
        const hook = await renderHook(() => usePromptPickerLibrary(serverId));
        try {
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(hook.getCurrent().isLoading).toBe(false);
                expect(hook.getCurrent().documents).toHaveLength(1);
                expect(hook.getCurrent().folders).toMatchObject([{ id: 'folder', name: 'Personal' }]);
            });
            expect(harness.requests.filter(request => request.path === PROMPT_LIBRARY_ROWS_ROUTE_V1).length - before).toBe(1);
            publishHomeAccountChange(serverId, ['unrelated-session'], { changeKinds: ['session'] });
            await flushHookEffects();
            expect(harness.requests.filter(request => request.path === PROMPT_LIBRARY_ROWS_ROUTE_V1).length - before).toBe(1);
            const folders = catalog.read('folders');
            if (folders.key !== 'folders') throw new Error('Expected folder record');
            const updated = await catalog.handle(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/folders`, {
                method: 'POST', body: JSON.stringify({ expectedRevision: catalog.revision('folders'),
                    content: { t: 'plain', v: { ...folders, value: { ...folders.value,
                        folders: [{ id: 'folder', name: 'Updated personal' }] } } } }),
            });
            expect(await updated!.json()).toMatchObject({ status: 'updated' });
            publishHomeAccountChange(serverId, [buildPromptLibraryPhysicalKeyV1('folders')]);
            const account = await captureLazyActionAccountContext(serverId);
            try {
                const projection = await createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!.readCatalog();
                expect(readPromptLibraryCatalogRecordV1({ ...projection, key: 'folders' })).toMatchObject({
                    status: 'ready', record: { value: { folders: [{ id: 'folder', name: 'Updated personal' }] } },
                });
            } finally { account.dispose(); }
            expect(harness.requests.filter(request => request.path === PROMPT_LIBRARY_ROWS_ROUTE_V1).length - before).toBe(2);
        } finally {
            held.resolve();
            await hook.unmount();
            storage.setState(previousScope);
        }
    });

    it('loads headers through real Action admission, shares a pending body read and preserves favorite metadata', async () => {
        const { serverId, artifactId, catalog } = await seed();
        const hook = await renderHook(() => usePromptPickerLibrary(serverId));
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().isLoading).toBe(false); });
        expect(hook.getCurrent().error).toBe(false);
        expect(hook.getCurrent().documents).toMatchObject([{ artifactId, title: 'Testing', favorite: false,
            folderId: 'folder', tags: ['debug'] }]);
        const held = createDeferred<void>();
        harness.answer(serverId, `GET /v1/artifacts/${artifactId}`, { body: harness.artifacts(serverId).read(artifactId), respondAfter: held.promise });
        const preview = hook.getCurrent().read(artifactId);
        const insertion = hook.getCurrent().read(artifactId);
        expect(insertion).toBe(preview);
        held.resolve();
        await expect(preview).resolves.toBe('Test $ARGUMENTS');
        harness.answer(serverId, `GET /v1/artifacts/${artifactId}`, { select: () => ({ body: harness.artifacts(serverId).read(artifactId) }) });
        // Another editor commits newer body and organization after the picker took its snapshot.
        const editor = await captureLazyActionAccountContext(serverId);
        try {
            await updatePromptDocInLibrary({ store: createUiPromptLibraryArtifactStore(editor.workflowArtifacts, editor),
                request: { artifactId, title: 'Updated elsewhere', markdown: 'Newer body', folderId: null, tags: ['newer'] } });
        } finally { editor.dispose(); }
        await act(async () => { await hook.getCurrent().setFavorite(artifactId, true); });
        expect(hook.getCurrent().documents[0]?.favorite).toBe(true);
        const stored = harness.artifacts(serverId).read(artifactId)!;
        expect(decodePlainArtifactStoredContent(stored.header)).toMatchObject({ favorite: true, title: 'Updated elsewhere' });
        expect(decodePlainArtifactStoredContent(stored.header)).not.toHaveProperty('folderId');
        expect(decodePlainArtifactStoredContent(stored.header)).not.toHaveProperty('tags');
        expect(catalog.read('folders').value).toMatchObject({ artifactHeadersById: {
            [artifactId]: { folderId: null, tags: ['newer'] },
        } });
        expect(hook.getCurrent().documents[0]).toMatchObject({ folderId: 'folder', tags: ['debug'] });
        expect(harness.artifacts(serverId).readPlainBody(artifactId)).toContain('Newer body');
        await hook.unmount();
        await expect(hook.getCurrent().read(artifactId)).rejects.toThrow('prompt_picker_closed');
    });

    it('rejects a late read after the picker closes or the Account changes', async () => {
        const { serverId, artifactId } = await seed();
        const hook = await renderHook(() => usePromptPickerLibrary(serverId));
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().documents).toHaveLength(1); });
        const held = createDeferred<void>();
        harness.answer(serverId, `GET /v1/artifacts/${artifactId}`, { body: harness.artifacts(serverId).read(artifactId), respondAfter: held.promise });
        const pending = hook.getCurrent().read(artifactId);
        const rejected = expect(pending).rejects.toBeDefined();
        await act(async () => { await harness.switchAccount(serverId, 'other-account'); });
        expect(hook.getCurrent().documents).toEqual([]);
        await hook.unmount();
        held.resolve();
        await rejected;
    });

    it('retires an in-flight favourite before a delayed read can write or update the picker', async () => {
        const { serverId, artifactId } = await seed();
        const hook = await renderHook(() => usePromptPickerLibrary(serverId));
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().documents).toHaveLength(1); });
        const before = harness.artifacts(serverId).read(artifactId);
        const held = createDeferred<void>();
        harness.answer(serverId, `GET /v1/artifacts/${artifactId}`, { body: before, respondAfter: held.promise });
        const pending = hook.getCurrent().setFavorite(artifactId, true);
        const rejected = expect(pending).rejects.toBeDefined();
        await act(async () => { await harness.switchAccount(serverId, 'other-account'); });
        held.resolve();
        await rejected;
        expect(hook.getCurrent().documents).toEqual([]);
        expect(harness.artifacts(serverId).read(artifactId)).toEqual(before);
        await hook.unmount();
    });
});
