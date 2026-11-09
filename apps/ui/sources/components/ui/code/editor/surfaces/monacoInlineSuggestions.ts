import type * as Monaco from 'monaco-editor';
import type { CodeEditorCommand, CodeEditorInlineContext, CodeEditorInlineEvent, CodeEditorInlineSuggestion, CodeEditorInlineSuggestions } from '../codeEditorTypes';

type Item = Monaco.languages.InlineCompletion & Readonly<{ suggestionId: string; originalText: string }>;
type CompletionList = Monaco.languages.InlineCompletions<Item>;

/** Monaco owns rendering/history; the shared controller owns inference and acceptance policy. */
export function createMonacoInlineSuggestions(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor,
    model: Monaco.editor.ITextModel, options: Readonly<{ readOnly: () => boolean; beforeAccept?: () => void; afterAccept?: () => void }>) {
    let candidate: CodeEditorInlineSuggestion | null = null;
    let candidateOffset = 0;
    let composing = false;
    let listOpen = false;
    let visibleId: string | null = null;
    let accepting: { id: string; text: string } | null = null;
    let acceptGuard: ((id: string) => boolean) | null = null;
    let lastPublishedContext: CodeEditorInlineContext | null = null;
    const contextListeners = new Set<() => void>();
    const eventListeners = new Set<(event: CodeEditorInlineEvent) => void>();
    let providerRegistration: Monaco.IDisposable | null = null;
    const acceptContext = editor.createContextKey<boolean>('happierInlineSuggestionAcceptable', false);
    const event = (value: CodeEditorInlineEvent) => { for (const listener of eventListeners) listener(value); };
    const publishContext = () => {
        acceptContext.set(!!candidate && visibleId === candidate.id && eligible());
        lastPublishedContext = getContext(); for (const listener of contextListeners) listener();
    };
    function getContext() {
        const position = editor.getPosition?.();
        const selections = editor.getSelections?.();
        if (!position || !selections?.length) return null;
        return { line: position.lineNumber, character: position.column - 1, offset: model.getOffsetAt(position),
            eol: model.getEOL() as '\n' | '\r\n',
            version: model.getVersionId(), selectionCount: selections.length, hasSelection: selections.some(selection => !selection.isEmpty()),
            composing, suggestWidgetOpen: listOpen };
    }
    function eligible() {
        const context = getContext();
        return !!context && !options.readOnly() && !context.composing && !context.suggestWidgetOpen && !context.hasSelection && context.selectionCount === 1;
    }
    function hide(dismissed = false, notify = true) {
        const previous = candidate;
        candidate = null;
        visibleId = null;
        accepting = null;
        acceptContext.set(false);
        providerRegistration?.dispose();
        providerRegistration = null;
        editor.trigger('happier.inline', 'editor.action.inlineSuggest.hide', null);
        if (dismissed && previous) event({ kind: 'dismissed', id: previous.id });
        if (previous && notify) publishContext();
    }
    function set(suggestion: CodeEditorInlineSuggestion | null) {
        if (!suggestion || !eligible()) { if (candidate || providerRegistration) hide(); return; }
        const context = getContext();
        if (!context || suggestion.line !== context.line || suggestion.character !== context.character) { hide(); return; }
        if (candidate?.id === suggestion.id && candidate.text === suggestion.text && candidate.line === suggestion.line && candidate.character === suggestion.character) return;
        candidate = suggestion;
        candidateOffset = context.offset;
        visibleId = null;
        acceptContext.set(false);
        // Monaco keys its completed lookup cache by provider identity, caret and
        // model version, even for empty results. Give each projection a native
        // provider lifetime so an unchanged-caret request cannot reuse stale data.
        providerRegistration?.dispose();
        providerRegistration = monaco.languages.registerInlineCompletionsProvider(selector, { ...provider });
        editor.trigger('happier.inline', 'editor.action.inlineSuggest.trigger', null);
    }
    const provider: Monaco.languages.InlineCompletionsProvider<CompletionList> = {
        provideInlineCompletions(requestModel, position, context, token) {
            if (requestModel !== model || token.isCancellationRequested) return null;
            if (context.selectedSuggestionInfo) { listOpen = true; hide(); publishContext(); return null; }
            if (!candidate || !eligible() || position.lineNumber !== candidate.line || position.column !== candidate.character + 1) return null;
            const endColumn = /\r|\n/.test(candidate.text) ? model.getLineMaxColumn(candidate.line) : candidate.character + 1;
            const suffix = endColumn > candidate.character + 1 ? model.getLineContent(candidate.line).slice(candidate.character) : '';
            return { suppressSuggestions: false, enableForwardStability: true, items: [{
                suggestionId: candidate.id, originalText: candidate.text, insertText: candidate.text + suffix,
                range: { startLineNumber: candidate.line, endLineNumber: candidate.line,
                    startColumn: candidate.character + 1, endColumn },
            }] };
        },
        handleItemDidShow(_completions, item) {
            if (candidate?.id !== item.suggestionId || visibleId === item.suggestionId) return;
            visibleId = item.suggestionId;
            publishContext();
            event({ kind: 'shown', id: item.suggestionId });
        },
        handlePartialAccept(_completions, item, acceptedCharacters) {
            options.afterAccept?.();
            event({ kind: 'partiallyAccepted', id: item.suggestionId, acceptedText: accepting?.id === item.suggestionId ? accepting.text : item.originalText.slice(0, acceptedCharacters) });
            accepting = null;
        },
        handleEndOfLifetime(_completions, item, reason) {
            if (reason.kind === 0) {
                options.afterAccept?.();
                event({ kind: 'accepted', id: item.suggestionId, acceptedText: accepting?.id === item.suggestionId ? accepting.text : item.originalText });
                accepting = null;
                visibleId = null;
                publishContext();
            } else if (reason.kind === 1 && candidate?.id === item.suggestionId) {
                hide(false, false);
                event({ kind: 'dismissed', id: item.suggestionId }); publishContext();
            }
        },
        disposeInlineCompletions() {},
    };
    const selector = model.uri ? { scheme: model.uri.scheme, pattern: model.uri.path } : { language: model.getLanguageId() };
    lastPublishedContext = getContext();
    const registrations = [
        editor.onDidChangeModelContent?.(change => {
            const previousOffset = lastPublishedContext?.offset;
            let expectedOffset = previousOffset;
            if (previousOffset !== undefined) {
                for (const edit of change.changes) {
                    if (edit.rangeOffset + edit.rangeLength <= previousOffset) expectedOffset! += edit.text.length - edit.rangeLength;
                }
            }
            if (accepting && change.changes.length === 1 && change.changes[0]!.rangeLength === 0) accepting.text = change.changes[0]!.text;
            if (candidate) {
                const edit = change.changes[0];
                if (change.changes.length === 1 && edit && edit.rangeLength === 0 && edit.rangeOffset === candidateOffset && candidate.text.startsWith(edit.text)) {
                    candidateOffset += edit.text.length;
                    const nextPosition = model.getPositionAt(candidateOffset);
                    candidate = { ...candidate, text: candidate.text.slice(edit.text.length), line: nextPosition.lineNumber, character: nextPosition.column - 1 };
                    if (!candidate.text) candidate = null;
                } else if (accepting?.id === candidate.id) {
                    expectedOffset = candidateOffset + accepting.text.length;
                    candidate = null; visibleId = null;
                } else hide(false, false);
            }
            // The model event can precede Monaco's cursor event. Publish when both describe the same edit.
            if (expectedOffset !== undefined && getContext()?.offset !== expectedOffset) return;
            publishContext();
        }),
        editor.onDidChangeCursorSelection?.(() => {
            const context = getContext();
            if (candidate && (!eligible() || context?.offset !== candidateOffset)) hide();
            publishContext();
        }),
        editor.onDidCompositionStart?.(() => { composing = true; hide(); publishContext(); }),
        editor.onDidCompositionEnd?.(() => { composing = false; publishContext(); }),
    ];
    const node = editor.getDomNode?.();
    // Observe the existing list's visibility; no polling or parallel completion-list state owner.
    const observeList = () => {
        const open = !!node?.querySelector('.suggest-widget.visible');
        if (open === listOpen) return;
        listOpen = open;
        if (open) hide();
        publishContext();
    };
    const observer = node && typeof MutationObserver !== 'undefined' ? new MutationObserver(observeList) : null;
    if (node && observer) observer.observe(node, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    function command(value: CodeEditorCommand) {
        if (value === 'inlineSuggestTrigger') {
            if (eligible()) {
                // Focus on the user's accessory/command-picker request, never on a late response.
                editor.focus();
                event({ kind: 'trigger' });
            }
            return true;
        }
        if (value === 'inlineSuggestDismiss') { hide(true); return true; }
        if (value !== 'inlineSuggestAccept' && value !== 'inlineSuggestAcceptWord') return false;
        observeList();
        if (candidate && visibleId === candidate.id && eligible()) options.beforeAccept?.();
        if (candidate && visibleId === candidate.id && eligible() && getContext()?.offset === candidateOffset && acceptGuard?.(candidate.id) === true) {
            accepting = { id: candidate.id, text: candidate.text };
            editor.trigger('happier.inline', value === 'inlineSuggestAccept' ? 'editor.action.inlineSuggest.commit' : 'editor.action.inlineSuggest.acceptNextWord', null);
        }
        return true;
    }
    // Native EditContext forwards keydown through Monaco's keybinding service.
    // Keep one guarded command path there instead of intercepting DOM events.
    const acceptWhen = 'editorTextFocus && !editorReadonly && happierInlineSuggestionAcceptable && !suggestWidgetVisible';
    const actions = [
        editor.addAction({ id: 'happier.inline.accept', label: 'Accept inline suggestion', precondition: acceptWhen,
            keybindings: [monaco.KeyCode.Tab], run: () => { command('inlineSuggestAccept'); } }),
        editor.addAction({ id: 'happier.inline.acceptWord', label: 'Accept inline suggestion word', precondition: acceptWhen,
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.RightArrow, monaco.KeyMod.WinCtrl | monaco.KeyCode.RightArrow],
            run: () => { command('inlineSuggestAcceptWord'); } }),
        editor.addAction({ id: 'happier.inline.dismiss', label: 'Dismiss inline suggestion', precondition: acceptWhen,
            keybindings: [monaco.KeyCode.Escape], run: () => { command('inlineSuggestDismiss'); } }),
        editor.addAction({ id: 'happier.inline.trigger', label: 'Request inline suggestion', precondition: 'editorTextFocus && !editorReadonly',
            keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Backslash], run: () => { command('inlineSuggestTrigger'); } }),
    ];
    const handle: CodeEditorInlineSuggestions = {
        set, getContext, getSuggestion: () => candidate?.id === visibleId ? candidate : null,
        subscribeContext: listener => { contextListeners.add(listener); return () => { contextListeners.delete(listener); }; },
        onEvent: listener => { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
        setAcceptGuard: guard => { acceptGuard = guard; },
    };
    return { handle, command, dispose() {
        observer?.disconnect();
        for (const action of actions) action.dispose();
        acceptContext.reset();
        providerRegistration?.dispose(); providerRegistration = null;
        for (const registration of registrations) registration?.dispose();
        contextListeners.clear(); eventListeners.clear(); candidate = null; acceptGuard = null;
    } };
}
