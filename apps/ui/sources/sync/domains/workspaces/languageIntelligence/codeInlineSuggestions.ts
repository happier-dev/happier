import { budgetInlineCompletionContext, type ProviderModelDescriptorV1 } from '@happier-dev/protocol/models/descriptor';
import { resolveFilesEditorAiSuggestionDelayMs, resolveFilesEditorAiSuggestionPolicy, resolveFilesEditorAiSuggestionModelId, type FilesEditorAiSuggestionsV1, type FilesEditorAiSuggestionOperation } from '@happier-dev/protocol/account/settings/accountSettings';
import type { LanguageIntelligenceQueryInput, LanguageIntelligenceQueryResult } from '@happier-dev/protocol/machines/languageIntelligence';
import type { CodeEditorInlineContext, CodeEditorInlineEvent, CodeEditorInlineSuggestion } from '@/components/ui/code/editor/codeEditorTypes';
import { createCodeNextEditSuggestions } from './codeNextEditSuggestions';
import { applyWorkspaceFileTextEdits } from '@happier-dev/protocol/machines/workspaceFilesReplace';

export type CodeInlineSuggestionUsage = Readonly<{
    kind: 'requested' | 'valid' | 'shown' | 'acceptedFull' | 'acceptedPartial' | 'dismissed' | 'kept';
    latencyMs?: number; inputTokens?: number; outputTokens?: number; costUsd?: number;
}>;
export type CodeInlineSuggestionPort = Readonly<{
    getSettings(): FilesEditorAiSuggestionsV1;
    /** Catalog facts for the selected source, including its explicit output allowance. */
    getModel(operation: FilesEditorAiSuggestionOperation): ProviderModelDescriptorV1 | null;
    query(input: LanguageIntelligenceQueryInput, signal: AbortSignal): Promise<LanguageIntelligenceQueryResult>;
    onUsage?(event: CodeInlineSuggestionUsage): void;
}>;
export type CodeInlineSuggestionSnapshot = Readonly<{
    status: 'off' | 'idle' | 'requesting' | 'ready' | 'unavailable';
    reason?: string;
    suggestion: CodeEditorInlineSuggestion | null;
}>;
type Basis = Readonly<{ context: CodeEditorInlineContext; text: string }>;
type Candidate = Basis & Readonly<{ projection: CodeEditorInlineSuggestion; settings: FilesEditorAiSuggestionsV1; model: ProviderModelDescriptorV1 }>;

/** A controller-owned operation, independent of language-server activation and editor engine. */
export function createCodeInlineSuggestions(input: Readonly<{
    rootPath: string; path: string; languageId: string | null; isCurrent(): boolean; port?: CodeInlineSuggestionPort;
}>) {
    let snapshot: CodeInlineSuggestionSnapshot = { status: 'off', reason: 'off', suggestion: null };
    const listeners = new Set<() => void>();
    let basis: Basis | null = null;
    let candidate: Candidate | null = null;
    let acceptance: Candidate | null = null;
    let retained: Readonly<{ spans: readonly Readonly<{ offset: number; text: string }>[]; version: number }> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: AbortController | null = null;
    let ready: FilesEditorAiSuggestionOperation | null = null;
    let disposed = false;
    let active = true;
    let nextId = 0;
    const nextEdit = createCodeNextEditSuggestions({ path: input.path, port: input.port, policy: () => policy('nextEdit'),
        trigger() { retire(); schedule(true, 'nextEdit'); }, cancel() { retire(); },
        accepted(edits, captured) {
            // Inverse coordinates address the post-transaction buffer, including
            // shifts from earlier edits. Count the accepted batch once, only if
            // all its inserted spans survive the next edit (as for ghost text).
            const applied = applyWorkspaceFileTextEdits(captured.text, edits.map(edit => ({ range: edit.range, text: edit.newText })));
            const spans = applied.edits.flatMap(edit => edit.insertText ? [{ offset: edit.startUtf16, text: edit.insertText }] : []);
            retained = spans.length ? { spans, version: basis?.context.version ?? captured.version } : null;
        },
    });

    function publish(next: CodeInlineSuggestionSnapshot) {
        if (snapshot.status === next.status && snapshot.reason === next.reason && snapshot.suggestion === next.suggestion) return;
        snapshot = next;
        for (const listener of listeners) listener();
    }
    function emit(event: CodeInlineSuggestionUsage) { input.port?.onUsage?.(event); }
    function clearSchedule() { if (timer !== null) clearTimeout(timer); timer = null; ready = null; }
    function retire(status: CodeInlineSuggestionSnapshot['status'] = 'idle', reason?: string) {
        clearSchedule(); inFlight?.abort();
        nextEdit.retire(status, reason);
        if (candidate) emit({ kind: 'dismissed' });
        candidate = null;
        publish({ status, ...(reason ? { reason } : {}), suggestion: null });
    }
    function policy(operation?: FilesEditorAiSuggestionOperation): string | null {
        if (disposed || !input.isCurrent()) return 'account_unavailable';
        if (!active || !input.port) return 'off';
        const settings = input.port.getSettings();
        // Document lifecycle remains active with either configured operation.
        // Dispatch and candidate admission always name their exact operation.
        return resolveFilesEditorAiSuggestionPolicy(settings, { path: input.path, languageId: input.languageId ?? 'text',
            operation: operation ?? (settings.modelId ? 'inline' : 'nextEdit') });
    }
    function suppressed(context: CodeEditorInlineContext) {
        return context.composing || context.hasSelection || context.selectionCount !== 1 || context.suggestWidgetOpen;
    }
    function sameBasis(left: Basis, right: Basis) {
        return left.text === right.text && left.context.version === right.context.version && left.context.offset === right.context.offset
            && left.context.line === right.context.line && left.context.character === right.context.character && left.context.eol === right.context.eol;
    }
    function validSource(item: Candidate) {
        return !policy('inline') && input.port?.getSettings() === item.settings && input.port.getModel('inline') === item.model;
    }
    function dispatch() {
        // An aborted upstream may still be settling. Keep only the latest demand,
        // and start it after the incumbent transport actually settles.
        if (inFlight || !ready || !basis || !input.port) return;
        const port = input.port;
        const requestedOperation = ready;
        ready = null;
        const reason = policy();
        if (reason) { retire(reason === 'off' ? 'off' : 'unavailable', reason); return; }
        const captured = basis;
        if (suppressed(captured.context)) return;
        const settings = port.getSettings();
        const inlineModel = requestedOperation === 'inline' ? port.getModel('inline') : null;
        const context = inlineModel && inlineModel.id === settings.modelId ? budgetInlineCompletionContext(inlineModel, {
            prefix: captured.text.slice(0, captured.context.offset), suffix: captured.text.slice(captured.context.offset),
        }) : null;
        // A pause without an eligible inline model can serve next-edit directly.
        // Otherwise its inline answer decides whether this same slot continues.
        const operation = requestedOperation === 'inline' && !context && settings.nextEditEnabled ? 'nextEdit' : requestedOperation;
        const modelId = resolveFilesEditorAiSuggestionModelId(settings, operation);
        const model = operation === 'inline' ? inlineModel : port.getModel('nextEdit');
        const nextEditInput = operation === 'nextEdit' && model?.nextEdit ? nextEdit.prepare(model) : null;
        if (!model || model.id !== modelId || (!context && !nextEditInput) || !settings.connectionId || !modelId) {
            if (operation === 'nextEdit' && model?.nextEdit && model.id === modelId) {
                const state = nextEdit.getSnapshot();
                publish({ status: state.status === 'unavailable' ? 'unavailable' : state.status === 'off' ? 'off' : 'idle', reason: state.reason, suggestion: null });
                return;
            }
            retire('unavailable', 'model_unavailable'); return;
        }
        const request = new AbortController();
        const started = Date.now();
        const requestIsCurrent = () => !request.signal.aborted && basis !== null && sameBasis(captured, basis)
            && !suppressed(basis.context) && !policy(operation) && port.getSettings() === settings && port.getModel(operation) === model;
        const continueNextEdit = () => {
            // Recheck after publication: listeners can synchronously cancel or
            // change the source. The incumbent releases the slot in finally.
            if (operation === 'inline' && requestIsCurrent() && settings.nextEditEnabled && !policy('nextEdit')) ready = 'nextEdit';
        };
        const queryInput: LanguageIntelligenceQueryInput = {
            rootPath: input.rootPath, path: input.path, kind: nextEditInput ? 'ai.nextEdit' : 'ai.inlineSuggest', languageId: input.languageId ?? 'text',
            version: captured.context.version, position: { line: captured.context.line - 1, character: captured.context.character },
            ...(nextEditInput ? { nextEdit: nextEditInput } : { inlineSuggestion: { connectionId: settings.connectionId, modelId, ...context! } }),
        };
        inFlight = request;
        try {
            // These callbacks are synchronous admission, before any transport owns
            // the request. A programmer failure must stay loud and release it.
            publish({ status: 'requesting', suggestion: null });
            // A next-edit-enabled pause remains dismissible during its inline
            // phase too, through the already projected pending-request fact.
            if (nextEditInput || settings.nextEditEnabled) nextEdit.requesting();
            emit({ kind: 'requested' });
        } catch (error) {
            if (inFlight === request) inFlight = null;
            throw error;
        }
        void (async () => {
            try {
                let response: LanguageIntelligenceQueryResult;
                try {
                    response = await port.query(queryInput, request.signal);
                } catch {
                    if (!request.signal.aborted && !policy(operation)) {
                        publish({ status: 'unavailable', reason: 'transport_failed', suggestion: null });
                        nextEdit.retire('unavailable', 'transport_failed');
                    }
                    return;
                }
                if (!requestIsCurrent()) return;
                if (nextEditInput && response.status === 'ok' && response.kind === 'ai.nextEdit') {
                    nextEdit.receive(response, captured, model, Date.now() - started);
                    const state = nextEdit.getSnapshot();
                    publish({ status: state.status === 'unavailable' ? 'unavailable' : state.status === 'ready' ? 'ready' : 'idle', reason: state.reason, suggestion: null });
                    return;
                }
                if (response.status !== 'ok' || response.kind !== 'ai.inlineSuggest' || operation !== 'inline') {
                    const reason = response.status === 'error' ? response.errorCode : response.status === 'unavailable' ? response.reason : 'model_unavailable';
                    nextEdit.retire('unavailable', reason);
                    publish({ status: 'unavailable', reason, suggestion: null });
                    if (response.status === 'ok') continueNextEdit();
                    return;
                }
                // Inline suggestions are insertions; an empty insertion is its
                // no-op. Do not guess that whitespace or a repeated suffix is one.
                if (response.version !== captured.context.version || !response.text) {
                    publish({ status: 'idle', suggestion: null }); continueNextEdit(); return;
                }
                emit({ kind: 'valid', latencyMs: Date.now() - started, ...response.usage });
                const text = captured.context.eol ? response.text.replace(/\r\n|\r|\n/g, captured.context.eol) : response.text;
                const projection = { id: String(++nextId), text, line: captured.context.line, character: captured.context.character };
                candidate = { ...captured, projection, settings, model };
                publish({ status: 'ready', suggestion: projection });
            } finally {
                if (operation === 'inline' && ready !== 'nextEdit' && nextEdit.getSnapshot().status === 'requesting') nextEdit.retire();
                if (inFlight === request) inFlight = null;
                if (!disposed && ready) dispatch();
            }
        })();
    }
    function schedule(manual = false, operation: FilesEditorAiSuggestionOperation = 'inline') {
        if (!basis || !input.port || suppressed(basis.context)) return;
        const reason = policy(operation === 'inline' ? undefined : operation);
        if (reason) { retire(reason === 'off' ? 'off' : 'unavailable', reason); return; }
        if (!manual && input.port.getSettings().mode !== 'automatic') return;
        clearSchedule();
        timer = setTimeout(() => { timer = null; ready = operation; dispatch(); }, manual ? 0 : resolveFilesEditorAiSuggestionDelayMs(input.port.getSettings().delay));
    }
    function updateContext(context: CodeEditorInlineContext, text: string) {
        const previous = basis;
        basis = { context, text };
        const previewJump = nextEdit.updateContext(context, text);
        if (previewJump) return;
        const reason = policy();
        if (reason || suppressed(context)) { retire(reason === 'off' ? 'off' : reason ? 'unavailable' : 'idle', reason ?? undefined); return; }
        if (retained && context.version !== retained.version) {
            if (retained.spans.every(span => text.slice(span.offset, span.offset + span.text.length) === span.text)) emit({ kind: 'kept' });
            retained = null;
        }
        if (candidate && validSource(candidate)) {
            if (sameBasis(candidate, basis)) return;
            const consumed = context.offset - candidate.context.offset;
            if (consumed > 0 && text.length - candidate.text.length === consumed
                && text.slice(0, candidate.context.offset) === candidate.text.slice(0, candidate.context.offset)
                && text.slice(context.offset) === candidate.text.slice(candidate.context.offset)
                && candidate.projection.text.startsWith(text.slice(candidate.context.offset, context.offset))) {
                const remainder = candidate.projection.text.slice(consumed);
                candidate = remainder ? { ...candidate, text, context, projection: { ...candidate.projection, text: remainder, line: context.line, character: context.character } } : null;
                publish({ status: candidate ? 'ready' : 'idle', suggestion: candidate?.projection ?? null });
                return;
            }
        }
        if (previous && sameBasis(previous, basis) && previous.context.composing === context.composing
            && previous.context.hasSelection === context.hasSelection && previous.context.selectionCount === context.selectionCount
            && previous.context.suggestWidgetOpen === context.suggestWidgetOpen) return;
        retire(); schedule();
    }
    let shownId: string | null = null;
    return {
        nextEdit,
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        updateContext,
        setActive(next: boolean) {
            if (active === next) return;
            active = next;
            if (!active) { acceptance = null; retained = null; retire('off', 'off'); nextEdit.reset(); }
            else schedule();
        },
        refresh() {
            const reason = policy();
            if (reason || input.port?.getSettings().nextEditEnabled !== true) nextEdit.reset();
            if (reason || (candidate && !validSource(candidate))) {
                acceptance = null; retained = null;
                retire(reason === 'off' ? 'off' : reason ? 'unavailable' : 'idle', reason ?? undefined);
            } else { retire(); }
            schedule();
        },
        trigger() { retire(); schedule(true); },
        canAccept(id: string, context: CodeEditorInlineContext, text: string): boolean {
            const allowed = Boolean(candidate && candidate.projection.id === id && validSource(candidate)
                && !suppressed(context) && sameBasis(candidate, { context, text }));
            acceptance = allowed ? candidate : null;
            if (!allowed) retire();
            return allowed;
        },
        onEvent(event: CodeEditorInlineEvent) {
            if (event.kind === 'trigger') { retire(); schedule(true); return; }
            if (event.kind === 'shown' && candidate && candidate.projection.id === event.id && shownId !== event.id) {
                shownId = event.id; emit({ kind: 'shown' });
            } else if ((event.kind === 'accepted' || event.kind === 'partiallyAccepted') && acceptance && acceptance.projection.id === event.id) {
                const text = event.acceptedText;
                if (text && acceptance.projection.text.startsWith(text)) {
                    emit({ kind: event.kind === 'accepted' ? 'acceptedFull' : 'acceptedPartial' });
                    retained = { spans: [{ offset: acceptance.context.offset, text }], version: basis?.context.version ?? acceptance.context.version };
                }
                acceptance = null;
            } else if (event.kind === 'dismissed' && candidate?.projection.id === event.id) retire();
        },
        retire() { acceptance = null; retained = null; retire('off', 'off'); nextEdit.reset(); },
        dispose() { disposed = true; clearSchedule(); inFlight?.abort(); nextEdit.dispose(); candidate = null; acceptance = null; retained = null; listeners.clear(); },
    };
}
