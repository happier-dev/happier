import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
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
        const hook = await renderHook(() => usePromptLibraryEntryActions());
        let removed: boolean | undefined;
        await act(async () => { removed = await hook.getCurrent().remove('doc-1'); });
        expect(removed).toBe(false);
        expect(fixture.boundary.read('doc-1')).not.toBeNull();
        expect(catalog.read('folders')).toEqual(originalFolders);
        expect(catalog.requests).toEqual([]);
        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(modalAlert).toHaveBeenCalled();
    });

    it.each([
        { actionId: 'artifact.get', operation: 'remove' },
        { actionId: 'artifact.delete', operation: 'remove' },
        { actionId: 'artifact.export', operation: 'exportDocument' },
        { actionId: 'prompt_doc.create', operation: 'duplicate' },
    ] as const)('explains a refused $actionId without changing the saved prompt', async ({ actionId, operation }) => {
        const { fixture } = await createFailureFixture('DELETE');
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().setState(state => ({ settings: { ...state.settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { disabledSurfaces: ['ui'] } } }),
        } }));
        const hook = await renderHook(() => usePromptLibraryEntryActions());
        try {
            await act(async () => { await hook.getCurrent()[operation]('doc-1'); });
            expect(modalAlert).toHaveBeenCalledWith('common.error', 'actionConfirmations.turnedOffUnnamedMessage');
            expect(fixture.boundary.list().map(row => row.id)).toEqual(['doc-1']);
            expect(fixture.requests.some(request => request.method === 'DELETE')).toBe(false);
            expect(promptLibrarySettingsRouterPushSpy).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('stays on the editor and retains the original when the Home rejects creation of a copy', async () => {
        const { fixture, catalog } = await createFailureFixture('POST');
        const hook = await renderHook(() => usePromptLibraryEntryActions());
        await act(async () => { await hook.getCurrent().duplicate('doc-1'); });
        expect(fixture.boundary.list().map(row => row.id)).toEqual(['doc-1']);
        expect(catalog.requests).toEqual([]);
        expect(promptLibrarySettingsRouterPushSpy).not.toHaveBeenCalled();
        expect(modalAlert).toHaveBeenCalled();
    });

    it('does not delete or alert when the person cancels confirmation', async () => {
        const { fixture, catalog } = await createFailureFixture('DELETE');
        modalConfirm.mockResolvedValueOnce(false);
        const hook = await renderHook(() => usePromptLibraryEntryActions());
        let removed: boolean | undefined;
        await act(async () => { removed = await hook.getCurrent().remove('doc-1'); });
        expect(removed).toBe(false);
        expect(fixture.boundary.list().map(row => row.id)).toEqual(['doc-1']);
        expect(catalog.requests).toEqual([]);
        expect(modalAlert).not.toHaveBeenCalled();
    });

    it('retains the prompt while an explicit Ask-first delete awaits approval', async () => {
        const { fixture, catalog } = await createFailureFixture('DELETE');
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().setState(state => ({ settings: { ...state.settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'artifact.delete': { approvalRequiredSurfaces: ['ui'] },
            } }),
        } }));
        const hook = await renderHook(() => usePromptLibraryEntryActions());
        let result: Promise<boolean> | undefined;
        await act(async () => { result = hook.getCurrent().remove('doc-1'); });
        await waitForHomeGovernance(() => expect(fixture.boundary.list()).toHaveLength(2));
        const approval = fixture.boundary.list().find(row => row.id !== 'doc-1')!;
        expect(ApprovalRequestV2Schema.parse(JSON.parse(fixture.boundary.readPlainBody(approval.id)!)))
            .toMatchObject({ actionId: 'artifact.delete', status: 'open' });
        expect(modalConfirm).not.toHaveBeenCalled();
        expect(fixture.boundary.read('doc-1')).not.toBeNull();
        expect(fixture.requests.some(request => request.method === 'DELETE')).toBe(false);
        expect(catalog.requests).toEqual([]);
        await hook.unmount();
        await result;
    });
});
