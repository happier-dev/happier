import type { editor } from 'monaco-editor';
import type { CodeEditorHandle, CodeEditorHistory } from '../codeEditorTypes';
import { minimalCodeEditorEdit } from '../codeEditorDocumentEdit';

/** Public Monaco boundary; the surface owns mounting and command admission. */
export function createMonacoCommands(engine: editor.IStandaloneCodeEditor, model: editor.ITextModel, options: Readonly<{
    isComposing: () => boolean;
    isReadOnly: () => boolean;
    openFind: () => void;
    navigateChange: (direction: 1 | -1) => void;
    onHistory: () => void;
}>): Pick<CodeEditorHandle, 'revealLine' | 'runCommand'> & Readonly<{ getHistory: () => CodeEditorHistory }> {
    const getHistory = (): CodeEditorHistory => ({ canUndo: model.canUndo?.() ?? false, canRedo: model.canRedo?.() ?? false });
    const revealLine: CodeEditorHandle['revealLine'] = (requestedLine, reveal) => {
        const line = Math.max(1, Math.min(model.getLineCount(), Math.floor(requestedLine) || 1));
        engine.setPosition({ lineNumber: line, column: 1 });
        if (reveal?.select) engine.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) });
        if (reveal?.top) {
            const topLine = Math.max(1, Math.min(model.getLineCount(), Math.floor(reveal.top.line) || 1));
            engine.setScrollTop(Math.max(0, engine.getTopForLineNumber(topLine) - reveal.top.offset), reveal.behavior === 'smooth' ? 0 : 1);
        } else engine.revealLineInCenter(line, reveal?.behavior === 'smooth' ? 0 : 1);
        if (reveal?.focus) engine.focus();
    };
    const runCommand: CodeEditorHandle['runCommand'] = (command) => {
        if (options.isComposing()) return;
        if (command === 'find') { options.openFind(); return; }
        if (command === 'nextChange' || command === 'prevChange') { options.navigateChange(command === 'nextChange' ? 1 : -1); return; }
        if (command === 'moveLeft' || command === 'moveRight') { engine.trigger('happier.command', command === 'moveLeft' ? 'cursorLeft' : 'cursorRight', null); return; }
        if (options.isReadOnly()) return;
        if (typeof command === 'object') {
            if ('replaceDocument' in command) {
                const change = minimalCodeEditorEdit(model.getValue(), command.replaceDocument.replace(/\r\n|\r|\n/g, model.getEOL()));
                if (!change) return;
                const start = model.getPositionAt(change.from), end = model.getPositionAt(change.to);
                engine.pushUndoStop();
                engine.executeEdits('happier.command', [{ range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: change.insert, forceMoveMarkers: true }]);
                engine.pushUndoStop();
            } else engine.trigger('happier.command', 'type', { text: command.insert });
        } else if (command === 'indent' || command === 'outdent' || command === 'undo' || command === 'redo') {
            engine.trigger('happier.command', { indent: 'editor.action.indentLines', outdent: 'editor.action.outdentLines', undo: 'undo', redo: 'redo' }[command], null);
        }
        options.onHistory();
    };
    return { revealLine, runCommand, getHistory };
}
