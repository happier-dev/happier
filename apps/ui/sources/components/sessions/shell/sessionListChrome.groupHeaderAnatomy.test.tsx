import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionShellCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
  },
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
  },
  storage: async (importOriginal) => importOriginal(),
});

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { CollapsibleSectionHeader } = await import('./sessionListChrome');
const { CollectionListGroupLabel } =
  await import('@/components/ui/lists/collection/CollectionList');

describe('session list group header anatomy (owner 2026-11-11, OWNER-1334-ROWS 06)', () => {
  // Needs you, Working and Pinned read as titles like Scheduled and Drafts: title on the content edge, then
  // its count and chevron. The header takes no kind, so no group can lead with a glyph of its own.
  it('draws every folding group as title, count and chevron with no leading glyph', async () => {
    const screen = await renderScreen(
      <CollapsibleSectionHeader
        title="Needs you"
        collapsed={false}
        onPress={vi.fn()}
        onOpen={vi.fn()}
        count={7}
      />,
    );
    const label = screen.root.findAllByType(CollectionListGroupLabel)[0]!;
    expect(label.props.title).toBe('Needs you');
    expect(label.props.count).toBe(7);
    expect(label.props.disclosure).toBeTruthy();
    expect(label.props.mark).toBeUndefined();
    await screen.unmount();
  });
});
