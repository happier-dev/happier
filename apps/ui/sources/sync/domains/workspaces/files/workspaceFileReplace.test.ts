import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';
import { WorkspaceFilesReplaceActionInputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { DaemonWorkspaceFileReplacePreviewResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';

import { act, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { subscribeAcknowledgedWorkspaceFileWrites } from './workspaceFileAcknowledgements';
import type {
  WorkspaceReplaceMatcher,
  WorkspaceReplacePreviewFile,
} from './workspaceFileReplace';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { decideApprovalAsInbox, installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
// Load the real Action graph during collection, outside an individual operation's test deadline.
await import('@/sync/ops/actions/defaultActionExecutor');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { AppPaneProvider, useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
const { unsavedWorkspaceFilePaths, useDetailsTabUnsavedKeys } = await import('@/components/appShell/panes/details/workspace/detailsTabChrome');
const { buildProjectPaneScopeId } = await import('@/components/projects/detail/projectPaneScope');
const { useWorkspaceFileEditorState } = await import('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState');
const { useReplaceUndoOnClose } = await import('@/components/appShell/search/replace/useReplaceUndoOnClose');
const { PresentationNoticeHost } = await import('@/components/sessions/presentation/PresentationNoticeHost');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { readWorkspaceFileEditorDraft } = await import('@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorDraft');
const { storage } = await import('@/sync/domains/state/storage');
const {
  buildReplaceApplyFiles,
  buildReplacePreviewUnifiedDiff,
  previewReplacedLine,
  replaceFileSelection,
  replaceMatchKey,
  summarizeReplaceResults,
  useWorkspaceReplace,
} = await import('./workspaceFileReplace');

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
// Machine RPC and admitted Action HTTP are transport boundaries; internal logic stays real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: (input: unknown) => rpc.call(input),
  }),
);

const hash = (c: string) => c.repeat(64);
const matcher: WorkspaceReplaceMatcher = {
  query: 'useSettingsRouteKey',
  replacement: 'useSettingsModalKey',
  matchCase: false,
  regex: false,
};
const modal: WorkspaceReplacePreviewFile = {
  path: 'apps/ui/settings/SettingsModal.tsx',
  hash: hash('a'),
  matchCount: 3,
  matches: [
    {
      line: 5,
      column16: 10,
      length16: 19,
      text: "import { useSettingsRouteKey } from './useSettingsRouteKey';",
      replacedText:
        "import { useSettingsModalKey } from './useSettingsModalKey';",
      before: [
        "import { Modal } from './Modal';",
        "import { Body } from './Body';",
      ],
      after: ["import type { Route } from './routes';", 'const key = useSettingsRouteKey(route);'],
    },
    {
      line: 5,
      column16: 40,
      length16: 19,
      text: "import { useSettingsRouteKey } from './useSettingsRouteKey';",
      replacedText:
        "import { useSettingsModalKey } from './useSettingsModalKey';",
      before: [
        "import { Modal } from './Modal';",
        "import { Body } from './Body';",
      ],
      after: ["import type { Route } from './routes';", 'const key = useSettingsRouteKey(route);'],
    },
    {
      line: 7,
      column16: 13,
      length16: 19,
      text: 'const key = useSettingsRouteKey(route);',
      replacedText: 'const key = useSettingsModalKey(route);',
      before: ["import { useSettingsRouteKey } from './useSettingsRouteKey';", "import type { Route } from './routes';"],
      after: ['', 'return key;'],
    },
  ],
};
const doc: WorkspaceReplacePreviewFile = {
  path: 'docs/settings-modal.md',
  hash: hash('b'),
  matchCount: 1,
  matches: [
    {
      line: 2,
      column16: 5,
      length16: 19,
      text: 'Use useSettingsRouteKey here',
      replacedText: 'Use useSettingsModalKey here',
      before: ['# Modal'],
      after: [],
    },
  ],
};

function lifetime(serverId = 'home'): ServerAccountScopeLifetime {
  return {
    scope: { serverId, accountId: 'acct' },
    isCurrent: () => true,
    onRetire: () => ({ dispose: () => {} }),
  };
}

describe('replace review model', () => {
  it('derives the file checkbox from its matches and sends only the matches left selected', () => {
    const excluded = new Map([
      [modal.path, new Set([replaceMatchKey(modal.matches[1]!)])],
      [doc.path, new Set([replaceMatchKey(doc.matches[0]!)])],
    ]);
    expect(replaceFileSelection(modal, excluded)).toEqual({
      selected: 2,
      total: 3,
      state: 'some',
    });
    expect(replaceFileSelection(doc, excluded)).toEqual({
      selected: 0,
      total: 1,
      state: 'none',
    });
    const third: WorkspaceReplacePreviewFile = {
      ...doc,
      path: 'src/dirty.ts',
      hash: hash('c'),
    };
    expect(
      buildReplaceApplyFiles([modal, doc, third], excluded, ['src/dirty.ts']),
    ).toEqual([
      {
        path: modal.path,
        expectedHash: hash('a'),
        excludedMatches: [{ line: 5, column16: 40 }],
      },
    ]);
  });

  it('marks only the selected matches of a line as replaced', () => {
    const excluded = new Set([replaceMatchKey(modal.matches[1]!)]);
    expect(previewReplacedLine(modal, 5, matcher, excluded)).toBe(
      "import { useSettingsModalKey } from './useSettingsRouteKey';",
    );
    expect(previewReplacedLine(modal, 5, matcher, new Set())).toBe(
      "import { useSettingsModalKey } from './useSettingsModalKey';",
    );
  });

  it('builds a standard unified patch from the preview that the shared hunk parser reads, merging nearby matches', () => {
    const patch = buildReplacePreviewUnifiedDiff(
      modal,
      matcher,
      new Set([replaceMatchKey(modal.matches[1]!)]),
    );
    const hunks = parseUnifiedDiffHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 3, newStart: 3 });
    expect(
      hunks[0]!.lines
        .filter((line) => line.kind === 'remove')
        .map((line) => line.text),
    ).toEqual([modal.matches[0]!.text, modal.matches[2]!.text]);
    expect(
      hunks[0]!.lines
        .filter((line) => line.kind === 'add')
        .map((line) => line.text),
    ).toEqual([
      "import { useSettingsModalKey } from './useSettingsRouteKey';",
      'const key = useSettingsModalKey(route);',
    ]);
    // A file whose matches are all left out shows no change.
    expect(
      parseUnifiedDiffHunks(
        buildReplacePreviewUnifiedDiff(
          doc,
          matcher,
          new Set([replaceMatchKey(doc.matches[0]!)]),
        ),
      ),
    ).toHaveLength(0);
  });

  it('counts per-file outcomes for the result summary', () => {
    expect(
      summarizeReplaceResults([
        { path: 'a', status: 'replaced', matchCount: 2 },
        { path: 'b', status: 'replaced', matchCount: 1 },
        { path: 'c', status: 'changed' },
        { path: 'd', status: 'skipped', reason: 'unsaved' },
        { path: 'e', status: 'cancelled' },
      ]),
    ).toEqual({
      replacedFiles: 2,
      replacedMatches: 3,
      changed: 1,
      skipped: 1,
      failed: 0,
      cancelled: 1,
      restored: 0,
    });
  });
});

describe('useWorkspaceReplace', () => {
    const boundaryErrors: string[] = [];
    beforeEach(async () => {
        boundaryErrors.length = 0;
        await homes.reset(); rpc.call.mockReset();
        scope = { ...scope, serverId: await homes.addHome({ name: 'Replace Home', serverUrl: 'https://replace-review.test',
            serverIdentityId: 'srv_replace_review', accountId: 'acct', currentAccount: true, active: false }) };
        scope = { ...scope, serverId: resolveServerProfileScopeIdForIdentifier(scope.serverId) };
        account = lifetime(scope.serverId);
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://replace-review.test',
            serverIdentityId: 'srv_replace_review', accountId: 'acct', machineId: 'mac', actionId: 'workspace.files.replace', tokenEpoch: 0,
            execute: async (request, context) => {
                const { machineId, ...payload } = WorkspaceFilesReplaceActionInputSchema.parse(request);
                return rpc.call({ method: 'workspace.files.replace', machineId, payload, serverId: scope.serverId,
                    accountId: 'acct', signal: context.signal });
            },
        });
        homes.answer(scope.serverId, '/v1/machines', { body: [boundary.machine] });
        for (const path of ['/v1/machines/read-batch', '/v1/actions/workspace.files.replace/execution-authorization', '/v1/actions/workspace.files.replace']) {
            homes.answer(scope.serverId, path, { select: async (_body, request) => {
                const response = await boundary.handle(new URL(request.url), request.init).catch((error: unknown) => {
                    boundaryErrors.push(error instanceof Error ? error.message : String(error));
                    throw error;
                });
                if (!response) throw new Error('Unhandled replacement Action request');
                return { status: response.status, body: await response.json() };
            } });
        }
    });
    afterEach(async () => { standardCleanup(); await homes.reset(); });
    let scope = { serverId: 'home', machineId: 'mac', rootPath: '/repo' };
    const previewOk = { ok: true, files: [modal, doc], skipped: { notText: 1 }, hasMore: false, coverage: 'complete' };
    let account = lifetime();

    it('shows every unmodified target when an oversized apply reply is explicitly truncated', async () => {
        rpc.call.mockImplementation((request: { method: string }) => request.method === 'daemon.workspaceFiles.replace.preview.v1'
            ? previewOk : { ok: true, truncated: true,
                results: [{ path: modal.path, status: 'failed', reason: 'transport_ceiling' }] });
        const hook = await renderHook(() => useWorkspaceReplace({ scope, accountLifetime: account, matcher, unsavedPaths: [] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        await act(async () => { await hook.getCurrent().apply(); });
        expect(hook.getCurrent().results).toEqual([
            { path: modal.path, status: 'failed', reason: 'transport_ceiling' },
            { path: doc.path, status: 'failed', reason: 'transport_ceiling' },
        ]);
        expect(hook.getCurrent().canUndo).toBe(false);
    });

    it('keeps unapplied Undo receipts recoverable when the refusal reply is truncated', async () => {
        rpc.call.mockImplementation((request: { method: string; payload?: { operation?: { kind: string } } }) => {
            if (request.method === 'daemon.workspaceFiles.replace.preview.v1') return previewOk;
            if (request.payload?.operation?.kind === 'restore') return { ok: true, truncated: true, results: [] };
            return { ok: true, results: [{ path: doc.path, status: 'replaced', hash: hash('c'), matchCount: 1,
                edits: [{ startUtf16: 4, deleteLength: 19, insertText: 'useSettingsModalKey', originalText: 'useSettingsRouteKey' }] }] };
        });
        const hook = await renderHook(() => useWorkspaceReplace({ scope, accountLifetime: account, matcher, unsavedPaths: [] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        await act(async () => { hook.getCurrent().toggleFile(modal.path); });
        await act(async () => { await hook.getCurrent().apply(); });
        await act(async () => { expect(await hook.getCurrent().undo()).toMatchObject({ restored: 0, changed: 0, error: 'failed' }); });
        expect(hook.getCurrent().canUndo).toBe(true);
        expect(hook.getCurrent().results).toMatchObject([{ path: doc.path, status: 'replaced', hash: hash('c') }]);
    });

    it('refuses the whole reviewed edit set when a real editor becomes dirty after preview, before its text debounce', async () => {
        const workspaceRefs = [{ id: 'replace-dirty-workspace', serverId: scope.serverId,
            machineId: scope.machineId, rootPath: scope.rootPath, label: 'Replace draft', createdAtMs: 1 }];
        rpc.call.mockImplementation((request: { method: string }) => request.method === 'daemon.workspaceFiles.replace.preview.v1'
            ? previewOk : { ok: true,
                results: [{ path: modal.path, status: 'replaced', hash: hash('d'), matchCount: 3, edits: [] }] });
        const tab = createWorkspaceFileDetailsTab(`${scope.rootPath}/${doc.path}`);
        const hook = await renderHook(() => {
            const context = useAppPaneContext();
            const pane = useAppPaneScope(buildProjectPaneScopeId('replace-dirty-workspace', scope.serverId, 'retained-editor'));
            const { chromeFor, unsavedKeys } = useDetailsTabUnsavedKeys(pane.pinDetailsTab);
            const chrome = chromeFor(tab.key);
            const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
            const persistDraft = React.useCallback((draft: Parameters<typeof useWorkspaceFileEditorState>[0]['persistedDraft']) => {
                pane.patchDetailsTabState(tab.key, draft ?? { accountId: null, isEditingFile: false,
                    editorOriginalHash: undefined, editorText: undefined });
            }, [pane.patchDetailsTabState]);
            const editor = useWorkspaceFileEditorState({ scope, accountId: 'acct', filePath: doc.path, displayMode: 'file',
                fileText: 'Use useSettingsRouteKey here', fileHash: hash('b'), fileWriteSupported: true,
                setFileWriteSupported: () => {}, fileEditorFeatureEnabled: true, filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true, filesEditorAutoSave: false, filesEditorChangeDebounceMs: 60_000,
                mountedRef: { current: true }, refreshAll: async () => {}, persistDraft,
                persistedDraft: readWorkspaceFileEditorDraft(pane.scopeState?.details.tabState[tab.key], 'acct') });
            React.useEffect(() => chrome.setUnsaved(editor.editorDirty), [chrome, editor.editorDirty]);
            const unsavedPaths = unsavedWorkspaceFilePaths({ accountId: 'acct', workspaceScope: scope,
                paneScopes: context.state.scopes, workspaceRefs, sessionState: storage.getState() });
            const replace = useWorkspaceReplace({ scope, accountLifetime: binding ?? null, matcher, unsavedPaths });
            return { editor, replace, pane, unsaved: unsavedKeys.has(tab.key) };
        }, { wrapper: ({ children }: React.PropsWithChildren) => React.createElement(AppPaneProvider, null, children) });
        await React.act(async () => { hook.getCurrent().pane.openDetailsTab(tab, { intent: 'pinned' }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().replace.canApply).toBe(true));
        await React.act(async () => {
            hook.getCurrent().editor.startEditingFile();
            // Consume the editor's two existing immediate publications, then
            // return to clean before a fresh dirty transition is debounced.
            hook.getCurrent().editor.onEditorChange('temporary edit');
            hook.getCurrent().editor.onEditorChange('Use useSettingsRouteKey here');
        });
        expect(hook.getCurrent().editor.editorDirty).toBe(false);
        await React.act(async () => {
            hook.getCurrent().editor.onEditorChange('Use useSettingsRouteKey here\nunsaved');
        });
        expect(hook.getCurrent().unsaved).toBe(true);
        expect(readWorkspaceFileEditorDraft(hook.getCurrent().pane.scopeState?.details.tabState[tab.key], 'acct'))
            .toMatchObject({ isEditingFile: true, editorText: 'Use useSettingsRouteKey here\nunsaved' });
        expect(hook.getCurrent().replace.unsavedFiles.map(file => file.path)).toEqual([doc.path]);
        await React.act(async () => { await hook.getCurrent().replace.apply(); });
        expect(homes.requestsFor('/v1/actions/workspace.files.replace').map(request => request.path)).toEqual([]);
        expect(rpc.call.mock.calls.filter(([request]) => request.payload?.operation?.kind === 'replace')).toEqual([]);
        expect(hook.getCurrent().replace).toMatchObject({ results: null, error: 'failed', applyError: null, applying: false, canApply: false });
        expect(hook.getCurrent().editor.getEditorText()).toContain('unsaved');
        await act(async () => { hook.getCurrent().replace.retry(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().replace.canApply).toBe(true));
        await act(async () => { await hook.getCurrent().replace.apply(); });
        expect(rpc.call.mock.lastCall?.[0], JSON.stringify(boundaryErrors)).toMatchObject({ payload: { operation: {
            files: [{ path: modal.path, expectedHash: modal.hash }],
        } } });
        expect(hook.getCurrent().replace.results?.map(result => [result.path, result.status]))
            .toEqual([[modal.path, 'replaced'], [doc.path, 'skipped']]);
        expect(hook.getCurrent().editor.getEditorText()).toContain('unsaved');
    });

    it('does not invalidate the reviewed selection when only a deselected target becomes dirty', async () => {
        rpc.call.mockResolvedValueOnce(previewOk).mockResolvedValueOnce({ ok: true,
            results: [{ path: modal.path, status: 'replaced', hash: hash('d'), matchCount: 3, edits: [] }] });
        const initialProps: { unsavedPaths: readonly string[] } = { unsavedPaths: [] };
        const hook = await renderHook((props: { unsavedPaths: readonly string[] }) => useWorkspaceReplace({
            scope, accountLifetime: account, matcher, unsavedPaths: props.unsavedPaths,
        }), { initialProps });
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        await act(async () => { hook.getCurrent().toggleFile(doc.path); });
        await hook.rerender({ unsavedPaths: [`${scope.rootPath}/${doc.path}`] });
        await act(async () => { await hook.getCurrent().apply(); });
        expect(rpc.call.mock.lastCall?.[0], JSON.stringify(boundaryErrors)).toMatchObject({ payload: { operation: {
            files: [{ path: modal.path, expectedHash: modal.hash }],
        } } });
        expect(hook.getCurrent()).toMatchObject({ error: null, applyError: null });
        expect(hook.getCurrent().results?.[0]).toMatchObject({ path: modal.path, status: 'replaced' });
    });

    it.each(['query', 'folder', 'machine', 'disarm', 'close'] as const)('withdraws an abandoned preview approval on %s, without executing its stale read', async (change) => {
        await homes.requireUiApproval(scope.serverId, 'workspace.files.replace.preview');
        rpc.call.mockResolvedValue(previewOk);
        if (change === 'query') await installOwnMachineApprovalReplayBoundary({ harness: homes,
            serverId: scope.serverId, accountId: 'acct', machineId: 'mac', machineFilesystemEffects: {
                workspaceFilesReplacePreview: async ({ machineId, ...payload }) => rpc.call({ machineId, payload,
                    method: 'daemon.workspaceFiles.replace.preview.v1', serverId: scope.serverId, accountId: 'acct' }),
            } });
        const initialProps: { scope: typeof scope; matcher: WorkspaceReplaceMatcher | null } = { scope, matcher };
        const hook = await renderHook((props: { scope: typeof scope; matcher: WorkspaceReplaceMatcher | null }) => {
            const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
            return useWorkspaceReplace({ scope: binding ? { ...props.scope, serverId: binding.scope.serverId } : null,
                accountLifetime: binding ?? null, matcher: props.matcher, unsavedPaths: [] });
        },
        { initialProps });
        const artifacts = homes.artifacts(scope.serverId);
        await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(1));
        await flushHookEffects();
        expect(hook.getCurrent().approval, JSON.stringify({ error: hook.getCurrent().error, loading: hook.getCurrent().loading,
            artifact: JSON.parse(artifacts.readPlainBody(artifacts.list()[0]!.id)!) })).toMatchObject({ operation: 'preview' });
        const oldId = hook.getCurrent().approval!.request.artifactId;
        // Fresh prop objects do not represent a new user intent.
        await hook.rerender({ scope: { ...scope }, matcher: { ...matcher } });
        expect(artifacts.list()).toHaveLength(1);
        if (change === 'close') await hook.unmount();
        else await hook.rerender({
            scope: { ...scope, ...(change === 'folder' ? { rootPath: '/other' } : {}), ...(change === 'machine' ? { machineId: 'other' } : {}) },
            matcher: change === 'disarm' ? null : { ...matcher, ...(change === 'query' ? { query: 'nextQuery' } : {}) },
        });
        await flushHookEffects();
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(oldId)!)).status).toBe('canceled');
        await decideApprovalAsInbox(scope.serverId, oldId, 'approve');
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(oldId)!)).status).toBe('canceled');
        expect(rpc.call).not.toHaveBeenCalled();
        if (change === 'query') {
            await waitForHomeGovernance(() => expect(hook.getCurrent().approval?.request.artifactId).not.toBe(oldId));
            const newest = hook.getCurrent().approval!.request.artifactId;
            const decision = await decideApprovalAsInbox(scope.serverId, newest, 'approve');
            await act(async () => { publishHomeAccountChange(scope.serverId, [newest]); });
            await flushHookEffects();
            expect(hook.getCurrent(), JSON.stringify({ decision, artifact: JSON.parse(artifacts.readPlainBody(newest)!) }))
                .toMatchObject({ approval: null, canApply: true });
            expect(hook.getCurrent().preview?.matcher.query).toBe('nextQuery');
            expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(newest)!)))
                .toMatchObject({ status: 'executed', approval: { flow: 'deferred' }, execution: { ok: true, result: previewOk } });
            expect(rpc.call.mock.calls.map(([request]) => request.payload.query)).toEqual(['nextQuery']);
        }
    });

    it('withdraws a next-page preview approval when its review is superseded', async () => {
        rpc.call.mockResolvedValue(DaemonWorkspaceFileReplacePreviewResponseSchema.parse({
            ...previewOk, coverage: 'partial', hasMore: true, cursor: { path: doc.path },
        }));
        const hook = await renderHook((props: { matcher: WorkspaceReplaceMatcher }) => {
            const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
            return useWorkspaceReplace({ scope: binding ? { ...scope, serverId: binding.scope.serverId } : null,
                accountLifetime: binding ?? null, matcher: props.matcher, unsavedPaths: [] });
        }, { initialProps: { matcher } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().preview?.cursor).toEqual({ path: doc.path }));
        expect(hook.getCurrent().preview?.cursor).toEqual({ path: doc.path });
        await homes.requireUiApproval(scope.serverId, 'workspace.files.replace.preview');
        await act(async () => { hook.getCurrent().loadMore(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().approval?.operation).toBe('preview'));
        const artifacts = homes.artifacts(scope.serverId);
        const pageId = hook.getCurrent().approval!.request.artifactId;
        await hook.rerender({ matcher: { ...matcher, query: 'nextQuery' } });
        await flushHookEffects();
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(pageId)!)).status).toBe('canceled');
        expect(rpc.call.mock.calls.map(([request]) => request.payload.cursor)).toEqual([undefined]);
    });

    it('keeps a pending preview through availability refresh, while disarming new effects', async () => {
        await homes.requireUiApproval(scope.serverId, 'workspace.files.replace.preview');
        rpc.call.mockResolvedValue(previewOk);
        await installOwnMachineApprovalReplayBoundary({ harness: homes,
            serverId: scope.serverId, accountId: 'acct', machineId: 'mac', machineFilesystemEffects: {
                workspaceFilesReplacePreview: async ({ machineId, ...payload }) => rpc.call({ machineId, payload,
                    method: 'daemon.workspaceFiles.replace.preview.v1', serverId: scope.serverId, accountId: 'acct' }),
            } });
        const hook = await renderHook((props: { available: boolean }) => {
            const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
            return useWorkspaceReplace({ scope: binding ? { ...scope, serverId: binding.scope.serverId } : null,
                accountLifetime: binding ?? null, matcher, unsavedPaths: [], available: props.available });
        }, { initialProps: { available: true } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().approval?.operation).toBe('preview'));
        const artifacts = homes.artifacts(scope.serverId);
        const oldId = hook.getCurrent().approval!.request.artifactId;
        await hook.rerender({ available: false });
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ canApply: false, approval: { request: { artifactId: oldId } } });
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(oldId)!)).status).toBe('open');
        await hook.rerender({ available: true });
        expect(artifacts.list()).toHaveLength(1);
        expect(hook.getCurrent().approval?.request.artifactId).toBe(oldId);
        expect(rpc.call).not.toHaveBeenCalled();
        const decision = await decideApprovalAsInbox(scope.serverId, oldId, 'approve');
        await act(async () => { publishHomeAccountChange(scope.serverId, [oldId]); });
        await flushHookEffects();
        expect(hook.getCurrent().canApply, JSON.stringify({ decision, error: hook.getCurrent().error,
            artifact: JSON.parse(artifacts.readPlainBody(oldId)!) })).toBe(true);
    });

    it('never borrows replacement Account authority to settle or execute an abandoned preview', async () => {
        await homes.requireUiApproval(scope.serverId, 'workspace.files.replace.preview');
        rpc.call.mockResolvedValue(previewOk);
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
            const original = binding?.scope.accountId === 'acct' ? binding : null;
            return useWorkspaceReplace({ scope: original ? { ...scope, serverId: original.scope.serverId } : null,
                accountLifetime: original, matcher, unsavedPaths: [] });
        });
        await waitForHomeGovernance(() => expect(homes.artifacts(scope.serverId).list()).toHaveLength(1));
        await flushHookEffects();
        expect(hook.getCurrent().approval, JSON.stringify({ error: hook.getCurrent().error, loading: hook.getCurrent().loading,
            artifact: JSON.parse(homes.artifacts(scope.serverId).readPlainBody(homes.artifacts(scope.serverId).list()[0]!.id)!) })).toMatchObject({ operation: 'preview' });
        const oldId = hook.getCurrent().approval!.request.artifactId;
        await act(async () => { await homes.switchAccount(scope.serverId, 'replacement-account'); });
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ approval: null, canApply: false, preview: null });
        // Credential revocation forbids the old captured carrier's cancellation
        // CAS. Keeping the old row is not permission to borrow this new Account.
        expect(StoredApprovalRequestSchema.parse(JSON.parse(homes.artifacts(scope.serverId).readPlainBody(oldId)!)))
            .toMatchObject({ status: 'open', executionOriginV1: { accountId: 'acct' } });
        const decision = await decideApprovalAsInbox(scope.serverId, oldId, 'approve');
        expect(decision).not.toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(rpc.call).not.toHaveBeenCalled();
    });

    it('shows Retry for an initially offline preview and starts only its explicit current intent', async () => {
        rpc.call.mockResolvedValue(previewOk);
        const hook = await renderHook((props: { available: boolean }) => {
            const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
            return useWorkspaceReplace({ scope: binding ? { ...scope, serverId: binding.scope.serverId } : null,
                accountLifetime: binding ?? null, matcher, unsavedPaths: [], available: props.available });
        }, { initialProps: { available: false } });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ loading: false, error: 'unavailable' }));
        expect(rpc.call).not.toHaveBeenCalled();
        await hook.rerender({ available: true });
        expect(hook.getCurrent()).toMatchObject({ loading: false, error: 'unavailable', canApply: false });
        expect(rpc.call).not.toHaveBeenCalled();
        await act(async () => { hook.getCurrent().retry(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        expect(rpc.call.mock.calls.map(([request]) => request.payload.query)).toEqual([matcher.query]);
    });

    it.each(['folder', 'machine', 'account'] as const)('retains late Apply custody across a %s switch and restores only the original target', async (changed) => {
        let completeApply: (value: unknown) => void = () => {};
        const edits = [{ startUtf16: 4, deleteLength: 19, insertText: 'useSettingsModalKey', originalText: 'useSettingsRouteKey' }];
        rpc.call.mockImplementation((request: { method: string; payload?: { operation?: { kind: string } } }) => {
            if (request.method === 'daemon.workspaceFiles.replace.preview.v1') return previewOk;
            if (request.payload?.operation?.kind === 'restore')
                return { ok: true, results: [{ path: doc.path, status: 'restored', hash: hash('b') }] };
            if (request.payload?.operation?.kind === 'replace')
                return new Promise(resolve => { completeApply = resolve; });
            throw new Error(`Unexpected replacement transport method: ${request.method}`);
        });
        const hook = await renderHook((props: { scope: typeof scope; account: ServerAccountScopeLifetime }) => useWorkspaceReplace({
            scope: props.scope, accountLifetime: props.account, matcher, unsavedPaths: [],
        }), { initialProps: { scope, account } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        let applying: Promise<void> = Promise.resolve();
        await act(async () => { applying = hook.getCurrent().apply(); });
        const otherScope = changed === 'folder' ? { ...scope, rootPath: '/other' }
            : changed === 'machine' ? { ...scope, machineId: 'other' } : scope;
        const otherAccount = changed === 'account' ? { ...lifetime(), scope: { serverId: scope.serverId, accountId: 'other' } } : account;
        await hook.rerender({ scope: otherScope, account: otherAccount });
        await act(async () => {
            completeApply({ ok: true, results: [{ path: doc.path, status: 'replaced', hash: hash('e'), matchCount: 1, edits }] });
            await applying;
        });
        expect(hook.getCurrent().results).toBeNull();
        expect(hook.getCurrent().canUndo).toBe(false);
        if (changed === 'account') expect(hook.getCurrent().undoOnClose).toBeNull();
        else expect(hook.getCurrent().undoOnClose?.machineId).toBe('mac');
        await act(async () => { expect(await hook.getCurrent().undo()).toBeNull(); });
        // A foreign projected Account is rejected by Action admission before Machine RPC.
        // Neither it nor selecting another target may send the retained operation's Undo.
        expect(rpc.call.mock.calls.filter(([request]) => request.payload?.operation?.kind === 'restore')).toHaveLength(0);
        if (changed === 'account') expect(rpc.call).not.toHaveBeenCalledWith(expect.objectContaining({ accountId: 'other' }));
        await hook.rerender({ scope, account });
        expect(hook.getCurrent().results?.[0]?.status).toBe('replaced');
        expect(hook.getCurrent().canUndo).toBe(true);
        await act(async () => { await hook.getCurrent().undo(); });
        expect(rpc.call.mock.lastCall?.[0]).toMatchObject({ machineId: 'mac', serverId: scope.serverId, accountId: 'acct',
            payload: { rootPath: '/repo', operation: { kind: 'restore', files: [{ path: doc.path, expectedHash: hash('e'), edits }] } } });
        expect(hook.getCurrent().results?.[0]?.status).toBe('restored');
    });

    it('re-previews on every replacement change and holds apply until the preview matches what is typed', async () => {
        let resolveSecond: (value: unknown) => void = () => {};
        rpc.call.mockResolvedValueOnce(previewOk).mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
        const hook = await renderHook((props: { replacement: string }) => {
            const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
            return useWorkspaceReplace({ scope: binding ? { ...scope, serverId: binding.scope.serverId } : null,
                accountLifetime: binding ?? null, matcher: { ...matcher, replacement: props.replacement }, unsavedPaths: [] });
        }, { initialProps: { replacement: 'useSettingsModalKey' } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        expect(hook.getCurrent().preview?.files).toHaveLength(2);
        expect(hook.getCurrent().canApply).toBe(true);
        await hook.rerender({ replacement: 'useSettingsKey' });
        // The last preview stays readable while the new one loads; apply waits.
        expect(hook.getCurrent().preview?.files).toHaveLength(2);
        expect(hook.getCurrent().stale).toBe(true);
        expect(hook.getCurrent().canApply).toBe(false);
        await waitForHomeGovernance(() => expect(rpc.call).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'daemon.workspaceFiles.replace.preview.v1',
            payload: expect.objectContaining({ replacement: 'useSettingsKey', rootPath: '/repo' }) })));
        await act(async () => { resolveSecond(previewOk); });
        await flushHookEffects();
        expect(hook.getCurrent().stale).toBe(false);
        expect(hook.getCurrent().canApply).toBe(true);
    });

    it('keeps the created approval request instead of claiming an unknown write outcome, then settles the approved replace with Undo', async () => {
        rpc.call.mockResolvedValueOnce(previewOk);
        await homes.requireUiApproval(scope.serverId, 'workspace.files.replace');
        const edits = [{ startUtf16: 4, deleteLength: 19, insertText: 'useSettingsModalKey', originalText: 'useSettingsRouteKey' }];
        let effects = 0;
        await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId: scope.serverId, accountId: 'acct', machineId: 'mac',
            machineFilesystemEffects: { workspaceFilesReplace: async () => {
                effects++;
                return { ok: true, results: [{ path: doc.path, status: 'replaced', hash: hash('e'), matchCount: 1, edits }] };
            } } });
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
            return useWorkspaceReplace({ scope: binding ? { ...scope, serverId: binding.scope.serverId } : null,
                accountLifetime: binding ?? null, matcher, unsavedPaths: [] });
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        let applying: Promise<void> = Promise.resolve();
        await act(async () => { applying = hook.getCurrent().apply(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({
            applyError: null, results: null, canApply: false, canUndo: false,
            approval: { operation: 'replace', status: 'waiting', serverId: scope.serverId,
                request: { kind: 'approval_request_created', actionId: 'workspace.files.replace', artifactId: expect.any(String) } },
        }));
        expect(effects).toBe(0);
        const artifactId = hook.getCurrent().approval!.request.artifactId;
        expect(await decideApprovalAsInbox(scope.serverId, artifactId, 'approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
        await act(async () => { publishHomeAccountChange(scope.serverId, [artifactId]); });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ approval: null, applying: false }));
        await act(async () => { await applying; });
        expect(effects).toBe(1);
        expect(hook.getCurrent()).toMatchObject({ approval: null, applyError: null, canUndo: true });
        expect(hook.getCurrent().results?.map((entry) => [entry.path, entry.status])).toEqual([[doc.path, 'replaced']]);
    });

    it.each([
        { operation: 'replace', errorCode: 'target_unavailable', expectedError: 'unavailable' },
        { operation: 'restore', errorCode: 'target_unavailable', expectedError: 'unavailable' },
        { operation: 'replace', errorCode: 'action_outcome_unknown', expectedError: 'outcome_unknown' },
        { operation: 'restore', errorCode: 'action_outcome_unknown', expectedError: 'outcome_unknown' },
    ] as const)('settles approved $operation / $errorCode without inventing effect certainty', async ({ operation, errorCode, expectedError }) => {
        const edits = [{ startUtf16: 4, deleteLength: 19, insertText: 'useSettingsModalKey', originalText: 'useSettingsRouteKey' }];
        rpc.call.mockResolvedValueOnce(previewOk)
            .mockResolvedValueOnce({ ok: true, results: [{ path: doc.path, status: 'replaced', hash: hash('e'), matchCount: 1, edits }] });
        const hook = await renderHook(() => {
            // The mounted author needs the real credential lifetime, including
            // Home-profile promotion, rather than the pure model fixtures' fixed scope.
            const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
            return useWorkspaceReplace({ scope: binding ? { ...scope, serverId: binding.scope.serverId } : null,
                accountLifetime: binding ?? null, matcher, unsavedPaths: [] });
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        if (operation === 'restore') await act(async () => { await hook.getCurrent().apply(); });
        await homes.requireUiApproval(scope.serverId, 'workspace.files.replace');
        // The daemon is an external boundary. It can report a native pre-effect
        // refusal or lost confirmation; the approval lifecycle stays real.
        await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId: scope.serverId, accountId: 'acct', machineId: 'mac',
            machineFilesystemEffects: { workspaceFilesReplace: async () => ({
                ok: false, errorCode, error: errorCode,
            }) } });
        let completing: Promise<unknown> = Promise.resolve();
        await act(async () => { completing = operation === 'replace' ? hook.getCurrent().apply() : hook.getCurrent().undo(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().approval?.status).toBe('waiting'));
        const artifactId = hook.getCurrent().approval!.request.artifactId;
        expect(await decideApprovalAsInbox(scope.serverId, artifactId, 'approve')).toMatchObject({
            ok: true, result: { status: errorCode === 'action_outcome_unknown' ? 'outcome_unknown' : 'failed', execution: { ok: false, errorCode } },
        });
        await act(async () => { publishHomeAccountChange(scope.serverId, [artifactId]); });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ approval: null, applying: false, undoing: false }));
        await act(async () => { await completing; });
        expect(hook.getCurrent()).toMatchObject({ approval: null, applyError: expectedError });
        expect(hook.getCurrent().results).toEqual(operation === 'replace' ? null : [
            expect.objectContaining({ path: doc.path, status: 'replaced' }),
        ]);
        expect(hook.getCurrent().canUndo).toBe(operation === 'restore');
    });

    it('returns a declined replace to its review without claiming a write', async () => {
        rpc.call.mockResolvedValueOnce(previewOk);
        await homes.requireUiApproval(scope.serverId, 'workspace.files.replace');
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
            return useWorkspaceReplace({ scope: binding ? { ...scope, serverId: binding.scope.serverId } : null,
                accountLifetime: binding ?? null, matcher, unsavedPaths: [] });
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        let applying: Promise<void> = Promise.resolve();
        await act(async () => { applying = hook.getCurrent().apply(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().approval?.status).toBe('waiting'));
        const artifactId = hook.getCurrent().approval!.request.artifactId;
        await decideApprovalAsInbox(scope.serverId, artifactId, 'reject');
        await act(async () => { publishHomeAccountChange(scope.serverId, [artifactId]); });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ approval: null, applying: false }));
        await act(async () => { await applying; });
        expect(hook.getCurrent()).toMatchObject({ approval: null, results: null, applyError: 'declined', canApply: true });
        expect(rpc.call).toHaveBeenCalledTimes(1);
    });

    it('holds Apply after Review again until its same-query refresh settles', async () => {
        let completeRefresh: (value: unknown) => void = () => {};
        rpc.call.mockResolvedValueOnce(previewOk)
            .mockResolvedValueOnce({ ok: true, results: [{ path: doc.path, status: 'changed' }] })
            .mockImplementationOnce(() => new Promise(resolve => { completeRefresh = resolve; }));
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(scope.serverId);
            return useWorkspaceReplace({ scope: binding ? { ...scope, serverId: binding.scope.serverId } : null,
                accountLifetime: binding ?? null, matcher, unsavedPaths: [] });
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        await act(async () => { await hook.getCurrent().apply(); });
        await act(async () => { hook.getCurrent().resetResults(); });
        expect(hook.getCurrent().preview?.files).toHaveLength(2);
        expect(hook.getCurrent().loading).toBe(true);
        expect(hook.getCurrent().canApply).toBe(false);
        await act(async () => { await hook.getCurrent().apply(); });
        await waitForHomeGovernance(() => expect(rpc.call).toHaveBeenCalledTimes(3));
        await act(async () => { completeRefresh(previewOk); });
        await flushHookEffects();
        expect(hook.getCurrent().canApply).toBe(true);
    });

    it('retains preview approval from loading the next review page', async () => {
        rpc.call.mockResolvedValueOnce(DaemonWorkspaceFileReplacePreviewResponseSchema.parse({
            ...previewOk, coverage: 'partial', hasMore: true, cursor: { path: doc.path },
        }));
        const hook = await renderHook(() => useWorkspaceReplace({ scope, accountLifetime: account, matcher, unsavedPaths: [] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        expect(hook.getCurrent().preview).toMatchObject({ hasMore: true, cursor: { path: doc.path }, coverage: 'partial' });
        expect(hook.getCurrent().canApply).toBe(true);
        await homes.requireUiApproval(scope.serverId, 'workspace.files.replace.preview');
        await act(async () => { hook.getCurrent().loadMore(); });
        await waitForHomeGovernance(() => expect(homes.artifacts(scope.serverId).list()).toHaveLength(1));
        await waitForHomeGovernance(() => expect(hook.getCurrent().approval).toMatchObject({ operation: 'preview',
            request: { kind: 'approval_request_created', actionId: 'workspace.files.replace.preview' } }));
        expect(hook.getCurrent().canApply).toBe(false);
        expect(hook.getCurrent().preview?.files).toHaveLength(2);
        expect(rpc.call).toHaveBeenCalledTimes(1);
    });

    it('continues closed Replace Undo through its approval and retains the original target', async () => {
        retirePresentationNotice();
        const screen = await renderScreen(React.createElement(PresentationNoticeHost));
        const edits = [{ startUtf16: 4, deleteLength: 19, insertText: 'useSettingsModalKey', originalText: 'useSettingsRouteKey' }];
        rpc.call.mockResolvedValueOnce(previewOk)
            .mockResolvedValueOnce({ ok: true, results: [{ path: doc.path, status: 'replaced', hash: hash('e'), matchCount: 1, edits }] })
            .mockResolvedValueOnce({ ok: true, results: [{ path: doc.path, status: 'restored', hash: hash('b') }] });
        const hook = await renderHook(() => {
            const model = useWorkspaceReplace({ scope, accountLifetime: account, matcher, unsavedPaths: [] });
            useReplaceUndoOnClose(model, 'Machine');
            return model;
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        await act(async () => { await hook.getCurrent().apply(); });
        await homes.requireUiApproval(scope.serverId, 'workspace.files.replace');
        await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId: scope.serverId, accountId: 'acct', machineId: 'mac',
            machineFilesystemEffects: { workspaceFilesReplace: async input => rpc.call({ method: 'workspace.files.replace',
                machineId: 'mac', payload: input, serverId: scope.serverId, accountId: 'acct' }) } });
        await hook.unmount();
        await waitForHomeGovernance(() => expect(readPresentationNotice()?.undo).toBeDefined());
        await screen.pressByTestIdAsync('current-session-presentation-notice-undo');
        await waitForHomeGovernance(() => expect(readPresentationNotice()?.approval?.artifactId).toBeDefined());
        expect(screen.findByTestId('presentation-notice-approval')).not.toBeNull();
        const artifactId = readPresentationNotice()!.approval!.artifactId;
        expect(rpc.call).toHaveBeenCalledTimes(2);
        expect(await decideApprovalAsInbox(scope.serverId, artifactId, 'approve')).toMatchObject({ ok: true });
        await act(async () => { publishHomeAccountChange(scope.serverId, [artifactId]); });
        await waitForHomeGovernance(() => expect(rpc.call).toHaveBeenCalledTimes(3));
        const { t } = await import('@/text');
        await waitForHomeGovernance(() => expect(readPresentationNotice()?.message).toBe(t('universalSearch.replace.undoneTitle')));
        expect(rpc.call.mock.calls[2]![0]).toMatchObject({ payload: { rootPath: '/repo',
            operation: { kind: 'restore', files: [{ path: doc.path, expectedHash: hash('e'), edits }] } } });
        retirePresentationNotice();
    });

    it('retains original-target Undo approval while another folder is selected', async () => {
        const edits = [{ startUtf16: 4, deleteLength: 19, insertText: 'useSettingsModalKey', originalText: 'useSettingsRouteKey' }];
        rpc.call.mockResolvedValueOnce(previewOk)
            .mockResolvedValueOnce({ ok: true, results: [{ path: doc.path, status: 'replaced', hash: hash('e'), matchCount: 1, edits }] })
            .mockResolvedValueOnce(previewOk);
        const hook = await renderHook((props: { rootPath: string }) => useWorkspaceReplace({
            scope: { ...scope, rootPath: props.rootPath }, accountLifetime: account, matcher, unsavedPaths: [],
        }), { initialProps: { rootPath: '/repo' } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        await act(async () => { await hook.getCurrent().apply(); });
        await hook.rerender({ rootPath: '/other' });
        await homes.requireUiApproval(scope.serverId, 'workspace.files.replace');
        const offer = hook.getCurrent().undoOnClose;
        expect(offer).not.toBeNull();
        await act(async () => { expect(await offer?.run()).toMatchObject({ error: 'approval_required' }); });
        expect(hook.getCurrent().approval).toMatchObject({ operation: 'restore',
            request: { kind: 'approval_request_created', actionId: 'workspace.files.replace' } });
        const artifacts = homes.artifacts(scope.serverId);
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifacts.list()[0]!.id)!)))
            .toMatchObject({ actionArgs: { rootPath: '/repo', operation: { kind: 'restore' } } });
        expect(hook.getCurrent().undoOnClose).toBeNull();
        expect(rpc.call).toHaveBeenCalledTimes(3);
    });

    it('applies the reviewed selection, skips unsaved files, and undoes with the recorded edits', async ({ onTestFinished }) => {
        const acknowledged: Array<string | null> = [];
        const dispose = subscribeAcknowledgedWorkspaceFileWrites({ ...scope, accountId: 'acct' }, modal.path,
            write => { acknowledged.push(write.hash); });
        onTestFinished(dispose);
        const edits = [{ startUtf16: 9, deleteLength: 19, insertText: 'useSettingsModalKey', originalText: 'useSettingsRouteKey' }];
        rpc.call.mockResolvedValueOnce(previewOk)
            .mockResolvedValueOnce({ ok: true, results: [{ path: modal.path, status: 'replaced', hash: hash('d'), matchCount: 3, edits }] })
            .mockResolvedValueOnce({ ok: true, results: [{ path: modal.path, status: 'restored', hash: hash('a') }] })
            .mockResolvedValueOnce(previewOk);
        const hook = await renderHook((props: { unsavedPaths: readonly string[] }) => useWorkspaceReplace({
            scope, accountLifetime: account, matcher, unsavedPaths: props.unsavedPaths,
        }), { initialProps: { unsavedPaths: [doc.path] } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        expect(hook.getCurrent().canApply).toBe(true);
        expect(hook.getCurrent().unsavedFiles.map((file) => file.path)).toEqual([doc.path]);
        expect(hook.getCurrent().totals).toMatchObject({ selectedFiles: 1, selectedMatches: 3 });
        // Saving a previously excluded draft does not silently add an unreviewed target.
        await hook.rerender({ unsavedPaths: [] });
        expect(hook.getCurrent().totals).toMatchObject({ selectedFiles: 1, selectedMatches: 3 });
        await act(async () => { await hook.getCurrent().apply(); });
        expect(rpc.call.mock.calls[1]?.[0], JSON.stringify(boundaryErrors)).toMatchObject({ payload: { rootPath: '/repo',
            operation: { kind: 'replace', matcher, files: [{ path: modal.path, expectedHash: hash('a') }] } } });
        expect(hook.getCurrent().results?.map((entry) => [entry.path, entry.status])).toEqual([[modal.path, 'replaced'], [doc.path, 'skipped']]);
        expect(hook.getCurrent().canUndo).toBe(true);
        expect(acknowledged).toEqual([hash('d')]);
        await act(async () => { await hook.getCurrent().undo(); });
        expect(rpc.call.mock.calls[2]![0]).toMatchObject({ payload: { operation: { kind: 'restore', files: [{ path: modal.path, expectedHash: hash('d'), edits }] } } });
        expect(hook.getCurrent().results?.[0]?.status).toBe('restored');
        expect(hook.getCurrent().canUndo).toBe(false);
        expect(acknowledged).toEqual([hash('d'), hash('a')]);
        await act(async () => { hook.getCurrent().retry(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().totals.selectedFiles).toBe(2));
    });

    it('reports a file changed since the replace when Undo finds other bytes', async ({ onTestFinished }) => {
        const acknowledged: Array<string | null> = [];
        const dispose = subscribeAcknowledgedWorkspaceFileWrites({ ...scope, accountId: 'acct' }, modal.path,
            write => { acknowledged.push(write.hash); });
        onTestFinished(dispose);
        const edits = [{ startUtf16: 4, deleteLength: 19, insertText: 'useSettingsModalKey', originalText: 'useSettingsRouteKey' }];
        rpc.call.mockResolvedValueOnce(previewOk)
            .mockResolvedValueOnce({ ok: true, results: [{ path: doc.path, status: 'replaced', hash: hash('e'), matchCount: 1, edits },
                { path: modal.path, status: 'changed' }] })
            .mockResolvedValueOnce({ ok: true, results: [{ path: doc.path, status: 'changed' }] });
        const unsavedPaths: string[] = [];
        const hook = await renderHook(() => useWorkspaceReplace({ scope, accountLifetime: account, matcher, unsavedPaths }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().canApply).toBe(true));
        await act(async () => { await hook.getCurrent().apply(); });
        expect(summarizeReplaceResults(hook.getCurrent().results ?? [])).toMatchObject({ replacedFiles: 1, changed: 1 });
        await act(async () => { await hook.getCurrent().undo(doc.path); });
        expect(hook.getCurrent().results?.find((entry) => entry.path === doc.path)?.status).toBe('undoChanged');
        expect(acknowledged).toEqual([]);
    });
});
