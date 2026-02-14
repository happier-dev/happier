import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clipboardMocks = vi.hoisted(() => ({
  setStringAsync: vi.fn(async () => {}),
}));
vi.mock('expo-clipboard', () => clipboardMocks);

vi.mock('@/modal', () => ({
  Modal: {
    alert: vi.fn(),
  },
}));

vi.mock('react-native-webview', () => ({
  WebView: () => null,
}));

describe('MermaidRenderer', () => {
  it('copies raw Mermaid source to clipboard', async () => {
    const { MermaidRenderer } = await import('./MermaidRenderer');

    let tree: ReturnType<typeof renderer.create> | undefined;
    try {
      await act(async () => {
        tree = renderer.create(<MermaidRenderer content={'graph TD\\nA-->B'} />);
      });

      const copyButtons =
        tree?.root.findAll((n) => n.props?.testID === 'mermaid-copy-button') ?? [];
      expect(copyButtons).toHaveLength(1);
      expect(typeof copyButtons[0]!.props?.onPress).toBe('function');

      clipboardMocks.setStringAsync.mockClear();
      await act(async () => {
        await copyButtons[0]!.props.onPress();
      });

      expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith('graph TD\\nA-->B');
    } finally {
      act(() => {
        tree?.unmount();
      });
    }
  });
});
