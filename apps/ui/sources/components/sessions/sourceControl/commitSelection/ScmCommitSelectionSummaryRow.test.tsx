import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstance, renderScreen } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

import { installSourceControlCommitSelectionCommonModuleMocks } from './sourceControlCommitSelectionTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

installSourceControlCommitSelectionCommonModuleMocks({
    reactNative: async () =>
        createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Platform: {
                OS: 'ios',
                select: (s: any) => s.ios ?? s.default,
            },
        }),
    text: async () =>
        createTextModuleMock({
            translate: (_k: string, vars?: any) =>
                vars?.count != null ? `selected:${vars.count}` : 'clear',
        }),
});

const selectionSummaryTheme = createThemeFixture();

describe('ScmCommitSelectionSummaryRow', () => {
  it('renders and calls onClear', async () => {
    const { ScmCommitSelectionSummaryRow } = await import('./ScmCommitSelectionSummaryRow');
    const onClear = vi.fn();

    const screen = await renderScreen(
      <ScmCommitSelectionSummaryRow theme={selectionSummaryTheme} count={3} onClear={onClear} density="compact" />,
    );
    pressTestInstance(screen.findByProps({ accessibilityRole: 'button' }), 'files.clearSelection');

    expect(onClear).toHaveBeenCalled();
  });
});
