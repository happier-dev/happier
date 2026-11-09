/** @vitest-environment jsdom */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { KeyboardShortcutLabelsContext } from '@/keyboard/shortcutLabels';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { RepositoryTreeToolbar } = await import('./RepositoryTreeToolbar');

/** The browser's media query answer for the primary pointer (a boundary the hint reads). */
function stubPointer(fine: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: fine && query === '(pointer: fine)' }));
  window.matchMedia = globalThis.matchMedia as typeof window.matchMedia;
}

function renderToolbar(shortcuts: Record<string, string>) {
  return renderScreen(
    <KeyboardShortcutLabelsContext.Provider value={shortcuts}>
      <RepositoryTreeToolbar
        testIDPrefix="repository-tree"
        searchValue=""
        onSearchValueChange={() => {}}
        changedOnly={false}
        changedCount={3}
        onChangedOnlyChange={() => {}}
        onQuickOpen={() => {}}
        detailsMode={false}
        onDetailsModeChange={() => {}}
        onCollapseAll={null}
        onRefresh={() => {}}
        refreshing={false}
      />
    </KeyboardShortcutLabelsContext.Provider>,
  );
}

describe('RepositoryTreeToolbar quick open', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('offers the ⌘P control only while its keycaps are drawn: a finger has no key, so no invisible control sits over the field and the segment', async () => {
    stubPointer(false);
    const touch = await renderToolbar({ 'search.files': 'Cmd+P' });
    expect(touch.findByTestId('repository-tree-quick-open')).toBeNull();
    await touch.unmount?.();

    stubPointer(true);
    const keyboard = await renderToolbar({ 'search.files': 'Cmd+P' });
    expect(keyboard.findByTestId('repository-tree-quick-open')).not.toBeNull();
    await keyboard.unmount?.();

    // No key bound to the command: nothing is drawn, so nothing is pressable.
    const unbound = await renderToolbar({});
    expect(unbound.findByTestId('repository-tree-quick-open')).toBeNull();
  });
});
