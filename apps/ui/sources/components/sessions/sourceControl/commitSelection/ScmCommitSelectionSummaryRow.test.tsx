import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstance, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Pressable: 'Pressable',
                    Platform: {
                        OS: 'ios',
                        select: (s: any) => s.ios ?? s.default,
                    },
                }
    );
});

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (_k: string, vars?: any) => (vars?.count != null ? `selected:${vars.count}` : 'clear'),
    });
});

describe('ScmCommitSelectionSummaryRow', () => {
  it('renders and calls onClear', async () => {
    const { ScmCommitSelectionSummaryRow } = await import('./ScmCommitSelectionSummaryRow');
    const onClear = vi.fn();

    const theme = {
      colors: {
        divider: '#ddd',
        surface: '#fff',
        surfaceHigh: '#f5f5f5',
        input: { background: '#f5f5f5' },
        textSecondary: '#666',
        textLink: '#00f',
      },
    };

    const screen = await renderScreen(
      <ScmCommitSelectionSummaryRow theme={theme} count={3} onClear={onClear} density="compact" />,
    );
    pressTestInstance(screen.findByType('Pressable' as any), 'files.clearSelection');

    expect(onClear).toHaveBeenCalled();
  });
});
