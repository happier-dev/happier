import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPromptDocInLibrary, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
const { usePromptPickerLibrary } = await import('../usePromptPickerLibrary');

beforeEach(async () => { await harness.reset(); installHomeGovernanceBoundaries(harness); });
afterEach(() => { vi.restoreAllMocks(); });

async function seed() {
    const serverId = await harness.addHome({ name: 'Picker Home', serverUrl: 'https://picker-library.test', accountId: 'picker-account' });
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
            request: { title: 'Testing', markdown: 'Test $ARGUMENTS', favorite: false, tags: ['debug'], folderId: 'folder' } });
        harness.answer(serverId, '/v1/artifacts?limit=500', { body: harness.artifacts(serverId).list() });
        return { serverId, artifactId: created.artifactId, catalog };
    } finally { account.dispose(); }
}

describe('active prompt picker Account library', () => {
    it('loads headers, shares a highlighted pending body read with insertion and patches favorite without losing the body', async () => {
        const { serverId, artifactId, catalog } = await seed();
        const hook = await renderHook(() => usePromptPickerLibrary(serverId));
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().documents).toHaveLength(1); });
        const held = createDeferred<void>();
        harness.answer(serverId, `GET /v1/artifacts/${artifactId}`, { body: harness.artifacts(serverId).read(artifactId), respondAfter: held.promise });
        const preview = hook.getCurrent().read(artifactId);
        const insertion = hook.getCurrent().read(artifactId);
        expect(insertion).toBe(preview);
        held.resolve();
        await expect(preview).resolves.toBe('Test $ARGUMENTS');
        await act(async () => { await hook.getCurrent().setFavorite(artifactId, true); });
        expect(hook.getCurrent().documents[0]?.favorite).toBe(true);
        const stored = harness.artifacts(serverId).read(artifactId)!;
        expect(decodePlainArtifactStoredContent(stored.header)).toMatchObject({ favorite: true });
        expect(decodePlainArtifactStoredContent(stored.header)).not.toHaveProperty('folderId');
        expect(decodePlainArtifactStoredContent(stored.header)).not.toHaveProperty('tags');
        expect(catalog.read('folders').value).toMatchObject({ artifactHeadersById: {
            [artifactId]: { folderId: 'folder', tags: ['debug'] },
        } });
        expect(hook.getCurrent().documents[0]).toMatchObject({ folderId: 'folder', tags: ['debug'] });
        expect(harness.artifacts(serverId).readPlainBody(artifactId)).toContain('Test $ARGUMENTS');
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
});
