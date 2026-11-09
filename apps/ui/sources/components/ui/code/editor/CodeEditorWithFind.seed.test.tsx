// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { CodeEditorFindHandle, TextEditorHandle } from './codeEditorTypes';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const { CodeEditorWithFind } = await import('./CodeEditorWithFind');
const { KeyboardShortcutProvider } =
  await import('@/keyboard/KeyboardShortcutProvider');
const { PluginSurfaceFocusEligibilityProvider } =
  await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
afterEach(standardCleanup);

/**
 * The engine is the boundary here (Monaco owns its native widget). It records the find requests it is
 * given, in order, the way Monaco's actions see them.
 */
function createNativeEngine() {
  const requests: Array<
    Readonly<{ kind: 'open' } | { kind: 'seed'; query: string; line?: number }>
  > = [];
  const find: CodeEditorFindHandle = {
    presentation: 'native',
    open: () => {
      requests.push({ kind: 'open' });
    },
    seed: (query, _options, target) => {
      requests.push({ kind: 'seed', query, line: target?.line });
    },
    set: () => {},
    step: () => {},
    close: () => {},
    getSnapshot: () => ({
      query: '',
      options: { matchCase: false, regex: false },
      status: { kind: 'idle' },
    }),
    subscribe: () => () => {},
    containsFocus: () => false,
    isOpen: () => false,
    isInputFocused: () => false,
  };
  const handle = {
    getValue: () => 'export const coast150 = "r352foldedquartz";',
    focus: () => {},
    find,
  } as unknown as TextEditorHandle;
  return { handle, requests };
}

describe('CodeEditorWithFind launch seed', () => {
  it('hands a seeded query to a ready native engine as its one find request, so the engine never seeds from the caret word', async () => {
    const engine = createNativeEngine();
    const consumed = vi.fn();
    const editorRef = { current: null as TextEditorHandle | null };
    function Editor() {
      return (
        <KeyboardShortcutProvider handlers={{}}>
          <PluginSurfaceFocusEligibilityProvider active>
            <CodeEditorWithFind
              editorRef={editorRef}
              filePath="coast.ts"
              resetKey="seed"
              value=""
              language="typescript"
              onChange={() => {}}
              onFindSeedConsumed={consumed}
              findSeed={{
                query: 'r352foldedquartz',
                options: { matchCase: false, regex: false },
                target: {
                  kind: 'file',
                  path: 'coast.ts',
                  anchor: { kind: 'fileLine', startLine: 150 },
                },
              }}
              renderEditor={(publish) => (
                <EngineMount publish={publish} handle={engine.handle} />
              )}
            />
          </PluginSurfaceFocusEligibilityProvider>
        </KeyboardShortcutProvider>
      );
    }
    await renderScreen(<Editor />);
    await act(async () => {});
    // An argument-less open would let Monaco seed its widget from the word at the caret ("export")
    // after the query arrives; the seed itself opens the widget.
    expect(engine.requests).toEqual([
      { kind: 'seed', query: 'r352foldedquartz', line: 150 },
    ]);
    expect(consumed).toHaveBeenCalledOnce();
  });
});

function EngineMount(
  props: Readonly<{
    publish: React.RefCallback<TextEditorHandle>;
    handle: TextEditorHandle;
  }>,
) {
  const { publish, handle } = props;
  React.useLayoutEffect(() => {
    publish(handle);
    return () => publish(null);
  }, [handle, publish]);
  return null;
}
