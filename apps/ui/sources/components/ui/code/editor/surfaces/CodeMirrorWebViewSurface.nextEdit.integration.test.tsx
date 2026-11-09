// @vitest-environment jsdom
import React from 'react';
import { act } from 'react-test-renderer';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as commands from '@codemirror/commands';
import * as language from '@codemirror/language';
import * as autocomplete from '@codemirror/autocomplete';
import * as search from '@codemirror/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesEditorAiSuggestionsV1Schema } from '@happier-dev/protocol/account/settings/accountSettings';
import type {
  LanguageIntelligenceQueryInput,
  LanguageIntelligenceQueryResult,
} from '@happier-dev/protocol/machines/languageIntelligence';
import { decodeNextEditRewriteWindow } from '@happier-dev/protocol/machines/languageIntelligence';
import { renderScreen } from '@/dev/testkit';
import { createCodeIntelligenceController } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import { bindCodeIntelligenceEditor } from '@/sync/domains/workspaces/languageIntelligence/bindCodeIntelligenceEditor';
import { createCodeMirrorDecorations } from '../bridge/codeMirrorDecorations';
import { createCodeMirrorInlineSuggestions } from '../bridge/codeMirrorInlineSuggestions';
import { createEditorDocumentHistory } from '../editorDocumentHistory';
import type { CodeEditorHandle } from '../codeEditorTypes';
import type { CodeInlineSuggestionUsage } from '@/sync/domains/workspaces/languageIntelligence/codeInlineSuggestions';

const boundary = vi.hoisted(() => ({
  holdHost: false,
  hostQueue: [] as string[],
  fromWebView: [] as string[],
  props: null as null | {
    source: { html: string };
    onMessage: (event: { nativeEvent: { data: string } }) => void;
  },
}));
vi.mock('../bridge/codemirrorWebViewBundle.generated', () => ({
  CODEMIRROR_WEBVIEW_BUNDLE_JS: '/* installed engine modules */',
}));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      OS: 'ios',
      select: (options: Record<string, unknown>) =>
        options.ios ?? options.default,
    },
    PixelRatio: { getFontScale: () => 1 },
  });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
// The native WebView is the OS boundary. Both sides of its actual bridge and the installed editor remain real.
vi.mock('react-native-webview', () => ({
  WebView: React.forwardRef(
    (props: NonNullable<typeof boundary.props>, ref) => {
      boundary.props = props;
      React.useImperativeHandle(ref, () => ({
        postMessage: (data: string) => {
          if (boundary.holdHost) boundary.hostQueue.push(data);
          else window.dispatchEvent(new MessageEvent('message', { data }));
        },
      }));
      return React.createElement('WebView');
    },
  ),
}));

import { CodeMirrorWebViewSurface } from './CodeMirrorWebViewSurface.native';

// Short enough that jsdom's unmeasured viewport draws every line; the distant journey is the Monaco and live case.
const SOURCE = `function old() {}\n${'// unchanged 🦊\n'.repeat(4)}old();\n`;

describe('native next-edit marker, preview and apply over the real bridge', () => {
  let editor: view.EditorView | null = null;
  let cleanupListeners = () => {};
  let restoreGeometry = () => {};
  beforeEach(() => {
    boundary.holdHost = false;
    boundary.hostQueue = [];
    boundary.fromWebView = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    document.body.innerHTML = '<div id="root"></div>';
    vi.stubGlobal('__CM6__', {
      ...state,
      ...view,
      ...commands,
      ...language,
      ...autocomplete,
      ...search,
      createCodeMirrorDecorations,
      createCodeMirrorInlineSuggestions,
    });
    const geometryDescriptors = ['getClientRects', 'getBoundingClientRect'].map(
      (name) =>
        [name, Object.getOwnPropertyDescriptor(Range.prototype, name)] as const,
    );
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    restoreGeometry = () => {
      for (const [name, descriptor] of geometryDescriptors) {
        if (descriptor)
          Object.defineProperty(Range.prototype, name, descriptor);
        else Reflect.deleteProperty(Range.prototype, name);
      }
    };
    Object.defineProperty(window, 'ReactNativeWebView', {
      configurable: true,
      value: {
        postMessage: (data: string) => {
          boundary.fromWebView.push(data);
          boundary.props!.onMessage({ nativeEvent: { data } });
        },
      },
    });
  });
  afterEach(() => {
    editor?.destroy();
    editor = null;
    cleanupListeners();
    restoreGeometry();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'ReactNativeWebView');
    boundary.props = null;
  });

  async function mount(
    patch: Partial<
      ReturnType<typeof FilesEditorAiSuggestionsV1Schema.parse>
    > = {},
    source = SOURCE,
  ) {
    const history = createEditorDocumentHistory();
    let text = source;
    const ref = React.createRef<CodeEditorHandle>();
    const surface = (resetKey = 'next-edit') => (
      <CodeMirrorWebViewSurface
        ref={ref}
        resetKey={resetKey}
        value={text}
        language="typescript"
        history={history}
        onChange={(next, change) => {
          if (!change?.history) history.record(text, next);
          text = next;
        }}
      />
    );
    const screen = await renderScreen(surface());
    const script = boundary.props!.source.html.match(
      /<script type="module">([\s\S]*?)<\/script>/,
    )?.[1];
    if (!script) throw new Error('WebView source missing');
    const documentListeners = vi.spyOn(document, 'addEventListener');
    const windowListeners = vi.spyOn(window, 'addEventListener');
    cleanupListeners = () => {
      for (const [type, listener] of documentListeners.mock.calls)
        if (type === 'message') document.removeEventListener(type, listener);
      for (const [type, listener] of windowListeners.mock.calls)
        if (type === 'message') window.removeEventListener(type, listener);
    };
    await act(async () => {
      new Function(script)();
    });
    const element = document.querySelector<HTMLElement>('.cm-editor');
    editor = element ? view.EditorView.findFromDOM(element) : null;
    if (!editor) throw new Error('Installed editor missing');
    const engine = editor;
    const settings = FilesEditorAiSuggestionsV1Schema.parse({
      enabled: true,
      nextEditEnabled: true,
      mode: 'onRequest',
      connectionId: 'source',
      modelId: 'edit-model',
      ...patch,
    });
    const requests: {
      input: LanguageIntelligenceQueryInput;
      signal: AbortSignal;
      resolve(value: LanguageIntelligenceQueryResult): void;
    }[] = [];
    const usage: CodeInlineSuggestionUsage[] = [];
    const model = {
      id: 'edit-model',
      name: 'Edit model',
      contextWindowTokens: 32768,
      nextEdit: {
        operationId: 'edit',
        tokenAccounting: 'utf8-bytes' as const,
        outputTokens: 4096,
        promptOverheadTokens: 32,
      },
    };
    const controller = createCodeIntelligenceController({
      scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' },
      path: 'src/a.ts',
      languageId: 'typescript',
      accountLifetime: {
        scope: { serverId: 'home', accountId: 'account' },
        isCurrent: () => true,
        onRetire: () => ({ dispose() {} }),
      },
      getText: () => ref.current!.getValue(),
      query: async () => ({
        status: 'unavailable',
        reason: 'no_capable_server',
      }),
      openLocation() {},
      // The Machine query is the scripted boundary.
      inlineSuggestions: {
        getSettings: () => settings,
        getModel: () => model,
        query: (input, signal) =>
          new Promise((resolve) => requests.push({ input, signal, resolve })),
        onUsage: event => usage.push(event),
      },
    });
    let unbind = () => {};
    await act(async () => {
      unbind = bindCodeIntelligenceEditor(controller, ref.current!, {
        path: 'src/a.ts',
        inlayHints: 'off',
        semanticHighlighting: false,
      });
    });
    const key = async (name: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      await act(async () => {
        engine.contentDOM.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    const all = (selector: string) =>
      [...engine.dom.querySelectorAll(selector)].map(
        (node) => node.textContent,
      );
    return {
      engine,
      ref,
      controller,
      requests,
      usage,
      resetSurface: () => screen.update(surface('next-document')),
      key,
      all,
      text: () => ref.current!.getValue(),
      async deliverHost() {
        const messages = boundary.hostQueue.splice(0);
        boundary.holdHost = false;
        await act(async () => {
          for (const data of messages) window.dispatchEvent(new MessageEvent('message', { data }));
        });
      },
      async openList() {
        await act(async () => {
          engine.dispatch({ effects: state.StateEffect.appendConfig.of(autocomplete.autocompletion({
            override: [context => ({ from: context.pos, options: [{ label: 'anotherName' }] })],
          })) });
          autocomplete.startCompletion(engine);
          await vi.runAllTimersAsync();
        });
        expect(autocomplete.completionStatus(engine.state)).not.toBeNull();
      },
      async renameAndPredict() {
        await act(async () => {
          engine.dispatch({
            changes: { from: 9, to: 12, insert: 'renamed' },
            selection: { anchor: 16 },
          });
        });
        await act(async () => {
          controller.nextEditSuggestions.trigger();
          await vi.runAllTimersAsync();
        });
      },
      async answer(index = 0) {
        await act(async () => {
          requests[index]!.resolve({
            status: 'ok',
            kind: 'ai.nextEdit',
            version: requests[index]!.input.version!,
            edits: [
              {
                path: 'src/a.ts',
                range: {
                  start: { line: 5, character: 0 },
                  end: { line: 5, character: 3 },
                },
                oldText: 'old',
                newText: 'renamed',
              },
            ],
          });
          await vi.runAllTimersAsync();
        });
      },
      async dispose() {
        unbind();
        controller.dispose();
        await screen.unmount();
      },
    };
  }

  it('renders every minimal decoded range and applies all three as one undo transaction over the bridge', async () => {
    const f = await mount({}, SOURCE + 'old();\nold();\n');
    try {
      await f.renameAndPredict();
      const request = f.requests[0].input;
      const before = f.text(), rewritten = before.replaceAll('old();', 'renamed();');
      const edits = decodeNextEditRewriteWindow('src/a.ts', request.nextEdit!, request.version!, rewritten, true)!;
      expect(edits).toHaveLength(3);
      await act(async () => {
        f.requests[0].resolve({ status: 'ok', kind: 'ai.nextEdit', version: request.version!, edits: [...edits] });
        await vi.runAllTimersAsync();
      });
      expect(await f.key('Tab')).toBe(true);
      expect(f.all('.happier-next-edit-removed')).toEqual(['ol', 'ol', 'ol']);
      expect(f.all('.happier-next-edit-added')).toEqual(['rename', 'rename', 'rename']);
      expect(f.text()).toBe(before);
      boundary.holdHost = true;
      expect(await f.key('Tab')).toBe(true);
      expect(f.text()).toBe(before);
      expect(f.usage.filter(event => event.kind === 'acceptedFull')).toHaveLength(0);
      await f.deliverHost();
      expect(f.text()).toBe(rewritten);
      expect(f.usage.filter(event => event.kind === 'acceptedFull')).toHaveLength(1);
      await act(async () => { f.ref.current!.runCommand('undo'); });
      expect(f.text()).toBe(before);
      expect(f.text().startsWith('function renamed()')).toBe(true);
    } finally { await f.dispose(); }
  });

  it('marks the predicted place, previews on the first Tab and applies once as one undo step on the second', async () => {
    const f = await mount();
    try {
      await f.renameAndPredict();
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.input.kind).toBe('ai.nextEdit');
      await f.answer();
      expect(f.controller.nextEditSuggestions.getSnapshot().status).toBe('ready');
      expect(f.all('.happier-next-edit-target')).toEqual(['old']);
      expect(f.all('.happier-next-edit-key')).toEqual(['Tab']);
      expect(f.all('.happier-next-edit-hint')[0]).toContain('6');

      expect(await f.key('Tab')).toBe(true);
      expect(f.controller.nextEditSuggestions.getSnapshot().status).toBe(
        'preview',
      );
      expect(
        f.engine.state.doc.lineAt(f.engine.state.selection.main.head).number,
      ).toBe(6);
      expect(f.all('.happier-next-edit-removed')).toEqual(['old']);
      expect(f.all('.happier-next-edit-added')).toEqual(['renamed']);
      expect(f.text()).toContain('\nold();');

      boundary.holdHost = true;
      expect(await f.key('Tab')).toBe(true);
      expect(f.text().endsWith('\nold();\n')).toBe(true);
      await f.deliverHost();
      expect(f.text().endsWith('\nrenamed();\n')).toBe(true);
      expect(f.text().startsWith('function renamed()')).toBe(true);
      expect(
        f.all(
          '.happier-next-edit-removed, .happier-next-edit-added, .happier-next-edit-hint',
        ),
      ).toEqual([]);

      await act(async () => {
        f.ref.current!.runCommand('undo');
      });
      expect(f.text().endsWith('\nold();\n')).toBe(true);
      expect(f.text().startsWith('function renamed()')).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it('counts acceptance only after the real transaction result, once, and retains only successful text', async () => {
    const f = await mount();
    try {
      await f.renameAndPredict();
      await f.answer();
      expect(await f.key('Tab')).toBe(true);
      boundary.holdHost = true;
      expect(await f.key('Tab')).toBe(true);
      expect(f.usage.filter(event => event.kind === 'acceptedFull')).toHaveLength(0);
      expect(f.text().endsWith('\nold();\n')).toBe(true);
      await f.deliverHost();
      expect(f.text().endsWith('\nrenamed();\n')).toBe(true);
      expect(f.usage.filter(event => event.kind === 'acceptedFull')).toHaveLength(1);
      const result = boundary.fromWebView.find(data => JSON.parse(data).type === 'nextEdit.applied');
      expect(result).toBeDefined();
      await act(async () => { boundary.props!.onMessage({ nativeEvent: { data: result! } }); });
      expect(f.usage.filter(event => event.kind === 'acceptedFull')).toHaveLength(1);
      await act(async () => { f.engine.dispatch({ changes: { from: f.engine.state.doc.length, insert: '// later\n' } }); });
      expect(f.usage.filter(event => event.kind === 'kept')).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it.each(['reset', 'unmount'] as const)('does not accept a late result after native surface %s', async lifecycle => {
    const f = await mount();
    let disposed = false;
    try {
      await f.renameAndPredict();
      await f.answer();
      expect(await f.key('Tab')).toBe(true);
      boundary.holdHost = true;
      expect(await f.key('Tab')).toBe(true);
      const message = boundary.hostQueue.map(data => JSON.parse(data) as { type: string; payload: { requestId: string } })
        .find(message => message.type === 'nextEdit.apply');
      expect(message).toBeDefined();
      const onMessage = boundary.props!.onMessage;
      if (lifecycle === 'reset') await f.resetSurface();
      else { await f.dispose(); disposed = true; }
      await act(async () => {
        onMessage({ nativeEvent: { data: JSON.stringify({ v: 1, type: 'nextEdit.applied', payload: { requestId: message!.payload.requestId, applied: true } }) } });
      });
      expect(f.usage.filter(event => event.kind === 'acceptedFull')).toHaveLength(0);
    } finally { if (!disposed) await f.dispose(); }
  });

  it.each(['caret', 'selection', 'selection then return', 'composition', 'list'] as const)(
    'refuses a delayed apply after %s changes at the native engine', async change => {
      const f = await mount();
      try {
        await f.renameAndPredict();
        await f.answer();
        expect(await f.key('Tab')).toBe(true);
        const before = f.text();
        const landing = f.engine.state.selection.main.head;
        boundary.holdHost = true;
        expect(await f.key('Tab')).toBe(true);
        await act(async () => {
          if (change === 'caret') f.engine.dispatch({ selection: { anchor: landing + 1 } });
          if (change === 'selection' || change === 'selection then return') {
            f.engine.dispatch({ selection: { anchor: landing, head: landing + 2 } });
            if (change === 'selection then return') f.engine.dispatch({ selection: { anchor: landing } });
          }
          if (change === 'composition') f.engine.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        });
        if (change === 'list') await f.openList();
        await f.deliverHost();
        expect(f.engine.state.doc.toString()).toBe(before);
        expect(f.text()).toBe(before);
        expect(f.usage.filter(event => event.kind === 'acceptedFull')).toHaveLength(0);
        await act(async () => {
          f.engine.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
          autocomplete.closeCompletion(f.engine);
          f.engine.dispatch({ changes: { from: f.engine.state.doc.length, insert: '// later\n' } });
        });
        expect(f.usage.filter(event => event.kind === 'kept')).toHaveLength(0);
      } finally { await f.dispose(); }
    },
  );

  it('routes pending Escape to cancellation and suppresses the late model answer', async () => {
    const f = await mount();
    try {
      await f.renameAndPredict();
      expect(f.controller.nextEditSuggestions.getSnapshot().status).toBe('requesting');
      expect(await f.key('Escape', { isComposing: true })).toBe(false);
      expect(await f.key('Escape', { shiftKey: true })).toBe(false);
      expect(f.requests[0]!.signal.aborted).toBe(false);
      expect(await f.key('Escape')).toBe(true);
      expect(f.requests[0]!.signal.aborted).toBe(true);
      await f.answer();
      expect(f.controller.nextEditSuggestions.getSnapshot().suggestion).toBeNull();
      expect(f.all('.happier-next-edit-target, .happier-next-edit-added')).toEqual([]);
      expect(f.text().endsWith('\nold();\n')).toBe(true);
    } finally { await f.dispose(); }
  });

  it.each(['pending', 'preview'] as const)('leaves Escape with the real LSP list from %s', async phase => {
    const f = await mount();
    try {
      await f.renameAndPredict();
      if (phase === 'preview') { await f.answer(); expect(await f.key('Tab')).toBe(true); }
      await f.openList();
      boundary.fromWebView = [];
      await f.key('Escape');
      expect(autocomplete.completionStatus(f.engine.state)).toBeNull();
      expect(boundary.fromWebView.some(data => JSON.parse(data).type === 'nextEdit.key')).toBe(false);
      if (phase === 'pending') {
        await f.answer();
        expect(f.controller.nextEditSuggestions.getSnapshot().suggestion).toBeNull();
      }
    } finally { await f.dispose(); }
  });

  it('dismisses on Escape and never draws a candidate made stale by a later edit', async () => {
    const f = await mount();
    try {
      await f.renameAndPredict();
      await f.answer();
      expect(await f.key('Tab')).toBe(true);
      expect(await f.key('Escape')).toBe(true);
      expect(
        f.controller.nextEditSuggestions.getSnapshot().suggestion,
      ).toBeNull();
      expect(
        f.all('.happier-next-edit-target, .happier-next-edit-hint'),
      ).toEqual([]);

      await act(async () => {
        f.controller.nextEditSuggestions.trigger();
        await vi.runAllTimersAsync();
      });
      expect(f.requests).toHaveLength(2);
      await act(async () => {
        f.engine.dispatch({
          changes: { from: 16, insert: 'X' },
          selection: { anchor: 17 },
        });
      });
      await f.answer(1);
      expect(
        f.controller.nextEditSuggestions.getSnapshot().suggestion,
      ).toBeNull();
      expect(
        f.all('.happier-next-edit-target, .happier-next-edit-hint'),
      ).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it('draws nothing while the preference is off', async () => {
    const f = await mount({ nextEditEnabled: false });
    try {
      await f.renameAndPredict();
      expect(f.requests).toHaveLength(0);
      expect(
        f.all('.happier-next-edit-target, .happier-next-edit-hint'),
      ).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
});
