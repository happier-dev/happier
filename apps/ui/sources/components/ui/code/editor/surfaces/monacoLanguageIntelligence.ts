import type * as Monaco from 'monaco-editor';
import type { CodeEditorCompletionSource, CodeEditorLanguageCommand, CodeEditorLanguageIntelligence } from '../codeEditorTypes';
import type { LanguageIntelligenceCompletionItem, LanguageIntelligenceRange } from '@happier-dev/protocol/machines/languageIntelligence';
import { applyWorkspaceFileTextEdits } from '@happier-dev/protocol/machines/workspaceFilesReplace';

const position = (value: Monaco.IPosition) => ({ line: value.lineNumber - 1, character: value.column - 1 });
const range = (value: Monaco.IRange): LanguageIntelligenceRange => ({ start: { line: value.startLineNumber - 1, character: value.startColumn - 1 }, end: { line: value.endLineNumber - 1, character: value.endColumn - 1 } });
const engineRange = (value: LanguageIntelligenceRange): Monaco.IRange => ({ startLineNumber: value.start.line + 1, startColumn: value.start.character + 1, endLineNumber: value.end.line + 1, endColumn: value.end.character + 1 });
const markdown = (value: string | undefined): Monaco.IMarkdownString | undefined => value === undefined ? undefined : ({ value, isTrusted: false, supportHtml: false });
// LSP's standard token vocabulary, translated by name instead of assuming a server's legend order.
const tokenTypes = ['namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator'];
const tokenModifiers = ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary'];

/** Public engine providers only translate shapes. Requests, sync, capabilities and server state belong to the controller. */
export function bindMonacoLanguageIntelligence(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor,
    port: (Pick<CodeEditorLanguageIntelligence, 'request' | 'getSnapshot' | 'subscribe'> & Partial<Pick<CodeEditorLanguageIntelligence, 'path' | 'inlayHints' | 'semanticHighlighting' | 'referencePreview'>>) | null,
    completionSource?: CodeEditorCompletionSource): Monaco.IDisposable & { runCommand(command: CodeEditorLanguageCommand): Promise<void> } {
    const model = editor.getModel();
    if (!model) return { dispose() {}, async runCommand() {} };
    let disposed = false;
    const pending = new Set<AbortController>();
    const providers: Monaco.IDisposable[] = [];
    // Monaco's public references widget resolves one model per referenced file. These are
    // disposable previews for the current explicit peek, never another document store.
    const previews = new Map<string, { path: string; model?: Monaco.editor.ITextModel }>();
    const clearPreviews = () => { for (const preview of previews.values()) preview.model?.dispose(); previews.clear(); };
    let peek: AbortController | undefined;
    const stopOpen = port?.referencePreview ? monaco.editor.registerEditorOpener({
        async openCodeEditor(_source, resource, selection) {
            const preview = previews.get(resource.toString());
            if (disposed || !preview || !port?.referencePreview) return false;
            const selected = selection && 'startLineNumber' in selection ? range(selection)
                : { start: selection ? position(selection) : { line: 0, character: 0 }, end: selection ? position(selection) : { line: 0, character: 0 } };
            await port.referencePreview.openLocation({ path: preview.path, range: selected });
            return true;
        },
    }) : undefined;
    const completionItems = new WeakMap<Monaco.languages.CompletionItem, { item: LanguageIntelligenceCompletionItem; version: number }>();
    const cancel = () => { for (const request of pending) request.abort(); pending.clear(); };
    const stopEdit = editor.onDidChangeModelContent(cancel);
    const request = async (candidate: Monaco.editor.ITextModel, token: Monaco.CancellationToken,
        kind: Parameters<CodeEditorLanguageIntelligence['request']>[0], options: Parameters<CodeEditorLanguageIntelligence['request']>[1]) => {
        if (!port || disposed || candidate !== model || token.isCancellationRequested) return null;
        const version = model.getVersionId();
        const abort = new AbortController(); pending.add(abort);
        const stop = token.onCancellationRequested(() => abort.abort());
        try {
            const result = await port.request(kind, options, abort.signal);
            return disposed || abort.signal.aborted || token.isCancellationRequested || model.getVersionId() !== version || editor.getModel() !== model ? null : result;
        } finally { pending.delete(abort); stop.dispose(); }
    };
    const provideReferences = async (candidate: Monaco.editor.ITextModel, at: Monaco.IPosition, token: Monaco.CancellationToken): Promise<Monaco.languages.Location[] | null> => {
        if (!port || disposed || candidate !== model || token.isCancellationRequested) return null;
        const version = model.getVersionId();
        peek?.abort(); clearPreviews();
        const abort = new AbortController(); peek = abort; pending.add(abort);
        const stop = token.onCancellationRequested(() => abort.abort());
        const current = () => !disposed && !abort.signal.aborted && model.getVersionId() === version && editor.getModel() === model;
        try {
            const result = await port.request('references', { position: position(at) }, abort.signal);
            if (!current() || result?.status !== 'ok' || result.kind !== 'references') return null;
            const targets = new Map<string, Monaco.Uri>();
            // Reference rows are already workspace-relative at the protocol/host boundary.
            const locations = result.locations.map(item => {
                if (item.path === port.path) return { uri: model.uri, range: engineRange(item.range) };
                let uri = targets.get(item.path);
                if (!uri) { uri = monaco.Uri.from({ scheme: 'happier-reference', path: '/' + item.path, query: model.uri.toString() }); targets.set(item.path, uri); }
                return { uri, range: engineRange(item.range) };
            });
            await Promise.all([...targets].map(async ([path, uri]) => {
                const text = await port.referencePreview?.readText(path, abort.signal).catch(() => null);
                if (!current()) return;
                previews.set(uri.toString(), { path, ...(text !== null && text !== undefined ? { model: monaco.editor.createModel(text, undefined, uri) } : {}) });
            }));
            return current() ? locations : null;
        } finally { pending.delete(abort); stop.dispose(); if (peek === abort) peek = undefined; }
    };
    const visible = (requested: Monaco.IRange): LanguageIntelligenceRange | null => {
        const viewport = editor.getVisibleRanges();
        if (!viewport.length) return null;
        const first = viewport[0], last = viewport[viewport.length - 1];
        const start = Math.max(requested.startLineNumber, first.startLineNumber), end = Math.min(requested.endLineNumber, last.endLineNumber);
        if (start > end) return null;
        return range({ startLineNumber: start, startColumn: start === first.startLineNumber ? Math.max(first.startColumn, start === requested.startLineNumber ? requested.startColumn : 1) : 1,
            endLineNumber: end, endColumn: end === last.endLineNumber ? Math.min(last.endColumn, end === requested.endLineNumber ? requested.endColumn : last.endColumn) : model.getLineMaxColumn(end) });
    };
    const completion = (item: LanguageIntelligenceCompletionItem, at: Monaco.IPosition, previous?: Monaco.languages.CompletionItem): Monaco.languages.CompletionItem => {
        const word = model.getWordUntilPosition(at);
        const edit = item.textEdit;
        const kinds: readonly (keyof typeof monaco.languages.CompletionItemKind)[] = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];
        const value: Monaco.languages.CompletionItem = { ...previous, label: item.label,
            kind: item.kind ? monaco.languages.CompletionItemKind[kinds[item.kind - 1]] ?? monaco.languages.CompletionItemKind.Text : monaco.languages.CompletionItemKind.Text,
            insertText: edit?.newText ?? item.insertText ?? previous?.insertText ?? item.label,
            range: edit ? 'range' in edit ? engineRange(edit.range) : { insert: engineRange(edit.insert), replace: engineRange(edit.replace) }
                : previous?.range ?? { startLineNumber: at.lineNumber, endLineNumber: at.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn },
            ...(item.insertTextFormat === 2 ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
            ...(item.detail !== undefined ? { detail: item.detail } : {}), ...(item.documentation !== undefined ? { documentation: markdown(item.documentation) } : {}),
            ...(item.sortText ? { sortText: item.sortText } : {}), ...(item.filterText ? { filterText: item.filterText } : {}),
            ...(item.preselect ? { preselect: true } : {}), ...(item.commitCharacters ? { commitCharacters: item.commitCharacters } : {}),
            ...(item.additionalTextEdits ? { additionalTextEdits: item.additionalTextEdits.map(edit => ({ range: engineRange(edit.range), text: edit.newText })) } : {}),
        };
        completionItems.set(value, { item, version: model.getVersionId() });
        return value;
    };
    let previousCapabilities: ReturnType<CodeEditorLanguageIntelligence['getSnapshot']>['capabilities'];
    let installed = false;
    function install() {
        const caps = port?.getSnapshot().capabilities;
        if (installed && caps === previousCapabilities) return;
        installed = true;
        previousCapabilities = caps;
        for (const provider of providers.splice(0)) provider.dispose();
        // This is a global Monaco option: use the Account preference, not one document's capabilities.
        if (port) editor.updateOptions({ occurrencesHighlight: caps?.documentHighlight ? 'singleFile' : 'off',
            'semanticHighlighting.enabled': port?.semanticHighlighting !== false });
        const selector = '*'; // Providers reject every model except this editor's exact incumbent model.
        if (caps?.references) providers.push(monaco.languages.registerReferenceProvider(selector, {
            provideReferences: (candidate, at, _context, token) => provideReferences(candidate, at, token),
        }));
        if (completionSource || caps?.completion) providers.push(monaco.languages.registerCompletionItemProvider(selector, {
            triggerCharacters: completionSource?.triggerCharacters ? [...completionSource.triggerCharacters] : caps?.completionTriggerCharacters,
            async provideCompletionItems(candidate, at, context, token) {
                if (completionSource) {
                    if (disposed || candidate !== model || token.isCancellationRequested) return null;
                    const version = model!.getVersionId();
                    const abort = new AbortController(); pending.add(abort);
                    const stop = token.onCancellationRequested(() => abort.abort());
                    try {
                        const items = await completionSource.complete({ offset: candidate.getOffsetAt(at), line: at.lineNumber,
                            character: at.column - 1, explicit: context.triggerKind === 0 }, abort.signal);
                        if (!items || disposed || abort.signal.aborted || model!.getVersionId() !== version || editor.getModel() !== model) return null;
                        const word = candidate.getWordUntilPosition(at);
                        return { suggestions: items.map(item => {
                            const start = item.range ? candidate.getPositionAt(item.range.start) : { lineNumber: at.lineNumber, column: word.startColumn };
                            const end = item.range ? candidate.getPositionAt(item.range.end) : { lineNumber: at.lineNumber, column: word.endColumn };
                            return { label: item.label, insertText: item.insertText ?? item.label, kind: monaco.languages.CompletionItemKind.Text,
                                ...(item.detail === undefined ? {} : { detail: item.detail }),
                                range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column } };
                        }) };
                    } catch { return null; }
                    finally { pending.delete(abort); stop.dispose(); }
                }
                const result = await request(candidate, token, 'completion', { position: position(at), completionContext: {
                    triggerKind: context.triggerKind === 1 ? 2 : context.triggerKind === 2 ? 3 : 1, ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}) } });
                return result?.status === 'ok' && result.kind === 'completion' ? { incomplete: result.isIncomplete, suggestions: result.items.map(item => completion(item, at)) } : null;
            },
            async resolveCompletionItem(item, token) {
                const captured = completionItems.get(item);
                if (!captured || captured.version !== model!.getVersionId() || !caps?.completionResolve) return item;
                const result = await request(model!, token, 'completionResolve', { serverId: captured.item.serverId, itemId: captured.item.itemId });
                const itemRange = 'insert' in item.range ? item.range.insert : item.range;
                return result?.status === 'ok' && result.kind === 'completionResolve' ? completion({ ...captured.item, ...result.item },
                    { lineNumber: itemRange.startLineNumber, column: itemRange.startColumn }, item) : item;
            },
        }));
        if (caps?.signatureHelp) providers.push(monaco.languages.registerSignatureHelpProvider(selector, {
            signatureHelpTriggerCharacters: caps.signatureTriggerCharacters, signatureHelpRetriggerCharacters: caps.signatureRetriggerCharacters,
            async provideSignatureHelp(candidate, at, token, context) {
                const result = await request(candidate, token, 'signatureHelp', { position: position(at), signatureContext: { triggerKind: context.triggerKind,
                    isRetrigger: context.isRetrigger, ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}) } });
                if (result?.status !== 'ok' || result.kind !== 'signatureHelp' || !result.help) return null;
                return { value: { signatures: result.help.signatures.map(signature => ({ ...signature, documentation: markdown(signature.documentation),
                    parameters: (signature.parameters ?? []).map(parameter => ({ ...parameter, documentation: markdown(parameter.documentation) })) })),
                    activeSignature: result.help.activeSignature ?? 0, activeParameter: result.help.activeParameter ?? 0 }, dispose() {} };
            },
        }));
        const format = async (candidate: Monaco.editor.ITextModel, token: Monaco.CancellationToken, options: Monaco.languages.FormattingOptions, selection?: Monaco.IRange) => {
            const result = await request(candidate, token, selection ? 'rangeFormatting' : 'formatting', {
                formattingOptions: { tabSize: options.tabSize, insertSpaces: options.insertSpaces }, ...(selection ? { range: range(selection) } : {}) });
            if (result?.status !== 'ok' || (result.kind !== 'formatting' && result.kind !== 'rangeFormatting') || result.files.some(file => file.path !== port?.path || file.renameTo)) return [];
            // The existing semantic edit-set transform validates the complete set before Monaco changes its buffer.
            const file = result.files[0]; if (!file) return [];
            applyWorkspaceFileTextEdits(model!.getValue(), file.edits);
            return file.edits.map(edit => ({ range: engineRange(edit.range), text: edit.text }));
        };
        if (caps?.formatting) providers.push(monaco.languages.registerDocumentFormattingEditProvider(selector, { provideDocumentFormattingEdits: (candidate, options, token) => format(candidate, token, options) }));
        if (caps?.rangeFormatting) providers.push(monaco.languages.registerDocumentRangeFormattingEditProvider(selector, { provideDocumentRangeFormattingEdits: (candidate, selection, options, token) => format(candidate, token, options, selection) }));
        if (caps?.inlayHint && port?.inlayHints !== 'off') providers.push(monaco.languages.registerInlayHintsProvider(selector, {
            async provideInlayHints(candidate, requested, token) {
                const clipped = visible(requested); if (!clipped) return null;
                const result = await request(candidate, token, 'inlayHint', { range: clipped });
                if (result?.status !== 'ok' || result.kind !== 'inlayHint') return null;
                return { hints: result.hints.filter(hint => port?.inlayHints !== 'parameters' || hint.kind === 2).map(hint => ({
                    label: hint.label, position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
                    kind: hint.kind === 2 ? monaco.languages.InlayHintKind.Parameter : monaco.languages.InlayHintKind.Type,
                    paddingLeft: hint.paddingLeft, paddingRight: hint.paddingRight, tooltip: markdown(hint.tooltip),
                })), dispose() {} };
            },
        }));
        if ((caps?.semanticTokensRange || caps?.semanticTokensDelta) && port?.semanticHighlighting !== false) providers.push(monaco.languages.registerDocumentRangeSemanticTokensProvider(selector, {
            getLegend: () => ({ tokenTypes, tokenModifiers }),
            async provideDocumentRangeSemanticTokens(candidate, requested, token) {
                const clipped = visible(requested); if (!clipped) return null;
                const result = await request(candidate, token, 'semanticTokens', { range: clipped });
                if (result?.status !== 'ok' || result.kind !== 'semanticTokens') return null;
                const decoded: { line: number; character: number; length: number; type: number; modifiers: number }[] = [];
                for (const source of result.tokens) {
                    let line = 0, character = 0;
                    const data = source.data ?? [];
                    for (let offset = 0; offset + 4 < data.length; offset += 5) {
                        line += data[offset]; character = data[offset] === 0 ? character + data[offset + 1] : data[offset + 1];
                        const type = tokenTypes.indexOf(source.legend.tokenTypes[data[offset + 3]]); if (type < 0) continue;
                        let modifiers = 0;
                        source.legend.tokenModifiers.forEach((name, index) => { const target = tokenModifiers.indexOf(name); if (target >= 0 && (data[offset + 4] & (1 << index))) modifiers |= 1 << target; });
                        decoded.push({ line, character, length: data[offset + 2], type, modifiers });
                    }
                }
                decoded.sort((left, right) => left.line - right.line || left.character - right.character);
                const data: number[] = []; let line = 0, character = 0;
                for (const item of decoded) { data.push(item.line - line, item.line === line ? item.character - character : item.character, item.length, item.type, item.modifiers); line = item.line; character = item.character; }
                return { data: new Uint32Array(data) };
            },
        }));
        if (caps?.documentHighlight) providers.push(monaco.languages.registerDocumentHighlightProvider(selector, {
            async provideDocumentHighlights(candidate, at, token) {
                const result = await request(candidate, token, 'documentHighlight', { position: position(at) });
                return result?.status === 'ok' && result.kind === 'documentHighlight' ? result.highlights.map(item => ({ range: engineRange(item.range),
                    kind: item.kind === 2 ? monaco.languages.DocumentHighlightKind.Read : item.kind === 3 ? monaco.languages.DocumentHighlightKind.Write : monaco.languages.DocumentHighlightKind.Text })) : null;
            },
        }));
        if (caps?.selectionRange) providers.push(monaco.languages.registerSelectionRangeProvider(selector, {
            async provideSelectionRanges(candidate, positions, token) {
                const results = [];
                for (const at of positions) {
                    const result = await request(candidate, token, 'selectionRange', { position: position(at) });
                    if (result?.status !== 'ok' || result.kind !== 'selectionRange') return null;
                    results.push(result.ranges.flatMap(item => item.ranges.map(value => ({ range: engineRange(value) }))));
                }
                return results;
            },
        }));
    }
    install();
    const stop = port?.subscribe(install);
    return {
        async runCommand(command) {
            if (disposed || editor.getModel() !== model) return;
            if (command === 'peekReferences') {
                // Monaco's Action2 command is public, but is not returned by getAction().
                editor.focus(); editor.trigger('happier.references', 'editor.action.referenceSearch.trigger', {}); return;
            }
            const actions = { suggest: 'editor.action.triggerSuggest', acceptCompletion: 'acceptSelectedSuggestion', signatureHelp: 'editor.action.triggerParameterHints',
                format: 'editor.action.formatDocument', formatSelection: 'editor.action.formatSelection', expandSelection: 'editor.action.smartSelect.expand', shrinkSelection: 'editor.action.smartSelect.shrink' };
            if (command in actions) { await editor.getAction(actions[command as keyof typeof actions])?.run(); return; }
            const version = model.getVersionId();
            if (command === 'organizeImports') {
                const result = await port?.request('organizeImports');
                if (disposed || model.getVersionId() !== version || result?.status !== 'ok' || result.kind !== 'organizeImports' || result.files.some(file => file.path !== port?.path || file.renameTo)) return;
                const edits = result.files.flatMap(file => file.edits); applyWorkspaceFileTextEdits(model.getValue(), edits);
                editor.pushUndoStop(); editor.executeEdits('happier.organizeImports', edits.map(edit => ({ text: edit.text, range: engineRange(edit.range) }))); editor.pushUndoStop();
            }
        },
        dispose() { disposed = true; cancel(); clearPreviews(); stopOpen?.dispose(); stopEdit.dispose(); stop?.(); for (const provider of providers.splice(0)) provider.dispose(); if (port) editor.updateOptions({ occurrencesHighlight: 'off' }); },
    };
}
