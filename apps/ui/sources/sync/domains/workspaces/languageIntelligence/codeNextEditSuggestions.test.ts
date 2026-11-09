import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesEditorAiSuggestionsV1Schema } from '@happier-dev/protocol/account/settings/accountSettings';
import type { LanguageIntelligenceQueryInput, LanguageIntelligenceQueryResult } from '@happier-dev/protocol/machines/languageIntelligence';
import { decodeNextEditRewriteWindow } from '@happier-dev/protocol/machines/languageIntelligence';
import { applyWorkspaceFileTextEdits } from '@happier-dev/protocol/machines/workspaceFilesReplace';
import { createCodeIntelligenceController } from './createCodeIntelligenceController';
import { projectProviderModelGenerationSettings, ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';
import { OLLAMA_PROVIDER_CONTRIBUTION } from '../../../../../../../packages/plugins/ollama/src/provider/contribution';

function fixture(separateModels = false) {
  let text = `function old() { return "🦊"; }\r\n${'//\r\n'.repeat(200)}old();\r\n`;
  const model = projectProviderModelGenerationSettings(ProviderModelDescriptorV1Schema.parse(
    OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels.find(model => 'nextEdit' in model),
  ), { maxTokens: 512 });
  const inlineModel = projectProviderModelGenerationSettings(ProviderModelDescriptorV1Schema.parse(
    OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels.find(model => 'inlineCompletion' in model),
  ), { maxTokens: 128 });
  let settings = { ...FilesEditorAiSuggestionsV1Schema.parse({ enabled: true, nextEditEnabled: true, mode: 'onRequest', connectionId: 'source', modelId: separateModels ? inlineModel.id : model.id }),
    nextEditModelId: separateModels ? model.id : null };
  const requests: { input: LanguageIntelligenceQueryInput; signal: AbortSignal; resolve(value: LanguageIntelligenceQueryResult): void }[] = [];
  const usage: string[] = [];
  const controller = createCodeIntelligenceController({
    scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'src/a.ts', languageId: 'typescript',
    accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
    getText: () => text, query: async () => ({ status: 'unavailable', reason: 'no_capable_server' }), openLocation() {},
    inlineSuggestions: { getSettings: () => settings, getModel: (operation: 'inline' | 'nextEdit') => {
      const id = operation === 'nextEdit' ? settings.nextEditModelId ?? settings.modelId : settings.modelId;
      return id === model.id ? model : separateModels && id === inlineModel.id ? inlineModel : null;
    },
      query: (input, signal) => new Promise(resolve => requests.push({ input, signal, resolve })), onUsage: event => { usage.push(event.kind); } },
  });
  let context = { line: 1, character: 12, offset: 12, version: 1, selectionCount: 1, hasSelection: false, composing: false, suggestWidgetOpen: false, eol: '\r\n' as const };
  function update(patch: Partial<typeof context> = {}, value = text) { text = value; context = { ...context, ...patch }; controller.inlineSuggestions.updateContext(context, text); }
  function rename() { update({ version: 2, character: 16, offset: 16 }, text.replace('function old', 'function renamed')); }
  return { controller, requests, usage, rename, update, context: () => context, text: () => text,
    configure(patch: Partial<typeof settings>) { settings = { ...settings, ...patch }; controller.inlineSuggestions.refresh(); },
    answer(index = 0) { requests[index].resolve({ status: 'ok', kind: 'ai.nextEdit', version: requests[index].input.version!,
      edits: [{ path: 'src/a.ts', range: { start: { line: 201, character: 0 }, end: { line: 201, character: 3 } }, oldText: 'old', newText: 'renamed' }] }); },
  };
}
afterEach(() => vi.useRealTimers());

describe('next edits through the shared code intelligence controller', () => {
  it.each([true, false])('retains a decoded multi-edit acceptance once only when every inserted span survives (%s)', async survives => {
    vi.useFakeTimers(); const f = fixture();
    try {
      f.update({}, f.text() + 'old();\r\n'); f.rename();
      f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync();
      const request = f.requests[0].input;
      const rewritten = f.text().replaceAll('old();', 'renamed();');
      const edits = decodeNextEditRewriteWindow('src/a.ts', request.nextEdit!, request.version!, rewritten, true)!;
      expect(edits).toHaveLength(2);
      f.requests[0].resolve({ status: 'ok', kind: 'ai.nextEdit', version: 2, edits: [...edits] }); await vi.runAllTimersAsync();
      expect(f.controller.nextEditSuggestions.getSnapshot().suggestion?.edits).toEqual(edits);
      let acknowledge!: (value: boolean) => void;
      const adapter = { jump() {}, apply: () => {
        const updated = applyWorkspaceFileTextEdits(f.text(), edits.map(edit => ({ range: edit.range, text: edit.newText }))).text;
        f.update({ version: 3 }, updated);
        return new Promise<boolean>(resolve => { acknowledge = resolve; });
      } };
      f.controller.nextEditSuggestions.tab(f.context(), f.text(), adapter);
      f.update({ line: 202, character: 0, offset: f.text().indexOf('old();') });
      f.controller.nextEditSuggestions.tab(f.context(), f.text(), adapter);
      expect(f.text()).toBe(rewritten);
      expect(f.usage).not.toContain('acceptedFull'); expect(f.usage).not.toContain('kept');
      acknowledge(true); await vi.runAllTimersAsync();
      expect(f.usage.filter(kind => kind === 'acceptedFull')).toHaveLength(1);
      const nextText = survives ? f.text() + ' ' : f.text().slice(0, f.text().lastIndexOf('renamed();')) + 'different();\r\n';
      f.update({ version: 4 }, nextText);
      expect(f.usage.filter(kind => kind === 'kept')).toHaveLength(survives ? 1 : 0);
    } finally { f.controller.dispose(); }
  });
  it('lets the existing pending next-edit dismissal cancel the inline phase and suppress its continuation', async () => {
    vi.useFakeTimers(); const f = fixture(true);
    try {
      f.update(); f.rename(); f.controller.inlineSuggestions.onEvent({ kind: 'trigger' }); await vi.runAllTimersAsync();
      expect(f.requests[0].input.kind).toBe('ai.inlineSuggest');
      expect(f.controller.nextEditSuggestions.getSnapshot().status).toBe('requesting');
      f.controller.nextEditSuggestions.dismiss();
      expect(f.requests[0].signal.aborted).toBe(true);
      f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 2, text: '' });
      await vi.runAllTimersAsync();
      expect(f.requests).toHaveLength(1);
      expect(f.controller.nextEditSuggestions.getSnapshot().status).not.toBe('requesting');
    } finally { f.controller.dispose(); }
  });
  it.each(['automatic', 'onRequest'] as const)('gives displayable ghost text the whole %s pause without requesting next-edit', async mode => {
    vi.useFakeTimers(); const f = fixture(true);
    try {
      f.configure({ mode }); f.update(); f.rename();
      if (mode === 'onRequest') {
        await vi.runAllTimersAsync(); expect(f.requests).toHaveLength(0);
        f.controller.inlineSuggestions.onEvent({ kind: 'trigger' });
      }
      await vi.runAllTimersAsync();
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0].input.kind).toBe('ai.inlineSuggest');
      f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 2, text: 'ghost' });
      await vi.runAllTimersAsync();
      expect(f.controller.inlineSuggestions.getSnapshot().suggestion?.text).toBe('ghost');
      expect(f.requests).toHaveLength(1);
      expect(f.controller.nextEditSuggestions.getSnapshot().suggestion).toBeNull();
      expect(f.controller.nextEditSuggestions.getSnapshot().status).not.toBe('requesting');
    } finally { f.controller.dispose(); }
  });

  it.each(['automatic', 'onRequest'] as const)('continues one %s pause from an empty inline insertion to next-edit, then cancels it on a keystroke', async mode => {
    vi.useFakeTimers(); const f = fixture(true);
    try {
      f.configure({ mode }); f.update(); f.rename();
      if (mode === 'onRequest') f.controller.inlineSuggestions.onEvent({ kind: 'trigger' });
      await vi.runAllTimersAsync();
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0].input.kind).toBe('ai.inlineSuggest');
      f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 2, text: '' });
      // Settling the first request is sufficient: no second debounce is owed.
      await vi.advanceTimersByTimeAsync(0);
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1].input).toMatchObject({ kind: 'ai.nextEdit', version: 2, nextEdit: {
        modelId: OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels.find(model => 'nextEdit' in model)!.id,
      } });
      expect(f.requests[0].signal.aborted).toBe(false);
      f.update({ version: 3, character: 17, offset: 17 }, f.text().replace('renamed', 'renamedX'));
      expect(f.requests[1].signal.aborted).toBe(true);
      f.answer(1); await vi.advanceTimersByTimeAsync(0);
      expect(f.requests).toHaveLength(2);
      expect(f.controller.nextEditSuggestions.getSnapshot().suggestion).toBeNull();
    } finally { f.controller.dispose(); }
  });

  it('continues after an inline answer is refused as invalid, but not after a cancelled pause or a disabled next-edit preference', async () => {
    vi.useFakeTimers(); const f = fixture(true);
    try {
      f.update(); f.rename(); f.controller.inlineSuggestions.trigger(); await vi.runAllTimersAsync();
      f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 1, text: 'wrong version' });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1].input.kind).toBe('ai.nextEdit');
      f.answer(1); await vi.advanceTimersByTimeAsync(0);
      f.controller.inlineSuggestions.trigger(); await vi.runAllTimersAsync();
      f.update({ character: 17, offset: 17 });
      expect(f.requests[2].signal.aborted).toBe(true);
      f.requests[2].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 2, text: '' });
      await vi.advanceTimersByTimeAsync(0); expect(f.requests).toHaveLength(3);
      f.configure({ nextEditEnabled: false }); f.controller.inlineSuggestions.trigger(); await vi.runAllTimersAsync();
      f.requests[3].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 2, text: '' });
      await vi.advanceTimersByTimeAsync(0); expect(f.requests).toHaveLength(4);
      expect(f.controller.inlineSuggestions.getSnapshot().suggestion).toBeNull();
    } finally { f.controller.dispose(); }
  });

  it.each(['automatic', 'onRequest'] as const)('requests next-edit directly for a %s pause with no eligible inline model', async mode => {
    vi.useFakeTimers(); const f = fixture(true);
    try {
      f.configure({ mode, modelId: null }); f.update(); f.rename();
      if (mode === 'onRequest') f.controller.inlineSuggestions.onEvent({ kind: 'trigger' });
      await vi.runAllTimersAsync();
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0].input.kind).toBe('ai.nextEdit');
      f.answer(); await vi.advanceTimersByTimeAsync(0);
      expect(f.controller.nextEditSuggestions.getSnapshot().status).toBe('ready');
    } finally { f.controller.dispose(); }
  });

  it('refuses an inline answer to a next-edit request instead of switching operations', async () => {
    vi.useFakeTimers(); const f = fixture(true);
    try {
      f.update(); f.rename(); f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync();
      expect(f.requests[0].input.kind).toBe('ai.nextEdit');
      f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 2, text: 'wrong operation' });
      await vi.runAllTimersAsync();
      expect(f.controller.inlineSuggestions.getSnapshot().suggestion).toBeNull();
      expect(f.controller.nextEditSuggestions.getSnapshot().suggestion).toBeNull();
      expect(f.usage).not.toContain('valid');
    } finally { f.controller.dispose(); }
  });
  it('refuses unsupported or unavailable explicit next-edit choices instead of substituting inline or the former next model', async () => {
    vi.useFakeTimers(); const f = fixture(true);
    try {
      f.update(); f.rename();
      for (const nextEditModelId of ['qwen2.5-coder:1.5b-base', 'missing-model', null]) {
        f.configure({ nextEditModelId }); f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync();
        expect(f.requests).toHaveLength(0);
      }
    } finally { f.controller.dispose(); }
  });

  it('keeps an explicitly selected next-edit model usable without an inline model', async () => {
    vi.useFakeTimers(); const f = fixture(true);
    try {
      f.configure({ modelId: null }); f.update(); f.rename();
      f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync();
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0].input.kind).toBe('ai.nextEdit');
      f.answer(); await vi.runAllTimersAsync(); f.update();
      expect(f.controller.nextEditSuggestions.getSnapshot().status).toBe('ready');
    } finally { f.controller.dispose(); }
  });
  it('requests Qwen ghost text and Sweep next-edit independently on the same selected connection', async () => {
    vi.useFakeTimers(); const f = fixture(true);
    try {
      f.update(); f.rename(); f.controller.inlineSuggestions.trigger(); await vi.runAllTimersAsync();
      expect(f.requests[0].input).toMatchObject({ kind: 'ai.inlineSuggest', inlineSuggestion: {
        connectionId: 'source', modelId: OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels.find(model => 'inlineCompletion' in model)!.id } });
      f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 2, text: 'suffix' }); await vi.runAllTimersAsync();
      f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync();
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1].input).toMatchObject({ kind: 'ai.nextEdit', nextEdit: {
        connectionId: 'source', modelId: OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels.find(model => 'nextEdit' in model)!.id } });
      f.answer(1); await vi.runAllTimersAsync();
      expect(f.controller.nextEditSuggestions.getSnapshot().status).toBe('ready');
    } finally { f.controller.dispose(); }
  });
  it('captures a top-of-file rename, previews a distant call, then applies once with an exact guard', async () => {
    vi.useFakeTimers(); const f = fixture();
    try {
      expect(f.controller.nextEditSuggestions).toBeDefined();
      f.update(); f.rename(); f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync();
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0].input).toMatchObject({ kind: 'ai.nextEdit', version: 2, nextEdit: { document: f.text(), recentEdits: [
        { baseVersion: 1, version: 2, oldText: 'ol', newText: 'rename' },
      ], target: { text: f.text(), range: { start: { line: 0, character: 0 }, end: { line: 202, character: 0 } } } } });
      f.answer(); await vi.runAllTimersAsync();
      expect(f.controller.nextEditSuggestions.getSnapshot()).toMatchObject({ status: 'ready', suggestion: { previewText: f.text().replace('old();', 'renamed();') } });
      const writes: unknown[] = [];
      const adapter = { jump: vi.fn(), apply: (edits: unknown) => { writes.push(edits); return true; } };
      expect(f.controller.nextEditSuggestions.tab(f.context(), f.text(), adapter)).toBe(true);
      expect(adapter.jump).toHaveBeenCalledWith({ line: 201, character: 0 }); expect(writes).toHaveLength(0);
      const target = f.text().lastIndexOf('old();'); f.update({ line: 202, character: 0, offset: target });
      expect(f.controller.nextEditSuggestions.getSnapshot().status).toBe('preview');
      expect(f.controller.nextEditSuggestions.tab(f.context(), f.text(), adapter)).toBe(true);
      expect(writes).toHaveLength(1);
      expect(f.controller.nextEditSuggestions.tab(f.context(), f.text(), adapter)).toBe(false);
    } finally { f.controller.dispose(); }
  });
  it('does not dispatch when the preference is off or the path is excluded', async () => {
    vi.useFakeTimers(); const f = fixture();
    try {
      expect(f.controller.nextEditSuggestions).toBeDefined();
      f.configure({ nextEditEnabled: false }); f.update(); f.rename(); f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync();
      expect(f.requests).toHaveLength(0);
      f.configure({ nextEditEnabled: true, excludedGlobs: ['**/*.ts'] });
      f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync(); expect(f.requests).toHaveLength(0);
    } finally { f.controller.dispose(); }
  });
  it('keeps one physical request, aborts on caret/edit changes, and drops late answers', async () => {
    vi.useFakeTimers(); const f = fixture();
    try {
      expect(f.controller.nextEditSuggestions).toBeDefined();
      f.update(); f.rename(); f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync();
      f.update({ character: 17, offset: 17 });
      expect(f.requests[0].signal.aborted).toBe(true);
      f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync(); expect(f.requests).toHaveLength(1);
      f.answer(); await vi.runAllTimersAsync(); expect(f.requests).toHaveLength(2);
      expect(f.controller.nextEditSuggestions.getSnapshot().suggestion).toBeNull();
      f.update({ version: 3, offset: 18, character: 18 }, f.text().replace('renamed', 'renamedX'));
      expect(f.requests[1].signal.aborted).toBe(true);
      f.answer(1); await vi.runAllTimersAsync(); expect(f.controller.nextEditSuggestions.getSnapshot().suggestion).toBeNull();
    } finally { f.controller.dispose(); }
  });
  it('cancels a dismissed pending prediction and never shows its late answer', async () => {
    vi.useFakeTimers(); const f = fixture();
    try {
      f.update(); f.rename(); f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync();
      expect(f.requests).toHaveLength(1);
      f.controller.nextEditSuggestions.dismiss();
      expect(f.requests[0].signal.aborted).toBe(true);
      f.answer(); await vi.runAllTimersAsync();
      expect(f.controller.nextEditSuggestions.getSnapshot().suggestion).toBeNull();
    } finally { f.controller.dispose(); }
  });
  it.each([true, false])('consumes native apply once and records acceptance only after its actual acknowledgment (%s)', async accepted => {
    vi.useFakeTimers(); const f = fixture();
    try {
      f.update(); f.rename(); f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync(); f.answer(); await vi.runAllTimersAsync();
      let acknowledge!: (value: boolean) => void;
      const adapter = { jump() {}, apply: vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve; })) };
      expect(f.controller.nextEditSuggestions.tab(f.context(), f.text(), adapter)).toBe(true);
      f.update({ line: 202, character: 0, offset: f.text().lastIndexOf('old();') });
      expect(f.controller.nextEditSuggestions.tab(f.context(), f.text(), adapter)).toBe(true);
      expect(f.usage).not.toContain('acceptedFull');
      expect(f.controller.nextEditSuggestions.tab(f.context(), f.text(), adapter)).toBe(false);
      acknowledge(accepted); await vi.runAllTimersAsync();
      expect(f.usage.filter(kind => kind === 'acceptedFull')).toHaveLength(accepted ? 1 : 0);
      expect(adapter.apply).toHaveBeenCalledTimes(1);
    } finally { f.controller.dispose(); }
  });
  it.each(['text', 'version'] as const)('revalidates %s immediately before apply even without an intervening engine event', async changed => {
    vi.useFakeTimers(); const f = fixture();
    try {
      f.update(); f.rename(); f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync(); f.answer(); await vi.runAllTimersAsync();
      const adapter = { jump: vi.fn(), apply: vi.fn(() => true) };
      expect(f.controller.nextEditSuggestions.tab(f.context(), f.text(), adapter)).toBe(true);
      const target = { ...f.context(), line: 202, character: 0, offset: f.text().lastIndexOf('old();'),
        ...(changed === 'version' ? { version: 3 } : {}) };
      expect(f.controller.nextEditSuggestions.tab(target, changed === 'text' ? f.text() + ' ' : f.text(), adapter)).toBe(false);
      expect(adapter.apply).not.toHaveBeenCalled();
      expect(f.controller.nextEditSuggestions.getSnapshot().suggestion).toBeNull();
    } finally { f.controller.dispose(); }
  });
  it('rejects a stale apply and respects IME, selection, list contention, and dismissal', async () => {
    vi.useFakeTimers(); const f = fixture();
    try {
      expect(f.controller.nextEditSuggestions).toBeDefined();
      f.update(); f.rename(); f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync(); f.answer(); await vi.runAllTimersAsync();
      const adapter = { jump: vi.fn(), apply: vi.fn(() => true) };
      expect(f.controller.nextEditSuggestions.tab({ ...f.context(), suggestWidgetOpen: true }, f.text(), adapter)).toBe(false);
      expect(adapter.jump).not.toHaveBeenCalled();
      f.controller.nextEditSuggestions.dismiss(); expect(f.controller.nextEditSuggestions.getSnapshot().suggestion).toBeNull();
      for (const patch of [{ composing: true }, { hasSelection: true }, { selectionCount: 2 }]) {
        f.update(patch); f.controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync();
      }
      expect(f.requests).toHaveLength(1); expect(adapter.apply).not.toHaveBeenCalled();
    } finally { f.controller.dispose(); }
  });
});
