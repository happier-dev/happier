import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierUiPlatformProvider } from '../../environment/context.js';
import type { PluginUiPlatform } from '@happier-dev/plugin-sdk/ui';
import { HappierPressable } from './Pressable.js';

/**
 * A touch target is the hit area, never the drawn control (DESIGN.md → Accessibility). React Native
 * Web ignores `hitSlop`, so on the web the hit area is a real invisible frame; the pressable's own box
 * keeps the size its caller drew.
 */
function mountIn(platform: PluginUiPlatform, children: ReactNode) {
  return mountThroughReactNativeWeb(
    <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>{children}</HappierUiPlatformProvider>,
  );
}

function emulatePrimaryPointer(pointer: 'coarse' | 'fine') {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: pointer === 'coarse'
      ? query === '(pointer: coarse)' || query === '(hover: none)'
      : query === '(pointer: fine)' || query === '(hover: hover)',
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function px(value: string): number {
  return Number.parseFloat(value);
}

function hitFrame(control: HTMLElement) {
  const frame = control.querySelector<HTMLElement>(':scope > [data-happier-hit-area="true"]');
  if (frame === null) return null;
  const style = getComputedStyle(frame);
  return { top: -px(style.top), bottom: -px(style.bottom), left: -px(style.left), right: -px(style.right), position: style.position };
}

const drawn = { width: 24, height: 24, borderRadius: 12 };

/** How far the frame reaches past the control's OUTER box: its offset from the padding edge, less the border. */
function reachPastOuterBox(control: HTMLElement) {
  const frame = hitFrame(control)!;
  const style = getComputedStyle(control);
  return {
    top: frame.top - px(style.borderTopWidth),
    bottom: frame.bottom - px(style.borderBottomWidth),
    left: frame.left - px(style.borderLeftWidth),
    right: frame.right - px(style.borderRightWidth),
  };
}

describe('shared pressable hit area', () => {
  for (const [platform, target] of [['ios', 44], ['android', 48]] as const) {
    it(`keeps the drawn ${platform} box and reaches ${target} with an invisible frame`, () => {
      const mount = mountIn(platform, <HappierPressable testID="dot" accessibilityLabel="Dot" onPress={() => {}} style={drawn} />);
      try {
        const control = mount.container.querySelector<HTMLElement>('[data-testid="dot"]')!;
        const style = getComputedStyle(control);
        expect(px(style.width)).toBe(24);
        expect(px(style.height)).toBe(24);
        expect(style.minHeight === '' || px(style.minHeight) <= 24).toBe(true);
        const deficit = (target - 24) / 2;
        expect(hitFrame(control)).toEqual({ top: deficit, bottom: deficit, left: deficit, right: deficit, position: 'absolute' });
      } finally {
        mount.unmount();
      }
    });
  }

  it('gives a finger in a phone browser the 44 px hit area', () => {
    emulatePrimaryPointer('coarse');
    const mount = mountIn('web', <HappierPressable testID="dot" accessibilityLabel="Dot" onPress={() => {}} style={drawn} />);
    try {
      const control = mount.container.querySelector<HTMLElement>('[data-testid="dot"]')!;
      expect(px(getComputedStyle(control).height)).toBe(24);
      expect(hitFrame(control)).toMatchObject({ top: 10, bottom: 10, left: 10, right: 10 });
    } finally {
      mount.unmount();
    }
  });

  it('leaves a precise pointer exactly as drawn', () => {
    emulatePrimaryPointer('fine');
    const mount = mountIn('desktop', <HappierPressable testID="dot" accessibilityLabel="Dot" onPress={() => {}} style={drawn} />);
    try {
      const control = mount.container.querySelector<HTMLElement>('[data-testid="dot"]')!;
      expect(px(getComputedStyle(control).height)).toBe(24);
      expect(hitFrame(control)).toBeNull();
    } finally {
      mount.unmount();
    }
  });

  it('splits the gap between adjacent small controls so their hit areas never overlap', () => {
    const gap = 6;
    const mount = mountIn('ios', (
      <>
        <HappierPressable testID="first" accessibilityLabel="First" onPress={() => {}} style={drawn} hitReach={{ right: gap / 2 }} />
        <HappierPressable testID="second" accessibilityLabel="Second" onPress={() => {}} style={drawn} hitReach={{ left: gap / 2 }} />
      </>
    ));
    try {
      const first = hitFrame(mount.container.querySelector<HTMLElement>('[data-testid="first"]')!)!;
      const second = hitFrame(mount.container.querySelector<HTMLElement>('[data-testid="second"]')!)!;
      expect(first.right + second.left).toBeLessThanOrEqual(gap);
      // Away from the neighbour, each still reaches the full 44 pt.
      expect(first.left).toBe(10);
      expect(second.right).toBe(10);
      expect(first.top).toBe(10);
    } finally {
      mount.unmount();
    }
  });

  describe('a bordered control', () => {
    it('reaches the target measured from its drawn outer box, not its padding box', () => {
      emulatePrimaryPointer('coarse');
      const mount = mountIn('web', (
        <HappierPressable testID="action" accessibilityLabel="Save" onPress={() => {}} style={{ width: 176, height: 32, borderWidth: 1 }} />
      ));
      try {
        const control = mount.container.querySelector<HTMLElement>('[data-testid="action"]')!;
        // 176x32 drawn: 6 px above and below reaches 44 high, the width already exceeds the target.
        expect(reachPastOuterBox(control)).toEqual({ top: 6, bottom: 6, left: 0, right: 0 });
        expect(32 + reachPastOuterBox(control).top + reachPastOuterBox(control).bottom).toBe(44);
      } finally {
        mount.unmount();
      }
    });

    it('accounts for each side border on its own, with the per-side width winning over borderWidth', () => {
      const mount = mountIn('android', (
        <HappierPressable
          testID="dot"
          accessibilityLabel="Dot"
          onPress={() => {}}
          style={[{ width: 24, height: 24, borderWidth: 1 }, { borderLeftWidth: 3, borderBottomWidth: 0 }]}
        />
      ));
      try {
        const control = mount.container.querySelector<HTMLElement>('[data-testid="dot"]')!;
        expect(reachPastOuterBox(control)).toEqual({ top: 12, bottom: 12, left: 12, right: 12 });
        const frame = hitFrame(control)!;
        expect({ top: frame.top, bottom: frame.bottom, left: frame.left, right: frame.right }).toEqual({ top: 13, bottom: 12, left: 15, right: 13 });
      } finally {
        mount.unmount();
      }
    });

    it('still caps the reach at hitReach from the outer box', () => {
      const mount = mountIn('ios', (
        <HappierPressable testID="dot" accessibilityLabel="Dot" onPress={() => {}} hitReach={{ right: 3 }} style={{ ...drawn, borderWidth: 2 }} />
      ));
      try {
        const control = mount.container.querySelector<HTMLElement>('[data-testid="dot"]')!;
        expect(reachPastOuterBox(control)).toEqual({ top: 10, bottom: 10, left: 10, right: 3 });
      } finally {
        mount.unmount();
      }
    });
  });

  it('presses from the invisible frame', () => {
    const onPress = vi.fn();
    const mount = mountIn('ios', <HappierPressable testID="dot" accessibilityLabel="Dot" onPress={onPress} style={drawn} />);
    try {
      const frame = mount.container.querySelector<HTMLElement>('[data-testid="dot"] > [data-happier-hit-area="true"]')!;
      frame.click();
      expect(onPress).toHaveBeenCalledOnce();
      expect(frame.getAttribute('aria-hidden')).toBe('true');
    } finally {
      mount.unmount();
    }
  });
});
