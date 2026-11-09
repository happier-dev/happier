import type * as State from '@codemirror/state';
import type * as View from '@codemirror/view';
import type * as Commands from '@codemirror/commands';
import type * as Autocomplete from '@codemirror/autocomplete';
import type { CodeEditorInlineContext, CodeEditorInlineEvent, CodeEditorInlineSuggestion } from '../codeEditorTypes';

type Api = Pick<typeof State, 'StateField' | 'StateEffect'>
    & Pick<typeof View, 'EditorView' | 'Decoration' | 'WidgetType' | 'keymap'>
    & Pick<typeof Commands, 'isolateHistory'> & Pick<typeof Autocomplete, 'completionStatus'>;
type Candidate = CodeEditorInlineSuggestion & Readonly<{ offset: number }>;
type Snapshot = Readonly<{ candidate: Candidate | null; version: number }>;
export type CodeMirrorInlineAcceptance = Readonly<{ id: string; partial: boolean; version: number }>;
export type CodeMirrorInlineChange = Readonly<{ from: number; to: number; insert: string }>;
type Position = Readonly<{ line: number; character: number }>;
type NextEditHint = readonly Readonly<{ key?: boolean; text: string }>[];
/** The host's projection of the shared next-edit snapshot (P7-R33); zero-based UTF-16 positions, localized hint parts. */
export type CodeMirrorNextEditProjection = Readonly<{ status: 'requesting' }> | Readonly<{
    id: string; status: 'ready' | 'preview';
    edits: readonly Readonly<{ start: Position; end: Position; oldText: string; newText: string }>[];
    hint: NextEditHint;
}>;
type NextEdit = Readonly<{ id: string; status: 'ready' | 'preview'; ranges: readonly Readonly<{ from: number; to: number; oldText: string; newText: string }>[];
    hintAt: number; hint: NextEditHint }>;

/** The canonical generator compiles this factory for both the embedded bundle and CDN fallback. */
export function createCodeMirrorInlineSuggestions(api: Api, options: Readonly<{
    separator: () => NonNullable<CodeEditorInlineContext['eol']>;
    event: (event: CodeEditorInlineEvent) => void;
    context: (context: CodeEditorInlineContext, changes: readonly CodeMirrorInlineChange[], suggestion: CodeEditorInlineSuggestion | null) => void;
    requestAccept: (request: CodeMirrorInlineAcceptance) => void;
    /** Tab or Escape on a displayed next edit; the host's controller decides (jump, apply or dismiss). */
    nextEdit?: (kind: 'tab' | 'dismiss') => void;
}>) {
    let version = 0;
    let composing = false;
    let nextEditRequesting = false;
    const set = api.StateEffect.define<Candidate | null>();
    const field = api.StateField.define<Snapshot>({
        create: () => ({ candidate: null, version: ++version }),
        update(previous, transaction) {
            let candidate = previous.candidate;
            if (candidate && transaction.docChanged) {
                const edits: { from: number; to: number; text: string }[] = [];
                transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => edits.push({ from, to, text: inserted.sliceString(0, inserted.length, options.separator()) }));
                const edit = edits[0];
                candidate = edits.length === 1 && edit && edit.from === candidate.offset && edit.to === candidate.offset
                    && candidate.text.startsWith(edit.text)
                    ? { ...candidate, text: candidate.text.slice(edit.text.length), offset: transaction.changes.mapPos(candidate.offset, 1) } : null;
                if (!candidate?.text) candidate = null;
                if (candidate) {
                    const line = transaction.state.doc.lineAt(candidate.offset);
                    candidate = { ...candidate, line: line.number, character: candidate.offset - line.from };
                }
            }
            for (const effect of transaction.effects) if (effect.is(set)) candidate = effect.value;
            const selection = transaction.state.selection;
            if (composing || selection.ranges.length !== 1 || !selection.main.empty
                || api.completionStatus(transaction.state) !== null || (candidate && selection.main.head !== candidate.offset)) candidate = null;
            return { candidate, version: transaction.docChanged ? ++version : previous.version };
        },
        provide: source => api.EditorView.decorations.from(source, snapshot => snapshot.candidate
            ? api.Decoration.set([api.Decoration.widget({ widget: new Ghost(snapshot.candidate), side: 1 }).range(snapshot.candidate.offset)])
            : api.Decoration.none),
    });
    const setNext = api.StateEffect.define<NextEdit | null>();
    // Retire at the engine before asynchronous context delivery can reach the controller.
    const nextField = api.StateField.define<NextEdit | null>({
        create: () => null,
        update(previous, transaction) {
            let next = transaction.docChanged ? null : previous;
            for (const effect of transaction.effects) if (effect.is(setNext)) next = effect.value;
            const selection = transaction.state.selection;
            if (next && (composing || selection.ranges.length !== 1 || !selection.main.empty
                || api.completionStatus(transaction.state) !== null
                || (transaction.selection && !selection.eq(transaction.startState.selection)
                    && (next.status !== 'preview' || selection.main.head !== next.ranges[0]?.from)))) next = null;
            return next;
        },
        provide: source => api.EditorView.decorations.from(source, next => {
            if (!next) return api.Decoration.none;
            const items = [];
            for (const range of next.ranges) {
                if (next.status === 'ready') {
                    items.push(range.from < range.to ? api.Decoration.mark({ class: 'happier-next-edit-target' }).range(range.from, range.to)
                        : api.Decoration.widget({ widget: new NextPart('happier-next-edit-target', '\u2009', false), side: 1 }).range(range.from));
                } else {
                    if (range.from < range.to) items.push(api.Decoration.mark({ class: 'happier-next-edit-removed' }).range(range.from, range.to));
                    if (range.newText) items.push(api.Decoration.widget({ widget: new NextPart('happier-next-edit-added', range.newText, true), side: 1 }).range(range.to));
                }
            }
            if (next.hint.length) items.push(api.Decoration.widget({ widget: new NextHint(next.hint), side: 2 }).range(next.hintAt));
            return api.Decoration.set(items, true);
        }),
    });
    const tapNext = (dom: HTMLElement) => {
        dom.addEventListener('pointerdown', event => event.preventDefault());
        dom.addEventListener('click', event => { event.preventDefault(); options.nextEdit?.('tab'); });
    };
    class NextPart extends api.WidgetType {
        constructor(readonly className: string, readonly text: string, readonly tappable: boolean) { super(); }
        override eq(other: NextPart) { return this.className === other.className && this.text === other.text; }
        override get lineBreaks() { return this.text.split(/\r\n|\r|\n/).length - 1; }
        override toDOM() {
            const dom = document.createElement('span');
            dom.className = this.className;
            dom.textContent = this.text;
            dom.style.whiteSpace = 'pre-wrap';
            if (this.tappable) tapNext(dom);
            return dom;
        }
        override ignoreEvent() { return true; }
    }
    class NextHint extends api.WidgetType {
        constructor(readonly parts: NextEditHint) { super(); }
        override eq(other: NextHint) { return this.parts.map(part => `${part.key ? 1 : 0}${part.text}`).join('\0') === other.parts.map(part => `${part.key ? 1 : 0}${part.text}`).join('\0'); }
        override toDOM() {
            const dom = document.createElement('span');
            dom.setAttribute('role', 'button');
            for (const part of this.parts) {
                const span = document.createElement('span');
                span.className = part.key ? 'happier-next-edit-key' : 'happier-next-edit-hint';
                span.textContent = part.text;
                dom.appendChild(span);
            }
            tapNext(dom);
            return dom;
        }
        override ignoreEvent() { return true; }
    }
    function offsetOf(editor: View.EditorView, position: Position) {
        const doc = editor.state.doc;
        if (!Number.isInteger(position.line) || position.line < 0 || position.line >= doc.lines) return null;
        const line = doc.line(position.line + 1);
        return Number.isInteger(position.character) && position.character >= 0 && position.character <= line.length ? line.from + position.character : null;
    }
    function resolveNext(editor: View.EditorView, projection: CodeMirrorNextEditProjection | null): NextEdit | null {
        if (!projection || projection.status === 'requesting' || !projection.edits.length) return null;
        const ranges = [];
        for (const edit of projection.edits) {
            const from = offsetOf(editor, edit.start), to = offsetOf(editor, edit.end);
            if (from === null || to === null || to < from) return null;
            ranges.push({ from, to, oldText: edit.oldText, newText: edit.newText });
        }
        const anchor = projection.status === 'ready' ? editor.state.selection.main.head : ranges[ranges.length - 1]!.to;
        return { id: projection.id, status: projection.status, ranges, hintAt: editor.state.doc.lineAt(anchor).to, hint: projection.hint };
    }
    function showNext(editor: View.EditorView, projection: CodeMirrorNextEditProjection | null) {
        nextEditRequesting = projection?.status === 'requesting';
        const next = resolveNext(editor, projection);
        if (next || editor.state.field(nextField)) editor.dispatch({ effects: setNext.of(next) });
    }
    function nextKey(editor: View.EditorView, kind: 'tab' | 'dismiss') {
        const context = getContext(editor);
        if ((!editor.state.field(nextField) && !(kind === 'dismiss' && nextEditRequesting)) || !options.nextEdit
            || context.composing || context.suggestWidgetOpen || (kind === 'tab' && !available(editor))) return false;
        options.nextEdit(kind);
        return true;
    }
    /** One transaction, one undo step; refused unless the drawn preview still describes the current buffer. */
    function applyNext(editor: View.EditorView, request: Readonly<{ id?: unknown }>) {
        const next = editor.state.field(nextField);
        if (!next || next.status !== 'preview' || next.id !== request.id || !available(editor)
            || editor.state.selection.main.head !== next.ranges[0]?.from) return false;
        const normalize = (value: string) => value.replace(/\r\n|\r/g, '\n');
        if (next.ranges.some(range => editor.state.doc.sliceString(range.from, range.to) !== normalize(range.oldText))) return false;
        const changes = editor.state.changes(next.ranges.map(range => ({ from: range.from, to: range.to, insert: editor.state.toText(range.newText) })));
        editor.dispatch({ changes, selection: { anchor: changes.mapPos(next.ranges[0]!.to, 1) },
            annotations: api.isolateHistory.of('full'), userEvent: 'input.complete' });
        return true;
    }
    class Ghost extends api.WidgetType {
        constructor(readonly candidate: Candidate) { super(); }
        override eq(other: Ghost) { return this.candidate.id === other.candidate.id && this.candidate.text === other.candidate.text; }
        override get lineBreaks() { return this.candidate.text.split(/\r\n|\r|\n/).length - 1; }
        override toDOM(editor: View.EditorView) {
            const dom = document.createElement('span');
            dom.className = 'happier-editor-inline-suggestion';
            dom.textContent = this.candidate.text;
            dom.setAttribute('aria-live', 'polite');
            dom.style.whiteSpace = 'pre-wrap';
            dom.addEventListener('pointerdown', event => event.preventDefault());
            dom.addEventListener('click', event => { event.preventDefault(); request(editor, false); });
            return dom;
        }
        override ignoreEvent() { return true; }
    }
    function getContext(editor: View.EditorView): CodeEditorInlineContext {
        const state = editor.state;
        const head = state.selection.main.head;
        const line = state.doc.lineAt(head);
        return { line: line.number, character: head - line.from,
            eol: options.separator(),
            offset: head + (line.number - 1) * (options.separator().length - 1), version: state.field(field).version,
            selectionCount: state.selection.ranges.length, hasSelection: !state.selection.main.empty,
            composing: composing || editor.composing, suggestWidgetOpen: api.completionStatus(state) !== null };
    }
    function available(editor: View.EditorView) {
        const context = getContext(editor);
        return !editor.state.readOnly && !context.composing && context.selectionCount === 1 && !context.hasSelection && !context.suggestWidgetOpen;
    }
    function request(editor: View.EditorView, partial: boolean) {
        const snapshot = editor.state.field(field);
        if (!snapshot.candidate || !available(editor)) return false;
        options.requestAccept({ id: snapshot.candidate.id, version: snapshot.version, partial });
        return true;
    }
    function accept(editor: View.EditorView, request: CodeMirrorInlineAcceptance) {
        const snapshot = editor.state.field(field);
        const candidate = snapshot.candidate;
        if (!candidate || candidate.id !== request.id || snapshot.version !== request.version || !available(editor)) return false;
        let text = candidate.text;
        if (request.partial) {
            // Segmenter preserves Unicode words and graphemes; leading indentation belongs to this acceptance.
            const whitespace = text.match(/^\s*/u)?.[0] ?? '';
            const remainder = text.slice(whitespace.length);
            const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
            const segment = segmenter.segment(remainder)[Symbol.iterator]().next().value;
            text = whitespace + (segment?.segment ?? '');
            if (text.endsWith('\r') && candidate.text[text.length] === '\n') text += '\n';
        }
        if (!text) return false;
        const inserted = editor.state.toText(text);
        editor.dispatch({ changes: { from: candidate.offset, insert: inserted },
            selection: { anchor: candidate.offset + inserted.length },
            annotations: api.isolateHistory.of('full'), userEvent: 'input.complete' });
        options.event({ kind: request.partial ? 'partiallyAccepted' : 'accepted', id: candidate.id, acceptedText: text });
        return true;
    }
    function show(editor: View.EditorView, suggestion: CodeEditorInlineSuggestion | null) {
        const previous = editor.state.field(field).candidate;
        if (suggestion === null && previous === null) return;
        if (suggestion && previous && suggestion.id === previous.id && suggestion.text === previous.text
            && suggestion.line === previous.line && suggestion.character === previous.character) return;
        const line = suggestion && suggestion.line >= 1 && suggestion.line <= editor.state.doc.lines ? editor.state.doc.line(suggestion.line) : null;
        const candidate = suggestion && line && suggestion.character >= 0 && suggestion.character <= line.length && suggestion.text
            ? { ...suggestion, offset: line.from + suggestion.character } : null;
        editor.dispatch({ effects: set.of(candidate) });
        if (candidate && editor.state.field(field).candidate) options.event({ kind: 'shown', id: candidate.id });
    }
    function dismiss(editor: View.EditorView) {
        const candidate = editor.state.field(field).candidate;
        if (!candidate) return false;
        editor.dispatch({ effects: set.of(null) });
        options.event({ kind: 'dismissed', id: candidate.id });
        return true;
    }
    function getSuggestion(editor: View.EditorView) { return editor.state.field(field).candidate; }
    function publish(editor: View.EditorView) { options.context(getContext(editor), [], getSuggestion(editor)); }
    const extensions: State.Extension[] = [field, nextField,
        api.EditorView.updateListener.of(update => {
            const changes: CodeMirrorInlineChange[] = [];
            const separator = options.separator();
            update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
                changes.push({ from: from + (update.startState.doc.lineAt(from).number - 1) * (separator.length - 1),
                    to: to + (update.startState.doc.lineAt(to).number - 1) * (separator.length - 1),
                    insert: inserted.sliceString(0, inserted.length, separator) });
            });
            if (update.docChanged || update.selectionSet || update.startState.field(field).candidate !== update.state.field(field).candidate
                || api.completionStatus(update.startState) !== api.completionStatus(update.state)) options.context(getContext(update.view), changes, getSuggestion(update.view));
        }),
        api.EditorView.domEventHandlers({
            compositionstart: (_event, editor) => { composing = true; dismiss(editor); showNext(editor, null); publish(editor); },
            compositionend: (_event, editor) => { composing = false; publish(editor); },
        }),
        api.keymap.of([
            { key: 'Tab', run: editor => request(editor, false) },
            { key: 'Mod-ArrowRight', run: editor => request(editor, true) },
            { key: 'Escape', run: dismiss },
            { key: 'Alt-\\', run: () => { options.event({ kind: 'trigger' }); return true; } },
            { key: 'Tab', run: editor => nextKey(editor, 'tab') },
            { any: (editor, event) => event.key === 'Escape' && !event.isComposing
                && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && nextKey(editor, 'dismiss') },
        ]),
    ];
    return { extensions, getContext, getSuggestion, publish, set: show, accept, request, dismiss,
        setNextEdit: showNext, applyNextEdit: applyNext, nextEditKey: nextKey, hasNextEdit: (editor: View.EditorView) => editor.state.field(nextField) !== null };
}
