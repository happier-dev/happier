// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { FilesEditorAiSuggestionsV1Schema } from '@happier-dev/protocol/account/settings/accountSettings';
import type {
  LanguageIntelligenceQueryInput,
  LanguageIntelligenceQueryResult,
} from '@happier-dev/protocol/machines/languageIntelligence';
import { createCodeIntelligenceController } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import { bindCodeIntelligenceEditor } from '@/sync/domains/workspaces/languageIntelligence/bindCodeIntelligenceEditor';
import type { CodeEditorHandle } from '../codeEditorTypes';
import { createMonacoInlineSuggestions } from './monacoInlineSuggestions';
import { createMonacoNextEdit } from './monacoNextEdit';

type Range = Monaco.IRange;
/** Monaco is the engine boundary: a line-aware model and editor with Monaco's public shapes. Everything above it is real. */
function engine(initial: string) {
  let text = initial;
  let version = 1;
  let position = { lineNumber: 1, column: 1 };
  const node = document.createElement('div');
  const changed = new Set<
    (event: Monaco.editor.IModelContentChangedEvent) => void
  >();
  const selected = new Set<() => void>();
  let decorations: Monaco.editor.IModelDeltaDecoration[] = [];
  const history: string[] = [];
  const lines = () => text.split('\n');
  const offsetAt = (at: { lineNumber: number; column: number }) =>
    lines()
      .slice(0, at.lineNumber - 1)
      .reduce((sum, line) => sum + line.length + 1, 0) +
    at.column -
    1;
  const positionAt = (offset: number) => {
    let rest = offset;
    for (const [index, line] of lines().entries()) {
      if (rest <= line.length)
        return { lineNumber: index + 1, column: rest + 1 };
      rest -= line.length + 1;
    }
    return { lineNumber: lines().length, column: 1 };
  };
  const model = {
    uri: { scheme: 'inmemory', path: '/src/a.ts' },
    getValue: () => text,
    getVersionId: () => version,
    getEOL: () => '\n',
    getLanguageId: () => 'typescript',
    getLineCount: () => lines().length,
    getLineMaxColumn: (line: number) => lines()[line - 1]!.length + 1,
    getLineContent: (line: number) => lines()[line - 1]!,
    getOffsetAt: offsetAt,
    getPositionAt: positionAt,
  } as unknown as Monaco.editor.ITextModel;
  const disposable = { dispose() {} };
  function replace(edits: readonly { range: Range; text: string }[]) {
    const resolved = edits
      .map((edit) => ({
        from: offsetAt({
          lineNumber: edit.range.startLineNumber,
          column: edit.range.startColumn,
        }),
        to: offsetAt({
          lineNumber: edit.range.endLineNumber,
          column: edit.range.endColumn,
        }),
        text: edit.text,
      }))
      .sort((a, b) => b.from - a.from);
    for (const edit of resolved)
      text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
    version++;
    const event = {
      changes: resolved.map((edit) => ({
        rangeOffset: edit.from,
        rangeLength: edit.to - edit.from,
        text: edit.text,
      })),
    } as Monaco.editor.IModelContentChangedEvent;
    for (const listener of changed) listener(event);
  }
  const editor = {
    createContextKey<T>(_key: string, defaultValue: T) {
      let value = defaultValue;
      return { set(next: T) { value = next; }, reset() { value = defaultValue; }, get: () => value };
    },
    addAction: () => disposable,
    getModel: () => model,
    getPosition: () => position,
    getSelections: () => [{ isEmpty: () => true }],
    getDomNode: () => node,
    setPosition(next: { lineNumber: number; column: number }) {
      position = next;
      for (const listener of selected) listener();
    },
    trigger: vi.fn(),
    focus() {},
    revealPositionInCenterIfOutsideViewport: vi.fn(),
    onDidChangeModelContent: (
      listener: (event: Monaco.editor.IModelContentChangedEvent) => void,
    ) => {
      changed.add(listener);
      return { dispose: () => changed.delete(listener) };
    },
    onDidChangeCursorSelection: (listener: () => void) => {
      selected.add(listener);
      return { dispose: () => selected.delete(listener) };
    },
    onDidCompositionStart: () => disposable,
    onDidCompositionEnd: () => disposable,
    createDecorationsCollection: () => ({
      set: (next: Monaco.editor.IModelDeltaDecoration[]) => {
        decorations = next;
      },
      clear: () => {
        decorations = [];
      },
    }),
    changeViewZones: () => {},
    pushUndoStop: () => {
      history.push('stop');
    },
    executeEdits: (
      _source: string,
      edits: { range: Range; text: string }[],
    ) => {
      history.push('edit');
      replace(edits);
      return true;
    },
  } as unknown as Monaco.editor.IStandaloneCodeEditor;
  const monaco = {
    KeyCode: { Tab: 2, RightArrow: 17, Escape: 9, Backslash: 88 },
    KeyMod: { CtrlCmd: 2048, WinCtrl: 256, Alt: 512 },
    languages: { registerInlineCompletionsProvider: () => disposable },
  } as unknown as typeof Monaco;
  return {
    editor,
    model,
    monaco,
    node,
    history,
    text: () => text,
    decorations: () => decorations,
    type(
      at: { lineNumber: number; column: number },
      length: number,
      insert: string,
    ) {
      const start = offsetAt(at);
      replace([
        {
          range: {
            startLineNumber: at.lineNumber,
            startColumn: at.column,
            endLineNumber: at.lineNumber,
            endColumn: at.column + length,
          },
          text: insert,
        },
      ]);
      editor.setPosition(positionAt(start + insert.length));
    },
    key(key: string) {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    },
  };
}

function fixture(
  patch: Partial<
    ReturnType<typeof FilesEditorAiSuggestionsV1Schema.parse>
  > = {},
) {
  const e = engine(
    `function old() {}\n${'// unchanged 🦊\n'.repeat(40)}old();\n`,
  );
  const settings = FilesEditorAiSuggestionsV1Schema.parse({
    enabled: true,
    nextEditEnabled: true,
    mode: 'onRequest',
    connectionId: 'source',
    modelId: 'edit-model',
    ...patch,
  });
  const requests: {
    input: LanguageIntelligenceQueryInput;
    resolve(value: LanguageIntelligenceQueryResult): void;
  }[] = [];
  const model = {
    id: 'edit-model',
    name: 'Edit model',
    contextWindowTokens: 32768,
    nextEdit: {
      operationId: 'edit',
      tokenAccounting: 'utf8-bytes' as const,
      outputTokens: 4096,
      promptOverheadTokens: 32,
    },
  };
  const controller = createCodeIntelligenceController({
    scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' },
    path: 'src/a.ts',
    languageId: 'typescript',
    accountLifetime: {
      scope: { serverId: 'home', accountId: 'account' },
      isCurrent: () => true,
      onRetire: () => ({ dispose() {} }),
    },
    getText: () => e.text(),
    query: async () => ({ status: 'unavailable', reason: 'no_capable_server' }),
    openLocation() {},
    // The Machine query is the scripted boundary.
    inlineSuggestions: {
      getSettings: () => settings,
      getModel: () => model,
      query: (input) =>
        new Promise((resolve) => requests.push({ input, resolve })),
    },
  });
  const inline = createMonacoInlineSuggestions(e.monaco, e.editor, e.model, {
    readOnly: () => false,
  });
  const flushes: string[] = [];
  const nextEdit = createMonacoNextEdit(e.editor, e.model, {
    getContext: inline.handle.getContext,
    readOnly: () => false,
    beforeApply: () => flushes.push('before'),
    afterApply: () => flushes.push('after'),
  });
  const handle = {
    getValue: () => e.text(),
    inlineSuggestions: inline.handle,
    setLanguageIntelligence: (
      port: Parameters<
        NonNullable<CodeEditorHandle['setLanguageIntelligence']>
      >[0],
    ) => nextEdit.setPort(port?.nextEditSuggestions ?? null),
  };
  const unbind = bindCodeIntelligenceEditor(
    controller,
    handle as unknown as CodeEditorHandle,
    { path: 'src/a.ts', inlayHints: 'off', semanticHighlighting: false },
  );
  return {
    ...e,
    controller,
    requests,
    nextEdit,
    flushes,
    /** The person renames the function on line 1; the model predicts the distant call site. */
    async renameAndPredict() {
      e.editor.setPosition({ lineNumber: 1, column: 13 });
      e.type({ lineNumber: 1, column: 10 }, 3, 'renamed');
      controller.nextEditSuggestions.trigger();
      await vi.runAllTimersAsync();
    },
    async answer(index = 0) {
      requests[index]!.resolve({
        status: 'ok',
        kind: 'ai.nextEdit',
        version: requests[index]!.input.version!,
        edits: [
          {
            path: 'src/a.ts',
            range: {
              start: { line: 41, character: 0 },
              end: { line: 41, character: 3 },
            },
            oldText: 'old',
            newText: 'renamed',
          },
        ],
      });
      await vi.runAllTimersAsync();
    },
    dispose() {
      unbind();
      nextEdit.dispose();
      inline.dispose();
      controller.dispose();
    },
  };
}
const classes = (f: ReturnType<typeof fixture>) =>
  f
    .decorations()
    .flatMap((item) =>
      [
        item.options.inlineClassName,
        item.options.after?.inlineClassName,
        item.options.before?.inlineClassName,
      ].filter(Boolean),
    );
afterEach(() => vi.useRealTimers());

describe('Monaco next-edit marker, preview and apply through the shared controller', () => {
  it('marks the predicted place, previews on the first Tab and applies once as one undo step on the second', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.renameAndPredict();
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.input.kind).toBe('ai.nextEdit');
      await f.answer();
      expect(f.controller.nextEditSuggestions.getSnapshot().status).toBe(
        'ready',
      );
      const target = f
        .decorations()
        .find(
          (item) => item.options.inlineClassName === 'happier-next-edit-target',
        );
      expect(target?.range).toMatchObject({
        startLineNumber: 42,
        startColumn: 1,
        endLineNumber: 42,
        endColumn: 4,
      });
      expect(
        f
          .decorations()
          .filter(
            (item) =>
              item.options.after?.inlineClassName === 'happier-next-edit-hint',
          )[0]?.range.startLineNumber,
      ).toBe(1);

      expect(f.key('Tab')).toBe(true);
      expect(f.controller.nextEditSuggestions.getSnapshot().status).toBe(
        'preview',
      );
      expect(f.editor.getPosition()).toMatchObject({
        lineNumber: 42,
        column: 1,
      });
      expect(f.text()).toContain('\nold();');
      expect(classes(f)).toEqual(
        expect.arrayContaining([
          'happier-next-edit-removed',
          'happier-next-edit-added',
        ]),
      );
      expect(
        f
          .decorations()
          .find(
            (item) =>
              item.options.after?.inlineClassName === 'happier-next-edit-added',
          )?.options.after?.content,
      ).toBe('renamed');

      const before = f.history.length;
      expect(f.key('Tab')).toBe(true);
      expect(f.text().endsWith('\nrenamed();\n')).toBe(true);
      expect(f.history.slice(before)).toEqual(['stop', 'edit', 'stop']);
      expect(f.flushes).toEqual(['before', 'after']);
      expect(f.decorations()).toEqual([]);
      // Nothing is left to apply: a third Tab is the editor's own again.
      expect(f.key('Tab')).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it('dismisses on Escape and never renders a candidate made stale by a later edit', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.renameAndPredict();
      await f.answer();
      expect(f.nextEdit.dismiss()).toBe(true);
      expect(f.decorations()).toEqual([]);
      expect(f.key('Tab')).toBe(false);

      f.controller.nextEditSuggestions.trigger();
      await vi.runAllTimersAsync();
      expect(f.requests).toHaveLength(2);
      // The person keeps typing before the answer lands: the late answer must never draw.
      f.type({ lineNumber: 1, column: 17 }, 0, 'X');
      await f.answer(1);
      expect(
        f.controller.nextEditSuggestions.getSnapshot().suggestion,
      ).toBeNull();
      expect(f.decorations()).toEqual([]);
      expect(f.key('Tab')).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it('renders nothing and leaves Tab alone while the preference is off', async () => {
    vi.useFakeTimers();
    const f = fixture({ nextEditEnabled: false });
    try {
      await f.renameAndPredict();
      expect(f.requests).toHaveLength(0);
      expect(f.decorations()).toEqual([]);
      expect(f.key('Tab')).toBe(false);
    } finally {
      f.dispose();
    }
  });
});
