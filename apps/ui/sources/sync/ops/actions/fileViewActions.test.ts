import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ScopeActionOutputSchemas, type FileViewMode } from '@happier-dev/protocol/actions/scopeActionFamily';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { appPaneReduce, createAppPaneState } from '@/components/appShell/panes/model/appPaneReducer';
import { createWorkspaceFileDetailsTab } from '@/components/appShell/panes/details/fileDetailsTab';
import { buildWorkspaceFileViewPatch, readWorkspaceFileView } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileView';
import { invokeScopeAction, registerFileViewActionOwner } from './scopeActionFamily';

describe('File view Actions through executor and real pane state', () => {
    it('retains selected Edit beside its draft when View and Changes are selected in between', () => {
        const draft = { accountId: 'account', isEditingFile: true, editorOriginalHash: 'saved', editorText: 'unsaved draft' };
        const scopeId = 'project:edit-selection';
        const tabId = 'file:src/a.ts';
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 1 }), {
            type: 'openDetailsTab', scopeId, tab: createWorkspaceFileDetailsTab('src/a.ts'), openAs: 'pinned',
        });
        state = appPaneReduce(state, { type: 'setDetailsTabState', scopeId, tabKey: tabId, nextState: draft });
        for (const mode of ['edit', 'file', 'diff', 'edit'] as const) {
            state = appPaneReduce(state, { type: 'patchDetailsTabState', scopeId, tabKey: tabId,
                patch: buildWorkspaceFileViewPatch(state.scopes[scopeId].details.tabState[tabId], { mode }) });
            expect(readWorkspaceFileView(state.scopes[scopeId].details.tabState[tabId]).mode).toBe(mode);
            expect(state.scopes[scopeId].details.tabState[tabId]).toMatchObject(draft);
        }
    });

    it('waits for the mounted view owner to finish flushing before returning its selection result', async () => {
        const cleanup = registerFileViewActionOwner('async-file-view', () => ({
            tabId: 'file:pending.ts', active: true, serverId: 'home', accountId: 'account', mode: 'edit',
            blame: false, availableModes: ['view', 'edit'], blameAvailable: false, changesScopeAvailable: false,
            set: async () => false,
        }));
        try {
            expect(await invokeScopeAction('file.view.set', { mode: 'view' })).toMatchObject({
                ok: false, errorCode: 'client_control_unavailable',
            });
        } finally { cleanup(); }
    });

    it('patches scope/blame beside a retained draft and admits offline editing until a non-connectivity restriction applies', async () => {
        const scopeId = 'project:files';
        const tabId = 'file:src/a.ts';
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 1 }), {
            type: 'openDetailsTab', scopeId, tab: createWorkspaceFileDetailsTab('src/a.ts'), openAs: 'pinned',
        });
        const draft = { accountId: 'account', isEditingFile: true, editorText: 'draft', editorOriginalText: 'saved' };
        state = appPaneReduce(state, { type: 'setDetailsTabState', scopeId, tabKey: tabId, nextState: draft });
        let mode: FileViewMode = 'view';
        let availableModes: readonly FileViewMode[] = ['view', 'changes', 'edit'];
        const cleanup = registerFileViewActionOwner(`${scopeId}:${tabId}`, () => {
            const view = readWorkspaceFileView(state.scopes[scopeId].details.tabState[tabId]);
            return { tabId, active: true, serverId: 'home', accountId: 'account', mode,
                blame: view.blame ?? false, changesScope: view.changesScope, availableModes,
                blameAvailable: true, changesScopeAvailable: true,
                set(patch) {
                    if (patch.mode) mode = patch.mode;
                    const { mode: _mode, ...viewPatch } = patch;
                    state = appPaneReduce(state, { type: 'patchDetailsTabState', scopeId, tabKey: tabId,
                        patch: buildWorkspaceFileViewPatch(state.scopes[scopeId].details.tabState[tabId], viewPatch) });
                    return true;
                },
            };
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ scopeAction: ({ actionId, input }) => invokeScopeAction(actionId, input) }));
        try {
            expect(await executor.execute('file.view.set', { mode: 'edit', changesScope: { kind: 'turn', turnId: 'turn-a' }, blame: true }, { surface: 'ui' }))
                .toEqual({ ok: true, result: { ok: true } });
            expect(state.scopes[scopeId].details.tabState[tabId]).toMatchObject({ ...draft, view: { blame: true, changesScope: { kind: 'turn', turnId: 'turn-a' } } });
            const result = await executor.execute('file.view.get', {}, { surface: 'agent' });
            expect(result).toMatchObject({ ok: true, result: { tabId, mode: 'edit', blame: true, changesScope: { kind: 'turn', turnId: 'turn-a' } } });
            if (result.ok) expect(ScopeActionOutputSchemas['file.view.get'].safeParse(result.result).success).toBe(true);
            availableModes = ['view', 'changes']; // A partial/binary/unsupported body, never connectivity.
            expect(await executor.execute('file.view.set', { mode: 'edit' }, { surface: 'ui' }))
                .toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
            expect(await executor.execute('file.view.set', { changesScope: { kind: 'unknown' } }, { surface: 'ui' }))
                .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            expect(await invokeScopeAction('file.view.get', {}, { serverId: 'other-home' }))
                .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
        } finally { cleanup(); }
        expect(await invokeScopeAction('file.view.get', {})).toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
    });
});
