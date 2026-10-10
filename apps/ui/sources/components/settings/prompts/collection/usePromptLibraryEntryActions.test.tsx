import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { installPromptLibrarySettingsCommonModuleMocks, promptLibrarySettingsRouterPushSpy } from '../promptLibrarySettingsTestHelpers';

const modalConfirm = vi.hoisted(() => vi.fn(async () => true));
const modalAlert = vi.hoisted(() => vi.fn());
installDisconnectedServerSocketBoundary();
installPromptLibrarySettingsCommonModuleMocks({ storage: importOriginal => importOriginal(),
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        spies: { confirm: modalConfirm, alert: modalAlert },
    }).module });
const { usePromptLibraryEntryActions } = await import('./usePromptLibraryEntryActions');

async function createFailureFixture(failingMethod: 'DELETE' | 'POST') {
    await loadSyncSingletonForTests();
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'folders',
        value: { v: 1, folders: [], artifactHeadersById: { 'doc-1': { tags: ['personal'] } } } }], revision: 4 });
    let fail = false;
    const fixture = await createPlainArtifactHomeFixture(`https://prompt-action-${failingMethod.toLowerCase()}-failure.test`, {
        handleRequest: async (path, init) => {
            if (fail && path.startsWith('/v1/artifacts') && init?.method === failingMethod)
                return Response.json({ error: 'Artifact write failed' }, { status: 500 });
            return catalog.handle(path, init);
        },
    });
    onTestFinished(fixture.dispose);
    await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'doc-1',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Prompt' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'Retained prompt', createdAtMs: 1, updatedAtMs: 1 }) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) });
    fail = true;
    return { fixture, catalog };
}

// Successful deletion/reference preservation and duplicate/CAS adoption are
// covered through the real same owner in usePromptLibraryEntryActions.entityRows.
describe('prompt entry action failure and cancellation', () => {
    beforeEach(() => {
        modalConfirm.mockReset().mockResolvedValue(true);
        modalAlert.mockClear();
        promptLibrarySettingsRouterPushSpy.mockClear();
    });

    it('keeps the Artifact and personal references when the Home rejects deletion', async () => {
        const { fixture, catalog } = await createFailureFixture('DELETE');
        const originalFolders = structuredClone(catalog.read('folders'));
        const hook = await renderHook(() => usePromptLibraryEntryActions('doc'));
        let removed: boolean | undefined;
        await act(async () => { removed = await hook.getCurrent().remove('doc-1'); });
        expect(removed).toBe(false);
        expect(fixture.boundary.read('doc-1')).not.toBeNull();
        expect(catalog.read('folders')).toEqual(originalFolders);
        expect(catalog.requests).toEqual([]);
        expect(modalAlert).toHaveBeenCalled();
    });

    it('stays on the editor and retains the original when the Home rejects creation of a copy', async () => {
        const { fixture, catalog } = await createFailureFixture('POST');
        const hook = await renderHook(() => usePromptLibraryEntryActions('doc'));
        await act(async () => { await hook.getCurrent().duplicate('doc-1'); });
        expect(fixture.boundary.list().map(row => row.id)).toEqual(['doc-1']);
        expect(catalog.requests).toEqual([]);
        expect(promptLibrarySettingsRouterPushSpy).not.toHaveBeenCalled();
        expect(modalAlert).toHaveBeenCalled();
    });

    it('does not delete or alert when the person cancels confirmation', async () => {
        const { fixture, catalog } = await createFailureFixture('DELETE');
        modalConfirm.mockResolvedValueOnce(false);
        const hook = await renderHook(() => usePromptLibraryEntryActions('doc'));
        let removed: boolean | undefined;
        await act(async () => { removed = await hook.getCurrent().remove('doc-1'); });
        expect(removed).toBe(false);
        expect(fixture.boundary.list().map(row => row.id)).toEqual(['doc-1']);
        expect(catalog.requests).toEqual([]);
        expect(modalAlert).not.toHaveBeenCalled();
    });
});
