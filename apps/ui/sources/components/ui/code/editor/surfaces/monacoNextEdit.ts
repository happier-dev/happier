import type * as Monaco from 'monaco-editor';
import type { LanguageIntelligenceRange } from '@happier-dev/protocol/machines/languageIntelligence';
import type { CodeNextEditAdapter } from '@/sync/domains/workspaces/languageIntelligence/codeNextEditSuggestions';
import type {
  CodeEditorCommand,
  CodeEditorInlineContext,
  CodeEditorLanguageIntelligence,
} from '../codeEditorTypes';
import { t } from '@/text';

type Port = NonNullable<CodeEditorLanguageIntelligence['nextEditSuggestions']>;
type Decoration = Monaco.editor.IModelDeltaDecoration;

const engineRange = (value: LanguageIntelligenceRange): Monaco.IRange => ({
  startLineNumber: value.start.line + 1,
  startColumn: value.start.character + 1,
  endLineNumber: value.end.line + 1,
  endColumn: value.end.character + 1,
});

/**
 * Monaco's projection of the shared next-edit operation (P7-R33): a quiet mark where the edit lands, then the
 * Replace-style inline diff at it. The controller owns candidates, validation and policy; this only draws, routes
 * Tab/Escape and applies the validated edits as one guarded undo step.
 */
export function createMonacoNextEdit(
  editor: Monaco.editor.IStandaloneCodeEditor,
  model: Monaco.editor.ITextModel,
  options: Readonly<{
    getContext: () => CodeEditorInlineContext | null;
    readOnly: () => boolean;
    beforeApply?: () => void;
    afterApply?: () => void;
  }>,
) {
  let port: Port | null = null;
  let keys = true;
  let stop: (() => void) | null = null;
  const collection = editor.createDecorationsCollection();
  let zones: string[] = [];
  const key = (content: string, at: Monaco.IRange): Decoration => ({
    range: at,
    options: { showIfCollapsed: true, after: { content, inlineClassName: 'happier-next-edit-key' } },
  });
  const hint = (content: string, at: Monaco.IRange): Decoration => ({
    range: at,
    options: { showIfCollapsed: true, after: { content, inlineClassName: 'happier-next-edit-hint' } },
  });
  const lineEnd = (line: number): Monaco.IRange => {
    const column = model.getLineMaxColumn(line);
    return {
      startLineNumber: line,
      startColumn: column,
      endLineNumber: line,
      endColumn: column,
    };
  };
  function clearZones() {
    if (!zones.length) return;
    const owned = zones;
    zones = [];
    editor.changeViewZones?.((accessor) => {
      for (const id of owned) accessor.removeZone(id);
    });
  }
  function render() {
    clearZones();
    const snapshot = port?.getSnapshot();
    const suggestion = snapshot?.suggestion;
    if (
      !snapshot ||
      !suggestion ||
      (snapshot.status !== 'ready' && snapshot.status !== 'preview')
    ) {
      collection.clear();
      return;
    }
    const decorations: Decoration[] = [];
    const first = suggestion.edits[0];
    if (!first) {
      collection.clear();
      return;
    }
    const targetLine = first.range.start.line + 1;
    if (snapshot.status === 'ready') {
      for (const edit of suggestion.edits) {
        const range = engineRange(edit.range);
        decorations.push(
          edit.oldText
            ? {
                range,
                options: { inlineClassName: 'happier-next-edit-target' },
              }
            : {
                range,
                options: {
                  showIfCollapsed: true,
                  before: {
                    content: ' ',
                    inlineClassName: 'happier-next-edit-target',
                  },
                },
              },
        );
      }
      const caret = editor.getPosition()?.lineNumber ?? targetLine;
      decorations.push(
        ...(keys ? [key('Tab', lineEnd(caret))] : []),
        hint(
          caret === targetLine
            ? t('files.editing.aiSuggestions.nextEditHere')
            : t('files.editing.aiSuggestions.nextEditAt', { line: targetLine }),
          lineEnd(caret),
        ),
      );
    } else {
      const added: { afterLine: number; text: string }[] = [];
      for (const edit of suggestion.edits) {
        const range = engineRange(edit.range);
        const multiline = /\r|\n/u.test(edit.newText);
        decorations.push({
          range,
          options: {
            showIfCollapsed: true,
            ...(edit.oldText
              ? { inlineClassName: 'happier-next-edit-removed' }
              : {}),
            ...(!multiline && edit.newText
              ? {
                  after: {
                    content: edit.newText,
                    inlineClassName: 'happier-next-edit-added',
                  },
                }
              : {}),
          },
        });
        if (multiline)
          added.push({ afterLine: range.endLineNumber, text: edit.newText });
      }
      const end = lineEnd(engineRange(first.range).endLineNumber);
      // Without keys (phone) the key row carries Apply and Dismiss; the diff itself is the preview.
      if (keys)
        decorations.push(
          key('Tab', end),
          hint(t('files.editing.aiSuggestions.nextEditApply'), end),
          key('Esc', end),
          hint(t('files.editing.aiSuggestions.nextEditDismiss'), end),
        );
      if (added.length && editor.changeViewZones)
        editor.changeViewZones((accessor) => {
          for (const item of added) {
            const lines = item.text.split(/\r\n|\r|\n/u);
            const node = document.createElement('div');
            node.className = 'happier-next-edit-zone';
            // A view zone sits outside the text layer: give it the text's own font and rhythm.
            const textLayer = editor.getDomNode?.()?.querySelector('.view-lines');
            const metrics = textLayer ? getComputedStyle(textLayer) : null;
            if (metrics) Object.assign(node.style, { fontFamily: metrics.fontFamily, fontSize: metrics.fontSize, lineHeight: metrics.lineHeight });
            node.style.whiteSpace = 'pre';
            const text = document.createElement('span');
            text.className = 'happier-next-edit-added';
            text.textContent = lines.join('\n');
            node.appendChild(text);
            zones.push(
              accessor.addZone({
                afterLineNumber: item.afterLine,
                heightInLines: lines.length,
                domNode: node,
              }),
            );
          }
        });
    }
    collection.set(decorations);
  }
  const adapter: CodeNextEditAdapter = {
    jump(position) {
      const target = {
        lineNumber: position.line + 1,
        column: position.character + 1,
      };
      editor.setPosition(target);
      editor.revealPositionInCenterIfOutsideViewport?.(target);
      editor.focus();
    },
    apply(edits, captured) {
      // The controller revalidated synchronously; the engine still refuses a newer buffer.
      if (
        options.readOnly() ||
        model.getVersionId() !== captured.version ||
        model.getValue() !== captured.text
      )
        return false;
      options.beforeApply?.();
      editor.pushUndoStop();
      const applied = editor.executeEdits(
        'happier.nextEdit',
        edits.map((edit) => ({
          range: engineRange(edit.range),
          text: edit.newText,
        })),
      );
      editor.pushUndoStop();
      options.afterApply?.();
      return applied !== false;
    },
  };
  function active() {
    const status = port?.getSnapshot().status;
    return (
      Boolean(port?.getSnapshot().suggestion) &&
      (status === 'ready' || status === 'preview')
    );
  }
  function tab() {
    const context = options.getContext();
    return Boolean(
      port &&
      context &&
      active() &&
      !options.readOnly() &&
      port.tab(context, model.getValue(), adapter),
    );
  }
  function dismiss() {
    const context = options.getContext();
    if (!port || context?.composing || context?.suggestWidgetOpen
      || (!active() && port.getSnapshot().status !== 'requesting')) return false;
    port!.dismiss();
    return true;
  }
  const keydown = (event: KeyboardEvent) => {
    if (
      event.isComposing ||
      event.key !== 'Tab' ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    if (tab()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const node = editor.getDomNode?.();
  node?.addEventListener('keydown', keydown, true);
  return {
    setPort(next: Port | null, keyHints = true) {
      keys = keyHints;
      if (next === port) { render(); return; }
      stop?.();
      stop = null;
      port = next;
      if (port) stop = port.subscribe(render);
      render();
    },
    active,
    dismiss,
    /** The phone accessory's Accept/Dismiss keys reach next edits through the same commands as ghost text. */
    command(command: CodeEditorCommand) {
      if (command === 'inlineSuggestAccept') return tab();
      if (command === 'inlineSuggestDismiss') return dismiss();
      return false;
    },
    dispose() {
      node?.removeEventListener('keydown', keydown, true);
      stop?.();
      stop = null;
      port = null;
      clearZones();
      collection.clear();
    },
  };
}
