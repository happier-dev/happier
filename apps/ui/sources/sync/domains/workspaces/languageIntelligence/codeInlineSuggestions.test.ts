import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LanguageIntelligenceQueryInput, LanguageIntelligenceQueryResult } from '@happier-dev/protocol/machines/languageIntelligence';
import { FilesEditorAiSuggestionsV1Schema } from '@happier-dev/protocol/account/settings/accountSettings';
import { DaemonLspQueryResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { createCodeIntelligenceController } from './createCodeIntelligenceController';
import { bindCodeIntelligenceEditor } from './bindCodeIntelligenceEditor';
import type { CodeInlineSuggestionPort } from './codeInlineSuggestions';
import type { CodeEditorInlineEvent, CodeEditorInlineSuggestion } from '@/components/ui/code/editor/codeEditorTypes';

function fixture(onUsage?: CodeInlineSuggestionPort['onUsage']) {
    let current = true;
    let settings = FilesEditorAiSuggestionsV1Schema.parse({ enabled: true, connectionId: 'source', modelId: 'model',
        excludedGlobs: ['**/.env*'] });
    const requests: { input: LanguageIntelligenceQueryInput; signal: AbortSignal;
        resolve(value: LanguageIntelligenceQueryResult): void; reject(error: unknown): void }[] = [];
    const usage: string[] = [];
    const model = { id: 'model', name: 'Model', contextWindowTokens: 2048,
        inlineCompletion: { operationId: 'fim', tokenAccounting: 'utf8-bytes' as const, outputTokens: 128, promptOverheadTokens: 16 } };
    const controller = createCodeIntelligenceController({
        scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'src/a.ts', languageId: 'typescript',
        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => current,
            onRetire: () => ({ dispose() {} }) },
        getText: () => 'const value = ', query: async () => ({ status: 'unavailable', reason: 'no_capable_server' }), openLocation() {},
        inlineSuggestions: {
            getSettings: () => settings,
            getModel: () => model,
            query: (input, signal) => new Promise((resolve, reject) => { requests.push({ input, signal, resolve, reject }); }),
            onUsage: event => { usage.push(event.kind); onUsage?.(event); },
        },
    });
    const context = { line: 1, character: 14, offset: 14, version: 1, selectionCount: 1, hasSelection: false, composing: false, suggestWidgetOpen: false,
        eol: undefined as '\n' | '\r\n' | '\r' | undefined };
    return { controller, requests, usage, context,
        configure(patch: Partial<typeof settings>) { settings = { ...settings, ...patch }; controller.inlineSuggestions.refresh(); },
        retire() { current = false; },
        move(patch: Partial<typeof context> = {}, text = 'const value = ') { controller.inlineSuggestions.updateContext({ ...context, ...patch }, text); },
    };
}

afterEach(() => { vi.useRealTimers(); });

describe('inline suggestions through the code intelligence controller', () => {
    it('retains a typed Provider refusal and Saved Secret reason after transport parsing', async () => {
        vi.useFakeTimers();
        const f = fixture();
        try {
            f.move(); await vi.runAllTimersAsync();
            const error = createProviderErrorV1('provider_binding_changed', { savedSecretReason: 'reference_stale' });
            f.requests[0].resolve(DaemonLspQueryResponseSchema.parse({ status: 'error', errorCode: 'provider_error', error }));
            await vi.runAllTimersAsync();
            expect(f.controller.inlineSuggestions.getSnapshot()).toMatchObject({
                status: 'unavailable', reason: 'provider_binding_changed', error, suggestion: null,
            });
            expect(f.controller.nextEditSuggestions.getSnapshot()).toMatchObject({
                status: 'unavailable', reason: 'provider_binding_changed', error, suggestion: null,
            });
        } finally { f.controller.dispose(); }
    });
    it('settles suggestions through a refused physical usage write and records later requests after recovery', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { fileEditorAiSuggestionUsageState } = await import('@/sync/domains/state/filePaneUiState');
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const { serverAccountScopeKeySuffix } = await import('@/sync/domains/scope/serverAccountScope');
        const { recordFileEditorAiSuggestionUsage, readFileEditorAiSuggestionUsage } = await import('@/sync/store/files/fileEditorAiSuggestionUsage');
        vi.useFakeTimers();
        const scope = { serverId: 'home', accountId: 'account' };
        const key = serverAccountScopeKeySuffix(scope);
        const previousScope = storage.getState().settingsScope;
        const previousUsage = fileEditorAiSuggestionUsageState.read(key);
        storage.setState({ settingsScope: scope });
        fileEditorAiSuggestionUsageState.remove(key);
        const device = getPersistenceStorage();
        const write = device.set.bind(device);
        const refused = vi.spyOn(device, 'set').mockImplementation((storageKey, value) => {
            if (storageKey.startsWith('ui-state:editor-ai-usage-v1:')) throw new Error('private device error details');
            write(storageKey, value);
        });
        const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const f = fixture(event => recordFileEditorAiSuggestionUsage(scope, event));
        try {
            f.move(); await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(1);
            f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 1, text: 'first' });
            await vi.runAllTimersAsync();
            expect(f.controller.inlineSuggestions.getSnapshot()).toMatchObject({ status: 'ready', suggestion: { text: 'first' } });
            expect(readFileEditorAiSuggestionUsage(scope)).toMatchObject({ requested: 0, valid: 0 });
            expect(diagnostic).toHaveBeenCalled();
            expect(diagnostic.mock.calls.flat().join(' ')).not.toContain('private device error details');

            refused.mockRestore();
            f.controller.inlineSuggestions.trigger(); await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(2);
            f.requests[1].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 1, text: 'recovered' });
            await vi.runAllTimersAsync();
            expect(f.controller.inlineSuggestions.getSnapshot()).toMatchObject({ status: 'ready', suggestion: { text: 'recovered' } });
            expect(readFileEditorAiSuggestionUsage(scope)).toMatchObject({ requested: 1, valid: 1 });

            const programmerError = new TypeError('invalid usage producer');
            expect(() => recordFileEditorAiSuggestionUsage(scope, { get kind(): 'requested' { throw programmerError; } })).toThrow(programmerError);
        } finally {
            f.controller.dispose(); refused.mockRestore(); diagnostic.mockRestore();
            if (previousUsage) fileEditorAiSuggestionUsageState.set(key, previousUsage);
            else fileEditorAiSuggestionUsageState.remove(key);
            storage.setState({ settingsScope: previousScope });
        }
    });

    it.each(['requested usage', 'requesting publication'] as const)('keeps %s programmer errors loud without wedging the next request', async failure => {
        vi.useFakeTimers();
        const programmerError = new TypeError('invalid synchronous callback');
        let fail = true;
        const f = fixture(event => { if (fail && failure === 'requested usage' && event.kind === 'requested') throw programmerError; });
        const unsubscribe = f.controller.inlineSuggestions.subscribe(() => {
            if (fail && failure === 'requesting publication' && f.controller.inlineSuggestions.getSnapshot().status === 'requesting') throw programmerError;
        });
        try {
            f.move();
            await expect(vi.runAllTimersAsync()).rejects.toBe(programmerError);
            expect(f.requests).toHaveLength(0);
            fail = false;
            f.controller.inlineSuggestions.trigger(); await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(1);
            f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 1, text: 'recovered' });
            await vi.runAllTimersAsync();
            expect(f.controller.inlineSuggestions.getSnapshot().suggestion?.text).toBe('recovered');
        } finally { unsubscribe(); f.controller.dispose(); }
    });

    it('retains transport failure status and permits the next requested suggestion', async () => {
        vi.useFakeTimers();
        const f = fixture();
        try {
            f.move(); await vi.runAllTimersAsync();
            f.requests[0].reject(new Error('transport refused'));
            await vi.runAllTimersAsync();
            expect(f.controller.inlineSuggestions.getSnapshot()).toMatchObject({ status: 'unavailable', reason: 'transport_failed', suggestion: null });
            f.controller.inlineSuggestions.trigger(); await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(2);
            f.requests[1].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 1, text: 'recovered' });
            await vi.runAllTimersAsync();
            expect(f.controller.inlineSuggestions.getSnapshot()).toMatchObject({ status: 'ready', suggestion: { text: 'recovered' } });
        } finally { f.controller.dispose(); }
    });

    it('ignores orphan engine events without attributing or accepting a candidate', () => {
        const f = fixture();
        try {
            f.controller.inlineSuggestions.onEvent({ kind: 'shown' });
            f.controller.inlineSuggestions.onEvent({ kind: 'accepted', acceptedText: 'unowned' });
            expect(f.usage).toEqual([]);
        } finally { f.controller.dispose(); }
    });

    it('does not dispatch while off, during composition, selection or multiple carets, and needs no language server', async () => {
        vi.useFakeTimers();
        const f = fixture();
        try {
            f.configure({ enabled: false }); f.move(); await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(0);
            f.configure({ enabled: true });
            for (const context of [{ composing: true }, { hasSelection: true }, { selectionCount: 2 }, { suggestWidgetOpen: true }]) {
                f.move(context); await vi.runAllTimersAsync();
            }
            expect(f.requests).toHaveLength(0);
            f.move(); await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(1);
            expect(f.requests[0].input).toMatchObject({ kind: 'ai.inlineSuggest', inlineSuggestion: { connectionId: 'source', modelId: 'model' } });
        } finally { f.controller.dispose(); }
    });

    it('keeps one physical request outstanding, cancels incompatible edits, and drops late answers', async () => {
        vi.useFakeTimers(); const f = fixture();
        try {
            f.move(); await vi.runAllTimersAsync();
            f.move({ character: 15, offset: 15, version: 2 }, 'const value = x'); await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(1);
            expect(f.requests[0].signal.aborted).toBe(true);
            f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 1, text: 'old' });
            await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(2);
            expect(f.controller.inlineSuggestions.getSnapshot().suggestion).toBeNull();
            f.requests[1].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 2, text: 'yz' });
            await vi.runAllTimersAsync();
            expect(f.controller.inlineSuggestions.getSnapshot().suggestion?.text).toBe('yz');
        } finally { f.controller.dispose(); }
    });

    it('consumes matching typing locally, retires on completion-list opening and rechecks policy at accept', async () => {
        vi.useFakeTimers(); const f = fixture();
        try {
            f.move(); await vi.runAllTimersAsync();
            f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 1, text: 'answer()' });
            await vi.runAllTimersAsync();
            f.move({ character: 17, offset: 17, version: 2 }, 'const value = ans'); await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(1);
            const suggestion = f.controller.inlineSuggestions.getSnapshot().suggestion;
            expect(suggestion?.text).toBe('wer()');
            expect(f.controller.inlineSuggestions.canAccept(suggestion!.id, { ...f.context, character: 17, offset: 17, version: 2 }, 'const value = ans')).toBe(true);
            f.configure({ enabled: false });
            expect(f.controller.inlineSuggestions.canAccept(suggestion!.id, { ...f.context, character: 17, offset: 17, version: 2 }, 'const value = ans')).toBe(false);
            f.configure({ enabled: true }); f.move(); await vi.runAllTimersAsync();
            f.requests[1].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 1, text: 'next' }); await vi.runAllTimersAsync();
            f.move({ suggestWidgetOpen: true });
            expect(f.controller.inlineSuggestions.getSnapshot().suggestion).toBeNull();
        } finally { f.controller.dispose(); }
    });

    it('manual mode only dispatches on intent and retires answers after Account or Provider changes', async () => {
        vi.useFakeTimers(); const f = fixture();
        try {
            f.configure({ mode: 'onRequest' }); f.move(); await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(0);
            f.controller.inlineSuggestions.trigger(); await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(1);
            f.configure({ connectionId: FilesEditorAiSuggestionsV1Schema.parse({ connectionId: 'other' }).connectionId });
            expect(f.requests[0].signal.aborted).toBe(true);
            f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 1, text: 'stale' }); await vi.runAllTimersAsync();
            expect(f.controller.inlineSuggestions.getSnapshot().suggestion).toBeNull();
            f.retire(); f.controller.inlineSuggestions.trigger(); await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(1);
        } finally { f.controller.dispose(); }
    });

    it('does not request from a retained editor after leaving Edit or hiding its tab', async () => {
        vi.useFakeTimers(); const f = fixture();
        try {
            f.move(); f.controller.inlineSuggestions.setActive(false);
            await vi.runAllTimersAsync();
            f.move({ offset: 15, character: 15, version: 2 }, 'const value = x'); await vi.runAllTimersAsync();
            f.controller.inlineSuggestions.trigger(); await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(0);
            f.controller.inlineSuggestions.setActive(true); await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(1);
        } finally { f.controller.dispose(); }
    });

    it('reports separate content-free requested, valid, shown, accepted and kept outcomes', async () => {
        vi.useFakeTimers(); const f = fixture();
        try {
            f.move(); await vi.runAllTimersAsync();
            f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 1, text: 'café\r\n\t世界' });
            await vi.runAllTimersAsync();
            const id = f.controller.inlineSuggestions.getSnapshot().suggestion!.id;
            f.controller.inlineSuggestions.onEvent({ kind: 'shown', id });
            f.controller.inlineSuggestions.onEvent({ kind: 'shown', id });
            expect(f.controller.inlineSuggestions.canAccept(id, f.context, 'const value = ')).toBe(true);
            f.move({ offset: 18, character: 18, version: 2 }, 'const value = café');
            f.controller.inlineSuggestions.onEvent({ kind: 'partiallyAccepted', id, acceptedText: 'café' });
            const rest = f.controller.inlineSuggestions.getSnapshot().suggestion!;
            expect(rest.text).toBe('\r\n\t世界');
            const context = { ...f.context, offset: 18, character: 18, version: 2 };
            expect(f.controller.inlineSuggestions.canAccept(id, context, 'const value = café')).toBe(true);
            f.move({ offset: 23, character: 3, line: 2, version: 3 }, 'const value = café\r\n\t世界');
            f.controller.inlineSuggestions.onEvent({ kind: 'accepted', id, acceptedText: '\r\n\t世界' });
            f.move({ offset: 24, character: 4, line: 2, version: 4 }, 'const value = café\r\n\t世界;');
            expect(f.usage).toEqual(['requested', 'valid', 'shown', 'acceptedPartial', 'kept', 'acceptedFull', 'kept']);
        } finally { f.controller.dispose(); }
    });

    it('issues one bounded-context request after a typing burst on a 5k-line document', async () => {
        vi.useFakeTimers(); const f = fixture();
        try {
            const text = Array.from({ length: 5000 }, (_, i) => `const v${i} = ${i};`).join('\r\n');
            for (let i = 1; i <= 50; i += 1) {
                f.move({ line: 5000, offset: text.length + i, character: 20 + i, version: i }, text + 'x'.repeat(i));
                await vi.advanceTimersByTimeAsync(1);
            }
            expect(f.requests).toHaveLength(0);
            await vi.advanceTimersByTimeAsync(250);
            expect(f.requests).toHaveLength(1);
            const context = f.requests[0].input.inlineSuggestion!;
            expect(new TextEncoder().encode(context.prefix + context.suffix).length).toBeLessThanOrEqual(2048 - 128 - 16);
            expect(context.prefix.endsWith('x'.repeat(50))).toBe(true);
            expect(f.requests[0].input).not.toHaveProperty('contents');
        } finally { f.controller.dispose(); }
    });

    it('binds native editor context, projection and the synchronous accept guard through one controller', async () => {
        vi.useFakeTimers(); const f = fixture();
        let projected: CodeEditorInlineSuggestion | null = null;
        let changed = () => {};
        let emit = (_event: CodeEditorInlineEvent) => {};
        const guard: { current: ((id: string) => boolean) | null } = { current: null };
        let context = f.context;
        const stop = bindCodeIntelligenceEditor(f.controller, {
            getValue: () => 'const value = ',
            inlineSuggestions: {
                set(value) { projected = value; }, getContext: () => context,
                getSuggestion: () => projected,
                subscribeContext(listener) { changed = listener; return () => { changed = () => {}; }; },
                onEvent(listener) { emit = listener; return () => { emit = () => {}; }; },
                setAcceptGuard(value) { guard.current = value; },
            },
        });
        try {
            await vi.runAllTimersAsync();
            expect(f.requests).toHaveLength(1);
            f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 1, text: 'answer()' });
            await vi.runAllTimersAsync();
            expect(projected).toMatchObject({ text: 'answer()' });
            const id = f.controller.inlineSuggestions.getSnapshot().suggestion!.id;
            expect(guard.current?.(id)).toBe(true);
            emit({ kind: 'shown', id });
            context = { ...context, suggestWidgetOpen: true }; changed();
            expect(projected).toBeNull();
            expect(guard.current?.(id)).toBe(false);
        } finally { stop(); f.controller.dispose(); }
        expect(guard.current).toBeNull();
    });

    it('uses the engine line ending for the displayed insertion and matching typing-through', async () => {
        vi.useFakeTimers(); const f = fixture();
        try {
            f.move({ eol: '\r\n' }); await vi.runAllTimersAsync();
            f.requests[0].resolve({ status: 'ok', kind: 'ai.inlineSuggest', version: 1, text: '\n\t世界' });
            await vi.runAllTimersAsync();
            expect(f.controller.inlineSuggestions.getSnapshot().suggestion?.text).toBe('\r\n\t世界');
            f.move({ eol: '\r\n', version: 2, line: 2, character: 0, offset: 16 }, 'const value = \r\n');
            await vi.runAllTimersAsync();
            expect(f.controller.inlineSuggestions.getSnapshot().suggestion?.text).toBe('\t世界');
            expect(f.requests).toHaveLength(1);
        } finally { f.controller.dispose(); }
    });
});
