import { ChangeSet, EditorSelection, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import { autocompletion, completionKeymap, startCompletion, acceptCompletion, closeCompletion, snippet, type Completion, type CompletionContext } from '@codemirror/autocomplete';
import { isolateHistory } from '@codemirror/commands';
import { parser as markdownParser } from '@lezer/markdown';
import { applyWorkspaceFileTextEdits } from '@happier-dev/protocol/machines/workspaceFilesReplace';
import type { LanguageIntelligenceCompletionItem, LanguageIntelligenceRange, LanguageIntelligenceSignatureHelp } from '@happier-dev/protocol/machines/languageIntelligence';
import type { CodeEditorLanguageIntelligence } from '../codeEditorTypes';
import { minimalCodeEditorEdit } from '../codeEditorDocumentEdit';
import { projectCodeSemanticTokens } from '../../model/codeSemanticTokens';

/** LSP item kinds translated to CodeMirror's public icon classes; unknown kinds stay neutral. */
const completionTypes: Readonly<Record<number, string>> = {
    1: 'text', 2: 'method', 3: 'function', 4: 'function', 5: 'property', 6: 'variable', 7: 'class',
    8: 'interface', 9: 'namespace', 10: 'property', 13: 'enum', 14: 'keyword', 20: 'enum', 21: 'constant', 22: 'class', 25: 'type',
};

/** Render the existing Markdown grammar with inert DOM: server HTML and URLs never become attributes. */
function documentationNode(value: string): HTMLElement {
    const root = document.createElement('div');
    const tags: Readonly<Record<string, string>> = { Paragraph: 'p', StrongEmphasis: 'strong', Emphasis: 'em', InlineCode: 'code',
        FencedCode: 'pre', CodeBlock: 'pre', CodeText: 'code', Blockquote: 'blockquote', BulletList: 'ul', OrderedList: 'ol', ListItem: 'li' };
    function append(node: ReturnType<typeof markdownParser.parse>['topNode'], parent: HTMLElement) {
        if (node.name.endsWith('Mark') || node.name === 'CodeInfo' || node.name === 'URL') return;
        if (node.name === 'Escape') { parent.append(document.createTextNode(value.slice(node.from + 1, node.to))); return; }
        const tag = tags[node.name], target = tag ? document.createElement(tag) : parent;
        let offset = node.from;
        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.from > offset) target.append(document.createTextNode(value.slice(offset, child.from)));
            append(child, target); offset = child.to;
        }
        if (offset < node.to) target.append(document.createTextNode(value.slice(offset, node.to)));
        if (target !== parent) parent.append(target);
    }
    append(markdownParser.parse(value).topNode, root);
    return root;
}

export function createCodeMirrorLanguageIntelligence(port: CodeEditorLanguageIntelligence, onSignature?: (help: LanguageIntelligenceSignatureHelp | null) => void): Readonly<{
    extensions: Extension[];
    command(view: EditorView, command: string): boolean;
    formatDocument(view: EditorView): Promise<void>;
    dispose(): void;
}> {
    let disposed = false;
    let formatting: Promise<void> = Promise.resolve();
    const pending = new Map<string, AbortController>();
    const cancel = () => { for (const request of pending.values()) request.abort(); pending.clear(); };
    const caps = () => port.getSnapshot().capabilities;
    const position = (editor: EditorView, offset: number) => { const line = editor.state.doc.lineAt(offset); return { line: line.number - 1, character: offset - line.from }; };
    const offset = (editor: EditorView, value: LanguageIntelligenceRange['start']) => {
        const line = editor.state.doc.line(value.line + 1);
        if (value.character < 0 || value.character > line.length) throw new RangeError('invalid_position');
        return line.from + value.character;
    };
    const request = async (editor: EditorView, kind: Parameters<CodeEditorLanguageIntelligence['request']>[0], options: Parameters<CodeEditorLanguageIntelligence['request']>[1], signal?: AbortSignal) => {
        if (disposed || signal?.aborted) return null;
        pending.get(kind)?.abort();
        const abort = new AbortController(); pending.set(kind, abort);
        const doc = editor.state.doc;
        const stop = () => abort.abort(); signal?.addEventListener('abort', stop, { once: true });
        try {
            const response = await port.request(kind, options, abort.signal);
            return disposed || abort.signal.aborted || editor.state.doc !== doc ? null : response;
        } catch { return null; }
        finally { signal?.removeEventListener('abort', stop); if (pending.get(kind) === abort) pending.delete(kind); }
    };
    const setRange = StateEffect.define<DecorationSet>();
    const setOccurrences = StateEffect.define<DecorationSet>();
    const decorationLayer = (set: typeof setRange) => StateField.define({ create: () => Decoration.none, update(value, transaction) {
        if (transaction.docChanged) value = Decoration.none;
        for (const effect of transaction.effects) if (effect.is(set)) value = effect.value;
        return value;
    }, provide: field => EditorView.decorations.from(field) });
    class Hint extends WidgetType {
        constructor(readonly label: string, readonly tooltip?: string) { super(); }
        eq(other: Hint) { return this.label === other.label && this.tooltip === other.tooltip; }
        toDOM() { const node = document.createElement('span'); node.className = 'happier-editor-inlay'; node.textContent = this.label; if (this.tooltip) node.title = this.tooltip; return node; }
    }
    async function refreshRange(editor: EditorView) {
        const visible = editor.visibleRanges;
        if (disposed || !visible.length || !editor.dom.isConnected) return;
        const viewport = { start: position(editor, visible[0].from), end: position(editor, visible[visible.length - 1].to) };
        const doc = editor.state.doc;
        const [hints, semantic] = await Promise.all([
            caps()?.inlayHint && port.inlayHints !== 'off' ? request(editor, 'inlayHint', { range: viewport }) : null,
            (caps()?.semanticTokensRange || caps()?.semanticTokensDelta) && port.semanticHighlighting ? request(editor, 'semanticTokens', { range: viewport }) : null,
        ]);
        if (disposed || editor.state.doc !== doc || editor.visibleRanges[0]?.from !== visible[0].from
            || editor.visibleRanges.at(-1)?.to !== visible.at(-1)?.to) return;
        const decorations: ReturnType<Decoration['range']>[] = [];
        if (hints?.status === 'ok' && hints.kind === 'inlayHint') for (const hint of hints.hints) {
            if (port.inlayHints === 'parameters' && hint.kind !== 2) continue;
            const from = offset(editor, hint.position);
            if (from < visible[0].from || from > visible[visible.length - 1].to) continue;
            decorations.push(Decoration.widget({ widget: new Hint(`${hint.paddingLeft ? ' ' : ''}${hint.label}${hint.paddingRight ? ' ' : ''}`, hint.tooltip), side: 1 }).range(from));
        }
        if (semantic?.status === 'ok' && semantic.kind === 'semanticTokens') for (const [line, tokens] of projectCodeSemanticTokens(semantic.tokens, viewport)) {
            for (const token of tokens) {
                const from = offset(editor, { line: line - 1, character: token.start }), to = from + token.end - token.start;
                if (to <= doc.length) decorations.push(Decoration.mark({ class: `happier-editor-semantic-${token.role}` }).range(from, to));
            }
        }
        editor.dispatch({ effects: setRange.of(Decoration.set(decorations, true)) });
    }
    async function refreshOccurrences(editor: EditorView) {
        if (disposed || !editor.dom.isConnected) return;
        const doc = editor.state.doc, selection = editor.state.selection;
        const occurrences = caps()?.documentHighlight && editor.hasFocus && selection.main.empty
            ? await request(editor, 'documentHighlight', { position: position(editor, selection.main.head) }) : null;
        if (disposed || editor.state.doc !== doc || editor.state.selection !== selection) return;
        const decorations: ReturnType<Decoration['range']>[] = [];
        if (occurrences?.status === 'ok' && occurrences.kind === 'documentHighlight') for (const item of occurrences.highlights) {
            const from = offset(editor, item.range.start), to = offset(editor, item.range.end);
            if (to > from) decorations.push(Decoration.mark({ class: 'happier-editor-occurrence' }).range(from, to));
        }
        editor.dispatch({ effects: setOccurrences.of(Decoration.set(decorations, true)) });
    }
    const resolved = new Map<string, LanguageIntelligenceCompletionItem>();
    const source = async (context: CompletionContext) => {
        if (!caps()?.completion || context.view?.composing || !context.state.selection.main.empty) return null;
        if (!context.view) return null;
        const editor = context.view;
        const before = context.state.doc.sliceString(Math.max(0, context.pos - 1), context.pos);
        const triggered = caps()?.completionTriggerCharacters?.includes(before);
        const word = context.matchBefore(/[\p{L}\p{N}_$]+/u);
        if (!context.explicit && !triggered && !word) return null;
        const abort = new AbortController(); context.addEventListener('abort', () => abort.abort(), { onDocChange: true });
        const response = await request(editor, 'completion', { position: position(editor, context.pos), completionContext: {
            triggerKind: context.explicit ? 1 : triggered ? 2 : 1, ...(triggered ? { triggerCharacter: before } : {}) } }, abort.signal);
        if (response?.status !== 'ok' || response.kind !== 'completion' || context.aborted) return null;
        resolved.clear();
        const doc = editor.state.doc;
        async function resolve(item: LanguageIntelligenceCompletionItem) {
            const key = JSON.stringify([item.serverId, item.itemId]);
            if (resolved.has(key)) return resolved.get(key)!;
            const result = caps()?.completionResolve ? await request(editor, 'completionResolve', { serverId: item.serverId, itemId: item.itemId }, abort.signal) : null;
            const value = result?.status === 'ok' && result.kind === 'completionResolve' ? { ...item, ...result.item } : item;
            if (editor.state.doc === doc && !abort.signal.aborted) resolved.set(key, value);
            return value;
        }
        return { from: word?.from ?? context.pos, options: response.items.map((item): Completion => ({
            label: item.label, detail: item.detail, type: item.kind === undefined ? undefined : completionTypes[item.kind],
            ...(item.filterText ? { displayLabel: item.label, label: item.filterText } : {}),
            info: async () => { const value = await resolve(item); const node = document.createElement('div');
                if (value.detail) { const detail = document.createElement('pre'); detail.textContent = value.detail; node.append(detail); }
                if (value.documentation) node.append(documentationNode(value.documentation));
                return node; },
            apply: (target, completion, from, to) => { void (async () => {
                const value = await resolve(item);
                if (disposed || target.state.doc !== doc || target.composing || abort.signal.aborted) return;
                const edit = value.textEdit;
                const replacement = edit && ('range' in edit ? edit.range : edit.replace);
                const start = replacement ? offset(target, replacement.start) : from, end = replacement ? offset(target, replacement.end) : to;
                const insert = edit?.newText ?? value.insertText ?? value.label;
                const additional = (value.additionalTextEdits ?? []).map(edit => ({ from: offset(target, edit.range.start), to: offset(target, edit.range.end), insert: edit.newText }));
                applyWorkspaceFileTextEdits(target.state.sliceDoc(), [
                    { range: replacement || { start: position(target, start), end: position(target, end) }, text: insert },
                    ...(value.additionalTextEdits ?? []).map(edit => ({ range: edit.range, text: edit.newText })),
                ]);
                const apply = (transaction: ReturnType<typeof target.state.update>) => {
                    const extra = ChangeSet.of(additional, doc.length, target.state.lineBreak).map(transaction.changes, true);
                    target.dispatch({ changes: transaction.changes.compose(extra), selection: transaction.newSelection.map(extra),
                        effects: StateEffect.mapEffects(transaction.effects, extra), annotations: isolateHistory.of('full'), userEvent: 'input.complete' });
                };
                if (value.insertTextFormat === 2) snippet(insert)({ state: target.state, dispatch: (...specs) => apply(target.state.update(...specs)) }, completion, start, end);
                else apply(target.state.update({ changes: { from: start, to: end, insert }, selection: { anchor: start + target.state.toText(insert).length } }));
                closeCompletion(target);
            })().catch(() => {}); },
        })) };
    };
    let signatureActive = false;
    const dismissSignature = () => { signatureActive = false; pending.get('signatureHelp')?.abort(); onSignature?.(null); };
    async function signature(editor: EditorView, triggerCharacter?: string, isRetrigger = false) {
        if (!caps()?.signatureHelp || editor.composing) return;
        const head = editor.state.selection.main.head;
        signatureActive = true;
        const result = await request(editor, 'signatureHelp', { position: position(editor, head), signatureContext: {
            triggerKind: triggerCharacter ? 2 : isRetrigger ? 3 : 1, isRetrigger, ...(triggerCharacter ? { triggerCharacter } : {}) } });
        if (editor.state.selection.main.head !== head || !result) return;
        if (result.status === 'ok' && result.kind === 'signatureHelp') {
            signatureActive = Boolean(result.help?.signatures.length);
            onSignature?.(signatureActive ? result.help : null);
        } else dismissSignature();
    }
    let selectionHistory: EditorSelection[] = [];
    async function expand(editor: EditorView) {
        const selection = editor.state.selection;
        const selected = selection.main;
        const result = await request(editor, 'selectionRange', { position: position(editor, selected.head) });
        if (result?.status !== 'ok' || result.kind !== 'selectionRange' || !editor.state.selection.eq(selection, true)) return;
        const ranges = result.ranges.flatMap(item => item.ranges).map(value => ({ from: offset(editor, value.start), to: offset(editor, value.end) }));
        const next = ranges.find(value => value.from <= selected.from && value.to >= selected.to && (value.from < selected.from || value.to > selected.to));
        if (next) { selectionHistory.push(selection); editor.dispatch({ selection: { anchor: next.from, head: next.to }, userEvent: 'select.expand' }); }
    }
    const command = (editor: EditorView, name: string): boolean => {
        if (disposed || editor.composing) return false;
        if (name === 'suggest') return caps()?.completion === true && startCompletion(editor);
        if (name === 'acceptCompletion') return acceptCompletion(editor);
        if (name === 'signatureHelp') { void signature(editor); return true; }
        if (name === 'expandSelection' && caps()?.selectionRange) { void expand(editor); return true; }
        if (name === 'shrinkSelection') { const previous = selectionHistory.pop(); if (previous) editor.dispatch({ selection: previous, userEvent: 'select.shrink' }); return Boolean(previous); }
        if (!['format', 'formatSelection', 'organizeImports'].includes(name) || editor.state.readOnly) return false;
        const capability = name === 'format' ? 'formatting' : name === 'formatSelection' ? 'rangeFormatting' : 'organizeImports';
        if (!caps()?.[capability]) return false;
        const selection = editor.state.selection.main;
        formatting = request(editor, capability, { ...(name === 'formatSelection' ? { range: { start: position(editor, selection.from), end: position(editor, selection.to) } } : {}),
            ...(name !== 'organizeImports' ? { formattingOptions: { tabSize: editor.state.tabSize, insertSpaces: true } } : {}) }).then(result => {
            if (result?.status !== 'ok' || !('files' in result) || result.files.some(file => file.path !== port.path || file.renameTo)) return;
            const file = result.files[0]; if (!file) return;
            const next = applyWorkspaceFileTextEdits(editor.state.sliceDoc(), file.edits).text;
            const change = minimalCodeEditorEdit(editor.state.doc.toString(), editor.state.toText(next).toString());
            if (change) editor.dispatch({ changes: change, annotations: isolateHistory.of('full'), userEvent: 'input' });
        }).catch(() => {});
        return true;
    };
    return { extensions: [decorationLayer(setRange), decorationLayer(setOccurrences), autocompletion({ override: [source], defaultKeymap: false }), keymap.of([
        { key: 'Ctrl-Space', run: editor => command(editor, 'suggest') }, { key: 'Mod-Space', run: editor => command(editor, 'suggest') },
        ...completionKeymap, { key: 'Escape', run: () => { dismissSignature(); return false; } },
    ]), ViewPlugin.fromClass(class {
        constructor(editor: EditorView) { queueMicrotask(() => { if (!disposed) { void refreshRange(editor).catch(() => {}); void refreshOccurrences(editor).catch(() => {}); } }); }
        update(update: import('@codemirror/view').ViewUpdate) {
            if (update.selectionSet && !update.startState.selection.eq(update.state.selection, true)) {
                pending.get('selectionRange')?.abort();
                if (update.transactions.some(transaction => transaction.selection
                    && !transaction.isUserEvent('select.expand') && !transaction.isUserEvent('select.shrink'))) selectionHistory = [];
            }
            if (update.docChanged) { cancel(); resolved.clear(); selectionHistory = []; onSignature?.(null); }
            if (update.docChanged || update.viewportChanged) queueMicrotask(() => { if (!disposed) void refreshRange(update.view).catch(() => {}); });
            if (update.docChanged || update.selectionSet || update.focusChanged) queueMicrotask(() => { if (!disposed) void refreshOccurrences(update.view).catch(() => {}); });
            if (update.focusChanged && !update.view.hasFocus) dismissSignature();
            if ((update.docChanged || update.selectionSet && signatureActive) && !update.view.composing) {
                const head = update.state.selection.main.head, before = update.state.doc.sliceString(Math.max(0, head - 1), head);
                const triggered = update.docChanged && (caps()?.signatureTriggerCharacters?.includes(before) || caps()?.signatureRetriggerCharacters?.includes(before));
                const isRetrigger = signatureActive;
                if (!update.state.selection.main.empty) dismissSignature();
                else if (triggered || isRetrigger) queueMicrotask(() => { if (!disposed) void signature(update.view, triggered ? before : undefined, isRetrigger); });
            }
        }
        destroy() { cancel(); }
    })], command, async formatDocument(editor) { command(editor, 'format'); await formatting; }, dispose() { disposed = true; cancel(); resolved.clear(); dismissSignature(); } };
}
