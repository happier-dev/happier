import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createMachineFixture, createSessionFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import {
  cleanupWorkspaceFileDetailsActionBoundary,
  getWorkspaceFileDetailsActionBoundary,
  installWorkspaceFileDetailsActionBoundary,
  installWorkspaceFileDetailsCommonModuleMocks,
  prepareWorkspaceFileDetailsActionBoundary,
} from '../details/workspaceFileDetails/workspaceFileDetailsTestHelpers';
import type { UseFilePageCodeIntelligenceInput } from './useFilePageCodeIntelligence';
import type {
  LanguageIntelligenceSyncInput,
  LanguageIntelligenceSyncResult,
  LanguageIntelligenceQueryInput,
  LanguageIntelligenceQueryResult,
  LanguageIntelligenceWatchResult,
} from '@happier-dev/protocol/machines/languageIntelligence';
import type {
  CodeEditorLanguageIntelligence,
  EditorDecoration,
  TextEditorHandle,
} from '@/components/ui/code/editor/codeEditorTypes';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { applyWorkspaceFileTextEdits } from '@happier-dev/protocol/machines/workspaceFilesReplace';
import type { CodeLinesViewProps } from '@/components/ui/code/view/CodeLinesView';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';

const navigation = vi.hoisted(() => ({ push: vi.fn(), alert: vi.fn() }));

installWorkspaceFileDetailsCommonModuleMocks({
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: navigation.alert } }).module;
  },
});
installWorkspaceFileDetailsActionBoundary();
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: { push: navigation.push } }).module;
});
// Only the remote Machine is scripted; the page controller, holder and Search source remain real.
const machine = vi.hoisted(() => ({
  sync: vi.fn<
    typeof import('@/sync/ops/machineLanguageIntelligence').machineLanguageIntelligenceSync
  >(),
  query: vi.fn(),
  watch: vi.fn(),
  fallback: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
}));
vi.mock('@/sync/ops/machineLanguageIntelligence', () => ({
  machineLanguageIntelligenceSync: machine.sync,
  machineLanguageIntelligenceQuery: machine.query,
  machineLanguageIntelligenceWatch: machine.watch,
  machineCodeIntelligenceFallback: machine.fallback,
  machineLanguageIntelligenceRestartAction: async () => ({ status: 'ok' }),
  machineLanguageIntelligencePreviewAction: machine.preview,
  machineLanguageIntelligenceApplyAction: machine.apply,
}));

const { AppPaneProvider } =
  await import('@/components/appShell/panes/AppPaneProvider');
const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
const { resolveCompactAppDestinations, hrefForDestinationRef } =
  await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { useFilePageCodeIntelligence } =
  await import('./useFilePageCodeIntelligence');
const { CodeIntelligenceCard } = await import('./CodeIntelligenceCard');
const { createWorkspaceSymbolSearchSource } =
  await import('@/components/appShell/search/workspaceSymbolSearchSource');
const { useWorkspaceFileEditorState } =
  await import('../details/workspaceFileDetails/useWorkspaceFileEditorState');
const { useWorkspaceFileEditorCommands } =
  await import('../details/workspaceFileDetails/useWorkspaceFileEditorCommands');
const { useCodeIntelligencePaneProducer } =
  await import('./codeIntelligencePaneStore');
const { CodeIntelligencePaneTab } = await import('./CodeIntelligencePaneTab');
const { CodeReferencesList } = await import('./CodeReferencesList');
const { CodeProblemsList } = await import('./CodeProblemsList');
const { registerComposerPresentationTarget } =
  await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { storage } = await import('@/sync/domains/state/storage');
const { FileContentPanel } = await import('../file/FileContentPanel');
const { CodeLinesView } =
  await import('@/components/ui/code/view/CodeLinesView');
const { SurfaceFreshnessLine } =
  await import('@/components/ui/surfaces/SurfaceFreshnessLine');
const { loadAccountSettings, saveAccountSettings } =
  await import('@/sync/domains/state/accountSettingsPersistence');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { prepareSessionDraftPersistenceStorage } =
  await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { readNewSessionDraftFromRepository } =
  await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
const actionBoundary = getWorkspaceFileDetailsActionBoundary();
const scope = { serverId: '', machineId: 'm1', rootPath: '/repo' };
const server = {
  serverId: 'ts',
  label: 'TS',
  state: 'ready',
  loading: false,
  generation: 'g1',
} as const;
const defaultLiveValue = { get: () => 'const value = Promise.resolve(1);' };
function PageWrapper({ children }: React.PropsWithChildren) {
  return <AppPaneProvider>{children}</AppPaneProvider>;
}
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
let portal: ReturnType<typeof installReactDomPortalBoundaryForTests>;

function input(
  overrides: Partial<UseFilePageCodeIntelligenceInput> = {},
): UseFilePageCodeIntelligenceInput {
  return {
    scopeId: 'intelligence-page',
    scope,
    filePath: 'src/a.ts',
    language: 'typescript',
    enabled: true,
    active: true,
    liveValue: defaultLiveValue,
    getUnsaved: () => false,
    editorHandleRef: { current: null },
    sessionId: null,
    accountId: 'account-a',
    machineName: 'Machine',
    machineUnreachable: false,
    agentName: null,
    ...overrides,
  };
}

function useRetainedEditor(
  id: 'a' | 'b',
  text: string,
  focused: boolean,
  displayMode: 'file' | 'diff' = 'file',
  hash = `base-${id}`,
) {
  const mountedRef = React.useRef(true);
  React.useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  const editor = useWorkspaceFileEditorState({
    scope,
    accountId: 'account-a',
    filePath: `src/${id}.ts`,
    displayMode,
    fileText: text,
    fileHash: hash,
    fileWriteSupported: true,
    setFileWriteSupported() {},
    fileEditorFeatureEnabled: true,
    filesEditorWebMonacoEnabled: true,
    filesEditorNativeCodeMirrorEnabled: true,
    filesEditorAutoSave: false,
    filesEditorChangeDebounceMs: 0,
    mountedRef,
    refreshAll: async () => {},
  });
  useWorkspaceFileEditorCommands({
    editor,
    tabKey: `file:src/${id}.ts`,
    file: { scope, path: `src/${id}.ts` },
    serverId: scope.serverId,
    accountId: 'account-a',
    focused,
    onStart: editor.startEditingFile,
  });
  return editor;
}

describe('File-page intelligence composition', () => {
  beforeEach(async () => {
    browser = await installBrowserRuntimeForTests({
      url: 'https://intelligence.test',
    });
    portal = installReactDomPortalBoundaryForTests();
    scope.serverId = await prepareWorkspaceFileDetailsActionBoundary();
    machine.sync
      .mockReset()
      .mockResolvedValue({
        status: 'ok',
        generation: 'g1',
        version: 1,
        servers: [server],
      });
    machine.query.mockReset();
    machine.watch
      .mockReset()
      .mockImplementation(
        (_machine, _request, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener(
              'abort',
              () => reject(options.signal.reason),
              { once: true },
            ),
          ),
      );
    machine.fallback.mockReset();
    machine.preview.mockReset();
    machine.apply
      .mockReset()
      .mockResolvedValue({ ok: false, errorCode: 'stale_hash' });
    navigation.push.mockReset();
    navigation.alert.mockReset();
  });
  afterEach(async () => {
    await standardCleanup();
    await cleanupWorkspaceFileDetailsActionBoundary();
    portal.restore();
    browser.restore();
  });

  it('feeds a warmed View viewport through the same controller without starting intelligence on open', async () => {
    machine.sync.mockResolvedValue({
      status: 'ok',
      generation: 'g1',
      version: 1,
      servers: [server],
      capabilities: {
        hover: true,
        definition: false,
        references: false,
        documentSymbol: false,
        diagnostics: 'none',
        acceptsExternalChanges: false,
        semanticTokensRange: true,
      },
    });
    machine.query.mockImplementation(
      async (_machine, request: LanguageIntelligenceQueryInput) =>
        request.kind === 'semanticTokens'
          ? {
              status: 'ok',
              kind: 'semanticTokens',
              tokens: [
                {
                  serverId: 'ts',
                  legend: { tokenTypes: ['function'], tokenModifiers: [] },
                  data: [0, 6, 5, 0, 0],
                },
              ],
            }
          : { status: 'ok', kind: 'hover', sections: [] },
    );
    const hook = await renderHook(() => useFilePageCodeIntelligence(input()), {
      wrapper: PageWrapper,
    });
    const screen = await renderScreen(
      <FileContentPanel
        theme={createThemeFixture()}
        displayMode="file"
        sessionId=""
        filePath="src/a.ts"
        fileContent={defaultLiveValue.get()}
        language="typescript"
        selectedLineKeys={new Set()}
        lineSelectionEnabled={false}
        onToggleLine={() => {}}
        diffContent={null}
        intelligence={hook.getCurrent().viewBinding}
      />,
    );
    // The web list renders the real Legend backend; feed its visible rows through the shared list contract.
    const { VirtualizedList } = await import('@/components/ui/lists/virtualized');
    const list = screen.findAllByType(VirtualizedList)[0];
    await act(async () => {
      list.props.onViewableItemsChanged({ viewableItems: [{ index: 0 }] });
    });
    expect(machine.sync).not.toHaveBeenCalled();
    expect(machine.query).not.toHaveBeenCalled();
    await act(async () => {
      await hook.getCurrent().controller?.hover({ line: 0, character: 7 });
    });
    await vi.waitFor(() =>
      expect(
        machine.query.mock.calls.some(
          (call) => call[1].kind === 'semanticTokens',
        ),
      ).toBe(true),
    );
    const request = machine.query.mock.calls.find(
      (call) => call[1].kind === 'semanticTokens',
    )![1];
    expect(request.range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: defaultLiveValue.get().length },
    });
    const { CodeLineRow } =
      await import('@/components/ui/code/view/CodeLineRow');
    // The list keeps items virtual; consume its real row renderer.
    const renderedList = screen.findAllByType(VirtualizedList)[0];
    const row = await renderScreen(
      renderedList.props.renderItem({
        item: renderedList.props.data[0],
        index: 0,
      }),
    );
    expect(row.findAllByType(CodeLineRow)[0].props.semanticTokens).toEqual([
      { start: 6, end: 11, role: 'function' },
    ]);
  });

  it.each(['format', 'formatSelection', 'organizeImports'] as const)(
    'reviews outside-Edit %s through the existing Action and applies only reviewed bytes',
    async (command) => {
      const files = [
        {
          path: 'src/a.ts',
          expectedHash: 'a'.repeat(64),
          edits: [
            {
              range: {
                start: { line: 0, character: 5 },
                end: { line: 0, character: 5 },
              },
              text: ' ',
            },
          ],
        },
      ];
      machine.preview.mockResolvedValue({
        status: 'ok',
        kind:
          command === 'organizeImports'
            ? 'organizeImports'
            : command === 'formatSelection'
              ? 'rangeFormatting'
              : 'formatting',
        files,
      });
      const hook = await renderHook(
        () =>
          useFilePageCodeIntelligence(
            input({
              getReadSelectionRange: () => ({
                start: { line: 0, character: 6 },
                end: { line: 0, character: 11 },
              }),
            }),
          ),
        { wrapper: PageWrapper },
      );
      const layer = hook.getCurrent().editSetLayer;
      if (!layer) throw new Error('Expected the existing edit-set layer');
      const screen = await renderScreen(layer);
      const run = hook.getCurrent().menuCommands?.[`code.${command}`];
      expect(run).toBeTypeOf('function');
      await act(async () => {
        run?.();
      });
      await vi.waitFor(() =>
        expect(
          screen.findAllByTestId('code-edit-set-apply').length,
        ).toBeGreaterThan(0),
      );
      expect(machine.preview.mock.calls[0].slice(0, 3)).toEqual([
        'm1',
        command === 'organizeImports'
          ? 'code.imports.organize'
          : 'code.format.apply',
        {
          rootPath: '/repo',
          path: 'src/a.ts',
          languageId: 'typescript',
          operation: {
            kind: 'preview',
            ...(command === 'organizeImports'
              ? {}
              : {
                  formattingOptions: { tabSize: 2, insertSpaces: true },
                  ...(command === 'formatSelection'
                    ? {
                        range: {
                          start: { line: 0, character: 6 },
                          end: { line: 0, character: 11 },
                        },
                      }
                    : {}),
                }),
          },
        },
      ]);
      expect(machine.apply).not.toHaveBeenCalled();
      await act(async () => {
        screen.findAllByTestId('code-edit-set-cancel')[0].props.onPress();
      });
      expect(machine.apply).not.toHaveBeenCalled();
      await act(async () => {
        run?.();
      });
      await vi.waitFor(() =>
        expect(
          screen.findAllByTestId('code-edit-set-apply').length,
        ).toBeGreaterThan(0),
      );
      await act(async () => {
        screen.findAllByTestId('code-edit-set-apply')[0].props.onPress();
      });
      await vi.waitFor(() => expect(machine.apply).toHaveBeenCalledTimes(1));
      expect(machine.apply.mock.calls[0][1]).toMatchObject({
        operation: {
          kind: command === 'organizeImports' ? 'organizeImports' : 'format',
          files,
        },
      });
      // The Machine refused the stale hash; the review reports that failure instead of claiming a write.
      await vi.waitFor(() =>
        expect(
          screen.findAllByTestId('code-edit-set-note').length,
        ).toBeGreaterThan(0),
      );
    },
  );

  it('shows Edit startup and project-loading through the existing note, then clears it when ready without a symbol query', async () => {
    let finishOpen!: (result: LanguageIntelligenceSyncResult) => void;
    let deliverWatch!: (result: LanguageIntelligenceWatchResult) => void;
    machine.sync.mockImplementation((_machine, request) =>
      request.op.op === 'open'
        ? new Promise((resolve) => {
            finishOpen = resolve;
          })
        : Promise.resolve({
            status: 'ok',
            generation: 'g1',
            servers: [server],
          }),
    );
    machine.watch.mockImplementation(
      (
        _machine,
        request: { sinceRevision?: number },
        options: { signal: AbortSignal },
      ) => {
        if (request.sinceRevision === undefined)
          return Promise.resolve({
            status: 'ok',
            revision: 1,
            servers: [{ ...server, state: 'starting' }],
            diagnostics: {},
          });
        return new Promise((resolve, reject) => {
          deliverWatch = resolve;
          options.signal.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true },
          );
        });
      },
    );
    function EditPage() {
      return useFilePageCodeIntelligence(input({ editing: true })).notice;
    }
    const screen = await renderScreen(
      <PageWrapper>
        <EditPage />
      </PageWrapper>,
    );
    await vi.waitFor(() =>
      expect(screen.findAllByType(SurfaceFreshnessLine)).toHaveLength(1),
    );
    const starting = screen.findAllByType(SurfaceFreshnessLine)[0];
    expect(starting.props.busy).toBe(true);
    expect(starting.props.action).toBeUndefined();
    expect(machine.query).not.toHaveBeenCalled();
    const startingReason = starting.props.reason;
    await act(async () => {
      finishOpen({
        status: 'ok',
        generation: 'g1',
        version: 1,
        servers: [{ ...server, loading: true }],
      });
    });
    await vi.waitFor(() =>
      expect(
        screen.findAllByType(SurfaceFreshnessLine)[0]?.props.reason,
      ).not.toBe(startingReason),
    );
    expect(screen.findAllByType(SurfaceFreshnessLine)[0]?.props.busy).toBe(
      true,
    );
    await act(async () => {
      deliverWatch({
        status: 'ok',
        revision: 2,
        servers: [server],
        diagnostics: {},
      });
    });
    await vi.waitFor(() =>
      expect(screen.findAllByType(SurfaceFreshnessLine)).toHaveLength(0),
    );
    await act(async () => {
      deliverWatch({
        status: 'ok',
        revision: 3,
        servers: [{ ...server, state: 'crashed' }],
        diagnostics: {},
      });
    });
    await vi.waitFor(() =>
      expect(screen.findAllByType(SurfaceFreshnessLine)).toHaveLength(1),
    );
    const failed = screen.findAllByType(SurfaceFreshnessLine)[0];
    expect(failed.props.busy).toBe(false);
    expect(failed.props.action?.onPress).toBeTypeOf('function');
    expect(machine.query).not.toHaveBeenCalled();
  });

  it('uses the displayed inspected token for card type/implementation, but the caret for keyboard/menu intent', async () => {
    const text = 'const caret = inspected;';
    const liveValue = { get: () => text };
    const editorHandleRef = {
      current: {
        getValue: () => text,
        flushPendingChange: async () => {},
        getCursorPosition: () => ({ line: 1, character: 8 }),
      },
    };
    machine.sync.mockResolvedValue({
      status: 'ok',
      generation: 'g1',
      version: 1,
      servers: [server],
      capabilities: {
        hover: true,
        definition: true,
        references: true,
        documentSymbol: true,
        diagnostics: 'none',
        acceptsExternalChanges: false,
        typeDefinition: true,
        implementation: true,
      },
    });
    machine.query.mockImplementation(
      async (_machine, request: LanguageIntelligenceQueryInput) =>
        request.kind === 'hover'
          ? {
              status: 'ok',
              kind: 'hover',
              sections: [
                { serverId: 'ts', label: 'TS', markdown: 'Inspected symbol' },
              ],
            }
          : { status: 'ok', kind: request.kind, locations: [], hasMore: false },
    );
    const hook = await renderHook(
      () =>
        useFilePageCodeIntelligence(
          input({ editing: true, liveValue, editorHandleRef }),
        ),
      { wrapper: PageWrapper },
    );
    const layer = hook.getCurrent().layer;
    if (!layer)
      throw new Error('Expected the existing intelligence card layer');
    const screen = await renderScreen(layer);
    for (const [kind, action, command] of [
      ['typeDefinition', 'onTypeDefinition', 'code.goToTypeDefinition'],
      ['implementation', 'onImplementation', 'code.goToImplementation'],
    ] as const) {
      await act(async () => {
        hook
          .getCurrent()
          .viewBinding?.onActivate(1, 16, { via: 'touch', rect: null });
      });
      await vi.waitFor(() =>
        expect(
          hook.getCurrent().controller?.getSnapshot().querySelection?.identifier
            .symbol,
        ).toBe('inspected'),
      );
      const card = screen.findAllByType(CodeIntelligenceCard)[0];
      machine.query.mockClear();
      await act(async () => {
        card.props[action]();
      });
      await vi.waitFor(() =>
        expect(
          machine.query.mock.calls.find((call) => call[1].kind === kind)?.[1]
            .position,
        ).toEqual({ line: 0, character: 16 }),
      );
      machine.query.mockClear();
      await act(async () => {
        hook.getCurrent().menuCommands?.[command]();
      });
      await vi.waitFor(() =>
        expect(
          machine.query.mock.calls.find((call) => call[1].kind === kind)?.[1]
            .position,
        ).toEqual({ line: 0, character: 8 }),
      );
    }
  });

  it('previews a held dirty reference without another read and refuses the retired Account', async () => {
    let port: CodeEditorLanguageIntelligence | null = null;
    const editorHandleRef = {
      current: {
        getValue: defaultLiveValue.get,
        flushPendingChange: async () => {},
        setLanguageIntelligence: (
          next: CodeEditorLanguageIntelligence | null,
        ) => {
          port = next;
        },
      },
    };
    const hook = await renderHook(
      () => {
        const other = useRetainedEditor('b', 'export const saved = 1;', false);
        const intelligence = useFilePageCodeIntelligence(
          input({ editing: true, editorHandleRef }),
        );
        return { other, intelligence };
      },
      { wrapper: PageWrapper },
    );
    await act(async () => {
      hook.getCurrent().other.startEditingFile();
      hook.getCurrent().other.onEditorChange('export const draft = 2;');
    });
    const preview = (port as CodeEditorLanguageIntelligence | null)
      ?.referencePreview;
    expect(preview?.readText).toBeTypeOf('function');
    if (!preview) return;
    expect(
      await preview.readText('src/b.ts', new AbortController().signal),
    ).toBe('export const draft = 2;');
    expect(actionBoundary.calls).toHaveLength(0); // Cost: already-held buffers perform no filesystem read.
    const { disconnectActiveServerConnection } =
      await import('@/sync/runtime/orchestration/connectionManager');
    await act(async () => {
      await disconnectActiveServerConnection();
    });
    expect(
      await preview.readText('src/b.ts', new AbortController().signal),
    ).toBeNull();
    expect(actionBoundary.calls).toHaveLength(0);
  });

  it('runs a project check only on request, offers cancellation and does not poll', async () => {
    let finish!: (value: LanguageIntelligenceQueryResult) => void;
    let signal: AbortSignal | undefined;
    machine.query.mockImplementation(
      (
        _machine,
        request: LanguageIntelligenceQueryInput,
        options: { signal: AbortSignal },
      ) => {
        expect(request).toMatchObject({
          kind: 'diagnostics',
          scope: 'project',
        });
        signal = options.signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const hook = await renderHook(() => useFilePageCodeIntelligence(input()), {
      wrapper: PageWrapper,
    });
    const screen = await renderScreen(
      <CodeIntelligencePaneTab
        scopeId="intelligence-page"
        kind="problems"
        active
      />,
    );
    expect(machine.query).not.toHaveBeenCalled();
    // The project check lives in its own scope: Open files never offers it.
    expect(screen.findAllByTestId('code-project-problems-check')).toHaveLength(
      0,
    );
    expect(
      screen.findAllByTestId('code-problems-scope:project').length,
    ).toBeGreaterThan(0);
    await act(async () => {
      screen.findAllByTestId('code-problems-scope:project')[0]?.props.onPress();
    });
    expect(hook.getCurrent().controller?.getSnapshot().problemsScope).toBe(
      'project',
    );
    expect(machine.query).not.toHaveBeenCalled();
    expect(
      screen.findAllByTestId('code-project-problems-check').length,
    ).toBeGreaterThan(0);
    await act(async () => {
      screen.findAllByTestId('code-project-problems-check')[0]?.props.onPress();
    });
    await vi.waitFor(() => expect(machine.query).toHaveBeenCalledOnce());
    await act(async () => {
      screen
        .findAllByTestId('code-project-problems-cancel')[0]
        ?.props.onPress();
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish({
        status: 'ok',
        kind: 'diagnostics',
        hasMore: false,
        diagnostics: [],
      });
    });
    expect(screen.findAllByTestId('code-problems-none')).toHaveLength(0);
    expect(machine.query).toHaveBeenCalledOnce();
    expect(
      hook.getCurrent().menuCommands?.['code.checkProjectProblems'],
    ).toBeTypeOf('function');
  });

  it.each([false, true])(
    'retains the final project diagnostic and its completeness in Problems (hasMore=%s)',
    async (hasMore) => {
      machine.query.mockResolvedValue({
        status: 'ok',
        kind: 'diagnostics',
        hasMore,
        diagnostics: [0, 4095].map((line) => ({
          serverId: 'ts',
          path: 'src/a.ts',
          severity: 'error',
          message: `Problem ${line}`,
          range: { start: { line, character: 0 }, end: { line, character: 1 } },
        })),
      });
      await renderHook(() => useFilePageCodeIntelligence(input()), {
        wrapper: PageWrapper,
      });
      const screen = await renderScreen(
        <CodeIntelligencePaneTab
          scopeId="intelligence-page"
          kind="problems"
          active
        />,
      );
      await act(async () => {
        screen
          .findAllByTestId('code-problems-scope:project')[0]
          ?.props.onPress();
      });
      await act(async () => {
        screen
          .findAllByTestId('code-project-problems-check')[0]
          ?.props.onPress();
      });
      await vi.waitFor(() =>
        expect(
          screen.findAllByTestId('code-problem-src/a.ts:4096').length,
        ).toBeGreaterThan(0),
      );
      expect(screen.findAllByType(CodeProblemsList)[0].props).toMatchObject({
        state: 'ready',
        partial: hasMore,
      });
      expect(screen.findAllByTestId('code-problems-none')).toHaveLength(0);
    },
  );

  it.each([
    { width: 1440, count: 0, hasMore: true },
    { width: 1440, count: 1, hasMore: true },
    { width: 390, count: 0, hasMore: true },
    { width: 390, count: 1, hasMore: true },
    { width: 1440, count: 0, hasMore: false },
    { width: 390, count: 0, hasMore: false },
  ])(
    'preserves semantic reference completeness in the presentation ($width px, $count rows, hasMore=$hasMore)',
    async ({ width, count, hasMore }) => {
      const { Dimensions } = await import('react-native');
      const dimensions = vi
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width, height: 844, scale: 1, fontScale: 1 });
      machine.sync.mockResolvedValue({
        status: 'ok',
        generation: 'g1',
        version: 1,
        servers: [server],
        capabilities: {
          hover: true,
          definition: true,
          references: true,
          documentSymbol: false,
          diagnostics: 'none',
          acceptsExternalChanges: false,
        },
      });
      machine.query.mockResolvedValue({
        status: 'ok',
        kind: 'references',
        hasMore,
        locations: count
          ? [
              {
                serverId: 'ts',
                path: 'src/a.ts',
                range: {
                  start: { line: 0, character: 6 },
                  end: { line: 0, character: 11 },
                },
                lineText: defaultLiveValue.get(),
              },
            ]
          : [],
      });
      try {
        const hook = await renderHook(
          () => useFilePageCodeIntelligence(input()),
          { wrapper: PageWrapper },
        );
        const layer = hook.getCurrent().layer;
        if (!layer) throw new Error('Expected card layer');
        const screen = await renderScreen(
          width === 390 ? (
            layer
          ) : (
            <CodeIntelligencePaneTab
              scopeId="intelligence-page"
              kind="references"
              active
            />
          ),
        );
        await act(async () => {
          await hook
            .getCurrent()
            .controller?.references({ line: 0, character: 7 });
        });
        await vi.waitFor(() =>
          expect(screen.findAllByType(CodeReferencesList)).toHaveLength(1),
        );
        const references = screen.findAllByType(CodeReferencesList)[0].props;
        expect(references.rows).toHaveLength(count);
        expect(references.textMatches).toBe(false);
        expect(references.partial).toBe(hasMore);
        expect(references.searching).toBe(false);
        // Semantic partial answers say so whether or not they carry rows; only a complete empty answer says "none".
        const { t } = await import('@/text');
        expect(
          screen.findAllByTestId('code-references-partial').length > 0,
        ).toBe(hasMore);
        const noneLine = t('files.pane.intelligence.noReferences');
        expect(
          screen.findAll((node) => node.props.children === noneLine).length > 0,
        ).toBe(!hasMore && count === 0);
      } finally {
        dimensions.mockRestore();
      }
    },
  );

  it('shows incoming and outgoing calls in the existing References panel through the real controller', async () => {
    const range = {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 6 },
    };
    const capabilities = {
      hover: true,
      definition: true,
      references: true,
      documentSymbol: true,
      diagnostics: 'pull',
      acceptsExternalChanges: false,
      callHierarchy: true,
    } as const;
    machine.sync.mockResolvedValue({
      status: 'ok',
      generation: 'g1',
      version: 1,
      servers: [server],
      capabilities,
    });
    const root = {
      serverId: 'ts',
      itemId: 'root',
      path: 'src/a.ts',
      name: 'value',
      kind: 12,
      range,
      selectionRange: range,
    };
    machine.query.mockImplementation(
      async (_machine, request: LanguageIntelligenceQueryInput) => {
        if (request.kind === 'references')
          return {
            status: 'ok',
            kind: 'references',
            hasMore: false,
            locations: [],
          };
        return {
          status: 'ok',
          kind: 'callHierarchy',
          direction: request.hierarchy?.direction,
          items: request.hierarchy?.direction === 'prepare' ? [root] : [],
          calls:
            request.hierarchy?.direction === 'prepare'
              ? []
              : [
                  {
                    item: {
                      ...root,
                      path: 'src/caller.ts',
                      name: 'caller',
                      itemId: 'caller',
                    },
                    ranges: [range],
                  },
                ],
        };
      },
    );
    const hook = await renderHook(() => useFilePageCodeIntelligence(input()), {
      wrapper: PageWrapper,
    });
    await act(async () => {
      await hook.getCurrent().controller?.references({ line: 0, character: 7 });
    });
    const screen = await renderScreen(
      <CodeIntelligencePaneTab
        scopeId="intelligence-page"
        kind="references"
        active
      />,
    );
    await act(async () => {
      screen.findAllByTestId('code-navigation-tab:calls')[0]?.props.onPress();
    });
    await vi.waitFor(() =>
      expect(
        screen.findAllByTestId('code-reference-src/caller.ts:2').length,
      ).toBeGreaterThan(0),
    );
    expect(
      machine.query.mock.calls
        .map((call) => call[1].hierarchy?.direction)
        .filter(Boolean),
    ).toEqual(['prepare', 'incoming']);
    await act(async () => {
      screen
        .findAllByTestId('code-call-direction:outgoing')[0]
        ?.props.onPress();
    });
    await vi.waitFor(() =>
      expect(machine.query.mock.calls.at(-1)?.[1]).toMatchObject({
        kind: 'callHierarchy',
        hierarchy: { direction: 'outgoing', itemId: 'root' },
        serverId: 'ts',
      }),
    );
  });

  it('keeps reading passive and warms the same document exactly once when Edit is entered', async () => {
    const hook = await renderHook(
      ({ editing }) => useFilePageCodeIntelligence(input({ editing })),
      {
        initialProps: { editing: false },
        wrapper: PageWrapper,
      },
    );
    try {
      expect(machine.sync).not.toHaveBeenCalled();
      await hook.rerender({ editing: true });
      await vi.waitFor(() =>
        expect(
          machine.sync.mock.calls.filter(
            ([, request]) => request.op.op === 'open',
          ),
        ).toHaveLength(1),
      );
      await hook.rerender({ editing: false });
      await hook.rerender({ editing: true });
      expect(
        machine.sync.mock.calls.filter(
          ([, request]) => request.op.op === 'open',
        ),
      ).toHaveLength(1);
    } finally {
      await hook.unmount();
    }
  });

  it('uses the selected View and Changes body coordinates without losing the retained dirty editor', async () => {
    const saved = 'const savedName = 1;\nmissingSaved();';
    const draft =
      'const draftName = 1;\n// inserted draft line\nmissingDraft();';
    let remoteText = '';
    let remoteVersion = 0;
    let remoteUnsaved = false;
    let holdSync: Promise<void> | undefined;
    const otherServer = { ...server, serverId: 'other' };
    const watches: Array<(response: LanguageIntelligenceWatchResult) => void> =
      [];
    machine.sync.mockImplementation(
      async (_machine, request: LanguageIntelligenceSyncInput) => {
        const op = request.op;
        if (op.op === 'open' || op.op === 'snapshot') remoteText = op.text;
        else if (op.op === 'change')
          remoteText = applyWorkspaceFileTextEdits(remoteText, [
            {
              range: {
                start: {
                  line: op.edit.startLine,
                  character: op.edit.startCharacter,
                },
                end: { line: op.edit.endLine, character: op.edit.endCharacter },
              },
              text: op.edit.text,
            },
          ]).text;
        if ('version' in op) remoteVersion = op.version;
        if ('unsaved' in op) remoteUnsaved = op.unsaved;
        if (op.op === 'change' || op.op === 'snapshot') await holdSync;
        return {
          status: 'ok',
          generation: 'g1',
          version: remoteVersion,
          servers: [server],
          capabilities: {
            hover: true,
            definition: true,
            references: true,
            documentSymbol: true,
            diagnostics: 'push',
            acceptsExternalChanges: false,
          },
        };
      },
    );
    // The remote Machine is the boundary: its query answers and diagnostic
    // versions describe exactly the text acknowledged by the real P7 sync.
    machine.query.mockImplementation(
      async (_machine, request: LanguageIntelligenceQueryInput) => {
        if (request.text === 'disk' && remoteUnsaved)
          return {
            status: 'error',
            errorCode: 'unsaved_editor_changes',
            diskHash: 'a'.repeat(64),
          };
        const name = remoteText === saved ? 'savedName' : 'draftName';
        const range = {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 6 + name.length },
        };
        if (request.kind === 'documentSymbols')
          return {
            status: 'ok',
            kind: request.kind,
            fileHash: 'a'.repeat(64),
            hasMore: false,
            symbols: [
              { serverId: 'ts', name, kind: 14, range, selectionRange: range },
            ],
          };
        if (request.kind === 'workspaceSymbol')
          return {
            status: 'ok',
            kind: request.kind,
            hasMore: false,
            symbols: [
              { serverId: 'ts', path: 'src/a.ts', name, kind: 14, range },
            ],
          };
        if (request.kind === 'definition')
          return {
            status: 'ok',
            kind: request.kind,
            hasMore: false,
            locations: [{ serverId: 'ts', path: 'src/a.ts', range }],
          };
        return {
          status: 'ok',
          kind: 'hover',
          sections: [{ serverId: 'ts', label: 'TS', markdown: name, range }],
        };
      },
    );
    machine.watch.mockImplementation(
      (_machine, _request, options: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          watches.push(resolve);
          options.signal.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    );
    const hook = await renderHook(
      ({ mode }: { mode: 'edit' | 'file' | 'diff' }) => {
        const editor = useRetainedEditor(
          'a',
          saved,
          true,
          mode === 'diff' ? 'diff' : 'file',
        );
        const intelligence = useFilePageCodeIntelligence(
          input({
            liveValue: editor.liveValue,
            displayedText: mode === 'edit' ? undefined : saved,
            getUnsaved: () => editor.readSnapshot().dirty,
            editorHandleRef: editor.editorHandleRef,
          }),
        );
        return { editor, intelligence };
      },
      { initialProps: { mode: 'edit' }, wrapper: PageWrapper },
    );
    await act(async () => {
      hook.getCurrent().editor.startEditingFile();
      hook.getCurrent().editor.onEditorChange(draft);
    });
    const controller = hook.getCurrent().intelligence.controller!;
    await act(async () => {
      await controller.hover({ line: 0, character: 8 });
    });
    expect(controller.getSnapshot().querySelection?.identifier.symbol).toBe(
      'draftName',
    );
    const deliverMarkers = async (
      revision: number,
      line: number,
      version = remoteVersion,
    ) => {
      await vi.waitFor(() => expect(watches.length).toBeGreaterThan(0));
      await act(async () => {
        watches.shift()!({
          status: 'ok',
          revision,
          servers: [server, otherServer],
          diagnostics: {
            'src/a.ts': {
              ts: {
                version,
                generation: 'g1',
                state: 'ready',
                items: [
                  {
                    serverId: 'ts',
                    path: 'src/a.ts',
                    severity: 'error',
                    message: 'Missing name',
                    range: {
                      start: { line, character: 0 },
                      end: { line, character: 12 },
                    },
                  },
                ],
              },
            },
            'src/b.ts': {
              other: {
                version: 1,
                generation: 'g1',
                state: 'ready',
                items: [
                  {
                    serverId: 'other',
                    path: 'src/b.ts',
                    severity: 'error',
                    message: 'Other file problem',
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 1 },
                    },
                  },
                ],
              },
            },
          },
        });
      });
    };
    await deliverMarkers(1, 2);
    expect(
      hook
        .getCurrent()
        .intelligence.viewBinding?.getDiagnosticsByLine()
        ?.has(3),
    ).toBe(true);
    for (const [index, mode] of (['file', 'diff'] as const).entries()) {
      const previousVersion = remoteVersion;
      let acknowledge!: () => void;
      holdSync = new Promise((resolve) => {
        acknowledge = resolve;
      });
      await hook.rerender({ mode });
      expect(hook.getCurrent().intelligence.controller).toBe(controller);
      expect(
        hook
          .getCurrent()
          .intelligence.viewBinding?.getDiagnosticsByLine()
          ?.has(3) ?? false,
      ).toBe(false);
      expect(
        controller.getDiagnosticsProjection().entries['src/b.ts']?.other.items,
      ).toHaveLength(1);
      if (index === 0) {
        await deliverMarkers(2, 2, previousVersion);
        expect(
          hook
            .getCurrent()
            .intelligence.viewBinding?.getDiagnosticsByLine()
            ?.has(3) ?? false,
        ).toBe(false);
      }
      await act(async () => {
        acknowledge();
        await controller.syncDocument();
      });
      expect(
        controller.getDiagnosticsProjection().entries['src/b.ts']?.other.items,
      ).toHaveLength(1);
      holdSync = undefined;
      const screen = await renderScreen(
        <FileContentPanel
          theme={createThemeFixture()}
          displayMode={mode}
          sessionId=""
          filePath="src/a.ts"
          fileContent={saved}
          language="typescript"
          selectedLineKeys={new Set()}
          lineSelectionEnabled={false}
          onToggleLine={() => {}}
          diffContent={`@@ -1,2 +1,2 @@\n-const oldName = 1;\n+const savedName = 1;\n missingSaved();`}
          intelligence={hook.getCurrent().intelligence.viewBinding}
        />,
      );
      try {
        const body = screen
          .findAllByType(CodeLinesView)
          .map((node) => node.props as CodeLinesViewProps)
          .find((props) =>
            props.lines.some((line) =>
              line.renderCodeText.includes('savedName'),
            ),
          )!;
        const line = body.lines.find((row) =>
          row.renderCodeText.includes('savedName'),
        )!;
        expect(line.newLine).toBe(1);
        await act(async () => {
          body.intelligence?.onPointerToken(line.id, 8, null, line.newLine!);
        });
        expect(controller.getSnapshot().selection?.identifier.symbol).toBe(
          'savedName',
        );
        await act(async () => {
          await controller.hover({ line: 0, character: 8 });
        });
        expect(controller.getSnapshot().querySelection?.identifier.symbol).toBe(
          'savedName',
        );
        expect(remoteText).toBe(saved);
        expect(remoteUnsaved).toBe(true);
        expect(
          hook
            .getCurrent()
            .intelligence.viewBinding?.getDiagnosticsByLine()
            ?.has(3) ?? false,
        ).toBe(false);
        await deliverMarkers(index + 3, 1);
        expect(
          hook
            .getCurrent()
            .intelligence.viewBinding?.getDiagnosticsByLine()
            ?.has(2),
        ).toBe(true);
        await act(async () => {
          expect(
            body.intelligence?.onActivateToken(
              line.id,
              8,
              { via: 'touch', rect: null },
              1,
            ),
          ).toBe(true);
        });
        await act(async () => {
          body.intelligence?.onActivateToken(
            line.id,
            8,
            { via: 'modifier', rect: null },
            1,
          );
        });
        await vi.waitFor(() =>
          expect(controller.getSnapshot()).toMatchObject({
            kind: 'definition',
            status: 'ready',
            querySelection: { identifier: { symbol: 'savedName' } },
          }),
        );
        const symbols = hook.getCurrent().intelligence.symbols!;
        expect(symbols.getText()).toBe(saved);
        const outline = await createWorkspaceSymbolSearchSource(
          symbols,
        ).resolve('savedName', new AbortController().signal);
        expect(outline.results[0]?.target).toMatchObject({
          kind: 'workspaceSymbol',
          path: 'src/a.ts',
          anchor: { kind: 'fileLine', startLine: 1 },
        });
        const { createDefaultActionExecutor } =
          await import('@/sync/ops/actions/defaultActionExecutor');
        expect(
          await createDefaultActionExecutor().execute(
            'code.hover.get',
            {
              machineId: 'm1',
              rootPath: '/repo',
              path: 'src/a.ts',
              line: 1,
              symbol: 'savedName',
            },
            {
              surface: 'agent',
              authority: 'account_automation',
              serverId: scope.serverId,
            },
          ),
        ).toMatchObject({
          ok: true,
          result: { status: 'error', errorCode: 'unsaved_editor_changes' },
        });
      } finally {
        await screen.unmount();
      }
    }
    let acknowledgeDraft!: () => void;
    holdSync = new Promise((resolve) => {
      acknowledgeDraft = resolve;
    });
    await hook.rerender({ mode: 'edit' });
    expect(
      hook
        .getCurrent()
        .intelligence.viewBinding?.getDiagnosticsByLine()
        ?.has(2) ?? false,
    ).toBe(false);
    acknowledgeDraft();
    await act(async () => {
      hook.getCurrent().editor.startEditingFile();
      await controller.syncDocument();
    });
    expect(hook.getCurrent().editor.editorSeedText).toBe(draft);
    expect(hook.getCurrent().editor.getEditorText()).toBe(draft);
    expect(hook.getCurrent().editor.readSnapshot().dirty).toBe(true);
    expect(remoteText).toBe(draft);
    expect(
      hook
        .getCurrent()
        .intelligence.viewBinding?.getDiagnosticsByLine()
        ?.has(2) ?? false,
    ).toBe(false);
    await deliverMarkers(5, 2);
    expect(
      hook
        .getCurrent()
        .intelligence.viewBinding?.getDiagnosticsByLine()
        ?.has(3),
    ).toBe(true);
    expect(hook.getCurrent().intelligence.symbols?.getText()).toBe(draft);
    expect(actionBoundary.calls).toEqual([]);
  });

  it('claims a read-view tap only when the existing controller resolves an identifier', async () => {
    machine.query.mockResolvedValue({
      status: 'ok',
      kind: 'hover',
      sections: [],
    });
    const liveValue = { get: () => '    target();' };
    const hook = await renderHook(
      () => useFilePageCodeIntelligence(input({ liveValue })),
      { wrapper: PageWrapper },
    );
    const binding = hook.getCurrent().viewBinding;
    const layer = hook.getCurrent().layer;
    if (!binding || !layer)
      throw new Error('Expected the live read-view intelligence binding');
    let claimed: unknown;
    await act(async () => {
      claimed = binding.onActivate(1, 0, { via: 'touch', rect: null });
    });
    expect(claimed).toBe(false);
    expect(hook.getCurrent().controller?.getSnapshot().selection).toBeNull();
    expect(layer.props.interaction.getState()).toBeNull();
    expect(machine.query).not.toHaveBeenCalled();
    await act(async () => {
      claimed = binding.onActivate(1, 6, { via: 'touch', rect: null });
    });
    expect(claimed).toBe(true);
    expect(
      hook.getCurrent().controller?.getSnapshot().selection?.identifier.symbol,
    ).toBe('target');
    expect(layer.props.interaction.getState()).toMatchObject({ via: 'tap' });
  });

  it('offers Markdown headings to passive @ Search in View, Source and Edit without starting a server', async () => {
    let text = '# First\n\n## Target';
    const liveValue = { get: () => text };
    const hook = await renderHook(
      ({ presentation }: { presentation: 'view' | 'source' | 'edit' }) =>
        useFilePageCodeIntelligence(
          input({
            filePath: 'README.md',
            language: 'markdown',
            enabled: false,
            outlineEnabled: true,
            liveValue,
            editorHandleRef: {
              current:
                presentation === 'edit'
                  ? { getValue: () => text, flushPendingChange: async () => {} }
                  : null,
            },
          }),
        ),
      { initialProps: { presentation: 'view' }, wrapper: PageWrapper },
    );
    for (const presentation of ['view', 'source', 'edit'] as const) {
      await hook.rerender({ presentation });
      const symbols = hook.getCurrent().symbols;
      expect(symbols).not.toBeNull();
      if (!symbols) throw new Error('Expected the active file outline');
      const page = await createWorkspaceSymbolSearchSource(symbols).resolve(
        'Target',
        new AbortController().signal,
      );
      expect(page.results[0]?.target).toMatchObject({
        kind: 'workspaceSymbol',
        path: 'README.md',
        anchor: { kind: 'fileLine', startLine: 3 },
      });
      text = '# Updated\n\n## Target';
    }
    expect(machine.sync).not.toHaveBeenCalled();
    expect(machine.query).not.toHaveBeenCalled();
  });

  it('shows schema documentation from Info at cursor inside a JSON property string', async () => {
    const text = '{"$schema":"./schema.json","flavour":12}\n';
    let cursorCharacter = 30;
    const liveValue = { get: () => text };
    const editorHandleRef = {
      current: {
        getValue: () => text,
        flushPendingChange: async () => {},
        getCursorPosition: () => ({ line: 1, character: cursorCharacter }),
      },
    };
    const jsonServer = { ...server, serverId: 'json', label: 'JSON' };
    machine.sync.mockResolvedValue({
      status: 'ok',
      generation: 'g1',
      version: 1,
      servers: [jsonServer],
      capabilities: {
        hover: true,
        definition: false,
        references: false,
        documentSymbol: true,
        diagnostics: 'pull',
        acceptsExternalChanges: false,
      },
    });
    machine.query.mockResolvedValue({
      status: 'ok',
      kind: 'hover',
      sections: [
        {
          serverId: 'json',
          label: 'JSON',
          markdown: 'Choose a flavour\\.',
          range: {
            start: { line: 0, character: 27 },
            end: { line: 0, character: 36 },
          },
        },
      ],
    });
    const hook = await renderHook(
      () =>
        useFilePageCodeIntelligence(
          input({
            filePath: 'sample.json',
            language: 'json',
            editing: true,
            liveValue,
            editorHandleRef,
          }),
        ),
      { wrapper: PageWrapper },
    );
    const layer = hook.getCurrent().layer;
    if (!layer)
      throw new Error('Expected the existing intelligence card layer');
    const screen = await renderScreen(layer);
    await act(async () => {
      hook.getCurrent().menuCommands?.['code.showInfo']();
    });
    await vi.waitFor(() =>
      expect(
        screen.findAllByType(CodeIntelligenceCard)[0]?.props.model.hover,
      ).toMatchObject({
        documentation: 'Choose a flavour\\.',
        serverLabel: 'JSON',
      }),
    );
    expect(machine.query).toHaveBeenCalledWith(
      scope.machineId,
      expect.objectContaining({
        kind: 'hover',
        position: { line: 0, character: 30 },
        text: 'held',
      }),
      expect.anything(),
    );
    expect(screen.findAllByType(CodeIntelligenceCard)[0]?.props.open).toBe(
      true,
    );
    expect(machine.fallback).not.toHaveBeenCalled();

    let finishHover!: (result: LanguageIntelligenceQueryResult) => void;
    machine.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishHover = resolve;
        }),
    );
    cursorCharacter = 15;
    await act(async () => {
      hook.getCurrent().menuCommands?.['code.showInfo']();
    });
    await vi.waitFor(() => expect(finishHover).toBeTypeOf('function'));
    expect(
      screen.findAllByType(CodeIntelligenceCard)[0]?.props.model.hover,
    ).toBeNull();
    await act(async () => {
      finishHover({ status: 'ok', kind: 'hover', sections: [] });
    });
    expect(
      screen.findAllByType(CodeIntelligenceCard)[0]?.props.model.hover,
    ).toBeNull();
  });

  it.each([undefined, '/repo'])('retains the optional Session file base when opening a definition (%s)', async (fileRootPath) => {
    const path = fileRootPath ? 'nested/b.ts' : 'b.ts';
    machine.query.mockResolvedValue({
      status: 'ok', kind: 'definition', hasMore: false,
      locations: [{ serverId: 'ts', path, outsideWorkspace: false,
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 7 } } }],
    });
    const session = createSessionFixture({ id: 'session-nested', serverId: scope.serverId,
      metadata: { machineId: scope.machineId, path: '/repo/nested', host: 'test' } });
    const sessionMachine = createMachineFixture({ id: scope.machineId });
    storage.setState({ isDataReady: true, sessions: { ...storage.getState().sessions, [session.id]: session },
      machines: { ...storage.getState().machines, [sessionMachine.id]: sessionMachine },
      machineListByServerId: { ...storage.getState().machineListByServerId, [scope.serverId]: [sessionMachine] } });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
      externalSessions: false, inbox: true, workflows: false, friends: false,
    } });
    let workspace: WorkspaceNavigationContextValue | undefined;
    function DefinitionWrapper({ children }: React.PropsWithChildren) {
      return <AppPaneProvider><WorkspaceProvider enabled catalog={catalog}>{owner => {
        workspace = owner;
        return children;
      }}</WorkspaceProvider></AppPaneProvider>;
    }
    const pageInput = {
      ...input({ sessionId: 'session-nested', scope: { ...scope, rootPath: fileRootPath ?? '/repo/nested' },
        filePath: fileRootPath ? 'nested/a.ts' : 'a.ts',
        editorHandleRef: { current: {
          getValue: defaultLiveValue.get, flushPendingChange: async () => {},
          getCursorPosition: () => ({ line: 1, character: 16 }),
        } },
      }),
    };
    const hook = await renderHook(() => useFilePageCodeIntelligence(pageInput), { wrapper: DefinitionWrapper });
    await act(async () => { hook.getCurrent().menuCommands?.['code.goToDefinition'](); });
    await vi.waitFor(() => {
      const hrefs = Object.values(workspace!.state.tabs).map(tab => hrefForDestinationRef(catalog, tab.target));
      const definition = hrefs.find(href => href && new URL(href, 'https://happier.test').searchParams.get('path') === path);
      expect(definition).toBeDefined();
      const query = new URL(definition!, 'https://happier.test').searchParams;
      expect(query.get('rootPath')).toBe(fileRootPath ?? null);
    });
  });

  it.each(['modifier', 'cursor', 'card'] as const)(
    'opens the existing explanation only when an outside-only definition settles (%s)',
    async (entry) => {
      let settle!: (result: LanguageIntelligenceQueryResult) => void;
      machine.query.mockImplementation(
        (_machine, request: LanguageIntelligenceQueryInput) =>
          request.kind === 'hover'
            ? Promise.resolve({ status: 'ok', kind: 'hover', sections: [] })
            : new Promise((resolve) => {
                settle = resolve;
              }),
      );
      const hook = await renderHook(
        () =>
          useFilePageCodeIntelligence(
            input({
              editorHandleRef: {
                current: {
                  getValue: () => 'const value = Promise.resolve(1);',
                  flushPendingChange: async () => {},
                  getCursorPosition: () => ({ line: 1, character: 16 }),
                },
              },
            }),
          ),
        { wrapper: PageWrapper },
      );
      const before = hook.getCurrent().layer;
      expect(before).not.toBeNull();
      if (!before) throw new Error('Expected the existing card layer');
      const interaction = before.props.interaction as { getState(): unknown };
      if (entry === 'card') {
        const screen = await renderScreen(before);
        await act(async () => {
          hook.getCurrent().menuCommands?.['code.showInfo']();
        });
        await act(async () => {
          screen.findAllByType(CodeIntelligenceCard)[0]?.props.onDefinition();
        });
      } else
        await act(async () => {
          if (entry === 'modifier')
            hook
              .getCurrent()
              .viewBinding?.onActivate(1, 16, { via: 'modifier', rect: null });
          else hook.getCurrent().menuCommands?.['code.goToDefinition']();
        });
      await vi.waitFor(() => expect(settle).toBeTypeOf('function'));
      expect(interaction.getState()).toBeNull();
      await act(async () => {
        settle({
          status: 'ok',
          kind: 'definition',
          hasMore: false,
          locations: [
            {
              serverId: 'ts',
              path: '/managed/lib.d.ts',
              outsideWorkspace: true,
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 7 },
              },
            },
          ],
        });
      });
      expect(hook.getCurrent().controller?.getSnapshot().status).toBe('ready');
      expect(interaction.getState()).toMatchObject({
        via: 'command',
        references: false,
      });
    },
  );

  it('lets the Machine hold the saved file before it is asked for fixes', async () => {
    // A save changes no text, only whether the editor holds unsaved edits; the Machine refuses
    // fixes while its held copy is unsaved, so the flow must hand it the saved state first.
    let dirty = true;
    const events: string[] = [];
    machine.sync.mockImplementation(
      async (
        _machine,
        request: { op: { op: string; unsaved?: boolean; version?: number } },
      ) => {
        events.push(
          `sync:${request.op.unsaved === true ? 'unsaved' : 'saved'}`,
        );
        return {
          status: 'ok',
          generation: 'g1',
          version: request.op.version ?? 1,
          servers: [server],
        };
      },
    );
    machine.query.mockResolvedValue({
      status: 'ok',
      kind: 'hover',
      sections: [],
    });
    machine.preview.mockImplementation(async (_machine, actionId: string) => {
      events.push(actionId);
      return {
        status: 'ok',
        kind: 'codeActions',
        actions: [],
        fileHash: 'disk',
      };
    });
    const hook = await renderHook(
      () => useFilePageCodeIntelligence(input({ getUnsaved: () => dirty })),
      { wrapper: PageWrapper },
    );
    await act(async () => {
      await hook.getCurrent().controller?.hover({ line: 0, character: 7 });
    });
    expect(events).toContain('sync:unsaved');
    dirty = false;
    const layer = hook.getCurrent().editSetLayer;
    if (!layer) throw new Error('Expected the edit-set layer');
    await renderScreen(layer);
    await act(async () => {
      hook.getCurrent().menuCommands?.['code.quickFix']();
    });
    await vi.waitFor(() => expect(events).toContain('code.codeActions.list'));
    expect(events.slice(events.indexOf('code.codeActions.list') - 1)).toEqual([
      'sync:saved',
      'code.codeActions.list',
    ]);
  });

  it('delivers saved and unsaved watch diagnostics through the mounted editor decoration channel', async () => {
    let text = 'const value = missing;';
    let dirty = false;
    const listeners = new Set<() => void>();
    const liveValue = {
      get: () => text,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const watches: Array<(response: LanguageIntelligenceWatchResult) => void> =
      [];
    machine.sync.mockImplementation(async (_machine, request) => ({
      status: 'ok',
      generation: 'g1',
      version: 'version' in request.op ? request.op.version : 1,
      servers: [server],
    }));
    machine.watch.mockImplementation(
      (_machine, _request, options: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          watches.push(resolve);
          options.signal.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    );
    machine.query.mockResolvedValue({
      status: 'ok',
      kind: 'diagnostics',
      diagnostics: [],
      hasMore: false,
    });
    const editorRef = { current: null as TextEditorHandle | null };
    const decorations = new Map<string, readonly EditorDecoration[]>();
    let diagnosticPublications = 0;
    const hook = await renderHook(
      () =>
        useFilePageCodeIntelligence(
          input({
            liveValue,
            getUnsaved: () => dirty,
            editorHandleRef: editorRef,
          }),
        ),
      { wrapper: PageWrapper },
    );
    await act(async () => {
      await hook.getCurrent().controller?.checkProblems();
    });
    const deliver = async (
      revision: number,
      version: number,
      message: string | null,
      path = 'src/a.ts',
    ) => {
      await vi.waitFor(() => expect(watches.length).toBeGreaterThan(0));
      await act(async () => {
        watches.shift()!({
          status: 'ok',
          revision,
          servers: [server],
          diagnostics: {
            [path]: {
              ts: {
                state: 'ready',
                version,
                generation: 'g1',
                items: message
                  ? [
                      {
                        serverId: 'ts',
                        path,
                        severity: 'error',
                        message,
                        range: {
                          start: { line: 0, character: 14 },
                          end: { line: 0, character: 21 },
                        },
                      },
                    ]
                  : [],
              },
            },
          },
        });
      });
    };
    await deliver(1, 1, 'Saved missing name');
    // The page may check before entering Edit: ready binds the held projection to the new engine.
    editorRef.current = {
      getValue: () => text,
      flushPendingChange: async () => {},
      setDecorations: (layer, items) => {
        if (layer === 'diagnostic') diagnosticPublications++;
        decorations.set(layer, items);
      },
    };
    await act(async () => {
      hook.getCurrent().bindEditor();
    });
    expect(decorations.get('diagnostic')).toEqual([
      expect.objectContaining({
        startLine: 1,
        startCharacter: 14,
        message: 'Saved missing name',
      }),
    ]);
    const initialPublications = diagnosticPublications;
    for (let index = 0; index < 12; index++)
      await deliver(1, 1, 'Saved missing name');
    expect(diagnosticPublications).toBe(initialPublications);
    const problems = await renderScreen(
      <PageWrapper>
        <CodeIntelligencePaneTab
          scopeId="intelligence-page"
          kind="problems"
          active
        />
      </PageWrapper>,
    );
    await deliver(2, 1, 'Another file problem', 'src/b.ts');
    expect(diagnosticPublications).toBe(initialPublications);
    expect(
      problems.findAllHostsByTestId('code-problem-src/b.ts:1'),
    ).toHaveLength(1);
    await act(async () => {
      text = 'const value = invalid;';
      dirty = true;
      for (const listener of listeners) listener();
      await hook.getCurrent().controller?.syncDocument();
    });
    await deliver(3, 2, 'Unsaved missing name');
    expect(decorations.get('diagnostic')).toEqual([
      expect.objectContaining({ message: 'Unsaved missing name' }),
    ]);
    await deliver(4, 2, null);
    expect(decorations.get('diagnostic')).toEqual([]);
    expect(
      problems.findAllHostsByTestId('code-problem-src/b.ts:1'),
    ).toHaveLength(1);
    await vi.waitFor(() => expect(watches.length).toBeGreaterThan(0));
    await act(async () => {
      watches.shift()!({
        status: 'ok',
        revision: 5,
        servers: [{ ...server, state: 'crashed' }],
        diagnostics: {},
      });
    });
    expect(
      problems.findAllHostsByTestId('code-problem-src/b.ts:1'),
    ).toHaveLength(0);
    expect(decorations.get('diagnostic')).toEqual([]);
  });

  it('keeps the explanation closed for an ordinary in-workspace definition', async () => {
    machine.query.mockResolvedValue({
      status: 'ok',
      kind: 'definition',
      hasMore: false,
      locations: [
        {
          serverId: 'ts',
          path: 'src/definition.ts',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 7 },
          },
        },
      ],
    });
    const hook = await renderHook(() => useFilePageCodeIntelligence(input()), {
      wrapper: PageWrapper,
    });
    const layer = hook.getCurrent().layer;
    if (!layer) throw new Error('Expected the existing card layer');
    const interaction = layer.props.interaction as { getState(): unknown };
    await act(async () => {
      hook
        .getCurrent()
        .viewBinding?.onActivate(1, 16, { via: 'modifier', rect: null });
    });
    expect(hook.getCurrent().controller?.getSnapshot().status).toBe('ready');
    expect(interaction.getState()).toBeNull();
  });

  it.each([false, true])(
    'opens the new-session composer for Project View problems without an editor-action holder, or explains unsaved text (%s)',
    async (unsaved) => {
      await prepareSessionDraftPersistenceStorage();
      const saved = 'missingName();';
      const liveValue = { get: () => saved };
      machine.query.mockResolvedValue({
        status: 'ok',
        kind: 'diagnostics',
        diagnostics: [],
        hasMore: false,
      });
      let deliver!: (answer: LanguageIntelligenceWatchResult) => void;
      machine.watch.mockImplementationOnce(
        (_machine, _request, options: { signal: AbortSignal }) =>
          new Promise<LanguageIntelligenceWatchResult>((resolve, reject) => {
            deliver = resolve;
            options.signal.addEventListener(
              'abort',
              () => reject(options.signal.reason),
              { once: true },
            );
          }),
      );
      const settingsScope = {
        serverId: scope.serverId,
        accountId: 'account-a',
      };
      const previous = loadAccountSettings(settingsScope);
      saveAccountSettings(
        settingsScope,
        {
          ...settingsParse(previous.settings),
          filesAskWithoutSessionTarget: 'session',
        },
        previous.version ?? 0,
      );
      const hook = await renderHook(
        () => {
          const page = useFilePageCodeIntelligence(
            input({
              displayedText: saved,
              liveValue,
              getUnsaved: () => unsaved,
            }),
          );
          return {
            page,
            producer: useCodeIntelligencePaneProducer('intelligence-page'),
          };
        },
        { wrapper: PageWrapper },
      );
      try {
        await act(async () => {
          await hook.getCurrent().page.controller?.checkProblems();
        });
        await act(async () => {
          deliver({
            status: 'ok',
            revision: 1,
            servers: [server],
            diagnostics: {
              'src/a.ts': {
                ts: {
                  state: 'ready',
                  version: 1,
                  generation: 'g1',
                  items: [
                    {
                      serverId: 'ts',
                      path: 'src/a.ts',
                      severity: 'error',
                      message: 'Unknown name',
                      range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 11 },
                      },
                    },
                  ],
                },
              },
            },
          });
        });
        let asked = false;
        await act(async () => {
          asked = (await hook.getCurrent().producer?.ask?.run()) ?? false;
        });
        if (unsaved) {
          expect(asked).toBe(false);
          expect(navigation.push).not.toHaveBeenCalled();
          expect(navigation.alert).toHaveBeenCalledWith(
            'common.error',
            'files.fileWriteFailed',
          );
        } else {
          expect(asked).toBe(true);
          // The entry router forwards expo-router's optional navigation options; the href is the contract.
          expect(navigation.push).toHaveBeenCalledOnce();
          expect(navigation.push.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
              pathname: '/new',
              params: expect.objectContaining({
                draftId: expect.any(String),
                draftServerId: scope.serverId,
                draftAccountId: 'account-a',
              }),
            }),
          );
          const draftId = navigation.push.mock.calls[0]?.[0].params.draftId;
          const draft = readNewSessionDraftFromRepository({
            scope: settingsScope,
            draftId,
          });
          expect(draft).toMatchObject({
            selectedMachineId: 'm1',
            selectedPath: '/repo',
          });
          expect(draft?.input).toContain(saved);
          expect(draft?.input).toContain('Unknown name');
        }
      } finally {
        await hook.unmount();
        saveAccountSettings(
          settingsScope,
          settingsParse(previous.settings),
          previous.version ?? 0,
        );
      }
    },
  );

  it('quotes current saved bytes after Format restores the version preceding an editor save', async () => {
    await prepareSessionDraftPersistenceStorage();
    const formatted = '  const total: string = lineTotal(item);';
    const unformatted = '            const total:string=lineTotal(item);';
    const formattedHash = 'a'.repeat(64);
    const unformattedHash = 'b'.repeat(64);
    const files = [
      {
        path: 'src/a.ts',
        expectedHash: unformattedHash,
        edits: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: unformatted.length },
            },
            text: formatted,
          },
        ],
      },
    ];
    machine.preview.mockResolvedValue({
      status: 'ok',
      kind: 'formatting',
      files,
    });
    machine.apply.mockResolvedValue({
      ok: true,
      results: [{ path: 'src/a.ts', status: 'replaced', hash: formattedHash }],
    } satisfies Awaited<
      ReturnType<
        typeof import('@/sync/ops/machineLanguageIntelligence').machineLanguageIntelligenceApplyAction
      >
    >);
    actionBoundary.read
      .mockReset()
      .mockResolvedValue({ success: true, hash: unformattedHash });
    machine.query.mockResolvedValue({
      status: 'ok',
      kind: 'diagnostics',
      diagnostics: [],
      hasMore: false,
    });
    let deliver!: (answer: LanguageIntelligenceWatchResult) => void;
    machine.watch.mockImplementationOnce(
      (_machine, _request, options: { signal: AbortSignal }) =>
        new Promise<LanguageIntelligenceWatchResult>((resolve, reject) => {
          deliver = resolve;
          options.signal.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    );
    const settingsScope = { serverId: scope.serverId, accountId: 'account-a' };
    const previous = loadAccountSettings(settingsScope);
    saveAccountSettings(
      settingsScope,
      {
        ...settingsParse(previous.settings),
        filesAskWithoutSessionTarget: 'session',
      },
      previous.version ?? 0,
    );
    const hook = await renderHook(
      ({ text, hash }) => {
        const editor = useRetainedEditor('a', text, true, 'file', hash);
        const page = useFilePageCodeIntelligence(
          input({
            displayedText: text,
            liveValue: editor.liveValue,
            editorHandleRef: editor.editorHandleRef,
            getUnsaved: () => editor.readSnapshot().dirty,
          }),
        );
        return {
          editor,
          page,
          producer: useCodeIntelligencePaneProducer('intelligence-page'),
        };
      },
      {
        wrapper: PageWrapper,
        initialProps: { text: formatted, hash: formattedHash },
      },
    );
    try {
      await act(async () => {
        hook.getCurrent().editor.startEditingFile();
        hook.getCurrent().editor.onEditorChange(unformatted);
      });
      await act(async () => {
        expect(await hook.getCurrent().editor.saveFileEdits()).toBe(true);
      });
      await hook.rerender({ text: unformatted, hash: unformattedHash });
      expect(hook.getCurrent().editor.readSnapshot().savedText).toBe(
        unformatted,
      );
      const layer = await renderScreen(hook.getCurrent().page.editSetLayer!);
      await act(async () => {
        hook.getCurrent().page.menuCommands?.['code.format']?.();
      });
      await vi.waitFor(() =>
        expect(
          layer.findAllByTestId('code-edit-set-apply').length,
        ).toBeGreaterThan(0),
      );
      await act(async () => {
        layer.findAllByTestId('code-edit-set-apply')[0].props.onPress();
      });
      await vi.waitFor(() => expect(machine.apply).toHaveBeenCalledTimes(1));
      // The saved-byte read after the acknowledged Format returns the original hash again.
      await hook.rerender({ text: formatted, hash: formattedHash });
      await act(async () => {
        await hook.getCurrent().page.controller?.checkProblems();
      });
      await act(async () => {
        deliver({
          status: 'ok',
          revision: 1,
          servers: [server],
          diagnostics: {
            'src/a.ts': {
              ts: {
                state: 'ready',
                version: 1,
                generation: 'g1',
                items: [
                  {
                    serverId: 'ts',
                    path: 'src/a.ts',
                    severity: 'error',
                    message: 'Wrong type',
                    range: {
                      start: { line: 0, character: 8 },
                      end: { line: 0, character: 13 },
                    },
                  },
                ],
              },
            },
          },
        });
      });
      await act(async () => {
        expect(await hook.getCurrent().producer?.ask?.run()).toBe(true);
      });
      const draftId = navigation.push.mock.calls[0]?.[0].params.draftId;
      const draft = readNewSessionDraftFromRepository({
        scope: settingsScope,
        draftId,
      });
      expect(draft?.input).toContain(formatted);
      expect(draft?.input).not.toContain(unformatted);
      expect(hook.getCurrent().editor.readSnapshot()).toMatchObject({
        savedText: formatted,
        dirty: false,
      });
    } finally {
      await hook.unmount();
      saveAccountSettings(
        settingsScope,
        settingsParse(previous.settings),
        previous.version ?? 0,
      );
    }
  });

  it.each([false, true])(
    'asks about every open file and saves a noncurrent dirty holder first (save fails: %s)',
    async (saveFails) => {
      const first = 'const a = 1;\n\nmissingA();';
      const second = 'const b = 1;\n\nmissingB();';
      const savedSecond = 'const b = 2;\n\nmissingB();';
      machine.query.mockResolvedValue({
        status: 'ok',
        kind: 'diagnostics',
        diagnostics: [],
        hasMore: false,
      });
      const diagnostics: LanguageIntelligenceWatchResult = {
        status: 'ok',
        revision: 1,
        servers: [server],
        diagnostics: Object.fromEntries(
          ['a', 'b'].map((id) => [
            `src/${id}.ts`,
            {
              ts: {
                state: 'ready',
                version: 1,
                generation: 'g1',
                items: [
                  {
                    serverId: 'ts',
                    path: `src/${id}.ts`,
                    severity: 'error',
                    message: `Unknown ${id}`,
                    range: {
                      start: { line: 2, character: 0 },
                      end: { line: 2, character: 8 },
                    },
                  },
                ],
              },
            },
          ]),
        ),
      };
      let deliver!: (answer: LanguageIntelligenceWatchResult) => void;
      machine.watch.mockImplementationOnce(
        (_machine, _request, options: { signal: AbortSignal }) =>
          new Promise<LanguageIntelligenceWatchResult>((resolve, reject) => {
            deliver = resolve;
            options.signal.addEventListener(
              'abort',
              () => reject(options.signal.reason),
              { once: true },
            );
          }),
      );
      const events: string[] = [];
      actionBoundary.read.mockReset().mockImplementation(async () => {
        events.push('save');
        return saveFails
          ? { success: false, error: 'Write failed' }
          : { success: true, hash: 'saved-b' };
      });
      const dispose = registerComposerPresentationTarget(
        { kind: 'session', sessionId: 'diagnostics-session' },
        {
          readRevision: () => 0,
          replace: () => 0,
          focusComposer: () => {
            events.push('focus');
          },
        },
      );
      const previous =
        storage.getState().reviewCommentsDraftsByWorkspaceCacheKey;
      storage.setState({ reviewCommentsDraftsByWorkspaceCacheKey: {} });
      const hook = await renderHook(
        () => {
          const editor = useRetainedEditor('a', first, true);
          const otherEditor = useRetainedEditor('b', second, false);
          const editors = [editor, otherEditor];
          const page = useFilePageCodeIntelligence(
            input({
              liveValue: editor.liveValue,
              editorHandleRef: editor.editorHandleRef,
              getUnsaved: () => editor.readSnapshot().dirty,
              sessionId: 'diagnostics-session',
            }),
          );
          const producer = useCodeIntelligencePaneProducer('intelligence-page');
          return { page, editors, producer };
        },
        { wrapper: PageWrapper },
      );
      try {
        await act(async () => {
          hook.getCurrent().editors[1]!.startEditingFile();
        });
        await act(async () => {
          hook.getCurrent().editors[1]!.onEditorChange(savedSecond);
        });
        expect(hook.getCurrent().page.controller).not.toBeNull();
        await act(async () => {
          await hook.getCurrent().page.controller?.checkProblems();
        });
        await act(async () => {
          deliver(diagnostics);
        });
        expect(
          Object.keys(
            hook.getCurrent().page.controller?.getDiagnosticsProjection()
              .entries ?? {},
          ),
        ).toEqual(['src/a.ts', 'src/b.ts']);
        await vi.waitFor(() =>
          expect(hook.getCurrent().producer?.ask).not.toBeNull(),
        );
        const label = hook.getCurrent().producer?.ask?.label;
        let asked = false;
        await act(async () => {
          asked = (await hook.getCurrent().producer?.ask?.run()) ?? false;
        });
        const drafts = Object.values(
          storage.getState().reviewCommentsDraftsByWorkspaceCacheKey,
        ).flat();
        if (saveFails) {
          expect(asked).toBe(false);
          expect(drafts).toEqual([]);
          expect(events).toEqual(['save']);
          expect(navigation.alert).toHaveBeenCalledWith(
            'common.error',
            'files.fileWriteFailed',
          );
        } else {
          expect(asked).toBe(true);
          expect(
            drafts.map((draft) => [
              draft.filePath,
              draft.snapshot.selectedLines,
            ]),
          ).toEqual([
            ['src/a.ts', ['missingA();']],
            ['src/b.ts', ['missingB();']],
          ]);
          expect(events).toEqual(['save', 'focus']);
        }
        expect(label).toContain('saveAndAsk');
      } finally {
        await hook.unmount();
        dispose();
        storage.setState({ reviewCommentsDraftsByWorkspaceCacheKey: previous });
      }
    },
  );
  it('keeps feeding the Problems tab after the page steps back for it, until the page closes', async () => {
    let setActive: (value: boolean) => void = () => {};
    const hook = await renderHook(
      () => {
        const [active, set] = React.useState(true);
        setActive = set;
        useFilePageCodeIntelligence(input({ active }));
        return useCodeIntelligencePaneProducer('intelligence-page');
      },
      { wrapper: PageWrapper },
    );
    try {
      await vi.waitFor(() => expect(hook.getCurrent()?.path).toBe('src/a.ts'));
      // Choosing Problems in the same column makes the File page inactive; the tab must not vanish with it.
      await act(async () => {
        setActive(false);
      });
      expect(hook.getCurrent()?.path).toBe('src/a.ts');
    } finally {
      await hook.unmount();
    }
  });
  it.each([true, false])(
    'checks the page for problems from the Problems tab button like the page command (page active: %s)',
    async (pageActive) => {
      machine.query.mockResolvedValue({
        status: 'ok',
        kind: 'diagnostics',
        diagnostics: [],
        hasMore: false,
      });
      let setActive: (value: boolean) => void = () => {};
      const hook = await renderHook(
        () => {
          const [active, set] = React.useState(true);
          setActive = set;
          return useFilePageCodeIntelligence(input({ active }));
        },
        { wrapper: PageWrapper },
      );
      try {
        const screen = await renderScreen(
          <PageWrapper>
            <CodeIntelligencePaneTab
              scopeId="intelligence-page"
              kind="problems"
              active
            />
          </PageWrapper>,
        );
        await vi.waitFor(() =>
          expect(
            screen.findAllByTestId('code-problems-check').length,
          ).toBeGreaterThan(0),
        );
        // Pressing a control in the side column moves pane focus off the File page.
        if (!pageActive)
          await act(async () => {
            setActive(false);
          });
        await act(async () => {
          screen.findAllByTestId('code-problems-check')[0]?.props.onPress();
        });
        await vi.waitFor(() =>
          expect(machine.query).toHaveBeenCalledWith(
            'm1',
            expect.objectContaining({ kind: 'diagnostics' }),
            expect.anything(),
          ),
        );
      } finally {
        await hook.unmount();
      }
    },
  );

  it('says there is nothing to show, without actions, when Info at cursor finds no name', async () => {
    const noop = () => {};
    const screen = await renderScreen(
      <CodeIntelligenceCard
        open
        anchor={{ x: 10, y: 10, width: 4, height: 16 }}
        model={{
          name: null,
          names: [],
          hover: null,
          diagnostic: null,
          outsidePath: null,
          progress: null,
          searching: false,
          sourceLabel: null,
          references: null,
        }}
        onRequestClose={noop}
        onDefinition={noop}
        onReferences={noop}
        onCopyName={noop}
        onCopyPath={noop}
        onChooseName={noop}
        onOpenReference={noop}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.findAllByTestId('code-hover-card').length).toBeGreaterThan(
        0,
      ),
    );
    expect(
      screen.findAllByTestId('code-hover-card-empty').length,
    ).toBeGreaterThan(0);
    expect(screen.findAllByTestId('code-hover-card-definition')).toHaveLength(
      0,
    );
    expect(screen.findAllByTestId('code-hover-card-references')).toHaveLength(
      0,
    );
  });

  it('leads the fix list with the fixes for the problem, before whole-file source actions', async () => {
    const range = {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    };
    const action = (title: string, kind: string) => ({
      serverId: 'ts',
      title,
      kind,
      range,
      files: [],
      hasCommand: false,
    });
    machine.query.mockResolvedValue({
      status: 'ok',
      kind: 'hover',
      sections: [],
    });
    machine.preview.mockResolvedValue({
      status: 'ok',
      kind: 'codeActions',
      fileHash: 'disk',
      actions: [
        action('Organize Imports', 'source.organizeImports'),
        action('Sort Imports', 'source.sortImports'),
        action('Update import from "../retry"', 'quickfix'),
      ],
    });
    const hook = await renderHook(() => useFilePageCodeIntelligence(input()), {
      wrapper: PageWrapper,
    });
    await act(async () => {
      await hook.getCurrent().controller?.hover({ line: 0, character: 7 });
    });
    const layer = hook.getCurrent().editSetLayer;
    if (!layer) throw new Error('Expected the edit-set layer');
    const screen = await renderScreen(layer);
    await act(async () => {
      hook.getCurrent().menuCommands?.['code.quickFix']();
    });
    await vi.waitFor(() =>
      expect(screen.findAllByTestId('code-fix-2').length).toBeGreaterThan(0),
    );
    expect(
      ['code-fix-0', 'code-fix-1', 'code-fix-2'].map(
        (id) => screen.findAllByTestId(id)[0]?.props.title,
      ),
    ).toEqual([
      'Update import from "../retry"',
      'Organize Imports',
      'Sort Imports',
    ]);
  });
});
