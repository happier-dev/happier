// @vitest-environment jsdom
import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as commands from '@codemirror/commands';
import * as language from '@codemirror/language';
import * as autocomplete from '@codemirror/autocomplete';
import * as search from '@codemirror/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createCodeMirrorDecorations } from '../bridge/codeMirrorDecorations';
import { createCodeMirrorInlineSuggestions } from '../bridge/codeMirrorInlineSuggestions';
import { createCodeMirrorLanguageIntelligence } from '../bridge/codeMirrorLanguageIntelligence';
import { CodeEditorAccessoryBar } from '../chrome/CodeEditorAccessoryBar';
import type {
  CodeEditorHandle,
  CodeEditorLanguageIntelligence,
} from '../codeEditorTypes';

const boundary = vi.hoisted(() => ({
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
        postMessage: (data: string) =>
          window.dispatchEvent(new MessageEvent('message', { data })),
      }));
      return React.createElement('WebView');
    },
  ),
}));

import { CodeMirrorWebViewSurface } from './CodeMirrorWebViewSurface.native';

const SIGNATURE = {
  signatures: [
    {
      label: 'greet(name: string, times: number): void',
      parameters: [{ label: 'name: string' }, { label: 'times: number' }],
    },
  ],
  activeSignature: 0,
  activeParameter: 1,
};

function textOf(node: ReactTestInstance | null): string {
  if (!node) return '';
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

describe('native language-intelligence chrome over the real bridge', () => {
  let editor: view.EditorView | null = null;
  let cleanupListeners = () => {};
  let restoreGeometry = () => {};
  beforeEach(() => {
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
      createCodeMirrorLanguageIntelligence,
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
        postMessage: (data: string) =>
          boundary.props!.onMessage({ nativeEvent: { data } }),
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

  it('shows the active parameter above the key row, retires it on Escape, and drives Suggest, Expand and Shrink through the handle', async () => {
    const ref = React.createRef<CodeEditorHandle>();
    const request = vi.fn<CodeEditorLanguageIntelligence['request']>(
      async (kind) => {
        if (kind === 'signatureHelp')
          return { status: 'ok', kind, help: SIGNATURE } as never;
        if (kind === 'selectionRange')
          return {
            status: 'ok',
            kind,
            ranges: [
              {
                serverId: 's',
                ranges: [
                  {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 11 },
                  },
                  {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 15 },
                  },
                ],
              },
            ],
          } as never;
        return { status: 'loading' } as never;
      },
    );
    const snapshot = {
      mode: 'server',
      status: 'ready',
      kind: null,
      selection: null,
      querySelection: null,
      result: null,
      capabilities: {
        hover: false,
        definition: false,
        references: false,
        documentSymbol: false,
        diagnostics: 'none',
        acceptsExternalChanges: false,
        completion: true,
        signatureHelp: true,
        selectionRange: true,
        signatureTriggerCharacters: ['('],
        signatureRetriggerCharacters: [','],
      },
    } as const;
    const port: CodeEditorLanguageIntelligence = {
      path: 'a.ts',
      inlayHints: 'off',
      semanticHighlighting: false,
      request,
      getSnapshot: () => snapshot as never,
      subscribe: () => () => undefined,
    };
    const save = {
      visible: true,
      enabled: false,
      tone: 'default' as const,
      onPress() {},
    };
    const screen = await renderScreen(
      <CodeMirrorWebViewSurface
        ref={ref}
        resetKey="signature"
        value={'greet("ada", 2)'}
        language="typescript"
        onChange={vi.fn()}
      />,
    );
    try {
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
      await act(async () => {
        ref.current!.setLanguageIntelligence!(port);
      });
      await screen.update(
        <>
          <CodeMirrorWebViewSurface
            ref={ref}
            resetKey="signature"
            value={'greet("ada", 2)'}
            language="typescript"
            onChange={vi.fn()}
          />
          <CodeEditorAccessoryBar
            editor={ref.current}
            save={save}
            languageIntelligence={{
              getSnapshot: port.getSnapshot,
              subscribe: port.subscribe,
            }}
          />
        </>,
      );
      expect(screen.findHostByTestId('code-editor-accessory-signature')).toBeNull();

      // Parameter help arrives over the real bridge from the engine's own request.
      await act(async () => {
        engine.dispatch({ selection: { anchor: 13 } });
        ref.current!.runCommand('signatureHelp');
      });
      await vi.waitFor(() =>
        expect(
          screen.findHostByTestId('code-editor-accessory-signature'),
        ).not.toBeNull(),
      );
      expect(
        textOf(screen.findHostByTestId('code-editor-accessory-signature')),
      ).toBe('greet(…, times: number): void');
      expect(
        textOf(screen.findHostByTestId('code-editor-accessory-signature-active')),
      ).toBe('times: number');

      // Escape retires the help, exactly as the engine's dismissal publishes it over the bridge.
      await act(async () => {
        view.runScopeHandlers(engine, new KeyboardEvent('keydown', { key: 'Escape' }), 'editor');
      });
      await vi.waitFor(() =>
        expect(
          screen.findHostByTestId('code-editor-accessory-signature'),
        ).toBeNull(),
      );

      // Suggest asks the server for completion through the engine.
      await act(async () => {
        screen.findByTestId('code-editor-accessory-suggest')!.props.onPress();
      });
      await vi.waitFor(() =>
        expect(request.mock.calls.map(([kind]) => kind)).toContain(
          'completion',
        ),
      );

      // Expand widens the selection through selectionRange; Shrink steps back.
      await act(async () => {
        engine.dispatch({ selection: { anchor: 8 } });
      });
      await act(async () => {
        screen
          .findByTestId('code-editor-accessory-expand-selection')!
          .props.onPress();
      });
      await vi.waitFor(() =>
        expect(engine.state.selection.main.empty).toBe(false),
      );
      const widened = engine.state.selection.main;
      expect(widened.to - widened.from).toBe(5);
      await act(async () => {
        screen
          .findByTestId('code-editor-accessory-shrink-selection')!
          .props.onPress();
      });
      await vi.waitFor(() =>
        expect(engine.state.selection.main.empty).toBe(true),
      );
    } finally {
      await screen.unmount();
    }
  });

  it('offers no language keys until the server can answer them', async () => {
    const handle = {
      getValue: () => '',
      flushPendingChange: async () => {},
      runCommand() {},
    };
    const empty = {
      hover: false,
      definition: false,
      references: false,
      documentSymbol: false,
      diagnostics: 'none',
      acceptsExternalChanges: false,
    } as const;
    const screen = await renderScreen(
      <CodeEditorAccessoryBar
        editor={handle}
        save={{ visible: false, enabled: false, tone: 'default', onPress() {} }}
        languageIntelligence={{
          getSnapshot: () => ({ capabilities: empty }) as never,
          subscribe: () => () => undefined,
        }}
      />,
    );
    try {
      for (const id of ['suggest', 'expand-selection', 'shrink-selection'])
        expect(screen.findByTestId(`code-editor-accessory-${id}`)).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
