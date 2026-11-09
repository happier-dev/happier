import { fitsNextEditContext, type ProviderModelDescriptorV1 } from '@happier-dev/protocol/models/descriptor';
import { encodeNextEditRewriteWindow, validateLanguageIntelligenceNextEdit,
  type LanguageIntelligenceNextEditInput, type LanguageIntelligencePredictedEdit, type LanguageIntelligenceRecentEdit,
  type LanguageIntelligenceQueryResult, type LanguageIntelligenceRange } from '@happier-dev/protocol/machines/languageIntelligence';
import { applyWorkspaceFileTextEdits, WorkspaceTextPositionError } from '@happier-dev/protocol/machines/workspaceFilesReplace';
import type { CodeEditorInlineContext } from '@/components/ui/code/editor/codeEditorTypes';
import type { CodeInlineSuggestionPort } from './codeInlineSuggestions';
import { resolveFilesEditorAiSuggestionModelId } from '@happier-dev/protocol/account/settings/accountSettings';
import { diffToSingleEdit } from './diffToSingleEdit';

export type CodeNextEditSuggestion = Readonly<{
  id: string; path: string; version: number; targetRange: LanguageIntelligenceRange;
  edits: readonly LanguageIntelligencePredictedEdit[]; previewText: string;
}>;
export type CodeNextEditSnapshot = Readonly<{
  status: 'off' | 'idle' | 'requesting' | 'ready' | 'preview' | 'unavailable'; reason?: string; suggestion: CodeNextEditSuggestion | null;
}>;
/** Implemented by each engine: jump preserves the buffer; apply validates the
 * actual model and makes one undo transaction. Native bridges acknowledge the
 * transaction asynchronously; expected stale/unavailable outcomes return false. */
export type CodeNextEditAdapter = Readonly<{
  jump(position: LanguageIntelligenceRange['start']): void;
  apply(edits: readonly LanguageIntelligencePredictedEdit[], captured: Readonly<{ text: string; version: number }>): boolean | Promise<boolean>;
}>;
type Basis = Readonly<{ context: CodeEditorInlineContext; text: string }>;

/** Candidate/history state only. U16's shared scheduler owns all physical requests. */
export function createCodeNextEditSuggestions(input: Readonly<{
  path: string; port?: CodeInlineSuggestionPort; policy(): string | null; trigger(): void; cancel(): void;
  accepted(edits: readonly LanguageIntelligencePredictedEdit[], captured: Readonly<{ text: string; version: number }>): void;
}>) {
  let snapshot: CodeNextEditSnapshot = { status: 'off', reason: 'off', suggestion: null };
  const listeners = new Set<() => void>();
  let basis: Basis | null = null;
  let history: LanguageIntelligenceRecentEdit[] = [];
  let candidate: Readonly<{ basis: Basis; projection: CodeNextEditSuggestion;
    settings: ReturnType<CodeInlineSuggestionPort['getSettings']>; model: ProviderModelDescriptorV1 }> | null = null;
  let nextId = 0;
  function publish(next: CodeNextEditSnapshot) {
    if (snapshot.status === next.status && snapshot.reason === next.reason && snapshot.suggestion === next.suggestion) return;
    snapshot = next; for (const listener of listeners) listener();
  }
  function retire(status: CodeNextEditSnapshot['status'] = 'idle', reason?: string) {
    candidate = null; publish({ status, ...(reason ? { reason } : {}), suggestion: null });
  }
  function enabled() { return !input.policy() && input.port?.getSettings().nextEditEnabled === true; }
  function suppressed(context: CodeEditorInlineContext) {
    return context.composing || context.hasSelection || context.selectionCount !== 1 || context.suggestWidgetOpen;
  }
  function validSource() {
    return enabled() && candidate && input.port?.getSettings() === candidate.settings && input.port.getModel('nextEdit') === candidate.model;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    updateContext(context: CodeEditorInlineContext, text: string): boolean {
      const previous = basis; basis = { context, text };
      if (!enabled()) { history = []; retire('off', input.policy() ?? 'off'); return false; }
      if (previous && previous.text !== text && context.version > previous.context.version) {
        const edit = diffToSingleEdit(previous.text, text);
        if (edit) {
          const range = { start: { line: edit.startLine, character: edit.startCharacter }, end: { line: edit.endLine, character: edit.endCharacter } };
          try {
            const inverse = applyWorkspaceFileTextEdits(previous.text, [{ range, text: edit.text }]).edits[0];
            history.push({ baseVersion: previous.context.version, version: context.version, range, oldText: inverse.originalText, newText: edit.text });
          } catch (error) { if (!(error instanceof WorkspaceTextPositionError)) throw error; history = []; }
        }
      } else if (previous && (previous.text !== text || previous.context.version !== context.version)) history = [];
      const start = candidate?.projection.edits[0]?.range.start;
      if (snapshot.status === 'preview' && start && validSource() && !suppressed(context)
        && candidate!.basis.text === text && candidate!.basis.context.version === context.version
        && context.line === start.line + 1 && context.character === start.character) return true;
      if (!previous || previous.text !== text || previous.context.version !== context.version
        || previous.context.offset !== context.offset || suppressed(context)) retire();
      return false;
    },
    prepare(model: ProviderModelDescriptorV1): LanguageIntelligenceNextEditInput | null {
      if (!enabled()) { retire('off', input.policy() ?? 'off'); return null; }
      if (!basis || !history.length || !model.nextEdit || suppressed(basis.context) || !input.port) return null;
      const settings = input.port.getSettings();
      const modelId = resolveFilesEditorAiSuggestionModelId(settings, 'nextEdit');
      if (!settings.connectionId || !modelId || model.id !== modelId) return null;
      const lines = basis.text.split(/\r\n|\r|\n/u);
      const target = { range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } }, text: basis.text };
      // The actual model context owns history retention. Never truncate the target.
      let admitted: LanguageIntelligenceNextEditInput | null = null;
      for (let first = history.length - 1; first >= 0; first--) {
        const request = { connectionId: settings.connectionId, modelId, document: basis.text, target, recentEdits: history.slice(first) };
        const encoded = encodeNextEditRewriteWindow(input.path, request, basis.context.version);
        if (!encoded || !fitsNextEditContext(model, encoded.prompt)) break;
        admitted = request;
      }
      if (admitted) { history = admitted.recentEdits; return admitted; }
      retire('unavailable', 'model_unavailable'); return null;
    },
    requesting() { retire('requesting'); },
    receive(response: Extract<LanguageIntelligenceQueryResult, { status: 'ok'; kind: 'ai.nextEdit' }>, captured: Basis, model: ProviderModelDescriptorV1, latencyMs: number) {
      if (!basis || !enabled() || !input.port || response.version !== captured.context.version) return;
      const document = { path: input.path, text: captured.text, version: captured.context.version };
      const edits = validateLanguageIntelligenceNextEdit(document, { path: input.path, text: basis.text, version: basis.context.version }, response.edits);
      if (!edits?.length) { retire(edits ? 'idle' : 'unavailable', edits ? undefined : 'invalid_response'); return; }
      const previewText = applyWorkspaceFileTextEdits(captured.text, edits.map(edit => ({ range: edit.range, text: edit.newText }))).text;
      const lines = captured.text.split(/\r\n|\r|\n/u);
      const projection = { id: String(++nextId), path: input.path, version: response.version,
        targetRange: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } }, edits, previewText };
      candidate = { basis: captured, projection, settings: input.port.getSettings(), model };
      publish({ status: 'ready', suggestion: projection }); input.port.onUsage?.({ kind: 'valid', latencyMs, ...response.usage });
    },
    tab(context: CodeEditorInlineContext, text: string, adapter: CodeNextEditAdapter): boolean {
      if (!candidate || suppressed(context)) return false;
      if (!validSource()) { retire(); return false; }
      const captured = { path: input.path, text: candidate.basis.text, version: candidate.basis.context.version };
      const edits = validateLanguageIntelligenceNextEdit(captured, { path: input.path, text, version: context.version }, candidate.projection.edits, candidate.projection.targetRange);
      if (!edits?.length) { retire(); return false; }
      if (snapshot.status === 'ready') {
        if (context.offset !== candidate.basis.context.offset) { retire(); return false; }
        publish({ status: 'preview', suggestion: candidate.projection });
        adapter.jump(edits[0].range.start); input.port?.onUsage?.({ kind: 'shown' }); return true;
      }
      const start = edits[0].range.start;
      if (snapshot.status !== 'preview' || context.line !== start.line + 1 || context.character !== start.character) return false;
      const applied = adapter.apply(edits, captured);
      retire();
      const acknowledge = (accepted: boolean) => {
        if (accepted && !input.policy()) {
          input.port?.onUsage?.({ kind: 'acceptedFull' }); input.accepted(edits, captured);
        }
      };
      if (typeof applied === 'boolean') { acknowledge(applied); return applied; }
      void applied.then(acknowledge);
      return true;
    },
    trigger: input.trigger,
    dismiss() {
      if (!candidate && snapshot.status !== 'requesting') return;
      const displayed = candidate !== null;
      input.cancel();
      if (displayed) input.port?.onUsage?.({ kind: 'dismissed' });
    },
    retire,
    reset() { history = []; basis = null; retire('off', 'off'); },
    dispose() { history = []; basis = null; candidate = null; listeners.clear(); },
  };
}
